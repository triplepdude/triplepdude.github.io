// Expected values come from the UI Events spec and the legacy keyCode table
// (a = 65, Shift = 16, Enter = 13, Escape = 27) and from counting a standard
// ANSI board: 104 keys full-size, 87 tenkeyless, 61 for a 60% board.
module.exports = async ({ page, open, assert }) => {
  await open();
  const text = sel => page.locator(sel).textContent();
  const hasClass = (code, cls) => page.locator(`.kbt-key[data-code="${code}"]`).evaluate((el, c) => el.classList.contains(c), cls);
  const active = () => page.evaluate(() => document.activeElement && document.activeElement.id);

  // The tester is focused and shows the full-size layout on load.
  assert.equal(await active(), 'kbt-scroll');
  assert.equal(await page.locator('#kbt-board .kbt-key').count(), 104);
  assert.equal(await text('#kbt-tested'), '0 / 104');

  // A single key press fills in the event panel and marks the key.
  await page.keyboard.press('KeyA');
  assert.equal(await text('#kbt-ev-type'), 'keyup');
  assert.equal(await text('#kbt-ev-key'), 'a');
  assert.equal(await text('#kbt-ev-code'), 'KeyA');
  assert.equal(await text('#kbt-ev-keycode'), '65');
  assert.match(await text('#kbt-ev-location'), /^0 /);
  assert.equal(await hasClass('KeyA', 'is-tested'), true);
  assert.equal(await hasClass('KeyA', 'is-down'), false);
  assert.equal(await text('#kbt-tested'), '1 / 104');

  // Right Shift is location 2 and legacy keyCode 16; Shift+A gives "A".
  await page.keyboard.down('ShiftRight');
  assert.equal(await text('#kbt-ev-keycode'), '16');
  assert.match(await text('#kbt-ev-location'), /^2 /);
  await page.keyboard.down('KeyA');
  assert.equal(await text('#kbt-ev-key'), 'A');
  assert.equal(await text('#kbt-ev-type'), 'keydown');
  assert.match(await text('#kbt-mods'), /Shift on/);
  assert.equal(await hasClass('ShiftRight', 'is-down'), true);
  assert.equal(await text('#kbt-held-count'), '2');
  await page.keyboard.up('KeyA');
  await page.keyboard.up('ShiftRight');
  assert.doesNotMatch(await text('#kbt-mods'), /Shift on/);

  // Rollover: five keys held together, then released.
  const roll = ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK'];
  for (const k of roll) await page.keyboard.down(k);
  assert.equal(await text('#kbt-held-count'), '5');
  assert.equal(await text('#kbt-max'), '5');
  assert.equal(await text('#kbt-held'), roll.join(' + '));
  assert.equal(await hasClass('KeyF', 'is-down'), true);
  for (const k of roll) await page.keyboard.up(k);
  assert.equal(await text('#kbt-held-count'), '0');
  assert.equal(await text('#kbt-max'), '5');
  assert.equal(await text('#kbt-held'), 'None');
  assert.equal(await hasClass('KeyF', 'is-down'), false);

  // Numpad Enter: key "Enter", keyCode 13, location 3 (numpad).
  await page.keyboard.down('NumpadEnter');
  assert.equal(await text('#kbt-ev-key'), 'Enter');
  assert.equal(await text('#kbt-ev-code'), 'NumpadEnter');
  assert.equal(await text('#kbt-ev-keycode'), '13');
  assert.match(await text('#kbt-ev-location'), /^3 /);
  await page.keyboard.up('NumpadEnter');
  assert.equal(await hasClass('NumpadEnter', 'is-tested'), true);

  // While capturing, Space/arrows/End do not scroll and Tab keeps focus.
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  for (const k of ['Space', 'PageDown', 'ArrowDown', 'End', 'F1', 'Backspace']) await page.keyboard.press(k);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.keyboard.press('Tab');
  assert.equal(await active(), 'kbt-scroll');
  assert.equal(await hasClass('Tab', 'is-tested'), true);
  assert.match(await text('#kbt-status-text'), /^Capturing/);

  // Escape twice releases the capture (no keyboard trap).
  await page.keyboard.press('Escape');
  assert.equal(await active(), 'kbt-scroll');
  await page.waitForTimeout(150); // a human double tap, well above the chatter threshold
  await page.keyboard.press('Escape');
  assert.equal(await active(), 'kbt-reset');
  assert.match(await text('#kbt-status-text'), /^Not capturing/);

  // Outside the tester, keys still register but are not blocked.
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowRight');
  assert.equal(await hasClass('ArrowRight', 'is-tested'), true);
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 3000 });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); });

  // Chatter: a key that goes down again 0-1 ms after release is flagged.
  await page.evaluate(() => {
    const t = document.getElementById('kbt-scroll');
    t.focus();
    const ev = type => t.dispatchEvent(new KeyboardEvent(type, { code: 'KeyQ', key: 'q', keyCode: 81, bubbles: true }));
    ev('keydown'); ev('keyup'); ev('keydown'); ev('keyup');
  });
  assert.equal(await text('#kbt-chatter'), '1');
  assert.equal(await hasClass('KeyQ', 'is-chatter'), true);
  assert.match(await text('#kbt-log'), /chatter\?/);
  assert.match(await text('#kbt-log'), /gap \d+ ms/);
  // A normal double press 250 ms apart is not.
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(250);
  await page.keyboard.press('KeyW');
  assert.equal(await text('#kbt-chatter'), '1');
  assert.equal(await hasClass('KeyW', 'is-chatter'), false);

  // Keys that only send keyup (Print Screen on Windows) still count.
  await page.evaluate(() => document.getElementById('kbt-scroll').dispatchEvent(
    new KeyboardEvent('keyup', { code: 'PrintScreen', key: 'PrintScreen', keyCode: 44, bubbles: true })));
  assert.equal(await hasClass('PrintScreen', 'is-tested'), true);
  assert.match(await text('#kbt-log'), /keyup only/);

  // A key that is not on the drawing (ISO key next to left Shift).
  assert.equal(await page.locator('#kbt-other-wrap').isVisible(), false);
  await page.evaluate(() => {
    const t = document.getElementById('kbt-scroll');
    for (const type of ['keydown', 'keyup']) t.dispatchEvent(new KeyboardEvent(type, { code: 'IntlBackslash', key: '\\', keyCode: 226, bubbles: true }));
  });
  assert.equal(await page.locator('#kbt-other-wrap').isVisible(), true);
  assert.match(await text('#kbt-other'), /IntlBackslash/);

  // Keys typed into the layout <select> are not recorded.
  const before = await text('#kbt-presses');
  await page.focus('#kbt-chatter-ms');
  await page.keyboard.press('KeyZ');
  assert.equal(await text('#kbt-presses'), before);
  assert.equal(await hasClass('KeyZ', 'is-tested'), false);

  // Layouts: tenkeyless drops the numpad, 60% also drops F-row and nav.
  const tested104 = Number((await text('#kbt-tested')).split(' / ')[0]);
  await page.selectOption('#kbt-layout', 'tkl');
  assert.equal(await page.locator('#kbt-board .kbt-key').count(), 87);
  assert.equal(await page.locator('.kbt-key[data-code="NumpadEnter"]').count(), 0);
  assert.equal(await text('#kbt-tested'), `${tested104 - 1} / 87`);
  assert.match(await text('#kbt-other'), /NumpadEnter/);
  await page.selectOption('#kbt-layout', '60');
  assert.equal(await page.locator('#kbt-board .kbt-key').count(), 61);
  assert.equal(await page.locator('.kbt-key[data-code="F1"]').count(), 0);
  assert.match(await text('#kbt-tested'), / \/ 61$/);

  // Mac names: Option sits next to Control, Command next to Space.
  await page.selectOption('#kbt-labels', 'mac');
  assert.match(await text('.kbt-key[data-code="MetaLeft"]'), /cmd/);
  const x = code => page.locator(`.kbt-key[data-code="${code}"]`).evaluate(el => el.getBoundingClientRect().left);
  assert.ok(await x('AltLeft') < await x('MetaLeft'));
  await page.selectOption('#kbt-labels', 'pc');
  assert.ok(await x('MetaLeft') < await x('AltLeft'));

  // Copy full log as tab-separated text.
  await page.click('#kbt-copy');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip.split('\n')[0], /^event\tkey\tcode\tkeyCode\tlocation/);
  assert.match(clip, /\tKeyA\t65\t0\t/);

  // Reset clears everything and refocuses the tester.
  await page.click('#kbt-reset');
  assert.equal(await text('#kbt-tested'), '0 / 61');
  assert.equal(await text('#kbt-max'), '0');
  assert.equal(await text('#kbt-chatter'), '0');
  assert.equal(await page.locator('.kbt-key.is-tested').count(), 0);
  assert.match(await text('#kbt-log'), /No keys pressed yet/);
  assert.equal(await active(), 'kbt-scroll');

  // Pressing every key of the 60% board reports completion.
  const codes = await page.locator('#kbt-board .kbt-key').evaluateAll(els => els.map(e => e.dataset.code));
  for (const c of codes) await page.keyboard.press(c);
  assert.equal(await text('#kbt-tested'), '61 / 61');
  assert.match(await text('#kbt-done'), /All 61 keys/);

  // At phone width the keyboard scrolls inside its own box, not the page.
  await page.selectOption('#kbt-layout', 'full');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const s = document.getElementById('kbt-scroll');
    return { page: document.documentElement.scrollWidth - window.innerWidth, inner: s.scrollWidth - s.clientWidth };
  });
  assert.ok(m.page <= 1, `page overflow ${m.page}`);
  assert.ok(m.inner > 0, 'keyboard should scroll inside its container');
  assert.equal(await page.locator('#kbt-swipe').isVisible(), true);
};
