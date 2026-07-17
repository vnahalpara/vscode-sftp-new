import { Readable } from 'stream';
import ProgressStream from '../progressStream';

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', c => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('ProgressStream', () => {
  it('passes all bytes through unchanged', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const progress = new ProgressStream(() => undefined);
    const out = await collect(source.pipe(progress));
    expect(out.toString()).toBe('hello world');
  });

  it('reports cumulative byte counts', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const seen: number[] = [];
    const progress = new ProgressStream(n => seen.push(n));
    await collect(source.pipe(progress));
    expect(seen[seen.length - 1]).toBe(11); // 'hello world'
    expect(seen).toEqual([6, 11]);
  });
});
