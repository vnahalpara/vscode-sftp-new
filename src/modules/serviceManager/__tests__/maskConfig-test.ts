import { maskConfig, MASK } from '../maskConfig';

// Every place this repo is known to let a secret sit in sftp.json, plus the
// two -- `git.password` and `magento.envOverrides` -- that no schema
// documents but real profiles carry anyway. Distinctive values so a leak is
// unambiguous in an assertion failure, and so a substring search over the
// whole serialised output is a meaningful test.
const SECRETS = [
  'ssh-hunter2',
  'my-passphrase',
  'interactive-answer-1',
  'interactive-answer-2',
  'sshpass -p prefix-hunter3',
  'custom-param-hunter4',
  'root-hunter5',
  'db-hunter6',
  'local-db-hunter7',
  'git-glpat-hunter8',
  'cf-token-hunter9',
  'hop-hunter10',
  'hop-root-hunter11',
  'profile-hunter12',
  'post-connect-hunter13',
  '-----BEGIN PRIVATE KEY----- pem-hunter14',
  'env-override-hunter15',
];

// A profile carrying all of the above at once, in the shape each field really
// takes.
const CONFIG: any = {
  name: 'prod',
  context: 'src',
  protocol: 'sftp',
  host: '10.0.0.5',
  port: 2222,
  remotePath: '/var/www',
  connectTimeout: 10000,
  username: 'deploy',
  password: 'ssh-hunter2',
  passphrase: 'my-passphrase',
  privateKeyPath: '/home/me/.ssh/id_rsa',
  agent: '/tmp/ssh-agent.sock',
  interactiveAuth: ['interactive-answer-1', 'interactive-answer-2'],
  ssh_prefix: 'sshpass -p prefix-hunter3',
  sshCustomParams: '-o ProxyCommand="pass custom-param-hunter4"',
  post_connect: 'mysql -ppost-connect-hunter13 -e "flush tables"',
  root_user: 'root',
  root_password: 'root-hunter5',
  database: [{ label: 'shop', name: 'shop_live', host: '127.0.0.1', port: 3306, username: 'root', password: 'db-hunter6' }],
  local: {
    provisioner: 'localwp',
    path: '/Users/me/Local/shop',
    database: { host: '127.0.0.1', name: 'local', username: 'root', password: 'local-db-hunter7' },
    magento: { envOverrides: { DB_PASSWORD: 'env-override-hunter15' } },
    ssl: { certPath: '/certs/local.crt', keyPath: '/certs/local.key' },
  },
  git: { username: 'bot', password: 'git-glpat-hunter8' },
  CLOUDFLARE_ZONE_ID: '023e105f4ecef8ad9ca31a8372d0c353',
  CLOUDFLARE_API_TOKEN: 'cf-token-hunter9',
  hop: [{ host: '10.0.0.9', username: 'jump', password: 'hop-hunter10', root_password: 'hop-root-hunter11' }],
  secureOptions: { rejectUnauthorized: true, key: '-----BEGIN PRIVATE KEY----- pem-hunter14' },
  profiles: {
    staging: { host: '10.0.0.6', remotePath: '/var/www-staging', password: 'profile-hunter12' },
  },
  vpn: { type: 'wireguard', configFile: '/etc/wireguard/wg0.conf', socksPort: 21000 },
  watcher: { files: '**/*.php', autoUpload: true, autoDelete: false },
  ignore: ['.git', 'node_modules'],
  concurrency: 4,
  uploadOnSave: true,
};

describe('maskConfig', () => {
  // The assertion that actually matters: this is what logger.info hands to
  // output.print, which JSON.stringifies it into the "sftp" output channel.
  it('emits no credential value anywhere in the logged output', () => {
    const logged = JSON.stringify(maskConfig(CONFIG));
    SECRETS.forEach(secret => expect(logged).not.toContain(secret));
  });

  it('masks unknown keys by default, so a new credential field cannot leak by omission', () => {
    const masked = maskConfig({ ...CONFIG, SOME_FUTURE_TOKEN: 'not-yet-invented-secret' });
    expect(masked.SOME_FUTURE_TOKEN).toBe(MASK);
    expect(JSON.stringify(masked)).not.toContain('not-yet-invented-secret');
  });

  it('keeps every masked key so the log still shows what was configured', () => {
    const masked = maskConfig(CONFIG);
    expect(Object.keys(masked).sort()).toEqual(Object.keys(CONFIG).sort());
    expect(masked.password).toBe(MASK);
    expect(masked.passphrase).toBe(MASK);
    expect(masked.username).toBe(MASK);
    expect(masked.ssh_prefix).toBe(MASK);
    expect(masked.sshCustomParams).toBe(MASK);
    expect(masked.post_connect).toBe(MASK);
    expect(masked.root_password).toBe(MASK);
    expect(masked.CLOUDFLARE_API_TOKEN).toBe(MASK);
    expect(masked.git).toBe(MASK);
  });

  it('still prints the structural settings the log exists to show', () => {
    const masked = maskConfig(CONFIG);
    expect(masked.name).toBe('prod');
    expect(masked.host).toBe('10.0.0.5');
    expect(masked.port).toBe(2222);
    expect(masked.protocol).toBe('sftp');
    expect(masked.remotePath).toBe('/var/www');
    expect(masked.context).toBe('src');
    expect(masked.ignore).toEqual(['.git', 'node_modules']);
    expect(masked.concurrency).toBe(4);
    expect(masked.uploadOnSave).toBe(true);
    expect(masked.watcher).toEqual({ files: '**/*.php', autoUpload: true, autoDelete: false });
    expect(masked.vpn).toEqual({ type: 'wireguard', configFile: '/etc/wireguard/wg0.conf', socksPort: 21000 });
    expect(masked.privateKeyPath).toBe('/home/me/.ssh/id_rsa');
    // A zone id is infrastructure identity, not a credential -- and it is what
    // tells a user whether the profile picked up the zone they meant.
    expect(masked.CLOUDFLARE_ZONE_ID).toBe('023e105f4ecef8ad9ca31a8372d0c353');
  });

  it('masks inside nested blocks rather than passing the block through whole', () => {
    const masked = maskConfig(CONFIG);
    expect(masked.database[0].password).toBe(MASK);
    expect(masked.database[0].name).toBe('shop_live');
    expect(masked.database[0].port).toBe(3306);
    expect(masked.local.database.password).toBe(MASK);
    expect(masked.local.database.name).toBe('local');
    expect(masked.local.path).toBe('/Users/me/Local/shop');
    expect(masked.local.ssl).toEqual({ certPath: '/certs/local.crt', keyPath: '/certs/local.key' });
    // An arbitrary env map is exactly where a DB password hides.
    expect(masked.local.magento.envOverrides).toBe(MASK);
    expect(masked.secureOptions.key).toBe(MASK);
    expect(masked.secureOptions.rejectUnauthorized).toBe(true);
  });

  it('masks a hop/bastion entry the same way as the top level', () => {
    const masked = maskConfig(CONFIG);
    expect(masked.hop[0].password).toBe(MASK);
    expect(masked.hop[0].root_password).toBe(MASK);
    expect(masked.hop[0].host).toBe('10.0.0.9');
  });

  it('keeps profile names but masks what is inside each profile', () => {
    const masked = maskConfig(CONFIG);
    expect(Object.keys(masked.profiles)).toEqual(['staging']);
    expect(masked.profiles.staging.password).toBe(MASK);
    expect(masked.profiles.staging.remotePath).toBe('/var/www-staging');
  });

  it('masks each interactiveAuth answer but keeps how many there were', () => {
    expect(maskConfig(CONFIG).interactiveAuth).toEqual([MASK, MASK]);
  });

  it('leaves interactiveAuth alone when it is the boolean mode switch', () => {
    expect(maskConfig({ ...CONFIG, interactiveAuth: true }).interactiveAuth).toBe(true);
    expect(maskConfig({ ...CONFIG, interactiveAuth: false }).interactiveAuth).toBe(false);
  });

  it('reports a masked-but-unset key as unset rather than implying a value', () => {
    const masked = maskConfig({ host: 'h', password: null, passphrase: undefined });
    expect(masked.password).toBeNull();
    expect(masked.passphrase).toBeUndefined();
  });

  it('does not mutate the config it was handed', () => {
    const config = { host: 'h', password: 'ssh-hunter2', database: [{ password: 'db-hunter6' }] };
    maskConfig(config);
    expect(config.password).toBe('ssh-hunter2');
    expect(config.database[0].password).toBe('db-hunter6');
  });
});
