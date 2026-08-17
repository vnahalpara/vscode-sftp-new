export interface ActivityEntry {
  at: number;
  label: string;
  command: string;
  code: number;
  ms: number;
  error: string | null;
}

export class ActivityLog {
  onEntry: (entry: ActivityEntry) => void = () => undefined;

  private _entries: ActivityEntry[] = [];
  private _capacity: number;

  constructor(capacity: number = 200) {
    this._capacity = Math.max(1, capacity);
  }

  push(entry: ActivityEntry): void {
    this._entries.push(entry);
    if (this._entries.length > this._capacity) {
      this._entries = this._entries.slice(this._entries.length - this._capacity);
    }
    this.onEntry(entry);
  }

  // A copy: the ring is ours, and a route handler serialising it must not be
  // able to grow it.
  entries(): ActivityEntry[] {
    return this._entries.slice();
  }
}

const SUDO_PATTERNS = [
  /a password is required/i,
  /no tty present and no askpass/i,
  /is not in the sudoers file/i,
];

// An empty panel is the worst possible answer to a sudo failure: it looks like
// the host has no services. Name the host, the user, and the fix instead.
export function sudoHint(stderr: string, user: string, host: string): string | null {
  if (!stderr) {
    return null;
  }
  const matched = SUDO_PATTERNS.some(pattern => pattern.test(stderr));
  if (!matched) {
    return null;
  }
  return (
    `${user}@${host} cannot run this command with sudo without a password. ` +
    `Add a sudoers rule on ${host}, for example: ` +
    `${user} ALL=(ALL) NOPASSWD: /bin/systemctl, /usr/sbin/nginx, /usr/sbin/apache2ctl`
  );
}
