import { Route } from './router';
import { Ctx, Handler } from './httpServer';
import { ManagedSession } from './session';
import { SseSink } from './sse';
import { sudoHint } from './activity';
import { OpsDeps, runPrivileged } from './ops/exec';
import {
  servicesCommand,
  serviceActionCommand,
  serviceStatusCommand,
  detectWebServerCommand,
  configFilesCommand,
  testConfigCommand,
  certInfoCommand,
  readFileCommand,
  splitAt,
} from './ops/command';
import { parseUnits, parseUnitFiles, mergeServices, sortServices } from './ops/services';
import { parseDetect, parseNginxVhosts, parseApacheVhosts, parseCertInfo, CertInfo } from './ops/webserver';

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
  services: true,
  webserver: true,
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

// ManagedSession publicly exposes its SSH transport (session.ts's
// `transport` getter) precisely so this can be built straight from the
// session routes.ts already has via resolve() — one owner of the exec
// channel, not a second token-keyed map living alongside index.ts's byToken.
//
// exec runs over privilegedTransport, not transport: systemctl/nginx/openssl
// need sudo, and privilegedTransport is the lane authenticated as root_user
// when the profile supplies those credentials (session-user otherwise). user
// is fed profile.privilegedAs to match -- sudoHint must name the account that
// actually ran the command, or it tells the operator to grant sudo to the
// wrong one.
function opsFor(session: ManagedSession): OpsDeps {
  return {
    exec: cmd => session.privilegedTransport.exec(cmd),
    activity: session.activity,
    user: session.profile.privilegedAs,
    host: session.profile.host,
    now: () => Date.now(),
  };
}

// A builder in ops/command.ts throws on a bad :action, a bad :unit, or an
// unknown :kind — that is the caller (client) asking for something invalid,
// not a server fault. Letting it fall through to httpServer's generic 500
// handler would misreport a client mistake as a server fault and would bury
// real 500s (transport/exec failures) in the same noise. Every builder call
// below that can throw on caller-supplied input is therefore wrapped and
// mapped to 400 here rather than left to propagate.
function badRequest(ctx: Ctx, error: unknown): void {
  ctx.text(400, (error as Error).message);
}

type Kind = 'nginx' | 'apache';

function isKind(value: string): value is Kind {
  return value === 'nginx' || value === 'apache';
}

// Runs testConfigCommand and reports pass/fail without ever throwing.
//
// This deliberately does NOT use runPrivileged. testConfigCommand's script
// redirects the tested binary's own stderr into stdout (`nginx -t 2>&1`), so
// a genuine "the config is broken" failure — the most useful message on this
// page — lands in stdout, not stderr. runPrivileged's error selection only
// ever looks at stderr (sudoHint(stderr) || stderr.trim() || generic exit
// code message), which is right for systemctl-style failures but would
// silently discard the real nginx/apache diagnostic here and replace it with
// "command exited with code 1". This mirrors runPrivileged's activity
// logging (same fields, pushed unconditionally) but keeps stdout available
// on the failure path.
async function runConfigTest(
  ops: OpsDeps,
  kind: Kind,
  command: string
): Promise<{ ok: boolean; output: string }> {
  const start = ops.now();
  const result = await ops.exec(command);
  const ms = ops.now() - start;
  const ok = result.code === 0;
  const hint = !ok ? sudoHint(result.stderr, ops.user, ops.host) : null;
  const output = hint || result.stdout || result.stderr || `command exited with code ${result.code}`;

  ops.activity.push({
    at: ops.now(),
    label: `test ${kind} config`,
    command,
    code: result.code,
    ms,
    error: ok ? null : output,
  });

  return { ok, output };
}

export function buildRoutes(deps: RouteDeps): Route<Handler>[] {
  // Paths a vhost listing has actually returned to this session, keyed by
  // token. GET /api/file is the vhost "View" button's config-file reader,
  // not a general file browser — the token authenticates the page, it does
  // not authorise arbitrary filesystem reads, and this endpoint runs sudo.
  // Restricting reads to exactly what a vhost listing surfaced for that
  // session (populated in the /api/webserver/:kind/vhosts handler below) is
  // what keeps an authenticated browser tab from being able to ask for any
  // root-readable file on the host.
  const allowedFiles = new Map<string, Set<string>>();

  function allowFiles(token: string, paths: string[]): void {
    let set = allowedFiles.get(token);
    if (!set) {
      set = new Set<string>();
      allowedFiles.set(token, set);
    }
    paths.forEach(p => set!.add(p));
  }

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
    {
      method: 'GET',
      path: '/api/services',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const ops = opsFor(session);
        const result = await ops.exec(servicesCommand());
        const sections = splitAt(result.stdout);
        const units = parseUnits(sections.units || '');
        const files = parseUnitFiles(sections.files || '');
        ctx.json(200, { services: sortServices(mergeServices(units, files)) });
      },
    },
    {
      method: 'POST',
      path: '/api/services/:unit/:action',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const ops = opsFor(session);
        const { unit, action } = ctx.params;
        let command: string;
        try {
          command = serviceActionCommand(unit, action);
        } catch (error) {
          badRequest(ctx, error);
          return;
        }
        try {
          const result = await runPrivileged(ops, `${action} ${unit}`, command);
          ctx.json(200, { ok: true, output: result.stdout || result.stderr });
        } catch (error) {
          // A failed action (e.g. a sudo hint, or systemctl rejecting it) is a
          // legitimate result the UI shows inline next to the row, not a
          // server fault — 500 would send it to a toast/error boundary
          // instead of the per-row result the Services tab needs.
          ctx.json(200, { ok: false, output: (error as Error).message });
        }
      },
    },
    {
      method: 'GET',
      path: '/api/services/:unit/status',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const ops = opsFor(session);
        const { unit } = ctx.params;
        let command: string;
        try {
          command = serviceStatusCommand(unit);
        } catch (error) {
          badRequest(ctx, error);
          return;
        }
        const result = await ops.exec(command);
        ctx.json(200, { output: result.stdout || result.stderr });
      },
    },
    {
      method: 'GET',
      path: '/api/webserver',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const ops = opsFor(session);
        const result = await ops.exec(detectWebServerCommand());
        ctx.json(200, parseDetect(result.stdout));
      },
    },
    {
      method: 'GET',
      path: '/api/webserver/:kind/vhosts',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const ops = opsFor(session);
        const kind = ctx.params.kind;
        if (!isKind(kind)) {
          ctx.text(400, `Unknown web server kind: ${kind}`);
          return;
        }

        const configResult = await runPrivileged(ops, `read ${kind} vhost configs`, configFilesCommand(kind));
        const sections = splitAt(configResult.stdout);
        const files = Object.keys(sections).map(file => ({ file, content: sections[file] }));
        allowFiles(session.token, Object.keys(sections));

        const vhosts = kind === 'nginx' ? parseNginxVhosts(files) : parseApacheVhosts(files);

        const certPaths = Array.from(
          new Set(vhosts.map(v => v.certificate).filter((p): p is string => Boolean(p)))
        );
        const certCmd = certInfoCommand(certPaths);

        let certificates: CertInfo[] = [];
        let skipped = certCmd.skipped;
        // certInfoCommand legitimately returns command: '' when every path
        // was rejected (e.g. all contained control characters) — runPrivileged
        // has no guard against an empty command string, so it must never be
        // called with one; there is nothing to run.
        if (certCmd.command) {
          try {
            const certResult = await runPrivileged(ops, `inspect ${kind} certificates`, certCmd.command);
            certificates = parseCertInfo(certResult.stdout, ops.now());
          } catch (error) {
            // A total failure to run openssl (e.g. sudo misconfigured) must
            // not blank the vhosts we already have — surface it as every
            // requested path being uninspectable rather than 500ing the
            // whole tab.
            skipped = skipped.concat(certPaths);
          }
        }

        ctx.json(200, { vhosts, certificates, skipped });
      },
    },
    {
      method: 'POST',
      path: '/api/webserver/:kind/test',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const ops = opsFor(session);
        const kind = ctx.params.kind;
        if (!isKind(kind)) {
          ctx.text(400, `Unknown web server kind: ${kind}`);
          return;
        }
        const result = await runConfigTest(ops, kind, testConfigCommand(kind));
        ctx.json(200, result);
      },
    },
    {
      method: 'GET',
      path: '/api/file',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        const requestedPath = typeof ctx.query.path === 'string' ? ctx.query.path : '';
        const allowed = allowedFiles.get(session.token);
        if (!requestedPath || !allowed || !allowed.has(requestedPath)) {
          ctx.text(403, 'That file was not returned by a vhost listing for this session.');
          return;
        }

        const ops = opsFor(session);
        const linesParam = typeof ctx.query.lines === 'string' ? Number(ctx.query.lines) : NaN;
        let command: string;
        try {
          command = readFileCommand(requestedPath, linesParam);
        } catch (error) {
          badRequest(ctx, error);
          return;
        }

        const result = await runPrivileged(ops, `view ${requestedPath}`, command);
        ctx.json(200, { content: result.stdout });
      },
    },
  ];
}
