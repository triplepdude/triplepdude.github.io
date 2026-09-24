const crypto = require('crypto');

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

module.exports = async ({ page, open, assert }) => {
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
  assert.equal(clip.split('\n').length, 5);

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
  assert.match(await text('#hg-drop-title'), /Choose a file/);
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
};
