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
  // media/webui does not exist until the UI milestone; until then every request
  // falls through to the bootstrap page, which is exactly what we want. An
  // uninitialised root degrades the same way: a path that cannot exist.
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
  running = { server, port };
  logger.info(`server manager listening on 127.0.0.1:${port}`, 'serverManager');
  return running;
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
  const launch = browserCommand(settings().browser, target, process.platform);
  if (!launch) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  try {
    const child = spawn(launch.cmd, launch.args, { detached: true, stdio: 'ignore' });
    child.on('error', async error => {
      // Chrome is not installed, or is not where we guessed. Fall back rather
      // than fail the command.
      logger.warn(
        `chrome launch failed (${error.message}); using the default browser`,
        'serverManager'
      );
      await vscode.env.openExternal(vscode.Uri.parse(target));
    });
    child.unref();
  } catch (error) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
  }
}

export function disposeAll(): void {
  byToken.forEach(session => session.dispose());
  byToken.clear();
  byProfile.clear();
  if (running) {
    running.server.close();
    running = null;
  }
}
