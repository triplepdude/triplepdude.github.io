const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Known answers come from tests/fixtures/wheel-spinner/make_fixtures.py (exact fractions,
// chi-square thresholds, the link capacity worked out with Python's form encoder) or are
// worked out by hand in the comments. The random generator is driven from outside: an init
// script fills crypto.getRandomValues from a queue the test controls, so the mapping from
// random words to entries can be checked exactly, including the draws that must be refused.
const HOOKS = () => {
  const orig = Crypto.prototype.getRandomValues;
  window.__rq = [];
  window.__rcalls = 0;
  Crypto.prototype.getRandomValues = function (arr) {
    window.__rcalls++;
    const r = orig.call(this, arr);
    if (arr instanceof Uint32Array) for (let i = 0; i < arr.length && window.__rq.length; i++) arr[i] = window.__rq.shift();
    return r;
  };
  window.__osc = 0;
  const proto = (window.BaseAudioContext || window.AudioContext).prototype;
  const make = proto.createOscillator;
  proto.createOscillator = function () { window.__osc++; return make.call(this); };
  window.__mathRandom = 0;
  const mr = Math.random;
  Math.random = function () { window.__mathRandom++; return mr(); };
};

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const expected = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const BRIGHT = expected.bright;
  await page.addInitScript(HOOKS);
  await open();

  const text = sel => page.locator(sel).textContent();
  const wheel = () => page.$eval('#ws-wheel', c => ({ state: c.dataset.state, pick: c.dataset.pick, spins: c.dataset.spins, angle: c.dataset.angle, label: c.getAttribute('aria-label') }));
  const setList = t => page.fill('#ws-entries', t);
  const setRange = (sel, v) => page.$eval(sel, (el, x) => { el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
  const queue = words => page.evaluate(w => { window.__rq.push(...w); }, words.map(w => w >>> 0));
  const dialogOpen = () => page.$eval('#ws-dialog', d => d.open);
  const closeDialog = async () => { await page.click('#ws-dlg-close'); assert.equal(await dialogOpen(), false); };
  // Spins with the given random words queued and returns the name in the pop-up.
  const forced = async words => {
    await queue(words);
    await page.click('#ws-spin');
    await page.waitForSelector('#ws-dialog[open]');
    const name = await text('#ws-dlg-name');
    const chance = await text('#ws-dlg-chance');
    await closeDialog();
    return { name, chance };
  };
  // The canvas colour at 35% of the radius along the pointer's axis (3 o'clock), or at an
  // angle below (+) or above (-) that axis. Short labels end well outside that radius.
  const colourAt = (deg = 0, r = 0.35) => page.$eval('#ws-wheel', (c, a) => {
    const R = c.width / 2;
    const x = Math.round(R + R * a.r * Math.cos(a.deg * Math.PI / 180)), y = Math.round(R + R * a.r * Math.sin(a.deg * Math.PI / 180));
    const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  }, { deg, r });
  const near = (a, b) => [1, 3, 5].every(i => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 3);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  // Slice index under the pointer for equal slices, from the documented layout: at rotation 0
  // slice 0 starts at the pointer and the slices follow clockwise.
  const sliceAt = (angleDeg, n) => Math.floor((((-angleDeg % 360) + 360) % 360) / (360 / n));

  // ---------- First view: a sensible example, nothing in the address ----------
  const DEFAULT = 'Amara\nBen\nChloé\nDiego\nHana\nKofi\nLena\nOmar';
  assert.equal(await page.inputValue('#ws-entries'), DEFAULT);
  assert.equal(await text('#ws-count'), '8 entries');
  let w = await wheel();
  assert.equal(w.state, 'idle');
  assert.equal(w.label, 'Wheel with 8 entries: Amara, Ben, Chloé, Diego, Hana, Kofi, Lena, Omar.');
  assert.equal(await text('#ws-result'), 'Press Spin or click the wheel.');
  assert.equal(await page.isDisabled('#ws-undo'), true);
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.getAttribute('#ws-result', 'role'), 'status');
  // Slice 0 (Amara) starts at the pointer and runs clockwise (below the axis); the last slice
  // (Omar) ends there.
  assert.ok(near(await colourAt(10, 0.5), BRIGHT[0]), `below the pointer ${await colourAt(10, 0.5)}`);
  assert.ok(near(await colourAt(-10, 0.5), BRIGHT[7]), `above the pointer ${await colourAt(-10, 0.5)}`);

  // ---------- An animated spin: decided at the click, shown afterwards ----------
  await page.uncheck('#ws-confetti-on');
  await setRange('#ws-time', 1);
  assert.equal(await text('#ws-time-out'), '1 s');
  assert.equal(await page.getAttribute('#ws-time', 'aria-valuetext'), '1 second');
  const before = await page.evaluate(() => ({ calls: window.__rcalls, osc: window.__osc }));
  const t0 = Date.now();
  await page.click('#ws-spin');
  w = await wheel();
  assert.equal(w.state, 'spinning');
  assert.match(w.pick, /^[0-7]$/);
  const callsAtStart = await page.evaluate(() => window.__rcalls);
  assert.ok(callsAtStart > before.calls, 'the draw happens when Spin is pressed');
  // While it turns, the list is locked and a second press does nothing.
  assert.equal(await page.$eval('#ws-entries', t => t.readOnly), true);
  for (const b of ['#ws-shuffle', '#ws-sort', '#ws-clear', '#ws-open', '#ws-weights']) assert.equal(await page.isDisabled(b), true, `${b} locked while spinning`);
  assert.equal(await page.getAttribute('#ws-spin', 'aria-disabled'), 'true');
  await page.click('#ws-spin', { force: true });
  await page.click('#ws-wheel', { force: true });
  assert.equal((await wheel()).pick, w.pick, 'pressing again while it turns changes nothing');
  await page.waitForFunction(() => window.__osc > 0, null, { timeout: 2000 });
  assert.equal((await wheel()).state, 'spinning', 'ticks sound while the wheel turns');
  await page.waitForSelector('#ws-dialog[open]', { timeout: 4000 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1000 && elapsed < 2600, `a 1 s spin plus its pause took ${elapsed} ms`);
  w = await wheel();
  const names = DEFAULT.split('\n');
  assert.equal(w.state, 'done');
  assert.equal(w.spins, '1');
  assert.equal(await text('#ws-dlg-name'), names[+w.pick], 'the pop-up shows the entry drawn at the start');
  assert.equal(sliceAt(+w.angle, 8), +w.pick, 'the wheel rests on the drawn slice');
  assert.ok(near(await colourAt(), BRIGHT[+w.pick]), 'the colour under the pointer is the winner\'s slice');
  assert.equal(await page.evaluate(() => window.__rcalls), callsAtStart, 'no randomness after the start');
  assert.equal(await text('#ws-dlg-chance'), 'Chance ' + expected.eight_equal);
  assert.equal(await text('#ws-result'), `Spin 1: ${names[+w.pick]}`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ws-dlg-close');
  const osc = await page.evaluate(() => window.__osc) - before.osc;
  assert.ok(osc >= 8, `ticks and the win chime: ${osc} tones`);
  // The dialog is named by its heading, which includes the winner.
  assert.equal(await page.getAttribute('#ws-dialog', 'aria-labelledby'), 'ws-dlg-title');
  assert.equal((await text('#ws-dlg-title')).replace(/\s+/g, ' ').trim(), `The wheel picked ${names[+w.pick]}`);
  await page.keyboard.press('Escape');
  // The browser closes the pop-up on Escape in a task of its own, so wait for it.
  await page.waitForFunction(() => !document.querySelector('#ws-dialog').open && document.activeElement.id === 'ws-spin', null, { timeout: 2000 })
    .catch(() => assert.fail('Escape closes the pop-up and focus goes back to Spin'));
  assert.deepEqual(await page.$$eval('#ws-hist-list li', l => l.map(x => x.textContent)), [names[+w.pick]]);

  // The spin time setting is used: 2 s takes at least 2 s.
  await setRange('#ws-time', 2);
  const t1 = Date.now();
  await page.keyboard.press('Enter');
  assert.equal((await wheel()).state, 'spinning', 'Enter on the focused Spin button spins');
  await page.waitForSelector('#ws-dialog[open]', { timeout: 5000 });
  const elapsed2 = Date.now() - t1;
  assert.ok(elapsed2 >= 2000 && elapsed2 < 3600, `a 2 s spin took ${elapsed2} ms`);
  w = await wheel();
  assert.equal(sliceAt(+w.angle, 8), +w.pick);
  assert.ok(near(await colourAt(), BRIGHT[+w.pick]));
  await closeDialog();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ws-spin');
  // The focus ring shows on the Spin button when it is reached from the keyboard.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ws-spin');
  assert.notEqual(await page.$eval('#ws-spin', b => getComputedStyle(b).outlineStyle), 'none');
  // Space spins too; sound off means no tones.
  await page.uncheck('#ws-sound');
  await page.focus('#ws-spin');
  const oscOff = await page.evaluate(() => window.__osc);
  await setRange('#ws-time', 1);
  await page.focus('#ws-spin');
  await page.keyboard.press('Space');
  await page.waitForSelector('#ws-dialog[open]', { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__osc), oscOff, 'no sound when Sound is off');
  assert.equal(await text('#ws-result'), `Spin 3: ${await text('#ws-dlg-name')}`);
  await closeDialog();
  // Clicking the wheel spins as well.
  await page.click('#ws-wheel');
  assert.equal((await wheel()).state, 'spinning');
  await page.waitForSelector('#ws-dialog[open]', { timeout: 4000 });
  await closeDialog();

  // ---------- Exact mapping from random words to entries (no modulo bias) ----------
  await page.uncheck('#ws-animate');
  await setList('A\nB\nC');
  // 3 entries need 2 bits: the top two bits of a word, and 3 (binary 11) is refused.
  // 0xFFFFFFFF % 3 is 0, so the modulo shortcut would pick A here; an unbiased draw refuses
  // it and uses the next word, whose top bits are 01: B.
  assert.equal((await forced([0xFFFFFFFF, 0x7FFFFFFF])).name, 'B');
  assert.equal((await forced([0x00000000])).name, 'A');
  assert.equal((await forced([0x40000000])).name, 'B');
  assert.equal((await forced([0xBFFFFFFF])).name, 'C');
  assert.equal((await forced([0xC0000000, 0x80000000])).name, 'C');
  // Four refusals in a row: the page asks for more random words.
  assert.equal((await forced([0xFFFFFFFF, 0xFFFFFFFF, 0xC0000000, 0xD0000000, 0x00000001])).name, 'A');
  assert.equal((await forced([0x40000000])).chance, 'Chance ' + expected.three_equal);

  // Weights 1, 2 and 3 make a wheel of 6 units: 3 bits, values 6 and 7 refused.
  await page.check('#ws-weights');
  await setList('A *1\nB *2\nC *3');
  assert.equal(await text('#ws-count'), '3 entries, total weight 6');
  const unit = u => u * 2 ** 29;
  for (const [u, name] of [[0, 'A'], [1, 'B'], [2, 'B'], [3, 'C'], [5, 'C']]) assert.equal((await forced([unit(u)])).name, name, `unit ${u}`);
  assert.equal((await forced([unit(6), unit(7), unit(1)])).name, 'B');
  assert.equal((await forced([unit(4)])).chance, 'Weight 3, chance 1 in 2 (50%)');
  // Weights shrink the slices as well as the odds: B's slice is a third of the wheel.
  w = await wheel();
  assert.equal(w.label, 'Wheel with 3 entries: A, B, C.');

  // ---------- Fair in the long run (chi-square, threshold exceeded by chance once in 10^6) ----------
  const tally = n => page.evaluate(count => {
    const spin = document.querySelector('#ws-spin'), name = document.querySelector('#ws-dlg-name'), close = document.querySelector('#ws-dlg-close');
    const c = {};
    for (let i = 0; i < count; i++) {
      spin.click();
      c[name.textContent] = (c[name.textContent] || 0) + 1;
      close.click();
    }
    return c;
  }, n);
  const chi2 = (counts, probs, n) => Object.keys(probs).reduce((s, k) => s + ((counts[k] || 0) - n * probs[k]) ** 2 / (n * probs[k]), 0);
  const spinsBefore = +(await wheel()).spins;
  let counts = await tally(2400);
  let stat = chi2(counts, { A: 1 / 6, B: 2 / 6, C: 3 / 6 }, 2400);
  assert.ok(stat < expected.chi2.df2, `weighted 1:2:3 chi-square ${stat.toFixed(2)} ${JSON.stringify(counts)}`);
  await page.uncheck('#ws-weights');
  await setList('V\nW\nX\nY\nZ');
  counts = await tally(2000);
  stat = chi2(counts, { V: 0.2, W: 0.2, X: 0.2, Y: 0.2, Z: 0.2 }, 2000);
  assert.ok(stat < expected.chi2.df4, `5 equal entries chi-square ${stat.toFixed(2)} ${JSON.stringify(counts)}`);
  assert.equal(+(await wheel()).spins, spinsBefore + 4400);

  // Results list: one line per spin, copied with numbers; clearing starts again from 1.
  // The page lists the latest 200, numbered as spun; Copy results has all of them.
  const total = spinsBefore + 4400;
  assert.equal(await page.locator('#ws-hist-list li').count(), 200);
  assert.deepEqual(await page.$eval('#ws-hist-list', l => [l.firstElementChild.value, l.lastElementChild.value]), [total - 199, total]);
  assert.equal(await text('#ws-hist-note'), `Showing the last 200 of ${total.toLocaleString('en-GB')} results. Copy results copies them all.`);
  await page.click('#ws-hist-copy');
  const all = (await clipboard()).split('\n');
  assert.equal(all.length, total);
  assert.match(all[total - 1], new RegExp(`^${total}\\. [V-Z]$`));
  const lastShown = await page.$eval('#ws-hist-list', l => l.lastElementChild.textContent);
  assert.equal(all[total - 1], `${total}. ${lastShown}`);
  await page.waitForFunction(() => document.querySelector('#ws-hist-list').getAttribute('tabindex') === '0');
  assert.ok(await page.$eval('#ws-hist-list', l => l.scrollTop > 0 && l.scrollTop + l.clientHeight >= l.scrollHeight - 2), 'the newest result is in view');
  await page.click('#ws-hist-clear');
  assert.equal(await page.isHidden('#ws-hist'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ws-spin');
  assert.equal((await wheel()).spins, '0');
  assert.equal(await text('#ws-result'), 'Press Spin or click the wheel.');
  assert.equal((await forced([0x00000000])).name, 'V');
  // 5 entries need 3 bits: 0xFFFFFFFF (top bits 111) is refused, 0x80000000 (100) is Z.
  assert.equal((await forced([0xFFFFFFFF, 0x80000000])).name, 'Z');
  assert.equal(await text('#ws-result'), 'Spin 2: Z');
  await page.click('#ws-hist-copy');
  assert.equal(await clipboard(), '1. V\n2. Z');

  // A wheel of one always lands on it.
  await setList('Solo');
  const solo = await forced([]);
  assert.deepEqual(solo, { name: 'Solo', chance: 'Chance 1 in 1 (100%)' });

  // ---------- Remove from wheel removes exactly the line that won ----------
  await setList('Ann\nBob\nAnn');
  await queue([0x80000000]);
  await page.click('#ws-spin');
  assert.equal(await text('#ws-dlg-name'), 'Ann');
  await page.click('#ws-dlg-remove');
  assert.equal(await dialogOpen(), false);
  assert.equal(await page.inputValue('#ws-entries'), 'Ann\nBob', 'the second Ann (line 3) goes, the first stays');
  assert.equal(await text('#ws-undo'), 'Undo remove');
  await page.click('#ws-undo');
  assert.equal(await page.inputValue('#ws-entries'), 'Ann\nBob\nAnn');
  // Blank lines and the rest of the text are left exactly as typed.
  await setList('Ann\n\n  Bob  \n\nCid\n');
  await queue([0x80000000]);
  await page.click('#ws-spin');
  assert.equal(await text('#ws-dlg-name'), 'Cid');
  await page.click('#ws-dlg-remove');
  assert.equal(await page.inputValue('#ws-entries'), 'Ann\n\n  Bob  \n\n');
  assert.equal(await text('#ws-count'), '2 entries');
  // "Spin again" closes the pop-up and spins at once.
  await setList('Yes\nNo');
  await queue([0x00000000]);
  await page.click('#ws-spin');
  await queue([0x80000000]);
  await page.click('#ws-dlg-again');
  assert.equal(await text('#ws-dlg-name'), 'No');
  await closeDialog();

  // ---------- Weights: forms that are accepted ----------
  await page.check('#ws-weights');
  await setList('Pizza *3\nSushi *2\nTacos');
  for (const [word, name] of [[0x00000000, 'Pizza'], [0x60000000, 'Sushi'], [0xA0000000, 'Tacos']]) {
    const r = await forced([word]);
    assert.equal(r.name, name);
    assert.ok(r.chance.endsWith(expected.guide_table[name]), `${name}: ${r.chance} (guide: ${expected.guide_table[name]})`);
  }
  // A decimal point or a decimal comma, with or without a space after the star: 1.5, 1 and
  // 0.25 are 6, 4 and 1 out of 11. 11 entries need 4 bits; 11 to 15 are refused.
  await setList('Pizza *1.5\nSushi\t1\nTacos * 0,25');
  assert.equal(await text('#ws-count'), '3 entries, total weight 2.75');
  assert.equal((await forced([0x00000000])).chance, 'Weight 1.5, chance ' + expected.decimal_weights.Pizza);
  assert.equal((await forced([0x60000000])).chance, 'Weight 1, chance ' + expected.decimal_weights.Sushi);
  assert.equal((await forced([0xB0000000, 0xF0000000, 0xA0000000])).chance, 'Weight 0.25, chance ' + expected.decimal_weights.Tacos);
  await setList('Big *1000\nSmall *0.01\nM*A*S*H\nRoom 101');
  assert.equal(await text('#ws-count'), '4 entries, total weight 1,002.01');
  assert.equal(await page.$eval('#ws-entries', t => t.getAttribute('aria-invalid')), null);
  // With weights off, the same lines are names, and the page says what it noticed.
  await page.uncheck('#ws-weights');
  await setList('Pizza *3\nSushi\tTwo\nTacos\t2');
  assert.equal(await text('#ws-count'), '3 entries. 2 lines end in what look like weights; tick Use weights to use them.');
  assert.equal((await forced([0x00000000])).name, 'Pizza *3');
  assert.equal((await forced([0x40000000])).name, 'Sushi Two', 'a tab inside a name shows as a space');
  await page.check('#ws-weights');
  assert.equal(await text('#ws-count'), '3 entries, total weight 6');

  // ---------- Weights: each error names its line, marks the box and blocks the spin ----------
  const errorFor = async (list, re) => {
    await setList(list);
    assert.match(await text('#ws-entries-msg'), re);
    assert.equal(await page.getAttribute('#ws-entries', 'aria-invalid'), 'true');
    assert.ok((await page.getAttribute('#ws-entries', 'aria-describedby')).split(' ').includes('ws-entries-msg'));
    const spins = (await wheel()).spins;
    await page.click('#ws-spin');
    assert.equal(await dialogOpen(), false);
    assert.equal((await wheel()).spins, spins);
    assert.match(await text('#ws-spin-msg'), /^Fix the list first: /);
  };
  await errorFor('Cake *1,000', /^Line 1: “1,000” is not a weight .*no thousands separators/);
  await errorFor('Cake *1.234', /^Line 1: “1\.234” is not a weight/);
  await errorFor('Ok\n\nCake *0', /^Line 3: a weight of 0 means “Cake” could never win/);
  await errorFor('Cake *1001', /^Line 1: weights go up to 1000\.$/);
  await errorFor('Pie\n*3', /^Line 2 has a weight but no name before it\.$/);
  await errorFor('Cake *2x', /^Line 1: “2x” is not a weight/);
  // Fixing the line clears the error, the red edge and the spin message.
  await setList('Cake *2');
  assert.equal(await text('#ws-entries-msg'), '');
  assert.equal(await page.getAttribute('#ws-entries', 'aria-invalid'), null);
  assert.equal(await text('#ws-spin-msg'), '');
  await page.uncheck('#ws-weights');

  // ---------- Decimal comma or point does not depend on the browser's language ----------
  for (const locale of ['de-DE', 'en-US']) {
    const ctx = await page.context().browser().newContext({ locale });
    const p = await ctx.newPage();
    await p.goto(url + '#w=1&e=' + encodeURIComponent('A *1,5\nB *1.5\nC *1,25'));
    assert.equal(await p.textContent('#ws-count'), '3 entries, total weight 4.25', locale);
    await p.fill('#ws-entries', Array.from({ length: 1200 }, (_, i) => 'n' + i).join('\n'));
    assert.equal(await p.textContent('#ws-count'), '1,200 entries, total weight 1,200', locale);
    await ctx.close();
  }

  // ---------- Shuffle, sort, quick lists, clear, undo ----------
  await setList(DEFAULT);
  // Every draw 0: the Fisher-Yates shuffle swaps each position with the first, which turns
  // the list one place to the left. 7 draws of 4 words each.
  await queue(Array(28).fill(0));
  await page.click('#ws-shuffle');
  assert.equal(await page.inputValue('#ws-entries'), 'Ben\nChloé\nDiego\nHana\nKofi\nLena\nOmar\nAmara');
  assert.equal(await text('#ws-undo'), 'Undo shuffle');
  await page.click('#ws-undo');
  assert.equal(await page.inputValue('#ws-entries'), DEFAULT);
  await setList('b\n\n10\nÄrger\n2\nalpha\nZeta\n1\n');
  await page.click('#ws-shuffle');
  const shuffled = (await page.inputValue('#ws-entries')).split('\n');
  assert.deepEqual([...shuffled].sort(), ['1', '10', '2', 'Zeta', 'alpha', 'b', 'Ärger'], 'same lines, blank ones dropped');
  await page.click('#ws-sort');
  assert.equal(await page.inputValue('#ws-entries'), '1\n2\n10\nalpha\nÄrger\nb\nZeta', 'numbers in order, case and accents ignored');
  assert.equal(await text('#ws-undo'), 'Undo sort');
  await page.check('#ws-weights');
  await setList('Pizza *3\nApple *2\nMango');
  await page.click('#ws-sort');
  assert.equal(await page.inputValue('#ws-entries'), 'Apple *2\nMango\nPizza *3', 'sorted by name, weights kept');
  await page.uncheck('#ws-weights');
  await page.click('.ws-quick [data-preset="yesno"]');
  assert.equal(await page.inputValue('#ws-entries'), 'Yes\nNo');
  assert.equal(await text('#ws-count'), '2 entries');
  await page.click('.ws-quick [data-preset="maybe"]');
  assert.equal(await page.inputValue('#ws-entries'), 'Yes\nNo\nMaybe');
  await page.click('.ws-quick [data-preset="ten"]');
  assert.equal(await page.inputValue('#ws-entries'), Array.from({ length: 10 }, (_, i) => i + 1).join('\n'));
  assert.equal(await text('#ws-undo'), 'Undo quick list');
  // 1 to 10: the forced pick 9 is "10" (the top 4 bits are 9), and its slice sits under the pointer.
  assert.equal((await forced([0x90000000])).name, '10');
  w = await wheel();
  assert.equal(sliceAt(+w.angle, 10), 9);
  assert.ok(near(await colourAt(), BRIGHT[1]), '10th slice of 10 uses colour 2 of 8');
  await page.click('#ws-undo');
  await page.click('#ws-undo');
  assert.equal(await page.inputValue('#ws-entries'), 'Yes\nNo');
  await page.click('.ws-quick [data-preset="names"]');
  assert.equal(await page.inputValue('#ws-entries'), DEFAULT);
  // The last slice never shares a colour with the first: 9 entries, slice 9 takes colour 2.
  await setList('a\nb\nc\nd\ne\nf\ng\nh\ni');
  assert.equal((await forced([0x80000000])).name, 'i');
  assert.ok(near(await colourAt(), BRIGHT[1]), `9th slice colour ${await colourAt()}`);
  // Clear, then Spin explains why nothing happens; Undo brings the list back.
  await page.click('#ws-clear');
  assert.equal(await page.inputValue('#ws-entries'), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ws-entries');
  assert.equal(await text('#ws-count'), 'No entries yet');
  assert.equal((await wheel()).label, 'Empty wheel. Add entries to the list to spin it.');
  await page.click('#ws-spin');
  assert.equal(await text('#ws-spin-msg'), 'Add at least one entry to the list first.');
  assert.equal(await dialogOpen(), false);
  await page.click('#ws-undo');
  assert.equal(await page.inputValue('#ws-entries'), 'a\nb\nc\nd\ne\nf\ng\nh\ni');
  assert.equal(await text('#ws-spin-msg'), '');

  // ---------- Colours: the theme repaints the wheel ----------
  await setList('Yes\nNo');
  await page.selectOption('#ws-theme', 'mono');
  assert.equal((await forced([0x00000000])).name, 'Yes');
  assert.ok(near(await colourAt(), '#111111'));
  assert.equal((await forced([0x80000000])).name, 'No');
  assert.ok(near(await colourAt(), '#f2f2f2'));
  await page.selectOption('#ws-theme', 'bright');
  assert.ok(near(await colourAt(), BRIGHT[1]));
  // The pointer follows the colour scheme (dark fill on a light page, light on a dark one).
  const pointer = () => page.$eval('#ws-wheel', c => {
    const R = c.width / 2, d = c.getContext('2d').getImageData(Math.round(R + R * 0.93), Math.round(R), 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  });
  assert.ok(near(await pointer(), '#16181d'), `pointer ${await pointer()}`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => {
    const c = document.querySelector('#ws-wheel'), R = c.width / 2;
    return c.getContext('2d').getImageData(Math.round(R + R * 0.93), Math.round(R), 1, 1).data[0] > 200;
  });
  assert.ok(near(await pointer(), '#eceef1'), `dark pointer ${await pointer()}`);
  await page.emulateMedia({ colorScheme: 'light' });

  // ---------- The page address keeps the wheel ----------
  const waitHash = h => page.waitForFunction(x => location.hash === x, h, { timeout: 3000 });
  // Settings at their defaults stay out of the address.
  await setRange('#ws-time', 5);
  await page.check('#ws-sound');
  await page.check('#ws-confetti-on');
  await setList('Amara\nBen\nChloé');
  await waitHash('#' + expected.example_hash);
  await page.uncheck('#ws-confetti-on');
  await page.check('#ws-weights');
  await page.selectOption('#ws-theme', 'pastel');
  await setRange('#ws-time', 7);
  await page.uncheck('#ws-sound');
  const hashState = '#' + new URLSearchParams({ e: 'Amara\nBen\nChloé', w: '1', t: 'pastel', d: '7', s: '0', c: '0' }).toString();
  await waitHash(hashState);
  await page.reload();
  assert.equal(await page.inputValue('#ws-entries'), 'Amara\nBen\nChloé');
  assert.equal(await page.isChecked('#ws-weights'), true);
  assert.equal(await page.inputValue('#ws-theme'), 'pastel');
  assert.equal(await page.inputValue('#ws-time'), '7');
  assert.equal(await text('#ws-time-out'), '7 s');
  assert.equal(await page.isChecked('#ws-sound'), false);
  assert.equal(await page.isChecked('#ws-confetti-on'), false);
  assert.equal(await text('#ws-count'), '3 entries, total weight 3');
  // Copy link right after typing copies the new list, not the one from before the pause.
  await page.fill('#ws-entries', 'Fresh\nList');
  await page.click('#ws-copy-link');
  const copied = await clipboard();
  assert.equal(copied, page.url());
  assert.equal(new URLSearchParams(new URL(copied).hash.slice(1)).get('e'), 'Fresh\nList');
  // Back to the defaults: the address is clean again.
  await page.click('.ws-quick [data-preset="names"]');
  await page.uncheck('#ws-weights');
  await page.selectOption('#ws-theme', 'bright');
  await setRange('#ws-time', 5);
  await page.check('#ws-sound');
  await page.check('#ws-confetti-on');
  await page.waitForFunction(() => location.hash === '');
  // One limit for writing and reading: a list whose address is exactly 16,000 characters is
  // kept and read back; one character more is refused, and the page says so.
  const lines = [];
  while (new URLSearchParams({ e: lines.concat('abcdefghij').join('\n') }).toString().length <= 16000) lines.push('abcdefghij');
  let atLimit = lines.join('\n');
  while (new URLSearchParams({ e: atLimit }).toString().length < 16000) atLimit += 'x';
  assert.equal(new URLSearchParams({ e: atLimit }).toString().length, 16000);
  await page.$eval('#ws-entries', (t, v) => { t.value = v; t.dispatchEvent(new Event('input', { bubbles: true })); }, atLimit);
  await page.waitForFunction(() => location.hash.length === 16001, null, { timeout: 3000 });
  assert.equal(await text('#ws-link-msg'), '');
  await page.reload();
  assert.equal(await page.inputValue('#ws-entries'), atLimit);
  await page.$eval('#ws-entries', (t, v) => { t.value = v; t.dispatchEvent(new Event('input', { bubbles: true })); }, atLimit + 'y');
  await page.waitForFunction(() => /too long to keep in the page address: it needs 16,001 characters and the limit is 16,000/.test(document.querySelector('#ws-link-msg').textContent));
  await page.waitForFunction(() => location.hash === '');
  await page.click('#ws-copy-link');
  assert.equal(await clipboard(), copied, 'Copy link does not copy a link that cannot hold the list');
  assert.equal(await page.getAttribute('#ws-copy-link', 'aria-describedby'), 'ws-link-hint ws-link-msg');
  // A longer link made by hand is refused with a message, and the example list is shown.
  // (about:blank first: a goto that only changes the hash would not load the page again.)
  await page.goto('about:blank');
  await page.goto(url + '#e=' + 'x'.repeat(15999));
  assert.match(await text('#ws-link-msg'), /^This link is 16,001 characters long, more than the 16,000/);
  assert.equal(await page.inputValue('#ws-entries'), DEFAULT);
  // Unknown or broken settings fall back to the defaults; Windows line ends are read.
  await page.goto('about:blank');
  await page.goto(url + '#t=neon&d=99&e=A%0D%0AB');
  assert.equal(await page.inputValue('#ws-theme'), 'bright');
  assert.equal(await page.inputValue('#ws-time'), '5');
  assert.equal(await text('#ws-count'), '2 entries');
  await page.goto('about:blank');
  await page.goto(url + '#ws-entries');
  assert.equal(await page.inputValue('#ws-entries'), DEFAULT, 'an ordinary #fragment is not a wheel');
  // A link pasted into the same tab loads without a reload.
  await page.evaluate(() => { location.hash = '#e=One%0ATwo'; });
  await page.waitForFunction(() => document.querySelector('#ws-entries').value === 'One\nTwo');
  assert.equal(await text('#ws-count'), '2 entries');
  assert.equal(await text('#ws-undo'), 'Undo link');
  await page.click('#ws-undo');
  assert.equal(await page.inputValue('#ws-entries'), DEFAULT, 'the list from before the link comes back');

  // ---------- Back button and fields restored late by the browser ----------
  await setList('Back\nForward');
  await waitHash('#e=Back%0AForward');
  await page.goto(base + '/');
  await page.goBack();
  assert.equal(await page.inputValue('#ws-entries'), 'Back\nForward');
  assert.equal(await text('#ws-count'), '2 entries');
  await page.evaluate(() => {
    document.querySelector('#ws-entries').value = 'P\nQ\nR';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await text('#ws-count'), '3 entries');
  assert.equal((await wheel()).label, 'Wheel with 3 entries: P, Q, R.');

  // ---------- Huge pastes stay responsive and are refused before any pattern runs ----------
  await page.uncheck('#ws-animate');
  const paste = v => page.$eval('#ws-entries', (t, s) => {
    t.value = s;
    const t0 = performance.now();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return performance.now() - t0;
  }, v);
  let ms = await paste('name\n'.repeat(210000));
  assert.ok(ms < 100, `input handler took ${ms} ms`);
  await page.waitForFunction(() => /^The list is 1,050,000 characters long\. The wheel reads up to 300,000/.test(document.querySelector('#ws-entries-msg').textContent));
  assert.equal(await page.getAttribute('#ws-entries', 'aria-invalid'), 'true');
  let t2 = Date.now();
  await page.click('#ws-spin');
  assert.ok(Date.now() - t2 < 1500, 'Spin answers at once');
  assert.match(await text('#ws-spin-msg'), /^Fix the list first: The list is 1,050,000 characters long/);
  ms = await paste(' '.repeat(1048576) + '*1');
  assert.ok(ms < 100);
  await page.waitForFunction(() => /^The list is 1,048,578 characters long/.test(document.querySelector('#ws-entries-msg').textContent));
  assert.equal((await wheel()).label, 'Empty wheel. Fix the list to spin it.');
  await paste('ab\n'.repeat(12000));
  await page.waitForFunction(() => document.querySelector('#ws-entries-msg').textContent === 'The list has 12,000 entries. The wheel holds up to 10,000, so remove some lines to spin.');
  assert.equal((await wheel()).label, 'Empty wheel. Fix the list to spin it.', 'no part of a list over the limit is drawn');
  assert.equal(await text('#ws-count'), '12,000 entries');
  // 10,000 entries draw quickly and spin.
  t2 = Date.now();
  await paste(Array.from({ length: 10000 }, (_, i) => String(i + 1)).join('\n'));
  await page.waitForFunction(() => document.querySelector('#ws-count').textContent === '10,000 entries');
  assert.ok(Date.now() - t2 < 2000, `10,000 entries took ${Date.now() - t2} ms`);
  assert.equal(await text('#ws-entries-msg'), '');
  assert.match((await wheel()).label, /^Wheel with 10,000 entries: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 and 9,988 more\.$/);
  // 10,000 needs 14 bits; 0x9C3C0000 >>> 18 is 9999, the last entry.
  assert.equal((await forced([0x9C3C0000])).name, '10000');
  // A long run of spaces before a star (weights on) is read in linear time.
  await page.check('#ws-weights');
  ms = await page.$eval('#ws-entries', t => {
    t.value = 'x' + ' '.repeat(250000) + '*' + ' '.repeat(40000) + '2';
    const t0 = performance.now();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#ws-spin').click();
    return performance.now() - t0;
  });
  assert.ok(ms < 500, `long spaces took ${ms} ms`);
  assert.equal(await text('#ws-dlg-name'), 'x');
  await closeDialog();
  await page.uncheck('#ws-weights');

  // ---------- Text is never cut inside an emoji ----------
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  await setList(family.repeat(45) + '\nB\u0301ob');
  const label = (await wheel()).label;
  assert.equal(label, `Wheel with 2 entries: ${family.repeat(40)}…, B\u0301ob.`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label), 'no lone surrogate');
  const longName = 'L' + 'é'.repeat(400);
  await setList(longName + '\nShort');
  assert.equal((await forced([0x00000000])).name, 'L' + 'é'.repeat(299) + '…');
  await page.click('#ws-hist-copy');
  assert.ok((await clipboard()).endsWith(longName), 'Copy results keeps the whole entry');

  // ---------- Opening and dropping text files (BOM, UTF-16, Windows-1252, not text) ----------
  await setList('Keep\nMe');
  await page.setInputFiles('#ws-file', path.join(fixtures, 'utf8-bom.txt'));
  await page.waitForFunction(() => document.querySelector('#ws-entries').value.startsWith('Zo'));
  assert.equal(await page.inputValue('#ws-entries'), 'Zoë\nŁukasz\n王芳\nAna *2');
  assert.equal(await text('#ws-undo'), 'Undo open');
  await page.click('#ws-undo');
  assert.equal(await page.inputValue('#ws-entries'), 'Keep\nMe');
  await page.setInputFiles('#ws-file', path.join(fixtures, 'utf16le.txt'));
  await page.waitForFunction(() => document.querySelector('#ws-entries').value.startsWith('Zo'));
  assert.equal(await page.inputValue('#ws-entries'), 'Zoë\nŁukasz\n王芳\nAna *2');
  await page.setInputFiles('#ws-file', path.join(fixtures, 'cp1252.txt'));
  await page.waitForFunction(() => document.querySelector('#ws-entries').value.startsWith('Ren'));
  assert.equal(await page.inputValue('#ws-entries'), 'Renée\nJosé');
  await page.setInputFiles('#ws-file', path.join(fixtures, 'photo.png'));
  await page.waitForFunction(() => document.querySelector('#ws-file-msg').textContent !== '');
  assert.equal(await text('#ws-file-msg'), 'photo.png is not a plain text file. Save the list as .txt, or copy and paste it.');
  assert.equal(await page.getAttribute('#ws-open', 'aria-describedby'), 'ws-file-msg');
  assert.equal(await page.inputValue('#ws-entries'), 'Renée\nJosé');
  // A Word file (a ZIP archive) is refused as well; a text file that merely starts like an
  // image is still opened.
  await page.setInputFiles('#ws-file', { name: 'list.docx', mimeType: 'application/octet-stream', buffer: Buffer.concat([Buffer.from('PK\u0003\u0004\u0014\u0000\u0006\u0000'), Buffer.alloc(64)]) });
  await page.waitForFunction(() => /^list\.docx is not a plain text file/.test(document.querySelector('#ws-file-msg').textContent));
  await page.setInputFiles('#ws-file', { name: 'odd.txt', mimeType: 'text/plain', buffer: Buffer.from('PNG party\nGIF night\n') });
  await page.waitForFunction(() => document.querySelector('#ws-entries').value === 'PNG party\nGIF night');
  assert.equal(await text('#ws-file-msg'), '');
  await page.click('#ws-undo');
  // Dropped on the box it opens; dropped beside it, the page does not navigate away.
  const pageUrl = page.url();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['\uFEFFDropped\r\nList\r\n'], 'drop.txt', { type: 'text/plain' }));
    const box = document.querySelector('#ws-entries');
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#ws-entries').value === 'Dropped\nList');
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('h1').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert.equal(prevented, true);
  assert.equal(page.url(), pageUrl);

  // ---------- Full screen ----------
  await setList('Yes\nNo');
  const small = await page.$eval('#ws-wheel', c => c.getBoundingClientRect().width);
  await page.click('#ws-full');
  assert.equal(await text('#ws-full'), 'Exit full screen');
  assert.equal(await page.$eval('#ws-stage', s => s.classList.contains('is-full')), true);
  await page.waitForFunction(w0 => document.querySelector('#ws-wheel').getBoundingClientRect().width > w0, small);
  // The pop-up shows above the full-screen wheel.
  await queue([0x00000000]);
  await page.click('#ws-spin');
  const onTop = await page.evaluate(() => {
    const r = document.querySelector('#ws-dlg-close').getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).id;
  });
  assert.equal(onTop, 'ws-dlg-close');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#ws-dialog').open);
  await page.waitForTimeout(100);
  assert.equal(await page.$eval('#ws-stage', s => s.classList.contains('is-full')), true, 'Esc closes the pop-up first');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#ws-stage').classList.contains('is-full'));
  assert.equal(await text('#ws-full'), 'Full screen');

  // ---------- Live region: one new announcement per spin, even for the same winner ----------
  await page.evaluate(() => {
    window.__live = 0;
    new MutationObserver(() => window.__live++).observe(document.querySelector('#ws-result'), { childList: true, characterData: true, subtree: true });
  });
  await forced([0x00000000]);
  await forced([0x00000000]);
  assert.equal(await page.evaluate(() => window.__live), 2);
  assert.match(await text('#ws-result'), /^Spin \d+: Yes$/);

  // Nothing on the page used Math.random.
  assert.equal(await page.evaluate(() => window.__mathRandom), 0);

  // ---------- Reduced motion: no turning, no confetti, unless asked for ----------
  {
    const ctx = await page.context().browser().newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(url);
    assert.equal(await p.isChecked('#ws-animate'), false);
    assert.equal(await p.isVisible('#ws-motion-hint'), true);
    await p.click('#ws-spin');
    assert.equal(await p.$eval('#ws-dialog', d => d.open), true, 'the result shows at once');
    assert.equal(await p.$eval('#ws-confetti', c => c.width), 300, 'no confetti was drawn');
    await p.click('#ws-dlg-close');
    await p.check('#ws-animate');
    await p.click('#ws-spin');
    assert.equal(await p.$eval('#ws-wheel', c => c.dataset.state), 'spinning');
    await ctx.close();
  }

  // ---------- Phone with touch: tap to spin, 44 px targets, no text cut off ----------
  {
    const ctx = await page.context().browser().newContext({ ...devices['Pixel 7'] });
    const p = await ctx.newPage();
    await p.goto(url + '#d=1');
    await p.locator('#ws-wheel').tap();
    assert.equal(await p.$eval('#ws-wheel', c => c.dataset.state), 'spinning');
    await p.waitForSelector('#ws-dialog[open]', { timeout: 4000 });
    for (const sel of ['#ws-dlg-again', '#ws-dlg-remove', '#ws-dlg-close']) {
      const h = (await p.locator(sel).boundingBox()).height;
      assert.ok(h >= 44, `${sel} is ${h} px tall`);
    }
    await p.locator('#ws-dlg-remove').tap();
    assert.equal(await p.textContent('#ws-count'), '7 entries');
    for (const sel of ['#ws-spin', '#ws-full', '#ws-shuffle', '#ws-sort', '#ws-clear', '#ws-open', '#ws-copy-link', '.ws-quick button >> nth=0', '#ws-theme', '#ws-time', 'label.check >> nth=0']) {
      const h = (await p.locator(sel).boundingBox()).height;
      assert.ok(h >= 44, `${sel} is ${h} px tall on a touch screen`);
    }
    assert.ok(await p.$eval('#ws-entries', t => parseFloat(getComputedStyle(t).fontSize)) >= 16);
    // Button and select text fits at common phone widths.
    for (const width of [320, 340, 360, 390, 414, 480, 540]) {
      await p.setViewportSize({ width, height: 800 });
      const cut = await p.evaluate(() => {
        const out = [];
        const m = document.createElement('canvas').getContext('2d');
        for (const b of document.querySelectorAll('.ws button')) {
          if (!b.getClientRects().length) continue;
          if (b.scrollWidth > b.clientWidth + 1) out.push(b.id || b.textContent);
        }
        for (const s of document.querySelectorAll('.ws select')) {
          const cs = getComputedStyle(s);
          m.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const need = Math.max(...[...s.options].map(o => m.measureText(o.text).width));
          const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
          if (need > room) out.push(`${s.id} needs ${Math.ceil(need)} of ${Math.floor(room)}`);
        }
        return out;
      });
      assert.deepEqual(cut, [], `text cut off at ${width} px`);
      assert.ok(await p.evaluate(w => document.documentElement.scrollWidth <= w, width), `no sideways scroll at ${width} px`);
    }
    await ctx.close();
  }

  // Leave a result, a long entry and its list on screen for the runner's narrow-screen checks.
  await page.setViewportSize({ width: 1280, height: 900 });
  await setList('A very long entry ' + 'x'.repeat(200) + '\n' + 'Ninety-nine red balloons go by');
  await forced([0x00000000]);
  assert.equal(await page.isVisible('#ws-hist'), true);
};
