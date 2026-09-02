import * as vscode from 'vscode';
import { COMMAND_CSV_OPEN_AS_TEXT } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { activeDocumentUri } from '../modules/editorTarget';


export default checkCommand({
  id: COMMAND_CSV_OPEN_AS_TEXT,

  async handleCommand(arg?: unknown) {
    const uri = activeDocumentUri(arg);
    if (!uri) {
      vscode.window.showInformationMessage('Open a CSV file first.');
      return;
    }
    // `default` is VS Code's own identifier for the built-in text editor.
    // Same thing "Reopen Editor With... > Text Editor" does; the command
    // exists so it can sit in a menu under a plain name rather than behind a
    // picker.
    await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  },
});
