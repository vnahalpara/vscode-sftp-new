import { parseDu, walkSize, SizeFs } from '../getSizeCore';
import { FileType } from '../../core/fs';

describe('parseDu', () => {
  it('parses leading byte count from du -sb output', () => {
    expect(parseDu('123456\t/var/www/app\n')).toBe(123456);
  });
  it('returns 0 for empty output', () => {
    expect(parseDu('')).toBe(0);
  });
  it('returns 0 for non-numeric (error) output', () => {
    expect(parseDu('du: illegal option -- b')).toBe(0);
  });
});

describe('walkSize', () => {
  function fakeFs(tree: { [dir: string]: Array<{ size: number; type: FileType; fspath: string }> }): SizeFs {
    return {
      list: (dir: string) => Promise.resolve(tree[dir] || []),
    };
  }

  it('sums file sizes across a nested tree', async () => {
    const fs = fakeFs({
      '/root': [
        { fspath: '/root/a.txt', size: 10, type: FileType.File },
        { fspath: '/root/sub', size: 4096, type: FileType.Directory },
      ],
      '/root/sub': [
        { fspath: '/root/sub/b.txt', size: 20, type: FileType.File },
        { fspath: '/root/sub/c.bin', size: 5, type: FileType.File },
      ],
    });
    // 10 (a) + 4096 (dir entry) + 20 (b) + 5 (c) = 4131
    expect(await walkSize(fs, '/root')).toBe(4131);
  });

  it('does not recurse into symlinks', async () => {
    const fs = fakeFs({
      '/root': [
        { fspath: '/root/link', size: 12, type: FileType.SymbolicLink },
      ],
      // this would be the symlink target contents — must NOT be counted
      '/root/link': [{ fspath: '/root/link/huge', size: 999999, type: FileType.File }],
    });
    expect(await walkSize(fs, '/root')).toBe(12);
  });

  it('skips directories that fail to list and continues', async () => {
    const fs: SizeFs = {
      list: (dir: string) => {
        if (dir === '/root') {
          return Promise.resolve([
            { fspath: '/root/ok.txt', size: 7, type: FileType.File },
            { fspath: '/root/denied', size: 4096, type: FileType.Directory },
          ]);
        }
        return Promise.reject(new Error('permission denied'));
      },
    };
    // 7 (ok) + 4096 (denied dir entry) + 0 (contents unreadable)
    expect(await walkSize(fs, '/root')).toBe(4103);
  });

  it('stops early when cancelled', async () => {
    const fs = fakeFs({
      '/root': [
        { fspath: '/root/a', size: 1, type: FileType.File },
        { fspath: '/root/b', size: 1, type: FileType.File },
      ],
    });
    expect(await walkSize(fs, '/root', { isCancelled: () => true })).toBe(0);
  });

  it('reports running progress', async () => {
    const fs = fakeFs({
      '/root': [
        { fspath: '/root/a', size: 1, type: FileType.File },
        { fspath: '/root/b', size: 2, type: FileType.File },
      ],
    });
    const seen: Array<[number, number]> = [];
    await walkSize(fs, '/root', { onProgress: (n, t) => seen.push([n, t]) });
    expect(seen).toEqual([[1, 1], [2, 3]]);
  });
});
