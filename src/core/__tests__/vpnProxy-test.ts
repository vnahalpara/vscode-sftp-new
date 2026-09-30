import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// "vpn": true routes through a SOCKS5 proxy the user runs themselves (an
// always-on wireproxy under launchd, say). Every test here stands up its own
// listener on an ephemeral port: nothing may ever probe the user's real proxy
// on 127.0.0.1:1080.

type VpnProxy = typeof import('../vpnProxy');

interface SocksRequest {
  atyp: number;
  host: string;
  port: number;
}

let servers: net.Server[] = [];
// Every accepted connection, so teardown can close one a client left open --
// server.close() alone waits for them and would hang the suite.
let accepted: net.Socket[] = [];
let tmpDirs: string[] = [];

function portOf(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected an AddressInfo, got a pipe/unset address');
  }
  return address.port;
}

function listen(handler: (socket: net.Socket) => void, host = '127.0.0.1'): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      accepted.push(socket);
      handler(socket);
    });
    server.once('error', reject);
    server.listen(0, host, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = portOf(server);
      server.close(() => resolve(port));
    });
  });
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-vpn-proxy-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Just enough of a SOCKS5 server: accepts no-auth, records each CONNECT
 * request exactly as it arrived on the wire (so a test can see whether the
 * hostname or a pre-resolved address was sent), reports success, and hangs up
 * at the first byte of the SSH session that follows -- it is no SSH server,
 * and hanging up makes the client fail fast instead of waiting on a timeout.
 */
function fakeSocks5(requests: SocksRequest[]): Promise<net.Server> {
  return listen(socket => {
    let stage: 'greeting' | 'request' | 'relay' = 'greeting';
    let buf = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) {
          return;
        }
        buf = buf.slice(2 + buf[1]);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) {
          return;
        }
        const atyp = buf[3];
        let host: string;
        let end: number;
        if (atyp === 0x03) {
          end = 5 + buf[4];
          host = buf.slice(5, end).toString();
        } else if (atyp === 0x01) {
          end = 8;
          host = Array.from(buf.slice(4, 8)).join('.');
        } else {
          socket.destroy();
          return;
        }
        if (buf.length < end + 2) {
          return;
        }
        requests.push({ atyp, host, port: buf.readUInt16BE(end) });
        buf = buf.slice(end + 2);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        stage = 'relay';
        if (buf.length === 0) {
          return;
        }
      }
      socket.destroy();
    });
  });
}

interface Harness {
  mod: VpnProxy;
  info: jest.SpyInstance;
  warn: jest.SpyInstance;
  debug: jest.SpyInstance;
}

function harness(initOptions?: { proxy?: string }): Harness {
  jest.resetModules();
  // tslint:disable-next-line:no-var-requires
  const logger = require('../../logger').default;
  const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
  // tslint:disable-next-line:no-var-requires
  const mod: VpnProxy = require('../vpnProxy');
  if (initOptions) {
    mod.init(initOptions);
  }
  return { mod, info, warn, debug };
}

afterEach(async () => {
  accepted.forEach(socket => socket.destroy());
  accepted = [];
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  servers = [];
  tmpDirs.forEach(dir => fse.removeSync(dir));
  tmpDirs = [];
  jest.restoreAllMocks();
});

describe('the "sftp.vpn.proxy" setting', () => {
  test('routes "vpn": true to the configured proxy', () => {
    const { mod } = harness({ proxy: '10.1.2.3:1081' });
    expect(mod.routeFor(true)).toEqual({ kind: 'shared', proxy: { host: '10.1.2.3', port: 1081 } });
  });

  test('defaults to 127.0.0.1:1080 before init() runs', () => {
    const { mod } = harness();
    expect(mod.routeFor(true)).toEqual({ kind: 'shared', proxy: { host: '127.0.0.1', port: 1080 } });
  });

  test('defaults to 127.0.0.1:1080 when no setting is passed', () => {
    const { mod, warn } = harness({});
    expect(mod.routeFor(true)).toEqual({ kind: 'shared', proxy: { host: '127.0.0.1', port: 1080 } });
    expect(warn).not.toHaveBeenCalled();
  });

  test('a malformed value falls back to the default instead of throwing', () => {
    const { mod } = harness({ proxy: '127.0.0.1' });
    expect(mod.routeFor(true)).toEqual({ kind: 'shared', proxy: { host: '127.0.0.1', port: 1080 } });
  });

  test('a malformed value is reported in the log', () => {
    const { warn } = harness({ proxy: 'localhost:99999' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"sftp.vpn.proxy"'));
  });

  test('a good value is not reported', () => {
    const { warn } = harness({ proxy: '127.0.0.1:1080' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('routeFor', () => {
  test('an absent vpn is direct', () => {
    const { mod } = harness({});
    expect(mod.routeFor(undefined)).toEqual({ kind: 'direct' });
  });

  test('the legacy object form takes the shared proxy', () => {
    const { mod } = harness({ proxy: '127.0.0.1:1081' });
    expect(mod.routeFor({ configFile: '~/wg0.conf', socksPort: 21080 })).toEqual({
      kind: 'shared',
      proxy: { host: '127.0.0.1', port: 1081 },
    });
  });

  test('the legacy object form logs exactly one deprecation line per call', () => {
    const { mod, info } = harness({});
    mod.routeFor({ configFile: '~/wg0.conf' });
    expect(info.mock.calls.filter(call => /deprecated/.test(call[0]))).toHaveLength(1);
  });

  test('the deprecation line names the new spelling', () => {
    const { mod, info } = harness({});
    mod.routeFor({ configFile: '~/wg0.conf' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"vpn": true'));
  });

  test('"vpn": true logs no deprecation', () => {
    const { mod, info } = harness({});
    mod.routeFor(true);
    expect(info.mock.calls.filter(call => /deprecated/.test(call[0]))).toHaveLength(0);
  });
});

describe('ensureSharedProxy', () => {
  test('resolves when a SOCKS5 proxy answers', async () => {
    const { mod } = harness({});
    const server = await fakeSocks5([]);
    await expect(mod.ensureSharedProxy({ host: '127.0.0.1', port: portOf(server) })).resolves.toBeUndefined();
  });

  test('fails fast, naming the address, when nothing is listening', async () => {
    const { mod } = harness({});
    const port = await closedPort();
    const started = Date.now();
    await expect(mod.ensureSharedProxy({ host: '127.0.0.1', port })).rejects.toThrow(
      `VPN proxy is not answering on 127.0.0.1:${port}. "vpn": true uses your always-on VPN tunnel`
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('the failure tells the user how to fix it', async () => {
    const { mod } = harness({});
    const port = await closedPort();
    await expect(mod.ensureSharedProxy({ host: '127.0.0.1', port })).rejects.toThrow(
      'start it, or change "sftp.vpn.proxy" in settings.'
    );
  });

  test('refuses a listener that is not SOCKS5', async () => {
    const { mod } = harness({});
    const server = await listen(socket => socket.on('data', () => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
    await expect(mod.ensureSharedProxy({ host: '127.0.0.1', port: portOf(server) })).rejects.toThrow(
      /VPN proxy is not answering/
    );
  });
});

describe('probeSocks5 with a host', () => {
  test('probes the host it is given, not only 127.0.0.1', async () => {
    let server: net.Server;
    try {
      server = await listen(socket => socket.on('data', () => socket.write(Buffer.from([0x05, 0x00]))), '::1');
    } catch (_e) {
      // No IPv6 loopback on this machine; nothing to tell the hosts apart by.
      return;
    }
    const { probeSocks5 } = harness().mod;
    await expect(probeSocks5(portOf(server), 300, '::1')).resolves.toBe(true);
  });

  test('still defaults to 127.0.0.1', async () => {
    const { probeSocks5 } = harness().mod;
    const server = await listen(socket => socket.on('data', () => socket.write(Buffer.from([0x05, 0x00]))));
    await expect(probeSocks5(portOf(server))).resolves.toBe(true);
  });
});

// Before 1.34.0 the extension started its own wireproxy and kept a merged
// WireGuard config (private key included) and a marker per tunnel in a `vpn`
// directory under its global storage. Nothing reads them any more, and the
// private keys should not outlive the feature.
describe('removeLegacyTunnelFiles', () => {
  function plantLegacy(storage: string): string {
    const dir = path.join(storage, 'vpn');
    fse.ensureDirSync(dir);
    fs.writeFileSync(path.join(dir, '0123456789abcdef.conf'), '[Interface]\nPrivateKey = not-a-real-key\n');
    fs.writeFileSync(path.join(dir, '0123456789abcdef.marker.json'), '{"port":21000,"pid":1}');
    return dir;
  }

  test('deletes the old vpn directory and everything in it', async () => {
    const { mod } = harness();
    const storage = tmpDir();
    const dir = plantLegacy(storage);
    await mod.removeLegacyTunnelFiles(storage);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('leaves the rest of the storage directory alone', async () => {
    const { mod } = harness();
    const storage = tmpDir();
    plantLegacy(storage);
    fs.writeFileSync(path.join(storage, 'keep.json'), '{}');
    await mod.removeLegacyTunnelFiles(storage);
    expect(fs.readdirSync(storage)).toEqual(['keep.json']);
  });

  test('is quiet when there is nothing to delete', async () => {
    const { mod } = harness();
    await expect(mod.removeLegacyTunnelFiles(tmpDir())).resolves.toBeUndefined();
  });

  // A recursive delete of "vpn" relative to wherever the process happens to be
  // is exactly what this must never do.
  test.each([[undefined], [''], ['relative/storage']])('does nothing for the storage path %p', async value => {
    const { mod } = harness();
    const cwd = tmpDir();
    const dir = plantLegacy(cwd);
    const original = process.cwd();
    process.chdir(cwd);
    try {
      await mod.removeLegacyTunnelFiles(value as any);
    } finally {
      process.chdir(original);
    }
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('swallows a failure and logs it at debug', async () => {
    const { mod, debug } = harness();
    // The fs-extra instance vpnProxy loaded after harness() reset the registry.
    // tslint:disable-next-line:no-var-requires
    const loadedFse = require('fs-extra');
    jest.spyOn(loadedFse, 'remove').mockImplementation((() => Promise.reject(new Error('EACCES'))) as any);
    await expect(mod.removeLegacyTunnelFiles(tmpDir())).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});

describe('SSHClient with "vpn": true', () => {
  function connectOption(extra: any = {}): any {
    return {
      host: 'target.example.test',
      port: 2222,
      username: 'someone',
      password: 'not-a-real-password',
      connectTimeout: 5000,
      vpn: true,
      ...extra,
    };
  }

  const askForPasswd = async () => undefined;

  function loadSSHClient(): any {
    // Required after harness() reset the registry, so sshClient shares the
    // very vpnProxy instance the harness configured.
    // tslint:disable-next-line:no-var-requires
    return require('../remote-client/sshClient').default;
  }

  test('connects through the configured proxy, sending the hostname so DNS stays in the tunnel', async () => {
    const requests: SocksRequest[] = [];
    const server = await fakeSocks5(requests);
    harness({ proxy: `127.0.0.1:${portOf(server)}` });
    const SSHClient = loadSSHClient();
    const client = new SSHClient(connectOption());

    // The fake proxy is no SSH server, so the SSH handshake itself fails; what
    // matters is where the connection went and how it got there.
    await expect(client.connect(connectOption(), { askForPasswd })).rejects.toThrow();
    client.end();

    expect(requests).toEqual([{ atyp: 0x03, host: 'target.example.test', port: 2222 }]);
  });

  test('a legacy object vpn goes through the same proxy', async () => {
    const requests: SocksRequest[] = [];
    const server = await fakeSocks5(requests);
    harness({ proxy: `127.0.0.1:${portOf(server)}` });
    const SSHClient = loadSSHClient();
    const option = connectOption({ vpn: { configFile: '/nonexistent/wg0.conf', socksPort: 21000 } });
    const client = new SSHClient(option);

    await expect(client.connect(option, { askForPasswd })).rejects.toThrow();
    client.end();

    expect(requests).toEqual([{ atyp: 0x03, host: 'target.example.test', port: 2222 }]);
  });

  // The VPN socket is handed to the first hop's own SSHClient. That client
  // used to drop it and dial the bastion itself, so a hop profile's first
  // connection left from the machine's real IP, outside the VPN.
  test('with hop, the first hop goes through the proxy rather than straight out', async () => {
    const server = await fakeSocks5([]);
    let directConnections = 0;
    const bastion = await listen(socket => {
      directConnections += 1;
      socket.on('error', () => undefined);
      socket.on('data', () => socket.destroy());
    });
    harness({ proxy: `127.0.0.1:${portOf(server)}` });
    const SSHClient = loadSSHClient();
    const option = connectOption({
      host: '127.0.0.1',
      port: portOf(bastion),
      hop: { host: 'target.example.test', username: 'someone', password: 'not-a-real-password' },
    });
    const client = new SSHClient(option);

    await expect(client.connect(option, { askForPasswd })).rejects.toThrow();
    client.end();

    expect(directConnections).toBe(0);
  });

  test('fails fast with the plain message when the proxy is not running', async () => {
    const port = await closedPort();
    harness({ proxy: `127.0.0.1:${port}` });
    const SSHClient = loadSSHClient();
    const client = new SSHClient(connectOption());

    await expect(client.connect(connectOption(), { askForPasswd })).rejects.toThrow(
      `VPN proxy is not answering on 127.0.0.1:${port}.`
    );
    client.end();
  });

  test('"vpn": false connects directly, never touching the proxy', async () => {
    const requests: SocksRequest[] = [];
    const server = await fakeSocks5(requests);
    const direct = await listen(socket => {
      socket.on('error', () => undefined);
      socket.on('data', () => socket.destroy());
    });
    harness({ proxy: `127.0.0.1:${portOf(server)}` });
    const SSHClient = loadSSHClient();
    const option = connectOption({ host: '127.0.0.1', port: portOf(direct), vpn: false });
    const client = new SSHClient(option);

    await expect(client.connect(option, { askForPasswd })).rejects.toThrow();
    client.end();

    expect(requests).toEqual([]);
  });
});
