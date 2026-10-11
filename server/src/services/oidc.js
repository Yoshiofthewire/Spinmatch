// OIDC sign-in for the single admin, mirroring ky-primitives oidcverify on top of
// openid-client. openid-client checks iss, aud membership, exp, nbf, nonce, state, PKCE and
// (with non-repudiation on) the RS256 signature; the rest is checked here.
import * as client from 'openid-client';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { config, secureUrlError } from '../config.js';
import { withTransaction } from '../lib/db.js';
import { revokeSessions } from './auth.js';

export const PENDING_TTL_MS = 5 * 60 * 1000;
const LEEWAY_S = 60;
const MAX_LOGOUT_AGE_S = 5 * 60;
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const ENDPOINTS = [
  'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint', 'end_session_endpoint',
];

// The browser sees only this code; the reason goes to the server log.
export class SsoError extends Error {
  constructor(code, reason) {
    super(reason || code);
    this.name = 'SsoError';
    this.code = code;
  }
}

export function oidcEnabled() {
  return Boolean(config.oidc);
}

// Keyed on the settings object, so replacing config.oidc re-runs discovery.
let cached = null;

export function discover() {
  const settings = config.oidc;
  if (cached?.settings === settings) return cached.promise;
  const promise = (async () => {
    const cfg = await client.discovery(
      new URL(settings.issuer),
      settings.clientId,
      // RS256 only: refuses none, HS* (keyed with the public client secret) and the rest.
      { id_token_signed_response_alg: 'RS256', [client.clockTolerance]: LEEWAY_S },
      client.ClientSecretBasic(settings.clientSecret),
      // secureUrlError already limited plain http to loopback.
      { execute: new URL(settings.issuer).protocol === 'http:' ? [client.allowInsecureRequests] : [], timeout: 10 },
    );
    const meta = cfg.serverMetadata();
    // openid-client compares URL-normalised forms; ID token iss checks need the exact string.
    if (meta.issuer !== settings.issuer) throw new Error(`discovered issuer ${meta.issuer} is not OIDC_ISSUER`);
    for (const key of ENDPOINTS) {
      const error = meta[key] && secureUrlError(meta[key]);
      if (error) throw new Error(`discovered ${key} ${error}`);
    }
    // Code-flow ID tokens are otherwise trusted on TLS alone; verify the signature too.
    client.enableNonRepudiationChecks(cfg);
    // jose fetches with redirect: 'manual', as openid-client does, so neither follows redirects.
    const jwks = createRemoteJWKSet(new URL(meta.jwks_uri), { timeoutDuration: 10_000 });
    return { cfg, meta, jwks };
  })();
  cached = { settings, promise };
  // Don't pin a failure: the next request retries discovery.
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}

// ---- Pending round trips (single-use rows behind an HttpOnly cookie) ----

export async function startFlow(db, purpose) {
  const { cfg } = await discover();
  const row = {
    id: randomBytes(32).toString('base64url'),
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier: client.randomPKCECodeVerifier(),
  };
  const now = Date.now();
  db.prepare('DELETE FROM oidc_pending WHERE created_at <= ?').run(now - PENDING_TTL_MS);
  db.prepare(
    'INSERT INTO oidc_pending (id, state, nonce, code_verifier, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.state, row.nonce, row.verifier, purpose, now);
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile email',
    code_challenge: await client.calculatePKCECodeChallenge(row.verifier),
    code_challenge_method: 'S256',
    state: row.state,
    nonce: row.nonce,
  });
  return { pendingId: row.id, url: url.href };
}

// Deleted before any check, so a failed or replayed callback can't retry the row.
export function takePending(db, id) {
  if (typeof id !== 'string' || !id) return null;
  const row = db.prepare('DELETE FROM oidc_pending WHERE id = ? RETURNING *').get(id);
  if (!row || row.created_at <= Date.now() - PENDING_TTL_MS) return null;
  return row;
}

// `search` is the callback's raw query; the URL base is config, never the Host header.
export async function finishFlow(pending, search) {
  const { cfg, meta } = await discover();
  const currentUrl = new URL(config.oidc.redirectUri);
  currentUrl.search = search;
  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
      pkceCodeVerifier: pending.code_verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
  } catch (err) {
    throw new SsoError(err.name === 'AuthorizationResponseError' ? 'denied' : 'failed', describe(err));
  }
  return checkIdToken(meta, tokens.id_token, tokens.claims());
}

// Only fields that carry no token or code: names, codes, and the libraries' fixed messages.
export function describe(err) {
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return [err.name, err.code, err.error, err.message].filter(Boolean).join(': ') + cause;
}

// Rules openid-client doesn't enforce (oidcverify verifyJWT/VerifyWithNonce).
function checkIdToken(meta, idToken, claims) {
  const fail = (reason) => { throw new SsoError('failed', `ID token rejected: ${reason}`); };
  const { typ } = decodeProtectedHeader(idToken);
  if (typ !== undefined && typ !== 'JWT' && typ !== 'at+jwt') fail(`typ ${typ}`);
  // A logout token's mark; it must never authenticate.
  if ('events' in claims) fail('events claim');
  // One audience: a token minted for several clients is replayable by any of them.
  const aud = [claims.aud].flat();
  if (aud.length !== 1 || aud[0] !== config.oidc.clientId) fail('audience');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + LEEWAY_S) fail('iat in the future');
  if (typeof claims.sub !== 'string' || !claims.sub) fail('no sub');
  // Without sid, a session-scoped back-channel logout could never reach this login.
  if (meta.backchannel_logout_session_supported && (typeof claims.sid !== 'string' || !claims.sid)) fail('no sid');
  if (claims.auth_time !== undefined && claims.auth_time > claims.iat + LEEWAY_S) fail('auth_time after iat');
  return { iss: claims.iss, sub: claims.sub };
}

// ---- Account link (issuer + sub on the admin row) ----

export function getLink(db) {
  const row = db.prepare('SELECT oidc_issuer, oidc_sub FROM app_auth WHERE id = 1').get();
  return row?.oidc_sub ? { issuer: row.oidc_issuer, sub: row.oidc_sub } : null;
}

export function setLink(db, link) {
  db.prepare('UPDATE app_auth SET oidc_issuer = ?, oidc_sub = ? WHERE id = 1')
    .run(link?.iss ?? null, link?.sub ?? null);
}

// Exact (iss, sub) only; email and username are never trusted for identity.
export function isLinked(db, { iss, sub }) {
  const link = getLink(db);
  return Boolean(link && link.issuer === iss && link.sub === sub);
}

// Refused only once an identity is linked, so OIDC_ONLY can't lock out a fresh install.
export function passwordLoginBlocked(db) {
  return Boolean(config.oidc?.only && getLink(db));
}

// ---- RP-initiated logout ----

export async function endSessionUrl(db) {
  if (!oidcEnabled() || !getLink(db)) return null;
  const { cfg, meta } = await discover();
  if (!meta.end_session_endpoint) return null;
  const params = config.oidc.postLogoutUri ? { post_logout_redirect_uri: config.oidc.postLogoutUri } : {};
  return client.buildEndSessionUrl(cfg, params).href;
}

// ---- Back-channel logout (OIDC Back-Channel Logout 1.0; oidcverify VerifyLogout) ----

export async function verifyLogoutToken(token) {
  const { jwks } = await discover();
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ['RS256'],
    typ: 'logout+jwt',
    issuer: config.oidc.issuer,
    audience: config.oidc.clientId,
    clockTolerance: LEEWAY_S,
    maxTokenAge: MAX_LOGOUT_AGE_S,
    requiredClaims: ['iat', 'exp', 'jti'],
  });
  const fail = (reason) => { throw new SsoError('failed', `logout token rejected: ${reason}`); };
  const aud = [payload.aud].flat();
  if (aud.length !== 1) fail('audience');
  // A nonce marks an ID token; token_use marks an access token.
  if ('nonce' in payload || 'token_use' in payload) fail('nonce or token_use');
  const event = payload.events?.[LOGOUT_EVENT];
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('events');
  for (const name of ['sub', 'sid', 'jti']) {
    if (name in payload && (typeof payload[name] !== 'string' || !payload[name])) fail(name);
  }
  if (!payload.sub && !payload.sid) fail('no sub or sid');
  if (payload.exp <= payload.iat) fail('exp not after iat');
  // The token stops being acceptable at the earlier of exp and the age cap, plus leeway.
  const replayUntil = (Math.min(payload.exp, payload.iat + MAX_LOGOUT_AGE_S) + LEEWAY_S) * 1000;
  return { jti: payload.jti, sub: payload.sub, sid: payload.sid, replayUntil };
}

// Records the jti and signs out everywhere in one transaction; false on a replay.
export function applyLogout(db, { jti, replayUntil }) {
  return withTransaction(db, () => {
    db.prepare('DELETE FROM oidc_logout_replay WHERE expires_at < ?').run(Date.now());
    const { changes } = db.prepare(
      'INSERT INTO oidc_logout_replay (jti, expires_at) VALUES (?, ?) ON CONFLICT(jti) DO NOTHING',
    ).run(jti, replayUntil);
    if (!changes) return false;
    revokeSessions(db);
    return true;
  }, 'IMMEDIATE');
}

// The logout must name the linked identity; sid alone can only end that same identity.
export function logoutMatchesLink(db, { sub }) {
  const link = getLink(db);
  return Boolean(link && link.issuer === config.oidc.issuer && (sub === undefined || sub === link.sub));
}
