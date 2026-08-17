import { samplerScript, slowBatchCommand, factsCommand } from '../probe';

// Ubuntu and Debian ship mawk, which has none of these.
const GAWK_ONLY = /\b(mktime|strftime|asort|asorti|gensub)\s*\(/;

describe('samplerScript', () => {
  it('is paced by stdin rather than a remote sleep', () => {
    const s = samplerScript(300);
    expect(s).toContain('while read');
    expect(s).not.toContain('sleep');
  });

  it('applies the idle timeout so an orphaned loop self-terminates', () => {
    expect(samplerScript(300)).toContain('-t 300');
  });

  it('emits the tick and end markers', () => {
    const s = samplerScript(300);
    expect(s).toContain('==TICK');
    expect(s).toContain('==END');
  });

  it('reads every fast-lane source', () => {
    const s = samplerScript(300);
    [
      '/proc/stat',
      '/proc/meminfo',
      '/proc/loadavg',
      '/proc/uptime',
      '/proc/net/dev',
      '/proc/diskstats',
    ].forEach(p => expect(s).toContain(p));
    expect(s).toContain('/proc/[0-9]*/stat');
  });

  it('labels each section with a marker the framer understands', () => {
    const s = samplerScript(300);
    ['--stat', '--mem', '--load', '--up', '--net', '--disk', '--pids'].forEach(m =>
      expect(s).toContain(m)
    );
  });

  it('uses no gawk-only awk functions', () => {
    expect(GAWK_ONLY.test(samplerScript(300))).toBe(false);
  });
});

describe('slowBatchCommand', () => {
  it('collects mounts in bytes, processes and addresses', () => {
    const c = slowBatchCommand();
    expect(c).toContain('df -PT -B1');
    expect(c).toContain('ps -eo pid=,user=,nlwp=,args=');
    expect(c).toContain('ip -o -4 addr');
  });

  it('labels each section', () => {
    const c = slowBatchCommand();
    ['--df', '--ps', '--addr'].forEach(m => expect(c).toContain(m));
  });

  it('tolerates a missing command instead of failing the whole batch', () => {
    expect(slowBatchCommand()).toContain('2>/dev/null');
  });
});

describe('factsCommand', () => {
  it('collects the one-per-session facts', () => {
    const c = factsCommand();
    [
      '/etc/os-release',
      '/proc/cpuinfo',
      'uname -m',
      'uname -s',
      'nproc',
      'getconf PAGESIZE',
      'hostname',
      'date +%s%3N',
    ].forEach(p => expect(c).toContain(p));
  });

  it('labels each section', () => {
    const c = factsCommand();
    ['--os', '--cpu', '--arch', '--kernel', '--cores', '--page', '--host', '--now'].forEach(m =>
      expect(c).toContain(m)
    );
  });
});
