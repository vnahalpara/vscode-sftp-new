import * as vscode from 'vscode';
import { getAllFileService } from '../serviceManager';

export interface CloneTarget {
  fileService: any;
  config: any;
}

function eachCloneable(): CloneTarget[] {
  const out: CloneTarget[] = [];
  getAllFileService().forEach(fileService => {
    let config: any;
    try {
      config = fileService.getConfig();
    } catch (e) {
      return;
    }
    if (config.local && config.protocol !== 'ftp') {
      out.push({ fileService, config });
    }
  });
  return out;
}

// Resolve the clone target: the single configured one, or prompt to choose.
export async function resolveCloneTarget(): Promise<CloneTarget | undefined> {
  const targets = eachCloneable();
  if (targets.length === 0) {
    vscode.window.showInformationMessage(
      'No `"local"` block found in any sftp.json connection. Add one to enable site cloning.'
    );
    return undefined;
  }
  if (targets.length === 1) {
    return targets[0];
  }
  const picked = await vscode.window.showQuickPick(
    targets.map(t => ({ label: t.config.name || t.config.host, description: t.config.host, target: t })),
    { placeHolder: 'Select a site to clone' }
  );
  return picked ? picked.target : undefined;
}
