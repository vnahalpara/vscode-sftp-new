import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import * as url from 'url';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { WebSocket } from 'ws';
import logger from '../../logger';
import { getHostInfo } from '../../core/fileService';
import { removeRemoteFs, hashOption } from '../../core/remoteFs';
import { Collector, MonitorTransport } from '../monitor/collector';
import { sshTransport, readFacts } from '../monitor/transport';
import { HostFacts } from '../monitor/types';
import { profileId, redactProfile } from './registry';
import { targetOption, hasRootCreds } from './privilege';
import { ManagedSession } from './session';
import { closeServer, closeSessionSockets, createServer, listen, tokenFrom } from './httpServer';
import { bootstrapHtml } from './bootstrap';
import { buildRoutes } from './routes';
import { browserCommand, BrowserKind } from './browser';
import { bridgeTerminal } from './terminal';

const GRACE_MS = 30000;
const PING_MS = 25000;

interface Running {
  server: http.Server;
  port: number;
}

let running: Running | null = null;
let starting: Promise<Running> | null = null;
// Bumped by disposeAll(). An in-flight start compares the generation it began
// in against this before adopting the server it just bound, so a dispose that
// lands mid-start orphans that start rather than being overwritten by it.
let generation = 0;
// webpack rewrites __dirname in the bundle, so the extension's install
// directory has to be handed to us at activation time — the same way
// vpnTunnel receives globalStoragePath.
let extensionRoot: string | null = null;

export function init(extensionPath: string): void {
  extensionRoot = extensionPath;
}

// Builds the config for the privileged (systemctl/nginx/openssl) lane. The
// credential swap lands on targetOption(config) -- the real destination --
// not unconditionally on the top level. Getting this wrong on a hop profile
// is a credential leak, not just a bug: rewriting the top-level username/
// password would hand the destination server's root password to the
// BASTION's sshd instead, a machine that should never see it, while
// deleting the bastion's own key auth and leaving the lane unable to
// connect to anything.
export function privilegedConfig(config: any): any {
  const target = targetOption(config);
  if (!hasRootCreds(target)) {
    return Object.assign({}, config);
  }

  const swapped = Object.assign({}, target);
  swapped.username = target.root_user;
  swapped.password = target.root_password;
  // Key/agent auth would take precedence over the password we just set and
  // would authenticate as the WRONG user -- the key belongs to the session
  // user, not to root. passphrase and interactiveAuth are auth prompts tied
  // to that same session-user credential and must go with it: left in place,
  // passphrase (sshClient.ts's _connectSSHClient prompts whenever
  // `passphrase === true`, without checking a key is present) pops a
  // passphrase dialog for a key that no longer exists, and interactiveAuth's
  // pre-canned array answers -- or its bare `true` prompt, unlabelled as
  // belonging to root -- would replay the session user's own password into
  // root's keyboard-interactive auth.
  delete swapped.privateKeyPath;
  delete swapped.privateKey;
  delete swapped.agent;
  delete swapped.passphrase;
  delete swapped.interactiveAuth;

  if (target === config) {
    return swapped;
  }
  if (Array.isArray(config.hop)) {
    // Copy the array and replace only the last (innermost) entry -- earlier
    // hops in a multi-hop chain keep their own credentials untouched, and
    // the original array/objects are never mutated.
    const hop = config.hop.slice(0, -1).concat([swapped]);
    return Object.assign({}, config, { hop });
  }
  return Object.assign({}, config, { hop: swapped });
}

// Whether privilegedConfig(config) actually produces a SEPARATE pooled
// connection from the session's own -- answered the only way that is
// correct by construction: comparing the exact pool keys both configs hash
// to (hashOption, in core/remoteFs.ts), the same key createRemoteIfNoneExist
// and removeRemoteFs use.
//
// "Does this config carry root credentials?" looks like the same question
// and is not. This code used to ask that one, and it was a real bug: before
// hashOption was made structure-aware, a hop profile with root credentials
// on the target hashed IDENTICALLY to the session's own config (every hop
// object stringified to the literal "[object Object]"), so the credential
// check said "separate" while the two configs actually shared one pooled
// connection. Tearing that "separate" connection down on dispose would have
// ended the user's live SFTP transfer. The credential-presence predicate
// was deleted rather than left exported, so nobody reaches for it again.
// Deciding by key equality stays correct even if hashOption changes again,
// which a credential check never could.
export function privilegedConnectionIsSeparate(config: any): boolean {
  return hashOption(getHostInfo(privilegedConfig(config))) !== hashOption(getHostInfo(config));
}

// A cheap fingerprint of "which account will privileged commands run as".
// ensureSession() compares this against the identity a cached session was
// built with, so editing root_user/root_password in sftp.json (adding,
// removing, or changing them) invalidates the cached session immediately
// instead of silently keeping the old identity -- and the stale privileged
// connection open -- until VS Code restarts.
export function privilegedIdentity(config: any): string {
  const target = targetOption(config);
  if (!hasRootCreds(target)) {
    return 'session';
  }
  // Hashed, not plaintext: this string lives on a long-lived
  // SessionRegistryEntry (in memory for as long as the dashboard stays
  // open), and the raw root password has no business surviving in a second
  // place beyond the closures that actually need it to authenticate. Same
  // approach as profileId (registry.ts) next door.
  const fingerprint = crypto
    .createHash('sha1')
    .update([target.root_user, target.root_password].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return `root:${fingerprint}`;
}

export interface SessionRegistryEntry {
  session: ManagedSession;
  privilegedIdentity: string;
  // Ends the privileged SSH lane's pooled connection, or does nothing when
  // that lane hashes to (and therefore shares a pooled connection with) the
  // session's own transport -- see privilegedConnectionIsSeparate. Ending a
  // shared connection here would kill the user's live SFTP connection, not
  // just the privileged lane.
  disposePrivileged: () => void;
}

// Owns the token/profile lookup tables ensureSession() and disposeAll() used
// to manage inline as two raw Maps. Pulled out into its own factory so the
// bookkeeping around tearing a privileged lane down -- on disposeAll(), and
// on a profile's root credentials changing under an already-open session --
// can be unit tested without a real HTTP server or the `vscode` module, both
// of which the rest of this file depends on.
export interface SessionRegistryHooks {
  // Called for every token the registry lets go of -- disposed on shutdown,
  // or evicted because its credentials changed under it. index.ts uses it to
  // terminate that session's live WebSockets: a disposed session whose
  // Terminal socket stays open is a shell still running on the user's
  // production host, since nothing else ever closes it.
  onTokenDisposed?(token: string): void;
}

export function createSessionRegistry(hooks: SessionRegistryHooks = {}) {
  const byToken = new Map<string, SessionRegistryEntry>();
  const byProfile = new Map<string, string>();

  // Both calls are caught individually, and the entry is always forgotten in
  // a finally: a throw from session.dispose() must not skip
  // disposePrivileged() (a root SSH connection left open because the
  // session's own teardown failed is exactly the leak this exists to
  // close), and neither throw may skip byToken.delete(token) or escape out
  // of disposeToken -- this runs synchronously inside registry.get() on the
  // request path (a stale session's identity no longer matching), where an
  // uncaught throw would surface as a 500 on an unrelated command instead of
  // the cleanup failure it actually is.
  function disposeSafely(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      logger.error(`${label} failed during session disposal: ${(error as Error).message}`, 'serverManager');
    }
  }

  function disposeToken(token: string): void {
    const entry = byToken.get(token);
    if (!entry) {
      return;
    }
    try {
      // First, because it is the only one of the three that is still costing
      // the user something on the far end: session.dispose() does not close
      // the pooled SSH connection (SFTP shares it), so a live terminal
      // socket keeps its remote shell running indefinitely.
      disposeSafely('closeSockets()', () => {
        if (hooks.onTokenDisposed) {
          hooks.onTokenDisposed(token);
        }
      });
      disposeSafely('session.dispose()', () => entry.session.dispose());
      disposeSafely('disposePrivileged()', () => entry.disposePrivileged());
    } finally {
      byToken.delete(token);
    }
  }

  return {
    // The live token for this profile id, but only when the session now
    // cached for it still carries the identity privileged commands were
    // authenticated with when it was created. A mismatch tears the stale
    // session (and its privileged lane, if it had one of its own) down and
    // reports no existing token, so the caller falls through to build a
    // fresh session under the current credentials.
    get(id: string, identity: string): string | undefined {
      const token = byProfile.get(id);
      if (token === undefined) {
        return undefined;
      }
      const entry = byToken.get(token);
      if (entry && entry.privilegedIdentity === identity) {
        return token;
      }
      disposeToken(token);
      byProfile.delete(id);
      return undefined;
    },
    set(id: string, token: string, entry: SessionRegistryEntry): void {
      byToken.set(token, entry);
      byProfile.set(id, token);
    },
    lookupSession(token: string): ManagedSession | undefined {
      const entry = byToken.get(token);
      return entry ? entry.session : undefined;
    },
    disposeAll(): void {
      // Snapshot the tokens first: disposeToken() mutates byToken mid-walk,
      // which a live forEach would otherwise skip entries around.
      Array.from(byToken.keys()).forEach(disposeToken);
      byToken.clear();
      byProfile.clear();
    },
  };
}

const registry = createSessionRegistry({
  onTokenDisposed: token => {
    if (running) {
      closeSessionSockets(running.server, token);
    }
  },
});

// The upgrade already passed checkUpgrade's token check (wsServer.ts) before
// this ever runs, but that check only proved the token is VALID -- it does
// not hand this callback the token or the session, so both are pulled off
// the request the same way the plain HTTP path does (tokenFrom, same as
// httpServer.ts's own request handler uses for /api/*).
//
// session.transport is used here, deliberately never
// session.privilegedTransport: the Terminal tab runs as the profile's
// ordinary SSH user. A browser tab able to open a root shell with no further
// prompt -- just because the dashboard happened to hold root credentials for
// systemctl/nginx/openssl -- would be a serious, silent privilege escalation
// dressed up as a terminal.
function onTerminal(ws: WebSocket, req: http.IncomingMessage): void {
  const token = tokenFrom(url.parse(req.url || '', true).query, req.headers);
  const session = registry.lookupSession(token);
  const hasShell = session && session.transport.shell;
  if (!hasShell) {
    // Unreachable in normal operation -- sshTransport always implements
    // shell(), and a valid token always resolves to a session (checkUpgrade
    // already required one to accept the upgrade at all) -- but a session
    // can in principle be disposed in the gap between the upgrade completing
    // and this callback running, and closing costs nothing.
    ws.close();
    return;
  }
  // Called as a method of the transport, not lifted off it. sshTransport
  // happens to return an object literal whose shell() never touches `this`,
  // so an unbound reference works today -- and would break silently the day
  // a transport is implemented as a class or starts caching a client on
  // itself.
  bridgeTerminal({ openShell: opts => session!.transport.shell!(opts) }, ws);
}

function settings() {
  const cfg = vscode.workspace.getConfiguration('sftp.serverManager');
  return {
    browser: cfg.get<BrowserKind>('browser', 'chrome'),
    interval: cfg.get<number>('interval', 2000),
    slowInterval: cfg.get<number>('slowInterval', 15000),
    historyMinutes: cfg.get<number>('historyMinutes', 60),
  };
}

async function ensureServer(): Promise<Running> {
  if (running) {
    return running;
  }
  // Two rapid invocations — a double-clicked menu item — would otherwise both
  // reach listen(), and the first server would be overwritten and leaked with
  // its loopback port still bound and out of disposeAll's reach.
  if (starting) {
    return starting;
  }

  const pending = (async () => {
    const startedAt = generation;
    // media/webui does not exist until the UI milestone; until then every
    // request falls through to the bootstrap page, which is exactly what we
    // want. An uninitialised root degrades the same way: a path that cannot
    // exist.
    const root = extensionRoot
      ? path.join(extensionRoot, 'media', 'webui')
      : path.join(__filename, 'media', 'webui');
    const server = createServer({
      root,
      routes: buildRoutes({
        sessions: { get: token => registry.lookupSession(token) },
        pingMs: PING_MS,
        schedule: (fn, ms) => setInterval(fn, ms),
        cancel: handle => clearInterval(handle),
      }),
      hasToken: token => registry.lookupSession(token) !== undefined,
      fallbackHtml: bootstrapHtml,
      onTerminal,
    });
    const port = await listen(server);
    if (startedAt !== generation) {
      // disposeAll() ran while we were binding. Nothing will ever own this
      // server, so close it here rather than leaking a held port, and fail the
      // caller instead of handing back a URL to a teardown in progress.
      closeServer(server);
      throw new Error('Server manager was disposed while starting.');
    }
    running = { server, port };
    logger.info(`server manager listening on 127.0.0.1:${port}`, 'serverManager');
    return running;
  })();
  starting = pending;

  // Drop the latch however it settles: a failed bind must not wedge every
  // later invocation onto the same rejected promise. The catch() is on a
  // throwaway branch so the rejection still reaches the real caller. The
  // identity check matters because a disposeAll() during startup followed by a
  // fresh start would otherwise let this stale closure wipe out the live latch
  // and reopen the double-bind this guard exists to stop.
  pending
    .catch(() => undefined)
    .then(() => {
      if (starting === pending) {
        starting = null;
      }
    });
  return pending;
}

// Resolves to the URL to open. A second invocation on the same profile returns
// the same session and the same token, so it re-focuses rather than
// double-sampling the host.
export async function ensureSession(fileService: any, config: any): Promise<string> {
  const { port } = await ensureServer();
  const id = profileId(fileService.workspace, config);
  const identity = privilegedIdentity(config);

  // registry.get() itself tears down and evicts a session whose cached
  // identity no longer matches -- e.g. root_user/root_password were added,
  // removed, or edited in sftp.json since this session was opened. Without
  // that check a stale session would keep running commands under the old
  // identity (and the UI would keep reporting the old privilegedAs) until
  // VS Code restarted.
  const existingToken = registry.get(id, identity);
  if (existingToken) {
    return `http://127.0.0.1:${port}/?t=${existingToken}`;
  }

  const cfg = settings();
  const transport = sshTransport(fileService, config);
  // Built eagerly but never connects here: sshTransport only calls
  // getSshClient inside exec()/openSampler(), so this does not open a root
  // SSH session just because the dashboard was opened -- only the first
  // privileged command (systemctl, nginx -t, openssl) does that.
  const privileged = sshTransport(fileService, privilegedConfig(config));
  const token = crypto.randomBytes(32).toString('hex');
  const session = new ManagedSession(
    redactProfile(fileService.workspace, config),
    token,
    {
      transport,
      privilegedTransport: privileged,
      readFacts: (t: MonitorTransport) => readFacts(t, config.host),
      makeCollector: (t: MonitorTransport, facts: HostFacts) =>
        new Collector(t, {
          pageSize: facts.pageSize,
          clockTicks: 100,
          interval: cfg.interval,
          slowInterval: cfg.slowInterval,
          historyMinutes: cfg.historyMinutes,
        }),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: handle => clearTimeout(handle),
      now: () => Date.now(),
    },
    { graceMs: GRACE_MS, interval: cfg.interval }
  );

  session.activity.onEntry = entry =>
    logger.info(`${entry.label}: ${entry.command} -> ${entry.code}`, 'serverManager');

  // Only end the privileged lane's pooled connection when it is genuinely
  // its own -- see privilegedConnectionIsSeparate. When it shares the
  // session's own pooled fsTable entry, ending it would cut the user's live
  // SFTP connection out from under them.
  const disposePrivileged = privilegedConnectionIsSeparate(config)
    ? () => removeRemoteFs(getHostInfo(privilegedConfig(config)))
    : () => undefined;
  registry.set(id, token, { session, privilegedIdentity: identity, disposePrivileged });
  return `http://127.0.0.1:${port}/?t=${token}`;
}

export async function openInBrowser(target: string): Promise<void> {
  const openDefault = () => vscode.env.openExternal(vscode.Uri.parse(target));

  const launch = browserCommand(settings().browser, target, process.platform);
  if (!launch) {
    await openDefault();
    return;
  }
  try {
    // windowsHide keeps the `cmd /c start` hop from flashing a console window.
    const child = spawn(launch.cmd, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Deliberately not an async handler: openInBrowser has already resolved by
    // the time 'error' fires, so a rejection here would be unhandled. Log the
    // fallback's own failure instead of letting it escape.
    child.on('error', error => {
      // Chrome is not installed, or is not where we guessed. Fall back rather
      // than fail the command.
      logger.warn(
        `chrome launch failed (${error.message}); using the default browser`,
        'serverManager'
      );
      Promise.resolve(openDefault()).catch(fallbackError => {
        logger.error(fallbackError, 'serverManager');
      });
    });
    child.unref();
  } catch (error) {
    await openDefault();
  }
}

export function disposeAll(): void {
  registry.disposeAll();
  // Clear the latch too, so a dispose racing a start cannot leave a stale
  // in-flight promise that later invocations would join. Bumping the
  // generation orphans any start still binding: it will close its own server
  // rather than adopt it into a manager that has just been torn down.
  starting = null;
  generation += 1;
  if (running) {
    // closeServer, not server.close(): an already-upgraded WebSocket keeps
    // its socket out of http.Server#close()'s reach entirely, so a plain
    // close() would leave the Terminal socket -- and the shell it is bridged
    // to on the user's production host -- alive until the browser tab went
    // away. registry.disposeAll() above has already terminated the sockets
    // it knows about by token; this also catches any that outlived their
    // session.
    closeServer(running.server);
    running = null;
  }
}
