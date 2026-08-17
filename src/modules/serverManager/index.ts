import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import logger from '../../logger';
import { Collector, MonitorTransport } from '../monitor/collector';
import { sshTransport, readFacts } from '../monitor/transport';
import { HostFacts } from '../monitor/types';
import { profileId, redactProfile } from './registry';
import { ManagedSession } from './session';
import { createServer, listen } from './httpServer';
import { bootstrapHtml } from './bootstrap';
import { buildRoutes } from './routes';
import { browserCommand, BrowserKind } from './browser';

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
const byToken = new Map<string, ManagedSession>();
const byProfile = new Map<string, string>();

export function init(extensionPath: string): void {
  extensionRoot = extensionPath;
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
        sessions: { get: token => byToken.get(token) },
        pingMs: PING_MS,
        schedule: (fn, ms) => setInterval(fn, ms),
        cancel: handle => clearInterval(handle),
      }),
      hasToken: token => byToken.has(token),
      fallbackHtml: bootstrapHtml,
    });
    const port = await listen(server);
    if (startedAt !== generation) {
      // disposeAll() ran while we were binding. Nothing will ever own this
      // server, so close it here rather than leaking a held port, and fail the
      // caller instead of handing back a URL to a teardown in progress.
      server.close();
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

  const existingToken = byProfile.get(id);
  if (existingToken) {
    return `http://127.0.0.1:${port}/?t=${existingToken}`;
  }

  const cfg = settings();
  const transport = sshTransport(fileService, config);
  const token = crypto.randomBytes(32).toString('hex');
  const session = new ManagedSession(
    redactProfile(fileService.workspace, config),
    token,
    {
      transport,
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

  byToken.set(token, session);
  byProfile.set(id, token);
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
  byToken.forEach(session => session.dispose());
  byToken.clear();
  byProfile.clear();
  // Clear the latch too, so a dispose racing a start cannot leave a stale
  // in-flight promise that later invocations would join. Bumping the
  // generation orphans any start still binding: it will close its own server
  // rather than adopt it into a manager that has just been torn down.
  starting = null;
  generation += 1;
  if (running) {
    running.server.close();
    running = null;
  }
}
