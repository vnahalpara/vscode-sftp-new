import * as vscode from 'vscode';
import { loadCloneState } from './cloneOrchestrator';
import { fmtBytes } from './noData';
import { CloneState } from './cloneState';

let panel: vscode.WebviewPanel | undefined;

function esc(s: any): string {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function row(k: string, v: string): string {
  return `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
}

function render(rc: any, state: CloneState): string {
  const sizes = state.sizes || {};
  const sizeRows = Object.keys(sizes)
    .map(k => `<tr><td>${esc(k)}</td><td>${esc(fmtBytes(sizes[k]))}</td></tr>`)
    .join('');
  const steps = state.steps || {};
  const stepRows = Object.keys(steps)
    .map(k => {
      const s = steps[k];
      const color =
        s.status === 'done'
          ? 'var(--vscode-testing-iconPassed, #3fb950)'
          : s.status === 'error'
          ? 'var(--vscode-errorForeground)'
          : 'var(--vscode-descriptionForeground)';
      return `<tr><td>${esc(k)}</td><td style="color:${color}">${esc(s.status)}</td><td>${esc(s.message || '')}</td><td>${esc(s.at || '')}</td></tr>`;
    })
    .join('');
  const preserved = state.preservedEnv ? Object.keys(state.preservedEnv).join(', ') : '—';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); padding: 12px; }
    h2 { margin: 0 0 8px; } h3 { margin: 16px 0 6px; }
    table { border-collapse: collapse; margin-bottom: 8px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    code { color: var(--vscode-textPreformat-foreground); }
  </style></head><body>
    <h2>Clone: ${esc(rc.name)}</h2>
    <table>
      ${row('Hostname', `<code>${esc(rc.hostname)}</code>`)}
      ${row('Local path', `<code>${esc(rc.localPath)}</code>`)}
      ${row('Platform', esc(state.platform || 'unknown'))}
      ${row('PHP', esc(state.phpVersion || '—'))}
      ${row('mysqldump on server', state.hasMysqldump ? 'yes' : 'NO')}
      ${row('Git remote', esc(state.gitRemote || '—'))}
      ${row('Local database', `<code>${esc(state.localDatabase || rc.localDb.name)}</code>`)}
      ${row('Preserved env.php', esc(preserved))}
    </table>
    <h3>Sizes</h3>
    <table><tr><th>path</th><th>size</th></tr>${sizeRows || '<tr><td colspan=2>—</td></tr>'}</table>
    <h3>Steps</h3>
    <table><tr><th>step</th><th>status</th><th>detail</th><th>at</th></tr>${stepRows || '<tr><td colspan=4>not started</td></tr>'}</table>
    <p class="muted">Phase 1 (backbone) pulls code/db/media locally. Provisioning &amp; serving land in Phase 2.</p>
  </body></html>`;
}

export function showCloneStatus(target: { fileService: any; config: any }): void {
  const { rc, state } = loadCloneState(target);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('sftpCloneStatus', 'Clone Status', vscode.ViewColumn.One, {
      enableScripts: false,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => (panel = undefined));
  }
  panel.title = `Clone: ${rc.name}`;
  panel.webview.html = render(rc, state);
  panel.reveal(vscode.ViewColumn.One);
}
