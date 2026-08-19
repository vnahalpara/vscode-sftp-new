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
  isConfigFilePath,
  logDiscoveryCommand,
  isLogFilePath,
  isSafeUnitName,
  splitAt,
} from './ops/command';
import { parseUnits, parseUnitFiles, mergeServices, sortServices } from './ops/services';
import { parseDetect, parseNginxVhosts, parseApacheVhosts, parseCertInfo, CertInfo } from './ops/webserver';
import { parseLogDiscovery } from './ops/logs';
import { hasCloudflare, zoneInfo, purgeEverything, CloudflareDeps } from './ops/cloudflare';

export interface SessionLookup {
  get(token: string): ManagedSession | undefined;
}

export interface RouteDeps {
  sessions: SessionLookup;
  pingMs: number;
  schedule(fn: () => void, ms: number): any;
  cancel(handle: any): void;
  // Optional: lets buildRoutes register a listener that fires when a
  // session's token is disposed (session closed on shutdown, or evicted
  // because its credentials changed under it -- see
  // SessionRegistryHooks.onTokenDisposed in index.ts, which this is meant
  // to be wired to). Subscribe-shaped (`deps.onTokenDisposed(listener)`),
  // not a single direct callback, because more than one piece of
  // per-token state below wants to hear about it. Optional because
  // RouteDeps predates this hook; a caller that doesn't wire it keeps the
  // pre-existing behaviour of never pruning allowedFiles.
  //
  // INVARIANT, and the reason index.ts's implementation is safe: buildRoutes
  // calls this SYNCHRONOUSLY, during construction, exactly once. index.ts's
  // wiring resets its listener list immediately before calling buildRoutes
  // and adds this listener during that call, so a rebuild cannot drop the
  // listener the new routes instance just registered. An implementation that
  // deferred the call (or a buildRoutes that registered lazily, from inside a
  // handler) would register into whatever list existed at that later moment
  // -- which after a server restart is a different one. Register eagerly.
  onTokenDisposed?(listener: (token: string) => void): void;
  // The Cloudflare HTTP client the /api/cloudflare/* routes call through --
  // production wires the real `httpsRequest` (ops/cloudflare.ts); tests
  // inject a fake so no route in this file ever makes a real network call.
  // Optional, like onTokenDisposed above, so the many pre-existing tests
  // that never exercise a Cloudflare route need not supply it -- those
  // routes' capability gate (hasCloudflare(session.cloudflareConfig)) always
  // returns false for a fake session with no cloudflareConfig override, so
  // the handler 404s before this is ever touched.
  cloudflare?: CloudflareDeps;
}

// Everything the later milestones will turn on. The UI reads these to decide
// which tabs are live, so an unfinished tab is greyed out rather than broken.
const CAPABILITIES = {
  services: true,
  webserver: true,
  logs: true,
  terminal: true,
  database: false,
  // DELIBERATELY UNCONSUMED, and it must stay that way. Every other key here
  // is a TAB name -- App.jsx and Dashboard.jsx look each tab up by key to
  // decide whether to grey it out. Cloudflare is not a tab; it is a card
  // inside Web server, and whether it renders is a PER-PROFILE question
  // (`profile.hasCloudflare`, i.e. does THIS profile carry both
  // CLOUDFLARE_* fields), not a per-build one. This flag only says the build
  // carries the feature at all, which is true of every build that contains
  // this line.
  //
  // Gating the card on this instead would render it for profiles with no
  // Cloudflare config, whose every request then 404s on the routes below.
  // If you are adding a consumer: use profile.hasCloudflare, not this.
  cloudflare: true,
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
// exec runs over privilegedTransport: this builder is for the commands that
// actually carry `sudo -n` (service actions, config reads, `nginx -t`,
// openssl, /api/file), and privilegedTransport is the lane authenticated as
// root_user when the profile supplies those credentials (session-user
// otherwise). user is fed profile.privilegedAs to match -- sudoHint must name
// the account that actually ran the command, or it tells the operator to
// grant sudo to the wrong one. Commands with no sudo in them use readOpsFor
// below instead, so a read never dials the root lane.
function opsFor(session: ManagedSession): OpsDeps {
  return {
    exec: cmd => session.privilegedTransport.exec(cmd),
    activity: session.activity,
    user: session.profile.privilegedAs,
    host: session.profile.host,
    now: () => Date.now(),
  };
}

// The unprivileged read lane, for the three commands under this router that
// carry no `sudo` at all: servicesCommand(), serviceStatusCommand() and
// detectWebServerCommand(). They need no privilege, so they must not be the
// thing that dials the root connection.
//
// Running them over privilegedTransport meant merely OPENING the Services
// tab opened the root SSH lane. Ubuntu and Debian ship
// `PermitRootLogin prohibit-password`, so a user who configured
// root_user/root_password exactly as documented -- without also enabling
// root password login -- got BOTH tabs failing to load with a raw ssh2 "All
// configured authentication methods failed": no sudo hint, no mention of the
// root lane, and (since these three bypass runPrivileged) not even an
// activity-log entry to explain it. Reading over the session's own transport
// -- the lane the Overview tab already holds open -- degrades that to "the
// list loads, and only the actions fail, with a hint that names the account".
//
// `user` is the session's own username here, not privilegedAs: sudoHint must
// name the account that actually ran the command.
function readOpsFor(session: ManagedSession): OpsDeps {
  return {
    exec: cmd => session.transport.exec(cmd),
    activity: session.activity,
    user: session.profile.username,
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

// Runs one Cloudflare API call (zoneInfo/purgeEverything) and records the
// outcome in the activity log -- the zone id and success/failure only, never
// the token and never an Authorization header. Same ordering discipline as
// runPrivileged: the entry is pushed regardless of outcome, before the
// caller below turns a rejection into a response.
//
// The message on a rejection is never Cloudflare's raw response body, and
// never a raw Node error either. zoneInfo/purgeEverything map BOTH halves of
// the failure space before it reaches here:
//
//   - a RESPONSE failure (a bad HTTP status, or a 200 with `success: false`)
//     through cloudflareError;
//   - a TRANSPORT rejection from the injected client -- httpsRequest's 15s
//     timeout, a DNS/TLS error, `https.request`'s synchronous
//     ERR_UNESCAPED_CHARACTERS throw -- through cloudflareTransportError,
//     which ops/cloudflare.ts's internal `request()` wrapper applies to every
//     call it makes.
//
// Both run the same token-contamination ladder, which is what guarantees the
// token cannot appear in the message even if Cloudflare's own error payload
// echoes it back. This function does not call either mapper a second time; it
// only relays the message the call already produced. (An earlier version of
// this comment claimed cloudflareError covered "every error path" -- it
// covered only the response half, and the transport half reached the 502 body
// and the activity entry as a bare `getaddrinfo ENOTFOUND api.cloudflare.com`.)
async function runCloudflare<T>(
  session: ManagedSession,
  label: string,
  zoneId: string,
  call: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const start = Date.now();
  try {
    const value = await call();
    session.activity.push({
      at: Date.now(),
      label,
      command: `zone ${zoneId}`,
      code: 0,
      ms: Date.now() - start,
      error: null,
    });
    return { ok: true, value };
  } catch (error) {
    const message = (error as Error).message;
    session.activity.push({
      at: Date.now(),
      label,
      command: `zone ${zoneId}`,
      code: 1,
      ms: Date.now() - start,
      error: message,
    });
    return { ok: false, message };
  }
}

// What buildRoutes hands back: the handlers, plus read-only access to the
// one allowlist those handlers seed.
//
// The predicate is exported rather than duplicated because /ws/logs
// (logFollow.ts, wired in index.ts) gates a privileged read -- `sudo -n tail
// -F <path>` -- on exactly the same question GET /api/file gates its own
// privileged read on: "did a discovery scan for THIS session actually return
// this path?". That question must have exactly one answer, from exactly one
// structure, seeded and pruned in exactly one place. It previously had two
// (a token-keyed map here, an unseeded Set on ManagedSession), and the
// second one -- the one the socket actually consulted -- was never written
// to by anything, so every file follow was refused. Two sources of truth for
// an authorization decision is how the next hole gets made; there is now one.
export interface BuiltRoutes {
  routes: Route<Handler>[];
  // True when `path` is in the allowlist THIS routes instance seeded for
  // THIS token -- never a global "is this path known to anyone" answer, or
  // session A's discovery would authorize session B's read.
  isLogPathAllowed(token: string, path: string): boolean;
}

export function buildRoutes(deps: RouteDeps): BuiltRoutes {
  // Paths a vhost listing OR a log discovery scan has actually returned to
  // this session, keyed by token. GET /api/file is the vhost "View"
  // button's config-file reader (and, since Task 4, the log tab's static
  // file reader) — not a general file browser. The token authenticates the
  // page, it does not authorise arbitrary filesystem reads, and this
  // endpoint runs sudo. Restricting reads to exactly what a vhost listing
  // or a log discovery scan surfaced for that session (populated in the
  // /api/webserver/:kind/vhosts and /api/logs handlers below) is what keeps
  // an authenticated browser tab from being able to ask for any
  // root-readable file on the host.
  //
  // Neither source's own listing is trusted as authoritative on its own:
  // the vhost listing's section keys are parsed out of a stream that also
  // carries the config files' raw bytes, so file CONTENT can forge one —
  // every path from it is intersected against the hard-coded globs
  // configFilesCommand expanded (isConfigFilePath) before it lands here.
  // Log discovery lists filenames only (find + stat), never a file's
  // content, but a filename can still forge a *second* discovery line via
  // an embedded newline+tab (see the "Newline-in-filename hazard" comment
  // on logDiscoveryCommand in ops/command.ts) — every path from it is
  // therefore independently re-checked against isLogFilePath here too,
  // rather than trusting that parseLogDiscovery already did so. The set
  // below can only ever contain paths that are either a real config file
  // under those globs, or a real file under /var/log.
  const allowedFiles = new Map<string, Set<string>>();

  function allowFiles(token: string, paths: string[]): void {
    let set = allowedFiles.get(token);
    if (!set) {
      set = new Set<string>();
      allowedFiles.set(token, set);
    }
    paths.forEach(p => set!.add(p));
  }

  // Not exploitable on its own -- tokens are crypto.randomBytes(32), so a
  // disposed token's set can never be revived by a later session reusing
  // it -- but without this, allowedFiles retains every path ever
  // discovered for every session opened in this extension host's
  // lifetime, unbounded. /api/logs makes that materially bigger than the
  // handful of /etc paths a vhost listing seeded: it adds every regular
  // file under /var/log to depth 3, per scan, per refresh. Pruning on
  // disposal keeps the map's size bounded by "sessions currently open",
  // not "sessions ever opened".
  deps.onTokenDisposed?.(token => {
    allowedFiles.delete(token);
  });

  // The /ws/logs half of the same gate GET /api/file applies below. Same
  // map, same token key, same lifetime -- the only difference is the extra
  // isLogFilePath intersection: allowedFiles also holds the /etc config
  // paths a vhost listing seeded, and a `tail -F /etc/nginx/nginx.conf` is
  // not something a log follow may ever open just because the Web server tab
  // was visited first. logFollow.ts re-checks isLogFilePath itself as well;
  // both checks are deliberate, and neither is the other's excuse.
  function isLogPathAllowed(token: string, path: string): boolean {
    const allowed = allowedFiles.get(token);
    return Boolean(path) && Boolean(allowed) && allowed!.has(path) && isLogFilePath(path);
  }

  const routes: Route<Handler>[] = [
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
        // No sudo in servicesCommand() -- read it over the session's own lane.
        const ops = readOpsFor(session);
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
        // `systemctl status` carries no sudo either.
        const ops = readOpsFor(session);
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
        // Detection is `command -v` and `systemctl is-active`: no sudo.
        const ops = readOpsFor(session);
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
        // Section keys are NOT trustworthy path names. configFilesCommand
        // frames its output as `printf '@@$f'; cat "$f"`, so every config
        // file's own bytes travel in the same stream as the `@@` markers
        // that delimit them: a line beginning `@@/etc/shadow` inside any
        // file under the globbed directories is, to splitAt, exactly a real
        // marker. Intersecting against the same hard-coded globs the
        // command expanded is what keeps remote file CONTENT from seeding
        // the allowlist below (and, with it, a privileged read of any path
        // the content names). Filtering here rather than only at allowFiles
        // also keeps a forged marker from appearing as a phantom vhost row.
        const configFiles = Object.keys(sections).filter(file => isConfigFilePath(kind, file));
        const files = configFiles.map(file => ({ file, content: sections[file] }));
        allowFiles(session.token, configFiles);

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
      path: '/api/logs',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        // logDiscoveryCommand carries `sudo -n` (it stats files an
        // unprivileged user may not be able to), so this is opsFor, the
        // privileged lane, not readOpsFor.
        const ops = opsFor(session);
        const result = await runPrivileged(ops, 'discover logs', logDiscoveryCommand());
        const { files, units } = parseLogDiscovery(result.stdout);

        // parseLogDiscovery (ops/logs.ts) already applies isLogFilePath to
        // every candidate path, but that parser's own filtering is not
        // trusted as authoritative here -- the same discipline
        // /api/webserver/:kind/vhosts applies to isConfigFilePath. Re-check
        // at the point this feeds the allowlist a privileged read is gated
        // on, so a future change to the parser can't silently widen it.
        const safeFiles = files.filter(file => isLogFilePath(file.path));
        // journalctl's own output is not caller-supplied, but it is
        // remote-reported text this process did not generate -- validated
        // with the existing isSafeUnitName (see ops/command.ts), never a
        // new validator, before it is surfaced to the client at all.
        const safeUnits = units.filter(isSafeUnitName);

        allowFiles(session.token, safeFiles.map(file => file.path));

        ctx.json(200, { files: safeFiles, units: safeUnits });
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
          ctx.text(403, 'That file was not returned by a vhost listing or a log discovery scan for this session.');
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
    {
      method: 'GET',
      path: '/api/cloudflare/zone',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        // A profile without both CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN
        // must behave as if this route does not exist -- 404, not a 500 or a
        // hang against an empty zone id.
        if (!hasCloudflare(session.cloudflareConfig)) {
          ctx.text(404, 'Cloudflare is not configured for this profile.');
          return;
        }
        const zoneId = session.cloudflareConfig.CLOUDFLARE_ZONE_ID!;
        const token = session.cloudflareConfig.CLOUDFLARE_API_TOKEN!;
        const result = await runCloudflare(session, 'read cloudflare zone', zoneId, () =>
          zoneInfo(deps.cloudflare!, zoneId, token)
        );
        if (!result.ok) {
          // 502: Cloudflare (the upstream) failed, not this server. The
          // message is already the mapped, token-safe text runCloudflare
          // relayed from cloudflareError -- never Cloudflare's raw body.
          ctx.text(502, result.message);
          return;
        }
        ctx.json(200, result.value);
      },
    },
    {
      method: 'POST',
      path: '/api/cloudflare/purge',
      handler: async ctx => {
        const session = resolve(deps, ctx);
        if (!session) {
          return;
        }
        if (!hasCloudflare(session.cloudflareConfig)) {
          ctx.text(404, 'Cloudflare is not configured for this profile.');
          return;
        }
        const zoneId = session.cloudflareConfig.CLOUDFLARE_ZONE_ID!;
        const token = session.cloudflareConfig.CLOUDFLARE_API_TOKEN!;
        const result = await runCloudflare(session, 'purge cloudflare cache', zoneId, () =>
          purgeEverything(deps.cloudflare!, zoneId, token)
        );
        if (!result.ok) {
          ctx.text(502, result.message);
          return;
        }
        ctx.json(200, result.value);
      },
    },
  ];

  return { routes, isLogPathAllowed };
}
