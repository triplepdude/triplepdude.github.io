// Colour blind test. The plates are random, so the test reads every one off
// the canvas, as a simulated observer would. Dot colours become L, M and S cone
// excitations with the published sRGB and Smith and Pokorny matrices
// (tests/fixtures/color-blind-test/cones.py), never with the page's own
// arithmetic. The figure is found by matching the dots against the page's
// figure outlines, and then the test measures how figure and background
// differ in each cone type. A plate meant to hide from protanopes must differ
// in L only: the M and S signals, all a protanope has, must be the same in
// figure and background. Observers with normal vision, protanopia,
// deuteranopia, tritanopia and milder losses then answer, and the page's
// verdicts are checked against the rules the guide states.
const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

const LEVELS = { L: [0.16, 0.09, 0.05, 0.025], M: [0.16, 0.09, 0.05, 0.025], S: [0.70, 0.40, 0.22, 0.12] };
const DIGITS = ['2', '3', '4', '5', '6', '7', '8', '9'];
const SHAPES = ['circle', 'square', 'triangle', 'star'];

// Runs in the page: reads a plate canvas and returns the figure it shows and
// the mean difference between figure and background dots, in natural logs of
// each cone excitation and of their ratios.
function readPlate(arg) {
  const c = document.getElementById(arg.id), W = c.width, H = c.height;
  const d = c.getContext('2d').getImageData(0, 0, W, H).data, T = arg.lms;
  const lin = [];
  for (let i = 0; i < 256; i++) { const v = i / 255; lin.push(v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); }
  // The paper between the dots is the most common colour.
  const counts = new Map();
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) { const k = d[i] * 65536 + d[i + 1] * 256 + d[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
  let paper = -1, most = 0;
  counts.forEach((n, k) => { if (n > most) { most = n; paper = k; } });
  // Inside a dot every pixel has the dot's exact colour; edges are blends.
  const pts = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] !== 255 || d[i] * 65536 + d[i + 1] * 256 + d[i + 2] === paper) continue;
      let same = true;
      for (const o of [4, -4, 4 * W, -4 * W]) if (d[i + o] !== d[i] || d[i + o + 1] !== d[i + 1] || d[i + o + 2] !== d[i + 2] || d[i + o + 3] !== 255) { same = false; break; }
      if (!same) continue;
      const r = lin[d[i]], g = lin[d[i + 1]], b = lin[d[i + 2]];
      const L = T[0][0] * r + T[0][1] * g + T[0][2] * b, M = T[1][0] * r + T[1][1] * g + T[1][2] * b, S = T[2][0] * r + T[2][1] * g + T[2][2] * b;
      pts.push({ x, y, L: Math.log(L), M: Math.log(M), S: Math.log(S), Y: Math.log(L + M) });
    }
  }
  // Each candidate figure drawn at the plate's size, on a coarse grid.
  const G = 40, cellOf = (x, y) => Math.min(G - 1, Math.floor(x / W * G)) + G * Math.min(G - 1, Math.floor(y / H * G));
  const tc = document.createElement('canvas');
  tc.width = W;
  tc.height = H;
  const t = tc.getContext('2d'), templates = {};
  for (const name of arg.names) {
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.clearRect(0, 0, W, H);
    t.setTransform(W / 2 * arg.scale, 0, 0, H / 2 * arg.scale, W / 2, H / 2);
    t.lineWidth = arg.stroke;
    t.lineCap = 'round';
    t.lineJoin = 'round';
    for (const stroke of arg.glyphs[name]) {
      t.beginPath();
      for (const s of stroke) {
        if (s[0] === 'M') t.moveTo(s[1], s[2]);
        else if (s[0] === 'L') t.lineTo(s[1], s[2]);
        else if (s[0] === 'Q') t.quadraticCurveTo(s[1], s[2], s[3], s[4]);
        else if (s[0] === 'A') t.arc(s[1], s[2], s[3], s[4] * Math.PI / 180, s[5] * Math.PI / 180, false);
        else if (s[0] === 'Z') t.closePath();
      }
      t.stroke();
    }
    const a = t.getImageData(0, 0, W, H).data, on = new Float64Array(G * G), all = new Float64Array(G * G);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = cellOf(x, y); all[k]++; if (a[(y * W + x) * 4 + 3] > 127) on[k]++; }
    templates[name] = Array.from(on, (v, k) => v / all[k] >= 0.5);
  }
  const total = new Float64Array(G * G);
  pts.forEach(p => { p.cell = cellOf(p.x, p.y); total[p.cell]++; });
  function otsu(v) {
    let lo = Infinity, hi = -Infinity;
    v.forEach(x => { if (x < lo) lo = x; if (x > hi) hi = x; });
    if (!(hi > lo)) return lo;
    const n = 512, hist = new Float64Array(n);
    v.forEach(x => { hist[Math.min(n - 1, Math.floor((x - lo) / (hi - lo) * n))]++; });
    let sum = 0;
    for (let i = 0; i < n; i++) sum += i * hist[i];
    let w0 = 0, s0 = 0, best = -1, at = 0;
    for (let i = 0; i < n; i++) {
      w0 += hist[i];
      s0 += i * hist[i];
      const w1 = v.length - w0;
      if (!w0 || !w1) continue;
      const between = w0 * w1 * Math.pow(s0 / w0 - (sum - s0) / w1, 2);
      if (between > best) { best = between; at = i; }
    }
    return lo + (at + 1) / n * (hi - lo);
  }
  // Split the dots by each feature a sighted observer could use: the L:M
  // ratio, the S:M ratio and the lightness. The split that draws a figure best wins.
  const byName = {};
  let best = { iou: -1 };
  for (const f of ['a', 'b', 'Y']) {
    const v = pts.map(p => (f === 'a' ? p.L - p.M : f === 'b' ? p.S - p.M : p.Y));
    const thr = otsu(v);
    for (const above of [true, false]) {
      const inA = new Float64Array(G * G);
      pts.forEach((p, i) => { if ((v[i] > thr) === above) inA[p.cell]++; });
      for (const name of arg.names) {
        let inter = 0, union = 0;
        for (let k = 0; k < G * G; k++) {
          if (total[k] < 3) continue;
          const m = inA[k] / total[k] >= 0.5, tt = templates[name][k];
          if (m && tt) inter++;
          if (m || tt) union++;
        }
        const iou = union ? inter / union : 0;
        byName[name] = Math.max(byName[name] || 0, iou);
        if (iou > best.iou) best = { iou, name, f, thr, above };
      }
    }
  }
  const second = Math.max(...arg.names.filter(n => n !== best.name).map(n => byName[n]));
  const v = pts.map(p => (best.f === 'a' ? p.L - p.M : best.f === 'b' ? p.S - p.M : p.Y));
  const F = [], B = [];
  pts.forEach((p, i) => ((v[i] > best.thr) === best.above ? F : B).push(p));
  const mean = (list, fn) => list.reduce((s, p) => s + fn(p), 0) / list.length;
  const diff = fn => mean(F, fn) - mean(B, fn);
  const spread = list => { const m = mean(list, p => p.Y); return Math.sqrt(mean(list, p => (p.Y - m) ** 2)); };
  return {
    figure: best.name, iou: best.iou, second, feature: best.f, nF: F.length, nB: B.length,
    da: diff(p => p.L - p.M), db: diff(p => p.S - p.M), dc: diff(p => p.S - p.L),
    dL: diff(p => p.L), dM: diff(p => p.M), dS: diff(p => p.S),
    sF: spread(F), sB: spread(B),
  };
}

module.exports = async ({ page, open, assert, fixtures, url }) => {
  const lms = JSON.parse(fs.readFileSync(path.join(fixtures, 'cones.json'), 'utf8')).rgb_to_lms;
  await page.addInitScript(() => {
    if (location.search.includes('inverted')) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => (/inverted-colors:\s*inverted/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q));
    }
  });
  await page.clock.install();
  await open();
  await page.clock.pauseAt(Date.now() + 60000);
  const text = s => page.locator(s).textContent();
  const glyphs = JSON.parse(await text('#cbt-glyphs'));
  const read = (id, names) => page.evaluate(readPlate, { id, names, lms, glyphs, scale: 1.2, stroke: 0.14 });

  // Turns what was measured into the kind of plate. Exactly one cone ratio
  // must be unchanged between figure and background: the two cone types in it
  // are the ones the plate leaves alone.
  function classify(info, where) {
    assert.ok(info.iou >= 0.6 && info.iou - info.second >= 0.05, `${where}: no clear figure (best ${info.figure} ${info.iou.toFixed(2)}, next ${info.second.toFixed(2)})`);
    assert.ok(info.nF > 300 && info.nB > 1500, `${where}: too few dots read (${info.nF}, ${info.nB})`);
    const flat = [info.da, info.db, info.dc].map(v => Math.abs(v) < 0.004);
    let kind, m = 0;
    if (flat.every(Boolean)) {
      kind = 'C';
      // Control plates: darker for every observer, whichever cones they have.
      for (const k of ['dL', 'dM', 'dS']) assert.ok(info[k] < -0.7, `${where}: control figure is not clearly darker (${k} ${info[k].toFixed(3)})`);
      return { kind, level: 0, m, figure: info.figure };
    }
    assert.equal(flat.filter(Boolean).length, 1, `${where}: figure differs in more than one cone type (${info.da.toFixed(4)}, ${info.db.toFixed(4)}, ${info.dc.toFixed(4)})`);
    // sign: +1 when the figure has more of the plate's cone type than the background.
    let sign;
    if (flat[1]) { kind = 'L'; m = Math.tanh(Math.abs(info.da) / 2); sign = Math.sign(info.da); } // M:S unchanged
    else if (flat[2]) { kind = 'M'; m = Math.tanh(Math.abs(info.da) / 2); sign = -Math.sign(info.da); } // S:L unchanged
    else { kind = 'S'; m = Math.tanh(Math.abs(info.db) / 2); sign = Math.sign(info.db); } // L:M unchanged
    const level = LEVELS[kind].findIndex(l => Math.abs(l - m) < (kind === 'S' ? 0.006 : 0.002));
    assert.ok(level >= 0, `${where}: ${kind}-cone contrast ${m.toFixed(4)} is none of the four strengths`);
    // The cones the plate leaves alone carry no brightness cue either: the
    // same spread of dot brightness in figure and background. One plate's
    // random dots vary by up to about 0.09 here; the averages below are tighter.
    const kept = { L: ['dM', 'dS'], M: ['dL', 'dS'], S: ['dL', 'dM'] }[kind];
    for (const k of kept) assert.ok(Math.abs(info[k]) < 0.2, `${where}: ${k} ${info[k].toFixed(3)} gives the figure away to a dichromat`);
    // That needs a wide spread of dot brightness, the same in figure and
    // background: 0.65 to 1.35 times the plate's colour, a spread (standard
    // deviation) of 0.21 in natural logs; half that range would give 0.10. Without it the lightness that comes with a cone contrast would show.
    assert.ok(info.sF > 0.14 && info.sB > 0.14 && Math.abs(info.sF - info.sB) < 0.07,
      `${where}: dot brightness spreads ${info.sF.toFixed(3)} (figure) and ${info.sB.toFixed(3)} (background)`);
    return { kind, level, m, sign, figure: info.figure, cue: (info[kept[0]] + info[kept[1]]) / 2 };
  }

  // ---- The example plate ----
  let demo = classify(await read('cbt-demo', DIGITS), 'example');
  assert.deepEqual([demo.kind, demo.figure], ['C', '7']);
  assert.equal(await text('#cbt-demo-cap'), 'Example: everyone should see a 7 here.');
  await page.selectOption('#cbt-mode', 'shapes');
  demo = classify(await read('cbt-demo', SHAPES), 'example');
  assert.deepEqual([demo.kind, demo.figure], ['C', 'star']);
  assert.equal(await text('#cbt-demo-cap'), 'Example: everyone should see a star here.');
  await page.selectOption('#cbt-mode', 'digits');
  assert.equal(await text('#cbt-env'), '', 'no screen warning on an ordinary screen');

  // ---- One full run ----
  const answerVia = async (value, via) => {
    if (via === 'click') return page.click(`#cbt-pad [data-answer="${value}"]`);
    if (value === 'none') return page.keyboard.press(via === 'zero' ? '0' : 'n');
    return page.keyboard.press(SHAPES.includes(value) ? String(SHAPES.indexOf(value) + 1) : value);
  };
  async function run({ mode = 'digits', time = '7', via = 'key', observer, during }) {
    await page.selectOption('#cbt-mode', mode);
    await page.selectOption('#cbt-time', time);
    await page.click('#cbt-start');
    assert.equal(await page.isVisible('#cbt-run'), true);
    assert.equal(await page.isVisible('#cbt-setup'), false);
    const names = mode === 'shapes' ? SHAPES : DIGITS, plates = [];
    for (let i = 0; i < 14; i++) {
      assert.equal(await text('#cbt-count'), `Plate ${i + 1} of 14`);
      assert.equal(await page.getAttribute('#cbt-plate', 'aria-label'), `Test plate ${i + 1} of 14`);
      const p = classify(await read('cbt-plate', names), `plate ${i + 1}`);
      plates.push(p);
      if (during) await during(i, p);
      const value = observer(p, i);
      if (value === 'timeout') { await page.clock.runFor(7000); continue; }
      await page.clock.runFor(250);
      await answerVia(value, via);
      p.answer = value;
    }
    assert.equal(await page.isVisible('#cbt-result'), true);
    // The plate set: a control first, another one later, and each cone type
    // at each of the four strengths exactly once.
    assert.equal(plates[0].kind, 'C');
    assert.equal(plates.filter(p => p.kind === 'C').length, 2);
    for (const k of ['L', 'M', 'S']) assert.deepEqual(plates.filter(p => p.kind === k).map(p => p.level).sort(), [0, 1, 2, 3], k);
    for (let i = 1; i < 14; i++) assert.notEqual(plates[i].figure, plates[i - 1].figure, 'the same figure twice in a row');
    // Over the 12 coloured plates, figure dots are no brighter or darker than
    // background dots to the cones each plate leaves alone. A run's average
    // varies with a spread of about 0.009, the average of all runs much less.
    const cue = plates.filter(p => p.kind !== 'C').reduce((sum, p) => sum + p.cue, 0) / 12;
    plates.forEach(p => { if (p.kind !== 'C') { signs.push(p.sign); cues.push(p.cue); } });
    assert.ok(Math.abs(cue) < 0.05, `figures carry a brightness cue of ${cue.toFixed(3)} on average`);
    return plates;
  }
  const verdict = async () => [await text('#cbt-verdict'), await text('#cbt-detail')];
  const scores = () => page.$$eval('#cbt-scores tbody tr', rows => rows.map(r => [...r.cells].map(c => c.textContent).join(' ')));
  const again = async () => { await page.click('#cbt-again'); assert.equal(await page.isVisible('#cbt-setup'), true); };
  const sees = missing => p => (p.kind === missing ? 'none' : p.figure);
  const signs = [], cues = [];

  // Normal colour vision, answering with the mouse: every plate seen.
  let plates = await run({ via: 'click', observer: p => p.figure });
  assert.deepEqual(await verdict(), ['No sign of a colour vision deficiency', 'You saw all 14 plates, including the faintest of each kind.']);
  assert.deepEqual(await scores(), ['Control (everyone should see) 2 of 2', 'Red-green, L cones (protan) 4 of 4', 'Red-green, M cones (deutan) 4 of 4', 'Blue-yellow, S cones (tritan) 4 of 4']);
  const rows = await page.$$eval('#cbt-plates tbody tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent)));
  assert.equal(rows.length, 14);
  rows.forEach((r, i) => {
    assert.equal(r[0], String(i + 1));
    assert.equal(r[2], plates[i].figure);
    assert.equal(r[3], plates[i].figure);
    assert.equal(r[4], 'Yes');
  });
  assert.equal(rows[0][1], 'Control');
  assert.match(rows.find((r, i) => plates[i].kind === 'L' && plates[i].level === 3)[1], /^Red-green, L cones \(protan\), very faint$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cbt-res-h', 'focus moves to the result');
  assert.equal(await text('#cbt-live'), 'Test finished. No sign of a colour vision deficiency.');
  await page.click('#cbt-copy');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), [
    'Colour vision screening (a screen test, not a diagnosis)',
    'No sign of a colour vision deficiency',
    'You saw all 14 plates, including the faintest of each kind.',
    'Control (everyone should see): 2 of 2 seen',
    'Red-green, L cones (protan): 4 of 4 seen',
    'Red-green, M cones (deutan): 4 of 4 seen',
    'Blue-yellow, S cones (tritan): 4 of 4 seen',
    'Figures: numbers. Time per plate: 7 seconds.',
  ].join('\n'));
  assert.match(await page.locator('.cbt-note').textContent(), /^This is a screening, not a diagnosis\./);
  await again();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cbt-start');

  // Protanopia, from the keyboard only: Tab to Start, Enter, then number keys
  // and N. Every L-cone plate is missed.
  await page.selectOption('#cbt-time', '7');
  await page.focus('#cbt-mode');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cbt-start');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-answer')), '1', 'focus moves to the answers');
  assert.deepEqual(await page.$$eval('#cbt-pad button', bs => bs.map(b => b.getAttribute('aria-keyshortcuts'))), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'N 0']);
  await page.click('#cbt-stop');
  assert.equal(await page.isVisible('#cbt-setup'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cbt-start');
  assert.equal(await text('#cbt-live'), 'Test stopped.');
  await run({ observer: sees('L') });
  assert.deepEqual(await verdict(), ['Signs of a red-green colour vision deficiency', 'Likely type: protan (the red-sensitive L cones). Severity hint: strong.']);
  assert.deepEqual((await scores())[1], 'Red-green, L cones (protan) 0 of 4');
  await again();

  // Deuteranopia, answering "none" with the 0 key.
  await run({ via: 'zero', observer: sees('M') });
  assert.deepEqual(await verdict(), ['Signs of a red-green colour vision deficiency', 'Likely type: deutan (the green-sensitive M cones). Severity hint: strong.']);
  await again();

  // Tritanopia.
  await run({ observer: sees('S') });
  assert.equal((await verdict())[0], 'Signs of a blue-yellow colour vision deficiency');
  assert.match((await verdict())[1], /^Likely type: tritan \(the blue-sensitive S cones\)\. Severity hint: strong\. Inherited blue-yellow deficiency is rare/);
  await again();

  // A milder blue-yellow loss: the two faintest S-cone plates missed.
  await run({ observer: p => (p.kind === 'S' && p.level >= 2 ? 'none' : p.figure) });
  assert.equal((await verdict())[0], 'Signs of a blue-yellow colour vision deficiency');
  assert.match((await verdict())[1], /^Likely type: tritan \(the blue-sensitive S cones\)\. Severity hint: mild\./);
  await again();

  // Mild deuteranomaly: the two faintest M plates and the faintest L plate
  // missed. Wrong numbers count as misses, like "none".
  const wrong = f => (f === '2' ? '3' : '2');
  await run({ observer: p => ((p.kind === 'M' && p.level >= 2) ? wrong(p.figure) : (p.kind === 'L' && p.level === 3) ? 'none' : p.figure) });
  assert.deepEqual(await verdict(), ['Signs of a red-green colour vision deficiency', 'Likely type: deutan (the green-sensitive M cones). Severity hint: mild.']);
  await again();

  // As many L as M plates missed: the type is unclear. One of the misses is a
  // plate left until the time ran out. The clock stops while the tab is hidden.
  const hide = async hidden => page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  let timedOut = -1;
  plates = await run({
    observer: (p, i) => {
      if (p.kind === 'L' && p.level === 3 && timedOut < 0) { timedOut = i; return 'timeout'; }
      return (p.kind === 'L' || p.kind === 'M') && p.level >= 2 ? 'none' : p.figure;
    },
    during: async i => {
      if (i !== 1) return;
      await page.clock.runFor(1000);
      await hide(true);
      await page.clock.runFor(30000);
      assert.equal(await text('#cbt-count'), 'Plate 2 of 14', 'the clock stops while the page is hidden');
      await hide(false);
      await page.clock.runFor(5000);
      assert.equal(await text('#cbt-count'), 'Plate 2 of 14');
      assert.equal(await text('#cbt-left'), '1 second left');
    },
  });
  assert.deepEqual(await verdict(), ['Signs of a red-green colour vision deficiency', 'Likely type: unclear, as you missed as many L-cone as M-cone plates. Severity hint: mild.']);
  const timedRow = await page.$$eval('#cbt-plates tbody tr', (trs, i) => [...trs[i].cells].map(c => c.textContent), timedOut);
  assert.deepEqual(timedRow.slice(3), ['No answer (time ran out)', 'No']);
  await again();
  await page.evaluate(() => { delete document.hidden; });

  // Both kinds missed.
  await run({ observer: p => ((p.kind === 'L' || p.kind === 'S') && p.level >= 1 ? 'none' : p.figure) });
  assert.equal((await verdict())[0], 'Signs of a red-green and a blue-yellow deficiency');
  await again();

  // One faint plate missed is borderline, not a deficiency.
  await run({ observer: p => (p.kind === 'S' && p.level === 3 ? 'none' : p.figure) });
  assert.deepEqual(await verdict(), ['No clear sign of a colour vision deficiency', 'You missed one of the 12 coloured plates, which a mistap or a dim or tinted screen can cause. Take the test again to check.']);
  await again();

  // The faintest L-cone and S-cone plates missed: one of each kind is still no
  // clear sign, and the message counts both misses.
  await run({ observer: p => ((p.kind === 'L' || p.kind === 'S') && p.level === 3 ? 'none' : p.figure) });
  assert.deepEqual(await verdict(), ['No clear sign of a colour vision deficiency', 'You missed 2 of the 12 coloured plates, but no more than one of each kind. A mistap or a dim or tinted screen can cause that, so take the test again to check.']);
  await again();

  // A missed control plate makes the result unreliable, whatever else.
  await run({ observer: (p, i) => (i === 0 ? wrong(p.figure) : p.figure) });
  assert.deepEqual(await verdict(), ['Result not reliable', 'You missed one of the two control plates, which everyone should see, colour blind or not. Check the screen settings under Before you start and take the test again.']);
  assert.deepEqual((await scores())[0], 'Control (everyone should see) 1 of 2');
  await again();

  // Shapes for children, answered with keys 1 to 4, 15 seconds per plate.
  await run({
    mode: 'shapes', time: '15', observer: p => p.figure,
    during: async i => {
      if (i !== 0) return;
      assert.equal(await text('#cbt-q'), 'What shape do you see?');
      assert.deepEqual(await page.$$eval('#cbt-pad button', bs => bs.map(b => b.textContent)), ['Circle1', 'Square2', 'Triangle3', 'Star4', 'I see no shape']);
      // The key shown on a button is its shortcut, not part of its name.
      assert.deepEqual(await page.$$eval('#cbt-pad button', bs => bs.map(b => b.getAttribute('aria-keyshortcuts'))), ['1', '2', '3', '4', 'N 0']);
      assert.equal(await page.getByRole('button', { name: 'Circle', exact: true }).count(), 1, 'the circle button is named "Circle"');
      assert.equal(await text('#cbt-left'), '15 seconds left');
      await page.clock.runFor(14000);
      assert.equal(await text('#cbt-count'), 'Plate 1 of 14', '15 seconds is 15 seconds');
      // 5 to 9 mean nothing in shape mode.
      await page.keyboard.press('7');
      assert.equal(await text('#cbt-count'), 'Plate 1 of 14');
    },
  });
  assert.equal((await verdict())[0], 'No sign of a colour vision deficiency');
  const shapeRow = await page.$$eval('#cbt-plates tbody tr', trs => [...trs[0].cells].map(c => c.textContent));
  assert.ok(['Circle', 'Square', 'Triangle', 'Star'].includes(shapeRow[2]) && shapeRow[3] === shapeRow[2], shapeRow.join(' | '));
  await page.click('#cbt-copy');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\nFigures: shapes\. Time per plate: 15 seconds\.$/);
  await again();

  // No time limit: a plate waits as long as needed. A key held down, or a
  // second press straight after the first, answers one plate only.
  await page.selectOption('#cbt-mode', 'digits');
  await page.selectOption('#cbt-time', '0');
  await page.click('#cbt-start');
  assert.equal(await text('#cbt-left'), 'No time limit');
  assert.equal(await page.isVisible('#cbt-timer'), false);
  await page.clock.runFor(120000);
  assert.equal(await text('#cbt-count'), 'Plate 1 of 14');
  await page.keyboard.press('5');
  await page.keyboard.press('5');
  assert.equal(await text('#cbt-count'), 'Plate 2 of 14', 'a second press within 0.2 s is ignored');
  await page.clock.runFor(300);
  await page.keyboard.down('6');
  await page.clock.runFor(300);
  await page.keyboard.down('6'); // auto-repeat
  await page.keyboard.up('6');
  assert.equal(await text('#cbt-count'), 'Plate 3 of 14', 'auto-repeat does not answer the next plate');
  await page.click('#cbt-stop');

  // A figure is the redder (bluer) or the greener (yellower) side of its plate
  // at random, so the brightness that comes with it is no clue either.
  const up = signs.filter(v => v > 0).length / signs.length;
  assert.ok(signs.length >= 120 && up > 0.25 && up < 0.75, `figures on the + side: ${up.toFixed(2)} of ${signs.length}`);
  const cue = cues.reduce((a, b) => a + b, 0) / cues.length;
  assert.ok(Math.abs(cue) < 0.02, `over ${cues.length} plates, figures carry a brightness cue of ${cue.toFixed(4)}`);

  // A Back-button visit restores the Figures choice; the example follows it.
  await page.selectOption('#cbt-mode', 'shapes');
  await page.goto(url.replace(/color-blind-test\/$/, ''));
  await page.goBack();
  const restored = await page.inputValue('#cbt-mode');
  demo = classify(await read('cbt-demo', restored === 'shapes' ? SHAPES : DIGITS), 'example after Back');
  assert.equal(demo.figure, restored === 'shapes' ? 'star' : '7');

  // A screen with inverted colours gets a warning before the test.
  await page.goto(url + '?inverted');
  assert.match(await text('#cbt-env'), /^Your device is inverting colours/);

  // ---- On a phone, with touch ----
  const ctx = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  try {
    const phone = await ctx.newPage();
    await phone.clock.install();
    await phone.goto(url);
    await phone.clock.pauseAt(Date.now() + 60000);
    await phone.tap('#cbt-start');
    const box = await phone.locator('#cbt-plate').boundingBox();
    const vw = phone.viewportSize().width;
    assert.ok(box.x >= 0 && box.x + box.width <= vw && box.width >= vw - 70, `plate fills the phone width: ${JSON.stringify(box)}`);
    const heights = await phone.$$eval('#cbt-pad button', bs => bs.map(b => b.getBoundingClientRect().height));
    assert.ok(heights.every(h => h >= 44), `answer buttons are at least 44px tall: ${heights}`);
    const glyphsP = JSON.parse(await phone.locator('#cbt-glyphs').textContent());
    for (let i = 0; i < 14; i++) {
      const info = await phone.evaluate(readPlate, { id: 'cbt-plate', names: DIGITS, lms, glyphs: glyphsP, scale: 1.2, stroke: 0.14 });
      const p = classify(info, `phone plate ${i + 1}`);
      await phone.clock.runFor(250);
      await phone.tap(`#cbt-pad [data-answer="${p.figure}"]`);
    }
    assert.equal(await phone.locator('#cbt-verdict').textContent(), 'No sign of a colour vision deficiency');
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on the phone');
  } finally {
    await ctx.close();
  }
  // While the clock runs, the whole plate, its clock and the answers are in
  // view, on a small phone and on a phone turned sideways.
  for (const opts of [devices['iPhone SE'], { ...devices['Pixel 7'], viewport: { width: 863, height: 360 } }]) {
    const small = await page.context().browser().newContext(opts);
    try {
      const p2 = await small.newPage();
      await p2.goto(url);
      await p2.tap('#cbt-start');
      await p2.waitForFunction(() => Math.abs(document.getElementById('cbt-run').getBoundingClientRect().top - 12) < 2, null, { timeout: 3000 });
      const r = await p2.evaluate(() => {
        const b = s => document.querySelector(s).getBoundingClientRect();
        return { vh: innerHeight, plate: b('#cbt-plate').top, clock: b('#cbt-timer').bottom, answers: b('.cbt-none').bottom };
      });
      assert.ok(r.plate >= 0 && r.clock <= r.vh && r.answers <= r.vh, `plate, clock and answers in view at ${opts.viewport.width}x${opts.viewport.height}: ${JSON.stringify(r)}`);
    } finally {
      await small.close();
    }
  }

  // Leave a finished result on screen for the runner's layout checks.
  await page.goto(url);
  await page.clock.pauseAt(Date.now() + 3600000);
  await run({ observer: sees('M') });
};
