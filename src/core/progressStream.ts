import { Transform, TransformCallback } from 'stream';

export default class ProgressStream extends Transform {
  private _bytes = 0;

  constructor(private _onBytes: (cumulative: number) => void) {
    super();
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this._bytes += chunk.length;
    try {
      this._onBytes(this._bytes);
    } catch {
      // never let a progress callback break the transfer
    }
    callback(undefined, chunk);
  }
}
