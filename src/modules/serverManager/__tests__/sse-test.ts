import { SseChannel, formatEvent, SseSink } from '../sse';

class FakeSink implements SseSink {
  chunks: string[] = [];
  ended = false;
  throwOnWrite = false;

  write(chunk: string) {
    if (this.throwOnWrite) {
      throw new Error('EPIPE');
    }
    this.chunks.push(chunk);
  }
  end() {
    this.ended = true;
  }
}

describe('formatEvent', () => {
  it('emits a named event with a JSON payload and a blank-line terminator', () => {
    expect(formatEvent('tick', { cpu: 12 })).toBe('event: tick\ndata: {"cpu":12}\n\n');
  });

  it('keeps the payload on one line even when it contains newlines', () => {
    // JSON.stringify escapes them, which is what keeps the frame parseable.
    const frame = formatEvent('error', { message: 'line one\nline two' });
    expect(frame.split('\n').length).toBe(4);
    expect(frame).toContain('line one\\nline two');
  });
});

describe('SseChannel', () => {
  it('fans one event out to every subscriber', () => {
    const channel = new SseChannel();
    const a = new FakeSink();
    const b = new FakeSink();
    channel.add(a);
    channel.add(b);

    channel.send('tick', { n: 1 });

    expect(a.chunks).toEqual(['event: tick\ndata: {"n":1}\n\n']);
    expect(b.chunks).toEqual(['event: tick\ndata: {"n":1}\n\n']);
  });

  it('counts live subscribers', () => {
    const channel = new SseChannel();
    expect(channel.count()).toBe(0);
    const off = channel.add(new FakeSink());
    expect(channel.count()).toBe(1);
    off();
    expect(channel.count()).toBe(0);
  });

  it('stops writing to a subscriber after it unsubscribes', () => {
    const channel = new SseChannel();
    const sink = new FakeSink();
    const off = channel.add(sink);
    off();

    channel.send('tick', { n: 1 });

    expect(sink.chunks).toEqual([]);
  });

  it('drops a sink that throws instead of failing the whole broadcast', () => {
    const channel = new SseChannel();
    const dead = new FakeSink();
    const live = new FakeSink();
    dead.throwOnWrite = true;
    channel.add(dead);
    channel.add(live);

    channel.send('tick', { n: 1 });

    expect(live.chunks.length).toBe(1);
    expect(channel.count()).toBe(1);
  });

  it('sends a comment heartbeat that carries no event', () => {
    const channel = new SseChannel();
    const sink = new FakeSink();
    channel.add(sink);

    channel.ping();

    expect(sink.chunks).toEqual([': ping\n\n']);
  });

  it('ends and forgets every subscriber on closeAll', () => {
    const channel = new SseChannel();
    const sink = new FakeSink();
    channel.add(sink);

    channel.closeAll();

    expect(sink.ended).toBe(true);
    expect(channel.count()).toBe(0);
  });
});
