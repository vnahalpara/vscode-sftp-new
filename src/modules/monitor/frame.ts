export const TICK = '==TICK';
export const END = '==END';

// A snapshot is a few tens of kB even on a host with thousands of processes.
// Anything past this means the stream desynchronised (a shell error, a binary
// blob), so the buffer is dropped rather than grown until the window dies.
export const MAX_BLOCK_BYTES = 4 * 1024 * 1024;

export class Framer {
  private _buf = '';

  buffered(): number {
    return this._buf.length;
  }

  // Feed a chunk of stdout; returns every block the chunk completed, in order.
  push(chunk: string): string[] {
    this._buf += chunk;
    const blocks: string[] = [];

    for (;;) {
      const start = this._buf.indexOf(TICK);
      if (start === -1) {
        // Nothing useful buffered. Keep a tail long enough to hold a marker
        // that was split across chunks.
        if (this._buf.length > TICK.length) {
          this._buf = this._buf.slice(-TICK.length);
        }
        break;
      }
      if (start > 0) {
        // Drop noise emitted before the loop started (login banners, warnings).
        this._buf = this._buf.slice(start);
      }
      const end = this._buf.indexOf(END);
      if (end === -1) {
        if (this._buf.length > MAX_BLOCK_BYTES) {
          this._buf = '';
        }
        break;
      }
      blocks.push(this._buf.slice(0, end));
      this._buf = this._buf.slice(end + END.length);
    }

    return blocks;
  }
}

export interface Block {
  at: number;
  sections: { [name: string]: string };
}

// Turn "==TICK 1700000000123\n--stat\n...\n--mem\n..." into a timestamp plus a
// map of section name to body. Also used for the one-shot batches, whose output
// carries the same section markers without a tick line.
export function splitSections(block: string): Block {
  let at = 0;
  const sections: { [name: string]: string } = {};
  let current = '';
  let buf: string[] = [];
  let done = false;

  const flush = () => {
    if (current) {
      sections[current] = buf.join('\n');
    }
    buf = [];
  };

  block.split('\n').forEach(line => {
    if (done) {
      return;
    }
    if (line.indexOf(TICK) === 0) {
      const n = Number(line.slice(TICK.length).trim());
      at = isFinite(n) ? n : 0;
      return;
    }
    if (line.indexOf(END) === 0) {
      flush();
      current = '';
      done = true;
      return;
    }
    // A section marker is "--name" with no spaces; /proc content never starts
    // that way, so this cannot swallow a data line.
    if (line.indexOf('--') === 0 && line.indexOf(' ') === -1) {
      flush();
      current = line.slice(2).trim();
      return;
    }
    buf.push(line);
  });
  flush();

  return { at, sections };
}
