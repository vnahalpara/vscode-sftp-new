import { formatBytes } from '../../ui/transferFormat';

export function sizeDescription(
  opts: { isDirectory: boolean; isRoot: boolean; size?: number },
  enabled: boolean
): string | undefined {
  if (!enabled || opts.isRoot || opts.isDirectory || typeof opts.size !== 'number') {
    return undefined;
  }
  return formatBytes(opts.size);
}
