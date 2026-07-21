import { COMMAND_GET_SIZE } from '../constants';
import { getSize } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_GET_SIZE,
  getFileTarget: uriFromExplorerContextOrEditorContext,
  handleFile: getSize,
});
