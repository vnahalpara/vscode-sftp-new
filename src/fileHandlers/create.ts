import { refreshRemoteExplorer } from './shared';
import { fileOperations, UResource } from '../core';
import app from '../app';
import { executeCommand } from '../host';
import { COMMAND_REMOTEEXPLORER_EDITINLOCAL } from '../constants';
import createFileHandler from './createFileHandler';
import { FileHandleOption } from './option';

export const createRemoteFile = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'createRemoteFile',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;

    let promise;
    promise = fileOperations.createFile(remoteFsPath, remoteFs, {});

    /*
    const stat = await remoteFs.lstat(remoteFsPath);
    switch (stat.type) {
      case FileType.Directory:
        if (option.skipDir) {
          return;
        }
        promise = fileOperations.createDir(remoteFsPath, remoteFs, {});
        // promise = fileOperations.removeDir(remoteFsPath, remoteFs, {});
        break;
      case FileType.File:
      case FileType.SymbolicLink:
        // promise = fileOperations.removeFile(remoteFsPath, remoteFs, {});
        break;
      default:
        throw new Error(`Unsupported file type (type = ${stat.type})`);
    }*/
    await promise;
  },
  transformOption() {
    const config = this.config;
    return {
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const gotoFolder = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'gotoFolder',
  async handle(_option) {
    // The remote URI encodes path separators as "%2F"; the segment after the
    // last one is the leaf the user typed. We treat a leaf containing a "." as a
    // file and anything else as a folder (see "Known limitation" in plan.md).
    const remoteUriString = String(this.target.remoteUri);
    const lastIndex = remoteUriString.lastIndexOf('%2F');
    const leaf = lastIndex !== -1 ? remoteUriString.substring(lastIndex + 3) : '';
    const isDirectory = !leaf.includes('.');

    if (isDirectory) {
      await app.remoteExplorer.reveal({
        resource: UResource.makeResource(this.target.remoteUri),
        isDirectory,
      });
    } else {
      await executeCommand(COMMAND_REMOTEEXPLORER_EDITINLOCAL, this.target.localUri);
    }
  },
});

export const createRemoteFolder = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'createRemoteFolder',
  async handle(option) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;

    let promise;
    promise = fileOperations.createDir(remoteFsPath, remoteFs, {});

    /*
    const stat = await remoteFs.lstat(remoteFsPath);
    switch (stat.type) {
      case FileType.Directory:
        if (option.skipDir) {
          return;
        }
        promise = fileOperations.createDir(remoteFsPath, remoteFs, {});
        // promise = fileOperations.removeDir(remoteFsPath, remoteFs, {});
        break;
      case FileType.File:
      case FileType.SymbolicLink:
        // promise = fileOperations.removeFile(remoteFsPath, remoteFs, {});
        break;
      default:
        throw new Error(`Unsupported file type (type = ${stat.type})`);
    }*/
    await promise;
  },
  transformOption() {
    const config = this.config;
    return {
      ignore: config.ignore,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});
