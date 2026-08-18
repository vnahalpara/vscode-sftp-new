import { privilegedConfig } from '../index';

test('prefers root credentials when both are present', () => {
  const out = privilegedConfig({
    host: 'h', username: 'magento', password: 'p',
    root_user: 'root', root_password: 'r',
  });
  expect(out.username).toBe('root');
  expect(out.password).toBe('r');
});

test('falls back to the session user when root credentials are absent', () => {
  const out = privilegedConfig({ host: 'h', username: 'magento', password: 'p' });
  expect(out.username).toBe('magento');
  expect(out.password).toBe('p');
});

test('requires BOTH root fields before switching', () => {
  const a = privilegedConfig({ username: 'u', password: 'p', root_user: 'root' });
  const b = privilegedConfig({ username: 'u', password: 'p', root_password: 'r' });
  expect(a.username).toBe('u');
  expect(b.username).toBe('u');
});

test('drops key-based auth when switching to root password auth', () => {
  const out = privilegedConfig({
    username: 'u', password: 'p', privateKeyPath: '/k', agent: '/a',
    root_user: 'root', root_password: 'r',
  });
  expect(out.privateKeyPath).toBeUndefined();
  expect(out.agent).toBeUndefined();
});

test('returns a copy, never mutating the caller config', () => {
  const config: any = { username: 'u', password: 'p', root_user: 'root', root_password: 'r' };
  privilegedConfig(config);
  expect(config.username).toBe('u');
});
