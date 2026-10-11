// In-process OIDC provider for tests: discovery, JWKS, authorize, token. Each ID token
// passes through `idp.mutate(header, claims)` so a test can tamper with it.
import http from 'node:http';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const b64u = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function rsaKey(modulusLength = 2048) {
  return generateKeyPairSync('rsa', { modulusLength });
}

export function jwk(pair, kid) {
  return { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

// Signs by header.alg: RS256 with `key`, HS256 with `secret`, none unsigned.
export function mint(header, claims, { key, secret } = {}) {
  const data = `${b64u(header)}.${b64u(claims)}`;
  if (header.alg === 'none') return `${data}.`;
  if (header.alg === 'HS256') return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
  return `${data}.${sign('sha256', Buffer.from(data), key).toString('base64url')}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(new URLSearchParams(body)));
  });
}

export async function startMockIdp({ clientId, clientSecret }) {
  const pair = rsaKey();
  const idp = {
    clientId,
    clientSecret,
    key: pair.privateKey,
    kid: 'k1',
    keys: [jwk(pair, 'k1')],
    sub: 'user-1',
    sid: 'idp-session-1',
    metadata: {}, // merged over discovery
    redirectDiscovery: false,
    mutate: null, // (header, claims) => void, for the next ID token
    signWith: null, // { key } | { secret } replacing the default signer
    authorizeRequests: [],
    tokenRequests: 0,
  };
  const codes = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idp.issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      if (idp.redirectDiscovery) {
        res.writeHead(302, { Location: `${idp.issuer}/elsewhere` });
        return res.end();
      }
      return json(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        end_session_endpoint: `${idp.issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
        ...idp.metadata,
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: idp.keys });
    if (url.pathname === '/authorize') {
      const p = Object.fromEntries(url.searchParams);
      idp.authorizeRequests.push(p);
      const back = new URL(p.redirect_uri);
      if (idp.denyNext) {
        idp.denyNext = false;
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', '<script>alert(1)</script> code=SECRET');
      } else {
        const code = randomBytes(16).toString('hex');
        codes.set(code, p);
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', p.state);
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      idp.tokenRequests += 1;
      const form = await readBody(req);
      // RFC 6749 2.3.1: each half form-urlencoded before base64.
      const [id, secret] = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64')
        .toString().split(':').map((part) => decodeURIComponent(part.replace(/\+/g, ' ')));
      const auth = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (id !== clientId || secret !== clientSecret || !auth || auth.redirect_uri !== form.get('redirect_uri')
        || auth.code_challenge_method !== 'S256' || auth.code_challenge !== challenge) {
        return json(400, { error: 'invalid_grant' });
      }
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', kid: idp.kid, typ: 'JWT' };
      const claims = {
        iss: idp.issuer, sub: idp.sub, aud: clientId, iat: now, exp: now + 300,
        auth_time: now, nonce: auth.nonce, sid: idp.sid,
      };
      idp.mutate?.(header, claims);
      idp.mutate = null;
      const signer = idp.signWith || { key: idp.key };
      idp.signWith = null;
      return json(200, {
        access_token: 'opaque-access', token_type: 'Bearer', expires_in: 300, id_token: mint(header, claims, signer),
      });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  idp.issuer = `http://127.0.0.1:${server.address().port}`;
  idp.close = () => new Promise((resolve) => server.close(resolve));

  // A valid back-channel logout token; `mutate` tampers as for ID tokens.
  idp.logoutToken = (mutate, signer = { key: idp.key, secret: clientSecret }) => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: idp.kid, typ: 'logout+jwt' };
    const claims = {
      iss: idp.issuer, aud: clientId, iat: now, exp: now + 120, jti: randomBytes(8).toString('hex'),
      sub: idp.sub, sid: idp.sid, events: { [LOGOUT_EVENT]: {} },
    };
    mutate?.(header, claims);
    return mint(header, claims, signer);
  };
  return idp;
}
