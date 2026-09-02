import * as vscode from 'vscode';

// Resolve the file a command should act on from however it was invoked: a URI
// from the explorer or tab context menu, a custom editor's own toolbar (which
// passes its document URI), or nothing at all from the command palette -- in
// which case the active editor's document is the only sensible target.
//
// Shared by the Markdown commands and the CSV command: every one of them has
// the same three ways in.
export function activeDocumentUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const active = vscode.window.activeTextEditor;
  if (active) {
    return active.document.uri;
  }
  // A custom editor is not a TextEditor, so when a viewer or the grid is the
  // active tab there is no activeTextEditor. The tab API names the active
  // tab's input, and for a custom editor that input carries the URI.
  //
  // `window.tabGroups` arrived in VS Code 1.67, which is why package.json's
  // engine is `^1.67.0` and not lower: this is the only path that can find
  // the document when a custom editor is the active tab and a command arrives
  // with no argument (the command palette). An earlier draft claimed the API
  // was present on any host that could run the extension while the engine
  // still said 1.64 -- on 1.64-1.66 the palette command would have silently
  // answered "Open a Markdown file first" with the file open in front of the
  // user. The engine floor is the fix, not a runtime guard.
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  return input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText
    ? input.uri
    : undefined;
}
