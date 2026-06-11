import { RemoteFileSystem } from './fs';
import { SSHClient } from './remote-client';
import { DbClient, DatabaseConfig } from './dbClient';

// One DbClient per (connection, database), reused across the tree, SQL runner and search.
const clients = new Map<string, DbClient>();

function keyFor(config: any, dbConfig: DatabaseConfig): string {
  const conn = `${config.host}:${config.port || ''}:${config.context || config.remotePath || config.name}`;
  return `${conn}|${dbConfig.name}`;
}

export function getDbClient(fileService: any, config: any, dbConfig: DatabaseConfig): DbClient {
  const key = keyFor(config, dbConfig);
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }

  const sshProvider = async () => {
    if (config.protocol && config.protocol !== 'sftp') {
      throw new Error('Database connections require an SFTP (SSH) connection.');
    }
    const remoteFs = (await fileService.getRemoteFileSystem(config)) as RemoteFileSystem;
    return remoteFs.getClient() as SSHClient;
  };

  const client = new DbClient(dbConfig, sshProvider);
  clients.set(key, client);
  return client;
}

export function disposeAll(): void {
  clients.forEach(client => {
    client.dispose().catch(() => {
      /* ignore */
    });
  });
  clients.clear();
}
