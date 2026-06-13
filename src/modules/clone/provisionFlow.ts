import * as path from 'path';
import * as fse from 'fs-extra';
import * as vscode from 'vscode';
import { getSshClient } from '../../core/sshAccess';
import { resolveClone } from './cloneConfig';
import { loadState, saveState, setStep, CloneState } from './cloneState';
import { pathsConflict } from './cloneOrchestrator';
import { getAdapter } from './platform';
import { detect } from './detect';
import { doctor, provision } from './provision/nativeBrew';
import { runInTerminal, shellSingle } from './localShell';

function nowIso(): string {
  return new Date().toISOString();
}

// Phase 2: provision a local environment (nginx + php-fpm + hosts), localize env.php, and
// (for git-cloned source) run composer install + di:compile. macOS / native brew only.
export async function runProvision(target: { fileService: any; config: any }): Promise<void> {
  const { fileService, config } = target;
  const rc = resolveClone(fileService, config);

  const contextAbs = fileService && fileService.baseDir;
  if (contextAbs && pathsConflict(contextAbs, rc.localPath)) {
    throw new Error('Clone path overlaps the live-sync context — fix "local.path" before provisioning.');
  }
  if (rc.provisioner !== 'native') {
    vscode.window.showWarningMessage('Only the native (brew) provisioner is implemented so far.');
    return;
  }

  let state: CloneState = loadState(rc.workspace, rc.key);

  // PHP version (from detect, or re-detect)
  let php = state.phpVersion;
  if (!php) {
    const ssh = await getSshClient(fileService, config);
    const det = await detect({ exec: (c: string, i?: string) => ssh.exec(c, i), remotePath: rc.remotePath }, rc.mediaPaths);
    state = {
      ...state,
      phpVersion: det.phpVersion,
      platform: det.platform === 'unknown' ? state.platform : det.platform,
      preservedEnv: det.preservedEnv,
    };
    php = det.phpVersion;
  }
  if (!php) {
    vscode.window.showErrorMessage('Could not determine the PHP version to provision.');
    return;
  }

  // Doctor — hard requirements block; 'warn' checks (e.g. search engine down) only surface a notice.
  const checks = await doctor(rc, php);
  const errors = checks.filter(c => !c.ok && c.level !== 'warn');
  const warnings = checks.filter(c => !c.ok && c.level === 'warn');
  if (errors.length) {
    const fixes = errors.map(m => `• ${m.name}: ${m.fix}`).join('\n');
    const pick = await vscode.window.showWarningMessage(
      `Local stack not ready for ${rc.name}:\n${fixes}`,
      { modal: true },
      'Run brew installs in terminal'
    );
    if (pick) {
      const cmds = errors
        .filter(m => m.fix && /^brew /.test(m.fix))
        .map(m => m.fix)
        .join(' && ');
      if (cmds) {
        runInTerminal('clone doctor', cmds);
      }
    }
    return; // user resolves, then re-runs provision
  }
  if (warnings.length) {
    vscode.window.showWarningMessage(
      `Provisioning ${rc.name} with warnings — ${warnings.map(w => `${w.name}: ${w.fix}`).join('; ')}.`
    );
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Provision ${rc.name}` },
    async progress => {
      // localize env.php
      const adapter = getAdapter(state.platform || 'magento2');
      if (adapter && adapter.localize) {
        progress.report({ message: 'Writing localized env.php…' });
        const res = await adapter.localize(rc, state.preservedEnv || {});
        state = setStep(state, 'localize', 'done', nowIso(), res.message);
        saveState(rc.workspace, rc.key, state, nowIso());
      }

      // nginx vhost + php-fpm + hosts
      progress.report({ message: `Configuring nginx + php@${php} + /etc/hosts…` });
      const pr = await provision(rc, php!);
      state = setStep(state, 'provision', 'done', nowIso(), pr.message);
      saveState(rc.workspace, rc.key, state, nowIso());

      // build: composer install + di:compile only when vendor is missing (git source); always
      // flush cache + reindex so the local search engine gets this project's catalog.
      const vendorReady = fse.existsSync(path.join(rc.localPath, 'vendor', 'autoload.php'));
      const buildSteps: string[] = [];
      if (!vendorReady) {
        buildSteps.push('composer install', 'php bin/magento setup:di:compile');
      }
      buildSteps.push('php bin/magento cache:flush', 'php bin/magento indexer:reindex');
      runInTerminal(`build ${rc.name}`, `cd ${shellSingle(rc.localPath)} && ${buildSteps.join(' && ')}`);
      const buildMsg = vendorReady ? 'cache:flush + reindex' : 'composer install + di:compile + reindex';
      state = setStep(state, 'build', 'pending', nowIso(), `${buildMsg} running in terminal`);
      saveState(rc.workspace, rc.key, state, nowIso());
    }
  );

  const url = rc.ssl ? `https://${rc.hostname}` : `http://${rc.hostname}`;
  const action = await vscode.window.showInformationMessage(
    `Provisioned ${rc.name}. Finish the terminal step(s) (/etc/hosts password + build/reindex), then open ${url}.`,
    'Open'
  );
  if (action === 'Open') {
    vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
