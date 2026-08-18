import * as crypto from 'crypto';

export interface RedactedProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privilegedAs: string;
  protocol: string;
  remotePath: string;
  workspace: string;
  hasVpn: boolean;
  hasDatabase: boolean;
}

// Two workspace folders can each hold a profile called "prod", so the folder
// path is part of the identity. The NUL separator stops {name:'a',host:'b'}
// from hashing the same as {name:'ab',host:''}.
export function profileId(workspace: string, config: any): string {
  const key = [
    workspace,
    config.name || '',
    config.host || '',
    String(config.port || 22),
  ].join('\u0000');
  return crypto
    .createHash('sha1')
    .update(key)
    .digest('hex')
    .slice(0, 16);
}

// An allowlist, deliberately. A denylist of secret keys would silently start
// leaking the day someone adds a new credential field to sftp.json.
//
// `username` is intentionally included: the UI header shows root@host:port, and
// a username is not a secret the way a password is.
export function redactProfile(workspace: string, config: any): RedactedProfile {
  return {
    id: profileId(workspace, config),
    name: config.name || config.host || '',
    host: config.host || '',
    port: config.port || 22,
    username: config.username || '',
    // Which account privileged commands (systemctl, nginx -t, openssl) will
    // actually run as. Never the password itself -- this object is the
    // RedactedProfile, serialised straight to the browser -- just the name of
    // the lane so the UI (and the sudo hint) can tell the user who to grant
    // sudo to.
    privilegedAs: config.root_user && config.root_password ? config.root_user : config.username || '',
    protocol: config.protocol || 'sftp',
    remotePath: config.remotePath || '/',
    workspace,
    hasVpn: Boolean(config.vpn && config.vpn.configFile),
    hasDatabase: Array.isArray(config.database) && config.database.length > 0,
  };
}
