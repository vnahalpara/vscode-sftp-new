import { COMMAND_CREATE_ARCHIVE } from '../constants';
import { createArchive } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_CREATE_ARCHIVE,
  getFileTarget: uriFromExplorerContextOrEditorContext,
  handleFile: createArchive,
});
