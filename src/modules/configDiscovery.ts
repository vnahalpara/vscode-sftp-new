import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as path from 'path';
import logger from '../logger';
import { CONFIG_PATH } from '../constants';
import {
  CONFIG_EXCLUDE_GLOB,
  CONFIG_SEARCH_MAX_RESULTS,
  clampDepth,
  selectDiscovered,
} from './configPaths';

// A workspace folder reduced to what discovery needs, so callers can pass a
// plain record and the pure helpers stay testable.
export interface DiscoveryFolder {
  name: string;
  fsPath: string;
}

export function readDepthSetting(): number {
  return clampDepth(vscode.workspace.getConfiguration('sftp').get('configSearchDepth'));
}

/**
 * Every `.vscode/sftp.json` to load for one workspace folder.
 *
 * The root-level file is checked directly rather than through the search, so
 * the behaviour every existing workspace relies on cannot be taken away by a
 * search setting, an exclude glob, or a search that fails outright.
 */
export async function discoverConfigFiles(
  folder: DiscoveryFolder,
  depth: number
): Promise<string[]> {
  const rootConfigPath = path.join(folder.fsPath, CONFIG_PATH);
  let rootPath: string | null = null;
  try {
    rootPath = (await fse.pathExists(rootConfigPath)) ? rootConfigPath : null;
  } catch (error) {
    rootPath = null;
  }

  let found: string[] = [];
  if (depth > 0) {
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder.fsPath, '**/.vscode/sftp.json'),
        CONFIG_EXCLUDE_GLOB,
        CONFIG_SEARCH_MAX_RESULTS
      );
      found = uris.map(uri => uri.fsPath);
    } catch (error) {
      logger.warn(`config search failed in ${folder.fsPath}: ${error && error.message}`);
      found = [];
    }
  }

  const files = selectDiscovered(folder.fsPath, rootPath, found, depth);
  logger.info(`${files.length} sftp.json in workspace folder "${folder.name}"`);
  return files;
}
