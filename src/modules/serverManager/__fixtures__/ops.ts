// Fixtures for the systemd output parsers in `ops/services.ts`.
//
// These are captured (or hand-built to match) the raw text that would sit
// under the `units` / `files` keys after `splitAt(servicesCommand())`'s
// output is split -- i.e. exactly what `systemctl list-units --type=service
// --all --no-pager --plain --no-legend` and `systemctl list-unit-files
// --type=service --no-pager --plain --no-legend` print, one section each.
// `--plain --no-legend` means: no header row, no ANSI colour, whitespace-
// separated columns -- except that real-world systemd still prepends a `●`
// bullet to a FAILED unit's line on some versions even with those flags,
// which is exactly the kind of surprise a parser has to survive.

// `systemctl list-units --type=service --all --no-pager --plain --no-legend`
export const UNITS_TEXT = [
  // Ordinary, healthy unit -- the baseline case.
  'nginx.service                loaded    active   running A high performance web server',
  // A `●` bullet prefix: systemd emits this for a FAILED unit on some
  // versions even under --plain --no-legend. Must not be swallowed into the
  // unit-name field and must not be dropped from the output -- a failed
  // unit is exactly what an operator opens this tab to find.
  '● sshd.service               loaded    failed   failed  OpenSSH server daemon',
  // A `not-found` load state: the unit file has vanished (e.g. an old
  // transient/generated unit) but systemd still reports a line for it.
  'bogus.service                not-found inactive dead    -',
  // A templated unit -- the `@` instance syntax must survive untouched.
  'getty@tty1.service           loaded    active   running Getty on tty1',
  // A non-`.service` unit that happens to sort in alongside the services;
  // must be skipped entirely rather than misparsed as a service.
  'cron.timer                   loaded    active   waiting Run cron background tasks',
  // Multiple consecutive spaces inside the description text itself (not
  // just between columns) -- collapsing whitespace during parsing must not
  // be mistaken for corruption.
  'cron.service                 loaded    active   running Regular   background program',
  // Fewer than four whitespace-separated fields: malformed and must be
  // skipped outright, not turned into a row of `undefined`s.
  'brokenline.service loaded active',
].join('\n');

// `systemctl list-unit-files --type=service --no-pager --plain --no-legend`
// Deliberately omits `cron.service` so `mergeServices` has a unit present in
// `list-units` but absent from `list-unit-files`, pinning `enabled ===
// 'unknown'` for that case. Also omits `bogus.service` (a not-found unit
// realistically has no unit file to report on) and `cron.timer` (filtered
// out before merge and not a `.service` unit to begin with).
export const UNIT_FILES_TEXT = [
  'nginx.service                          enabled',
  'sshd.service                           disabled',
  'getty@tty1.service                     enabled',
  // A malformed line with only one field -- must be skipped, not crash.
  'garbageline',
].join('\n');

// A completely empty listing, e.g. `systemctl` produced no output at all
// (permission denied, no services matched, etc).
export const EMPTY_UNITS_TEXT = '';
export const EMPTY_UNIT_FILES_TEXT = '';
