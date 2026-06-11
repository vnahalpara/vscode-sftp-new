import * as vscode from 'vscode';
import app from '../../app';
import { getDbClient } from '../../core/dbConnectionManager';
import { DbClient, ColumnInfo } from '../../core/dbClient';
import {
  buildWhere,
  buildOrderBy,
  buildSelect,
  buildCount,
  buildUpdate,
  FILTER_OPS,
  Sort,
  Filter,
} from '../../core/dbQuery';
import { DbTarget } from '../dbSession';
import logger from '../../logger';

const PAGE_SIZES = [10, 30, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 30;

interface ViewState {
  page: number;
  pageSize: number;
  sort: Sort | null;
  filter: Filter | null;
}

interface Session {
  panel: vscode.WebviewPanel;
  target: DbTarget;
  table: string;
  client: DbClient;
  allColumns: string[];
  meta: ColumnInfo[];
}

const panels = new Map<string, Session>();

function keyFor(target: DbTarget, table: string): string {
  const c = target.config;
  return `${c.host}:${c.port || ''}:${c.context || c.remotePath || c.name}|${target.dbConfig.name}|${table}`;
}

function savedState(key: string): ViewState {
  const saved =
    (app.context && app.context.workspaceState.get<Partial<ViewState>>(`dbview:${key}`)) || {};
  return {
    page: 1,
    pageSize: saved.pageSize && PAGE_SIZES.indexOf(saved.pageSize) !== -1 ? saved.pageSize : DEFAULT_PAGE_SIZE,
    sort: saved.sort || null,
    filter: saved.filter || null,
  };
}

function persist(key: string, state: ViewState) {
  if (app.context) {
    // page is intentionally not persisted (reopen starts at page 1)
    app.context.workspaceState.update(`dbview:${key}`, {
      pageSize: state.pageSize,
      sort: state.sort,
      filter: state.filter,
    });
  }
}

async function fetchPage(session: Session, state: ViewState) {
  const { client, table, allColumns } = session;
  const where = buildWhere(state.filter, allColumns);
  const countBuilt = buildCount(table, where);
  const countRes = await client.query(countBuilt.sql, countBuilt.params);
  const total = countRes.rows.length ? Number(countRes.rows[0][0]) : 0;
  const sel = buildSelect(table, {
    where,
    orderBy: buildOrderBy(state.sort),
    limit: state.pageSize,
    offset: Math.max(0, (state.page - 1) * state.pageSize),
  });
  const res = await client.query(sel.sql, sel.params);
  return { columns: res.columns, rows: res.rows, total };
}

async function load(session: Session, state: ViewState) {
  const key = keyFor(session.target, session.table);
  try {
    const { columns, rows, total } = await fetchPage(session, state);
    persist(key, state);
    session.panel.webview.postMessage({
      type: 'data',
      columns,
      rows,
      total,
      state,
      allColumns: session.allColumns,
      meta: session.meta,
      ops: FILTER_OPS,
      pageSizes: PAGE_SIZES,
    });
  } catch (err) {
    logger.error(err, 'db data browser');
    session.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
  }
}

async function saveRow(session: Session, msg: any) {
  const set = msg.set || {};
  const where = msg.where || {};
  if (Object.keys(set).length === 0) {
    session.panel.webview.postMessage({ type: 'saved', message: 'No changes to save.' });
    return;
  }
  if (Object.keys(where).length === 0) {
    session.panel.webview.postMessage({ type: 'editError', message: 'Cannot identify the row to update.' });
    return;
  }
  const built = buildUpdate(session.table, set, where, !msg.usingPk);
  try {
    await session.client.query(built.sql, built.params);
    session.panel.webview.postMessage({ type: 'saved', message: 'Row updated.' });
    load(session, msg.state as ViewState);
  } catch (err) {
    session.panel.webview.postMessage({ type: 'editError', message: (err as Error).message });
  }
}

export async function openTableBrowser(target: DbTarget, table: string) {
  const key = keyFor(target, table);
  const existing = panels.get(key);
  if (existing) {
    existing.panel.reveal();
    return;
  }

  const client = getDbClient(target.fileService, target.config, target.dbConfig);
  let meta: ColumnInfo[] = [];
  try {
    meta = await client.listColumns(table);
  } catch (err) {
    vscode.window.showErrorMessage(`Open ${table}: ${(err as Error).message}`);
    return;
  }
  const allColumns = meta.map(c => c.name);

  const panel = vscode.window.createWebviewPanel(
    'sftpDbTable',
    `${table} @ ${target.dbConfig.name}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = html(table, target.dbConfig.name);

  const session: Session = { panel, target, table, client, allColumns, meta };
  panels.set(key, session);

  panel.onDidDispose(() => panels.delete(key));
  panel.webview.onDidReceiveMessage(async (msg: any) => {
    if (msg.type === 'query') {
      load(session, msg.state as ViewState);
    } else if (msg.type === 'copy') {
      vscode.env.clipboard.writeText(String(msg.value || ''));
      vscode.window.setStatusBarMessage('Copied cell value', 1500);
    } else if (msg.type === 'save') {
      await saveRow(session, msg);
    }
  });

  load(session, savedState(key));
}

function html(table: string, db: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); margin: 0; padding: 0 0 8px; }
    .bar { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .bar .grp { display: flex; gap: 4px; align-items: center; }
    select, input, button, textarea { font-family: inherit; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 5px; }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; border: none; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: .5; cursor: default; }
    input.val { width: 180px; }
    .spacer { flex: 1; }
    .muted { color: var(--vscode-descriptionForeground); }
    #busy { display: none; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); }
    .spin { width: 12px; height: 12px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: sp .7s linear infinite; display: inline-block; }
    @keyframes sp { to { transform: rotate(360deg); } }
    /* swallows clicks while a query is running so repeated clicks don't queue queries */
    #block { display: none; position: fixed; inset: 0; z-index: 5; cursor: progress; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    th { position: sticky; top: 39px; background: var(--vscode-editorWidget-background); cursor: pointer; user-select: none; }
    th .arrow { color: var(--vscode-textLink-foreground); }
    tr:nth-child(even) td { background: var(--vscode-list-hoverBackground); }
    td { cursor: pointer; }
    td.editc { text-align: center; width: 1%; }
    td.editc a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    .err { color: var(--vscode-errorForeground); padding: 8px; }
    /* editor overlay */
    #ov { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 10; }
    #ov .card { position: absolute; top: 4vh; left: 50%; transform: translateX(-50%); width: min(620px, 92vw); max-height: 90vh; overflow: auto; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); box-shadow: 0 4px 16px rgba(0,0,0,.4); }
    #ov .card h3 { margin: 0; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    #ov .form { padding: 8px 12px; }
    #ov .frow { display: grid; grid-template-columns: 160px 1fr auto; gap: 8px; align-items: center; padding: 3px 0; }
    #ov .frow label { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
    #ov .frow .pk { color: var(--vscode-textLink-foreground); }
    #ov .frow input, #ov .frow select, #ov .frow textarea { width: 100%; box-sizing: border-box; }
    #ov .frow textarea { min-height: 48px; resize: vertical; }
    #ov .nullbox { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    #ov pre { margin: 0; padding: 8px 12px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; word-break: break-all; border-top: 1px solid var(--vscode-panel-border); }
    #ov .foot { padding: 10px 12px; display: flex; gap: 8px; align-items: center; border-top: 1px solid var(--vscode-panel-border); position: sticky; bottom: 0; background: var(--vscode-editor-background); }
    #ov .status { color: var(--vscode-descriptionForeground); }
    #ov .status.error { color: var(--vscode-errorForeground); }
    /* single-cell editor */
    #cellov { display: none; position: absolute; z-index: 20; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-focusBorder); box-shadow: 0 4px 14px rgba(0,0,0,.45); padding: 6px; width: 340px; max-width: 92vw; }
    #cellov .ch { font-weight: 600; margin-bottom: 4px; }
    #cellov textarea { width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical; }
    #cellov .cf { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
    #cellov .status { color: var(--vscode-descriptionForeground); margin-top: 4px; min-height: 14px; }
    #cellov .status.error { color: var(--vscode-errorForeground); }
  </style></head><body>
  <div class="bar">
    <div class="grp"><strong>${escapeHtml(table)}</strong> <span class="muted">${escapeHtml(db)}</span></div>
    <div class="grp">
      <span class="muted">Filter</span>
      <select id="fcol"></select>
      <select id="fop"></select>
      <input id="fval" class="val" placeholder="value" />
      <button id="apply">Apply</button>
      <button id="clear">Clear</button>
    </div>
    <div class="grp" id="busy"><span class="spin"></span> Loading…</div>
    <div class="spacer"></div>
    <div class="grp"><span class="muted">Rows</span><select id="psize"></select></div>
    <div class="grp">
      <button id="prev">‹ Prev</button>
      <span id="pageinfo" class="muted"></span>
      <button id="next">Next ›</button>
    </div>
  </div>
  <div id="content"></div>
  <div id="block"></div>

  <div id="ov"><div class="card">
    <h3 id="ovtitle">Edit row</h3>
    <div class="form" id="ovform"></div>
    <pre id="ovsql"></pre>
    <div class="foot">
      <button class="primary" id="ovsave">Save</button>
      <button id="ovcancel">Cancel</button>
      <span class="status" id="ovstatus"></span>
    </div>
  </div></div>

  <div id="cellov">
    <div class="ch"><span id="celltitle"></span></div>
    <textarea id="cellta" rows="4"></textarea>
    <div class="cf">
      <span id="cellnullwrap"><input type="checkbox" id="cellnull"/> NULL</span>
      <span class="spacer"></span>
      <button class="primary" id="cellsave">Save</button>
      <button id="cellcancel">Cancel</button>
    </div>
    <div class="status" id="cellstatus"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const tableName = ${JSON.stringify(table)};
    let state = { page: 1, pageSize: ${DEFAULT_PAGE_SIZE}, sort: null, filter: null };
    let allColumns = [], ops = [], pageSizes = [], total = 0, meta = [], lastColumns = [], lastRows = [];
    let editFields = null, editOrig = null;
    const $ = id => document.getElementById(id);
    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function metaOf(col){ for (var i=0;i<meta.length;i++) if (meta[i].name===col) return meta[i]; return { name: col, type: '', nullable: true, key: '' }; }

    let busy = false;
    function setBusy(b){
      busy = b;
      $('busy').style.display = b ? 'flex' : 'none';
      $('block').style.display = b ? 'block' : 'none';
      ['apply','clear','prev','next','psize','fcol','fop','fval'].forEach(id => $(id).disabled = b);
    }
    // ignore new queries while one is running, so repeated header/page clicks don't stack
    function send(){ if (busy) return; setBusy(true); vscode.postMessage({ type: 'query', state }); }

    function populateControls(){
      $('fcol').innerHTML = '<option value="">(anywhere)</option>' + allColumns.map(c => '<option>'+esc(c)+'</option>').join('');
      $('fop').innerHTML = ops.map(o => '<option>'+o+'</option>').join('');
      $('psize').innerHTML = pageSizes.map(p => '<option>'+p+'</option>').join('');
      const f = state.filter || { column: '', op: '=', value: '' };
      $('fcol').value = f.column || '';
      $('fop').value = f.op || '=';
      $('fval').value = f.value || '';
      $('psize').value = String(state.pageSize);
    }

    function render(columns, rows){
      lastColumns = columns; lastRows = rows;
      const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
      $('pageinfo').textContent = 'Page ' + state.page + ' / ' + totalPages + ' · ' + total + ' rows';
      $('prev').disabled = state.page <= 1;
      $('next').disabled = state.page >= totalPages;
      const head = '<th></th>' + columns.map(c => {
        let arrow = '';
        if (state.sort && state.sort.column === c) arrow = ' <span class="arrow">' + (state.sort.dir === 'DESC' ? '▼' : '▲') + '</span>';
        return '<th data-col="'+esc(c)+'">'+esc(c)+arrow+'</th>';
      }).join('');
      const body = rows.map((r, ri) => '<tr><td class="editc"><a data-edit="'+ri+'">✎ edit</a></td>' + r.map((v,i) => {
        if (v === null) return '<td class="null" data-ri="'+ri+'" data-col="'+esc(columns[i])+'" data-null="1">NULL</td>';
        const s = esc(v);
        return '<td data-ri="'+ri+'" data-col="'+esc(columns[i])+'" data-val="'+s+'">'+s+'</td>';
      }).join('') + '</tr>').join('');
      $('content').innerHTML = '<table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table>';
      document.querySelectorAll('th[data-col]').forEach(th => th.onclick = () => {
        const col = th.getAttribute('data-col');
        if (state.sort && state.sort.column === col) state.sort = { column: col, dir: state.sort.dir === 'ASC' ? 'DESC' : 'ASC' };
        else state.sort = { column: col, dir: 'ASC' };
        state.page = 1; send();
      });
      document.querySelectorAll('a[data-edit]').forEach(a => a.onclick = () => openEdit(parseInt(a.getAttribute('data-edit'),10)));
      document.querySelectorAll('#content td[data-col]').forEach(td => td.onclick = (e) => {
        e.stopPropagation();
        openCellEdit(parseInt(td.getAttribute('data-ri'),10), td.getAttribute('data-col'), td);
      });
    }

    // ----- single-cell editor -----
    let cellCtx = null, activeEditor = null;
    function whereForRow(origByName){
      const pkCols = meta.filter(m => m.key === 'PRI').map(m => m.name);
      const usingPk = pkCols.length > 0;
      const where = {};
      (usingPk ? pkCols : lastColumns).forEach(c => { where[c] = origByName[c]; });
      return { where, usingPk };
    }
    function openCellEdit(ri, col, td){
      const ci = lastColumns.indexOf(col);
      const orig = lastRows[ri][ci];
      const cm = metaOf(col);
      const origByName = {}; for (var k=0;k<lastColumns.length;k++) origByName[lastColumns[k]] = lastRows[ri][k];
      cellCtx = { col, cm, orig, origByName };
      const box = $('cellov');
      const rect = td.getBoundingClientRect();
      box.style.left = (rect.left + window.scrollX) + 'px';
      box.style.top = (rect.bottom + window.scrollY) + 'px';
      box.style.minWidth = Math.max(rect.width, 260) + 'px';
      $('celltitle').textContent = col;
      const ta = $('cellta'); ta.value = orig === null ? '' : String(orig); ta.disabled = (orig === null);
      const nb = $('cellnull');
      if (cm.nullable) { $('cellnullwrap').style.display = ''; nb.checked = (orig === null); }
      else { $('cellnullwrap').style.display = 'none'; nb.checked = false; }
      $('cellstatus').textContent = ''; $('cellstatus').className = 'status'; $('cellsave').disabled = false;
      box.style.display = 'block';
      ta.focus(); ta.select();
    }
    function closeCell(){ $('cellov').style.display = 'none'; cellCtx = null; }
    function saveCell(){
      if (!cellCtx) return;
      const v = $('cellnull').checked ? null : $('cellta').value;
      if (sameValue(v, cellCtx.orig)) { closeCell(); return; }
      const w = whereForRow(cellCtx.origByName);
      activeEditor = 'cell';
      $('cellstatus').textContent = 'Saving…'; $('cellstatus').className = 'status'; $('cellsave').disabled = true;
      vscode.postMessage({ type: 'save', set: oneField(cellCtx.col, v), where: w.where, usingPk: w.usingPk, state });
    }
    function oneField(col, v){ const o = {}; o[col] = v; return o; }
    $('cellsave').onclick = saveCell;
    $('cellcancel').onclick = closeCell;
    $('cellnull').onchange = () => { $('cellta').disabled = $('cellnull').checked; };
    document.addEventListener('mousedown', (e) => {
      const box = $('cellov');
      if (box.style.display === 'block' && !box.contains(e.target)) closeCell();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCell(); $('ov').style.display='none'; } });

    // ----- row editor -----
    function inputFor(col, value){
      const t = String(col.type || '').toLowerCase();
      const isNull = value === null;
      let el, kind = 'text';
      if (t.indexOf('datetime') === 0 || t.indexOf('timestamp') === 0) {
        el = document.createElement('input'); el.type = 'datetime-local'; el.step = '1';
        el.value = isNull ? '' : String(value).replace(' ', 'T'); kind = 'datetime';
      } else if (t === 'date') {
        el = document.createElement('input'); el.type = 'date'; el.value = isNull ? '' : String(value);
      } else if (t.indexOf('time') === 0) {
        el = document.createElement('input'); el.type = 'time'; el.step = '1'; el.value = isNull ? '' : String(value);
      } else if (t === 'tinyint(1)') {
        el = document.createElement('select'); el.innerHTML = '<option value="0">0</option><option value="1">1</option>';
        el.value = isNull ? '0' : String(value);
      } else if (t.indexOf('enum(') === 0) {
        el = document.createElement('select');
        const vals = (t.match(/'((?:[^'\\\\]|\\\\.)*)'/g) || []).map(s => s.slice(1, -1));
        el.innerHTML = vals.map(v => '<option>'+esc(v)+'</option>').join('');
        if (!isNull) el.value = String(value);
      } else if (/^(int|bigint|smallint|mediumint|tinyint|decimal|float|double|numeric)/.test(t)) {
        el = document.createElement('input'); el.type = 'number'; el.step = 'any'; el.value = isNull ? '' : String(value);
      } else if (t.indexOf('text') !== -1 || t === 'json' || t.indexOf('blob') !== -1) {
        el = document.createElement('textarea'); el.value = isNull ? '' : String(value);
      } else {
        el = document.createElement('input'); el.type = 'text'; el.value = isNull ? '' : String(value);
      }
      el.oninput = refreshPreview; el.onchange = refreshPreview;
      return { el, kind };
    }

    function openEdit(rowIndex){
      const row = lastRows[rowIndex];
      editOrig = {};
      for (var i=0;i<lastColumns.length;i++) editOrig[lastColumns[i]] = row[i];
      const form = $('ovform'); form.innerHTML = '';
      editFields = [];
      lastColumns.forEach(col => {
        const cm = metaOf(col);
        const orig = editOrig[col];
        const field = inputFor(cm, orig);
        const wrap = document.createElement('div'); wrap.className = 'frow';
        const lab = document.createElement('label');
        lab.innerHTML = esc(col) + (cm.key === 'PRI' ? ' <span class="pk">PK</span>' : '');
        lab.title = cm.type;
        const nullWrap = document.createElement('span'); nullWrap.className = 'nullbox';
        let nullBox = null;
        if (cm.nullable) {
          nullBox = document.createElement('input'); nullBox.type = 'checkbox'; nullBox.checked = (orig === null);
          nullBox.onchange = () => { field.el.disabled = nullBox.checked; refreshPreview(); };
          field.el.disabled = nullBox.checked;
          nullWrap.appendChild(nullBox); nullWrap.appendChild(document.createTextNode(' NULL'));
        }
        wrap.appendChild(lab); wrap.appendChild(field.el); wrap.appendChild(nullWrap);
        form.appendChild(wrap);
        editFields.push({ col, field, nullBox, orig });
      });
      $('ovstatus').textContent = ''; $('ovstatus').className = 'status';
      refreshPreview();
      $('ov').style.display = 'block';
    }

    function currentValue(f){
      if (f.nullBox && f.nullBox.checked) return null;
      let v = f.field.el.value;
      if (f.field.kind === 'datetime') v = v.replace('T', ' ');
      return v;
    }
    function sameValue(a, b){
      if (a === null || b === null) return a === b;
      return String(a) === String(b);
    }
    function computeChange(){
      const set = {};
      editFields.forEach(f => { const v = currentValue(f); if (!sameValue(v, f.orig)) set[f.col] = v; });
      const w = whereForRow(editOrig);
      return { set, where: w.where, usingPk: w.usingPk };
    }
    function sqlLit(v){ return v === null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; }
    function refreshPreview(){
      const ch = computeChange();
      const cols = Object.keys(ch.set);
      if (cols.length === 0) { $('ovsql').textContent = '-- no changes'; $('ovsave').disabled = true; return; }
      $('ovsave').disabled = false;
      const setSql = cols.map(c => '\`'+c+'\` = ' + sqlLit(ch.set[c])).join(', ');
      const whereSql = Object.keys(ch.where).map(c => ch.where[c] === null ? '\`'+c+'\` IS NULL' : '\`'+c+'\` = ' + sqlLit(ch.where[c])).join(' AND ');
      $('ovsql').textContent = 'UPDATE \`' + tableName + '\` SET ' + setSql + ' WHERE ' + whereSql + (ch.usingPk ? '' : ' LIMIT 1') + ';';
    }
    function closeEdit(){ $('ov').style.display = 'none'; editFields = null; editOrig = null; }
    $('ovcancel').onclick = closeEdit;
    $('ov').onclick = (e) => { if (e.target.id === 'ov') closeEdit(); };
    $('ovsave').onclick = () => {
      const ch = computeChange();
      if (Object.keys(ch.set).length === 0) return;
      activeEditor = 'row';
      $('ovstatus').textContent = 'Saving…'; $('ovstatus').className = 'status'; $('ovsave').disabled = true;
      vscode.postMessage({ type: 'save', set: ch.set, where: ch.where, usingPk: ch.usingPk, state });
    };

    $('apply').onclick = () => {
      const col = $('fcol').value, op = $('fop').value, value = $('fval').value;
      state.filter = (op === 'IS NULL' || op === 'IS NOT NULL' || value !== '') ? { column: col || null, op, value } : null;
      state.page = 1; send();
    };
    $('clear').onclick = () => { state.filter = null; $('fval').value=''; state.page = 1; send(); };
    $('psize').onchange = () => { state.pageSize = parseInt($('psize').value, 10); state.page = 1; send(); };
    $('prev').onclick = () => { if (state.page > 1) { state.page--; send(); } };
    $('next').onclick = () => { state.page++; send(); };
    $('fval').onkeydown = (e) => { if (e.key === 'Enter') $('apply').click(); };

    window.addEventListener('message', ev => {
      const m = ev.data;
      if (m.type === 'error') { setBusy(false); $('content').innerHTML = '<div class="err">'+esc(m.message)+'</div>'; return; }
      if (m.type === 'saved') {
        if (activeEditor === 'cell') { $('cellstatus').textContent = m.message; setTimeout(closeCell, 500); }
        else { $('ovstatus').textContent = m.message; setTimeout(closeEdit, 600); }
        return;
      }
      if (m.type === 'editError') {
        if (activeEditor === 'cell') { $('cellstatus').textContent = m.message; $('cellstatus').className = 'status error'; $('cellsave').disabled = false; }
        else { $('ovstatus').textContent = m.message; $('ovstatus').className = 'status error'; $('ovsave').disabled = false; }
        return;
      }
      if (m.type !== 'data') return;
      setBusy(false);
      state = m.state; allColumns = m.allColumns; ops = m.ops; pageSizes = m.pageSizes; total = m.total; meta = m.meta || [];
      populateControls();
      render(m.columns, m.rows);
    });
  </script>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
