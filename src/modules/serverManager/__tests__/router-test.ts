import { matchRoute, Route } from '../router';

const ROUTES: Route<string>[] = [
  { method: 'GET', path: '/api/session', handler: 'session' },
  { method: 'GET', path: '/api/host', handler: 'host' },
  { method: 'POST', path: '/api/host/refresh', handler: 'refresh' },
  { method: 'POST', path: '/api/services/:unit/:action', handler: 'service' },
];

describe('matchRoute', () => {
  it('matches an exact path', () => {
    const m = matchRoute(ROUTES, 'GET', '/api/session');
    expect(m && m.handler).toBe('session');
    expect(m && m.params).toEqual({});
  });

  it('captures named parameters', () => {
    const m = matchRoute(ROUTES, 'POST', '/api/services/nginx/restart');
    expect(m && m.handler).toBe('service');
    expect(m && m.params).toEqual({ unit: 'nginx', action: 'restart' });
  });

  it('percent-decodes captured parameters', () => {
    const m = matchRoute(ROUTES, 'POST', '/api/services/php8.2-fpm%40www/restart');
    expect(m && m.params.unit).toBe('php8.2-fpm@www');
  });

  it('does not match on the wrong method', () => {
    expect(matchRoute(ROUTES, 'POST', '/api/session')).toBeNull();
  });

  it('does not match a longer or shorter path', () => {
    expect(matchRoute(ROUTES, 'GET', '/api/session/extra')).toBeNull();
    expect(matchRoute(ROUTES, 'GET', '/api')).toBeNull();
  });

  it('ignores a trailing slash', () => {
    const m = matchRoute(ROUTES, 'GET', '/api/session/');
    expect(m && m.handler).toBe('session');
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute(ROUTES, 'GET', '/api/nope')).toBeNull();
  });

  it('prefers the first matching route when two could match', () => {
    // A literal segment declared before a parameter wins, which is what lets
    // /api/host/refresh coexist with a future /api/host/:field.
    const routes: Route<string>[] = [
      { method: 'GET', path: '/api/host/refresh', handler: 'literal' },
      { method: 'GET', path: '/api/host/:field', handler: 'param' },
    ];
    const m = matchRoute(routes, 'GET', '/api/host/refresh');
    expect(m && m.handler).toBe('literal');
  });
});
