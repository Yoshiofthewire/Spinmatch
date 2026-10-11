import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { parseOidcEnv } = await import('../src/config.js');

const FULL = {
  OIDC_ISSUER: 'https://idp.example/realms/home',
  OIDC_CLIENT_ID: 'spinmatch',
  OIDC_CLIENT_SECRET: 's3cret',
  OIDC_REDIRECT_URI: 'https://spinmatch.example/api/auth/oidc/callback',
};

test('OIDC is off when nothing is set', () => {
  assert.equal(parseOidcEnv({}), null);
});

test('a full config parses', () => {
  assert.deepEqual(parseOidcEnv({ ...FULL, OIDC_ONLY: '1', OIDC_POST_LOGOUT_URI: 'https://spinmatch.example/' }), {
    issuer: FULL.OIDC_ISSUER,
    clientId: 'spinmatch',
    clientSecret: 's3cret',
    redirectUri: FULL.OIDC_REDIRECT_URI,
    postLogoutUri: 'https://spinmatch.example/',
    only: true,
  });
});

test('each missing required variable is named', () => {
  for (const key of Object.keys(FULL)) {
    const env = { ...FULL };
    delete env[key];
    assert.throws(() => parseOidcEnv(env), new RegExp(`partly configured.*${key}`));
  }
});

test('OIDC_ONLY or a post-logout URI alone is refused', () => {
  assert.throws(() => parseOidcEnv({ OIDC_ONLY: '1' }), /OIDC_ONLY/);
  assert.throws(() => parseOidcEnv({ OIDC_POST_LOGOUT_URI: 'https://x.example/' }), /OIDC_POST_LOGOUT_URI/);
  assert.throws(() => parseOidcEnv({ ...FULL, OIDC_ONLY: 'yes' }), /OIDC_ONLY must be 1/);
});

test('plain http is allowed only for loopback', () => {
  for (const key of ['OIDC_ISSUER', 'OIDC_REDIRECT_URI', 'OIDC_POST_LOGOUT_URI']) {
    assert.throws(() => parseOidcEnv({ ...FULL, [key]: 'http://idp.example/' }), new RegExp(`${key} must use https`));
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.ok(parseOidcEnv({ ...FULL, OIDC_ISSUER: `http://${host}:9000`, OIDC_REDIRECT_URI: `http://${host}:3000/cb` }));
  }
  assert.throws(() => parseOidcEnv({ ...FULL, OIDC_ISSUER: 'http://localhost.evil.example' }), /must use https/);
  assert.throws(() => parseOidcEnv({ ...FULL, OIDC_ISSUER: 'https://u:p@idp.example' }), /credentials/);
  assert.throws(() => parseOidcEnv({ ...FULL, OIDC_ISSUER: 'not a url' }), /not a URL/);
});

// The real entry point: config is checked before the database is touched.
function boot(env) {
  const index = fileURLToPath(new URL('../src/index.js', import.meta.url));
  return spawnSync(process.execPath, [index], {
    env: { PATH: process.env.PATH, MB_CONTACT_EMAIL: 'test@example.com', LIBRARY_DB: ':memory:', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('the server refuses to start on a partial OIDC config', () => {
  const run = boot({ OIDC_ISSUER: FULL.OIDC_ISSUER });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing to start: OIDC is partly configured; also set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI/);
});

test('the server refuses to start on an http issuer off loopback', () => {
  const run = boot({ ...FULL, OIDC_ISSUER: 'http://idp.example' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /OIDC_ISSUER must use https/);
});
