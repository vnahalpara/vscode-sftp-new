import upath from './upath';
import { promptForPassword } from '../host';
import logger from '../logger';
import app from '../app';
import { ConnectOption } from './remote-client/remoteClient';
import {
  FileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from './fs';
import localFs from './localFs';

// A NUL separator between every key and value, and between every entry --
// the same defence profileId (registry.ts) uses for exactly the same reason,
// documented there: "{name:'a',host:'b'}" must not hash the same as
// "{name:'ab',host:''}". A bare value-only join has a second, worse failure
// mode this function used to have: two DIFFERENT nested objects (e.g. two
// hop configs with different target hosts) both stringify to the literal
// text "[object Object]" under Array.prototype.join, so they hashed
// IDENTICALLY regardless of their contents -- silently sharing one pooled
// connection between two configs that should never share one. Recursing
// into plain objects and arrays (with object keys sorted, so key order
// never affects the hash) and including key names fixes both.
//
// fsTable is in-memory only and its keys are never persisted anywhere, so
// there is no migration/compatibility concern in changing this -- the only
// behavioural change is that configs which previously (incorrectly)
// collided now correctly get their own connections.
const HASH_SEP = '\u0000';

// A separator only separates if it cannot appear inside the things it
// separates. JSON does permit an escaped NUL inside a string, so without this a
// crafted value could forge the separator and impersonate a different
// config: because object keys are sorted, a value in the alphabetically
// first key could swallow every later key/value pair, making
// {host: 'h\0password\0r\0username\0root'} hash identically to
// {host: 'h', password: 'r', username: 'root'}. JSON.stringify escapes a
// literal NUL as a six-character escape, so an encoded string can never
// contain a raw HASH_SEP byte. Only strings need it -- no number, boolean,
// bigint, symbol or function renders to a NUL -- and restricting it to
// strings keeps this total, where JSON.stringify(bigint) would throw.
// It also makes 22 and '22' distinguishable, which String() alone did not.
function encodeScalar(value: any): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function canonicalize(value: any): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalize(item)).join(HASH_SEP) + ']';
  }
  if (typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => encodeScalar(key) + HASH_SEP + canonicalize(value[key]))
        .join(HASH_SEP) +
      '}'
    );
  }
  return encodeScalar(value);
}

export function hashOption(option: any): string {
  return canonicalize(option);
}

// Connecting MUTATES the option object it is handed. `_doConnect`
// (core/remote-client/sshClient.ts) writes `port = 22` onto every non-final
// hop and `privateKey = <contents of privateKeyPath>` onto the innermost
// one, in place. Those writes reach the CALLER's own config object graph:
// getHostInfo (core/fileService.ts) only shallow-copies the top level, so
// `config.hop` is literally the same object the file service holds, and the
// `Object.assign({}, option)` this function replaced left it shared.
//
// That was survivable only while hashOption was value-only -- every nested
// object stringified to "[object Object]", so no mutation inside a hop could
// ever change the pool key. Now that the key is structure-aware, a shared
// hop makes the first successful connect rewrite the very config the key is
// computed from: the next operation hashes to a DIFFERENT key, misses this
// pool entry and opens a second SSH+SFTP connection, while the first is
// orphaned beyond the reach of removeRemoteFs/reconnectRemoteFs (both of
// which key off the post-mutation hash) and stays open for the window's
// life. A password-prompting profile prompts a second time on top.
//
// Deep-copying here -- once, at the boundary where the pool hands an option
// to the client -- keeps every connect-time write on the pool's private copy
// and the key stable by construction, rather than trying to keep the hash
// blind to a mutation that should never have escaped in the first place.
// Only plain objects and arrays are recursed: anything else (a Buffer, a
// socket, the `debug` function installed below, a class instance) is carried
// over by reference, because copying those would change their behaviour, and
// none of them is a container a connect-time write lands inside of.
export function copyConnectOption<T>(option: T): T {
  if (Array.isArray(option)) {
    return (option.map(item => copyConnectOption(item)) as any) as T;
  }
  if (option && typeof option === 'object') {
    const proto = Object.getPrototypeOf(option);
    if (proto === Object.prototype || proto === null) {
      const copy = {};
      Object.keys(option).forEach(key => {
        copy[key] = copyConnectOption((option as any)[key]);
      });
      return (copy as any) as T;
    }
  }
  return option;
}

class KeepAliveRemoteFs {
  private isValid: boolean = false;

  private pendingPromise: Promise<RemoteFileSystem> | null;

  private fs: RemoteFileSystem;

  async getFs(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours: number;
    }
  ): Promise<RemoteFileSystem> {
    if (this.isValid) {
      this.pendingPromise = null;
      return Promise.resolve(this.fs);
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    // Deep, not Object.assign: see copyConnectOption above -- connecting
    // writes into nested hop objects, and those writes must not reach the
    // caller's config, whose shape is what the pool key is hashed from.
    const connectOption = copyConnectOption(option);
    // tslint:disable variable-name
    let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;
    if (option.protocol === 'sftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

        if (log) {
          if (log[1] === 'Parser') return;
          logger.debug(`${log[1]}: ${log[2]}`);
        } else {
          logger.debug(str);
        }
      };
      FsConstructor = SFTPFileSystem;
    } else if (option.protocol === 'ftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^\[connection\] (>|<) (.*?)(\\r\\n)?$/);

        if (!log) return;

        if (log[2].match(/200 NOOP/)) return;

        if (log[2].match(/^PASS /)) log[2] = 'PASS ******';

        logger.debug(`${log[1]} ${log[2]}`);
      };
      FsConstructor = FTPFileSystem;
    } else {
      throw new Error(`unsupported protocol ${option.protocol}`);
    }

    this.fs = new FsConstructor(upath, {
      clientOption: connectOption,
      remoteTimeOffsetInHours: option.remoteTimeOffsetInHours,
    });
    this.fs.onDisconnected(this.invalid.bind(this));

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    this.pendingPromise = this.fs
      .connect(connectOption, {
        askForPasswd: promptForPassword,
      })
      .then(
        () => {
          app.sftpBarItem.reset();
          this.isValid = true;
          return this.fs;
        },
        err => {
          this.fs.end();
          this.invalid('error');
          throw err;
        }
      );

    return this.pendingPromise;
  }

  invalid(reason: string) {
    this.pendingPromise = null;
    this.fs.end();
    this.isValid = false;
  }

  end() {
    this.fs.end();
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

export function createRemoteIfNoneExist(option): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option);
  }

  const fsInstance = new KeepAliveRemoteFs();
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option);
}

export function removeRemoteFs(option) {
  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    fs.end();
    delete fsTable[identity];
  }
}

// Force a fresh connection for an already-connected server. Tears the
// (possibly silently-dead) cached connection down completely and builds a brand
// new one, then reconnects eagerly so the returned promise reflects the new
// connection's success/failure. Returns null when there is no existing
// connection for this option, so we never spin up an idle server here.
//
// We rebuild via removeRemoteFs + createRemoteIfNoneExist (rather than
// invalidating and reusing the cached instance) so that a delayed `close` event
// from the old socket can't fire the old instance's disconnect handler against
// the freshly created connection.
export function reconnectRemoteFs(option): Promise<FileSystem> | null {
  const identity = hashOption(option);
  if (fsTable[identity] === undefined) {
    return null;
  }

  removeRemoteFs(option);
  return createRemoteIfNoneExist(option);
}
