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
  // Every builder wraps its command in `sudo -n ...` unconditionally, even
  // when the lane is already authenticated as root (see registry.ts's
  // privilegedAs). "Add a sudoers rule for root" is nonsensical advice
  // there -- root failing to sudo to itself is almost never a missing
  // sudoers entry; it is usually sudo not being installed/on PATH, or a
  // requiretty/secure_path restriction, since this runs over a non-tty exec
  // channel.
  if (user === 'root') {
    return (
      `${user}@${host} is already authenticated as root, so a sudoers rule will not help. ` +
      `This usually means sudo is missing or not on PATH, or /etc/sudoers on ${host} has a ` +
      `requiretty/secure_path restriction that blocks a non-interactive session.`
    );
  }
  // Name what sudo ACTUALLY execs, not what the command is conceptually
  // about. Of the privileged builders in ops/command.ts only
  // serviceActionCommand execs a web-server-agnostic binary directly
  // (`sudo -n systemctl ...`); configFilesCommand, testConfigCommand and
  // certInfoCommand all exec `sudo -n sh -c <script>`, and readFileCommand
  // execs `sudo -n sed`. nginx, apache2ctl, httpd and openssl only ever run
  // INSIDE that sh script, so sudoers matches /bin/sh -- never them. The
  // previous version of this hint told users to grant
  // `NOPASSWD: /bin/systemctl, /usr/sbin/nginx, /usr/sbin/apache2ctl`, which
  // got Services working and left every part of the Web server tab failing
  // with the same hint naming the binaries they had just granted: there was
  // no path from the advice to a working tab.
  //
  // The split that matters is by COMMAND, not by tab. Both tabs' action
  // buttons run systemctl, so a user who only wants the Web server tab's
  // restart button needs /bin/systemctl and nothing more -- telling them
  // "the Web server tab needs /bin/sh" would talk them into an unrestricted
  // root grant to get a button that /bin/systemctl alone would have fixed.
  // Only the reads (vhost config, Test config, certificates, View) go
  // through a shell. And the honest advice for those is not "grant
  // /bin/sh": NOPASSWD on a shell is unrestricted root by any other name.
  return (
    `${user}@${host} cannot run this command with sudo without a password. ` +
    `Service actions -- start/stop/restart/reload, on BOTH tabs -- need one sudoers rule on ` +
    `${host}: ${user} ALL=(ALL) NOPASSWD: /bin/systemctl. ` +
    `Only the Web server tab's config reads, Test config, certificate panel and View run sudo ` +
    `on /bin/sh and /bin/sed instead (nginx, apache2ctl, httpd and openssl all run INSIDE a ` +
    `"sudo -n sh -c" script, so a rule naming those binaries never matches). NOPASSWD on ` +
    `/bin/sh grants unrestricted root, so for those reads specifically, setting root_user and ` +
    `root_password on the connection profile is usually the better trade -- see the README for ` +
    `what that costs.`
  );
}
