import { DetectResult, DetectContext } from './types';
import { getAdapter } from './platform';
import { defaultMediaPaths } from './cloneConfig';
import { shellSingle } from '../../core/dbExec';

export function parseDu(out: string): number {
  const m = /^(\d+)/.exec((out || '').trim());
  return m ? parseInt(m[1], 10) : 0;
}

export function parsePhpVersion(out: string): string | undefined {
  const m = /PHP\s+(\d+\.\d+)/i.exec(out || '');
  return m ? m[1] : undefined;
}

// Probe the live site over SSH: platform, php/mysqldump availability, sizes, git, preserved config.
export async function detect(ctx: DetectContext, userMediaPaths: string[] | null): Promise<DetectResult> {
  const q = shellSingle;
  const rp = ctx.remotePath;

  const isMagento = (await ctx.exec(`test -f ${q(rp)}/bin/magento && echo yes || true`)).stdout.indexOf('yes') !== -1;
  const isWp =
    !isMagento && (await ctx.exec(`test -f ${q(rp)}/wp-config.php && echo yes || true`)).stdout.indexOf('yes') !== -1;
  const platform: DetectResult['platform'] = isMagento ? 'magento2' : isWp ? 'wordpress' : 'unknown';

  const phpVersion = parsePhpVersion((await ctx.exec('php -v 2>/dev/null | head -1')).stdout);
  const hasMysqldump =
    (await ctx.exec('command -v mysqldump >/dev/null 2>&1 && echo yes || true')).stdout.indexOf('yes') !== -1;
  const gitRemote =
    (await ctx.exec(`git -C ${q(rp)} config --get remote.origin.url 2>/dev/null || true`)).stdout.trim() || null;

  // null/undefined => platform default; [] => explicitly skip media
  const mediaPaths = userMediaPaths === null ? defaultMediaPaths(platform) : userMediaPaths;

  const sizes: { [label: string]: number } = {};
  sizes.code = parseDu((await ctx.exec(`du -sb ${q(rp)} 2>/dev/null || true`)).stdout);
  for (const mp of mediaPaths) {
    sizes[mp] = parseDu((await ctx.exec(`du -sb ${q(rp + '/' + mp)} 2>/dev/null || true`)).stdout);
  }

  let preservedEnv;
  const adapter = getAdapter(platform);
  if (adapter) {
    preservedEnv = (await adapter.detectExtra(ctx)).preservedEnv;
  }

  return { platform, phpVersion, hasMysqldump, gitRemote, mediaPaths, sizes, preservedEnv };
}
