const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Fixtures (tests/fixtures/unlock-pdf, made by make_fixtures.py with reportlab and pikepdf/qpdf):
// one two-page document with bookmarks, a filled-in field, an attachment, XMP on the catalogue
// and on page 1, encrypted every way PDF allows (R2 to R6, both kinds of password, one password
// for both, a blank permissions password, EncryptMetadata false, a signature), plus files this
// page must refuse. expected.json holds what qpdf reads in each. Outputs are checked with pdf.js
// (an independent reader) and, for AES-256 copies, with ISO 32000-2 Algorithm 2.B written below
// with Node's crypto.

function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// ISO 32000-2 Algorithm 2.B and the checks of Algorithms 11, 12 and 13 (AES-256, R6).
function aesNoPad(key, iv, data, decrypt) {
  const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(`aes-${key.length * 8}-cbc`, key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}
function hash2B(pw, salt, udata) {
  let k = crypto.createHash('sha256').update(Buffer.concat([pw, salt, udata])).digest();
  for (let round = 0; ; round++) {
    const seq = Buffer.concat([pw, k, udata]);
    const e = aesNoPad(k.subarray(0, 16), k.subarray(16, 32), Buffer.concat(new Array(64).fill(seq)));
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    k = crypto.createHash(['sha256', 'sha384', 'sha512'][sum % 3]).update(e).digest();
    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}
// The text of every stream in a file written by pdf-lib, decrypted with an AES-256 file key when
// given, and inflated where it is compressed.
function streamsText(buf, key) {
  const raw = buf.toString('latin1');
  let out = '';
  for (let at = raw.indexOf('stream'); at >= 0; at = raw.indexOf('stream', at + 6)) {
    if (raw.slice(at - 3, at) === 'end') continue;
    let b = at + 6;
    if (raw[b] === '\r') b++;
    if (raw[b] !== '\n') continue;
    b++;
    const len = Number((raw.slice(raw.lastIndexOf(' obj', at), at).match(/\/Length (\d+)/) || [])[1]);
    if (!len) continue;
    let data = buf.subarray(b, b + len);
    if (key) {
      try {
        const plain = aesNoPad(key, data.subarray(0, 16), data.subarray(16), true);
        data = plain.subarray(0, plain.length - plain[plain.length - 1]);
      } catch (e) { continue; }
    }
    try { out += zlib.inflateSync(data).toString('latin1'); } catch (e) { out += data.toString('latin1'); }
  }
  return out;
}

function r6Dict(buf) {
  const raw = buf.toString('latin1'), at = raw.indexOf('/Filter /Standard');
  if (at < 0) return null;
  const d = raw.slice(raw.lastIndexOf(' obj', at), raw.indexOf('endobj', at));
  const hex = k => { const x = d.match(new RegExp('/' + k + ' <([0-9A-Fa-f]+)>')); return x ? Buffer.from(x[1], 'hex') : null; };
  const num = k => { const x = d.match(new RegExp('/' + k + ' (-?\\d+)')); return x ? Number(x[1]) : null; };
  return { text: d, V: num('V'), R: num('R'), P: num('P'), O: hex('O'), U: hex('U'), OE: hex('OE'), UE: hex('UE'), Perms: hex('Perms') };
}
function checkR6(buf, origOwner) {
  const e = r6Dict(buf);
  const none = Buffer.alloc(0);
  const userOk = hash2B(none, e.U.subarray(32, 40), none).equals(e.U.subarray(0, 32));
  const fileKey = aesNoPad(hash2B(none, e.U.subarray(40, 48), none), Buffer.alloc(16), e.UE, true);
  const perms = crypto.createDecipheriv('aes-256-ecb', fileKey, null).setAutoPadding(false).update(e.Perms);
  const ownerPw = Buffer.from(origOwner, 'utf8');
  const origOwnerWorks = hash2B(ownerPw, e.O.subarray(32, 40), e.U.subarray(0, 48)).equals(e.O.subarray(0, 32));
  return { V: e.V, R: e.R, P: e.P, userOk, permsP: perms.readInt32LE(0), permsTag: perms.toString('latin1', 8, 12), origOwnerWorks, fileKey, text: e.text };
}

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const fx = n => path.join(fixtures, n);
  const exp = JSON.parse(fs.readFileSync(fx('expected.json'), 'utf8'));
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await open();
  assert.equal(await page.isVisible('#ul-drop'), true);
  assert.equal(await page.isVisible('#ul-unlock'), false);
  assert.ok(!requests.some(u => /pdf-lib/.test(u)), 'pdf-lib is loaded only when a file is chosen');

  // Reads a PDF with pdf.js: encryption, permissions, text markers, bookmarks, attachments, fields, title.
  const inspect = buf => page.evaluate(async b64 => {
    const lib = await import('/assets/vendor/pdfjs/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.js';
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const task = lib.getDocument({ data, verbosity: 0 });
    const doc = await task.promise;
    const meta = await doc.getMetadata();
    const marks = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const text = (await (await doc.getPage(i)).getTextContent()).items.map(t => t.str).join(' ');
      marks.push((text.match(/UNLOCK-MARK-\d+/) || [''])[0]);
    }
    const outline = ((await doc.getOutline()) || []).map(o => o.title);
    const widget = (await (await doc.getPage(1)).getAnnotations()).find(x => x.fieldName === 'name');
    const field = widget ? widget.fieldValue : null;
    const p = await doc.getPermissions();
    const perms = p ? Array.from(p).sort((x, y) => x - y) : null;   // an array or a Set, by pdf.js version
    await task.destroy();
    return { encrypted: !!meta.info.EncryptFilterName, title: meta.info.Title, marks, outline, field, perms };
  }, buf.toString('base64'));
  const WHOLE = { title: 'Unlock test', marks: ['UNLOCK-MARK-01', 'UNLOCK-MARK-02'], outline: ['Chapter 1', 'Chapter 2'], field: 'Ada Lovelace' };
  const assertWhole = (got, label) => {
    for (const k of Object.keys(WHOLE)) assert.deepEqual(got[k], WHOLE[k], `${label}: ${k} kept`);
  };
  // The attached file (notes.txt) is a stream of its own: it must come through decrypted.
  const assertAttachment = (buf, label, key) => assert.ok(streamsText(buf, key).includes('ATTACHMENT-MARK'), `${label}: attachment kept`);

  const rows = () => page.$$eval('.ul-file', l => l.map(e => ({
    name: e.querySelector('.ul-name').textContent, prot: e.querySelector('.ul-prot').textContent,
    state: e.querySelector('.ul-state').textContent, note: e.querySelector('.ul-note').textContent,
    dl: !e.querySelector('button').hidden,
  })));
  const rowOf = async name => (await rows()).find(r => r.name === name);
  const idle = () => page.waitForFunction(() => document.querySelector('#ul-progress').hidden && !document.querySelector('#ul-clear').disabled &&
    document.querySelectorAll('.ul-file').length > 0, null, { timeout: 60000 });
  const unlockWith = async pw => { await page.fill('#ul-pw', pw); await page.press('#ul-pw', 'Enter'); await idle(); };
  const save = async name => {
    const btn = page.locator('.ul-file', { has: page.locator('.ul-name', { hasText: new RegExp('^' + name.replace(/[.]/g, '\\.') + '$') }) }).locator('button');
    const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
    return { name: dl.suggestedFilename(), buf: fs.readFileSync(await dl.path()) };
  };
  const status = () => page.waitForFunction(() => document.getElementById('ul-status').textContent).then(h => h.jsonValue());
  const fieldError = () => page.evaluate(() => {
    const f = document.getElementById('ul-pw'), box = document.getElementById('ul-pw-error');
    return { text: box.textContent, invalid: f.getAttribute('aria-invalid'), linked: f.getAttribute('aria-describedby').split(/\s+/).includes('ul-pw-error') };
  });
  // What each file should say it is protected by, from qpdf's reading of it.
  const and = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  const protection = e => {
    const parts = [];
    if (e.user !== '') parts.push('Password to open');   // made with an open password
    if (e.restrictions.length) parts.push((parts.length ? 'blocks ' : 'Blocks ') + and(e.restrictions));
    else if (parts.length) parts.push('nothing else restricted');
    parts.push(e.cipher + ' encryption');
    return parts.join(' · ');
  };

  // ---- Every fixture at once ----
  const names = fs.readdirSync(fixtures).filter(n => n.endsWith('.pdf')).sort();
  assert.equal(names.length, 21);
  await page.setInputFiles('#ul-file', names.map(fx));
  await idle();
  assert.ok(requests.some(u => /pdf-lib\.min\.js/.test(u)), 'pdf-lib loads once there is a file');
  let got = await rows();
  assert.deepEqual(got.map(r => r.name), names);
  const REFUSED = {
    'attachments-only.pdf': 'Only its attachments are encrypted. The document itself opens without a password; this page does not unlock attachments.',
    'certificate.pdf': 'Certificate security: it opens with the recipient’s private key (a digital ID), not a password, so this page does not open it.',
    'drm.pdf': 'Rights management (DRM): it is opened with keys from the publisher’s server, so it cannot be unlocked here.',
    'crypt-filter.pdf': 'Parts of it use their own encryption filter, which this page does not handle.',
    'damaged.pdf': 'This file is damaged or is not a valid PDF.',
  };
  for (const r of got) {
    const key = r.name.replace(/\.pdf$/, ''), e = exp[key];
    if (REFUSED[r.name]) { assert.equal(r.state, REFUSED[r.name], r.name); assert.equal(r.dl, false); continue; }
    if (!e.encrypted) { assert.equal(r.state, 'Not protected: no password and no restrictions, so there is nothing to remove.'); assert.equal(r.dl, false); continue; }
    assert.equal(r.prot, protection(e), `${r.name} protection`);
    if (e.empty_opens_as === 'owner') {
      assert.equal(r.state, 'Unlocked: password and restrictions removed. Its permissions password is blank, which also opens it.', r.name);
      assert.equal(r.dl, true);
    } else if (e.empty_opens_as === 'user' && !e.restrictions.length) {
      // Encrypted, but with no open password and nothing restricted: nothing to ask for.
      assert.equal(r.state, 'Unlocked: encryption removed. It had no password and no restrictions.', r.name);
      assert.equal(r.dl, true);
    } else if (e.empty_opens_as === 'user') {
      assert.equal(r.state, 'Opens without a password. To remove the restrictions, type its permissions password.', r.name);
    } else {
      assert.equal(r.state, 'Needs the password that opens it.', r.name);
    }
  }
  assert.equal((await rowOf('signed.pdf')).note, 'It is digitally signed: the signature will not validate in an unlocked copy, so keep the original.');
  assert.equal(await status(), '2 files are unlocked, 11 files need a password to open, 2 files need the permissions password to lift restrictions, 1 file is not protected, 5 files cannot be unlocked here.');
  assert.equal(await page.isVisible('#ul-unlock'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ul-pw', 'the password box takes the focus');
  // The blank permissions password: unlocked straight away, all of it kept.
  let out = await save('r6-blank-owner.pdf');
  assert.equal(out.name, 'r6-blank-owner-unlocked.pdf');
  let pdf = await inspect(out.buf);
  assertWhole(pdf, 'blank owner');
  assertAttachment(out.buf, 'blank owner');
  assert.equal(pdf.encrypted, false);
  assert.equal(pdf.perms, null);
  out = await save('r6-empty.pdf');
  pdf = await inspect(out.buf);
  assertWhole(pdf, 'empty passwords');
  assert.equal(pdf.encrypted, false);

  // ---- The password box ----
  assert.deepEqual(await page.$eval('#ul-pw', el => [el.type, el.getAttribute('autocapitalize'), el.getAttribute('autocorrect'), el.getAttribute('spellcheck'), el.getAttribute('autocomplete')]),
    ['password', 'none', 'off', 'false', 'off']);
  await page.click('#ul-show');
  assert.deepEqual(await page.$eval('#ul-pw', el => el.type), 'text');
  assert.equal(await page.getAttribute('#ul-show', 'aria-pressed'), 'true');
  await page.click('#ul-show');
  assert.equal(await page.$eval('#ul-pw', el => el.type), 'password');
  assert.equal(await page.getAttribute('#ul-show', 'aria-pressed'), 'false');
  // Caps Lock is reported while it is on.
  await page.$eval('#ul-pw', el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', modifierCapsLock: true, bubbles: true })));
  assert.equal(await page.textContent('#ul-caps'), 'Caps Lock is on.');
  await page.$eval('#ul-pw', el => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true })));
  assert.equal(await page.textContent('#ul-caps'), '');
  // No password, then a wrong one.
  await page.fill('#ul-pw', '');
  await page.click('#ul-go');
  assert.deepEqual(await fieldError(), { text: 'Type the password first.', invalid: 'true', linked: true });
  await unlockWith('not the password');
  assert.deepEqual(await fieldError(), { text: 'That password does not unlock any of these files. Check it, or ask whoever sent them.', invalid: 'true', linked: true });
  assert.equal((await rowOf('r6-open.pdf')).state, 'That password does not open this file.');
  assert.equal((await rowOf('r6-restricted.pdf')).state, 'That is not its permissions password, so the restrictions stay.');
  assert.equal((await rowOf('r6-restricted.pdf')).dl, false);
  assert.equal(await status(), 'That password does not unlock any of these files. Check it, or ask whoever sent them.');
  // A megabyte pasted into the box stops at 1,024 characters.
  await page.$eval('#ul-pw', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, 'x'.repeat(1 << 20));
  assert.equal(await page.$eval('#ul-pw', el => el.value.length), 1024);
  assert.equal(await page.getAttribute('#ul-pw', 'aria-invalid'), null, 'typing clears the error');

  // ---- The open password: "open sesame" ----
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  const t0 = await threadMs();
  await unlockWith('open sesame');
  assert.ok((await threadMs()) - t0 < 1500, 'the work runs off the main thread');
  assert.deepEqual(await fieldError(), { text: '', invalid: null, linked: true });
  const KEPT = 'Open password removed. Still blocks %: type the permissions password to remove that too.';
  const expectState = {
    'r6-open.pdf': 'Unlocked: password removed.',
    'r4-rc4.pdf': 'Unlocked: password removed.',
    'r2.pdf': 'Unlocked: password and restrictions removed.',          // no permissions password: the open one is both
    'r6-both.pdf': KEPT.replace('%', 'printing and copying'),
    'r5.pdf': KEPT.replace('%', 'printing'),
    'r4-aes-nometa.pdf': KEPT.replace('%', 'copying'),
    'r6-objstm.pdf': KEPT.replace('%', 'printing'),                     // object streams and an xref stream
    'r4-objstm.pdf': KEPT.replace('%', 'copying'),
    'r6-same.pdf': 'That password does not open this file.',
    'r3.pdf': 'That password does not open this file.',
    'r6-cyrillic.pdf': 'That password does not open this file.',
    'r6-restricted.pdf': 'That is not its permissions password, so the restrictions stay.',
  };
  for (const [n, s] of Object.entries(expectState)) assert.equal((await rowOf(n)).state, s, n);
  assert.equal((await rowOf('r6-both.pdf')).note, 'The copy keeps these restrictions under a new random permissions password, so to lift them later start from the original file.');
  assert.equal(await status(), 'Unlocked 8 of 13 files. 5 files are unlocked, 5 files have the open password removed but restrictions kept, 3 files need a password to open, 2 files need the permissions password to lift restrictions, 1 file is not protected, 5 files cannot be unlocked here.');

  // Plain copies: no encryption left, and no trace of the old encryption dictionary.
  for (const n of ['r6-open', 'r4-rc4', 'r2']) {
    out = await save(n + '.pdf');
    assert.equal(out.name, n + '-unlocked.pdf');
    pdf = await inspect(out.buf);
    assertWhole(pdf, n);
    assertAttachment(out.buf, n);
    assert.equal(pdf.encrypted, false, n);
    assert.equal(pdf.perms, null, `${n} has no restrictions left`);
    const raw = out.buf.toString('latin1');
    assert.ok(!raw.includes('/Encrypt') && !raw.includes('/Standard'), `${n}: no encryption dictionary`);
    assert.ok(!raw.toLowerCase().includes(exp[n].O_hex), `${n}: the old /O is gone`);
    // The trailer's /Size is one more than the highest object number (ISO 32000-1 Table 15).
    const highest = Math.max(...Array.from(raw.matchAll(/(?:^|\n)(\d+) 0 obj/g), m => Number(m[1])));
    assert.equal(Number(raw.slice(raw.lastIndexOf('trailer')).match(/\/Size (\d+)/)[1]), highest + 1, `${n}: trailer /Size`);
    const streams = streamsText(out.buf);
    assert.ok(streams.includes('ROOT-XMP-MARK') && streams.includes('PAGE-XMP-MARK'), `${n}: XMP decrypted`);
  }
  // Copies that keep the restrictions: AES-256 (R6), no open password, the same /P, a new permissions password.
  const keptCopies = {};
  for (const n of ['r6-both', 'r5', 'r4-aes-nometa', 'r6-objstm', 'r4-objstm']) {
    out = await save(n + '.pdf');
    keptCopies[n] = out.buf;
    pdf = await inspect(out.buf);
    assertWhole(pdf, n);
    assert.equal(pdf.encrypted, true, `${n} copy is still encrypted`);
    const r6 = checkR6(out.buf, exp[n].owner);
    assert.equal(r6.V, 5);
    assert.equal(r6.R, 6);
    assert.equal(r6.userOk, true, `${n}: opens with no password`);
    assert.equal(r6.P, exp[n].P, `${n}: same permissions`);
    assert.equal(r6.permsP, exp[n].P, `${n}: /Perms holds /P`);
    assert.equal(r6.permsTag, (exp[n].encrypt_metadata ? 'T' : 'F') + 'adb');
    assert.equal(r6.origOwnerWorks, false, `${n}: the original permissions password does not open the copy`);
    const all = streamsText(out.buf, r6.fileKey);
    assert.ok(all.includes('UNLOCK-MARK-01') && all.includes('ATTACHMENT-MARK'), `${n}: streams decrypt with the key from /UE`);
    assert.match(out.buf.toString('latin1', 0, 9), /^%PDF-1\.7/);
    assert.ok(out.buf.toString('latin1').includes('/ExtensionLevel 8'));
    assert.ok(!out.buf.toString('latin1').toLowerCase().includes(exp[n].O_hex), `${n}: the old /O is gone`);
  }
  // pdf.js reads the restrictions back: 4 = print, 16 = copy, 2048 = high-quality print.
  pdf = await inspect(keptCopies['r6-both']);
  assert.ok(!pdf.perms.includes(4) && !pdf.perms.includes(16) && !pdf.perms.includes(2048) && pdf.perms.includes(8));
  pdf = await inspect(keptCopies['r4-aes-nometa']);
  assert.ok(pdf.perms.includes(4) && !pdf.perms.includes(16));
  // EncryptMetadata false is kept: only the catalogue's XMP is in the clear.
  const nometa = streamsText(keptCopies['r4-aes-nometa']);
  assert.ok(nometa.includes('ROOT-XMP-MARK'), 'catalogue XMP left unencrypted');
  assert.ok(!nometa.includes('PAGE-XMP-MARK'), 'page XMP encrypted');
  assert.match(r6Dict(keptCopies['r4-aes-nometa']).text, /\/EncryptMetadata false/);

  // ---- An R3 open password in PDFDocEncoding (€ is byte 0xA0 there, not in Latin-1) ----
  await unlockWith('é€');
  assert.equal((await rowOf('r3.pdf')).state, KEPT.replace('%', 'high-quality printing'));
  out = await save('r3.pdf');
  const r3 = checkR6(out.buf, 'owner pass');
  assert.equal(r3.userOk, true);
  assert.equal(r3.P, exp.r3.P);
  assert.ok((await inspect(out.buf)).perms.includes(4) && !(await inspect(out.buf)).perms.includes(2048), 'low-quality printing only');

  // ---- The permissions password lifts everything, also on files already partly unlocked ----
  await unlockWith('owner pass');
  assert.equal((await rowOf('r3.pdf')).state, 'Unlocked: password and restrictions removed.');
  for (const n of ['r6-both.pdf', 'r5.pdf', 'r4-aes-nometa.pdf', 'r6-objstm.pdf', 'r4-objstm.pdf']) assert.equal((await rowOf(n)).state, 'Unlocked: password and restrictions removed.', n);
  assert.equal((await rowOf('r6-restricted.pdf')).state, 'Unlocked: restrictions removed.');
  assert.equal((await rowOf('signed.pdf')).state, 'Unlocked: restrictions removed.');
  assert.equal((await rowOf('signed.pdf')).note, 'It was digitally signed: the signature will not validate in the copy, so keep the original.');
  for (const n of ['r6-both', 'r4-aes-nometa', 'r6-restricted', 'r6-objstm', 'r4-objstm']) {
    out = await save(n + '.pdf');
    pdf = await inspect(out.buf);
    assertWhole(pdf, n);
    assertAttachment(out.buf, n);
    assert.equal(pdf.encrypted, false, n);
    assert.equal(pdf.perms, null, n);
    assert.ok(streamsText(out.buf).includes('PAGE-XMP-MARK'), `${n}: a page's XMP is decrypted too`);
  }
  // A signature's /Contents is never encrypted, so it comes out byte for byte.
  out = await save('signed.pdf');
  assert.ok(out.buf.toString('latin1').toLowerCase().includes(exp.signature_contents_hex), 'signature contents unchanged');
  pdf = await inspect(out.buf);
  assert.deepEqual(pdf.marks, WHOLE.marks);

  // ---- One password for both, and an R6 password in UTF-8 ----
  await unlockWith('same pass');
  assert.equal((await rowOf('r6-same.pdf')).state, 'Unlocked: password and restrictions removed.');
  await unlockWith('пароль€');
  assert.equal((await rowOf('r6-cyrillic.pdf')).state, 'Unlocked: password removed.');
  pdf = await inspect((await save('r6-cyrillic.pdf')).buf);
  assertWhole(pdf, 'cyrillic');
  assert.equal(await page.isVisible('#ul-unlock'), false, 'nothing left that needs a password');
  assert.equal(await status(), 'Unlocked. 15 files are unlocked, 1 file is not protected, 5 files cannot be unlocked here.');

  // ---- Download all as a ZIP; a double click saves one file ----
  let downloads = 0;
  page.on('download', () => downloads++);
  const before = downloads;
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.dblclick('#ul-zip')]);
  assert.equal(zipDl.suggestedFilename(), 'unlocked-pdfs.zip');
  const entries = unzip(fs.readFileSync(await zipDl.path()));
  const unlockedNames = names.filter(n => exp[n.replace(/\.pdf$/, '')] && exp[n.replace(/\.pdf$/, '')].encrypted).map(n => n.replace(/\.pdf$/, '-unlocked.pdf'));
  assert.deepEqual(entries.map(e => e.name).sort(), unlockedNames.sort());
  const r2Button = page.locator('.ul-file', { has: page.locator('.ul-name', { hasText: /^r2\.pdf$/ }) }).locator('button');
  const [singleDl] = await Promise.all([page.waitForEvent('download'), r2Button.dblclick()]);
  const single = fs.readFileSync(await singleDl.path());
  assert.ok(entries.find(e => e.name === 'r2-unlocked.pdf').data.equals(single), 'the ZIP holds the same bytes');
  await page.waitForTimeout(1000);
  assert.equal(downloads - before, 2, 'one ZIP and one PDF for two double clicks');

  // ---- Clear the list; files that are not PDFs; too many files; drag and drop ----
  await page.click('#ul-clear');
  assert.equal(await page.$$eval('.ul-file', l => l.length), 0);
  assert.equal(await page.isVisible('#ul-files'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ul-choose');
  await page.setInputFiles('#ul-file', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello, not a pdf') },
    { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
  ]);
  await idle();
  assert.deepEqual((await rows()).map(r => r.state), ['This is not a PDF file.', 'This file is empty.']);
  await page.click('#ul-clear');
  const many = Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') }));
  await page.setInputFiles('#ul-file', many);
  await idle();
  assert.equal(await page.$$eval('.ul-file', l => l.length), 100);
  assert.equal(await page.textContent('#ul-error'), 'Only the first 100 files were added: the list holds up to 100.');
  await page.click('#ul-clear');
  assert.equal(await page.textContent('#ul-error'), '');
  const dt = await page.evaluateHandle(b64 => {
    const d = new DataTransfer();
    d.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'dropped.pdf', { type: 'application/pdf' }));
    return d;
  }, fs.readFileSync(fx('r6-open.pdf')).toString('base64'));
  await page.dispatchEvent('#ul-drop', 'dragover', { dataTransfer: dt });
  assert.equal(await page.$eval('#ul-drop', el => el.classList.contains('is-over')), true);
  await page.dispatchEvent('#ul-drop', 'drop', { dataTransfer: dt });
  await idle();
  assert.equal((await rowOf('dropped.pdf')).state, 'Needs the password that opens it.');
  // Keyboard only: type the password and press Enter, then Tab to the download.
  await page.focus('#ul-pw');
  await page.keyboard.type('open sesame');
  await page.keyboard.press('Enter');
  await idle();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Download', 'focus moves to the download');
  const [kbd] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(kbd.suggestedFilename(), 'dropped-unlocked.pdf');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.focus('#ul-choose').then(() => page.keyboard.press('Enter'))]);
  assert.equal(chooser.isMultiple(), true);
  await page.click('#ul-clear');

  // ---- Guide links point at tools of this site ----
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/split-pdf/', '/merge-pdf/', '/pdf-to-jpg/']);
  for (const href of links) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), href);
  assert.match(await page.textContent('.faq'), /17 U\.S\.C\. §1201/);

  // ---- A phone with a touch screen ----
  const browser = page.context().browser();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true, locale: 'de-DE' });
  const p2 = await phone.newPage();
  const errors = [];
  p2.on('pageerror', e => errors.push(e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p2.goto(url);
  const longName = 'Kontoauszug_2026_mit_allen_Anlagen_und_Unterschriften_vom_Steuerberater_geprueft';
  const [pick] = await Promise.all([p2.waitForEvent('filechooser'), p2.tap('#ul-choose')]);
  await pick.setFiles([{ name: longName + '.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('r6-both.pdf')) },
    { name: 'r6-open.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(fx('r6-open.pdf')) }]);
  await p2.waitForFunction(() => document.querySelector('#ul-progress').hidden && document.querySelectorAll('.ul-file').length === 2, null, { timeout: 60000 });
  await p2.fill('#ul-pw', 'open sesame');
  await p2.tap('#ul-go');
  await p2.waitForFunction(() => document.querySelectorAll('.ul-file button:not([hidden])').length === 2, null, { timeout: 60000 });
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await p2.setViewportSize({ width, height: 800 });
    const cut = await p2.$$eval('.ul button', l => l.filter(e => e.getClientRects().length && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)).map(e => e.textContent));
    assert.deepEqual(cut, [], `nothing cut off at ${width}px`);
    assert.ok(await p2.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width}px`);
  }
  for (const sel of ['#ul-choose', '#ul-show', '#ul-go', '#ul-zip', '.ul-file button']) {
    assert.ok((await p2.$eval(sel, el => el.getBoundingClientRect().height)) >= 44, `${sel} is at least 44px tall`);
  }
  const [dlPhone] = await Promise.all([p2.waitForEvent('download'), p2.tap('.ul-file button')]);
  assert.equal(dlPhone.suggestedFilename(), longName + '-unlocked.pdf');
  assert.deepEqual(errors, []);
  await phone.close();
};
