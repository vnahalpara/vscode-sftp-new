export interface SseSink {
  write(chunk: string): void;
  end(): void;
}

// JSON.stringify escapes newlines, so the payload is always a single data line
// and the frame stays parseable by EventSource without any splitting.
export function formatEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseChannel {
  private _sinks: SseSink[] = [];

  add(sink: SseSink): () => void {
    this._sinks.push(sink);
    return () => this._drop(sink);
  }

  count(): number {
    return this._sinks.length;
  }

  send(event: string, data: any): void {
    this._broadcast(formatEvent(event, data));
  }

  // A comment frame. Proxies and some browsers drop an idle event stream, and a
  // heartbeat is cheaper than reconnecting.
  ping(): void {
    this._broadcast(': ping\n\n');
  }

  closeAll(): void {
    const sinks = this._sinks;
    this._sinks = [];
    sinks.forEach(sink => {
      try {
        sink.end();
      } catch (error) {
        // A socket that is already gone is exactly what we wanted.
      }
    });
  }

  private _broadcast(frame: string): void {
    // Iterate a copy: a throwing sink is dropped mid-loop.
    this._sinks.slice().forEach(sink => {
      try {
        sink.write(frame);
      } catch (error) {
        this._drop(sink);
      }
    });
  }

  private _drop(sink: SseSink): void {
    const index = this._sinks.indexOf(sink);
    if (index >= 0) {
      this._sinks.splice(index, 1);
    }
  }
}
