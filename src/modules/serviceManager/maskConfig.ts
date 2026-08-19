// What gets printed to the "sftp" output channel every time a profile is
// loaded (createFileService -> logger.info in ./index.ts). `logger.info` is
// NOT gated on the debug setting, and output.print JSON.stringifies whatever
// it is handed, so anything this function passes through verbatim is written
// in cleartext to a panel the user is likely to paste into a bug report or a
// screenshot. That makes this function a redaction boundary, not a formatter.
//
// It is an ALLOWLIST, deliberately -- the same reasoning, and for the same
// class of accident, as redactProfile in ../serverManager/registry.ts:
//
//   "An allowlist, deliberately. A denylist of secret keys would silently
//    start leaking the day someone adds a new credential field to sftp.json."
//
// This function used to be that denylist: it masked `username`, `password`,
// `passphrase` and `interactiveAuth` and passed EVERY other key through
// verbatim. Every credential field added to sftp.json since then has been
// printed in full -- `root_password`, `database[].password`, `ssh_prefix`
// (which embeds a password inline), the undocumented `git.password` some
// profiles carry, and most recently `CLOUDFLARE_API_TOKEN`, a live,
// non-expiring API credential the README itself tells users to put in this
// file. Adding two more keys to a denylist would have fixed exactly those two
// and left the next one to leak, so the default is now inverted: an unknown
// key is masked, and only a key named below is printed.
//
// The log still has to answer "did it pick up my config?", so a masked key
// KEEPS ITS NAME and reports MASK as its value rather than being dropped --
// the reader can still see that `password` was present and that
// `CLOUDFLARE_API_TOKEN` was read, just not what they are.
//
// ADDING A FIELD TO sftp.json? Do nothing here and it is masked, which is the
// safe answer. Add its name below ONLY after deciding its value is safe to
// print in cleartext into a channel that ends up in bug reports.

export const MASK = '<masked>';

// Non-credential, structural configuration -- printed verbatim. Flat across
// nesting levels on purpose: the same key means the same kind of thing
// wherever it appears (`database[].host` is as safe as the top-level `host`;
// `database[].password` is as unsafe as the top-level one), and one list is
// far easier to audit than a tree of them.
//
// `username` and `root_user` are deliberately NOT here. They are account
// names rather than secrets -- registry.ts publishes `username` to the
// browser for exactly that reason -- but this function has always masked
// `username`, and loosening a redaction is not this change's job.
const SAFE_KEYS = new Set([
  // identity / connection shape
  'name',
  'context',
  'protocol',
  'host',
  'port',
  'connectTimeout',
  'remotePath',
  'workspace',
  // which profile block was selected, and the blocks themselves (the values
  // are recursed through this same masking -- see maskProfiles below)
  'defaultProfile',
  'profiles',
  // paths and switches, never key material itself. `privateKeyPath`/`agent`/
  // `sshConfigPath` name a location; the secret lives in the file or the
  // agent, not in sftp.json. Contrast `sshCustomParams` and `ssh_prefix`,
  // which are free-form command text a password is routinely inlined into --
  // both are absent here, so both are masked.
  'agent',
  'privateKeyPath',
  'sshConfigPath',
  // `false`/`true` says which auth mode is on and leaks nothing; an ARRAY is
  // the list of answers to send to the server's prompts, i.e. passwords, and
  // is masked element-by-element below.
  'interactiveAuth',
  'algorithms',
  'kex',
  'cipher',
  'serverHostKey',
  'hmac',
  // ftp
  'secure',
  'secureOptions',
  'passive',
  'servername',
  'rejectUnauthorized',
  'ciphers',
  'ecdhCurve',
  'honorCipherOrder',
  'minDHSize',
  'secureProtocol',
  'sessionIdContext',
  'ALPNProtocols',
  'NPNProtocols',
  // NB: secureOptions' `key`, `cert`, `pfx`, `ca`, `crl`, `dhparam` and
  // `passphrase` are absent on purpose -- those carry inline PEM/key material.
  // transfer behaviour
  'uploadOnSave',
  'useTempFile',
  'openSsh',
  'downloadOnOpen',
  'limitOpenFilesOnRemote',
  'ignore',
  'ignoreFile',
  'watcher',
  'files',
  'autoUpload',
  'autoDelete',
  'concurrency',
  'syncOption',
  'delete',
  'skipCreate',
  'ignoreExisting',
  'update',
  'remoteTimeOffsetInHours',
  'remoteExplorer',
  'filesExclude',
  'order',
  // vpn -- all paths, ports and timeouts; the WireGuard keys live in
  // `configFile`, not in sftp.json
  'vpn',
  'type',
  'configFile',
  'wireproxyPath',
  'socksPort',
  'healthCheckTimeout',
  // database entries: everything but `password`, which is not listed
  'database',
  'label',
  // local (clone) provisioning: paths and platform switches. `magento`'s
  // `envOverrides` is an arbitrary env map that routinely carries a DB
  // password, so it is absent and masked whole.
  'local',
  'provisioner',
  'platform',
  'hostname',
  'path',
  'phpVersion',
  'ssl',
  'certPath',
  'keyPath',
  'mediaPaths',
  'mediaProxy',
  'codeMethod',
  'dbExcludes',
  'magento',
  // hop/bastion: an object (or array of objects) of ordinary connection
  // options, so recursing it applies every rule above -- notably masking the
  // hop's own password and root_password.
  'hop',
  // A zone id identifies infrastructure; it is not a credential. Cloudflare
  // shows it in the dashboard and puts it in every API URL, and it already
  // reaches the browser through the activity log (routes.ts records
  // `zone <id>` as the command for each Cloudflare call). CLOUDFLARE_API_TOKEN
  // is deliberately absent one line below where it would go.
  'CLOUDFLARE_ZONE_ID',
]);

function maskValue(value: any): any {
  if (Array.isArray(value)) {
    return value.map(maskValue);
  }
  if (value && typeof value === 'object') {
    return maskObject(value);
  }
  return value;
}

// `profiles` is a map of USER-CHOSEN profile names to partial configs, so its
// own keys are not config keys and must not be tested against SAFE_KEYS --
// that would mask every profile body and leave only the names. The names are
// kept (which profiles exist is the diagnostic point) and each body is masked
// by the ordinary rules, so a password overridden inside a profile is masked
// exactly like the top-level one.
function maskProfiles(profiles: any): any {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return MASK;
  }
  const copy = {};
  Object.keys(profiles).forEach(name => {
    copy[name] = maskValue(profiles[name]);
  });
  return copy;
}

function maskObject(config: any): any {
  const copy = {};
  Object.keys(config).forEach(key => {
    const value = config[key];

    if (key === 'profiles') {
      copy[key] = maskProfiles(value);
      return;
    }

    if (!SAFE_KEYS.has(key)) {
      // null/undefined are printed as they are: there is nothing to leak, and
      // "present but unset" is exactly the kind of thing this log exists to
      // show. Everything else -- including an empty string -- reports MASK.
      copy[key] = value === null || value === undefined ? value : MASK;
      return;
    }

    // interactiveAuth as an array is a list of answers to the server's auth
    // prompts, i.e. passwords. The key stays, and so does the number of
    // answers, which is the only part worth seeing.
    if (key === 'interactiveAuth' && Array.isArray(value)) {
      copy[key] = value.map(() => MASK);
      return;
    }

    copy[key] = maskValue(value);
  });
  return copy;
}

/**
 * A copy of `config` safe to print to the output channel: every key is kept
 * so the log still shows what was configured, but only the structural,
 * non-credential fields listed above keep their values.
 */
export function maskConfig(config: any): any {
  if (!config || typeof config !== 'object') {
    return config;
  }
  return maskValue(config);
}

export default maskConfig;
