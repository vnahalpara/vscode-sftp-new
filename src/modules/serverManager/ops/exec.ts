import { ActivityLog, sudoHint } from '../activity';

export interface OpsDeps {
  exec(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
  activity: ActivityLog;
  user: string;
  host: string;
  now(): number;
}

// Run one already-built privileged command and record it in the activity
// log, success or failure alike.
//
// Privilege contract (see ops/command.ts): every command handed to this
// function is already complete, with any `sudo -n` baked in by the builder
// that made it. This function must never prepend `sudo` itself -- doing so
// would double-sudo every privileged call.
//
// The command is logged verbatim. Everything this module runs comes from
// ops/command.ts's builders -- systemctl, openssl, sed invocations -- none
// of which embed a credential. If a future builder ever needs to pass a
// secret on the command line, it must not be logged as-is; redact it before
// it reaches here.
//
// Ordering: the activity entry is pushed BEFORE this function throws on a
// failure. An operator's first move after a failed restart is to check the
// activity log, and an entry that only gets written on success would erase
// the exact call they came looking for. So the entry always lands first,
// and the throw (if any) happens after.
export async function runPrivileged(
  deps: OpsDeps,
  label: string,
  command: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const start = deps.now();
  const result = await deps.exec(command);
  const ms = deps.now() - start;

  let error: string | null = null;
  if (result.code !== 0) {
    const hint = sudoHint(result.stderr, deps.user, deps.host);
    error = hint || result.stderr.trim() || `command exited with code ${result.code}`;
  }

  deps.activity.push({
    at: deps.now(),
    label,
    command,
    code: result.code,
    ms,
    error,
  });

  if (error !== null) {
    throw new Error(error);
  }

  return result;
}
