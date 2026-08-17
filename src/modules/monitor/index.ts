import * as vscode from 'vscode';
import { Collector } from './collector';
import { sshTransport, readFacts } from './transport';
import { monitorHtml } from './html';
import { HostFacts } from './types';
import logger from '../../logger';

interface Session {
  panel: vscode.WebviewPanel;
  collector: Collector;
}

const sessions = new Map<string, Session>();

function keyFor(config: any): string {
  return `${config.name || ''}@${config.host}:${config.port}`;
}

function settings() {
  // Same access pattern as the db feature's `sftp.db.defaultLimit`.
  const cfg = vscode.workspace.getConfiguration('sftp.monitor');
  return {
    interval: cfg.get<number>('interval', 2000),
    slowInterval: cfg.get<number>('slowInterval', 10000),
    historyMinutes: cfg.get<number>('historyMinutes', 5),
  };
}

export async function openMonitor(fileService: any, config: any): Promise<void> {
  const key = keyFor(config);
  const existing = sessions.get(key);
  if (existing) {
    // Never open a second dashboard for one host: it would double-sample it.
    existing.panel.reveal();
    return;
  }

  const transport = sshTransport(fileService, config);
  let facts: HostFacts;
  try {
    facts = await readFacts(transport, config.host);
  } catch (error) {
    vscode.window.showErrorMessage(`Monitoring: ${(error as Error).message}`);
    return;
  }
  if (!facts.linux) {
    vscode.window.showErrorMessage(
      'Monitoring requires a Linux host (it reads /proc on the server).'
    );
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'sftpMonitor',
    `Monitor: ${config.name || facts.hostname}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = monitorHtml(panel.webview.cspSource);

  const cfg = settings();
  const collector = new Collector(transport, {
    pageSize: facts.pageSize,
    clockTicks: 100,
    interval: cfg.interval,
    slowInterval: cfg.slowInterval,
    historyMinutes: cfg.historyMinutes,
  });

  const post = (msg: any) => panel.webview.postMessage(msg);

  collector.onSnapshot = snapshot =>
    post({ type: 'tick', snapshot, history: collector.history().points() });
  collector.onSlow = slow => post({ type: 'slow', slow });
  collector.onError = error => {
    logger.error(error, 'monitor');
    post({ type: 'error', message: error.message });
  };
  collector.onClosed = () => post({ type: 'connection', up: false });

  panel.webview.onDidReceiveMessage(async (msg: any) => {
    if (msg.type === 'ready') {
      post({ type: 'init', facts, interval: cfg.interval });
      await collector.start();
    } else if (msg.type === 'pause') {
      collector.pause();
      post({ type: 'state', paused: true });
    } else if (msg.type === 'resume') {
      collector.resume();
      post({ type: 'state', paused: false });
    } else if (msg.type === 'setInterval') {
      const ms = Number(msg.ms) || cfg.interval;
      collector.setInterval(ms);
      post({ type: 'state', interval: ms });
    } else if (msg.type === 'reconnect') {
      try {
        // reconnect() rebuilds the cached connection; null means there was no
        // live connection to rebuild, in which case start() will make one.
        const pending = fileService.reconnect();
        if (pending) {
          await pending;
        }
        await collector.start();
        post({ type: 'connection', up: true });
      } catch (error) {
        post({ type: 'error', message: (error as Error).message });
      }
    }
  });

  // The collector's lifetime is the panel's lifetime, not its visibility:
  // polling deliberately continues while the tab is hidden.
  panel.onDidDispose(() => {
    collector.stop();
    sessions.delete(key);
  });

  sessions.set(key, { panel, collector });
}
