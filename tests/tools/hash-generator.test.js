const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC-32C (Castagnoli, reflected 0x82F63B78), bit by bit, independent of the page's table code.
function crc32c(buf) {
  let c = 0xffffffff;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1; }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
const crc32 = buf => (zlib.crc32(buf) >>> 0).toString(16).padStart(8, '0');
// Everything Node's crypto module can compute itself.
function nodeHashes(buf) {
  const h = (alg, opts) => crypto.createHash(alg, opts).update(buf).digest('hex');
  return {
    md5: h('md5'), sha1: h('sha1'), sha256: h('sha256'), sha384: h('sha384'), sha512: h('sha512'),
    'sha3-224': h('sha3-224'), 'sha3-256': h('sha3-256'), 'sha3-384': h('sha3-384'), 'sha3-512': h('sha3-512'),
    shake128: h('shake128', { outputLength: 32 }), shake256: h('shake256', { outputLength: 64 }),
    blake2b512: h('blake2b512'), blake2s256: h('blake2s256'), ripemd160: h('ripemd160'), crc32: crc32(buf), crc32c: crc32c(buf),
  };
}

// Known-answer vectors computed independently with Python's hashlib
// (hashlib.new(alg, s.encode('utf-8')).digest(), then .hex() and base64.b64encode).
const V = {
  '': {
    md5: ['d41d8cd98f00b204e9800998ecf8427e', '1B2M2Y8AsgTpgAmY7PhCfg=='],
    sha1: ['da39a3ee5e6b4b0d3255bfef95601890afd80709', '2jmj7l5rSw0yVb/vlWAYkK/YBwk='],
    sha256: ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='],
    sha384: ['38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b', 'OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb'],
    sha512: ['cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e', 'z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='],
  },
  abc: {
    md5: ['900150983cd24fb0d6963f7d28e17f72', 'kAFQmDzST7DWlj99KOF/cg=='],
    sha1: ['a9993e364706816aba3e25717850c26c9cd0d89d', 'qZk+NkcGgWq6PiVxeFDCbJzQ2J0='],
    sha256: ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='],
    sha384: ['cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7', 'ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn'],
    sha512: ['ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f', '3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw=='],
  },
  'héllo wörld 👋 日本語': {
    md5: ['922cca76fbbefcbd82e64c736e6e37f7', 'kizKdvu+/L2C5kxzbm439w=='],
    sha1: ['440c60b15be21c6a92dc233c40686c3984f05814', 'RAxgsVviHGqS3CM8QGhsOYTwWBQ='],
    sha256: ['88b5504a70e83da99e04100fa00636a8488ee8d175b2a518ab378a179591f9bc', 'iLVQSnDoPameBBAPoAY2qEiO6NF1sqUYqzeKF5WR+bw='],
    sha384: ['4e5ad25b7f71edc16207e10ffbecd625d459f3b03811fd61fa7121a86c830645211e6a55e8385c26c40827dbc8228809', 'TlrSW39x7cFiB+EP++zWJdRZ87A4Ef1h+nEhqGyDBkUhHmpV6DhcJsQIJ9vIIogJ'],
    sha512: ['c4338e9773d006af3f90ae22e46bc9f8a56b8225d65752b9a3b15006377ffc258c43a382ac4d5c66cf6c08053fbbbdd99728f4b8f961ee15ec9f8ae154a1721c', 'xDOOl3PQBq8/kK4i5GvJ+KVrgiXWV1K5o7FQBjd//CWMQ6OCrE1cZs9sCAU/u73Zlyj0uPlh7hXsn4rhVKFyHA=='],
  },
};
const ALGS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];

module.exports = async ({ page, open, assert, fixtures }) => {
  await open();
  const text = sel => page.locator(sel).textContent();

  // Waits until the SHA-512 hex (the last one computed) shows the expected value.
  async function settle(sha512Hex) {
    await page.waitForFunction(v => document.querySelector('#hg-sha512-hex').textContent.toLowerCase() === v, sha512Hex, { timeout: 15000 })
      .catch(() => {});
  }
  async function expectAll(vec, label) {
    await settle(vec.sha512[0]);
    for (const a of ALGS) {
      assert.equal(await text(`#hg-${a}-hex`), vec[a][0], `${label}: ${a} hex`);
      assert.equal(await text(`#hg-${a}-b64`), vec[a][1], `${label}: ${a} base64`);
    }
  }

  // On load: hashes of the empty input.
  await expectAll(V[''], 'empty');
  assert.match(await text('#hg-summary'), /empty input/);

  await page.fill('#hg-text', 'abc');
  await expectAll(V.abc, 'abc');
  assert.equal(await text('#hg-bytes'), '3 bytes in UTF-8');

  await page.fill('#hg-text', 'héllo wörld 👋 日本語');
  await expectAll(V['héllo wörld 👋 日本語'], 'unicode');
  assert.equal(await text('#hg-bytes'), '28 bytes in UTF-8');

  // Uppercase toggle affects hex only.
  await page.check('#hg-upper');
  assert.equal(await text('#hg-md5-hex'), '922CCA76FBBEFCBD82E64C736E6E37F7');
  assert.equal(await text('#hg-md5-b64'), 'kizKdvu+/L2C5kxzbm439w==');
  await page.uncheck('#hg-upper');

  // Copy all puts every hex digest on the clipboard.
  await page.click('#hg-copy-all');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clip.includes('SHA-256: 88b5504a70e83da99e04100fa00636a8488ee8d175b2a518ab378a179591f9bc'), clip);
  assert.equal(clip.split('\n').length, 6); // the six algorithms ticked by default

  // Compare box.
  await page.fill('#hg-text', 'abc');
  await expectAll(V.abc, 'abc again');
  const cmp = async value => { await page.fill('#hg-expected', value); return { cls: await page.getAttribute('#hg-compare', 'class'), msg: await text('#hg-compare') }; };
  let r = await cmp(V.abc.sha256[0].toUpperCase());
  assert.match(r.cls, /\bok\b/); assert.match(r.msg, /SHA-256/);
  assert.equal(await page.locator('.hg-item.is-match').getAttribute('data-alg'), 'sha256');
  r = await cmp(`${V.abc.md5[0]}  downloads/abc.txt`); // sha256sum / md5sum line
  assert.match(r.cls, /\bok\b/); assert.match(r.msg, /MD5/);
  r = await cmp(`SHA1 (abc.txt) = ${V.abc.sha1[0]}`); // BSD style
  assert.match(r.cls, /\bok\b/); assert.match(r.msg, /SHA-1/);
  r = await cmp(`sha384-${V.abc.sha384[1]}`); // Subresource Integrity
  assert.match(r.cls, /\bok\b/); assert.match(r.msg, /SHA-384/);
  r = await cmp(V.abc.sha512[1].replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')); // base64url, no padding
  assert.match(r.cls, /\bok\b/); assert.match(r.msg, /SHA-512/);
  r = await cmp(V[''].sha256[0]);
  assert.match(r.cls, /\berror\b/); assert.match(r.msg, /No match.*SHA-256/);
  assert.equal(await page.locator('.hg-item.is-match').count(), 0);
  r = await cmp(V.abc.sha256[0].slice(1));
  assert.match(r.cls, /\berror\b/); assert.match(r.msg, /63 hex characters/);
  await page.fill('#hg-expected', '');
  assert.equal(await text('#hg-compare'), '');

  // Hex and Base64 input modes (vectors from hashlib over bytes 00 01 02 ff).
  await page.selectOption('#hg-enc', 'hex');
  await page.fill('#hg-text', '00 01 02 FF');
  await settle(crypto.createHash('sha512').update(Buffer.from([0, 1, 2, 255])).digest('hex'));
  assert.equal(await text('#hg-sha256-hex'), '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56');
  assert.equal(await text('#hg-md5-hex'), '0416dab819887333af831f8c765ac2ae');
  assert.equal(await text('#hg-bytes'), '4 bytes');
  await page.fill('#hg-text', '0x12 3g');
  assert.match(await text('#hg-msg'), /"g" is not a hex digit/);
  assert.equal(await text('#hg-md5-hex'), '–');
  await page.fill('#hg-text', 'abc');
  assert.match(await text('#hg-msg'), /even number of digits/);
  await page.selectOption('#hg-enc', 'base64');
  await page.fill('#hg-text', 'YWJj');
  await expectAll(V.abc, 'base64 input');
  assert.equal(await text('#hg-msg'), '');
  await page.fill('#hg-text', 'YW*j');
  assert.match(await text('#hg-msg'), /not valid Base64/);
  // Padding boundaries: MD5/SHA-1/SHA-256 use 64-byte blocks (a message of 56-63 bytes needs a
  // second padding block), SHA-384/512 use 128-byte blocks (boundary at 112). Expected values
  // come from Node's crypto module.
  await page.selectOption('#hg-enc', 'hex');
  for (const n of [55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129]) {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 73 + n) & 255;
    const exp = Object.fromEntries(ALGS.map(a => [a, crypto.createHash(a).update(buf).digest('hex')]));
    await page.fill('#hg-text', buf.toString('hex'));
    await settle(exp.sha512);
    for (const a of ALGS) assert.equal(await text(`#hg-${a}-hex`), exp[a], `${n}-byte message: ${a}`);
    assert.equal(await text('#hg-bytes'), `${n} bytes`);
  }

  await page.selectOption('#hg-enc', 'utf8');
  await page.fill('#hg-text', 'abc');
  await expectAll(V.abc, 'back to utf8');

  // Checksums pasted together with the text around them.
  const sha = V.abc.sha256[0];
  const formats = [
    [`Algorithm       Hash                                                                   Path\n---------       ----                                                                   ----\nSHA256          ${sha.toUpperCase()}       C:\\Users\\me\\abc.txt`, 'SHA-256', 'PowerShell Get-FileHash'],
    [`SHA256 hash of abc.txt:\n${sha}\nCertUtil: -hashfile command completed successfully.`, 'SHA-256', 'certutil'],
    [`MD5 hash of file abc.txt:\n${V.abc.md5[0].match(/../g).join(' ')}\nCertUtil: -hashfile command completed successfully.`, 'MD5', 'old certutil with spaced bytes'],
    [`SHA2-256(abc.txt)= ${sha}`, 'SHA-256', 'OpenSSL 3'],
    [`(stdin)= ${V.abc.sha1[0]}`, 'SHA-1', 'old OpenSSL stdin'],
    [`"${V.abc.sha512[0]}"`, 'SHA-512', 'quoted'],
    [`sha256:${sha}`, 'SHA-256', 'Docker digest'],
    [`integrity="sha384-${V.abc.sha384[1]}"`, 'SHA-384', 'SRI attribute'],
  ];
  for (const [value, alg, label] of formats) {
    r = await cmp(value);
    assert.match(r.cls, /\bok\b/, label);
    assert.ok(r.msg.includes(`the ${alg} hash`), `${label}: ${r.msg}`);
  }
  r = await cmp('not a hash!');
  assert.match(r.cls, /\berror\b/);
  assert.match(r.msg, /does not look like a hash/);
  await page.fill('#hg-expected', '');

  // Files: one million "a" (the RFC 1321 / FIPS 180 long-message vector).
  await page.check('input[name="hg-src"][value="file"]');
  assert.equal(await page.isVisible('#hg-text'), false);
  assert.equal(await text('#hg-md5-hex'), '–');
  await page.setInputFiles('#hg-file', { name: 'million-a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1000000, 'a') });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of million-a.txt'));
  assert.equal(await text('#hg-md5-hex'), '7707d6ae4e027c70eea2a935c2296f21');
  assert.equal(await text('#hg-sha256-hex'), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');

  // A 9 MB file crosses the 4 MB read chunks and shows progress; expected values from Node's crypto.
  const big = Buffer.alloc(9 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 9)) & 255;
  const bigExp = Object.fromEntries(ALGS.map(a => [a, crypto.createHash(a).update(big).digest('hex')]));
  await page.setInputFiles('#hg-file', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: big });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of big.bin'), null, { timeout: 30000 });
  for (const a of ALGS) assert.equal(await text(`#hg-${a}-hex`), bigExp[a], `big file ${a}`);
  assert.equal(await page.isVisible('#hg-progress-wrap'), false);
  assert.match(await text('#hg-drop-hint'), /9\.00 MB/);

  // Compare works against the file too.
  r = await cmp(bigExp.sha1.toUpperCase());
  assert.match(r.cls, /\bok\b/); assert.match(r.msg, /SHA-1 hash of the file/);

  // An empty file.
  await page.setInputFiles('#hg-file', { name: 'empty.dat', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of empty.dat'));
  await expectAll(V[''], 'empty file');
  await page.fill('#hg-expected', '');

  // A newer file replaces a big one still being hashed: only the newer result is shown.
  const huge = Buffer.alloc(40 * 1024 * 1024, 7);
  await page.setInputFiles('#hg-file', { name: 'huge.bin', mimeType: 'application/octet-stream', buffer: huge });
  await page.waitForSelector('#hg-progress-wrap:not([hidden])');
  await page.setInputFiles('#hg-file', { name: 'abc.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of abc.txt'));
  await page.waitForTimeout(1500); // give the stale job time to (wrongly) finish
  assert.match(await text('#hg-summary'), /^Hashes of abc\.txt/);
  assert.equal(await text('#hg-md5-hex'), V.abc.md5[0]);
  assert.equal(await page.isVisible('#hg-progress-wrap'), false);

  // Cancel stops a big file, resets the drop zone and hides the progress bar.
  await page.setInputFiles('#hg-file', { name: 'huge.bin', mimeType: 'application/octet-stream', buffer: huge });
  await page.waitForSelector('#hg-progress-wrap:not([hidden])');
  await page.click('#hg-cancel');
  await page.waitForTimeout(1500);
  assert.match(await text('#hg-summary'), /cancelled/);
  assert.equal(await text('#hg-md5-hex'), '–');
  assert.match(await text('#hg-drop-title'), /Choose files/);
  assert.equal(await page.isVisible('#hg-progress-wrap'), false);
  assert.equal(await page.getAttribute('#hg-results', 'data-busy'), '');

  // Switching to Text while a file is hashing shows the text hashes, not dimmed.
  await page.setInputFiles('#hg-file', { name: 'huge.bin', mimeType: 'application/octet-stream', buffer: huge });
  await page.waitForSelector('#hg-progress-wrap:not([hidden])');
  await page.check('input[name="hg-src"][value="text"]');
  assert.equal(await page.getAttribute('#hg-results', 'data-busy'), '');
  assert.equal(await text('#hg-md5-hex'), V.abc.md5[0]);
  await page.check('input[name="hg-src"][value="file"]');
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of huge.bin'), null, { timeout: 30000 });
  assert.equal(await text('#hg-md5-hex'), crypto.createHash('md5').update(huge).digest('hex'));

  // Dropping a file on the tool card hashes it.
  await page.check('input[name="hg-src"][value="text"]');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['abc'], 'dropped.txt', { type: 'text/plain' }));
    const card = document.querySelector('.tool-card');
    card.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of dropped.txt'));
  assert.equal(await text('#hg-sha256-hex'), V.abc.sha256[0]);
  assert.equal(await page.isVisible('#hg-file-pane'), true);

  // Switching back to Text shows the text hashes again, then Clear resets.
  await page.fill('#hg-expected', '');
  await page.check('input[name="hg-src"][value="text"]');
  await expectAll(V.abc, 'text tab again');
  await page.click('#hg-clear');
  await expectAll(V[''], 'cleared');
  assert.equal(await page.inputValue('#hg-text'), '');

  // BSD lines whose file name contains brackets still match.
  r = await cmp(`SHA256 (abc (1).txt) = ${V[''].sha256[0]}`);
  assert.match(r.cls, /\bok\b/); assert.match(r.msg, /SHA-256/);

  // Crafted input in the expected-hash box is parsed in linear time (a trailing-'=' regex and
  // the BSD "\(.*\)" pattern used to take over a second on 40,000 characters).
  for (const expr of [`'='.repeat(40000) + 'x'`, `'SHA256 (' + ')= x'.repeat(20000)`, `'a(' + ')='.repeat(20000) + ' x'`, `'A'.repeat(40000) + '='.repeat(40000) + 'x'`]) {
    const ms = await page.evaluate(expr => {
      const el = document.querySelector('#hg-expected');
      el.value = eval(expr);
      const t = performance.now();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - t;
    }, expr);
    assert.ok(ms < 150, `${expr} took ${Math.round(ms)} ms`);
    assert.match(await text('#hg-compare'), /^No match/, expr);
  }
  await page.fill('#hg-expected', '');

  // Screen readers: the hash list, the compare message and input errors change on every
  // keystroke, so none is a live region; one short sentence is announced once typing pauses.
  assert.equal(await page.getAttribute('#hg-results', 'aria-live'), null);
  assert.equal(await page.getAttribute('#hg-compare', 'aria-live'), null);
  assert.equal(await page.getAttribute('#hg-msg', 'role'), null);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__live = [];
    new MutationObserver(ms => ms.forEach(m => {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const reg = n && n.closest('[aria-live]:not([aria-live="off"]), [role=status], [role=alert]');
      if (reg && reg.textContent) window.__live.push(reg.id + ':' + reg.textContent);
    })).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.type('#hg-text', 'hello world', { delay: 40 });
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.evaluate(() => window.__live), ['hg-status:Hashes updated for 11 bytes of text.']);
  await page.evaluate(() => { window.__live = []; });
  await page.type('#hg-expected', '5eb63bbbe01eeed093cb22bb8f5acdc3', { delay: 20 }); // MD5 of "hello world"
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.evaluate(() => window.__live), ['hg-status:Match: this is the MD5 hash of the input.']);
  await page.evaluate(() => { window.__live = []; });
  await page.fill('#hg-text', '');
  await page.selectOption('#hg-enc', 'hex');
  await page.type('#hg-text', 'abc', { delay: 40 });
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.evaluate(() => window.__live),
    ['hg-status:Hex input needs an even number of digits (two per byte); it has 3. Enter valid input first.']);
  await page.selectOption('#hg-enc', 'utf8');
  await page.click('#hg-clear');

  // ---------- Every algorithm ----------
  const PY = JSON.parse(fs.readFileSync(path.join(fixtures, 'python-vectors.json'), 'utf8'));
  const B3 = JSON.parse(fs.readFileSync(path.join(fixtures, 'blake3-test-vectors.json'), 'utf8'));
  const IDS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'keccak256', 'shake128', 'shake256', 'blake2b512', 'blake2s256', 'blake3', 'ripemd160', 'crc32', 'crc32c'];
  const hexOf = async id => page.locator(`#hg-${id}-hex`).textContent();
  const allHex = async () => Object.fromEntries(await Promise.all(IDS.map(async id => [id, await hexOf(id)])));
  await page.click('#hg-pick-all');
  assert.equal(await text('#hg-alg-count'), '18 of 18');
  for (const id of IDS) assert.equal(await page.isVisible(`#hg-${id}-hex`), true, id);
  const expectFor = (buf, key) => Object.assign(nodeHashes(buf), { keccak256: PY.keccak256[key], blake3: PY.blake3[key] });
  const settleAll = async exp => page.waitForFunction(e => Object.entries(e).every(([id, v]) => document.querySelector(`#hg-${id}-hex`).textContent === v), exp, { timeout: 15000 }).catch(() => {});
  for (const [key, textValue] of [['', ''], ['abc', 'abc'], ['unicode', 'héllo wörld 👋 日本語'], ['fox', 'The quick brown fox jumps over the lazy dog']]) {
    await page.fill('#hg-text', textValue);
    const exp = expectFor(Buffer.from(textValue, 'utf8'), key);
    await settleAll(exp);
    assert.deepEqual(await allHex(), exp, 'text ' + JSON.stringify(textValue));
  }
  // Published answers anchor the reference values: NIST FIPS 202 "abc", Keccak-256 "" (Ethereum),
  // CRC check values for "123456789".
  await page.fill('#hg-text', 'abc');
  await settleAll({ 'sha3-256': '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532' });
  assert.equal(await hexOf('sha3-256'), '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  assert.equal(PY.keccak256[''], 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  await page.fill('#hg-text', '123456789');
  await settleAll({ crc32: 'cbf43926', crc32c: 'e3069283' });
  assert.deepEqual([await hexOf('crc32'), await hexOf('crc32c')], ['cbf43926', 'e3069283']);
  assert.equal(await page.locator('#hg-crc32-b64').textContent(), Buffer.from('cbf43926', 'hex').toString('base64'));
  // Block and padding boundaries of every algorithm (64, 128, 136, 144, 168-byte blocks).
  await page.selectOption('#hg-enc', 'hex');
  for (const n of [55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 135, 136, 137, 143, 144, 167, 168, 169]) {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 73 + n) & 255;
    await page.fill('#hg-text', buf.toString('hex'));
    const exp = expectFor(buf, 'pad' + n);
    await settleAll(exp);
    assert.deepEqual(await allHex(), exp, `${n}-byte message`);
  }
  // Official BLAKE3 test vectors: 131-byte extended output, and keyed_hash with the 32-byte key.
  // Inputs over 64 KB are hashed in the background worker.
  await page.fill('#hg-blake3-len', String(131 * 8));
  for (const c of B3.cases.filter(c => [0, 1, 63, 64, 65, 1023, 1024, 1025, 2048, 2049, 3072, 3073, 4097, 8193, 31744, 102400].includes(c.input_len))) {
    const buf = Buffer.alloc(c.input_len);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 251;
    await page.fill('#hg-text', buf.toString('hex'));
    await page.waitForFunction(v => document.querySelector('#hg-blake3-hex').textContent === v, c.hash, { timeout: 15000 }).catch(() => {});
    assert.equal(await hexOf('blake3'), c.hash, `BLAKE3 official vector, ${c.input_len} bytes`);
    if (c.input_len === 102400) assert.equal(await hexOf('sha3-512'), crypto.createHash('sha3-512').update(buf).digest('hex'), 'worker path, SHA3-512');
  }
  await page.fill('#hg-key', B3.key);
  for (const c of B3.cases.filter(c => [0, 1, 1025, 8193].includes(c.input_len))) {
    const buf = Buffer.alloc(c.input_len);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 251;
    await page.fill('#hg-text', buf.toString('hex'));
    await page.waitForFunction(v => document.querySelector('#hg-blake3-hex').textContent === v, c.keyed_hash, { timeout: 15000 }).catch(() => {});
    assert.equal(await hexOf('blake3'), c.keyed_hash, `BLAKE3 keyed_hash, ${c.input_len} bytes`);
  }
  await page.fill('#hg-key', '');
  await page.fill('#hg-blake3-len', '256');

  // ---------- SHAKE and BLAKE3 output length ----------
  await page.selectOption('#hg-enc', 'utf8');
  await page.fill('#hg-text', 'abc');
  await page.fill('#hg-shake128-len', '512');
  await page.waitForFunction(() => document.querySelector('#hg-shake128-hex').textContent.length === 128);
  assert.equal(await hexOf('shake128'), crypto.createHash('shake128', { outputLength: 64 }).update('abc').digest('hex'));
  await page.fill('#hg-shake128-len', '100');
  await page.waitForFunction(() => /8,192 bits, in steps of 8/.test(document.querySelector('#hg-shake128-hex').textContent));
  await page.fill('#hg-shake128-len', '256');
  await page.waitForFunction(() => document.querySelector('#hg-shake128-hex').textContent.length === 64);

  // ---------- HMAC and keyed hashes ----------
  const fox = 'The quick brown fox jumps over the lazy dog';
  const hmac = (alg, key, msg) => crypto.createHmac(alg, key).update(msg).digest('hex');
  await page.fill('#hg-text', fox);
  await page.fill('#hg-key', 'key');
  // Well-known answers: HMAC-MD5 and HMAC-SHA256("key", fox) as published on Wikipedia.
  const keyedExp = {
    md5: '80070713463e7749b90c2dc24911e275', sha256: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    sha1: hmac('sha1', 'key', fox), sha384: hmac('sha384', 'key', fox), sha512: hmac('sha512', 'key', fox),
    'sha3-224': hmac('sha3-224', 'key', fox), 'sha3-256': hmac('sha3-256', 'key', fox), 'sha3-384': hmac('sha3-384', 'key', fox), 'sha3-512': hmac('sha3-512', 'key', fox),
    ripemd160: hmac('ripemd160', 'key', fox), blake2b512: PY.keyed.blake2b512, blake2s256: PY.keyed.blake2s256,
  };
  assert.equal(hmac('md5', 'key', fox), keyedExp.md5);
  assert.equal(hmac('sha256', 'key', fox), keyedExp.sha256);
  await settleAll(keyedExp);
  for (const [id, v] of Object.entries(keyedExp)) assert.equal(await hexOf(id), v, 'keyed ' + id);
  assert.equal(await page.locator('.hg-item[data-alg="sha256"] b').textContent(), 'HMAC-SHA-256');
  assert.equal(await page.locator('.hg-item[data-alg="blake2b512"] b').textContent(), 'BLAKE2b-512 keyed');
  assert.match(await hexOf('keccak256'), /No keyed version/);
  assert.equal(await page.isDisabled('button[data-copy-target="#hg-keccak256-hex"]'), true, 'nothing to copy');
  assert.equal(await page.isVisible('#hg-keccak256-b64'), false);
  assert.equal(await page.isDisabled('button[data-copy-target="#hg-sha256-hex"]'), false);
  assert.match(await hexOf('crc32'), /No keyed version/);
  assert.match(await hexOf('blake3'), /exactly 32 bytes; this one has 3/);
  assert.match(await text('#hg-summary'), /^HMACs of 43 bytes of text/);
  assert.match(await text('#hg-key-info'), /Key: 3 bytes/);
  // RFC 4231 test cases 1 and 6 (hex key; a 131-byte key is hashed first).
  await page.selectOption('#hg-key-enc', 'hex');
  await page.fill('#hg-key', '0b'.repeat(20));
  await page.fill('#hg-text', 'Hi There');
  await settleAll({ sha256: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7' });
  assert.equal(await hexOf('sha256'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(await hexOf('sha512'), '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854');
  await page.fill('#hg-key', 'aa'.repeat(131));
  await page.fill('#hg-text', 'Test Using Larger Than Block-Size Key - Hash Key First');
  await settleAll({ sha256: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54' });
  assert.equal(await hexOf('sha256'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  assert.equal(await hexOf('sha3-256'), hmac('sha3-256', Buffer.alloc(131, 0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First'));
  assert.match(await hexOf('blake2b512'), /at most 64 bytes; this one has 131/);
  // A 32-byte Base64 key unlocks keyed BLAKE3.
  await page.selectOption('#hg-key-enc', 'base64');
  await page.fill('#hg-key', Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64'));
  await page.fill('#hg-text', fox);
  await settleAll({ blake3: PY.keyed32.blake3, blake2s256: PY.keyed32.blake2s256, blake2b512: PY.keyed32.blake2b512 });
  assert.deepEqual([await hexOf('blake3'), await hexOf('blake2s256'), await hexOf('blake2b512')], [PY.keyed32.blake3, PY.keyed32.blake2s256, PY.keyed32.blake2b512]);
  await page.fill('#hg-key', 'not*base64');
  await page.waitForFunction(() => /key is not valid Base64/.test(document.querySelector('#hg-msg').textContent));
  assert.equal(await page.getAttribute('#hg-key', 'aria-invalid'), 'true');
  await page.fill('#hg-key', '');
  await page.selectOption('#hg-key-enc', 'utf8');
  await settleAll({ sha256: nodeHashes(Buffer.from(fox)).sha256 });
  assert.equal(await text('#hg-msg'), '');
  assert.equal(await page.locator('.hg-item[data-alg="sha256"] b').textContent(), 'SHA-256');

  // ---------- Compare finds and ticks the matching algorithm ----------
  await page.click('#hg-pick-common');
  assert.equal(await text('#hg-alg-count'), '6 of 18');
  assert.equal(await page.isVisible('#hg-keccak256-hex'), false);
  await page.fill('#hg-text', 'abc');
  await settleAll({ sha256: V.abc.sha256[0] });
  r = await cmp('0x' + PY.keccak256.abc);
  assert.match(r.cls, /\bok\b/, r.msg);
  assert.match(r.msg, /^Match: this is the Keccak-256 hash of the input\./);
  assert.equal(await page.isChecked('input[data-alg="keccak256"]'), true);
  assert.equal(await page.isVisible('#hg-keccak256-hex'), true);
  assert.equal(await page.locator('.hg-item.is-match').getAttribute('data-alg'), 'keccak256');
  // A 256-bit SHAKE256 value is the start of the 512-bit output: the length follows.
  r = await cmp(crypto.createHash('shake256', { outputLength: 32 }).update('abc').digest('hex'));
  assert.match(r.msg, /^Match: this is the SHAKE256 \(256-bit\) hash of the input\./);
  assert.equal(await page.inputValue('#hg-shake256-len'), '256');
  // Google Cloud Storage lists CRC-32C as Base64 of the big-endian value.
  r = await cmp('crc32c=' + Buffer.from(crc32c(Buffer.from('abc')), 'hex').toString('base64'));
  assert.match(r.msg, /^Match: this is the CRC-32C hash/);
  r = await cmp(V.abc.sha256[0].slice(0, 63));
  assert.match(r.msg, /63 hex characters, an odd number/);
  r = await cmp('00'.repeat(32));
  assert.match(r.msg, /^No match\. A 64-character hex value is 256 bits, like SHA-256, SHA3-256, Keccak-256 or BLAKE2s-256; none of .* matches\./);
  await page.fill('#hg-expected', '');
  await page.fill('#hg-shake256-len', '512');
  await page.click('#hg-pick-common');

  // ---------- Files with other algorithms, in the worker ----------
  await page.check('input[name="hg-src"][value="file"]');
  for (const id of ['sha3-256', 'keccak256', 'blake3', 'blake2b512', 'crc32c']) await page.check(`input[data-alg="${id}"]`);
  await page.setInputFiles('#hg-file', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: big });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of big.bin') && document.querySelector('#hg-results').dataset.busy === '', null, { timeout: 60000 });
  const bigNode = nodeHashes(big);
  for (const id of ['md5', 'sha256', 'sha512', 'sha3-256', 'blake2b512', 'crc32c']) assert.equal(await hexOf(id), bigNode[id], 'big file ' + id);
  assert.equal(await hexOf('keccak256'), PY.bigfile.keccak256);
  assert.equal(await hexOf('blake3'), PY.bigfile.blake3);
  // Without SHA-1 and SHA-2 the file is not held in memory, and a key gives HMACs of the file.
  for (const id of ['sha1', 'sha256', 'sha384', 'sha512']) await page.uncheck(`input[data-alg="${id}"]`);
  await page.fill('#hg-key', 'secret');
  await page.setInputFiles('#hg-file', { name: 'million-a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1000000, 'a') });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('HMACs of million-a.txt'), null, { timeout: 30000 });
  assert.equal(await hexOf('md5'), crypto.createHmac('md5', 'secret').update(Buffer.alloc(1000000, 'a')).digest('hex'));
  assert.equal(await hexOf('sha3-256'), crypto.createHmac('sha3-256', 'secret').update(Buffer.alloc(1000000, 'a')).digest('hex'));
  // Ticking an algorithm hashes the file again with it.
  await page.check('input[data-alg="sha256"]');
  await page.waitForFunction(v => document.querySelector('#hg-sha256-hex').textContent === v, crypto.createHmac('sha256', 'secret').update(Buffer.alloc(1000000, 'a')).digest('hex'), { timeout: 30000 });
  await page.fill('#hg-key', '');
  await page.click('#hg-pick-common');
  await page.check('input[name="hg-src"][value="text"]');

  // ---------- Several files: a table and a checksum list ----------
  const FILES = [['a.txt', Buffer.from('abc')], ['my photo.jpg', crypto.randomBytes(70000)], ['empty.bin', Buffer.alloc(0)]];
  const digest = (alg, b) => crypto.createHash(alg).update(b).digest('hex');
  await page.check('input[name="hg-src"][value="file"]');
  await page.setInputFiles('#hg-file', FILES.map(([name, buffer]) => ({ name, mimeType: 'application/octet-stream', buffer })));
  await page.waitForFunction(() => /^Hashes of 3 files \([^)]*\)$/.test(document.querySelector('#hg-summary').textContent), null, { timeout: 30000 });
  assert.equal(await page.isVisible('#hg-results'), false);
  assert.equal(await page.inputValue('#hg-multi-alg'), 'sha256');
  const multiRows = () => page.$$eval('#hg-multi-body tr', trs => trs.map(tr => Array.from(tr.cells).map(c => c.textContent)));
  assert.deepEqual((await multiRows()).map(r => [r[0], r[2]]), FILES.map(([n, b]) => [n, digest('sha256', b)]));
  assert.equal(await text('#hg-drop-title'), '3 files');
  await page.selectOption('#hg-multi-alg', 'md5');
  assert.deepEqual((await multiRows()).map(r => r[2]), FILES.map(([, b]) => digest('md5', b)));
  const [dlSums] = await Promise.all([page.waitForEvent('download'), page.click('#hg-multi-dl')]);
  assert.match(dlSums.suggestedFilename(), /^MD5SUMS(\.txt)?$/); // Chrome adds .txt to a text/plain download
  const sums = fs.readFileSync(await dlSums.path(), 'utf8');
  assert.equal(sums, FILES.map(([n, b]) => digest('md5', b) + '  ' + n).join('\n') + '\n');
  // GNU md5sum -c accepts the list for the same files.
  let md5sum = false;
  try { md5sum = /GNU coreutils/.test(require('child_process').execFileSync('md5sum', ['--version']).toString()); } catch (e) { md5sum = false; }
  if (md5sum) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sums-'));
    for (const [n, b] of FILES) fs.writeFileSync(path.join(dir, n), b);
    fs.writeFileSync(path.join(dir, 'MD5SUMS'), sums);
    const res = require('child_process').execFileSync('md5sum', ['-c', 'MD5SUMS'], { cwd: dir }).toString();
    assert.equal(res.trim().split('\n').filter(l => / OK$/.test(l)).length, 3, res);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await page.click('#hg-multi-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sums);
  // Check a pasted SHA256SUMS: one line wrong, one file missing, one extra line, paths ignored.
  const list = [digest('sha256', FILES[0][1]) + '  ./downloads/a.txt', '0'.repeat(64) + ' *my photo.jpg', digest('sha256', Buffer.from('zzz')) + '  other.iso'].join('\n');
  await page.fill('#hg-expected', list);
  let checks = (await multiRows()).map(r => r[3]);
  assert.deepEqual(checks, ['OK (SHA-256)', 'Different', 'Not in the list']);
  assert.equal(await text('#hg-compare'), '1 file does not match its checksum. 1 matches. 1 file is not in the list. 1 line in the list names a file you did not choose.');
  assert.match(await page.getAttribute('#hg-compare', 'class'), /\berror\b/);
  // BSD-style lines, all matching.
  await page.fill('#hg-expected', FILES.map(([n, b]) => `SHA3-256 (${n}) = ${digest('sha3-256', b)}`).join('\n'));
  assert.deepEqual((await multiRows()).map(r => r[3]), ['OK (SHA3-256)', 'OK (SHA3-256)', 'OK (SHA3-256)']);
  assert.equal(await text('#hg-compare'), 'All 3 checked files match.');
  // One bare hash: which file is it?
  await page.fill('#hg-expected', digest('sha512', FILES[1][1]));
  assert.equal(await text('#hg-compare'), 'Match: this is the SHA-512 hash of my photo.jpg.');
  await page.fill('#hg-expected', '');
  assert.equal(await page.isVisible('#hg-multi-check-h'), false);
  // Several files dropped at once.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['one'], 'one.txt'));
    dt.items.add(new File(['two'], 'two.txt'));
    document.querySelector('.tool-card').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of 2 files'));
  assert.deepEqual((await multiRows()).map(r => r[2]), [digest('md5', Buffer.from('one')), digest('md5', Buffer.from('two'))]);
  // Back to one file; a pasted list is matched by its name.
  await page.setInputFiles('#hg-file', { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two') });
  await page.waitForFunction(() => document.querySelector('#hg-summary').textContent.startsWith('Hashes of two.txt'));
  assert.equal(await page.isVisible('#hg-results'), true);
  assert.equal(await page.isVisible('#hg-multi'), false);
  await page.fill('#hg-expected', digest('sha256', Buffer.from('one')) + '  one.txt\n' + digest('sha256', Buffer.from('two')) + '  two.txt');
  assert.match(await text('#hg-compare'), /^Match: this is the SHA-256 hash of the file\./);
  await page.fill('#hg-expected', '');
  await page.click('#hg-clear');
  assert.match(await text('#hg-drop-title'), /Choose files/);
  await page.check('input[name="hg-src"][value="text"]');

  // Short text is hashed with every algorithm on each keystroke, so it has to stay fast.
  const typeMs = await page.evaluate(() => {
    const el = document.querySelector('#hg-text');
    el.value = 'x'.repeat(60000);
    const t = performance.now();
    el.dispatchEvent(new Event('input'));
    return performance.now() - t;
  });
  assert.ok(typeMs < 100, `hashing 60 KB of text took ${Math.round(typeMs)} ms`);
  await page.click('#hg-clear');

  // The selected Text/File segment has a --muted ring (5.5:1 on the track), not only a colour change.
  const ring = await page.$eval('input[name="hg-src"]:checked + span', el => getComputedStyle(el).boxShadow);
  assert.match(ring, /rgb\(91, 98, 112\)/, ring);
};
