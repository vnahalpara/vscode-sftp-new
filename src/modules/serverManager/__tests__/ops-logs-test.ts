import { parseLogDiscovery } from '../ops/logs';
import {
  LOG_DISCOVERY_TEXT,
  LOG_DISCOVERY_EMPTY_TEXT,
  LOG_DISCOVERY_GUARDED_NO_FINAL_NEWLINE_TEXT,
  LOG_DISCOVERY_UNGUARDED_NO_FINAL_NEWLINE_TEXT,
  LOG_DISCOVERY_HUGE_SIZE_TEXT,
  LOG_DISCOVERY_INJECTED_PATH_TEXT,
} from '../__fixtures__/ops';

describe('parseLogDiscovery', () => {
  it('parses an ordinary file with a readable size', () => {
    const { files } = parseLogDiscovery(LOG_DISCOVERY_TEXT);
    const syslog = files.filter(f => f.path === '/var/log/syslog')[0];
    expect(syslog).toEqual({ path: '/var/log/syslog', bytes: 8832 });
  });

  it('reports a genuinely empty file as bytes: 0, a real known size', () => {
    const { files } = parseLogDiscovery(LOG_DISCOVERY_TEXT);
    const wtmp = files.filter(f => f.path === '/var/log/wtmp')[0];
    expect(wtmp).toEqual({ path: '/var/log/wtmp', bytes: 0 });
  });

  it('reports an unstattable file as bytes: null, never bytes: 0', () => {
    const { files } = parseLogDiscovery(LOG_DISCOVERY_TEXT);
    const protectedFile = files.filter(f => f.path === '/var/log/private/protected.log')[0];
    expect(protectedFile).toBeDefined();
    expect(protectedFile.bytes).toBeNull();
    expect(protectedFile.bytes).not.toBe(0);
  });

  it('splits on the first TAB only, so a path containing spaces survives intact', () => {
    const { files } = parseLogDiscovery(LOG_DISCOVERY_TEXT);
    const spaced = files.filter(f => f.path === '/var/log/app 2/access log')[0];
    expect(spaced).toEqual({ path: '/var/log/app 2/access log', bytes: 4096 });
  });

  it('parses the journald unit list', () => {
    const { units } = parseLogDiscovery(LOG_DISCOVERY_TEXT);
    expect(units).toEqual(['nginx.service', 'sshd.service', 'cron.service']);
  });

  it('returns empty files and units for empty sections rather than throwing', () => {
    expect(parseLogDiscovery(LOG_DISCOVERY_EMPTY_TEXT)).toEqual({ files: [], units: [] });
  });

  it('returns empty files and units when neither section is present at all', () => {
    expect(parseLogDiscovery('noise, no markers here')).toEqual({ files: [], units: [] });
  });

  it('treats a non-numeric size field as bytes: null', () => {
    const text = '@@files\nnot-a-number\t/var/log/weird.log\n@@units\n';
    const { files } = parseLogDiscovery(text);
    expect(files).toEqual([{ path: '/var/log/weird.log', bytes: null }]);
  });

  it('treats a size field too large to represent exactly (> Number.MAX_SAFE_INTEGER) as bytes: null, ' +
     'not a rounded/approximate number', () => {
    const { files } = parseLogDiscovery(LOG_DISCOVERY_HUGE_SIZE_TEXT);
    expect(files).toEqual([{ path: '/var/log/huge.log', bytes: null }]);
  });

  it('drops a discovered path outside /var/log entirely, keeping every legitimate entry alongside it', () => {
    // The load-bearing fix for the newline-in-filename hazard documented
    // on logDiscoveryCommand: a forged @@files line naming a path like
    // /etc/shadow must never survive parseLogDiscovery, regardless of how
    // it got into the stream, and a single bad entry must not take down
    // the legitimate ones next to it.
    const { files } = parseLogDiscovery(LOG_DISCOVERY_INJECTED_PATH_TEXT);
    expect(files).toEqual([{ path: '/var/log/nginx/access.log', bytes: 4096 }]);
    expect(files.some(f => f.path === '/etc/shadow')).toBe(false);
  });

  describe('framing a section whose last line lacks a final newline', () => {
    it('still parses @@units correctly when the guard newline logDiscoveryCommand adds is present', () => {
      const result = parseLogDiscovery(LOG_DISCOVERY_GUARDED_NO_FINAL_NEWLINE_TEXT);
      expect(result.files).toEqual([{ path: '/var/log/nginx/access.log', bytes: 4096 }]);
      expect(result.units).toEqual(['nginx.service']);
    });

    it('is the guard newline that makes the difference -- without it the @@units marker is swallowed', () => {
      // Documents the failure mode logDiscoveryCommand's defensive
      // `printf '\n'` exists to prevent: with the guard newline missing,
      // @@units is glued onto the previous file's path and the unit name
      // is lost from `units` entirely.
      const result = parseLogDiscovery(LOG_DISCOVERY_UNGUARDED_NO_FINAL_NEWLINE_TEXT);
      expect(result.units).toEqual([]);
      expect(result.files.length).toBe(1);
      expect(result.files[0].path).toContain('@@units');
      expect(result.files[0].path).not.toBe('/var/log/nginx/access.log');
    });
  });
});
