// Pure parsing for the `@@files` / `@@units`-sectioned output of
// `logDiscoveryCommand` (`ops/command.ts`). This file does no I/O and runs
// no shell command itself -- `command.ts` builds the remote command and
// `splitAt` frames its two sections; the caller (Task 4) is responsible for
// running the command and handing the resulting text to `parseLogDiscovery`
// below. Tail/follow output (Task 5) is streamed, not framed with `@@`
// markers, so it has no parser here.

import { splitAt, isLogFilePath } from './command';

export interface LogFile {
  path: string;
  bytes: number | null;
}

// `bytes` is a contract shared across this whole feature: `null` means "not
// computable" and is rendered as an em dash; it must never collapse to `0`,
// which means "this file genuinely has zero bytes". A size field that is
// empty (stat failed) or contains anything other than digits is therefore
// `null`, not `0` and not a best-effort parse of whatever digits happen to
// be in it.
function parseBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  // A size too large to represent exactly as a JS number is not reliably
  // computable either -- reporting a rounded/approximate byte count would
  // be worse than reporting "unknown".
  return Number.isSafeInteger(n) ? n : null;
}

// Each line of the `@@files` section is `<size>\t<path>`, written by
// `logDiscoveryCommand`'s `printf '%s\t%s\n' "$sz" "$f"`. Split on the
// FIRST tab only (not on whitespace generally): a log file's path can
// itself contain spaces, and taking everything after the first tab as the
// path -- rather than word-splitting the whole line -- keeps such a path
// intact.
//
// `isLogFilePath` is applied to every candidate path before it is kept.
// This is not incidental hardening -- see the "Newline-in-filename hazard"
// comment on `logDiscoveryCommand` in `ops/command.ts`: a directory name
// under /var/log can legally embed both a newline and a tab, which forges
// what looks like an entire second, well-formed `<size>\t<path>` line once
// this function's own `text.split('\n')` re-splits the stream -- a forged
// line that, by shape alone, is indistinguishable from a real discovery. A
// path is only ever kept here if it is one `isLogFilePath` actually
// vouches for as rooted at /var/log; anything else is dropped silently,
// the same way a malformed line with no tab is dropped, not surfaced as a
// (fake) result.
function parseFilesSection(text: string): LogFile[] {
  const files: LogFile[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) {
      // Blank line (the section's own trailing framing newline, or a
      // malformed entry) -- skip rather than fabricate a pathless row.
      continue;
    }
    const sizeField = line.slice(0, tabIndex);
    const path = line.slice(tabIndex + 1);
    if (!path || !isLogFilePath(path)) {
      continue;
    }
    files.push({ path, bytes: parseBytes(sizeField) });
  }
  return files;
}

function parseUnitsSection(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/** Parse the `@@files`/`@@units`-sectioned output of `logDiscoveryCommand`. */
export function parseLogDiscovery(text: string): { files: LogFile[]; units: string[] } {
  const sections = splitAt(text);
  return {
    files: parseFilesSection(sections.files || ''),
    units: parseUnitsSection(sections.units || ''),
  };
}
