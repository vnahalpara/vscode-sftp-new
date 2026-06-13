export interface ExecLike {
  exec(cmd: string, input?: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface DetectContext extends ExecLike {
  remotePath: string;
}

export interface DetectResult {
  platform: 'magento2' | 'wordpress' | 'unknown';
  phpVersion?: string;
  hasMysqldump: boolean;
  gitRemote: string | null;
  mediaPaths: string[];
  sizes: { [label: string]: number };
  preservedEnv?: { [key: string]: any };
}

export interface PlatformAdapter {
  id: 'magento2' | 'wordpress';
  // information_schema LIKE patterns whose DATA is skipped in the dump (structure kept)
  noDataPatterns(): string[];
  // pull live config and extract values to preserve verbatim across clones (Magento env.php)
  detectExtra(ctx: DetectContext): Promise<{ preservedEnv?: { [key: string]: any } }>;
  // write local config (Magento env.php / WP wp-config defines) so the imported DB is localized
  localize(rc: any, preserved: { [key: string]: any }): Promise<{ message: string }>;
}

// Seam for Phase 2 — local environment that serves the cloned site.
export interface Provisioner {
  id: 'native' | 'localwp';
}
