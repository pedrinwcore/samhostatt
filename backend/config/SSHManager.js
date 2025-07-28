const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

class SSHManager {
    constructor() {
        this.connections = new Map();
    }

    async getConnection(serverId) {
        try {
            // Buscar dados do servidor no banco
            const db = require('./database');
            const [serverRows] = await db.execute(
                'SELECT ip, porta_ssh, senha_root FROM wowza_servers WHERE codigo = ? AND status = "ativo"',
                [serverId]
            );

            if (serverRows.length === 0) {
                throw new Error('Servidor não encontrado ou inativo');
            }

            const server = serverRows[0];
            const connectionKey = `${server.ip}:${server.porta_ssh}`;

            // Verificar se já existe conexão ativa
            if (this.connections.has(connectionKey)) {
                const existingConn = this.connections.get(connectionKey);
                if (existingConn.conn && existingConn.conn._sock && !existingConn.conn._sock.destroyed) {
                    return existingConn;
                }
                // Remover conexão inválida
                this.connections.delete(connectionKey);
            }

            // Criar nova conexão SSH
            const conn = new Client();
            
            return new Promise((resolve, reject) => {
                conn.on('ready', () => {
                    console.log(`✅ Conectado via SSH ao servidor ${server.ip}`);
                    
                    const connectionData = {
                        conn,
                        server,
                        connected: true,
                        lastUsed: new Date()
                    };
                    
                    this.connections.set(connectionKey, connectionData);
                    resolve(connectionData);
                });

                conn.on('error', (err) => {
                    console.error(`❌ Erro SSH para ${server.ip}:`, err);
                    reject(err);
                });

                conn.on('close', () => {
                    console.log(`🔌 Conexão SSH fechada para ${server.ip}`);
                    this.connections.delete(connectionKey);
                });

                // Conectar
                conn.connect({
                    host: server.ip,
                    port: server.porta_ssh || 22,
                    username: 'root',
                    password: server.senha_root,
                    readyTimeout: 30000,
                    keepaliveInterval: 30000
                });
            });

        } catch (error) {
            console.error('Erro ao obter conexão SSH:', error);
            throw error;
        }
    }

    async executeCommand(serverId, command) {
        try {
            const { conn } = await this.getConnection(serverId);
            
            return new Promise((resolve, reject) => {
                conn.exec(command, (err, stream) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    let stdout = '';
                    let stderr = '';

                    stream.on('close', (code, signal) => {
                        if (code === 0) {
                            resolve({ success: true, stdout, stderr, code });
                        } else {
                            reject(new Error(`Comando falhou com código ${code}: ${stderr}`));
                        }
                    });

                    stream.on('data', (data) => {
                        stdout += data.toString();
                    });

                    stream.stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
                });
            });
        } catch (error) {
            console.error('Erro ao executar comando SSH:', error);
            throw error;
        }
    }

    async uploadFile(serverId, localPath, remotePath) {
        try {
            const { conn } = await this.getConnection(serverId);
            
            return new Promise((resolve, reject) => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    // Criar diretório remoto se não existir
                    const remoteDir = path.dirname(remotePath);
                    sftp.mkdir(remoteDir, { mode: 0o755 }, (mkdirErr) => {
                        // Ignorar erro se diretório já existir
                        
                        sftp.fastPut(localPath, remotePath, (uploadErr) => {
                            if (uploadErr) {
                                reject(uploadErr);
                                return;
                            }

                            // Definir permissões do arquivo
                            sftp.chmod(remotePath, 0o644, (chmodErr) => {
                                if (chmodErr) {
                                    console.warn('Aviso: Não foi possível definir permissões:', chmodErr);
                                }
                                
                                resolve({ success: true, remotePath });
                            });
                        });
                    });
                });
            });
        } catch (error) {
            console.error('Erro ao fazer upload via SSH:', error);
            throw error;
        }
    }

    async createUserDirectory(serverId, userLogin) {
        try {
            const userDir = `/usr/local/WowzaStreamingEngine/content/${userLogin}`;
            const commands = [
                `mkdir -p ${userDir}`,
                `mkdir -p ${userDir}/videos`,
                `mkdir -p ${userDir}/logos`,
                `mkdir -p ${userDir}/recordings`,
                `chown -R wowza:wowza ${userDir}`,
                `chmod -R 755 ${userDir}`
            ];

            for (const command of commands) {
                await this.executeCommand(serverId, command);
            }

            console.log(`✅ Diretório criado para usuário ${userLogin} no servidor ${serverId}`);
            return { success: true, userDir };
        } catch (error) {
            console.error(`Erro ao criar diretório para usuário ${userLogin}:`, error);
            throw error;
        }
    }

    async createUserFolder(serverId, userLogin, folderName) {
        try {
            const folderPath = `/usr/local/WowzaStreamingEngine/content/${userLogin}/${folderName}`;
            const commands = [
                `mkdir -p ${folderPath}`,
                `chown -R wowza:wowza ${folderPath}`,
                `chmod -R 755 ${folderPath}`
            ];

            for (const command of commands) {
                await this.executeCommand(serverId, command);
            }

            console.log(`✅ Pasta ${folderName} criada para usuário ${userLogin}`);
            return { success: true, folderPath };
        } catch (error) {
            console.error(`Erro ao criar pasta ${folderName}:`, error);
            throw error;
        }
    }

    async deleteFile(serverId, remotePath) {
        try {
            const command = `rm -f "${remotePath}"`;
            await this.executeCommand(serverId, command);
            
            console.log(`✅ Arquivo removido: ${remotePath}`);
            return { success: true };
        } catch (error) {
            console.error(`Erro ao remover arquivo ${remotePath}:`, error);
            throw error;
        }
    }

    async listFiles(serverId, remotePath) {
        try {
            const command = `ls -la "${remotePath}"`;
            const result = await this.executeCommand(serverId, command);
            
            return { success: true, files: result.stdout };
        } catch (error) {
            console.error(`Erro ao listar arquivos em ${remotePath}:`, error);
            throw error;
        }
    }

    async getFileInfo(serverId, remotePath) {
        try {
            const command = `ls -la "${remotePath}" 2>/dev/null || echo "FILE_NOT_FOUND"`;
            const result = await this.executeCommand(serverId, command);
            
            if (result.stdout.includes('FILE_NOT_FOUND')) {
                return { exists: false };
            }

            return { 
                exists: true, 
                info: result.stdout,
                size: this.extractFileSize(result.stdout),
                permissions: this.extractPermissions(result.stdout)
            };
        } catch (error) {
            return { exists: false };
        }
    }

    extractFileSize(lsOutput) {
        try {
            const parts = lsOutput.trim().split(/\s+/);
            return parseInt(parts[4]) || 0;
        } catch (error) {
            return 0;
        }
    }

    extractPermissions(lsOutput) {
        try {
            const parts = lsOutput.trim().split(/\s+/);
            return parts[0] || '';
        } catch (error) {
            return '';
        }
    }

    closeConnection(serverId) {
        try {
            const db = require('./database');
            db.execute('SELECT ip, porta_ssh FROM wowza_servers WHERE codigo = ?', [serverId])
                .then(([serverRows]) => {
                    if (serverRows.length > 0) {
                        const server = serverRows[0];
                        const connectionKey = `${server.ip}:${server.porta_ssh}`;
                        
                        if (this.connections.has(connectionKey)) {
                            const { conn } = this.connections.get(connectionKey);
                            conn.end();
                            this.connections.delete(connectionKey);
                            console.log(`🔌 Conexão SSH fechada para ${server.ip}`);
                        }
                    }
                });
        } catch (error) {
            console.error('Erro ao fechar conexão SSH:', error);
        }
    }

    closeAllConnections() {
        for (const [key, { conn }] of this.connections) {
            try {
                conn.end();
                console.log(`🔌 Conexão SSH fechada: ${key}`);
            } catch (error) {
                console.error(`Erro ao fechar conexão ${key}:`, error);
            }
        }
        this.connections.clear();
    }
}

module.exports = new SSHManager();