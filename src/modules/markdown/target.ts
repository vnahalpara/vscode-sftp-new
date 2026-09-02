import * as vscode from 'vscode';

// Resolve the Markdown file a command should act on from however it was
// invoked: a URI from the explorer or tab context menu, the viewer's own
// toolbar (which passes its document URI), or nothing at all from the command
// palette -- in which case the active editor's document is the only sensible
// target.
export function markdownTargetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const active = vscode.window.activeTextEditor;
  if (active) {
    return active.document.uri;
  }
  // A custom editor is not a TextEditor, so when the viewer itself is the
  // active tab there is no activeTextEditor. The tab API names the active
  // tab's input, and for a custom editor that input carries the URI.
  //
  // Reached through a cast because this repo pins @types/vscode at 1.64 (see
  // package.json engines) and `window.tabGroups` was added in 1.67. It exists
  // at runtime on every VS Code that can run this extension's other features;
  // the guard below is for the types' sake and for an unexpectedly old host,
  // where the honest answer is "no target", not a crash.
  const tabGroups = (vscode.window as any).tabGroups;
  const tab = tabGroups && tabGroups.activeTabGroup && tabGroups.activeTabGroup.activeTab;
  const input: any = tab && tab.input;
  return input && input.uri instanceof vscode.Uri ? input.uri : undefined;
}
