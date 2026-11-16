// Expected values were computed independently with Python's fractions.Fraction:
// needed = (target - current * (1 - w)) / w, rounded UP to hundredths, and
// needed points = target * (points so far + final points) - points earned.
module.exports = async ({ page, open, assert, url }) => {
  await open();
  const text = sel => page.locator(sel).textContent();
  const table = () => page.$$eval('#fg-table tbody tr', trs => trs.map(tr => [...tr.children].filter(c => !c.hidden).map(c => c.textContent)));
  const set = async (current, weight, target) => {
    await page.fill('#fg-current', current);
    await page.fill('#fg-weight', weight);
    await page.fill('#fg-target', target);
  };

  // Default: 88% now, final worth 25%, target 90% -> (90 - 66) / 0.25 = 96%.
  assert.equal(await text('#fg-need'), '96.00%');
  assert.equal(await text('#fg-verdict'), 'You need at least 96.00% on the final to finish with 90%.');
  assert.equal(await text('#fg-best'), '91.00%');
  assert.equal(await text('#fg-worst'), '66.00%');
  assert.deepEqual(await table(), [
    ['A (your target)', '90%', '96.00%'],
    ['B', '80%', '56.00%'],
    ['C', '70%', '16.00%'],
    ['D', '60%', 'Guaranteed'],
  ]);
  // The target row is marked in text, not only by its background colour.
  assert.equal(await page.locator('#fg-table tr.fg-target th').textContent(), 'A (your target)');

  // + and - grades: A+ 124 (not possible), A 108 (not possible), A- 96 ... D- -24.
  await page.check('#fg-pm');
  const plus = await table();
  assert.equal(plus.length, 12);
  assert.deepEqual(plus[0], ['A+', '97%', 'Not possible (124.00%)']);
  assert.deepEqual(plus[1], ['A', '93%', 'Not possible (108.00%)']);
  assert.deepEqual(plus[2], ['A− (your target)', '90%', '96.00%']);
  assert.deepEqual(plus[3], ['B+', '87%', '84.00%']);
  assert.deepEqual(plus[9], ['D+', '67%', '4.00%']);
  assert.deepEqual(plus[10], ['D', '63%', 'Guaranteed']);
  await page.uncheck('#fg-pm');

  // Known vectors.
  await set('85', '40', '90');
  assert.equal(await text('#fg-need'), '97.50%');
  // Exact maths: (90 - 87 x 0.7) / 0.3 is exactly 97; floating point gives
  // 97.00000000000001, which a naive round-up would show as 97.01.
  await set('87', '30', '90');
  assert.equal(await text('#fg-need'), '97.00%');
  assert.equal(await text('#fg-best'), '90.90%');
  // 89.333… is rounded up to 89.34 so it is always enough.
  await set('76', '30', '80');
  assert.equal(await text('#fg-need'), '89.34%');
  assert.equal(await text('#fg-worst'), '53.20%');
  await set('83.5', '20', '80');
  assert.equal(await text('#fg-need'), '66.00%');
  // Final worth 100%: you need the target itself.
  await set('88', '100', '90');
  assert.equal(await text('#fg-need'), '90.00%');
  // A typed target that is not a letter cut-off gets its own highlighted row.
  await set('88', '25', '85');
  assert.equal(await text('#fg-need'), '76.00%');
  const rows = await table();
  assert.deepEqual(rows[1], ['Your target', '85%', '76.00%']);
  assert.equal(await page.locator('#fg-table tr.fg-target th').textContent(), 'Your target');

  // Impossible: 80% now, final 30%, target 90% needs 113.33…%; best is 86%.
  await set('80', '30', '90');
  assert.equal(await text('#fg-need'), 'Not reachable');
  assert.equal(await text('#fg-verdict'), 'Not reachable without extra credit: you would need 113.34% on the final. With 100% the best you can finish with is 86.00%.');
  assert.equal(await page.locator('#fg-verdict').evaluate(e => e.classList.contains('fg-bad')), true);
  // Already guaranteed: 88% now, final 25%, target 60%.
  await set('88', '25', '60');
  assert.equal(await text('#fg-need'), 'Guaranteed');
  assert.match(await text('#fg-verdict'), /even 0% on the final leaves you with 66\.00%/);

  // What if: 80% on the final with 88% now and a 25% final gives 86.00%, a B.
  await page.fill('#fg-if', '80');
  assert.equal(await text('#fg-if-out'), '80% on the final gives a course grade of 86.00% (B).');
  await page.fill('#fg-if', '105');
  assert.match(await text('#fg-if-out'), /That includes extra credit/);
  await page.fill('#fg-if', 'abc');
  assert.match(await text('#fg-if-out'), /Enter the score you might get/);
  // The what-if box points at the line that holds its result or its error.
  assert.equal(await page.getAttribute('#fg-if', 'aria-describedby'), 'fg-if-out');
  await page.locator('#fg-if').press('Tab');
  assert.equal(await page.getAttribute('#fg-if', 'aria-invalid'), 'true');
  await page.fill('#fg-if', '');

  // Errors: a weight of 0 or over 100, and text in a number box.
  await page.fill('#fg-weight', '0');
  await page.locator('#fg-weight').press('Tab');
  assert.match(await text('#fg-msg'), /more than 0% and at most 100%/);
  assert.equal(await page.getAttribute('#fg-weight', 'aria-invalid'), 'true');
  // Every grade box points at the message, in percent and in points mode.
  assert.deepEqual(await page.$$eval('#fg-current, #fg-weight, #fg-earned, #fg-possible, #fg-final-pts, #fg-target', els => els.map(el => el.getAttribute('aria-describedby'))), Array(6).fill('fg-msg'));
  assert.equal(await text('#fg-need'), '–');
  await page.fill('#fg-weight', '120');
  await page.locator('#fg-weight').press('Tab');
  assert.match(await text('#fg-msg'), /at most 100%/);
  await page.fill('#fg-weight', '25');
  assert.equal(await text('#fg-msg'), '');
  assert.equal(await page.getAttribute('#fg-weight', 'aria-invalid'), null);
  await page.fill('#fg-current', 'eighty');
  await page.locator('#fg-current').press('Tab');
  assert.match(await text('#fg-msg'), /current grade/);
  // An empty box is a prompt, not an error.
  await page.fill('#fg-current', '');
  await page.locator('#fg-current').press('Tab');
  assert.equal(await text('#fg-msg'), '');
  assert.equal(await text('#fg-verdict'), 'Fill in every box to see the score you need.');
  await page.fill('#fg-current', '88%');
  assert.equal(await text('#fg-need'), 'Guaranteed');

  // Regressions found in review (Python fractions.Fraction):
  // a decimal comma is read as a decimal point here, since no box takes a list:
  // (90 - 88.5 x 0.75) / 0.25 = 94.5.
  await set('88,5', '25', '90');
  assert.equal(await text('#fg-need'), '94.50%');
  assert.equal(await text('#fg-msg'), '');
  // A group of thousands never starts with 0, so the comma in "0,500" is a
  // decimal comma. A final worth 0.5% (it was read as 500% and refused):
  // (88.05 - 88 x 0.995) / 0.005 = 98. A current grade of 0.5% (it was read
  // as 500%): 0.5 x 0.75 = 0.375 -> 0.38% with nothing on the final.
  await set('88', '0,500', '88.05');
  assert.equal(await text('#fg-need'), '98.00%');
  assert.equal(await text('#fg-msg'), '');
  await set('0,500', '25', '90');
  assert.equal(await text('#fg-worst'), '0.38%');
  assert.equal(await text('#fg-need'), 'Not reachable');
  // A zero-led number that is grouped any other way is not a number (the
  // first two were read as 500.25%).
  for (const v of ['0,500.25', '0.500,25', '0,500,000']) {
    await page.fill('#fg-current', v);
    await page.locator('#fg-current').press('Tab');
    assert.equal(await text('#fg-need'), '–', v);
    assert.equal(await text('#fg-msg'), 'Enter your current grade as a percentage, such as 88.', v);
  }
  // The guide links the percentage calculator and the grade calculator.
  assert.deepEqual(await page.$$eval('.prose a[href^="/"]', as => as.map(a => a.getAttribute('href'))), ['/percentage-calculator/', '/grade-calculator/']);
  // A typed target is echoed exactly, not rounded to 90: (89.995 - 66) / 0.25 = 95.98.
  await set('88', '25', '89.995');
  assert.equal(await text('#fg-need'), '95.98%');
  assert.equal(await text('#fg-verdict'), 'You need at least 95.98% on the final to finish with 89.995%.');
  await set('88', '25', '90');

  // The mode switch shows keyboard focus: the checked segment is filled with the
  // accent colour, so the ring goes around the whole control.
  await page.focus('input[name="fg-mode"][value="percent"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  const ring = await page.evaluate(() => {
    const seg = document.querySelector('.fg-seg'), s = getComputedStyle(seg);
    return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor, fill: getComputedStyle(document.querySelector('.fg-seg label')).backgroundColor, bg: getComputedStyle(document.querySelector('.tool-card')).backgroundColor };
  });
  assert.equal(ring.style, 'solid');
  assert.equal(ring.offset, '2px');
  assert.notEqual(ring.color, ring.bg);

  // Points: 412 of 500 so far, 200-point final, B (80%) needs 0.8 x 700 - 412 = 148 points = 74%.
  await page.check('input[name="fg-mode"][value="points"]');
  assert.equal(await page.locator('#fg-current').isVisible(), false);
  assert.equal(await page.locator('#fg-earned').isVisible(), true);
  assert.equal(await text('#fg-if-label'), 'Final exam score (points)');
  await page.fill('#fg-target', '80');
  assert.equal(await text('#fg-need'), '74.00%');
  assert.equal(await text('#fg-need-pts'), '148');
  assert.equal(await text('#fg-verdict'), 'You need at least 74.00% on the final, which is 148 of 200 points, to finish with 80%.');
  assert.equal(await text('#fg-best'), '87.43%');
  assert.equal(await text('#fg-worst'), '58.86%');
  assert.deepEqual((await table())[0], ['A', '90%', 'Not possible (109.00%)', '–']);
  assert.deepEqual((await table())[1], ['B (your target)', '80%', '74.00%', '148']);
  // 150-point final, target 90%: 585 - 412 = 173 points > 150, so not reachable.
  await page.fill('#fg-final-pts', '150');
  await page.fill('#fg-target', '90');
  assert.equal(await text('#fg-need'), 'Not reachable');
  assert.match(await text('#fg-verdict'), /you would need 115\.34% on the final\. With 100% the best you can finish with is 86\.46%/);
  // 173 points needed: the label says the final is not worth that many.
  assert.equal(await text('#fg-need-pts'), '173');
  assert.equal(await text('#fg-need-pts-l'), 'Points needed, but the final is worth only 150');
  // Thousands separators in points: 0.8 x (1,200 + 300) - 1,000 = 200 of 300 = 66.67%.
  await page.fill('#fg-earned', '1,000');
  await page.fill('#fg-possible', '1,200');
  await page.fill('#fg-final-pts', '300');
  await page.fill('#fg-target', '80');
  assert.equal(await text('#fg-need'), '66.67%');
  assert.equal(await text('#fg-need-pts'), '200');
  await page.fill('#fg-earned', '412');
  await page.fill('#fg-possible', '500');
  await page.fill('#fg-final-pts', '150');
  await page.fill('#fg-target', '90');
  // 87 of 100, 60-point final, target 83%: 0.83 x 160 - 87 = 45.8 points = 76.33…% -> 76.34%.
  await page.fill('#fg-earned', '87');
  await page.fill('#fg-possible', '100');
  await page.fill('#fg-final-pts', '60');
  await page.fill('#fg-target', '83');
  assert.equal(await text('#fg-need'), '76.34%');
  assert.equal(await text('#fg-need-pts'), '45.8');
  assert.match(await text('#fg-verdict'), /, which is 45\.8 of 60 points \(46 in whole points\), to finish/);
  // What if 50 of 60: (87 + 50) / 160 = 85.625 -> 85.63%, a B.
  await page.fill('#fg-if', '50');
  assert.equal(await text('#fg-if-out'), '50 of 60 points on the final gives a course grade of 85.63% (B).');
  await page.fill('#fg-final-pts', '0');
  await page.locator('#fg-final-pts').press('Tab');
  assert.match(await text('#fg-msg'), /more than 0 points/);
  await page.fill('#fg-final-pts', '60');

  // Copy result.
  await page.click('#fg-copy');
  await page.waitForFunction(() => document.querySelector('#fg-copy').textContent === 'Copied!');
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
  assert.equal(copied[0], 'Points so far: 87 of 100; final worth 60 points; target 83%');
  assert.equal(copied[1], 'You need at least 76.34% on the final, which is 45.8 of 60 points (46 in whole points), to finish with 83%.');

  // One short summary is announced after typing pauses.
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    window.__fgChanges = 0;
    new MutationObserver(() => window.__fgChanges++).observe(document.querySelector('#fg-status'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#fg-target').fill('');
  await page.locator('#fg-target').pressSequentially('85', { delay: 40 });
  // 0.85 x 160 - 87 = 49 points = 81.666…% -> 81.67%.
  await page.waitForFunction(() => document.querySelector('#fg-status').textContent === 'You need at least 81.67% on the final, which is 49 of 60 points, to finish with 85%.', null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__fgChanges), 1);

  // At phone width the letter table (points column, +/- grades, a marked
  // target row) fits without a horizontal scroll bar.
  await page.fill('#fg-target', '93');
  await page.check('#fg-pm');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#fg-table tr.fg-target th').textContent(), 'A (your target)');
  const wrap = await page.$eval('#fg-table', t => { const w = t.parentElement; return { scroll: w.scrollWidth, client: w.clientWidth }; });
  assert.ok(wrap.scroll <= wrap.client + 1, JSON.stringify(wrap));

  // In a locale that writes decimals with a comma (German) any single comma
  // is a decimal comma, so "1,000" is 1% (0.75% with nothing on the final)
  // and "0,500" is 0.5%, as before; a zero-led group is refused there too.
  const de = await page.context().browser().newContext({ locale: 'de-DE' });
  try {
    const p2 = await de.newPage();
    await p2.goto(url);
    for (const [current, worst] of [['0,500', '0.38%'], ['1,000', '0.75%'], ['88,5', '66.38%'], ['0.500,25', '–'], ['0,500.25', '–']]) {
      await p2.fill('#fg-current', current);
      assert.equal(await p2.textContent('#fg-worst'), worst, `de-DE current grade ${current}`);
    }
  } finally {
    await de.close();
  }
};
