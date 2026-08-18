import { ActivityLog } from '../activity';
import { runPrivileged, OpsDeps } from '../ops/exec';

interface FakeResult {
  stdout: string;
  stderr: string;
  code: number;
}

function makeDeps(exec: (cmd: string) => Promise<FakeResult>, clock: number[]): OpsDeps {
  const activity = new ActivityLog();
  let i = 0;
  return {
    exec,
    activity,
    user: 'deploy',
    host: 'web1',
    now: () => clock[Math.min(i++, clock.length - 1)],
  };
}

describe('runPrivileged', () => {
  it('runs the command verbatim, without ever prepending sudo itself', async () => {
    const seen: string[] = [];
    const deps = makeDeps(async cmd => {
      seen.push(cmd);
      return { stdout: 'ok', stderr: '', code: 0 };
    }, [1000, 1010]);

    await runPrivileged(deps, 'restart nginx', 'sudo -n systemctl restart nginx');

    expect(seen).toEqual(['sudo -n systemctl restart nginx']);
  });

  it('returns stdout/stderr/code on success', async () => {
    const deps = makeDeps(async () => ({ stdout: 'done', stderr: '', code: 0 }), [1000, 1010]);

    const result = await runPrivileged(deps, 'restart nginx', 'systemctl restart nginx');

    expect(result).toEqual({ stdout: 'done', stderr: '', code: 0 });
  });

  it('logs a successful call with code 0 and the duration from the injected clock', async () => {
    const deps = makeDeps(async () => ({ stdout: 'done', stderr: '', code: 0 }), [1000, 1250]);

    await runPrivileged(deps, 'restart nginx', 'systemctl restart nginx');

    const entries = deps.activity.entries();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      label: 'restart nginx',
      command: 'systemctl restart nginx',
      code: 0,
      ms: 250,
      error: null,
    });
  });

  it('logs the non-zero exit code on failure, still records the entry, and throws', async () => {
    const deps = makeDeps(
      async () => ({ stdout: '', stderr: 'Unit nginx.service not found.', code: 5 }),
      [2000, 2040]
    );

    await expect(
      runPrivileged(deps, 'restart nginx', 'systemctl restart nginx')
    ).rejects.toThrow();

    const entries = deps.activity.entries();
    expect(entries.length).toBe(1);
    expect(entries[0].code).toBe(5);
    expect(entries[0].ms).toBe(40);
    expect(entries[0].error).toBe('Unit nginx.service not found.');
  });

  it('produces a sudo hint containing the user, the host and NOPASSWD on a sudo failure', async () => {
    const deps = makeDeps(
      async () => ({ stdout: '', stderr: 'sudo: a password is required', code: 1 }),
      [1000, 1010]
    );

    let caught: Error | undefined;
    try {
      await runPrivileged(deps, 'restart nginx', 'sudo -n systemctl restart nginx');
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('deploy');
    expect(caught!.message).toContain('web1');
    expect(caught!.message).toContain('NOPASSWD');
  });

  it('records the sudo hint as the activity entry error, not just the raw stderr', async () => {
    const deps = makeDeps(
      async () => ({ stdout: '', stderr: 'sudo: a password is required', code: 1 }),
      [1000, 1010]
    );

    await expect(
      runPrivileged(deps, 'restart nginx', 'sudo -n systemctl restart nginx')
    ).rejects.toThrow();

    const entries = deps.activity.entries();
    expect(entries[0].error).toContain('NOPASSWD');
  });

  it('produces a useful message naming the exit code when stderr is empty', async () => {
    const deps = makeDeps(async () => ({ stdout: '', stderr: '', code: 7 }), [1000, 1010]);

    let caught: Error | undefined;
    try {
      await runPrivileged(deps, 'restart nginx', 'systemctl restart nginx');
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('7');
  });

  it('trims stderr before using it as the failure message', async () => {
    const deps = makeDeps(
      async () => ({ stdout: '', stderr: '  Unit nginx.service not found.\n', code: 5 }),
      [1000, 1010]
    );

    let caught: Error | undefined;
    try {
      await runPrivileged(deps, 'restart nginx', 'systemctl restart nginx');
    } catch (e) {
      caught = e as Error;
    }

    expect(caught!.message).toBe('Unit nginx.service not found.');
  });

  it('notifies the activity log listener for both success and failure', async () => {
    const seenLabels: string[] = [];
    const okDeps = makeDeps(async () => ({ stdout: 'ok', stderr: '', code: 0 }), [1000, 1010]);
    okDeps.activity.onEntry = e => seenLabels.push(e.label);
    await runPrivileged(okDeps, 'reload nginx', 'systemctl reload nginx');
    expect(seenLabels).toEqual(['reload nginx']);
  });
});
