import { EventEmitter } from 'events';
import { channelFromStream, readFacts } from '../transport';
import { OS_RELEASE, CPUINFO } from '../__fixtures__/proc';

class FakeStream extends EventEmitter {
  written: string[] = [];
  ended = false;
  closed = false;
  write(s: string) {
    this.written.push(s);
    return true;
  }
  end() {
    this.ended = true;
  }
  close() {
    this.closed = true;
  }
}

describe('channelFromStream', () => {
  it('forwards decoded data chunks', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    const chunks: string[] = [];
    ch.onData(c => chunks.push(c));
    s.emit('data', Buffer.from('hello'));
    expect(chunks).toEqual(['hello']);
  });

  it('forwards close', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    let closed = false;
    ch.onClose(() => {
      closed = true;
    });
    s.emit('close');
    expect(closed).toBe(true);
  });

  it('treats a stream error as a close so the panel can recover', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    let closed = 0;
    ch.onClose(() => {
      closed++;
    });
    s.emit('error', new Error('broken pipe'));
    expect(closed).toBe(1);
  });

  it('reports close only once even if error and close both fire', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    let closed = 0;
    ch.onClose(() => {
      closed++;
    });
    s.emit('error', new Error('broken pipe'));
    s.emit('close');
    expect(closed).toBe(1);
  });

  it('reports a close that happened before the listener was attached', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    s.emit('close');
    let closed = false;
    ch.onClose(() => {
      closed = true;
    });
    expect(closed).toBe(true);
  });

  it('writes pacing newlines to the stream', () => {
    const s = new FakeStream();
    channelFromStream(s as any).write('\n');
    expect(s.written).toEqual(['\n']);
  });

  it('ends the stream on close', () => {
    const s = new FakeStream();
    channelFromStream(s as any).close();
    expect(s.ended).toBe(true);
  });

  // end() only half-closes an ssh2 channel (allowHalfOpen), so a sampler that
  // does not notice EOF would keep its channel slot on the pooled connection
  // SFTP shares. close() hands it back whatever the far end does.
  it('closes the channel, not just its write side', () => {
    const s = new FakeStream();
    channelFromStream(s as any).close();
    expect(s.closed).toBe(true);
  });

  it('tolerates a stream with no close() at all', () => {
    const s = new EventEmitter() as any;
    s.write = () => true;
    s.end = () => undefined;
    expect(() => channelFromStream(s).close()).not.toThrow();
  });

  it('swallows a write after close instead of throwing', () => {
    const s = new FakeStream();
    const ch = channelFromStream(s as any);
    ch.close();
    expect(() => ch.write('\n')).not.toThrow();
    expect(s.written).toEqual([]);
  });
});

describe('readFacts', () => {
  const transport = (stdout: string) => ({
    openSampler: () => Promise.reject(new Error('unused')),
    exec: () => Promise.resolve({ stdout, stderr: '', code: 0 }),
  });

  const FACTS = [
    '--os',
    OS_RELEASE,
    '--cpu',
    CPUINFO,
    '--arch',
    'x86_64',
    '--kernel',
    'Linux',
    '--cores',
    '8',
    '--page',
    '4096',
    '--host',
    'apex',
    '--now',
    '1700000000123',
  ].join('\n');

  it('reads every fact', async () => {
    const f = await readFacts(transport(FACTS), 'fallback');
    expect(f.prettyName).toBe('Ubuntu 22.04.5 LTS (Jammy Jellyfish)');
    expect(f.distroId).toBe('ubuntu');
    expect(f.cpuModel).toBe('Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz');
    expect(f.arch).toBe('x86_64');
    expect(f.cores).toBe(8);
    expect(f.pageSize).toBe(4096);
    expect(f.hostname).toBe('apex');
    expect(f.serverEpochMs).toBe(1700000000123);
    expect(f.linux).toBe(true);
  });

  it('flags a non-Linux kernel', async () => {
    const f = await readFacts(transport(FACTS.replace('\nLinux\n', '\nDarwin\n')), 'fallback');
    expect(f.linux).toBe(false);
  });

  it('falls back to sane defaults when facts are missing', async () => {
    const f = await readFacts(transport('--kernel\nLinux\n'), 'fallback-host');
    expect(f.hostname).toBe('fallback-host');
    expect(f.cores).toBe(1);
    expect(f.pageSize).toBe(4096);
    expect(f.prettyName).toBe('');
    expect(f.linux).toBe(true);
  });
});
