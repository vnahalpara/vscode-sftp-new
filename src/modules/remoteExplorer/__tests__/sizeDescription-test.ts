import { sizeDescription } from '../sizeDescription';

describe('sizeDescription', () => {
  it('formats a file size when enabled', () => {
    expect(sizeDescription({ isDirectory: false, isRoot: false, size: 1258 }, true)).toBe('1.23 KB');
  });

  it('formats a zero-byte file', () => {
    expect(sizeDescription({ isDirectory: false, isRoot: false, size: 0 }, true)).toBe('0 B');
  });

  it('returns undefined for a folder', () => {
    expect(sizeDescription({ isDirectory: true, isRoot: false, size: 4096 }, true)).toBeUndefined();
  });

  it('returns undefined for a root node', () => {
    expect(sizeDescription({ isDirectory: false, isRoot: true, size: 1258 }, true)).toBeUndefined();
  });

  it('returns undefined when the setting is disabled', () => {
    expect(sizeDescription({ isDirectory: false, isRoot: false, size: 1258 }, false)).toBeUndefined();
  });

  it('returns undefined when size is missing', () => {
    expect(sizeDescription({ isDirectory: false, isRoot: false }, true)).toBeUndefined();
  });
});
