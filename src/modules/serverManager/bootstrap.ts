// The page served when no UI build exists in media/webui — which is every run
// until the milestone that adds the React app, and any run where the vite build
// was skipped. It proves the whole pipe end to end: token, session lookup,
// SSE, live snapshots.
//
// There is deliberately no interpolation anywhere in this string. The token
// comes from location.search in the browser, so nothing server-side is ever
// spliced into markup and there is no injection surface at all.
export function bootstrapHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Server Manager</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #0b0b0c; color: #e6e6e6;
         font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8a8a8a; margin-bottom: 20px; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 999px;
            border: 1px solid #333; margin-bottom: 16px; }
  .online { color: #4ade80; border-color: #14532d; }
  .offline, .unsupported { color: #f87171; border-color: #7f1d1d; }
  .connecting, .idle { color: #fbbf24; border-color: #78350f; }
  pre { background: #141416; border: 1px solid #232326; border-radius: 8px;
        padding: 14px; overflow: auto; max-height: 40vh; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
       color: #8a8a8a; margin: 22px 0 8px; }
</style>
</head>
<body>
<h1 id="host">Server Manager</h1>
<div class="sub" id="who">connecting…</div>
<div class="status idle" id="status">idle</div>
<h2>Facts</h2><pre id="facts">–</pre>
<h2>Latest snapshot</h2><pre id="tick">waiting for the first sample…</pre>
<h2>Slow lane</h2><pre id="slow">–</pre>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('t') || sessionStorage.getItem('sftp-token') || '';
  if (params.get('t')) {
    sessionStorage.setItem('sftp-token', token);
    history.replaceState(null, '', location.pathname);
  }

  function show(id, value) {
    document.getElementById(id).textContent =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  function applyState(state) {
    var el = document.getElementById('status');
    el.className = 'status ' + state.status;
    el.textContent = state.error ? state.status + ' — ' + state.error : state.status;
    document.getElementById('host').textContent = state.profile.name;
    document.getElementById('who').textContent =
      state.profile.username + '@' + state.profile.host + ':' + state.profile.port;
    if (state.facts) { show('facts', state.facts); }
  }

  fetch('/api/session', { headers: { 'x-sftp-token': token } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(applyState)
    .catch(function (err) { show('status', 'cannot reach VS Code: ' + err.message); });

  var stream = new EventSource('/api/stream?t=' + encodeURIComponent(token));
  stream.addEventListener('state', function (e) { applyState(JSON.parse(e.data)); });
  stream.addEventListener('tick', function (e) { show('tick', JSON.parse(e.data).snapshot); });
  stream.addEventListener('slow', function (e) { show('slow', JSON.parse(e.data)); });
  stream.onerror = function () {
    var el = document.getElementById('status');
    el.className = 'status offline';
    el.textContent = 'VS Code disconnected';
  };
})();
</script>
</body>
</html>`;
}
