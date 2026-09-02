import * as path from 'path';
import * as vscode from 'vscode';
import { COMMAND_MARKDOWN_TO_PDF } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { activeDocumentUri } from '../modules/editorTarget';
import { renderPrintDocument } from '../modules/markdown/render';
import { renderPdf } from '../modules/markdown/pdf';
import { formatBytes } from '../ui/transferFormat';


export default checkCommand({
  id: COMMAND_MARKDOWN_TO_PDF,

  async handleCommand(arg?: unknown) {
    const uri = activeDocumentUri(arg);
    if (!uri) {
      vscode.window.showInformationMessage('Open a Markdown file first.');
      return;
    }

    // Through the TextDocument rather than the filesystem: if the file is
    // open with unsaved edits, the PDF should match what the user is looking
    // at, not the stale copy on disk. openTextDocument returns the existing
    // document when one is open, and reads from disk when none is.
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const baseName = path.basename(uri.fsPath).replace(/\.(md|markdown)$/i, '');

    // Ask where to put it, defaulting beside the source. A save dialog rather
    // than a silent write next to the file: the whole point of a PDF is to
    // share it, so the user usually wants to choose the destination -- and a
    // silent write into a remote-synced folder would upload the PDF on save
    // for anyone with uploadOnSave.
    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Export PDF',
      defaultUri: vscode.Uri.file(path.join(path.dirname(uri.fsPath), `${baseName}.pdf`)),
      filters: { PDF: ['pdf'] },
    });
    if (!target) {
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Converting ${path.basename(uri.fsPath)} to PDF…`,
        },
        () => renderPdf(renderPrintDocument(source, baseName), target.fsPath)
      );

      const action = await vscode.window.showInformationMessage(
        `${path.basename(target.fsPath)} — ${formatBytes(result.bytes)}`,
        'Open',
        'Reveal'
      );
      if (action === 'Open') {
        await vscode.env.openExternal(target);
      } else if (action === 'Reveal') {
        await vscode.commands.executeCommand('revealFileInOS', target);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`PDF export failed: ${(error as Error).message}`);
    }
  },
});
