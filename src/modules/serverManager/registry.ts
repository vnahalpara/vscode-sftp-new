import * as crypto from 'crypto';
import { targetOption, hasRootCreds } from './privilege';
import { hasCloudflare } from './ops/cloudflare';

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
  hasCloudflare: boolean;
  cloudflareZoneId: string;
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
  // targetOption resolves to the hop (the real destination) when one is
  // configured, and to config itself otherwise -- the same resolution
  // index.ts's privilegedConfig uses to build the actual SSH connection.
  // Reading root_user/root_password off anything else (e.g. always the top
  // level) would report the wrong account on a hop/bastion profile, where
  // the top level is the jump host: the UI, and the sudo hint that reads
  // this field, would name the bastion's user while the connection is
  // actually authenticated as root on the target.
  const target = targetOption(config);
  return {
    id: profileId(workspace, config),
    name: config.name || config.host || '',
    host: config.host || '',
    port: config.port || 22,
    username: config.username || '',
    // Which account privileged commands (systemctl, nginx -t, openssl) will
    // actually run as. Never the password itself -- this object is the
    // RedactedProfile, serialised straight to the browser -- just the name of
    // the lane so the UI and the sudo hint can tell the user who to grant
    // sudo to. Both consume it: the hint in activity.ts names this account,
    // and the Servers & settings page renders it as "Privileged commands run
    // as" (webui/src/pages/Settings.jsx), which is where a user goes to find
    // out who the sudoers rule has to be written for. The fallback (no root credentials) is target.username, NOT
    // config.username: on a hop profile without root credentials the
    // privileged lane still authenticates as the HOP's own username (see
    // privilegedConfig -- it returns a value-identical copy of target()
    // unchanged), which is the destination server's user, not the bastion's.
    // config.username is only the right fallback when there is no hop, i.e.
    // when target === config, so it stays as the second fallback.
    privilegedAs: hasRootCreds(target) ? target.root_user : target.username || config.username || '',
    protocol: config.protocol || 'sftp',
    remotePath: config.remotePath || '/',
    workspace,
    hasVpn: Boolean(config.vpn && config.vpn.configFile),
    hasDatabase: Array.isArray(config.database) && config.database.length > 0,
    // A boolean only -- never CLOUDFLARE_ZONE_ID/CLOUDFLARE_API_TOKEN
    // themselves. This object is serialised straight to the browser; the
    // token lives only in the raw config, which never reaches this
    // function's return value (this is an allowlist that builds a fresh
    // object from named fields, not a denylist of secret keys to strip).
    hasCloudflare: hasCloudflare(config),
    // The zone ID, never the token. A zone id is infrastructure identity, not
    // a credential: Cloudflare shows it in the dashboard sidebar and puts it
    // in the path of every API call, and it ALREADY reaches this browser
    // through the activity log, where routes.ts records `zone <id>` as the
    // command for each Cloudflare call. It is here so the purge confirmation
    // can name the zone honestly ("zone <id>") when the zone-name lookup
    // failed, instead of the card having to gate the purge button on that
    // lookup succeeding. Empty string when Cloudflare is not configured --
    // gated on hasCloudflare so a half-finished edit (a zone id with no
    // token) reports nothing, matching every other Cloudflare gate.
    cloudflareZoneId: hasCloudflare(config) ? String(config.CLOUDFLARE_ZONE_ID) : '',
  };
}
