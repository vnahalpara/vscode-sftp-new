import * as path from 'path';
import * as fse from 'fs-extra';

export type StepStatus = 'pending' | 'running' | 'done' | 'error';

export interface StepState {
  status: StepStatus;
  at?: string;
  message?: string;
}

export interface CloneState {
  platform?: 'magento2' | 'wordpress';
  phpVersion?: string;
  hasMysqldump?: boolean;
  gitRemote?: string | null;
  // byte sizes keyed by label (code, db, <mediaPath>…)
  sizes?: { [label: string]: number };
  // Magento env.php values to preserve verbatim across clones (crypt.key, table_prefix, …)
  preservedEnv?: { [key: string]: any };
  steps?: { [step: string]: StepState };
  hostname?: string;
  localPath?: string;
  localDatabase?: string;
  updatedAt?: string;
}

const FILE = path.join('.vscode', 'sftp-clone.state.json');

function fileFor(workspace: string): string {
  return path.join(workspace, FILE);
}

// All clone states for a workspace, keyed by config identity.
function readAll(workspace: string): { [key: string]: CloneState } {
  try {
    return fse.readJsonSync(fileFor(workspace));
  } catch (e) {
    return {};
  }
}

export function loadState(workspace: string, key: string): CloneState {
  return readAll(workspace)[key] || {};
}

export function saveState(workspace: string, key: string, state: CloneState, now: string): void {
  const all = readAll(workspace);
  all[key] = { ...state, updatedAt: now };
  fse.ensureDirSync(path.dirname(fileFor(workspace)));
  fse.writeJsonSync(fileFor(workspace), all, { spaces: 2 });
}

export function setStep(state: CloneState, step: string, status: StepStatus, now: string, message?: string): CloneState {
  const steps = { ...(state.steps || {}) };
  steps[step] = { status, at: now, message };
  return { ...state, steps };
}

export function stepDone(state: CloneState, step: string): boolean {
  return !!(state.steps && state.steps[step] && state.steps[step].status === 'done');
}
