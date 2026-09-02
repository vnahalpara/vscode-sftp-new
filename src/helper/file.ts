import * as tmp from 'tmp';
import * as vscode from 'vscode';
import { upath } from '../core';
import { isConfigPath } from '../modules/configPaths';

export function isValidFile(uri: vscode.Uri) {
  return uri.scheme === 'file';
}

// A config file is sftp.json INSIDE a .vscode directory, at any depth -- not
// any file named sftp.json. The config handlers now derive a config root two
// levels up from the file, so a stray sftp.json elsewhere in the tree would
// reload an unrelated folder's services from it.
export function isConfigFile(uri: vscode.Uri) {
  return isConfigPath(uri.fsPath);
}

export function fileDepth(file: string) {
  return upath.normalize(file).split('/').length;
}

export function makeTmpFile(option): Promise<string> {
  return new Promise((resolve, reject) => {
    tmp.file({ ...option, discardDescriptor: true }, (err, tmpPath) => {
      if (err) reject(err);

      resolve(tmpPath);
    });
  });
}
