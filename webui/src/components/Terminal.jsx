import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getToken } from '../api.js';
import { Badge, Card } from './ui.jsx';

// The exact close code terminal.ts's bridge uses for "the shell exited on
// its own" (the user typed `exit`, or the remote host ended the session) --
// see that file's comment on CLOSE_NORMAL/CLOSE_INTERNAL_ERROR. Any other
// code (1011 for a bridge/shell failure, or an abnormal browser-side close
// like 1006) must read as a failure; only this one must not.
const CLOSE_NORMAL = 1000;

function wsUrl() {
  // This server only ever speaks plain http on loopback (see wsServer.ts's
  // checkUpgrade comment), so ws: is always correct here -- there is no
  // https: case to branch on.
  return `ws://${location.host}/ws/terminal?t=${encodeURIComponent(getToken())}`;
}

function statusTone(status) {
  if (status === 'open') return 'ok';
  if (status === 'connecting') return 'warn';
  if (status === 'closed-error') return 'bad';
  return ''; // closed-clean: a finished session is not a failure
}

function statusLabel(status) {
  if (status === 'open') return 'Connected';
  if (status === 'connecting') return 'Connecting…';
  if (status === 'closed-error') return 'Disconnected';
  return 'Session ended';
}

// One mounted instance owns exactly one WebSocket + one xterm instance for
// its whole life. "Reconnect" (in the parent below) remounts a fresh
// instance via a `key` bump instead of rewiring a socket in place -- that
// gets this component's own cleanup (this effect's return) as the teardown
// path for free, rather than a second hand-rolled one.
function TerminalSession({ profile, onReconnect }) {
  const hostRef = useRef(null);
  const [status, setStatus] = useState('connecting'); // connecting | open | closed-clean | closed-error
  const [reason, setReason] = useState('');

  // Guards every setState below that can fire after this instance is gone.
  // Socket and ResizeObserver callbacks are not awaits, but they are exactly
  // the same "work finishes after the component is gone" hazard
  // Services.jsx's mountedRef guards against — see that file's comment.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const term = new XTerm({
      convertEol: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0f0f0e', foreground: '#e9e9e6', cursor: '#e9e9e6' },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(hostRef.current);
    fitAddon.fit();

    const socket = new WebSocket(wsUrl());
    // Output from the bridge is always raw bytes (terminal.ts: "server ->
    // client: always terminal output, always raw bytes"), so this only ever
    // needs to become a Uint8Array for term.write() — never JSON-decoded.
    socket.binaryType = 'arraybuffer';

    const encoder = new TextEncoder();
    // Keystrokes typed in the instant between mount and the socket finishing
    // its handshake are not dropped; they are sent the moment 'open' fires.
    const inputQueue = [];
    // The last {cols, rows} actually sent, so a ResizeObserver firing on
    // every layout pass (it fires more often than the terminal's own cell
    // grid actually changes) does not spam a resize frame the bridge would
    // just re-apply as a no-op.
    let lastSize = null;

    function sendResize() {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const { cols, rows } = term;
      if (lastSize && lastSize.cols === cols && lastSize.rows === rows) {
        return;
      }
      lastSize = { cols, rows };
      // The ONE control message this bridge understands, and it MUST travel
      // as a TEXT frame — see the binary-input comment on term.onData below
      // for why control and input must never share a frame type.
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(hostRef.current);

    term.onData(data => {
      // Every keystroke and paste goes out as a BINARY frame, always. This
      // is not a style choice: terminal.ts's bridge disambiguates
      // client->server text frames as control-or-not by trying to parse
      // them as JSON, so a TEXT frame carrying a pasted
      // `{"type":"resize","cols":80,"rows":24}` would silently resize the
      // PTY instead of reaching the shell. Binary input sidesteps the bridge's
      // control parser entirely — see terminal.ts's wire-protocol comment.
      const bytes = encoder.encode(data);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(bytes);
      } else {
        inputQueue.push(bytes);
      }
    });

    socket.addEventListener('open', () => {
      if (!mountedRef.current) {
        return;
      }
      setStatus('open');
      inputQueue.splice(0).forEach(bytes => socket.send(bytes));
      sendResize();
    });

    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        term.write(event.data);
      } else {
        term.write(new Uint8Array(event.data));
      }
    });

    socket.addEventListener('close', event => {
      resizeObserver.disconnect();
      if (!mountedRef.current) {
        return;
      }
      // 1000 is a clean exit (the shell exited, or the user closed the
      // session normally) — it must never render like an error. Anything
      // else, including an abnormal browser-side close (1006) with no
      // reason at all, is a failure and is shown as one.
      if (event.code === CLOSE_NORMAL) {
        setStatus('closed-clean');
      } else {
        setStatus('closed-error');
        setReason(event.reason || 'The connection was lost.');
      }
    });

    // No separate state transition here: the WebSocket spec fires 'error'
    // immediately before 'close' on every failure, carrying no usable
    // information of its own (per spec, Event, not ErrorEvent). 'close' is
    // the one event with the code/reason this UI actually decides on: this
    // listener exists only so an unhandled 'error' event does not log a
    // console warning.
    socket.addEventListener('error', () => {});

    return () => {
      resizeObserver.disconnect();
      // Safe to call regardless of readyState — CONNECTING simply aborts,
      // OPEN sends a close frame, and a socket already CLOSING/CLOSED is a
      // no-op.
      socket.close();
      fitAddon.dispose();
      term.dispose();
    };
  }, []);

  return (
    <Card
      title="Terminal"
      sub={profile ? `${profile.username}@${profile.host} · interactive SSH shell` : undefined}
      actions={
        <div className="row">
          <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
          {(status === 'closed-clean' || status === 'closed-error') && (
            <button className="btn sm" onClick={onReconnect}>
              Reconnect
            </button>
          )}
        </div>
      }
    >
      <div ref={hostRef} className="term-host" />
      {status === 'closed-error' && (
        <div className="mono" style={{ marginTop: 10, fontSize: 12.5, color: 'var(--critical)' }}>
          {reason}
        </div>
      )}
    </Card>
  );
}

// The ordinary, non-privileged SSH user this shell runs as — deliberately
// `profile.username`, never `profile.privilegedAs`. terminal.ts's deps wire
// openShell() to session.transport, not session.privilegedTransport (see its
// TerminalDeps comment): this tab never has a root shell, so nothing here
// should ever suggest it does.
export default function Terminal({ profile }) {
  // Bumping this key fully unmounts and remounts TerminalSession, which is
  // what actually gets a fresh socket and a fresh xterm instance — see that
  // component's own comment on why a remount, not an in-place rewire.
  const [attempt, setAttempt] = useState(0);
  return <TerminalSession key={attempt} profile={profile} onReconnect={() => setAttempt(a => a + 1)} />;
}
