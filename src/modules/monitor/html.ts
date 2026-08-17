export function escapeHtml(s: any): string {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 0 10px 16px; }
  .bar { position: sticky; top: 0; z-index: 3; background: var(--vscode-editor-background);
         border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 0; display: flex;
         gap: 10px; align-items: center; flex-wrap: wrap; }
  .bar .host { font-size: 14px; font-weight: 600; }
  .badge { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 8px;
           color: var(--vscode-descriptionForeground); }
  .spacer { flex: 1; }
  select, button, input { font-family: inherit; font-size: 12px;
           background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 6px; }
  button { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #gauges { display: flex; gap: 12px; align-items: center; }
  .ring { text-align: center; }
  .rlabel { color: var(--vscode-descriptionForeground); font-size: 10px; margin-top: -2px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-top: 10px;
          padding: 8px 10px; overflow: hidden; }
  .card h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
             color: var(--vscode-descriptionForeground); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .big { font-size: 22px; font-weight: 600; }
  .cores { display: flex; flex-wrap: wrap; gap: 2px; margin: 6px 0; }
  .core { position: relative; width: 9px; height: 26px; background: var(--vscode-panel-border); }
  .core > span { position: absolute; bottom: 0; left: 0; right: 0;
                 background: var(--vscode-charts-blue, #3794ff); }
  .kv { display: flex; gap: 16px; flex-wrap: wrap; color: var(--vscode-descriptionForeground); }
  .kv b { color: var(--vscode-foreground); font-weight: 600; }
  .meter { height: 8px; background: var(--vscode-panel-border); border-radius: 4px;
           overflow: hidden; margin: 4px 0; }
  .meter > span { display: block; height: 100%; background: var(--vscode-charts-blue, #3794ff); }
  .row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0;
         border-bottom: 1px solid var(--vscode-panel-border); }
  .row:last-child { border-bottom: none; }
  .legend { display: flex; gap: 12px; margin-top: 4px; color: var(--vscode-descriptionForeground); }
  .legend i { display: inline-block; width: 10px; height: 2px; vertical-align: middle;
              margin-right: 4px; }
  .tablewrap { overflow-x: auto; max-height: 420px; overflow-y: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border);
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background,
       var(--vscode-editor-background)); color: var(--vscode-descriptionForeground);
       cursor: pointer; user-select: none; }
  td.num, th.num { text-align: right; }
  .muted { color: var(--vscode-descriptionForeground); }
  .err { color: var(--vscode-errorForeground); }
  #offline { display: none; padding: 8px 10px; margin-top: 10px;
             border: 1px solid var(--vscode-errorForeground); border-radius: 6px; }
  canvas { width: 100%; display: block; }
`;

// The client script does presentation only: formatting, sorting, filtering and
// DOM assembly. Every number it renders was computed in metrics.ts, which is
// why none of the arithmetic here is more than a unit conversion. Written with
// string concatenation rather than template literals so it can live inside one.
const SCRIPT = `
  var vscode = acquireVsCodeApi();
  var facts = null, snap = null, slow = null, history = [];
  var sortKey = 'cpuPct', sortDir = -1, filterText = '', paused = false, hoverIdx = -1;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  // null means "not computable from the samples we have" — never render it as 0.
  function fmtBytes(n) {
    if (n === null || n === undefined) { return '—'; }
    var u = ['B', 'K', 'M', 'G', 'T', 'P'], i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v = v / 1024; i++; }
    var s = i === 0 ? String(Math.round(v)) : (v < 10 ? v.toFixed(2) : v.toFixed(1));
    return s.replace(/\\.0+$/, '').replace(/(\\.\\d)0$/, '$1') + ' ' + u[i];
  }
  function fmtRate(n) { return n === null || n === undefined ? '—' : fmtBytes(n) + '/s'; }
  function fmtPct(n, d) {
    return n === null || n === undefined ? '—' : n.toFixed(d === undefined ? 0 : d) + '%';
  }
  function fmtNum(n, d) {
    return n === null || n === undefined ? '—' : n.toFixed(d === undefined ? 0 : d);
  }
  function fmtMs(n) { return n === null || n === undefined ? '—' : n.toFixed(2) + ' ms'; }
  function fmtUptime(sec) {
    if (!sec) { return ''; }
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60);
    if (d > 0) { return 'up ' + d + 'd ' + h + 'h'; }
    if (h > 0) { return 'up ' + h + 'h ' + m + 'm'; }
    return 'up ' + m + 'm';
  }

  function ring(label, pct, color) {
    var r = 17, c = 2 * Math.PI * r, v = pct === null || pct === undefined ? 0 : pct;
    var on = (c * Math.min(v, 100) / 100).toFixed(2);
    return '<div class="ring"><svg width="44" height="44" viewBox="0 0 44 44">' +
      '<circle cx="22" cy="22" r="' + r + '" fill="none" stroke="var(--vscode-panel-border)" stroke-width="4"/>' +
      '<circle cx="22" cy="22" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="4" ' +
        'stroke-linecap="round" stroke-dasharray="' + on + ' ' + c.toFixed(2) + '" ' +
        'transform="rotate(-90 22 22)"/>' +
      '<text x="22" y="26" text-anchor="middle" font-size="11" fill="var(--vscode-foreground)">' +
        (pct === null || pct === undefined ? '—' : Math.round(v)) + '</text></svg>' +
      '<div class="rlabel">' + esc(label) + '</div></div>';
  }

  function renderGauges() {
    var diskPct = null;
    if (slow && slow.mounts.length) {
      var root = slow.mounts.filter(function (m) { return m.mount === '/'; })[0] || slow.mounts[0];
      diskPct = root.totalBytes > 0 ? (root.usedBytes / root.totalBytes) * 100 : null;
    }
    $('gauges').innerHTML =
      ring('CPU', snap && snap.cpu ? snap.cpu.total : null, cssVar('--vscode-charts-blue', '#3794ff')) +
      ring('RAM', snap ? snap.mem.usedPct : null, cssVar('--vscode-charts-purple', '#b180d7')) +
      ring('Disk', diskPct, cssVar('--vscode-charts-green', '#89d185'));
  }

  function renderCpu() {
    if (!snap) { return; }
    var c = snap.cpu;
    var cores = c ? c.cores : [];
    var bars = cores.map(function (p, i) {
      return '<div class="core" title="core ' + i + ': ' + p.toFixed(1) + '%">' +
        '<span style="height:' + Math.max(2, Math.min(100, p)).toFixed(1) + '%"></span></div>';
    }).join('');
    var b = c ? c.breakdown : null;
    $('cpubody').innerHTML =
      '<div class="kv"><span class="big">' + fmtPct(c ? c.total : null) + '</span>' +
        '<span class="muted" style="margin-left:auto">' + esc(facts ? facts.cpuModel : '') +
        (facts && facts.arch ? ' (' + esc(facts.arch) + ')' : '') + '</span></div>' +
      '<div class="cores">' + bars + '</div>' +
      '<div class="kv"><span>Cores <b>' + (cores.length || (facts ? facts.cores : 0)) + '</b></span>' +
        '<span>User <b>' + fmtPct(b ? b.user : null) + '</b></span>' +
        '<span>System <b>' + fmtPct(b ? b.system : null) + '</b></span>' +
        '<span>Nice <b>' + fmtPct(b ? b.nice : null) + '</b></span>' +
        '<span>IOWait <b>' + fmtPct(b ? b.iowait : null) + '</b></span>' +
        '<span>Steal <b>' + fmtPct(b ? b.steal : null) + '</b></span></div>';
  }

  function renderMem() {
    if (!snap) { return; }
    var m = snap.mem, r = 32, c = 2 * Math.PI * r;
    var colors = [cssVar('--vscode-charts-purple', '#b180d7'),
                  cssVar('--vscode-panel-border', '#555'),
                  cssVar('--vscode-charts-green', '#89d185')];
    var vals = [m.usedPct, m.cachedPct, m.freePct];
    var offset = 0, segs = '';
    for (var i = 0; i < vals.length; i++) {
      segs += '<circle cx="42" cy="42" r="' + r + '" fill="none" stroke="' + colors[i] + '" ' +
        'stroke-width="9" stroke-dasharray="' + (c * vals[i] / 100).toFixed(2) + ' ' + c.toFixed(2) +
        '" stroke-dashoffset="' + (-c * offset / 100).toFixed(2) + '" transform="rotate(-90 42 42)"/>';
      offset += vals[i];
    }
    $('membody').innerHTML =
      '<div style="display:flex;gap:14px;align-items:center">' +
        '<svg width="84" height="84" viewBox="0 0 84 84">' + segs +
          '<text x="42" y="40" text-anchor="middle" font-size="9" fill="var(--vscode-descriptionForeground)">Total</text>' +
          '<text x="42" y="52" text-anchor="middle" font-size="12" fill="var(--vscode-foreground)">' +
            fmtBytes(m.total) + '</text></svg>' +
        '<div style="flex:1">' +
          '<div class="row"><span style="color:' + colors[0] + '">Used</span><span><b>' +
            fmtBytes(m.used) + '</b> ' + fmtPct(m.usedPct) + '</span></div>' +
          '<div class="row"><span class="muted">Cached</span><span><b>' + fmtBytes(m.cached) +
            '</b> ' + fmtPct(m.cachedPct) + '</span></div>' +
          '<div class="row"><span style="color:' + colors[2] + '">Free</span><span><b>' +
            fmtBytes(m.free) + '</b> ' + fmtPct(m.freePct) + '</span></div>' +
        '</div></div>' +
      '<div style="margin-top:8px">' +
        '<div class="kv"><span>Swap</span><span style="margin-left:auto">' +
          (m.swapTotal > 0 ? fmtBytes(m.swapUsed) + ' of ' + fmtBytes(m.swapTotal) + ' used'
                           : 'disabled') + '</span></div>' +
        '<div class="meter"><span style="width:' + m.swapPct.toFixed(1) + '%"></span></div></div>';
  }

  function renderNet() {
    if (!snap) { return; }
    var addrs = {};
    if (slow) { slow.addrs.forEach(function (a) { addrs[a.name] = a.address; }); }
    if (!snap.net.length) { $('netbody').innerHTML = '<div class="muted">No interfaces.</div>'; return; }
    $('netbody').innerHTML = snap.net.map(function (n) {
      return '<div style="margin-bottom:6px">' +
        '<div class="kv"><b>' + esc(n.name) + '</b><span class="muted" style="margin-left:auto">' +
          esc(addrs[n.name] || '') + '</span></div>' +
        '<div class="row"><span>&#8593; up</span><span><b>' + fmtRate(n.txBps) +
          '</b> <span class="muted">total ' + fmtBytes(n.txTotal) + '</span></span></div>' +
        '<div class="row"><span>&#8595; down</span><span><b>' + fmtRate(n.rxBps) +
          '</b> <span class="muted">total ' + fmtBytes(n.rxTotal) + '</span></span></div></div>';
    }).join('');
  }

  function renderStorage() {
    if (!slow) { return; }
    if (!slow.mounts.length) { $('storagebody').innerHTML = '<div class="muted">No mounts reported.</div>'; return; }
    var io = {};
    if (snap) { snap.disks.forEach(function (d) { io[d.name] = d; }); }
    $('storagebody').innerHTML = slow.mounts.map(function (m) {
      var pct = m.totalBytes > 0 ? (m.usedBytes / m.totalBytes) * 100 : 0;
      var d = io[m.deviceName];
      var ioRows = d
        ? '<div class="row"><span>read</span><span>' + fmtRate(d.readBps) + ' &middot; ' +
            fmtMs(d.readLatencyMs) + ' &middot; ' + fmtNum(d.readIops) + ' IOPS &middot; total ' +
            fmtBytes(d.readTotal) + '</span></div>' +
          '<div class="row"><span>write</span><span>' + fmtRate(d.writeBps) + ' &middot; ' +
            fmtMs(d.writeLatencyMs) + ' &middot; ' + fmtNum(d.writeIops) + ' IOPS &middot; total ' +
            fmtBytes(d.writeTotal) + '</span></div>'
        : '<div class="row muted"><span>io</span><span>not reported for ' + esc(m.deviceName) + '</span></div>';
      return '<div style="margin-bottom:10px">' +
        '<div class="kv"><b>' + esc(m.device) + '</b><span class="muted">' + esc(m.mount) +
          '</span><span style="margin-left:auto">' + fmtBytes(m.usedBytes) + ' / ' +
          fmtBytes(m.totalBytes) + ' <span class="muted">' + esc(m.fstype) + '</span></span></div>' +
        '<div class="meter"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
        ioRows + '</div>';
    }).join('');
  }

  var COLS = [
    { key: 'pid', label: 'Pid', num: true },
    { key: 'comm', label: 'Process', num: false },
    { key: 'args', label: 'Args', num: false },
    { key: 'threads', label: 'Threads', num: true },
    { key: 'user', label: 'User', num: false },
    { key: 'cpuPct', label: 'CPU%', num: true },
    { key: 'rssBytes', label: 'Mem', num: true }
  ];

  function renderProcs() {
    if (!snap) { return; }
    var meta = {};
    if (slow) { slow.psRows.forEach(function (r) { meta[r.pid] = r; }); }
    var rows = snap.procs.map(function (p) {
      var m = meta[p.pid] || {};
      return { pid: p.pid, comm: p.comm, args: m.args || '', threads: p.threads,
               user: m.user || '', cpuPct: p.cpuPct, rssBytes: p.rssBytes };
    });
    if (filterText) {
      var f = filterText.toLowerCase();
      rows = rows.filter(function (r) {
        return String(r.comm).toLowerCase().indexOf(f) !== -1 ||
               String(r.args).toLowerCase().indexOf(f) !== -1;
      });
    }
    rows.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (x === null || x === undefined) { x = -1; }
      if (y === null || y === undefined) { y = -1; }
      if (typeof x === 'string' || typeof y === 'string') {
        return String(x).localeCompare(String(y)) * sortDir;
      }
      return (x - y) * sortDir;
    });

    var head = COLS.map(function (c) {
      var arrow = sortKey === c.key ? (sortDir < 0 ? ' ▾' : ' ▴') : '';
      return '<th data-key="' + c.key + '"' + (c.num ? ' class="num"' : '') + '>' +
        c.label + arrow + '</th>';
    }).join('');
    var body = rows.map(function (r) {
      return '<tr><td class="num">' + r.pid + '</td><td>' + esc(r.comm) + '</td><td title="' +
        esc(r.args) + '">' + esc(r.args) + '</td><td class="num">' + r.threads + '</td><td>' +
        esc(r.user) + '</td><td class="num">' + fmtPct(r.cpuPct, 1) + '</td><td class="num">' +
        fmtBytes(r.rssBytes) + '</td></tr>';
    }).join('');

    $('procbody').innerHTML = '<div class="tablewrap"><table><thead><tr>' + head +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="muted">' + rows.length + ' of ' + snap.procs.length + ' shown</div>';

    var ths = document.querySelectorAll('#procbody th');
    for (var i = 0; i < ths.length; i++) {
      ths[i].onclick = function () {
        var key = this.getAttribute('data-key');
        if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = -1; }
        renderProcs();
      };
    }
  }

  var SERIES = [
    { key: 'one', label: '1m', varName: '--vscode-charts-red', fallback: '#f14c4c' },
    { key: 'five', label: '5m', varName: '--vscode-charts-blue', fallback: '#3794ff' },
    { key: 'fifteen', label: '15m', varName: '--vscode-charts-yellow', fallback: '#cca700' }
  ];

  function drawChart() {
    var cv = $('loadchart');
    if (!cv) { return; }
    var w = cv.clientWidth || 600, h = cv.height;
    cv.width = w;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (history.length < 2) { return; }

    var max = 0.1;
    history.forEach(function (p) { max = Math.max(max, p.one, p.five, p.fifteen); });
    max = max * 1.15;
    var padL = 4, padR = 34, padT = 6, padB = 14;
    var plotW = Math.max(1, w - padL - padR), plotH = Math.max(1, h - padT - padB);
    var x = function (i) { return padL + (plotW * i) / (history.length - 1); };
    var y = function (v) { return padT + plotH - (plotH * v) / max; };

    ctx.strokeStyle = cssVar('--vscode-panel-border', '#444');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y(0) + 0.5); ctx.lineTo(padL + plotW, y(0) + 0.5); ctx.stroke();

    ctx.fillStyle = cssVar('--vscode-descriptionForeground', '#999');
    ctx.font = '10px var(--vscode-font-family)';
    ctx.fillText(max.toFixed(2), padL + plotW + 4, padT + 8);
    ctx.fillText('0', padL + plotW + 4, padT + plotH);

    SERIES.forEach(function (s) {
      ctx.strokeStyle = cssVar(s.varName, s.fallback);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      history.forEach(function (p, i) {
        var px = x(i), py = y(p[s.key]);
        if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
      });
      ctx.stroke();
    });

    if (hoverIdx >= 0 && hoverIdx < history.length) {
      ctx.strokeStyle = cssVar('--vscode-descriptionForeground', '#999');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(hoverIdx) + 0.5, padT);
      ctx.lineTo(x(hoverIdx) + 0.5, padT + plotH);
      ctx.stroke();
    }

    var p = history[hoverIdx >= 0 && hoverIdx < history.length ? hoverIdx : history.length - 1];
    var when = hoverIdx >= 0 ? new Date(p.at).toLocaleTimeString() + ' ' : 'Current load ';
    $('loadnow').innerHTML = esc(when) + '<b>' + p.one.toFixed(2) + ' / ' + p.five.toFixed(2) +
      ' / ' + p.fifteen.toFixed(2) + '</b>';
  }

  function renderAll() {
    renderGauges(); renderCpu(); renderMem(); renderNet(); renderStorage(); renderProcs(); drawChart();
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type === 'init') {
      facts = msg.facts;
      $('host').textContent = facts.hostname;
      $('distro').textContent = facts.prettyName || 'Linux';
      $('ivl').value = String(msg.interval);
      $('legend').innerHTML = SERIES.map(function (s) {
        return '<span><i style="background:' + cssVar(s.varName, s.fallback) + '"></i>' + s.label + '</span>';
      }).join('');
    } else if (msg.type === 'tick') {
      snap = msg.snapshot;
      history = msg.history || [];
      $('uptime').textContent = fmtUptime(snap.uptimeSec);
      $('offline').style.display = 'none';
      renderAll();
    } else if (msg.type === 'slow') {
      slow = msg.slow;
      renderGauges(); renderStorage(); renderNet(); renderProcs();
    } else if (msg.type === 'state') {
      if (msg.paused !== undefined) {
        paused = msg.paused;
        $('pause').textContent = paused ? 'Resume' : 'Pause';
      }
      if (msg.interval !== undefined) { $('ivl').value = String(msg.interval); }
    } else if (msg.type === 'connection') {
      $('offline').style.display = msg.up ? 'none' : 'block';
    } else if (msg.type === 'error') {
      $('errline').textContent = msg.message || '';
    }
  });

  $('pause').onclick = function () {
    vscode.postMessage(paused ? { type: 'resume' } : { type: 'pause' });
  };
  $('ivl').onchange = function () {
    vscode.postMessage({ type: 'setInterval', ms: Number($('ivl').value) });
  };
  $('procfilter').oninput = function () {
    filterText = $('procfilter').value || '';
    renderProcs();
  };
  $('reconnect').onclick = function () { vscode.postMessage({ type: 'reconnect' }); };

  var chart = $('loadchart');
  chart.addEventListener('mousemove', function (e) {
    if (history.length < 2) { return; }
    var rect = chart.getBoundingClientRect();
    var frac = (e.clientX - rect.left - 4) / Math.max(1, rect.width - 38);
    hoverIdx = Math.round(Math.min(1, Math.max(0, frac)) * (history.length - 1));
    drawChart();
  });
  chart.addEventListener('mouseleave', function () { hoverIdx = -1; drawChart(); });
  window.addEventListener('resize', function () { drawChart(); });

  vscode.postMessage({ type: 'ready' });
`;

export function monitorHtml(cspSource: string): string {
  // Inline style and script only, and no external origins: this policy is what
  // keeps the page unable to reach the network at all.
  const src = escapeHtml(cspSource);
  const csp =
    `default-src 'none'; img-src ${src} data:; style-src ${src} 'unsafe-inline'; ` +
    `script-src ${src} 'unsafe-inline'; font-src ${src};`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <style>${CSS}</style></head><body>
    <div class="bar">
      <span class="host" id="host">connecting…</span>
      <span class="badge" id="distro"></span>
      <span class="badge" id="uptime"></span>
      <span class="err" id="errline"></span>
      <div class="spacer"></div>
      <div id="gauges"></div>
      <button id="pause">Pause</button>
      <select id="ivl" title="Refresh interval">
        <option value="1000">1s</option>
        <option value="2000">2s</option>
        <option value="5000">5s</option>
        <option value="10000">10s</option>
      </select>
    </div>
    <div id="offline"><span class="err">Connection lost.</span>
      <button id="reconnect">Reconnect</button></div>
    <div class="card" id="cpu"><h3>CPU Usage</h3><div id="cpubody"></div></div>
    <div class="grid2">
      <div class="card" id="load"><h3>CPU Load</h3>
        <canvas id="loadchart" height="130"></canvas>
        <div class="legend" id="legend"></div>
        <div id="loadnow" class="muted"></div></div>
      <div class="card" id="procs"><h3>Processes</h3>
        <input id="procfilter" placeholder="filter by name or args…" style="width:100%;margin-bottom:6px">
        <div id="procbody"></div></div>
    </div>
    <div class="grid2">
      <div class="card" id="mem"><h3>Memory Usage</h3><div id="membody"></div></div>
      <div class="card" id="net"><h3>Network Usage</h3><div id="netbody"></div></div>
    </div>
    <div class="card" id="storage"><h3>Storage</h3><div id="storagebody"></div></div>
    <script>${SCRIPT}</script></body></html>`;
}
