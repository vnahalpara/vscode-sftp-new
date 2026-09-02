import { WebviewMessage } from '../../src/modules/csv/protocol';

// Provided by the VS Code webview host. Declared rather than imported: there
// is no module for it, and this bundle has no @types/vscode-webview.
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// May only be called once per page, so it happens here, at module load. That
// makes this the one module under webui/csv that a test must never import.
const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}
