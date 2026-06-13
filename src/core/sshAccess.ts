import { RemoteFileSystem } from './fs';
import { SSHClient } from './remote-client';

// Resolve the live SSHClient for a config's connection (used by DB + clone features).
// Requires an SFTP/SSH connection (FTP has no exec/forward channel).
export async function getSshClient(fileService: any, config: any): Promise<SSHClient> {
  if (config.protocol && config.protocol !== 'sftp') {
    throw new Error('This feature requires an SFTP (SSH) connection.');
  }
  const remoteFs = (await fileService.getRemoteFileSystem(config)) as RemoteFileSystem;
  return remoteFs.getClient() as SSHClient;
}

// The remote filesystem (for readFile / get streams / list / stat).
export async function getRemoteFs(fileService: any, config: any): Promise<RemoteFileSystem> {
  return (await fileService.getRemoteFileSystem(config)) as RemoteFileSystem;
}
