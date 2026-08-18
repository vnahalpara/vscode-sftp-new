// Pure chart-series derivation. No browser globals — see format.ts for why.
//
// The server keeps only load history (LoadPoint[]). CPU, memory and network
// series are accumulated here from the tick stream, which is why pushPoint has
// to be defensive about ordering and capacity.

export interface SeriesPoint {
  at: number;
  [key: string]: number | null;
}

// In-memory history only, so the ranges stop at the server's historyMinutes
// default of 60. Offering 24h or 7d would promise data that cannot exist.
export const RANGES = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '60 min', minutes: 60 },
];

export function pushPoint(
  buffer: SeriesPoint[],
  point: SeriesPoint,
  capacity: number
): SeriesPoint[] {
  const last = buffer.length ? buffer[buffer.length - 1] : null;
  // A server clock that stepped backwards across a reconnect would otherwise
  // draw the axis inside out.
  if (last && point.at <= last.at) {
    return buffer;
  }
  const next = buffer.concat([point]);
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

export function trimToWindow(
  points: SeriesPoint[],
  minutes: number,
  now: number
): SeriesPoint[] {
  const cutoff = now - minutes * 60 * 1000;
  return points.filter(p => p.at >= cutoff);
}

export function cpuPoint(snapshot: any): SeriesPoint | null {
  if (!snapshot || !snapshot.cpu) {
    return null;
  }
  const point: SeriesPoint = { at: snapshot.at, total: snapshot.cpu.total };
  (snapshot.cpu.cores || []).forEach((v: number, i: number) => {
    point[`core${i}`] = v;
  });
  return point;
}

export function memPoint(snapshot: any): SeriesPoint | null {
  if (!snapshot || !snapshot.mem) {
    return null;
  }
  return {
    at: snapshot.at,
    usedPct: snapshot.mem.usedPct,
    cachedPct: snapshot.mem.cachedPct,
  };
}

// Loopback and container/bridge plumbing are not throughput anyone is trying
// to see, and including them swamps the scale on a busy host — a
// Docker-equipped host reports docker0 plus one veth* per container.
// Exported so Overview.jsx's Network interfaces footer can apply the exact
// same rule instead of re-deriving it — before this the chart filtered but
// the footer table did not, so the same docker0/veth* noise the chart
// already hid was still listed below it.
const VIRTUAL_PREFIXES = ['ifb', 'veth', 'docker', 'br-', 'virbr', 'tun', 'tap'];
export function isPhysical(name: string): boolean {
  return name !== 'lo' && !VIRTUAL_PREFIXES.some(prefix => name.indexOf(prefix) === 0);
}

export function netPoint(snapshot: any): SeriesPoint | null {
  if (!snapshot || !snapshot.net) {
    return null;
  }
  const ifaces = snapshot.net.filter((n: any) => isPhysical(n.name));
  let rx: number | null = null;
  let tx: number | null = null;
  ifaces.forEach((n: any) => {
    if (typeof n.rxBps === 'number') {
      rx = (rx || 0) + n.rxBps;
    }
    if (typeof n.txBps === 'number') {
      tx = (tx || 0) + n.txBps;
    }
  });
  return { at: snapshot.at, rx, tx };
}

export function loadSeries(history: any[]): SeriesPoint[] {
  if (!history || !history.length) {
    return [];
  }
  return history.map(p => ({ at: p.at, one: p.one, five: p.five, fifteen: p.fifteen }));
}
