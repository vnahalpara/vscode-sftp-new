import * as React from 'react';
import { useEffect } from 'react';
import { post } from './vscode';

// Placeholder: Task 8 grows this into the grid. When it does, it must also
// handle the host's answer to an `op`. The host acks a successful op with
// `ack {revision}`; on a stale `base`, a too-large file, a read-only
// document, a failed edit, or a document that moved underneath the edit it
// sends a full `table` (or `tooLarge`) with NO ack. So an incoming
// `table`/`tooLarge` has to clear any pending op queue, or the webview waits
// forever for acks that will never arrive.
export default function App() {
  useEffect(() => {
    post({ type: 'ready' });
  }, []);
  return <div className="csv-screen">Loading…</div>;
}
