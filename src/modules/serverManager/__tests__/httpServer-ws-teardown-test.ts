import * as path from 'path';
import { WebSocket } from 'ws';
import { createServer, listen, closeServer, closeSessionSockets } from '../httpServer';

// Covers the seam between httpServer.ts and wsServer.ts that nothing else
// exercises: ws-attach-test.ts drives attachWs() directly, and
// session-registry-test.ts drives the registry's onTokenDisposed hook in
// isolation, but nothing proves that createServer() actually wires the two
// together -- that the wsHandles WeakMap really gets populated, and that
// closeServer()/closeSessionSockets() really reach a live upgraded socket
// through it. If a future refactor drops `wsHandles.set(server, ws)`, or the
// `ws.close()` inside closeServer(), every other test in the suite stays
// green while a disposed dashboard leaves a live interactive shell running on
// the user's production server -- exactly the leak the previous round fixed.
//
// A real http.Server and a real `ws` client, bound to port 0 only.

const TOKEN_A = 'session-a-token';
const TOKEN_B = 'session-b-token';

// Guards the wait for the effect under test: if closeServer()/
// closeSessionSockets() regress to a no-op, the socket never closes on its
// own, and this rejects instead of hanging the test forever.
function waitForClose(ws: WebSocket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not close in time`)), 2000);
    ws.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForOpen(ws: WebSocket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not open in time`)), 2000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Cleanup that does not depend on the code under test working: forcing every
// client shut and then closing the listener guarantees jest can exit even if
// closeServer()/closeSessionSockets() have regressed to leaving the socket
// (and therefore the server's open connection) alive -- a REGRESSION here
// must surface as a failed assertion above, never as a hung suite.
function forceCleanup(server: import('http').Server, clients: WebSocket[]): Promise<void> {
  clients.forEach(client => client.terminate());
  return new Promise(resolve => server.close(() => resolve()));
}

describe('createServer <-> attachWs teardown seam', () => {
  it('closeServer() terminates a live /ws/terminal socket accepted through createServer()', async () => {
    const server = createServer({
      root: path.resolve('/tmp/does-not-exist-webui'),
      routes: [],
      hasToken: token => token === TOKEN_A,
      fallbackHtml: () => '<!doctype html><title>bootstrap</title>',
      onTerminal: ws => {
        // Left open deliberately: nothing here should ever close it. Only
        // closeServer() below is allowed to.
        ws.on('error', () => undefined);
      },
    });
    const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?t=${TOKEN_A}`);

    try {
      await waitForOpen(client, 'client');
      expect(client.readyState).toBe(WebSocket.OPEN);

      const closed = waitForClose(client, 'client');
      closeServer(server);
      await closed;

      expect(client.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await forceCleanup(server, [client]);
    }
  });

  it('closeSessionSockets() terminates only the named session, leaving the other session live', async () => {
    const accepted: { ws: WebSocket; token: string }[] = [];
    const server = createServer({
      root: path.resolve('/tmp/does-not-exist-webui'),
      routes: [],
      hasToken: token => token === TOKEN_A || token === TOKEN_B,
      fallbackHtml: () => '<!doctype html><title>bootstrap</title>',
      onTerminal: (ws, _req, token) => {
        ws.on('error', () => undefined);
        accepted.push({ ws, token });
      },
    });
    const port = await listen(server);
    const clientA = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?t=${TOKEN_A}`);
    const clientB = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?t=${TOKEN_B}`);

    try {
      await Promise.all([waitForOpen(clientA, 'clientA'), waitForOpen(clientB, 'clientB')]);

      const aClosed = waitForClose(clientA, 'clientA');
      closeSessionSockets(server, TOKEN_A);
      await aClosed;

      expect(clientA.readyState).toBe(WebSocket.CLOSED);
      // The inverse failure -- tearing down the wrong session's socket -- is
      // worse than the leak this exists to catch, so this is asserted just
      // as deliberately as the positive case above.
      expect(clientB.readyState).toBe(WebSocket.OPEN);
    } finally {
      await forceCleanup(server, [clientA, clientB]);
    }
  });
});
