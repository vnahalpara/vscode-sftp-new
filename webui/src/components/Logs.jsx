import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, getToken } from '../api.js';
import { Badge, Card, Empty } from './ui.jsx';
import { fmtBytes } from '../format';

// The DOM cannot hold an unbounded log -- a `tail -F` on a busy access log
// can produce lines forever. This is the single cap shared by the one-shot
// snapshot (GET /api/file) and by live follow output (WS /ws/logs): once the
// rendered buffer would exceed it, the OLDEST lines are dropped and
// `dropped` is incremented so the UI can say so plainly, rather than
// silently discarding output -- see useLineBuffer below.
const MAX_LINES = 2000;

// GET /api/file's own `lines` param -- see routes.ts / ops/command.ts's
// readFileCommand: this is clamped server-side to at most 5000, and the
// default (no/garbage `lines`) is 400. 500 is comfortably inside that,
// small enough to load fast, and — since it's well under MAX_LINES above —
// never triggers a spurious "lines dropped" notice on a plain snapshot.
const TAIL_LINES = 500;

// logFollow.ts's own two-code convention (see that file's module comment,
// and terminal.ts's identical one that it deliberately mirrors): 1000 is the
// ONLY clean stop -- either this component's own explicit Stop, or the
// server's own clean teardown. Every other code, INCLUDING an abnormal 1006
// (no close frame at all -- the network just dropped), is a failure and
// must be rendered as one; there is no third "ended fine, but not by
// request" bucket to fall through to.
const CLOSE_NORMAL = 1000;

function wsUrl(target) {
  const params = new URLSearchParams();
  if (target.kind === 'file') {
    params.set('path', target.path);
  } else {
    params.set('unit', target.unit);
  }
  // Same header-can't-travel-on-a-WebSocket reasoning as Terminal.jsx's
  // wsUrl: the token has to ride the query string here, not the
  // x-sftp-token header apiGet/apiPost use.
  params.set('t', getToken());
  return `ws://${location.host}/ws/logs?${params.toString()}`;
}

// ---------------------------------------------------------------- picker --

// logDiscoveryCommand (ops/command.ts) walks every regular file under
// /var/log to depth 3 and reports all of them -- on a stock Ubuntu host
// that includes rotated (`access.log.1`), compressed (`syslog.2.gz`) and
// binary login-accounting logs (`wtmp`, `btmp`, `lastlog`, `faillog`) that
// `tail`/`sed` render as garbage or mostly-garbage text. These are still
// real, legitimate discoveries -- hiding them outright would make the
// picker quietly lie about what the scan actually found, and an operator
// might genuinely want to open a `.1` while `logrotate` is mid-rotation.
// DEPRIORITISE, not hide: they render in a separate, collapsed-by-default
// group below the primary list, each tagged with why it's there, so the
// primary list stays usable at a glance without losing anything.
const COMPRESSED_RE = /\.(gz|bz2|xz|zip)$/i;
const ROTATED_RE = /\.\d+$/;
const BINARY_BASENAMES = new Set(['wtmp', 'btmp', 'lastlog', 'faillog']);

function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function classify(file) {
  const name = basename(file.path);
  if (BINARY_BASENAMES.has(name)) {
    return 'binary';
  }
  if (COMPRESSED_RE.test(name)) {
    return 'archived';
  }
  if (ROTATED_RE.test(name) || /\.old$/i.test(name)) {
    return 'rotated';
  }
  return 'primary';
}

function tagTone(tag) {
  return tag === 'binary' ? 'warn' : '';
}

// ------------------------------------------------------------ line buffer --

// Shared by the one-shot snapshot and the live follow stream, so both paths
// enforce the exact same cap and report drops the exact same way -- there
// is only one buffer, not two independently-capped ones that could drift.
function useLineBuffer() {
  const [lines, setLines] = useState([]);
  const [dropped, setDropped] = useState(0);
  // A follow chunk boundary rarely lands on a '\n' -- this carries whatever
  // trailing partial line one chunk left off, across to the next, so a line
  // split across two WebSocket messages is not rendered as two half-lines.
  const pendingRef = useRef('');

  const reset = useCallback(() => {
    pendingRef.current = '';
    setLines([]);
    setDropped(0);
  }, []);

  const cap = useCallback(next => {
    if (next.length <= MAX_LINES) {
      return next;
    }
    const excess = next.length - MAX_LINES;
    setDropped(d => d + excess);
    return next.slice(excess);
  }, []);

  // Streamed text (follow output) -- appended, with a carried partial line.
  const appendText = useCallback(
    text => {
      if (!text) {
        return;
      }
      const combined = pendingRef.current + text;
      const parts = combined.split('\n');
      pendingRef.current = parts.pop();
      if (parts.length === 0) {
        return;
      }
      setLines(prev => cap(prev.concat(parts)));
    },
    [cap]
  );

  // A full snapshot (GET /api/file's `content`) -- REPLACES the buffer, for
  // a fresh selection, rather than appending onto whatever was there before.
  const setSnapshot = useCallback(
    text => {
      pendingRef.current = '';
      const parts = (text || '').split('\n');
      // A file ending in a trailing newline (the common case) would
      // otherwise show one fake empty line at the end.
      if (parts.length && parts[parts.length - 1] === '') {
        parts.pop();
      }
      setDropped(0);
      setLines(cap(parts));
    },
    [cap]
  );

  return { lines, dropped, appendText, setSnapshot, reset };
}

// ------------------------------------------------------------- follow ws --

// One mounted instance owns exactly one WebSocket for its whole life,
// created and torn down in a single effect -- same shape as Terminal.jsx's
// TerminalSession, for the same reason: "Stop" (in the parent below) simply
// stops rendering this component, and its own cleanup is the teardown path,
// rather than a second hand-rolled close() call living somewhere else. An
// abandoned follow leaves `tail -F`/`journalctl -f` running against the
// user's production host, so this MUST run on every unmount, not just an
// explicit Stop click.
function LogFollowSocket({ target, buffer, onOpen, onClose }) {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const socket = new WebSocket(wsUrl(target));
    // Follow output is always raw bytes on this bridge too (logFollow.ts is
    // the read-only twin of terminal.ts's bridge, and inherits its
    // "server -> client: always raw bytes" wire shape) -- decoded here, not
    // JSON-parsed, same reasoning as Terminal.jsx.
    socket.binaryType = 'arraybuffer';
    const decoder = new TextDecoder();

    socket.addEventListener('open', () => {
      if (mountedRef.current) {
        onOpen();
      }
    });

    socket.addEventListener('message', event => {
      const text =
        typeof event.data === 'string' ? event.data : decoder.decode(event.data, { stream: true });
      buffer.appendText(text);
    });

    socket.addEventListener('close', event => {
      if (!mountedRef.current) {
        return;
      }
      onClose(event.code, event.reason);
    });

    // Same reasoning as Terminal.jsx: 'error' carries nothing usable of its
    // own (per spec, a plain Event) and is always followed by 'close', which
    // is the one event this component actually decides anything from. This
    // listener exists only so an unhandled 'error' doesn't log a console
    // warning.
    socket.addEventListener('error', () => {});

    return () => {
      // Safe at any readyState -- CONNECTING aborts, OPEN sends a close
      // frame (the "explicit Stop" case, which the server/close handler
      // above will still see as code 1000), CLOSING/CLOSED is a no-op.
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `buffer` is a
    // set of useCallback-stabilised functions from the parent's
    // useLineBuffer(), and onOpen/onClose are stable per follow attempt;
    // only `target` identity is meant to restart this effect.
  }, [target]);

  return null;
}

function followTone(status) {
  if (status === 'live') return 'ok';
  if (status === 'connecting') return 'warn';
  if (status === 'error') return 'bad';
  return ''; // idle / stopped -- a finished follow is not a failure
}

function followLabel(status) {
  if (status === 'live') return 'Following';
  if (status === 'connecting') return 'Connecting…';
  if (status === 'error') return 'Follow failed';
  if (status === 'stopped') return 'Follow stopped';
  return 'Not following';
}

// ------------------------------------------------------------------ rows --

function PickerRow({ target, active, onSelect, primary, secondary, tag }) {
  return (
    <li
      onClick={onSelect}
      style={{
        listStyle: 'none',
        cursor: 'pointer',
        padding: '6px 8px',
        borderRadius: 6,
        background: active ? 'var(--surface-2)' : 'transparent',
        marginBottom: 2,
      }}
    >
      <div
        className="mono"
        title={target}
        style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {primary}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 1 }}>
        {secondary}
        {tag && (
          <>
            {' · '}
            <Badge tone={tagTone(tag)}>{tag}</Badge>
          </>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- main ui --

export default function Logs() {
  const [discovery, setDiscovery] = useState(null); // { files, units } | null until first load resolves
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [discoveryError, setDiscoveryError] = useState(null);
  const [showSecondary, setShowSecondary] = useState(false);

  const [selected, setSelected] = useState(null); // { kind: 'file', path } | { kind: 'unit', unit } | null
  const [tailLoading, setTailLoading] = useState(false);
  const [tailError, setTailError] = useState(null);

  const [followTarget, setFollowTarget] = useState(null); // non-null only while a socket should exist
  const [followStatus, setFollowStatus] = useState('idle'); // idle | connecting | live | stopped | error
  const [followReason, setFollowReason] = useState('');

  const buffer = useLineBuffer();

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadDiscovery = useCallback(async () => {
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try {
      const res = await apiGet('/api/logs');
      if (!mountedRef.current) {
        return;
      }
      setDiscovery({ files: (res && res.files) || [], units: (res && res.units) || [] });
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setDiscoveryError(err.message);
    } finally {
      if (mountedRef.current) {
        setDiscoveryLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadDiscovery();
  }, [loadDiscovery]);

  // Selecting a source shows a snapshot; it never starts a live stream on
  // its own -- attaching `tail -F` to a production log the instant a row is
  // clicked would be a surprise, and every open follow holds an SSH channel
  // on the pooled connection this feature shares with SFTP and the Terminal
  // tab (see logFollow.ts's module comment). Follow is Step 2, always
  // explicit.
  function selectTarget(target) {
    setFollowTarget(null);
    setFollowStatus('idle');
    setFollowReason('');
    setTailError(null);
    buffer.reset();
    setSelected(target);
  }

  useEffect(() => {
    if (!selected) {
      return;
    }
    // journald has no one-shot "read N lines" route wired up (routes.ts only
    // exposes GET /api/file, which is keyed by a file path in the discovery
    // allowlist -- there is nothing equivalent for a unit). A unit can only
    // ever be observed by starting Follow; there is no snapshot to fetch.
    if (selected.kind === 'unit') {
      setTailLoading(false);
      setTailError(null);
      return;
    }
    let cancelled = false;
    setTailLoading(true);
    setTailError(null);
    apiGet(`/api/file?path=${encodeURIComponent(selected.path)}&lines=${TAIL_LINES}`)
      .then(res => {
        if (cancelled || !mountedRef.current) {
          return;
        }
        buffer.setSnapshot((res && res.content) || '');
      })
      .catch(err => {
        if (cancelled || !mountedRef.current) {
          return;
        }
        setTailError(err.message);
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) {
          return;
        }
        setTailLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `buffer`'s
    // functions are useCallback-stable; only `selected` should re-trigger.
  }, [selected]);

  function startFollow() {
    if (!selected) {
      return;
    }
    setFollowReason('');
    setFollowStatus('connecting');
    setFollowTarget(selected);
  }

  function stopFollow() {
    setFollowTarget(null);
    setFollowStatus('stopped');
  }

  const handleFollowClose = useCallback((code, reason) => {
    setFollowTarget(null);
    if (code === CLOSE_NORMAL) {
      setFollowStatus('stopped');
    } else {
      // Includes an abnormal close (1006, no reason at all) -- that is a
      // failure too, not a silent fall-through to "stopped".
      setFollowStatus('error');
      setFollowReason(reason || 'The connection was lost.');
    }
  }, []);

  const handleFollowOpen = useCallback(() => {
    setFollowStatus('live');
  }, []);

  const groups = useMemo(() => {
    const files = (discovery && discovery.files) || [];
    const primary = [];
    const secondary = [];
    files.forEach(file => {
      const tag = classify(file);
      (tag === 'primary' ? primary : secondary).push({ file, tag });
    });
    const byPath = (a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0);
    primary.sort(byPath);
    secondary.sort(byPath);
    return { primary, secondary, units: (discovery && discovery.units) || [] };
  }, [discovery]);

  const isEmpty =
    discovery !== null &&
    !discoveryLoading &&
    !discoveryError &&
    groups.primary.length === 0 &&
    groups.secondary.length === 0 &&
    groups.units.length === 0;

  const hasContent = buffer.lines.length > 0;

  return (
    <Card
      title="Logs"
      sub={
        discovery
          ? `${groups.primary.length + groups.secondary.length} file${
              groups.primary.length + groups.secondary.length === 1 ? '' : 's'
            } · ${groups.units.length} journald unit${groups.units.length === 1 ? '' : 's'}`
          : undefined
      }
      actions={
        <button className="btn sm" onClick={loadDiscovery} disabled={discoveryLoading}>
          {discoveryLoading ? 'Loading…' : 'Reload'}
        </button>
      }
    >
      {discoveryError && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
            {discoveryError}
          </span>
          <button className="btn sm" onClick={loadDiscovery}>
            Retry
          </button>
        </div>
      )}

      {discoveryLoading && discovery === null && !discoveryError && (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
          Discovering logs…
        </div>
      )}

      {isEmpty && (
        <Empty title="No logs discovered">
          The host reported no files under /var/log and no journald units.
        </Empty>
      )}

      {discovery !== null && !isEmpty && (
        <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
          <div style={{ width: 280, flex: '0 0 280px' }}>
            {groups.primary.length > 0 && (
              <>
                <div className="section-title">Files</div>
                <ul style={{ margin: 0, padding: 0 }}>
                  {groups.primary.map(({ file }) => (
                    <PickerRow
                      key={file.path}
                      target={file.path}
                      active={selected && selected.kind === 'file' && selected.path === file.path}
                      onSelect={() => selectTarget({ kind: 'file', path: file.path })}
                      primary={basename(file.path)}
                      secondary={fmtBytes(file.bytes)}
                    />
                  ))}
                </ul>
              </>
            )}

            {groups.secondary.length > 0 && (
              <>
                <button
                  className="btn sm"
                  style={{ marginTop: groups.primary.length ? 8 : 0, marginBottom: 6 }}
                  onClick={() => setShowSecondary(s => !s)}
                >
                  {showSecondary ? 'Hide' : 'Show'} {groups.secondary.length} rotated/archived/binary
                </button>
                {showSecondary && (
                  <ul style={{ margin: 0, padding: 0 }}>
                    {groups.secondary.map(({ file, tag }) => (
                      <PickerRow
                        key={file.path}
                        target={file.path}
                        active={selected && selected.kind === 'file' && selected.path === file.path}
                        onSelect={() => selectTarget({ kind: 'file', path: file.path })}
                        primary={basename(file.path)}
                        secondary={fmtBytes(file.bytes)}
                        tag={tag}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}

            {groups.units.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: 14 }}>
                  Units
                </div>
                <ul style={{ margin: 0, padding: 0 }}>
                  {groups.units.map(unit => (
                    <PickerRow
                      key={unit}
                      target={unit}
                      active={selected && selected.kind === 'unit' && selected.unit === unit}
                      onSelect={() => selectTarget({ kind: 'unit', unit })}
                      primary={unit}
                      secondary="journald unit"
                    />
                  ))}
                </ul>
              </>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {!selected && (
              <Empty title="Select a file or unit">Choose a source from the list to view its output.</Empty>
            )}

            {selected && (
              <>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>
                    {selected.kind === 'file' ? selected.path : `unit: ${selected.unit}`}
                  </div>
                  <div className="row">
                    <Badge tone={followTone(followStatus)}>{followLabel(followStatus)}</Badge>
                    {followTarget ? (
                      <button className="btn sm danger" onClick={stopFollow}>
                        Stop
                      </button>
                    ) : (
                      <button className="btn sm primary" onClick={startFollow}>
                        Follow
                      </button>
                    )}
                  </div>
                </div>

                {tailError && (
                  <div className="row" style={{ marginBottom: 8 }}>
                    <span className="mono" style={{ color: 'var(--critical)', fontSize: 12.5 }}>
                      {tailError}
                    </span>
                  </div>
                )}

                {followStatus === 'error' && followReason && (
                  <div className="mono" style={{ color: 'var(--critical)', fontSize: 12.5, marginBottom: 8 }}>
                    {followReason}
                  </div>
                )}

                {buffer.dropped > 0 && (
                  <div className="muted mono" style={{ fontSize: 11.5, marginBottom: 8 }}>
                    {buffer.dropped.toLocaleString()} older line{buffer.dropped === 1 ? '' : 's'} dropped —
                    showing the most recent {MAX_LINES.toLocaleString()}.
                  </div>
                )}

                {selected.kind === 'unit' && !hasContent && !tailError && (
                  <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
                    journald units have no one-shot snapshot in this UI — start Follow to see live output.
                  </div>
                )}

                {tailLoading && <div className="muted">Loading…</div>}

                {!tailLoading && (
                  <pre className="output" style={{ margin: 0 }}>
                    {hasContent ? buffer.lines.join('\n') : 'No output yet.'}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {followTarget && (
        <LogFollowSocket
          target={followTarget}
          buffer={buffer}
          onOpen={handleFollowOpen}
          onClose={handleFollowClose}
        />
      )}
    </Card>
  );
}
