// Decoder answers use the RFC 9562 Appendix A test vectors (v1, v4, v6, v7,
// v8 all encode 2022-02-22T19:22:22Z) and values computed independently with
// Python's uuid module (uuid3/uuid5 of www.example.com in the DNS namespace,
// the 128-bit integers, the DNS namespace UUID's own v1 timestamp).
const fs = require('fs');

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

  // Without crypto.randomUUID (older browsers, pages not served over HTTPS)
  // the page falls back to getRandomValues and must still set the bits.
  const p2 = await page.context().newPage();
  const p2errors = [];
  p2.on('pageerror', e => p2errors.push(e.message));
  await p2.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }); });
  await p2.goto(page.url());
  assert.equal(await p2.evaluate(() => typeof crypto.randomUUID), 'undefined');
  await p2.fill('#uu-count', '500');
  const fb = (await p2.inputValue('#uu-out')).split('\n');
  assert.equal(fb.length, 500);
  for (const u of fb) assert.match(u, V4);
  assert.equal(new Set(fb).size, 500);
  assert.deepEqual(p2errors, []);
  await p2.close();
};
