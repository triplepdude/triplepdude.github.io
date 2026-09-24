const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tokens are built and signed here with Node's crypto module, independently of the page.
const b64u = b => Buffer.from(b).toString('base64url');
function makeToken(header, payload, sign) {
  const input = b64u(typeof header === 'string' ? header : JSON.stringify(header)) + '.' + b64u(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return input + '.' + b64u(sign(Buffer.from(input)));
}
const hmac = (hash, secret) => data => crypto.createHmac(hash, secret).update(data).digest();

const JWT_IO = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

module.exports = async ({ page, open, assert, fixtures, url }) => {
  await open();
  const text = sel => page.locator(sel).textContent();
  const now = Math.floor(Date.now() / 1000);

  async function expectVerify(re, label) {
    await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#jwt-verify').textContent), re.source, { timeout: 5000 }).catch(() => {});
    assert.match(await text('#jwt-verify'), re, label);
  }
  const verified = label => expectVerify(/^Signature verified/, label).then(async () => {
    assert.match(await page.getAttribute('#jwt-verify', 'class'), /\bok\b/, label);
    assert.equal(await text('#jwt-sig-badge'), 'Signature verified', label);
  });
  const invalid = label => expectVerify(/^Invalid signature/, label).then(async () => {
    assert.match(await page.getAttribute('#jwt-verify', 'class'), /\berror\b/, label);
  });

  // On load: an example token, decoded and verified with its example secret.
  assert.equal(await text('#jwt-header'), '{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
  assert.match(await text('#jwt-payload'), /"name": "Jane Doe"/);
  await verified('example on load');
  assert.match(await text('#jwt-time-badge'), /^Valid now, expires in/);
  assert.equal(await text('#jwt-alg-badge'), 'HS256 · HMAC with SHA-256');

  // The jwt.io example. First re-derive its signature independently.
  const [h, p, s] = JWT_IO.split('.');
  assert.equal(b64u(hmac('sha256', 'your-256-bit-secret')(Buffer.from(h + '.' + p))), s, 'jwt.io fixture signature');
  await page.fill('#jwt-token', JWT_IO);
  assert.equal(await page.inputValue('#jwt-secret'), '', 'example secret is cleared for a new token');
  await expectVerify(/Enter the secret/, 'asks for a secret');
  assert.equal(await text('#jwt-sig-badge'), 'Signature not checked');
  assert.equal(await text('#jwt-payload'), '{\n  "sub": "1234567890",\n  "name": "John Doe",\n  "iat": 1516239022\n}');
  // python: datetime.fromtimestamp(1516239022, timezone.utc) -> 2018-01-18 01:30:22+00:00
  assert.equal(await text('tr[data-claim="iat"] .jwt-utc'), '2018-01-18 01:30:22 UTC');
  assert.equal(await text('tr[data-claim="sub"] .jwt-raw'), '1234567890');
  assert.equal(await text('#jwt-time-badge'), 'No expiry (exp) claim');
  assert.equal(await page.isVisible('#jwt-secret'), true);
  assert.equal(await page.isVisible('#jwt-key'), false);
  await page.fill('#jwt-secret', 'your-256-bit-secret');
  await verified('jwt.io token');
  assert.match(await text('#jwt-key-note'), /19 bytes.*at least 32 bytes for HS256/);
  await page.fill('#jwt-secret', 'your-256-bit-secreT');
  await invalid('wrong secret');

  // Secret given in Base64 (standard and URL-safe without padding).
  await page.check('#jwt-secret-b64');
  await page.fill('#jwt-secret', Buffer.from('your-256-bit-secret').toString('base64'));
  await verified('base64 secret');
  await page.fill('#jwt-secret', Buffer.from('your-256-bit-secret').toString('base64url'));
  await verified('base64url secret');
  await page.fill('#jwt-secret', 'not*base64');
  await expectVerify(/secret is not valid Base64/, 'bad base64 secret');
  await page.uncheck('#jwt-secret-b64');
  await page.fill('#jwt-secret', 'your-256-bit-secret');
  await verified('back to text secret');

  // Tampered payload with the original signature.
  const tampered = h + '.' + b64u('{"sub":"1234567890","name":"Jane Doe","iat":1516239022}') + '.' + s;
  await page.fill('#jwt-token', tampered);
  await invalid('tampered payload');
  assert.equal(await text('#jwt-sig-badge'), 'Invalid signature');
  // "Bearer" prefix and line breaks are cleaned up.
  await page.fill('#jwt-token', 'Bearer ' + JWT_IO.slice(0, 40) + '\n' + JWT_IO.slice(40));
  await verified('bearer prefix');

  // HS384 / HS512 with properly sized secrets: no weak-secret note.
  const s48 = 'k'.repeat(48), s64 = 'm'.repeat(64);
  await page.fill('#jwt-token', makeToken({ alg: 'HS384', typ: 'JWT' }, { sub: 'x', exp: now + 7200 }, hmac('sha384', s48)));
  await page.fill('#jwt-secret', s48);
  await verified('HS384');
  assert.equal(await text('#jwt-key-note'), '');
  assert.match(await text('#jwt-time-badge'), /^Valid now, expires in 2 hours$/);
  await page.fill('#jwt-token', makeToken({ alg: 'HS512' }, { sub: 'x' }, hmac('sha512', s64)));
  await page.fill('#jwt-secret', s64);
  await verified('HS512');

  // RS256 with a fresh 2048-bit key, verified with SPKI PEM, PKCS#1 PEM, JWK and JWKS.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaOther = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsToken = makeToken({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, { sub: 'rs-user', iat: now - 7200, exp: now - 3600 },
    d => crypto.sign('sha256', d, rsa.privateKey));
  await page.fill('#jwt-token', rsToken);
  assert.equal(await page.isVisible('#jwt-key'), true);
  assert.equal(await page.isVisible('#jwt-secret'), false);
  assert.equal(await text('#jwt-time-badge'), 'Expired 1 hour ago');
  await expectVerify(/Paste the public key/, 'asks for a key');
  await page.fill('#jwt-key', rsa.publicKey.export({ type: 'spki', format: 'pem' }));
  await verified('RS256 SPKI PEM');
  await page.fill('#jwt-key', rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }));
  await verified('RS256 PKCS#1 PEM');
  const jwk = Object.assign(rsa.publicKey.export({ format: 'jwk' }), { kid: 'k1', use: 'sig', alg: 'RS256' });
  await page.fill('#jwt-key', JSON.stringify(jwk, null, 2));
  await verified('RS256 JWK');
  const otherJwk = Object.assign(rsaOther.publicKey.export({ format: 'jwk' }), { kid: 'k0', alg: 'RS256' });
  await page.fill('#jwt-key', JSON.stringify({ keys: [otherJwk, jwk] }));
  await verified('RS256 JWKS by kid');
  assert.match(await text('#jwt-key-note'), /kid "k1".*2 keys/);
  await page.fill('#jwt-key', JSON.stringify({ keys: [otherJwk] }));
  await expectVerify(/No key in this JWKS has the token's kid "k1"/, 'kid missing from JWKS');
  await page.fill('#jwt-key', JSON.stringify(Object.assign({}, jwk, { alg: 'RS512' })));
  await expectVerify(/marked for RS512, but the token uses RS256/, 'jwk alg mismatch');
  await page.fill('#jwt-key', rsaOther.publicKey.export({ type: 'spki', format: 'pem' }));
  await invalid('RS256 wrong key');
  await page.fill('#jwt-key', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await expectVerify(/This is a private key/, 'private key refused');
  await page.fill('#jwt-key', crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }));
  await expectVerify(/EC P-256 key, but RS256 needs an RSA public key/, 'wrong key type');
  await page.fill('#jwt-key', 'hello');
  await expectVerify(/Paste the public key as PEM/, 'garbage key');
  // Tampered RS256 token fails with the right key.
  const [rh, , rsig] = rsToken.split('.');
  await page.fill('#jwt-key', rsa.publicKey.export({ type: 'spki', format: 'pem' }));
  await page.fill('#jwt-token', rh + '.' + b64u(JSON.stringify({ sub: 'admin', exp: now + 3600 })) + '.' + rsig);
  await invalid('RS256 tampered');

  // X.509 certificate (fixture made with Python's cryptography package, token signed by its key).
  const certPem = fs.readFileSync(path.join(fixtures, 'cert.pem'), 'utf8');
  const certToken = fs.readFileSync(path.join(fixtures, 'rs256-cert-token.txt'), 'utf8').trim();
  await page.fill('#jwt-token', certToken);
  await page.fill('#jwt-key', certPem);
  await verified('RS256 with certificate');
  await page.fill('#jwt-key', certPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
  await verified('RS256 with bare base64 certificate');
  await page.fill('#jwt-key', JSON.stringify({ kty: 'RSA', kid: 'cert-1', x5c: [certPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')] }));
  await verified('RS256 with JWK x5c');

  // PS256 (salt length = hash length, RFC 7518 3.5), not valid yet.
  const psToken = makeToken({ alg: 'PS256' }, { sub: 'ps', nbf: now + 3 * 3600, exp: now + 6 * 3600 },
    d => crypto.sign('sha256', d, { key: rsa.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }));
  await page.fill('#jwt-token', psToken);
  await page.fill('#jwt-key', rsa.publicKey.export({ type: 'spki', format: 'pem' }));
  await verified('PS256');
  assert.equal(await text('#jwt-time-badge'), 'Not yet valid: starts in 3 hours');

  // ES256 (raw R||S), ES384 wrong-curve key, DER-encoded signature, ES512 on P-521.
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const p521 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-521' });
  const esToken = makeToken({ alg: 'ES256', typ: 'JWT' }, { sub: 'es' }, d => crypto.sign('sha256', d, { key: p256.privateKey, dsaEncoding: 'ieee-p1363' }));
  await page.fill('#jwt-token', esToken);
  await page.fill('#jwt-key', p256.publicKey.export({ type: 'spki', format: 'pem' }));
  await verified('ES256 PEM');
  await page.fill('#jwt-key', JSON.stringify(p256.publicKey.export({ format: 'jwk' })));
  await verified('ES256 JWK');
  await page.fill('#jwt-key', p384.publicKey.export({ type: 'spki', format: 'pem' }));
  await expectVerify(/EC P-384 key, but ES256 needs an EC P-256 public key/, 'curve mismatch');
  await page.fill('#jwt-key', p256.publicKey.export({ type: 'spki', format: 'pem' }));
  await page.fill('#jwt-token', makeToken({ alg: 'ES256' }, { sub: 'es' }, d => crypto.sign('sha256', d, p256.privateKey)));
  await expectVerify(/exactly 64 bytes.*DER-encoded/, 'DER signature');
  await page.fill('#jwt-token', makeToken({ alg: 'ES384' }, { sub: 'es' }, d => crypto.sign('sha384', d, { key: p384.privateKey, dsaEncoding: 'ieee-p1363' })));
  await page.fill('#jwt-key', p384.publicKey.export({ type: 'spki', format: 'pem' }));
  await verified('ES384');
  await page.fill('#jwt-token', makeToken({ alg: 'ES512' }, { sub: 'es' }, d => crypto.sign('sha512', d, { key: p521.privateKey, dsaEncoding: 'ieee-p1363' })));
  await page.fill('#jwt-key', p521.publicKey.export({ type: 'spki', format: 'pem' }));
  await verified('ES512 (P-521)');

  // EdDSA (Ed25519, RFC 8037).
  const ed = crypto.generateKeyPairSync('ed25519');
  await page.fill('#jwt-token', makeToken({ alg: 'EdDSA' }, { sub: 'ed' }, d => crypto.sign(null, d, ed.privateKey)));
  await page.fill('#jwt-key', ed.publicKey.export({ type: 'spki', format: 'pem' }));
  await verified('EdDSA PEM');
  await page.fill('#jwt-key', JSON.stringify(ed.publicKey.export({ format: 'jwk' })));
  await verified('EdDSA JWK');

  // alg "none" is flagged as unsafe.
  await page.fill('#jwt-token', b64u('{"alg":"none","typ":"JWT"}') + '.' + b64u('{"sub":"admin"}') + '.');
  assert.match(await text('#jwt-warn'), /unsigned and unsafe/);
  assert.equal(await text('#jwt-sig-badge'), 'Unsigned');
  assert.equal(await page.isVisible('#jwt-key'), false);
  assert.equal(await page.isVisible('#jwt-secret'), false);

  // Timestamps in milliseconds, big integers kept exactly, string exp.
  await page.fill('#jwt-token', makeToken({ alg: 'HS256' }, '{"id":12345678901234567890,"exp":1716242622000}', hmac('sha256', 'x')));
  assert.match(await text('#jwt-warn'), /"exp" looks like milliseconds \(13 digits\)/);
  assert.match(await text('#jwt-payload'), /"id": 12345678901234567890/);
  await page.fill('#jwt-token', makeToken({ alg: 'HS256' }, { exp: '1716242622' }, hmac('sha256', 'x')));
  assert.match(await text('#jwt-warn'), /"exp" is a string, not a number/);
  assert.equal(await text('#jwt-time-badge'), 'Expiry (exp) is not a valid date');
  await page.fill('#jwt-token', makeToken({ alg: 'HS256' }, { nbf: null }, hmac('sha256', 'x')));
  assert.match(await text('tr[data-claim="nbf"] .jwt-flag'), /not null\.$/);

  // Encrypted JWE: header only.
  await page.fill('#jwt-token', [b64u('{"alg":"RSA-OAEP","enc":"A256GCM"}'), 'ZW5j', 'aXY', 'Y2lwaGVy', 'dGFn'].join('.'));
  assert.match(await text('#jwt-info'), /encrypted token \(JWE\)/);
  assert.equal(await text('#jwt-payload'), '(encrypted)');
  assert.equal(await text('#jwt-msg'), '');

  // Malformed input.
  const bad = [
    ['abc', /no dots/],
    ['aaa.bbb', /three parts.*has 2/],
    ['a.b.c.d', /three parts.*has 4/],
    ['eyJhbGciOiJIUzI1NiJ9.$$$.abc', /contains "\$"/],
    ['abc.e30.', /header is not valid UTF-8/],
    [b64u('not json') + '.e30.', /header is not valid JSON/],
    [b64u('[1,2]') + '.e30.', /header must be a JSON object/],
    ['eyJhbGciOiJIUzI1NiJ9x.e30.', /length is impossible/],
    ['.e30.', /header part is empty/],
  ];
  for (const [tok, re] of bad) {
    await page.fill('#jwt-token', tok);
    assert.match(await text('#jwt-msg'), re, `error for ${tok}`);
    assert.equal(await page.isVisible('#jwt-out'), false, `output hidden for ${tok}`);
  }
  // A payload that is not JSON is shown as text with a warning.
  await page.fill('#jwt-token', b64u('{"alg":"HS256"}') + '.' + b64u('hello world') + '.');
  assert.equal(await text('#jwt-payload'), 'hello world');
  assert.match(await text('#jwt-warn'), /payload is not JSON/);

  // A cut-off signature still shows the header and payload, and verification says why it fails.
  const good = makeToken({ alg: 'HS256', typ: 'JWT' }, { sub: 'cut' }, hmac('sha256', 'k'.repeat(32)));
  await page.fill('#jwt-token', good.slice(0, good.length - 42)); // leaves 1 signature character
  assert.equal(await text('#jwt-msg'), '');
  assert.equal(await page.isVisible('#jwt-out'), true);
  assert.match(await text('#jwt-payload'), /"sub": "cut"/);
  assert.match(await text('#jwt-warn'), /signature is not valid Base64url.*cut off/);
  await page.fill('#jwt-secret', 'k'.repeat(32));
  await invalid('truncated signature');
  assert.match(await text('#jwt-verify'), /whole token was copied/);
  assert.equal(await text('#jwt-sig-badge'), 'Invalid signature');

  // Tokens inside other text: a JSON token response, a callback URL, a cookie.
  await page.fill('#jwt-token', JSON.stringify({ access_token: good, token_type: 'Bearer', id_token: JWT_IO }));
  assert.equal(await text('#jwt-msg'), '');
  assert.match(await text('#jwt-payload'), /"sub": "cut"/);
  assert.match(await text('#jwt-info'), /Found 2 tokens inside the pasted text and decoded the first one/);
  await verified('token extracted from JSON');
  await page.fill('#jwt-token', 'https://app.example.com/callback#id_token=' + JWT_IO + '&state=af0ifjsldkj');
  assert.match(await text('#jwt-payload'), /"name": "John Doe"/);
  assert.match(await text('#jwt-info'), /Found a token inside the pasted text/);
  await page.fill('#jwt-token', 'Cookie: session=' + JWT_IO + '; theme=dark');
  assert.match(await text('#jwt-payload'), /"name": "John Doe"/);

  // A secret with a stray trailing space gets a hint when verification fails.
  await page.fill('#jwt-token', good);
  await page.fill('#jwt-secret', 'k'.repeat(32) + ' ');
  await invalid('secret with trailing space');
  assert.match(await text('#jwt-key-note'), /ends with a space/);
  await page.fill('#jwt-secret', 'k'.repeat(32));
  await verified('secret without the space');

  // Algorithms that exist but aren't supported here are not called non-standard.
  await page.fill('#jwt-token', makeToken({ alg: 'ES256K' }, { sub: 'x' }, () => Buffer.alloc(64, 1)));
  assert.match(await text('#jwt-info'), /"ES256K" is not one of the signature algorithms this page supports/);

  // RFC 7797 unencoded payloads use a different signing input, so they are not reported as tampered.
  await page.fill('#jwt-token', makeToken({ alg: 'HS256', b64: false, crit: ['b64'] }, { sub: 'x' }, hmac('sha256', 'k'.repeat(32))));
  await expectVerify(/unencoded payload.*RFC 7797/, 'b64 false');
  assert.equal(await text('#jwt-sig-badge'), 'Signature not checked');

  // Nested JWT (cty: JWT): no "payload is not JSON" warning, an explanation instead.
  await page.fill('#jwt-token', makeToken({ alg: 'HS256', cty: 'JWT' }, JWT_IO, hmac('sha256', 'x')));
  assert.equal(await text('#jwt-warn'), '');
  assert.match(await text('#jwt-info'), /payload is itself a JWT/);
  assert.equal(await text('#jwt-payload'), JWT_IO);

  // Bare Base64 DER keys: PKCS#1 RSA public key works, private keys are refused, Ed25519 SPKI (60 chars) works.
  await page.fill('#jwt-token', rsToken);
  await page.fill('#jwt-key', rsa.publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64'));
  await verified('RS256 bare base64 PKCS#1');
  await page.fill('#jwt-key', rsa.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
  await expectVerify(/This is a private key/, 'bare PKCS#8 private key refused');
  await page.fill('#jwt-key', rsa.privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64'));
  await expectVerify(/This is a private key/, 'bare PKCS#1 private key refused');
  await page.fill('#jwt-token', makeToken({ alg: 'EdDSA' }, { sub: 'ed' }, d => crypto.sign(null, d, ed.privateKey)));
  const edDer = ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(edDer.length, 60);
  await page.fill('#jwt-key', edDer);
  await verified('EdDSA bare base64 SPKI');

  // RSA keys under 2048 bits verify, with a note (RFC 7518 section 3.3).
  const rsa1024 = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  await page.fill('#jwt-token', makeToken({ alg: 'RS256' }, { sub: 'small' }, d => crypto.sign('sha256', d, rsa1024.privateKey)));
  await page.fill('#jwt-key', rsa1024.publicKey.export({ type: 'spki', format: 'pem' }));
  await verified('RS256 1024-bit');
  assert.match(await text('#jwt-key-note'), /only 1024 bits.*2048 bits or more/);

  // Editing the example a little keeps its secret, so the tampering shows as an invalid signature.
  await page.click('#jwt-example');
  await verified('example before tampering');
  const ex = await page.inputValue('#jwt-token');
  const [exH, exP, exS] = ex.split('.');
  const exPayload = JSON.parse(Buffer.from(exP, 'base64url').toString());
  // Change one character of the Base64url payload (a flipped letter inside "role").
  const i = exP.length - 30;
  const flipped = exP.slice(0, i) + (exP[i] === 'A' ? 'B' : 'A') + exP.slice(i + 1);
  assert.ok(exPayload.role);
  await page.fill('#jwt-token', [exH, flipped, exS].join('.'));
  assert.notEqual(await page.inputValue('#jwt-secret'), '', 'example secret kept after a small edit');
  await invalid('tampered example');

  // Local times follow the viewer's time zone, including daylight saving time.
  // python: datetime.fromtimestamp(t, ZoneInfo('America/New_York')) -> Sat Jun 20 2026 08:00:00 PM EDT,
  // Wed Dec 31 2025 07:00:00 PM EST.
  const nyCtx = await page.context().browser().newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
  const ny = await nyCtx.newPage();
  const nyErrors = [];
  ny.on('pageerror', e => nyErrors.push(e.message));
  await ny.goto(url);
  await ny.fill('#jwt-token', makeToken({ alg: 'HS256' }, { exp: 1782000000, iat: 1767225600 }, hmac('sha256', 'x')));
  assert.equal(await ny.locator('tr[data-claim="exp"] .jwt-utc').textContent(), '2026-06-21 00:00:00 UTC');
  assert.match(await ny.locator('tr[data-claim="exp"] .jwt-local').textContent(), /^Local: Sat, Jun 20, 2026, 08:00:00 PM EDT/);
  assert.match(await ny.locator('tr[data-claim="iat"] .jwt-local').textContent(), /^Local: Wed, Dec 31, 2025, 07:00:00 PM EST/);
  assert.deepEqual(nyErrors, []);
  await nyCtx.close();

  // Clear, then the example comes back.
  await page.click('#jwt-clear');
  assert.equal(await page.inputValue('#jwt-token'), '');
  assert.equal(await page.isVisible('#jwt-out'), false);
  assert.equal(await text('#jwt-msg'), '');
  await page.click('#jwt-example');
  await verified('example again');
};
