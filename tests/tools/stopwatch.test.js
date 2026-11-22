const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Lap times, totals, the average (rounded half up), fastest and slowest laps,
// the CSV, the copied text and the page address come from
// tests/fixtures/stopwatch/expected.py (integer arithmetic on the press
// times), never from this page. The page's clock is Playwright's fake clock,
// so every press lands on an exact millisecond.
module.exports = async ({ page, open, assert, fixtures, url, base }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const T0 = new Date('2026-03-14T12:00:00Z').getTime();
  await page.clock.install({ time: T0 });
  await open();
  await page.clock.pauseAt(T0 + 5000);

  const text = s => page.locator(s).textContent();
  const display = async () => (await text('#sw-hms')) + (await text('#sw-ms'));
  const status = () => text('#sw-status');
  const off = s => page.getAttribute(s, 'aria-disabled');
  const hash = () => page.evaluate(() => location.hash);
  const rows = () => page.$$eval('#sw-rows tr:not(.sw-now)', trs => trs.map(tr => [tr.querySelector('.sw-n').textContent, tr.cells[1].textContent, tr.cells[2].textContent]));
  const tagOf = n => page.$$eval('#sw-rows tr:not(.sw-now)', (trs, n) => trs.find(tr => tr.querySelector('.sw-n').textContent === String(n)).querySelector('.sw-tag').textContent, n);
  const nowRow = () => page.$eval('#sw-rows tr.sw-now', tr => [tr.querySelector('.sw-n').textContent, tr.querySelector('.sw-tag').textContent, tr.cells[1].textContent, tr.cells[2].textContent]);
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur());
  const reopen = async h => { await page.goto('about:blank'); await page.goto(url + h); };
  const baseTitle = await page.title();

  // ---- Fresh page: zero, only Start works, the address is left alone. ----
  assert.equal(await display(), '00:00.000');
  assert.equal(await text('#sw-start'), 'Start');
  assert.equal(await off('#sw-lap'), 'true');
  assert.equal(await off('#sw-reset'), 'true');
  assert.equal(await page.isVisible('#sw-laps'), false);
  assert.equal(await hash(), '');
  assert.equal(await page.getAttribute('#sw-time', 'role'), 'timer');
  assert.equal(await page.getAttribute('#sw-time', 'aria-live'), null, 'the running digits are not announced');
  assert.equal(await page.$eval('.sw-keys', el => getComputedStyle(el).display), 'block', 'the key hint shows with a mouse and keyboard');
  // Lap and Reset are dimmed by colour, not opacity, which would fade the
  // focus ring too.
  await page.focus('#sw-start');
  await page.keyboard.press('Tab');
  const dim = await page.$eval('#sw-lap', el => {
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    const cs = getComputedStyle(el);
    return { focus: el.matches(':focus-visible'), op, ring: cs.outlineStyle + ' ' + cs.outlineColor, color: cs.color };
  });
  assert.ok(dim.focus && dim.op === 1 && /^solid rgb\(\d+, \d+, \d+\)$/.test(dim.ring), JSON.stringify(dim));
  assert.match(dim.color, / \/ 0\.5\)$/, 'the label is dimmed');
  // A contrast theme replaces those colours; Lap is then greyed with its GrayText.
  await page.emulateMedia({ forcedColors: 'active' });
  const [startInk, lapInk] = await page.$$eval('#sw-start, #sw-lap', els => els.map(e => getComputedStyle(e).color));
  assert.notEqual(lapInk, startInk, 'Lap still looks unavailable in a contrast theme');
  await page.emulateMedia({ forcedColors: 'none' });

  // ---- The guide's example from the keyboard: Space, then L three times. ----
  await blur();
  await page.keyboard.press('Space');
  assert.equal(await text('#sw-start'), 'Stop');
  assert.equal(await status(), 'Started.');
  assert.equal(await off('#sw-lap'), 'false');
  assert.equal(await off('#sw-reset'), 'true', 'no reset while running');
  await page.clock.fastForward(65123);
  await page.keyboard.press('l');
  assert.equal(await status(), 'Lap 1: 1 minute 5.123 seconds. Total 1 minute 5.123 seconds.');
  await page.clock.fastForward(61000);
  await page.keyboard.press('L'); // Caps Lock on
  assert.equal(await status(), 'Lap 2: 1 minute 1 second. Total 2 minutes 6.123 seconds.');
  await page.clock.fastForward(62500);
  await page.keyboard.press('l');
  // The tab title shows the running time.
  assert.equal(await page.title(), '3:08 · ' + baseTitle);
  // R while running is refused and changes nothing.
  await page.keyboard.press('r');
  assert.equal(await status(), 'Stop the stopwatch before you reset it.');
  await page.clock.fastForward(1500);
  await page.keyboard.press('Space');
  const G = X.guide;
  assert.equal(await display(), G.stopped);
  assert.equal(await status(), 'Stopped at 3 minutes 10.123 seconds.');
  assert.equal(await text('#sw-start'), 'Resume');
  assert.equal(await page.title(), '3:10 stopped · ' + baseTitle);
  assert.deepEqual(await rows(), G.table);
  assert.equal(await text('#sw-count'), '3');
  assert.equal(await text('#sw-avg'), G.average);
  assert.equal(await text('#sw-best'), G.fastest);
  assert.equal(await text('#sw-best-which'), 'lap ' + G.fastestLaps.join(', '));
  assert.equal(await text('#sw-worst'), G.slowest);
  assert.equal(await text('#sw-worst-which'), 'lap ' + G.slowestLaps.join(', '));
  assert.equal(await tagOf(2), 'Fastest');
  assert.equal(await tagOf(1), 'Slowest');
  assert.equal(await tagOf(3), '');
  assert.equal(await page.getAttribute('#sw-rows tr:not(.sw-now) .sw-fast', 'class'), 'sw-tag sw-fast');
  // Lap 4 is the lap in progress, ended by Stop.
  assert.deepEqual(await nowRow(), ['4', 'At stop', '00:01.500', G.stopped]);
  assert.equal(await text('#sw-sub'), 'Lap 4 · 00:01.500');
  assert.equal(await hash(), G.hash);

  // Download and copy: every recorded lap plus the lap that Stop ended.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sw-csv')]);
  assert.equal(dl.suggestedFilename(), 'stopwatch-laps.csv');
  assert.equal(fs.readFileSync(await dl.path(), 'utf8'), G.csv);
  assert.equal(await status(), 'Downloaded 4 laps.');
  await page.click('#sw-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), G.tsv);
  // Space on a focused button presses that button, not start/stop.
  await page.evaluate(() => navigator.clipboard.writeText('x'));
  await page.focus('#sw-copy');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), G.tsv);
  assert.equal(await text('#sw-start'), 'Resume');
  await blur();

  // ---- Presses count from the moment the button or key goes down. ----
  // The mouse is held 80 ms on Resume, then Lap is pressed with Space on the
  // focused button 920 ms after the release and held 50 ms.
  const box = await page.locator('#sw-start').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(80);
  await page.mouse.up();
  assert.equal(await status(), 'Resumed at 3 minutes 10.123 seconds.');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'sw-start', 'a mouse click leaves the focus where it was');
  await page.clock.fastForward(920);
  await page.focus('#sw-lap');
  await page.keyboard.down('Space');
  await page.clock.runFor(50);
  await page.keyboard.up('Space');
  await blur();
  await page.keyboard.press('Space');
  const M = X.more;
  assert.deepEqual(await rows(), M.table);
  assert.equal(await text('#sw-avg'), M.average, 'the average lap rounds half up');
  assert.equal(await text('#sw-best'), M.fastest);
  assert.equal(await text('#sw-best-which'), 'lap ' + M.fastestLaps.join(', '));
  assert.equal(await text('#sw-worst-which'), 'lap ' + M.slowestLaps.join(', '));
  assert.equal(await tagOf(2), '', 'lap 2 is no longer the fastest');
  assert.equal(await display(), M.stopped);
  assert.equal(await hash(), M.hash);

  // ---- Reset, and undo it. ----
  await page.keyboard.press('r');
  assert.equal(await display(), '00:00.000');
  assert.equal(await hash(), '');
  assert.equal(await page.isVisible('#sw-laps'), false);
  assert.equal(await text('#sw-reset'), 'Undo reset');
  assert.equal(await off('#sw-reset'), 'false');
  assert.equal(await page.title(), baseTitle);
  assert.equal(await status(), 'Reset to zero. Undo reset brings back 3 minutes 11.173 seconds and 4 laps.');
  await page.click('#sw-reset');
  assert.equal(await display(), M.stopped);
  assert.deepEqual(await rows(), M.table);
  assert.equal(await hash(), M.hash);
  assert.equal(await text('#sw-reset'), 'Reset');
  assert.equal(await status(), 'Restored 3 minutes 11.173 seconds and 4 laps.');
  await page.click('#sw-reset');
  await page.keyboard.press('Space'); // starting again drops the undo
  await page.keyboard.press('Space');
  assert.equal(await text('#sw-reset'), 'Reset');
  await page.keyboard.press('r');

  // ---- Keys with Ctrl, Cmd or Alt belong to the browser (Ctrl+L, Ctrl+R). ----
  await page.keyboard.press('Space');
  await page.clock.fastForward(1000);
  for (const k of ['Control+l', 'Meta+l', 'Alt+l', 'Control+f']) await page.keyboard.press(k);
  assert.equal(await page.locator('#sw-rows tr:not(.sw-now)').count(), 0, 'no lap from a browser shortcut');
  assert.equal(await page.$eval('#sw-panel', el => el.classList.contains('is-full')), false);
  // A touch that turns into a scroll (pointercancel) leaves no press time
  // behind for a later click that has none, such as a screen reader's.
  await page.dispatchEvent('#sw-lap', 'pointerdown', { button: 0, isPrimary: true, pointerType: 'touch' });
  await page.dispatchEvent('#sw-lap', 'pointercancel', { pointerType: 'touch' });
  await page.clock.fastForward(1000);
  await page.$eval('#sw-lap', b => b.click());
  assert.deepEqual(await rows(), [['1', '00:02.000', '00:02.000']]);
  await page.keyboard.press('Control+r');
  assert.equal(await text('#sw-start'), 'Stop', 'Ctrl+R is not R');
  await page.keyboard.press('Space');
  await page.keyboard.press('r');

  // ---- Background and sleep. A timestamp-based count needs only one frame
  // after a long gap. A sleeping device stops performance.now() but not the
  // time of day: the gap is added. Setting the clock back is ignored. ----
  await page.keyboard.press('Space');
  await page.clock.fastForward(2000);
  let wall = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(wall + 600000);
  await page.clock.runFor(100);
  wall = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(wall - 3600000);
  await page.clock.runFor(100);
  assert.equal(await page.title(), '10:02 · ' + baseTitle);
  await page.keyboard.press('Space');
  assert.equal(await display(), '10:02.200');

  // ---- A reload carries on from the page address. ----
  await page.keyboard.press('Space');
  await page.clock.fastForward(5000);
  const before = await hash();
  assert.match(before, /^#r\d{13}$/);
  await page.reload();
  assert.equal(await text('#sw-start'), 'Stop');
  await page.clock.fastForward(1000);
  await blur();
  await page.keyboard.press('Space');
  assert.equal(await display(), '10:08.200');
  await page.keyboard.press('r');

  // ---- Addresses: hours, broken or oversized ones, and the lap limit. ----
  await reopen('#p3725123');
  assert.equal(await display(), X.hours);
  assert.equal(await page.title(), '1:02:05 stopped · ' + baseTitle);
  await reopen('#p3599999999');
  assert.equal(await display(), X.longest);
  assert.ok(await page.$eval('#sw-time', el => el.classList.contains('is-long')));
  await reopen('#p%35000'); // percent-encoded digits are read
  assert.equal(await display(), '00:05.000');
  for (const bad of ['#hello', '#p5000;6000', '#x1', '#r', '#p-5', '#p5000;1,,2']) {
    await reopen(bad);
    assert.equal(await text('#sw-msg'), 'The stopwatch in the page address could not be read, so it starts from zero.', bad);
    assert.equal(await display(), '00:00.000', bad);
  }
  // More than 999:59:59.999, the most the digits hold on a phone 320 px wide,
  // is refused; so is a start time of 1970.
  for (const long of ['#p3600000000', '#r1', '#p9999999999999']) {
    await reopen(long);
    assert.equal(await text('#sw-msg'), 'The stopwatch in the page address has run for more than 999 hours, the most it shows, so it starts from zero.', long);
    assert.equal(await display(), '00:00.000', long);
  }
  // A stopwatch left running stops by itself at 999:59:59.999.
  const nowMs = await page.evaluate(() => Date.now());
  await reopen('#r' + (nowMs - 3599998000) + ';3599990000');
  assert.equal(await display(), '999:59:58.000');
  await page.clock.fastForward(1000);
  await page.clock.fastForward(1000);
  assert.equal(await display(), '999:59:59.999');
  assert.equal(await text('#sw-start'), 'Resume');
  assert.equal(await text('#sw-msg'), 'The stopwatch stopped at 999:59:59.999, the most it shows.');
  assert.equal(await hash(), '#p3599999999;3599990000');
  assert.deepEqual(await nowRow(), ['2', 'At stop', '00:09.999', '999:59:59.999']);
  // A link to a heading of the guide is a link, not a broken stopwatch.
  await reopen('#how-accurate-is-it');
  assert.equal(await text('#sw-msg'), '');
  assert.equal(await hash(), '#how-accurate-is-it');
  await page.waitForFunction(() => document.getElementById('how-accurate-is-it').getBoundingClientRect().top < innerHeight, null, { timeout: 3000 });
  await page.evaluate(() => { location.hash = '#lap-time-and-split-time'; });
  await page.waitForTimeout(50);
  assert.equal(await text('#sw-msg'), '');
  // Ties: every fastest lap is named.
  await reopen('#p5000;1000,2000,1000');
  assert.equal(await text('#sw-best-which'), 'laps 1 and 3');
  assert.equal(await text('#sw-worst-which'), 'lap 2');
  assert.equal(await tagOf(3), 'Fastest');
  await reopen('#p9000;1000,1000,1000,1000,5000');
  assert.equal(await text('#sw-best-which'), '4 laps');
  assert.equal(await page.locator('#sw-rows .sw-fast').count(), 4);
  // Over the limit, and a megabyte: refused at once, before any pattern runs.
  await reopen('#p1;' + '1,'.repeat(8000) + '1');
  assert.match(await text('#sw-msg'), /longer than 16,000 characters/);
  const t0 = Date.now();
  await reopen('#p1;' + '1,'.repeat(500000) + '1');
  assert.match(await text('#sw-msg'), /longer than 16,000 characters/);
  assert.ok(Date.now() - t0 < 5000, 'a megabyte address is refused quickly');
  // A changed address (a link or an edit) is read without a reload.
  await page.evaluate(() => { location.hash = '#p7000;1000,2000'; });
  await page.waitForFunction(() => document.querySelector('#sw-ms').textContent === '.000' && document.querySelector('#sw-hms').textContent === '00:07');
  assert.equal(await text('#sw-msg'), '');
  assert.deepEqual(await rows(), [['2', '00:02.000', '00:03.000'], ['1', '00:01.000', '00:01.000']]);
  // 1,000 laps is the most; more are refused with a message.
  await reopen('#p100000;' + Array(1000).fill(100).join(','));
  assert.equal(await text('#sw-count'), '1,000');
  assert.match(await text('#sw-msg'), /keeps up to 1,000 laps/);
  await blur();
  await page.keyboard.press('Space');
  assert.equal(await off('#sw-lap'), 'true');
  await page.keyboard.press('l');
  await page.click('#sw-lap', { force: true }); // aria-disabled, which Playwright waits on
  assert.equal(await text('#sw-count'), '1,000');
  assert.equal(await page.locator('#sw-rows tr').count(), 1001);
  // Equal laps: neither fastest nor slowest is marked.
  assert.equal(await text('#sw-best'), '–');
  assert.equal(await page.locator('#sw-rows .sw-fast, #sw-rows .sw-slow').count(), 0);
  await page.keyboard.press('Space');
  await page.keyboard.press('r');
  assert.equal(await text('#sw-msg'), '');

  // ---- Full screen: the panel fills the screen, the rest is inert. ----
  await page.click('#sw-full');
  await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === 'sw-panel');
  assert.equal(await text('#sw-full'), 'Exit full screen');
  assert.equal(await page.$eval('.site-header', el => el.inert), true);
  assert.equal(await page.$eval('#sw-status', el => el.inert), false);
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.$eval('.site-header', el => el.inert), false);
  assert.equal(await page.$eval('#sw-panel', el => el.classList.contains('is-full')), false);

  // ---- Keys belong to the page when focus is elsewhere. ----
  await page.focus('.faq summary');
  await page.keyboard.press('Space');
  assert.equal(await text('#sw-start'), 'Start');
  assert.equal(await page.$eval('.faq details', d => d.open), true);
  await blur();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.keyboard.press('Space');
  assert.equal(await text('#sw-start'), 'Start', 'Space scrolls the page when the stopwatch is off screen');
  await page.evaluate(() => window.scrollTo(0, 0));
  // Lap while stopped explains itself.
  await page.click('#sw-lap', { force: true }); // aria-disabled, which Playwright waits on
  assert.equal(await status(), 'Start the stopwatch to record laps.');

  // ---- Back and forward: the state is right again when the page returns. ----
  await page.keyboard.press('Space');
  await page.clock.fastForward(3000);
  await page.keyboard.press('Space');
  await page.goto(base + '/');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#sw-hms'));
  assert.equal(await display(), '00:03.000');
  assert.equal(await text('#sw-start'), 'Resume');
  await page.keyboard.press('r');

  // ---- A decimal-comma language: copied laps use its decimal mark, so a
  // German spreadsheet does not read 65.123 as 65123; the CSV keeps points. ----
  const de = await page.context().browser().newContext({ locale: 'de-DE', acceptDownloads: true });
  await de.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const dp = await de.newPage();
  await dp.goto(url + G.hash);
  await dp.click('#sw-copy');
  assert.equal(await dp.evaluate(() => navigator.clipboard.readText()), G.tsvComma);
  const [ddl] = await Promise.all([dp.waitForEvent('download'), dp.click('#sw-csv')]);
  assert.equal(fs.readFileSync(await ddl.path(), 'utf8'), G.csv);
  await de.close();

  // ---- No Fullscreen API (iPhone): the view fills the window; Esc leaves. ----
  const browser = page.context().browser();
  const ip = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const p2 = await ip.newPage();
  await p2.addInitScript(() => { delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; });
  await p2.goto(url);
  await p2.tap('#sw-full');
  assert.equal(await p2.$eval('#sw-panel', el => el.classList.contains('is-full')), true);
  assert.equal(await p2.evaluate(() => document.fullscreenElement), null);
  const r = await p2.$eval('#sw-panel', el => el.getBoundingClientRect().toJSON());
  assert.deepEqual([r.x, r.y, r.width, r.height], [0, 0, 390, 844]);
  await p2.keyboard.press('Escape');
  assert.equal(await p2.$eval('#sw-panel', el => el.classList.contains('is-full')), false);
  await ip.close();

  // ---- A phone with a touch screen: big enough buttons, laps by tapping. ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const pp = await phone.newPage();
  const outside = [];
  await pp.route('**/*', route => { if (!route.request().url().startsWith(base)) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
  await pp.goto(url);
  // The key hint is for keyboards; a touch screen does not show it.
  assert.equal(await pp.$eval('.sw-keys', el => getComputedStyle(el).display), 'none');
  for (const id of ['#sw-start', '#sw-lap', '#sw-reset', '#sw-full']) {
    const b = await pp.locator(id).boundingBox();
    assert.ok(b.height >= 44 && b.width >= 44, `${id} is ${b.width}x${b.height}`);
  }
  await pp.tap('#sw-start');
  await pp.waitForTimeout(250);
  await pp.tap('#sw-lap');
  await pp.waitForTimeout(150);
  await pp.tap('#sw-lap');
  await pp.tap('#sw-start');
  const prow = await pp.$$eval('#sw-rows tr:not(.sw-now)', trs => trs.map(tr => [tr.cells[1].textContent, tr.cells[2].textContent]));
  assert.equal(prow.length, 2);
  const ms = s => { const [m, rest] = s.split(':'); return Math.round((Number(m) * 60 + Number(rest)) * 1000); };
  assert.equal(ms(prow[0][1]), ms(prow[1][1]) + ms(prow[0][0]), 'total = previous total + lap time');
  assert.ok(ms(prow[1][0]) >= 200 && ms(prow[1][0]) < 5000, `first lap ${prow[1][0]}`);
  assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on the phone');
  assert.deepEqual(outside, []);
  // Quick taps on Lap are laps, not a double-tap zoom (iPhone).
  for (const id of ['#sw-start', '#sw-lap', '#sw-reset']) assert.equal(await pp.$eval(id, el => getComputedStyle(el).touchAction), 'manipulation', id);
  // 320 px: the laps table shows every column without scrolling sideways,
  // and no button breaks its label over two lines.
  await pp.setViewportSize({ width: 320, height: 640 });
  const oneLine = () => pp.$$eval('#sw-panel .btn', bs => bs.filter(b => b.getClientRects().length).map(b => {
    const r = document.createRange(); r.selectNodeContents(b);
    return [b.textContent, new Set([...r.getClientRects()].map(x => Math.round(x.top))).size];
  }).filter(x => x[1] > 1));
  const fits = () => pp.$eval('#sw-laps .table-wrap', w => w.scrollWidth <= w.clientWidth);
  await pp.goto(url + '#p3725123;65123,61000,62500');
  assert.ok(await fits(), 'the laps table fits 320 px');
  assert.deepEqual(await oneLine(), []);
  await pp.goto(url + '#p32523123;' + Array(9).fill(3500000).join(',') + ',500000');
  assert.ok(await fits(), 'the laps table fits 320 px with 9 hours of laps');
  await pp.tap('#sw-reset');
  assert.equal(await pp.textContent('#sw-reset'), 'Undo reset');
  assert.deepEqual(await oneLine(), []);
  await pp.tap('#sw-reset');
  await pp.tap('#sw-full');
  await pp.waitForFunction(() => document.querySelector('#sw-full').textContent === 'Exit full screen');
  assert.deepEqual(await oneLine(), []);
  await phone.close();
};
