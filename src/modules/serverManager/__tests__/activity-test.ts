import { ActivityLog, sudoHint, ActivityEntry } from '../activity';

function entry(label: string): ActivityEntry {
  return { at: 1, label, command: 'true', code: 0, ms: 5, error: null };
}

describe('ActivityLog', () => {
  it('keeps entries in insertion order', () => {
    const log = new ActivityLog();
    log.push(entry('one'));
    log.push(entry('two'));
    expect(log.entries().map(e => e.label)).toEqual(['one', 'two']);
  });

  it('drops the oldest entries once capacity is exceeded', () => {
    const log = new ActivityLog(2);
    log.push(entry('one'));
    log.push(entry('two'));
    log.push(entry('three'));
    expect(log.entries().map(e => e.label)).toEqual(['two', 'three']);
  });

  it('notifies a listener for each entry', () => {
    const log = new ActivityLog();
    const seen: string[] = [];
    log.onEntry = e => seen.push(e.label);
    log.push(entry('one'));
    expect(seen).toEqual(['one']);
  });

  it('survives having no listener attached', () => {
    const log = new ActivityLog();
    expect(() => log.push(entry('one'))).not.toThrow();
  });

  it('hands out a copy, so a caller cannot mutate the ring', () => {
    const log = new ActivityLog();
    log.push(entry('one'));
    log.entries().push(entry('injected'));
    expect(log.entries().length).toBe(1);
  });

  it('keeps only the newest entry at capacity 1', () => {
    const log = new ActivityLog(1);
    log.push(entry('one'));
    log.push(entry('two'));
    log.push(entry('three'));
    expect(log.entries().map(e => e.label)).toEqual(['three']);
  });

  it('floors a zero capacity to one rather than dropping everything', () => {
    const log = new ActivityLog(0);
    log.push(entry('one'));
    expect(log.entries().map(e => e.label)).toEqual(['one']);
  });

  it('floors a negative capacity to one rather than growing without bound', () => {
    const log = new ActivityLog(-5);
    log.push(entry('one'));
    log.push(entry('two'));
    expect(log.entries().map(e => e.label)).toEqual(['two']);
  });
});

describe('sudoHint', () => {
  it('explains a password prompt', () => {
    const hint = sudoHint('sudo: a password is required', 'deploy', 'web1');
    expect(hint).toContain('deploy');
    expect(hint).toContain('web1');
    expect(hint).toContain('NOPASSWD');
  });

  it('explains a missing tty', () => {
    const hint = sudoHint(
      'sudo: no tty present and no askpass program specified',
      'deploy',
      'web1'
    );
    expect(hint).toContain('NOPASSWD');
  });

  it('explains a user missing from sudoers', () => {
    const hint = sudoHint('deploy is not in the sudoers file.', 'deploy', 'web1');
    expect(hint).toContain('sudoers');
  });

  it('returns null for an unrelated failure, so real errors survive', () => {
    expect(sudoHint('Unit nginx.service not found.', 'deploy', 'web1')).toBeNull();
  });

  it('returns null for empty stderr', () => {
    expect(sudoHint('', 'deploy', 'web1')).toBeNull();
  });
});
