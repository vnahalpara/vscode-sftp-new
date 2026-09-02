import Trie from '../trie';

function trie() {
  return new Trie<string>({}, { delimiter: '/' });
}

describe('Trie.get', () => {
  it('returns the value stored at exactly that key', () => {
    const t = trie();
    t.add('/a/b', 'service');
    expect(t.get('/a/b')).toBe('service');
  });

  // The difference that matters for collision detection: findPrefix answers
  // "who owns this path", which for an unclaimed child is the ANCESTOR. Asking
  // "is this exact folder already claimed" needs get.
  it('returns null for a descendant of a stored key, where findPrefix returns the ancestor', () => {
    const t = trie();
    t.add('/a/b', 'service');
    expect(t.findPrefix('/a/b/c')).toBe('service');
    expect(t.get('/a/b/c')).toBeNull();
  });

  it('returns null for a key that was never added', () => {
    const t = trie();
    t.add('/a/b', 'service');
    expect(t.get('/x/y')).toBeNull();
  });

  it('returns null for an interior node with no value', () => {
    const t = trie();
    t.add('/a/b/c', 'service');
    expect(t.get('/a/b')).toBeNull();
  });

  it('returns null after the key is removed', () => {
    const t = trie();
    t.add('/a/b', 'service');
    t.remove('/a/b');
    expect(t.get('/a/b')).toBeNull();
  });
});
