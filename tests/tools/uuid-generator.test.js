// Decoder answers use the RFC 9562 Appendix A test vectors (v1, v4, v6, v7,
// v8 all encode 2022-02-22T19:22:22Z) and values computed independently with
// Python's uuid module (uuid3/uuid5 of www.example.com in the DNS namespace,
// the 128-bit integers, the DNS namespace UUID's own v1 timestamp).
const fs = require('fs');
const nodeCrypto = require('crypto');
const { execFileSync } = require('child_process');

// Name-based UUIDs computed with Node's own MD5/SHA (RFC 9562 sections 5.3, 5.5, B.2).
function nameUuid(ver, ns, name) {
  const hash = crypto => nodeCrypto.createHash(crypto).update(Buffer.concat([Buffer.from(ns.replace(/-/g, ''), 'hex'), Buffer.from(name, 'utf8')])).digest();
  const b = hash({ 3: 'md5', 5: 'sha1', 8: 'sha256' }[ver]).subarray(0, 16);
  b[6] = (b[6] & 0x0f) | (ver << 4);
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidToBig = s => [...s].reduce((v, c) => v * 32n + BigInt(CROCKFORD.indexOf(c)), 0n);

module.exports = async ({ page, open, assert }) => {
  const T = Date.parse('2026-09-24T12:34:56.789Z'); // 1790253296789 = 0x01a0d3696c95 (Python)
  await page.clock.setFixedTime(new Date(T));
  await open();

  const text = sel => page.locator(sel).textContent();
  const lines = async () => (await page.inputValue('#uu-out')).split('\n');
  const row = id => page.locator('#uu-row-' + id + ' td').evaluate(td => td.firstChild ? (td.firstChild.textContent || '') : '');
  const inspect = v => page.fill('#uu-in', v);
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  // Default: one v4 UUID.
  let out = await lines();
  assert.equal(out.length, 1);
  assert.match(out[0], V4);
  assert.equal(await text('#uu-summary'), '1 UUID, version 4');
  await page.click('#uu-gen');
  assert.notEqual((await lines())[0], out[0], 'Generate makes a new one');

  // 1000 v4: valid, unique, and every random bit is roughly balanced.
  await page.fill('#uu-count', '1000');
  out = await lines();
  assert.equal(out.length, 1000);
  assert.equal(await text('#uu-summary'), '1,000 UUIDs, version 4');
  assert.equal(new Set(out).size, 1000);
  const counts = new Array(128).fill(0);
  for (const u of out) {
    assert.match(u, V4);
    const bin = BigInt('0x' + u.replace(/-/g, '')).toString(2).padStart(128, '0');
    for (let i = 0; i < 128; i++) if (bin[i] === '1') counts[i]++;
  }
  for (let i = 0; i < 128; i++) {
    if (i >= 48 && i < 52) assert.equal(counts[i], i === 49 ? 1000 : 0, `version bit ${i}`);
    else if (i === 64) assert.equal(counts[i], 1000, 'variant bit 64');
    else if (i === 65) assert.equal(counts[i], 0, 'variant bit 65');
    else assert.ok(counts[i] > 400 && counts[i] < 600, `random bit ${i} set ${counts[i]}/1000 times`);
  }

  // v7 with a frozen clock: 1000 IDs in the same millisecond must share the
  // timestamp and still sort strictly in generation order (RFC 9562 6.2).
  await page.selectOption('#uu-ver', '7');
  out = await lines();
  assert.equal(out.length, 1000);
  assert.equal(await text('#uu-summary'), '1,000 UUIDs, version 7');
  for (const u of out) {
    assert.match(u, V7);
    assert.equal(u.replace(/-/g, '').slice(0, 12), '01a0d3696c95');
  }
  for (let i = 1; i < out.length; i++) assert.ok(out[i] > out[i - 1], `v7 order at ${i}`);
  const lastOfBatch = out[999];

  // The decoder reads the timestamp back.
  await inspect(out[0]);
  assert.equal(await row('timestamp-utc'), '2026-09-24T12:34:56.789Z');
  assert.equal(await row('unix-time-ms'), '1790253296789');
  assert.equal(await row('version'), '7: Unix Epoch time-based');

  // Clock steps back 5 s: the order still holds (last timestamp is reused).
  await page.clock.setFixedTime(new Date(T - 5000));
  await page.fill('#uu-count', '3');
  out = await lines();
  assert.ok(out[0] > lastOfBatch, 'monotonic after clock rollback');
  assert.equal(out[0].slice(0, 13), '01a0d369-6c95');
  // Clock moves on 1 s: new timestamp.
  await page.clock.setFixedTime(new Date(T + 1000));
  await page.click('#uu-gen');
  out = await lines();
  assert.equal(out[0].replace(/-/g, '').slice(0, 12), '01a0d369707d');
  assert.ok(out[0] < out[1] && out[1] < out[2]);

  // Formats re-format the same list rather than generating new IDs.
  const base = out.slice();
  await page.check('#uu-upper');
  assert.deepEqual(await lines(), base.map(u => u.toUpperCase()));
  await page.check('#uu-nohyph');
  assert.deepEqual(await lines(), base.map(u => u.toUpperCase().replace(/-/g, '')));
  await page.check('#uu-braces');
  assert.deepEqual(await lines(), base.map(u => '{' + u.toUpperCase().replace(/-/g, '') + '}'));
  await page.uncheck('#uu-upper');
  await page.uncheck('#uu-nohyph');
  assert.deepEqual(await lines(), base.map(u => '{' + u + '}'));

  // Copy and download.
  await page.click('.uu-gen button[data-copy-target="#uu-out"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base.map(u => '{' + u + '}').join('\n'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#uu-dl')]);
  assert.equal(dl.suggestedFilename(), 'uuids-v7.txt');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), base.map(u => '{' + u + '}').join('\n') + '\n');
  await page.uncheck('#uu-braces');

  // Count validation: friendly error, list unchanged.
  for (const bad of ['0', '1001', '2.5', '', '-3']) {
    await page.fill('#uu-count', bad);
    assert.match(await text('#uu-gen-err'), /whole number from 1 to 1,000/, `count ${bad}`);
    assert.deepEqual(await lines(), base, `count ${bad}`);
  }
  await page.fill('#uu-count', '2');
  assert.equal(await text('#uu-gen-err'), '');
  assert.equal((await lines()).length, 2);

  // Decoder: RFC 9562 vectors via the example buttons.
  await page.click('button[data-uuid="C232AB00-9414-11EC-B3C8-9F6BDECED846"]');
  assert.equal(await row('status'), 'Valid UUID');
  assert.equal(await row('standard-form'), 'c232ab00-9414-11ec-b3c8-9f6bdeced846');
  assert.equal(await row('version'), '1: Gregorian time-based');
  assert.equal(await row('variant'), 'RFC 9562 (OSF DCE, formerly RFC 4122)');
  assert.equal(await row('timestamp-utc'), '2022-02-22T19:22:22.0000000Z');
  assert.equal(await row('clock-sequence'), '13256 (0x33c8)');
  assert.equal(await row('node'), '9f:6b:de:ce:d8:46');
  assert.match(await text('#uu-row-node'), /Multicast bit set/);
  assert.equal(await row('as-an-integer'), '258133314363070689776975542038781941830');

  await page.click('button[data-uuid="1EC9414C-232A-6B00-B3C8-9F6BDECED846"]');
  assert.equal(await row('version'), '6: Reordered Gregorian time-based');
  assert.equal(await row('timestamp-utc'), '2022-02-22T19:22:22.0000000Z');
  assert.equal(await row('clock-sequence'), '13256 (0x33c8)');
  assert.equal(await row('as-an-integer'), '40921815930960820517455393747779901510');

  await page.click('button[data-uuid="017F22E2-79B0-7CC3-98C4-DC0C0C07398F"]');
  assert.equal(await row('version'), '7: Unix Epoch time-based');
  assert.equal(await row('timestamp-utc'), '2022-02-22T19:22:22.000Z');
  assert.equal(await row('unix-time-ms'), '1645557742000');
  assert.equal(await row('random-bits'), 'rand_a cc3, rand_b 18c4dc0c0c07398f');
  assert.equal(await row('as-an-integer'), '1989357241971137676463954034883508623');

  await page.click('button[data-uuid="919108F7-52D1-4320-9BAC-F847DB4148A8"]');
  assert.equal(await row('version'), '4: Random');
  assert.equal(await page.locator('#uu-row-timestamp-utc').count(), 0);
  assert.equal(await row('as-an-integer'), '193491124287564075115561252409011423400');

  await page.click('button[data-uuid="2489E9AD-2EE2-8E00-8EC9-32D5F69181C0"]');
  assert.equal(await row('version'), '8: Custom, vendor-specific');
  assert.equal(await row('as-an-integer'), '48568292040296206889929073122543239616');

  await page.click('button[data-uuid="00000000-0000-0000-0000-000000000000"]');
  assert.equal(await row('status'), 'Valid UUID');
  assert.match(await row('type'), /^Nil UUID/);
  assert.equal(await row('as-an-integer'), '0');
  await page.click('button[data-uuid="FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"]');
  assert.match(await row('type'), /^Max UUID/);
  assert.equal(await row('as-an-integer'), '340282366920938463463374607431768211455');

  // Name-based UUIDs (Python: uuid3/uuid5(NAMESPACE_DNS, 'www.example.com')).
  await inspect('5df41881-3aed-3515-88a7-2f4a814cf09e');
  assert.equal(await row('version'), '3: Name-based, MD5 hash');
  await inspect('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.equal(await row('version'), '5: Name-based, SHA-1 hash');
  assert.equal(await row('as-an-integer'), '62257697832880430461588949038000940706');

  // The DNS namespace UUID is itself a v1 with sub-microsecond digits.
  await inspect('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
  assert.equal(await row('timestamp-utc'), '1998-02-04T22:13:53.1511824Z');
  assert.equal(await row('clock-sequence'), '180 (0xb4)');
  assert.equal(await row('node'), '00:c0:4f:d4:30:c8');
  assert.match(await text('#uu-row-node'), /MAC address/);
  assert.equal(await row('as-an-integer'), '143098242404177361603877621312831893704');

  // Other variants.
  await inspect('00000000-0000-0000-C000-000000000046'); // COM IUnknown
  assert.equal(await row('status'), 'Non-standard variant');
  assert.equal(await row('variant'), 'Microsoft, reserved for backward compatibility');
  assert.equal(await row('version'), 'Not applicable to this variant');
  await inspect('00000000-0000-0000-0000-000000000001');
  assert.equal(await row('variant'), 'NCS, reserved for backward compatibility');
  await inspect('12345678-1234-0234-8234-123456789abc');
  assert.equal(await row('status'), 'Unknown version');

  // Accepted spellings.
  for (const v of ['{017F22E2-79B0-7CC3-98C4-DC0C0C07398F}', 'urn:uuid:017f22e2-79b0-7cc3-98c4-dc0c0c07398f', ' 017F22E279B07CC398C4DC0C0C07398F ',
    '"017f22e2-79b0-7cc3-98c4-dc0c0c07398f"', "'017F22E2-79B0-7CC3-98C4-DC0C0C07398F'", '{urn:uuid:017f22e2-79b0-7cc3-98c4-dc0c0c07398f}', 'URN:UUID:017F22E2-79B0-7CC3-98C4-DC0C0C07398F']) {
    await inspect(v);
    assert.equal(await text('#uu-in-err'), '', v);
    assert.equal(await row('standard-form'), '017f22e2-79b0-7cc3-98c4-dc0c0c07398f', v);
  }
  // Errors.
  for (const [v, re] of [
    ['017f22e2-79b0-7cc3-98c4-dc0c0c07398g', /"g" is not a hexadecimal digit/],
    ['017f22e2-79b0-7cc3-98c4-dc0c0c07398', /32 hex digits, but this has 31/],
    ['017f22e279b0-7cc3-98c4-dc0c0c07398f0', /32 hex digits, but this has 33/],
    ['017f22e279b0-7cc3-98c4-dc0c0c07398f', /hyphens are in the wrong places/],
    ['017f22e2-79b0-7cc3-98c4-dc0c0c0739😀', /^"😀" is not a hexadecimal digit/],
    ['"017f22e2-79b0-7cc3-98c4-dc0c0c07398f', /^""" is not a hexadecimal digit/],
  ]) {
    await inspect(v);
    assert.match(await text('#uu-in-err'), re, v);
    assert.equal(await page.locator('#uu-info tr').count(), 0, v);
  }
  await inspect('');
  assert.equal(await text('#uu-in-err'), '');

  // Live regions: typing must not fire an announcement per key.
  const record = () => page.evaluate(() => {
    window.__live = [];
    if (window.__liveOn) return;
    window.__liveOn = true;
    document.querySelectorAll('[aria-live], [role=alert], [role=status]').forEach(r => new MutationObserver(() =>
      window.__live.push([r.id || r.className, r.getAttribute('role') || r.getAttribute('aria-live'), r.textContent.trim()])
    ).observe(r, { childList: true, subtree: true, characterData: true }));
  });
  const heard = () => page.evaluate(() => window.__live);
  assert.equal(await page.locator('#uu-in-err[role], .table-wrap[aria-live]').count(), 0, 'no alert or live table');
  assert.equal(await page.getAttribute('#uu-in', 'aria-describedby'), 'uu-in-err');
  await page.waitForTimeout(1000); // let the generator's delayed status (from the count above) settle
  await record();
  await page.focus('#uu-in');
  await page.keyboard.type('919108f7-52d1-4320-9bac-f847db4148a8', { delay: 20 });
  assert.match(await text('#uu-in-err'), /^$/);
  await page.waitForTimeout(1200);
  let log = await heard();
  assert.deepEqual(log, [['uu-in-status', 'status', 'Valid UUID. Version 4: Random.']], 'one status after 36 keys');
  await record();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  assert.equal(await text('#uu-in-err'), 'A UUID has 32 hex digits, but this has 30.', 'visible error is immediate');
  await page.waitForTimeout(1200);
  assert.deepEqual(await heard(), [['uu-in-status', 'status', 'A UUID has 32 hex digits, but this has 30.']]);
  await page.click('[aria-label="Decode the RFC 9562 v7 example"]');
  assert.equal(await text('#uu-in-status'), 'Valid UUID. Version 7: Unix Epoch time-based.', 'example buttons announce at once');

  // ---------- v1 and v6 ----------
  // With a frozen clock every ID takes the next 100 ns tick after T. Selecting v1 made
  // one ID (tick 0), so the batch of 1,000 starts at tick 1.
  const OFFSET = 0x01B21DD213814000n;
  const T100 = BigInt(T) * 10000n + OFFSET;
  const V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const V6 = /^[0-9a-f]{8}-[0-9a-f]{4}-6[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const p2 = await page.context().newPage();
  await p2.clock.setFixedTime(new Date(T));
  await p2.goto(page.url());
  await p2.selectOption('#uu-ver', '1');
  await p2.fill('#uu-count', '1000');
  let v1s = (await p2.inputValue('#uu-out')).split('\n');
  assert.equal(v1s.length, 1000);
  const v1time = u => { const h = u.replace(/-/g, ''); return (BigInt('0x' + h.slice(13, 16)) << 48n) | (BigInt('0x' + h.slice(8, 12)) << 32n) | BigInt('0x' + h.slice(0, 8)); };
  const tailOf = u => u.slice(19);
  v1s.forEach((u, i) => {
    assert.match(u, V1);
    assert.equal(v1time(u), T100 + 1n + BigInt(i), `v1 time ${i}`);
    assert.equal(tailOf(u), tailOf(v1s[0]), 'same clock sequence and node in a batch');
  });
  assert.equal(parseInt(v1s[0].slice(24, 26), 16) & 1, 1, 'random node has the multicast bit set');
  assert.equal(new Set(v1s).size, 1000);
  // Python's uuid module reads the same 60-bit time.
  const py = (code, arg) => execFileSync('python3', ['-c', code, arg]).toString().trim();
  let python = true;
  try { py('print(1)', ''); } catch (e) { python = false; }
  if (python) assert.equal(py('import uuid,sys; u=uuid.UUID(sys.argv[1]); print(u.version, u.time, u.clock_seq, u.node)', v1s[999]),
    `1 ${T100 + 1000n} ${parseInt(v1s[0].slice(19, 23), 16) & 0x3fff} ${parseInt(v1s[0].slice(24), 16)}`);
  await p2.selectOption('#uu-ver', '6');
  const v6s = (await p2.inputValue('#uu-out')).split('\n');
  const v6time = u => { const h = u.replace(/-/g, ''); return (BigInt('0x' + h.slice(0, 12)) << 12n) | BigInt('0x' + h.slice(13, 16)); };
  v6s.forEach((u, i) => {
    assert.match(u, V6);
    assert.equal(v6time(u), T100 + 1001n + BigInt(i), `v6 time ${i}`);
    assert.equal(tailOf(u), tailOf(v1s[0]));
    if (i) assert.ok(u > v6s[i - 1], `v6 sorts in order at ${i}`);
  });
  assert.equal(await p2.locator('#uu-summary').textContent(), '1,000 UUIDs, version 6');
  // The decoder converts between the two layouts (RFC 9562 appendix A: the v1 and v6 examples).
  await p2.click('button[data-uuid="C232AB00-9414-11EC-B3C8-9F6BDECED846"]');
  assert.equal(await p2.locator('#uu-row-as-v6 td').evaluate(td => td.firstChild.textContent), '1ec9414c-232a-6b00-b3c8-9f6bdeced846');
  await p2.click('button[data-uuid="1EC9414C-232A-6B00-B3C8-9F6BDECED846"]');
  assert.equal(await p2.locator('#uu-row-as-v1 td').evaluate(td => td.firstChild.textContent), 'c232ab00-9414-11ec-b3c8-9f6bdeced846');

  // ---------- ULID ----------
  await p2.selectOption('#uu-ver', 'ulid');
  assert.equal(await p2.isVisible('#uu-upper'), false, 'UUID format options are hidden for ULIDs');
  const ulids = (await p2.inputValue('#uu-out')).split('\n');
  assert.equal(ulids.length, 1000);
  assert.equal(await p2.locator('#uu-summary').textContent(), '1,000 ULIDs');
  let tPrefix = '';
  for (let v = BigInt(T), i = 0; i < 10; i++, v >>= 5n) tPrefix = CROCKFORD[Number(v & 31n)] + tPrefix;
  ulids.forEach((u, i) => {
    assert.match(u, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.equal(u.slice(0, 10), tPrefix, 'ULID time prefix');
    if (i) assert.equal(ulidToBig(u) - ulidToBig(ulids[i - 1]), 1n, `monotonic ULID: +1 at ${i}`);
  });
  await p2.clock.setFixedTime(new Date(T - 5000));
  await p2.click('#uu-gen');
  const back = (await p2.inputValue('#uu-out')).split('\n');
  assert.ok(back[0] > ulids[999], 'ULIDs stay in order when the clock steps back');
  const [dlU] = await Promise.all([p2.waitForEvent('download'), p2.click('#uu-dl')]);
  assert.equal(dlU.suggestedFilename(), 'ulids.txt');
  await p2.close();

  // ULID decoding (spec example; ulid-py gives the time and UUID form).
  await page.click('button[data-uuid="01ARZ3NDEKTSV4RRFFQ69G5FAV"]');
  assert.equal(await row('status'), 'Valid ULID');
  assert.equal(await row('timestamp-utc'), '2016-07-30T23:54:10.259Z');
  assert.equal(await row('unix-time-ms'), '1469922850259');
  assert.equal(await row('as-a-uuid'), '01563e3a-b5d3-d676-4c61-efb99302bd5b');
  assert.equal(await text('#uu-in-status'), 'Valid ULID. Timestamp, UTC 2016-07-30T23:54:10.259Z.');
  await inspect('01arz3ndektsv4rrffq69g5fav');
  assert.equal(await row('standard-form'), '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  // ...and a UUID's ULID form (ulid.from_uuid(UUID('017f22e2-79b0-7cc3-98c4-dc0c0c07398f'))).
  await inspect('017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
  assert.equal(await row('as-a-ulid'), '01FWHE4YDGFK1SHH6W1G60EECF');
  for (const [v, re] of [['01ARZ3NDEKTSV4RRFFQ69G5FAI', /"I" can't appear in a ULID/], ['81ARZ3NDEKTSV4RRFFQ69G5FAV', /starts with 0 to 7/], ['01ARZ3NDEKTSV4RRFFQ69G5FA*', /"\*" can't appear/]]) {
    await inspect(v);
    assert.match(await text('#uu-in-err'), re, v);
  }
  await inspect('6ba7b811-9dad-11d1-80b4-00c04fd430c8');
  assert.match(await text('#uu-row-namespace'), /standard URL namespace/);

  // ---------- Name-based v3, v5, v8 ----------
  const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8', URLNS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
  const OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8', X500 = '6ba7b814-9dad-11d1-80b4-00c04fd430c8';
  // Published and Python (uuid.uuid3/uuid5) answers first, to anchor the Node helper.
  assert.equal(nameUuid(5, DNS, 'www.example.com'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.equal(nameUuid(3, DNS, 'www.example.com'), '5df41881-3aed-3515-88a7-2f4a814cf09e');
  assert.equal(nameUuid(8, DNS, 'www.example.com'), '5c146b14-3c52-8afd-938a-375d0df1fbf6'); // RFC 9562 B.2
  await page.selectOption('#uu-ver', '5');
  assert.equal(await page.isVisible('#uu-count'), false);
  assert.equal(await page.isVisible('#uu-names'), true);
  assert.equal(await page.inputValue('#uu-out'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.equal(await text('#uu-summary'), '1 UUID, version 5 (name-based)');
  await page.selectOption('#uu-ver', '3');
  await page.waitForFunction(() => document.querySelector('#uu-out').value === '5df41881-3aed-3515-88a7-2f4a814cf09e');
  await page.selectOption('#uu-ver', '8');
  await page.waitForFunction(() => document.querySelector('#uu-out').value === '5c146b14-3c52-8afd-938a-375d0df1fbf6');
  // Python: uuid5/uuid3 in the URL, OID and X.500 namespaces.
  const PY = [
    [URLNS, 'https://example.com/', 'dd2c1780-811a-5296-81c5-178a0ef488bc', 'b9dcdff8-af4a-365d-8043-0f8361942709'],
    [OID, '1.3.6.1', '1447fa61-5277-5fef-a9b3-fbc6e44f4af3', 'dd1a1cef-13d5-368a-ad82-eca71acd4cd1'],
    [X500, 'cn=John Doe,o=Acme', '56427d5b-cb4e-5e1f-a034-040025b6d964', '44605102-f0fe-3590-ba8d-457f38a1c122'],
  ];
  for (const [ns, name, v5, v3] of PY) {
    assert.equal(nameUuid(5, ns, name), v5);
    await page.selectOption('#uu-ns', ns);
    await page.fill('#uu-names', name);
    await page.selectOption('#uu-ver', '5');
    await page.waitForFunction(v => document.querySelector('#uu-out').value === v, v5);
    await page.selectOption('#uu-ver', '3');
    await page.waitForFunction(v => document.querySelector('#uu-out').value === v, v3);
  }
  // Custom namespace, Unicode, an empty name and MD5/SHA padding boundaries (55, 56, 64, 119 bytes).
  const CUSTOM = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f';
  const names = ['héllo 👋', '', 'a'.repeat(39), 'b'.repeat(40), 'c'.repeat(48), 'd'.repeat(103), ' www.example.com', 'WWW.EXAMPLE.COM'];
  await page.selectOption('#uu-ns', 'custom');
  assert.match(await text('#uu-gen-err'), /Enter the namespace UUID/);
  await page.fill('#uu-ns-custom', 'not-a-uuid');
  assert.match(await text('#uu-gen-err'), /custom namespace must be a UUID/);
  await page.fill('#uu-ns-custom', '{' + CUSTOM.toUpperCase() + '}');
  await page.fill('#uu-names', names.join('\r\n') + '\n');
  for (const ver of [3, 5, 8]) {
    await page.selectOption('#uu-ver', String(ver));
    const exp = names.map(n => nameUuid(ver, CUSTOM, n));
    await page.waitForFunction(v => document.querySelector('#uu-out').value === v, exp.join('\n'));
    assert.equal(await text('#uu-summary'), `8 UUIDs, version ${ver} (name-based)`);
  }
  if (python) assert.equal(py('import uuid,sys; print(uuid.uuid5(uuid.UUID(sys.argv[1]), "héllo 👋"))', CUSTOM), nameUuid(5, CUSTOM, 'héllo 👋'));
  await page.check('#uu-upper');
  assert.equal((await page.inputValue('#uu-out')).split('\n')[0], nameUuid(8, CUSTOM, 'héllo 👋').toUpperCase());
  await page.uncheck('#uu-upper');
  const [dl5] = await Promise.all([page.waitForEvent('download'), page.click('#uu-dl')]);
  assert.equal(dl5.suggestedFilename(), 'uuids-v8.txt');
  await page.fill('#uu-names', '');
  assert.match(await text('#uu-gen-err'), /Enter a name/);
  assert.equal(await page.getAttribute('#uu-names', 'aria-invalid'), 'true');
  await page.selectOption('#uu-ns', DNS);
  await page.fill('#uu-names', 'www.example.com');

  // ---------- Nil and Max ----------
  await page.selectOption('#uu-ver', 'nil');
  assert.equal(await page.inputValue('#uu-out'), '00000000-0000-0000-0000-000000000000');
  assert.equal(await text('#uu-summary'), 'Nil UUID');
  await page.selectOption('#uu-ver', 'max');
  await page.check('#uu-braces');
  await page.check('#uu-upper');
  assert.equal(await page.inputValue('#uu-out'), '{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}');
  await page.uncheck('#uu-braces');
  await page.uncheck('#uu-upper');

  // ---------- NanoID ----------
  await page.selectOption('#uu-ver', 'nanoid');
  await page.fill('#uu-count', '1000');
  let ids = (await page.inputValue('#uu-out')).split('\n');
  assert.equal(ids.length, 1000);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{21}$/);
  assert.equal(new Set(ids).size, 1000);
  assert.equal(await text('#uu-summary'), '1,000 NanoIDs of 21 characters');
  // 21 characters of 64 = 126 bits; birthday bound sqrt(2 * 2^126 * ln(1/0.99)) = 1.3e18.
  const n1 = Math.sqrt(2 * 2 ** 126 * Math.log(1 / 0.99));
  assert.equal(n1.toExponential(1), '1.3e+18');
  assert.equal(await text('#uu-nano-info'), '126 random bits per ID (64 characters, length 21). About 1.3 × 10¹⁸ IDs give a 1% chance that two are equal.');
  // 36 characters: 64 is not a multiple of 36, so a plain "byte % 36" or "byte & 63"
  // mapping would favour some characters. Each should appear about 10,000 / 36 = 278 times.
  await page.selectOption('#uu-nano-set', '0123456789abcdefghijklmnopqrstuvwxyz');
  await page.fill('#uu-nano-len', '10');
  ids = (await page.inputValue('#uu-out')).split('\n');
  const freq = {};
  for (const id of ids) { assert.match(id, /^[0-9a-z]{10}$/); for (const c of id) freq[c] = (freq[c] || 0) + 1; }
  assert.equal(Object.keys(freq).length, 36);
  for (const [c, n] of Object.entries(freq)) assert.ok(n > 180 && n < 380, `character ${c} appeared ${n} times`);
  // Custom alphabets, including characters outside the BMP.
  await page.fill('#uu-nano-alpha', 'abc');
  assert.equal(await page.inputValue('#uu-nano-set'), 'custom');
  await page.fill('#uu-nano-len', '5');
  ids = (await page.inputValue('#uu-out')).split('\n');
  for (const id of ids) assert.match(id, /^[abc]{5}$/);
  assert.equal(await text('#uu-nano-info'), `7.9 random bits per ID (3 characters, length 5). About 2 IDs give a 1% chance that two are equal.`);
  await page.fill('#uu-nano-alpha', '😀😁');
  await page.fill('#uu-count', '3');
  ids = (await page.inputValue('#uu-out')).split('\n');
  for (const id of ids) assert.match(id, /^(?:😀|😁){5}$/u);
  for (const [alpha, len, re] of [['aa', '5', /appears more than once/], ['a', '5', /at least 2 different characters/], ['abc', '0', /length from 1 to 256/], ['abc', '257', /length from 1 to 256/]]) {
    await page.fill('#uu-nano-alpha', alpha);
    await page.fill('#uu-nano-len', len);
    assert.match(await text('#uu-gen-err'), re, alpha + ' ' + len);
  }
  await page.selectOption('#uu-nano-set', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-');
  await page.fill('#uu-nano-len', '21');
  assert.equal(await text('#uu-gen-err'), '');
  const [dlN] = await Promise.all([page.waitForEvent('download'), page.click('#uu-dl')]);
  assert.equal(dlN.suggestedFilename(), 'nanoids.txt');
  assert.equal(fs.readFileSync(await dlN.path(), 'utf8').split('\n').length, 4);

  // The generator's status is announced once typing pauses, never as an alert.
  assert.equal(await page.locator('#uu-gen-err[role], #uu-summary[aria-live]').count(), 0);
  await page.selectOption('#uu-ver', '5');
  await page.waitForTimeout(1000);
  await record();
  await page.fill('#uu-names', '');
  await page.type('#uu-names', 'a\nb', { delay: 40 });
  await page.waitForTimeout(1200);
  assert.deepEqual((await heard()).filter(l => l[0] === 'uu-gen-status'), [['uu-gen-status', 'status', '2 UUIDs, version 5 (name-based)']]);
  await page.selectOption('#uu-ver', '4');

  // Without crypto.randomUUID (older browsers, pages not served over HTTPS)
  // the page falls back to getRandomValues and must still set the bits.
  const p3 = await page.context().newPage();
  const p2errors = [];
  p3.on('pageerror', e => p2errors.push(e.message));
  await p3.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }); });
  await p3.goto(page.url());
  assert.equal(await p3.evaluate(() => typeof crypto.randomUUID), 'undefined');
  await p3.fill('#uu-count', '500');
  const fb = (await p3.inputValue('#uu-out')).split('\n');
  assert.equal(fb.length, 500);
  for (const u of fb) assert.match(u, V4);
  assert.equal(new Set(fb).size, 500);
  assert.deepEqual(p2errors, []);
  await p3.close();
};
