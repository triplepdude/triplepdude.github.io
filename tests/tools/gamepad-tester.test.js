// navigator.getGamepads is stubbed and gamepadconnected / gamepaddisconnected
// are dispatched by hand (headless Chromium has no controllers). Expected values
// follow the W3C Gamepad "standard" mapping (button 0 = bottom face button,
// 7 = right trigger, axes 0/1 = left stick with up = -1) and were computed in
// python3: right stick (-0.25, 1) is 1.031 from centre at 256 degrees; a stick
// whose reach is 1 - 0.08 sin^2(2θ) averages a 4.0% circularity error.
module.exports = async ({ page, open, assert, url }) => {
  await page.addInitScript(() => {
    if (location.search.includes('nogp')) { delete Navigator.prototype.getGamepads; return; }
    window.__pads = [];
    window.__rumble = [];
    const btn = (pressed, value) => ({ pressed, touched: pressed, value });
    const snap = p => {
      let ts = p.timestamp;
      const axes = p.axes.slice();
      // A controller streaming new input every p.rate ms.
      if (p.rate) { ts = Math.floor(performance.now() / p.rate) * p.rate; axes[0] = Math.sin(ts / 50) * 0.8; }
      // New input every p.countRate ms, but a timestamp that counts reports, not ms.
      if (p.countRate) { ts = Math.floor(performance.now() / p.countRate); axes[0] = Math.sin(ts / 10) * 0.8; }
      return { id: p.id, index: p.index, mapping: p.mapping, connected: true, timestamp: ts, axes,
        buttons: p.buttons.map(b => ({ ...b })), vibrationActuator: p.vibrationActuator, hapticActuators: p.hapticActuators };
    };
    Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, writable: true, value() {
      const out = [null, null, null, null];
      for (const p of window.__pads) if (p) out[p.index] = snap(p);
      return out;
    } });
    window.__makePad = (index, id, mapping, nb, na, vib) => ({
      index, id, mapping, timestamp: 1, axes: new Array(na).fill(0), buttons: Array.from({ length: nb }, () => btn(false, 0)),
      vibrationActuator: vib ? {
        type: 'dual-rumble', effects: ['dual-rumble', 'trigger-rumble'],
        playEffect(type, params) {
          window.__rumble.push([type, params]);
          return vib === 'reject' ? Promise.reject(new DOMException('No motor', 'NotSupportedError')) : Promise.resolve('complete');
        },
        reset() { window.__rumble.push(['reset']); return Promise.resolve('complete'); },
      } : null,
    });
    window.__connect = p => { window.__pads[p.index] = p; const e = new Event('gamepadconnected'); e.gamepad = snap(p); window.dispatchEvent(e); };
    window.__disconnect = i => {
      const e = new Event('gamepaddisconnected');
      e.gamepad = { ...snap(window.__pads[i]), connected: false };
      window.__pads[i] = null;
      window.dispatchEvent(e);
    };
    window.__press = (i, k, value) => { const p = window.__pads[i]; p.buttons[k] = btn(value > 0.1, value); p.timestamp++; };
    window.__axes = (i, a) => { const p = window.__pads[i]; p.axes = a.slice(); p.timestamp++; };
    window.__frames = n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  });
  await open();

  const text = s => page.locator(s).textContent();
  const texts = s => page.locator(s).allTextContents();
  const until = (fn, arg, timeout = 3000) => page.waitForFunction(fn, arg, { timeout });
  const waitText = (sel, re, timeout = 3000) => until(([s, src]) => { const e = document.querySelector(s); return e && new RegExp(src).test(e.textContent); }, [sel, re.source], timeout);
  const hidden = s => page.$eval(s, e => e.hidden || getComputedStyle(e).display === 'none');
  const li = n => `#gpt-buttons li:nth-child(${n + 1})`;
  const cls = (s, c) => page.$eval(s, (e, k) => e.classList.contains(k), c);
  const svgText = (x, y) => page.$eval(`#gpt-svg text[x="${x}"][y="${y}"]`, e => e.textContent);
  const stickRead = n => page.$eval(`#gpt-sticks figure:nth-child(${n}) .gpt-read`, e => e.textContent);

  // ---- No controller yet ----
  assert.equal(await hidden('#gpt-empty'), false);
  assert.match(await text('#gpt-empty-text'), /press any button/);
  assert.equal(await hidden('#gpt-live'), true);
  assert.equal(await hidden('#gpt-details'), true);
  assert.equal(await hidden('#gpt-svg'), false);
  assert.equal(await svgText(437, 188), 'A');
  assert.equal(await text('#gpt-error'), '');

  // ---- An Xbox controller connects ----
  await page.evaluate(() => window.__connect(window.__makePad(0, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'standard', 17, 4, true)));
  await until(() => !document.getElementById('gpt-live').hidden);
  assert.equal(await hidden('#gpt-empty'), true);
  assert.equal(await text('#gpt-id'), 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)');
  assert.equal(await text('#gpt-index'), '0');
  assert.equal(await text('#gpt-mapping'), 'standard');
  assert.equal(await text('#gpt-counts'), '17 / 4');
  assert.equal(await text('#gpt-vendor'), 'Microsoft (045e:0b13)');
  assert.equal(await text('#gpt-tested'), '0 of 17');
  assert.equal(await hidden('#gpt-pad-field'), true, 'no controller picker for a single controller');
  await waitText('#gpt-status', /^Controller connected: Xbox Wireless Controller$/);
  assert.deepEqual(await texts('#gpt-buttons .gpt-bn'), ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS',
    'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Xbox']);
  assert.deepEqual((await texts('#gpt-buttons .gpt-bi')).slice(0, 3), ['#0', '#1', '#2']);
  assert.deepEqual(await texts('#gpt-axes .gpt-an'), ['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y']);
  assert.deepEqual(await texts('#gpt-sticks figcaption'), ['Left stick', 'Right stick']);
  assert.equal(await cls('#gpt-svg', 'is-dim'), false);

  // Pressing A (button 0) lights it in the list and on the drawing; releasing leaves a tick.
  await page.evaluate(() => window.__press(0, 0, 1));
  await until(() => document.querySelector('#gpt-buttons li').classList.contains('is-on'));
  assert.equal(await text(li(0) + ' .gpt-bx'), '1.00');
  assert.equal(await page.$eval('#gpt-svg circle[cx="437"][cy="188"]', e => e.classList.contains('is-on')), true);
  assert.equal(await text('#gpt-tested'), '1 of 17');
  await waitText('#gpt-status', /^A pressed$/);
  await page.evaluate(() => window.__press(0, 0, 0));
  await until(() => !document.querySelector('#gpt-buttons li').classList.contains('is-on'));
  assert.equal(await cls(li(0), 'is-tested'), true);
  assert.equal(await page.$eval('#gpt-svg circle[cx="437"][cy="188"]', e => e.classList.contains('is-tested')), true);

  // Right trigger (button 7) half pulled: analog value and a half-filled trigger.
  await page.evaluate(() => window.__press(0, 7, 0.5));
  await waitText(li(7) + ' .gpt-bx', /^0\.50$/);
  assert.equal(await page.$eval(li(7) + ' .gpt-lvl', e => e.style.width), '50%');
  assert.equal(await page.$eval('#gpt-svg rect.lvl[x="390"]', e => e.getAttribute('height')), '17');
  // Past the pressed threshold the trigger is outlined, not filled solid, so the
  // analog level stays visible on the drawing.
  const trig = await page.$eval('#gpt-svg rect.b.trig[x="390"]', e => {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.color = 'var(--surface)';
    const surface = getComputedStyle(probe).color;
    probe.remove();
    return { on: e.classList.contains('is-on'), fill: getComputedStyle(e).fill, surface, lvl: getComputedStyle(e.nextElementSibling).opacity };
  });
  assert.deepEqual([trig.on, trig.fill, trig.lvl], [true, trig.surface, '0.85']);
  await page.evaluate(() => window.__press(0, 7, 0));
  assert.equal(await text('#gpt-tested'), '2 of 17');

  // Sticks: left up-right at (0.5, -0.5), right stick at (-0.25, 1).
  await page.evaluate(() => window.__axes(0, [0.5, -0.5, -0.25, 1]));
  await waitText('#gpt-axes li:nth-child(4) .gpt-av', /^1\.0000$/);
  assert.deepEqual(await texts('#gpt-axes .gpt-av'), ['0.5000', '−0.5000', '−0.2500', '1.0000']);
  assert.deepEqual(await page.$eval('#gpt-axes li:nth-child(2) .gpt-axbar i', e => [e.style.left, e.style.width]), ['25%', '25%']);
  assert.match(await stickRead(1), /^X 0\.5000 · Y −0\.5000Distance 0\.707 · angle 45°Outside deadzone/);
  assert.match(await stickRead(2), /^X −0\.2500 · Y 1\.0000Distance 1\.031 · angle 256°/);
  const knobs = await page.$$eval('#gpt-svg g[transform]', els => els.map(e => e.getAttribute('transform')).filter(Boolean));
  assert.deepEqual(knobs, ['translate(9.00 -9.00)', 'translate(-4.50 18.00)']);

  // Deadzone: a 0.05 offset is inside a 0.10 deadzone and outside 0.04.
  await page.evaluate(() => window.__axes(0, [0.03, 0.04, 0, 0]));
  await until(() => /Distance 0\.050/.test(document.querySelector('#gpt-sticks .gpt-read').textContent));
  assert.match(await stickRead(1), /Inside deadzone/);
  await page.focus('#gpt-dz');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#gpt-dz-val'), '0.04');
  await until(() => /Outside deadzone/.test(document.querySelector('#gpt-sticks .gpt-read').textContent));

  // A driver reporting NaN or Infinity is read as 0, not shown or recorded.
  await page.evaluate(() => window.__axes(0, [NaN, Infinity, -Infinity, 0]));
  await waitText('#gpt-axes li:nth-child(2) .gpt-av', /^0\.0000$/);
  assert.deepEqual(await texts('#gpt-axes .gpt-av'), ['0.0000', '0.0000', '0.0000', '0.0000']);
  assert.match(await stickRead(1), /^X 0\.0000 · Y 0\.0000Distance 0\.000/);

  // Circularity: part of a turn, then a full turn with dents at the diagonals.
  await page.click('#gpt-circ-reset');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gpt-circ-reset');
  const sweep = (bins, dent) => page.evaluate(async ([n, d]) => {
    for (let b = 0; b < n; b++) {
      const t = (b + 0.5) * 5 * Math.PI / 180, r = 1 - d * Math.sin(2 * t) ** 2;
      window.__axes(0, [r * Math.cos(t), -r * Math.sin(t), 0, 0]);
      await window.__frames(2);
    }
  }, [bins, dent]);
  await sweep(9, 0);
  await until(() => /Circularity: keep rotating \(13% of directions\)/.test(document.querySelector('#gpt-sticks .gpt-read').textContent));
  await sweep(36, 0);
  await until(() => /Circularity: 0\.0% average error \(50% of directions so far\)/.test(document.querySelector('#gpt-sticks .gpt-read').textContent));
  // A stick held at the edge is recorded straight after a reset, so centre it first.
  await page.evaluate(() => window.__axes(0, [0, 0, 0, 0]));
  await page.click('#gpt-circ-reset');
  await until(() => /Circularity: rotate the stick around its edge/.test(document.querySelector('#gpt-sticks .gpt-read').textContent));
  await sweep(72, 0.08);
  await until(() => /Circularity: 4\.0% average error$/.test(document.querySelector('#gpt-sticks .gpt-read').textContent));

  // Drift: left stick rests at (0.012, -0.009), right at (0.12, 0.16).
  await page.evaluate(() => window.__axes(0, [0.012, -0.009, 0.12, 0.16]));
  await page.click('#gpt-drift');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gpt-drift');
  assert.match(await text('#gpt-drift-out'), /^Measuring/);
  await waitText('#gpt-drift-out', /Right stick/, 5000);
  assert.equal(await page.getAttribute('#gpt-drift-out', 'aria-live'), null);
  await waitText('#gpt-status', /^Left stick: no drift\. Right stick: drift\.$/);
  assert.deepEqual(await texts('#gpt-drift-out p'), [
    'Left stick: resting offset 0.015 (X 0.012, Y −0.009), largest 0.015. No drift.',
    'Right stick: resting offset 0.200 (X 0.120, Y 0.160), largest 0.200. Drift: large enough to move a character or camera in many games.',
  ]);

  // Vibration: dual rumble with the defaults, then trigger rumble at half strength.
  assert.equal(await page.isVisible('#gpt-trigger'), true);
  await page.click('#gpt-rumble');
  await waitText('#gpt-vib-msg', /^Vibration finished/);
  assert.equal(await cls('#gpt-vib-msg', 'ok'), true);
  assert.deepEqual(await page.evaluate(() => window.__rumble[0]), ['dual-rumble', { startDelay: 0, duration: 1000, strongMagnitude: 1, weakMagnitude: 1 }]);
  await page.focus('#gpt-strong');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  assert.equal(await text('#gpt-strong-val'), '0.50');
  await page.selectOption('#gpt-dur', '500');
  await page.click('#gpt-trigger');
  await until(() => window.__rumble.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__rumble[1]), ['trigger-rumble',
    { startDelay: 0, duration: 500, strongMagnitude: 0, weakMagnitude: 0, leftTrigger: 0.5, rightTrigger: 0.5 }]);
  await page.click('#gpt-stop');
  assert.deepEqual(await page.evaluate(() => window.__rumble[2]), ['reset']);
  assert.equal(await text('#gpt-vib-msg'), 'Vibration stopped.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gpt-stop');

  // Update rate: new input every 8 ms is 125 Hz; no movement is reported clearly.
  await page.evaluate(() => { window.__pads[0].rate = 8; });
  await page.click('#gpt-rate');
  assert.match(await text('#gpt-rate-out'), /^Measuring/);
  await waitText('#gpt-rate-out', /Hz|Not enough/, 6000);
  assert.match(await text('#gpt-rate-out'), /^About 125 Hz: new input every 8\.00 ms on average \(\d+ updates in 3 seconds\)/);
  await waitText('#gpt-status', /^Update rate about 125 hertz\.$/);
  // A timestamp that is not in milliseconds is not trusted: new data every 4 ms
  // is 250 Hz, even though the timestamps step by 1.
  await page.evaluate(() => { window.__pads[0].rate = 0; window.__pads[0].countRate = 4; });
  await page.click('#gpt-rate');
  await waitText('#gpt-rate-out', /Hz\b|Not enough/, 6000);
  const counted = /^About (\d+) Hz/.exec(await text('#gpt-rate-out'));
  assert.ok(counted && Math.abs(Number(counted[1]) - 250) <= 10, await text('#gpt-rate-out'));
  await page.evaluate(() => { window.__pads[0].countRate = 0; });
  await page.click('#gpt-rate');
  await waitText('#gpt-rate-out', /Not enough input/, 6000);

  // ---- A DualSense connects; pressing Cross on it brings it into view ----
  // A drift measurement is running on the Xbox controller when that happens.
  await page.click('#gpt-drift');
  await page.evaluate(() => window.__connect(window.__makePad(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'standard', 18, 4, false)));
  await until(() => !document.getElementById('gpt-pad-field').hidden);
  assert.deepEqual(await texts('#gpt-pad option'), ['0: Xbox Wireless Controller', '1: DualSense Wireless Controller']);
  assert.equal(await text('#gpt-index'), '0', 'a new controller does not steal the view');
  await page.evaluate(() => window.__press(1, 0, 1));
  await waitText('#gpt-index', /^1$/);
  // Results of the Xbox controller are not shown under the DualSense.
  assert.equal(await text('#gpt-drift-out'), '');
  assert.equal(await text('#gpt-rate-out'), '');
  assert.equal(await page.inputValue('#gpt-pad'), '1');
  assert.equal(await text('#gpt-vendor'), 'Sony (054c:0ce6)');
  const ps = await texts('#gpt-buttons .gpt-bn');
  assert.deepEqual([ps[0], ps[1], ps[2], ps[3], ps[8], ps[9], ps[16], ps[17]], ['Cross', 'Circle', 'Square', 'Triangle', 'Create', 'Options', 'PS', 'Touchpad']);
  await until(() => document.querySelector('#gpt-buttons li').classList.contains('is-on'));
  assert.equal(await text('#gpt-tested'), '1 of 18', 'the press that switched controllers counts');
  assert.equal(await svgText(437, 188), '✕');
  assert.equal(await page.isVisible('#gpt-svg text[x="300"][y="104"]'), true, 'touchpad drawn');
  assert.equal(await page.isDisabled('#gpt-rumble'), true);
  assert.match(await text('#gpt-vib-msg'), /not available for this controller/);
  await page.evaluate(() => window.__press(1, 0, 0));
  await page.waitForTimeout(2300);
  assert.equal(await text('#gpt-drift-out'), '', 'the stopped measurement never reports');
  // Label sets can be chosen by hand.
  await page.selectOption('#gpt-labels', 'nintendo');
  await waitText(li(0) + ' .gpt-bn', /^B$/);
  assert.equal(await text(li(1) + ' .gpt-bn'), 'A');
  assert.equal(await svgText(437, 188), 'B');
  // An 18th button that the Nintendo and Xbox sets do not name is drawn with
  // its number, not as a blank shape.
  assert.equal(await svgText(300, 104), '17');
  assert.equal(await text(li(17) + ' .gpt-bn'), 'Button 17');
  await page.selectOption('#gpt-labels', 'xbox');
  await waitText(li(0) + ' .gpt-bn', /^A$/);
  assert.equal(await svgText(300, 104), '17');
  assert.equal(await svgText(300, 190), 'Xbox');
  await page.selectOption('#gpt-labels', 'index');
  await waitText(li(0) + ' .gpt-bn', /^Button 0$/);
  assert.equal(await svgText(437, 188), '0');
  await page.selectOption('#gpt-labels', 'auto');
  await waitText(li(0) + ' .gpt-bn', /^Cross$/);
  // Back to the Xbox controller from the list; its results were kept.
  await page.selectOption('#gpt-pad', '0');
  await waitText('#gpt-index', /^0$/);
  assert.equal(await text('#gpt-tested'), '2 of 17');
  assert.equal(await page.isDisabled('#gpt-rumble'), false);

  // ---- A controller without a standard mapping (Firefox-style id) ----
  await page.evaluate(() => window.__connect(window.__makePad(2, '2dc8-6001-8BitDo SN30 Pro', '', 12, 6, false)));
  await until(() => document.querySelectorAll('#gpt-pad option').length === 3);
  await page.selectOption('#gpt-pad', '2');
  await waitText('#gpt-index', /^2$/);
  assert.equal(await text('#gpt-mapping'), 'none');
  assert.equal(await text('#gpt-vendor'), '8BitDo (2dc8:6001)');
  assert.match(await text('#gpt-map-note'), /no standard mapping/);
  assert.equal(await hidden('#gpt-svg'), true);
  assert.equal(await text(li(0) + ' .gpt-bn'), 'Button 0');
  assert.deepEqual(await texts('#gpt-axes .gpt-an'), ['Axis 0', 'Axis 1', 'Axis 2', 'Axis 3', 'Axis 4', 'Axis 5']);
  assert.deepEqual(await texts('#gpt-sticks figcaption'), ['Axes 0 and 1', 'Axes 2 and 3']);
  assert.equal(await text('#gpt-pad option:nth-child(3)'), '2: 8BitDo SN30 Pro');

  // Reset clears the tested buttons of the shown controller only.
  await page.selectOption('#gpt-pad', '0');
  await waitText('#gpt-tested', /^2 of 17$/);
  await page.click('#gpt-reset');
  await waitText('#gpt-tested', /^0 of 17$/);
  await until(() => !document.querySelector('#gpt-buttons li.is-tested, #gpt-svg .is-tested'));

  // ---- Unplugging everything returns to the waiting message ----
  await page.evaluate(() => { window.__disconnect(2); window.__disconnect(1); });
  await until(() => document.querySelectorAll('#gpt-pad option').length === 1);
  assert.equal(await hidden('#gpt-pad-field'), true);
  await page.evaluate(() => window.__disconnect(0));
  await until(() => !document.getElementById('gpt-empty').hidden);
  assert.equal(await hidden('#gpt-live'), true);
  assert.equal(await hidden('#gpt-details'), true);
  assert.equal(await cls('#gpt-svg', 'is-dim'), true);
  await waitText('#gpt-status', /^Controller disconnected: Xbox Wireless Controller$/);

  // ---- Only hapticActuators (older API); the id is shown as text ----
  const evil = '<img src=x onerror="window.__xss=1">Pad & "co"';
  await page.evaluate(id => {
    const pad = window.__makePad(0, id, '', 10, 2, false);
    pad.hapticActuators = [{ pulse(v, d) { window.__rumble.push(['pulse', v, d]); return Promise.resolve(true); } }];
    window.__connect(pad);
  }, evil);
  await until(() => !document.getElementById('gpt-live').hidden);
  assert.equal(await text('#gpt-id'), evil);
  assert.equal(await page.$$eval('.tool-card img', e => e.length), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await text('#gpt-drift-out'), '', 'results of the unplugged controller are gone');
  assert.equal(await page.isDisabled('#gpt-rumble'), false);
  assert.equal(await page.isVisible('#gpt-trigger'), false);
  const nRumble = await page.evaluate(() => window.__rumble.length);
  await page.selectOption('#gpt-dur', '250');
  await page.click('#gpt-rumble');
  await until(n => window.__rumble.length === n + 1, nRumble);
  // Strong motor is still at 0.50, weak at 1.00: pulse uses the larger.
  assert.deepEqual(await page.evaluate(() => window.__rumble[window.__rumble.length - 1]), ['pulse', 1, 250]);
  await page.click('#gpt-stop');
  assert.deepEqual(await page.evaluate(() => window.__rumble[window.__rumble.length - 1]), ['pulse', 0, 1]);
  await page.evaluate(() => window.__disconnect(0));
  await until(() => !document.getElementById('gpt-empty').hidden);

  // ---- A controller that refuses to rumble gets a clear error ----
  await page.evaluate(() => window.__connect(window.__makePad(0, 'Generic X-Box pad (STANDARD GAMEPAD Vendor: 0e6f Product: 02a1)', 'standard', 17, 4, 'reject')));
  await until(() => !document.getElementById('gpt-live').hidden);
  assert.equal(await text('#gpt-vendor'), 'Unknown (0e6f:02a1)');
  await page.click('#gpt-rumble');
  await waitText('#gpt-vib-msg', /did not accept/);
  assert.equal(await text('#gpt-vib-msg'), 'The controller did not accept the vibration request (NotSupportedError). It may not support rumble in this browser.');
  assert.equal(await cls('#gpt-vib-msg', 'error'), true);

  // ---- A browser without the Gamepad API ----
  await page.goto(url + '?nogp');
  assert.match(await text('#gpt-error'), /does not support the Gamepad API/);
  assert.equal(await hidden('#gpt-empty'), true);
};
