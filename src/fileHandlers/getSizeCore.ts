import { FileType } from '../core/fs';

export interface SizeEntry {
  size: number;
  type: FileType;
  fspath: string;
}

export interface SizeFs {
  list(dir: string, option?: any): Promise<SizeEntry[]>;
}

// Parse the leading byte count from `du -sb <path>` output ("<bytes>\t<path>").
export function parseDu(out: string): number {
  const m = /^(\d+)/.exec((out || '').trim());
  return m ? parseInt(m[1], 10) : 0;
}

// Recursively sum entry sizes under `root`. Only real directories are
// descended into (symlinks are counted by their own entry size, never
// followed — this avoids loops). Directories that fail to list contribute 0
// and the walk continues.
export async function walkSize(
  fs: SizeFs,
  root: string,
  opts: {
    onProgress?: (seen: number, total: number) => void;
    isCancelled?: () => boolean;
  } = {}
): Promise<number> {
  const isCancelled = opts.isCancelled || (() => false);
  let seen = 0;
  let grandTotal = 0;

  async function walk(dir: string): Promise<void> {
    if (isCancelled()) {
      return;
    }
    let entries: SizeEntry[];
    try {
      entries = await fs.list(dir);
    } catch {
      return; // permission-denied / unreadable subdir — skip, keep going
    }
    for (const entry of entries) {
      if (isCancelled()) {
        return;
      }
      grandTotal += entry.size || 0;
      seen += 1;
      if (opts.onProgress) {
        opts.onProgress(seen, grandTotal);
      }
      if (entry.type === FileType.Directory) {
        await walk(entry.fspath);
      }
    }
  }

  await walk(root);
  return grandTotal;
}
