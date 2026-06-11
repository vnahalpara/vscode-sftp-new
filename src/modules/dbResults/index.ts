import * as vscode from 'vscode';

export interface TableResult {
  columns: string[];
  rows: any[][];
  footnote?: string;
}

let panel: vscode.WebviewPanel | undefined;
let last: TableResult | undefined;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toCsv(result: TableResult): string {
  const cell = (v: any) => {
    if (v === null || v === undefined) {
      return '';
    }
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [result.columns.map(cell).join(',')];
  for (const row of result.rows) {
    lines.push(row.map(cell).join(','));
  }
  return lines.join('\n');
}

function render(result: TableResult, title: string, durationMs?: number): string {
  const MAX_CELL = 1024;
  const head = result.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const body = result.rows
    .map(row => {
      const tds = row
        .map(v => {
          if (v === null || v === undefined) {
            return '<td class="null">NULL</td>';
          }
          let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
          let truncated = '';
          if (s.length > MAX_CELL) {
            truncated = ` title="${escapeHtml(s.slice(0, 200))}… (${s.length} chars)"`;
            s = s.slice(0, MAX_CELL) + '…';
          }
          return `<td${truncated}>${escapeHtml(s)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');

  const footer =
    `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}` +
    (durationMs !== undefined ? ` · ${durationMs} ms` : '') +
    (result.footnote ? ` · ${escapeHtml(result.footnote)}` : '');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 0 0 28px; margin: 0; }
    .toolbar { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); display:flex; gap:8px; align-items:center; }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; cursor: pointer; border-radius: 2px; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .title { font-weight: 600; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top; }
    th { position: sticky; top: 33px; background: var(--vscode-editorWidget-background); cursor: pointer; user-select: none; }
    tr:nth-child(even) { background: var(--vscode-list-hoverBackground); }
    td { cursor: pointer; }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    .footer { position: fixed; bottom: 0; left: 0; right: 0; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); padding: 3px 8px; }
  </style></head><body>
    <div class="toolbar"><span class="title">${escapeHtml(title)}</span><button onclick="exportCsv()">Export CSV</button></div>
    <table id="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="footer">${footer}</div>
    <script>
      const vscode = acquireVsCodeApi();
      function exportCsv(){ vscode.postMessage({ type: 'exportCsv' }); }
      const grid = document.getElementById('grid');
      grid.addEventListener('click', e => {
        if (e.target.tagName === 'TD') {
          vscode.postMessage({ type: 'copy', value: e.target.classList.contains('null') ? '' : e.target.textContent });
        }
      });
      let sortCol = -1, asc = true;
      grid.querySelectorAll('th').forEach((th, i) => th.addEventListener('click', () => {
        const tbody = grid.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        asc = sortCol === i ? !asc : true; sortCol = i;
        rows.sort((a,b) => {
          const x = a.children[i].textContent, y = b.children[i].textContent;
          const nx = parseFloat(x), ny = parseFloat(y);
          const cmp = (!isNaN(nx) && !isNaN(ny)) ? nx - ny : x.localeCompare(y);
          return asc ? cmp : -cmp;
        });
        rows.forEach(r => tbody.appendChild(r));
      }));
    </script>
  </body></html>`;
}

export function showResult(title: string, result: TableResult, durationMs?: number) {
  last = result;
  if (!panel) {
    panel = vscode.window.createWebviewPanel('sftpDbResults', 'Database Results', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'copy' && msg.value) {
        await vscode.env.clipboard.writeText(String(msg.value));
        vscode.window.setStatusBarMessage('Copied cell value', 1500);
      } else if (msg.type === 'exportCsv' && last) {
        const uri = await vscode.window.showSaveDialog({
          filters: { CSV: ['csv'] },
          saveLabel: 'Export CSV',
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(toCsv(last), 'utf8'));
          vscode.window.showInformationMessage(`Exported ${last.rows.length} rows to ${uri.fsPath}`);
        }
      }
    });
  }
  panel.title = title.length > 40 ? title.slice(0, 40) + '…' : title;
  panel.webview.html = render(result, title, durationMs);
  panel.reveal(vscode.ViewColumn.One, true);
}
