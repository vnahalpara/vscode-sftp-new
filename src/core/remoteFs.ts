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

function canonicalize(value: any): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(HASH_SEP) + ']';
  }
  if (typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => key + HASH_SEP + canonicalize(value[key]))
        .join(HASH_SEP) +
      '}'
    );
  }
  return String(value);
}

export function hashOption(option: any): string {
  return canonicalize(option);
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

    const connectOption = Object.assign({}, option);
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
