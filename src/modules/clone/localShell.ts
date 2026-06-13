import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { shellSingle } from '../../core/dbExec';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

// Run a local shell command, capturing output. macOS/Linux (clone feature is mac-only for now).
export function run(cmd: string, opts: { cwd?: string; input?: string } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('error', err => (stderr += String(err.message)));
    child.on('close', code => resolve({ stdout, stderr, code: code || 0 }));
    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    }
  });
}

export async function which(bin: string): Promise<boolean> {
  const r = await run(`command -v ${shellSingle(bin)} >/dev/null 2>&1`);
  return r.code === 0;
}

// Run a command visibly in the integrated terminal — for installs and anything needing
// sudo (e.g. editing /etc/hosts). The user sees it and enters their own password.
export function runInTerminal(name: string, commandLine: string): vscode.Terminal {
  const term = vscode.window.createTerminal(name);
  term.show();
  term.sendText(commandLine);
  return term;
}

export { shellSingle };
