import TransferTask, { TransferDirection } from '../transferTask';
import { FileType } from '../fs';

describe('TransferTask.size', () => {
  const fakeFs: any = { pathResolver: {} };

  it('exposes the size from transferOption', () => {
    const task = new TransferTask(
      { fsPath: '/a', fileSystem: fakeFs },
      { fsPath: '/b', fileSystem: fakeFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: { atime: 0, mtime: 0, perserveTargetMode: false, size: 1234 },
      }
    );
    expect(task.size).toBe(1234);
  });

  it('defaults size to 0 when unset', () => {
    const task = new TransferTask(
      { fsPath: '/a', fileSystem: fakeFs },
      { fsPath: '/b', fileSystem: fakeFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: { atime: 0, mtime: 0, perserveTargetMode: false },
      }
    );
    expect(task.size).toBe(0);
  });
});
