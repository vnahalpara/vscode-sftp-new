const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!n || n < 0) {
    return '0 B';
  }
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  if (i === 0) {
    return `${Math.round(n)} B`;
  }
  const value = n / Math.pow(1024, i);
  const trimmed = parseFloat(value.toFixed(2)); // drops trailing zeros: 1.50 -> 1.5, 1.00 -> 1
  return `${trimmed} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export class SpeedWindow {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(private windowMs: number = 1000) {}

  add(t: number, cumulativeBytes: number): void {
    this.samples.push({ t, bytes: cumulativeBytes });
    const cutoff = t - this.windowMs;
    // keep one sample just outside the window as the baseline
    while (this.samples.length > 2 && this.samples[1].t <= cutoff) {
      this.samples.shift();
    }
  }

  speed(): number {
    if (this.samples.length < 2) {
      return 0;
    }
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) {
      return 0;
    }
    return (last.bytes - first.bytes) / dt;
  }

  reset(): void {
    this.samples = [];
  }
}
