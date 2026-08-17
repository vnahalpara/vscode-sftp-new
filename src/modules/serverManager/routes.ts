import { Route } from './router';
import { Ctx, Handler } from './httpServer';
import { ManagedSession } from './session';
import { SseSink } from './sse';

export interface SessionLookup {
  get(token: string): ManagedSession | undefined;
}

export interface RouteDeps {
  sessions: SessionLookup;
  pingMs: number;
  schedule(fn: () => void, ms: number): any;
  cancel(handle: any): void;
}

// Everything the later milestones will turn on. The UI reads these to decide
// which tabs are live, so an unfinished tab is greyed out rather than broken.
const CAPABILITIES = {
  services: false,
  webserver: false,
  logs: false,
  terminal: false,
  database: false,
};

function resolve(deps: RouteDeps, ctx: Ctx): ManagedSession | null {
  const session = deps.sessions.get(ctx.token);
  if (!session) {
    // The token authenticated but its session is gone — VS Code reloaded, or
    // the window outlived the workspace. 404 is the honest answer.
    ctx.text(404, 'That session is no longer open in VS Code.');
    return null;
  }
  return session;
}

export function buildRoutes(deps: RouteDeps): Route<Handler>[] {
  return [
    {
      method: 'GET',
      path: '/api/session',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        // state() carries no token, and must not start doing so.
        ctx.json(200, { ...session.state(), capabilities: CAPABILITIES });
      },
    },
    {
      method: 'GET',
      path: '/api/host',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        ctx.json(200, session.state());
      },
    },
    {
      method: 'POST',
      path: '/api/host/refresh',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        try {
          await session.refresh();
          ctx.json(200, { ok: true });
        } catch (error) {
          ctx.text(500, (error as Error).message);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/activity',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        ctx.json(200, { entries: session.activity.entries() });
      },
    },
    {
      method: 'GET',
      path: '/api/stream',
      handler: ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }

        ctx.res.writeHead(200, {
          'content-type': 'text/event-stream',
          // no-transform matters: a compressing proxy would buffer the stream.
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });

        const sink: SseSink = {
          write: chunk => ctx.res.write(chunk),
          end: () => ctx.res.end(),
        };
        const unsubscribe = session.subscribe(sink);
        const heartbeat = deps.schedule(() => session.sse.ping(), deps.pingMs);

        ctx.req.on('close', () => {
          deps.cancel(heartbeat);
          unsubscribe();
        });
      },
    },
  ];
}
