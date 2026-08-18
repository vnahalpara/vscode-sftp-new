import { privilegedConfig, hasRootLane, privilegedIdentity } from '../index';

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

test('drops passphrase and interactiveAuth alongside the key fields', () => {
  // passphrase: true pops a dialog unconditionally (sshClient.ts prompts
  // whenever passphrase === true, without checking a key is present), and a
  // left-behind interactiveAuth would replay the session user's own answers
  // -- or an unlabelled prompt inviting the user to type them -- into root's
  // keyboard-interactive auth. Both must go with the deleted key.
  const out = privilegedConfig({
    username: 'u', password: 'p', passphrase: true, interactiveAuth: ['session-secret'],
    root_user: 'root', root_password: 'r',
  });
  expect(out.passphrase).toBeUndefined();
  expect(out.interactiveAuth).toBeUndefined();
});

describe('hop-aware target selection', () => {
  test('no hop: behaves exactly as the flat case (regression)', () => {
    const out = privilegedConfig({
      host: 'target', username: 'magento', password: 'p',
      root_user: 'root', root_password: 'r',
    });
    expect(out.username).toBe('root');
    expect(out.password).toBe('r');
    expect(out.hop).toBeUndefined();
  });

  test('object hop: the swap lands on the hop (the real destination), never on the top-level jump host', () => {
    // Top level = bastion; hop = target. root_user/root_password describe
    // the target's root account and must never reach the bastion's fields.
    const config = {
      host: 'bastion', username: 'bastionUser', password: 'bastionPass', privateKeyPath: '/bastion/key',
      hop: {
        host: 'target', username: 'targetUser', password: 'targetPass', privateKeyPath: '/target/key',
        root_user: 'root', root_password: 'r',
      },
    };
    const out = privilegedConfig(config);

    // Bastion (top-level) fields are completely untouched.
    expect(out.username).toBe('bastionUser');
    expect(out.password).toBe('bastionPass');
    expect(out.privateKeyPath).toBe('/bastion/key');

    // The target's own fields carry the swap.
    expect(out.hop.username).toBe('root');
    expect(out.hop.password).toBe('r');
    expect(out.hop.privateKeyPath).toBeUndefined();
  });

  test('array hop (multi-hop): only the innermost (last) hop is swapped', () => {
    // local -> hopA -> hopB -> target. root_user/root_password live on the
    // target, the last element of the array.
    const config = {
      host: 'hopA', username: 'hopAUser', password: 'hopAPass',
      hop: [
        { host: 'hopB', username: 'hopBUser', password: 'hopBPass', privateKeyPath: '/hopb/key' },
        { host: 'target', username: 'targetUser', password: 'targetPass', privateKeyPath: '/target/key',
          root_user: 'root', root_password: 'r' },
      ],
    };
    const out = privilegedConfig(config);

    // Top-level jump host: untouched.
    expect(out.username).toBe('hopAUser');
    expect(out.password).toBe('hopAPass');

    // Middle hop: untouched.
    expect(out.hop[0].username).toBe('hopBUser');
    expect(out.hop[0].password).toBe('hopBPass');
    expect(out.hop[0].privateKeyPath).toBe('/hopb/key');

    // Innermost hop (the actual target): swapped.
    expect(out.hop[1].username).toBe('root');
    expect(out.hop[1].password).toBe('r');
    expect(out.hop[1].privateKeyPath).toBeUndefined();
  });

  test('root credentials on the top level are ignored when a hop is configured', () => {
    // A profile that mistakenly (or legacy-ly) carries root_user/root_password
    // on the jump host, not the target, must not swap the bastion's own
    // credentials -- there is nothing for a bastion root lane to do here.
    const config = {
      host: 'bastion', username: 'bastionUser', password: 'bastionPass',
      root_user: 'root', root_password: 'r',
      hop: { host: 'target', username: 'targetUser', password: 'targetPass' },
    };
    const out = privilegedConfig(config);
    expect(out.username).toBe('bastionUser');
    expect(out.password).toBe('bastionPass');
    expect(out.hop.username).toBe('targetUser');
    expect(out.hop.password).toBe('targetPass');
  });

  test('returns a copy, never mutating the caller config or its nested hop', () => {
    const hop = { host: 'target', username: 'targetUser', password: 'targetPass', root_user: 'root', root_password: 'r' };
    const config: any = { host: 'bastion', username: 'bastionUser', password: 'bastionPass', hop };
    privilegedConfig(config);

    expect(config.hop).toBe(hop);
    expect(hop.username).toBe('targetUser');
    expect(hop.password).toBe('targetPass');
  });

  test('returns a copy, never mutating the caller config or its nested hop array', () => {
    const target = { host: 'target', username: 'targetUser', password: 'targetPass', root_user: 'root', root_password: 'r' };
    const middle = { host: 'hopB', username: 'hopBUser', password: 'hopBPass' };
    const config: any = { host: 'hopA', username: 'hopAUser', password: 'hopAPass', hop: [middle, target] };
    privilegedConfig(config);

    expect(config.hop[0]).toBe(middle);
    expect(config.hop[1]).toBe(target);
    expect(target.username).toBe('targetUser');
    expect(target.password).toBe('targetPass');
  });
});

describe('hasRootLane', () => {
  test('false with no root credentials', () => {
    expect(hasRootLane({ host: 'h', username: 'u', password: 'p' })).toBe(false);
  });

  test('true with both root credentials at the top level', () => {
    expect(hasRootLane({ username: 'u', password: 'p', root_user: 'root', root_password: 'r' })).toBe(true);
  });

  test('reads root credentials off the hop, not the top level, when a hop is configured', () => {
    const config = {
      host: 'bastion', username: 'u', password: 'p',
      hop: { host: 'target', username: 'tu', password: 'tp', root_user: 'root', root_password: 'r' },
    };
    expect(hasRootLane(config)).toBe(true);
  });

  test('ignores top-level root credentials when a hop is configured', () => {
    const config = {
      host: 'bastion', username: 'u', password: 'p', root_user: 'root', root_password: 'r',
      hop: { host: 'target', username: 'tu', password: 'tp' },
    };
    expect(hasRootLane(config)).toBe(false);
  });
});

describe('privilegedIdentity', () => {
  test('is stable for the session lane (no root credentials)', () => {
    const a = privilegedIdentity({ username: 'u', password: 'p' });
    const b = privilegedIdentity({ username: 'u', password: 'p2' });
    expect(a).toBe(b);
  });

  test('changes when root credentials are added', () => {
    const before = privilegedIdentity({ username: 'u', password: 'p' });
    const after = privilegedIdentity({ username: 'u', password: 'p', root_user: 'root', root_password: 'r' });
    expect(after).not.toBe(before);
  });

  test('changes when root credentials are edited', () => {
    const a = privilegedIdentity({ username: 'u', password: 'p', root_user: 'root', root_password: 'r1' });
    const b = privilegedIdentity({ username: 'u', password: 'p', root_user: 'root', root_password: 'r2' });
    expect(a).not.toBe(b);
  });

  test('changes when root credentials are removed', () => {
    const withRoot = privilegedIdentity({ username: 'u', password: 'p', root_user: 'root', root_password: 'r' });
    const withoutRoot = privilegedIdentity({ username: 'u', password: 'p' });
    expect(withRoot).not.toBe(withoutRoot);
  });

  test('is hop-aware, matching hasRootLane/privilegedConfig', () => {
    const config = {
      host: 'bastion', username: 'u', password: 'p',
      hop: { host: 'target', username: 'tu', password: 'tp', root_user: 'root', root_password: 'r' },
    };
    const sessionIdentity = privilegedIdentity({ host: 'bastion', username: 'u', password: 'p', hop: { host: 'target', username: 'tu', password: 'tp' } });
    expect(privilegedIdentity(config)).not.toBe(sessionIdentity);
  });
});
