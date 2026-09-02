import * as vscode from 'vscode';
import { COMMAND_MARKDOWN_OPEN_AS_TEXT } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { markdownTargetUri } from '../modules/markdown/target';


export default checkCommand({
  id: COMMAND_MARKDOWN_OPEN_AS_TEXT,

  async handleCommand(arg?: unknown) {
    const uri = markdownTargetUri(arg);
    if (!uri) {
      vscode.window.showInformationMessage('Open a Markdown file first.');
      return;
    }
    // `default` is VS Code's own identifier for the built-in text editor.
    // This is the same thing "Reopen Editor With... > Text Editor" does; the
    // command exists so it can sit in a menu under a plain name rather than
    // behind a picker.
    await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  },
});
