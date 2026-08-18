// Pure parsing for the `@@files` / `@@units`-sectioned output of
// `logDiscoveryCommand` (`ops/command.ts`). This file does no I/O and runs
// no shell command itself -- `command.ts` builds the remote command and
// `splitAt` frames its two sections; the caller (Task 4) is responsible for
// running the command and handing the resulting text to `parseLogDiscovery`
// below. Tail/follow output (Task 5) is streamed, not framed with `@@`
// markers, so it has no parser here.

import { splitAt } from './command';

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
    if (!path) {
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
