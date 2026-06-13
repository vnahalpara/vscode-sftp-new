import * as fs from 'fs';
import { getRemoteFs } from '../../core/sshAccess';

// Stream a remote file to a local path via SFTP, reporting bytes. Returns total bytes.
export async function downloadRemoteFile(
  fileService: any,
  config: any,
  remotePath: string,
  localPath: string,
  onProgress?: (bytes: number) => void
): Promise<number> {
  const remoteFs = await getRemoteFs(fileService, config);
  const stream = await remoteFs.get(remotePath);
  return new Promise<number>((resolve, reject) => {
    const out = fs.createWriteStream(localPath);
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (onProgress) {
        onProgress(bytes);
      }
    });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve(bytes));
    stream.pipe(out);
  });
}
