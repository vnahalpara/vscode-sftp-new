import {
  DEFAULT_EXCLUDES,
  archiveName,
  buildCleanupCommand,
  buildCountCommand,
  buildStatCommand,
  buildTarCommand,
  isDiagnosticLine,
  isSafeExclude,
  parseVerboseChunk,
  resolveExcludes,
  splitRemotePath,
} from '../createArchiveCore';

describe('isSafeExclude', () => {
  it('accepts an ordinary pattern', () => {
    expect(isSafeExclude('node_modules')).toBe(true);
    expect(isSafeExclude('var/cache')).toBe(true);
  });

  // The characters a naive "reject dangerous input" filter gets wrong: both
  // are legitimate in a real directory name.
  it('accepts a hyphen and a space', () => {
    expect(isSafeExclude('my-cache')).toBe(true);
    expect(isSafeExclude('Application Support')).toBe(true);
  });

  // A newline would split a line of tar's verbose output and desynchronise
  // the progress count from the files actually archived.
  it('rejects a newline', () => {
    expect(isSafeExclude('a\nb')).toBe(false);
  });

  it('rejects a carriage return and a tab', () => {
    expect(isSafeExclude('a\rb')).toBe(false);
    expect(isSafeExclude('a\tb')).toBe(false);
  });

  it('rejects an empty pattern and a non-string', () => {
    expect(isSafeExclude('')).toBe(false);
    expect(isSafeExclude(42 as any)).toBe(false);
    expect(isSafeExclude(null as any)).toBe(false);
  });

  it('rejects an absurdly long pattern', () => {
    expect(isSafeExclude('x'.repeat(256))).toBe(false);
  });
});

describe('resolveExcludes', () => {
  it('falls back to the defaults when nothing is configured', () => {
    expect(resolveExcludes(undefined)).toEqual(DEFAULT_EXCLUDES);
    expect(resolveExcludes(null)).toEqual(DEFAULT_EXCLUDES);
  });

  it('uses a configured list verbatim', () => {
    expect(resolveExcludes(['foo', 'bar'])).toEqual(['foo', 'bar']);
  });

  // An explicit empty array means "archive everything" and must be honoured,
  // NOT silently replaced by the defaults -- that is the only way to opt out.
  it('honours an explicit empty list as archive-everything', () => {
    expect(resolveExcludes([])).toEqual([]);
  });

  it('drops unsafe entries rather than failing the whole run', () => {
    expect(resolveExcludes(['ok', 'bad\nline'])).toEqual(['ok']);
  });

  // vendor is deliberately not a default: excluding a dependency tree turns a
  // pre-change backup into one that cannot be restored without a working
  // composer/npm install and network access from the server.
  it('does not exclude vendor by default', () => {
    expect(DEFAULT_EXCLUDES).not.toContain('vendor');
  });
});

describe('archiveName', () => {
  const at = new Date(2026, 7, 21, 9, 5, 3);

  it('builds a timestamped name', () => {
    expect(archiveName('media', at)).toBe('media-2026-08-21-090503.tar.gz');
  });

  it('zero-pads so names sort lexicographically', () => {
    expect(archiveName('a', new Date(2026, 0, 2, 3, 4, 5))).toBe('a-2026-01-02-030405.tar.gz');
  });

  it('collapses characters that are awkward in a filename', () => {
    expect(archiveName('my data', at)).toBe('my_data-2026-08-21-090503.tar.gz');
    expect(archiveName("we'ird;", at)).toBe('we_ird_-2026-08-21-090503.tar.gz');
  });

  it('falls back to a usable name for an empty folder name', () => {
    expect(archiveName('', at)).toBe('archive-2026-08-21-090503.tar.gz');
  });

  // Two runs a second apart must never collide; the timestamp is what makes
  // an overwrite prompt unnecessary.
  it('produces different names one second apart', () => {
    const a = archiveName('x', new Date(2026, 7, 21, 9, 5, 3));
    const b = archiveName('x', new Date(2026, 7, 21, 9, 5, 4));
    expect(a).not.toBe(b);
  });
});

describe('splitRemotePath', () => {
  it('splits an ordinary path', () => {
    expect(splitRemotePath('/var/www/html/media')).toEqual({
      parent: '/var/www/html',
      name: 'media',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(splitRemotePath('/var/www/media/')).toEqual({ parent: '/var/www', name: 'media' });
  });

  it('handles a folder directly under root', () => {
    expect(splitRemotePath('/srv')).toEqual({ parent: '/', name: 'srv' });
  });

  it('handles a bare relative name', () => {
    expect(splitRemotePath('media')).toEqual({ parent: '.', name: 'media' });
  });
});

describe('buildCountCommand', () => {
  it('prunes each exclude so the count matches what tar will add', () => {
    const cmd = buildCountCommand('/var/www', 'html', ['node_modules', '.git']);
    expect(cmd).toContain("cd '/var/www'");
    expect(cmd).toContain("-name 'node_modules' -prune -o");
    expect(cmd).toContain("-name '.git' -prune -o");
    expect(cmd).toContain('-print | wc -l');
  });

  it('quotes a path containing a single quote', () => {
    expect(buildCountCommand("/var/o'brien", 'html', [])).toContain(`'/var/o'\\''brien'`);
  });
});

describe('buildTarCommand', () => {
  it('writes the archive to the parent and archives a relative path', () => {
    const cmd = buildTarCommand('/var/www', 'html', 'html-2026.tar.gz', []);
    expect(cmd).toBe(`cd '/var/www' && tar -czvf 'html-2026.tar.gz'  -- './html'`);
  });

  it('passes each exclude to tar', () => {
    const cmd = buildTarCommand('/p', 'n', 'a.tar.gz', ['node_modules', 'var/cache']);
    expect(cmd).toContain(`--exclude='node_modules'`);
    expect(cmd).toContain(`--exclude='var/cache'`);
  });

  // The end-of-options guard this repo uses on every remote command: a
  // directory named `--checkpoint` is a flag to getopt otherwise.
  it('guards the path with an end-of-options marker', () => {
    expect(buildTarCommand('/p', '--checkpoint', 'a.tar.gz', [])).toContain(`-- './--checkpoint'`);
  });

  it('quotes a folder name containing a single quote', () => {
    expect(buildTarCommand('/p', "o'brien", 'a.tar.gz', [])).toContain(`'./o'\\''brien'`);
  });
});

describe('buildCleanupCommand', () => {
  it('removes the partial archive by full path', () => {
    expect(buildCleanupCommand('/var/www', 'a.tar.gz')).toBe(`rm -f '/var/www/a.tar.gz'`);
  });
});

describe('buildStatCommand', () => {
  it('tries GNU stat then BSD stat then falls back to zero', () => {
    const cmd = buildStatCommand('/p', 'a.tar.gz');
    expect(cmd).toContain('stat -c%s');
    expect(cmd).toContain('stat -f%z');
    expect(cmd).toContain('echo 0');
  });
});

describe('parseVerboseChunk', () => {
  it('returns whole lines and keeps the partial remainder', () => {
    const out = parseVerboseChunk('a.txt\nb.txt\nc.t', '');
    expect(out.names).toEqual(['a.txt', 'b.txt']);
    expect(out.carry).toBe('c.t');
  });

  // A chunk boundary falls mid-line often at these volumes; dropping the
  // remainder silently under-counts and the bar never reaches 100%.
  it('completes a line split across two chunks', () => {
    const first = parseVerboseChunk('a.txt\nb.t', '');
    const second = parseVerboseChunk('xt\nc.txt\n', first.carry);
    expect(second.names).toEqual(['b.txt', 'c.txt']);
    expect(second.carry).toBe('');
  });

  it('strips a carriage return and drops blank lines', () => {
    expect(parseVerboseChunk('a.txt\r\n\nb.txt\n', '').names).toEqual(['a.txt', 'b.txt']);
  });

  it('handles an empty chunk without losing the carry', () => {
    expect(parseVerboseChunk('', 'partial')).toEqual({ names: [], carry: 'partial' });
  });
});

describe('isDiagnosticLine', () => {
  // Counting a warning as a file makes the progress bar overshoot its total.
  it('recognises a tar diagnostic', () => {
    expect(isDiagnosticLine('tar: Removing leading `/` from member names')).toBe(true);
    expect(isDiagnosticLine('tar: ./x: File changed as we read it')).toBe(true);
  });

  it('does not mistake a real member for a diagnostic', () => {
    expect(isDiagnosticLine('./html/index.php')).toBe(false);
  });

  // A file legitimately named `tarball.txt` starts with "tar" but is not a
  // diagnostic -- the colon-and-space is what distinguishes them.
  it('does not mistake a file starting with tar for a diagnostic', () => {
    expect(isDiagnosticLine('./tarball.txt')).toBe(false);
    expect(isDiagnosticLine('tarantula.log')).toBe(false);
  });
});
