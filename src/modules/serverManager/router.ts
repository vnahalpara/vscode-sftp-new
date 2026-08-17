export interface RouteParams {
  [name: string]: string;
}

export interface Route<H> {
  method: string;
  path: string;
  handler: H;
}

export interface RouteMatch<H> {
  handler: H;
  params: RouteParams;
}

// Filtering empties is what makes '/api/session' and '/api/session/' the same
// route, and it costs nothing.
function segments(pathname: string): string[] {
  return pathname.split('/').filter(part => part.length > 0);
}

// Routes are tried in declaration order, so a literal segment listed before a
// parameter always wins over it.
export function matchRoute<H>(
  routes: Route<H>[],
  method: string,
  pathname: string
): RouteMatch<H> | null {
  const want = segments(pathname);

  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const have = segments(route.path);
    if (have.length !== want.length) {
      continue;
    }

    const params: RouteParams = {};
    let matched = true;
    for (let i = 0; i < have.length; i++) {
      const declared = have[i];
      if (declared.charAt(0) === ':') {
        params[declared.slice(1)] = decodeURIComponent(want[i]);
      } else if (declared !== want[i]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { handler: route.handler, params };
    }
  }

  return null;
}
