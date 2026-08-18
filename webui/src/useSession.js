import { useEffect, useRef, useState, useCallback } from 'react';
import { apiGet, apiPost, openStream } from './api';
import { pushPoint, cpuPoint, memPoint, netPoint, loadSeries } from './series';

// 60 minutes at the 2s default cadence, matching the server's historyMinutes.
// Points are cheap; the cap only exists so a very long session cannot grow
// without bound.
const CAPACITY = 1800;

export function useSession() {
  const [state, setState] = useState({
    status: 'connecting',
    error: null,
    profile: null,
    facts: null,
    interval: 2000,
    lastSeen: null,
  });
  const [snapshot, setSnapshot] = useState(null);
  const [slow, setSlow] = useState(null);
  const [activity, setActivity] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [series, setSeries] = useState({ cpu: [], mem: [], net: [], load: [] });
  const [streamDown, setStreamDown] = useState(false);
  // EventSource auto-retries on a transient drop (readyState goes back to
  // CONNECTING) but gives up and sits in CLOSED after an error it treats as
  // unrecoverable — e.g. a 401 once the session is gone. The banner needs to
  // say which of those happened instead of always claiming a retry that may
  // never come.
  const [streamClosed, setStreamClosed] = useState(false);
  const buffers = useRef({ cpu: [], mem: [], net: [] });

  useEffect(() => {
    let closed = false;
    apiGet('/api/session')
      .then(s => {
        if (!closed) {
          setState(s);
        }
      })
      .catch(err => {
        if (!closed) {
          setState(s => ({ ...s, status: 'offline', error: err.message }));
        }
      });

    const close = openStream({
      // Merge, don't replace: `capabilities` is only ever sent by the initial
      // /api/session fetch above — session.state() (the source of every SSE
      // `state` frame) does not carry it. The server emits a `state` frame on
      // every transition (idle -> connecting -> online), all landing after
      // that fetch, so a wholesale replace here would silently drop
      // `capabilities` back to `undefined` on the very first frame.
      state: next => setState(s => ({ ...s, ...next })),
      tick: ({ snapshot: snap, history }) => {
        setStreamDown(false);
        setStreamClosed(false);
        setSnapshot(snap);
        const b = buffers.current;
        const cpu = cpuPoint(snap);
        const mem = memPoint(snap);
        const net = netPoint(snap);
        if (cpu) {
          b.cpu = pushPoint(b.cpu, cpu, CAPACITY);
        }
        if (mem) {
          b.mem = pushPoint(b.mem, mem, CAPACITY);
        }
        if (net) {
          b.net = pushPoint(b.net, net, CAPACITY);
        }
        setSeries({ cpu: b.cpu, mem: b.mem, net: b.net, load: loadSeries(history) });
      },
      slow: next => setSlow(next),
      // EventSource reconnects on its own for a transient drop; this only
      // drives the banner. readyState tells us which case we are in: CLOSED
      // (2) means the browser gave up (e.g. a 401 once the session no longer
      // exists) and nothing will retry.
      onError: e => {
        setStreamDown(true);
        setStreamClosed(Boolean(e && e.target && e.target.readyState === EventSource.CLOSED));
      },
    });

    return () => {
      closed = true;
      close();
    };
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await apiPost('/api/host/refresh');
      const entries = await apiGet('/api/activity');
      setActivity(entries.entries || []);
    } catch (err) {
      setState(s => ({ ...s, error: err.message }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { ...state, snapshot, slow, series, activity, refresh, refreshing, streamDown, streamClosed };
}
