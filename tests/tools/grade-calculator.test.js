// Expected averages were computed independently with Python's
// fractions.Fraction and Decimal ROUND_HALF_UP, not copied from the page.
module.exports = async ({ page, open, assert }) => {
  await open();
  const text = sel => page.locator(sel).textContent();
  const row = n => page.locator('#gc-rows .gc-row').nth(n - 1);
  const k = (n, key) => row(n).locator(`[data-k="${key}"]`);
  const tableRows = () => page.$$eval('#gc-table tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent)));
  const setRows = async list => {
    await page.click('#gc-clear');
    for (let i = 0; i < list.length; i++) {
      if (i >= 3) await page.click('#gc-add');
      const [name, score, weight] = list[i];
      await k(i + 1, 'name').fill(name);
      await k(i + 1, 'score').fill(score);
      await k(i + 1, 'weight').fill(weight);
    }
  };

  // Sample: 92 x 20 + (51/60 = 85) x 15 + 78 x 25 = 5,065 over 60 graded weight = 84.4166…
  assert.equal(await text('#gc-avg'), '84.42%');
  assert.equal(await text('#gc-letter'), 'B');
  assert.equal(await row(2).locator('.gc-r-main').textContent(), '85.00%');
  assert.equal(await row(2).locator('.gc-r-sub').textContent(), '51/60 points');
  assert.equal(await row(4).locator('.gc-r-sub').textContent(), 'not graded yet');
  assert.equal(await text('#gc-s-graded'), '60%');
  assert.equal(await text('#gc-s-banked'), '50.65');
  const note = await text('#gc-note');
  assert.match(note, /Graded work is 60% of the course; 1 row worth 40% is not graded yet/);
  assert.match(note, /normalised \(divided by 60\)/);
  assert.deepEqual(await tableRows(), [
    ['Homework', '92.00%', '20%', '33.33%', '30.67'],
    ['Quizzes', '85.00%', '15%', '25.00%', '21.25'],
    ['Midterm exam', '78.00%', '25%', '41.67%', '32.50'],
  ]);
  assert.equal(await text('#gc-t-c'), '84.42');

  // Final exam graded: (5,065 + 95 x 40) / 100 = 88.65, a B; with +/- grades a B+.
  await k(4, 'score').fill('95');
  assert.equal(await text('#gc-avg'), '88.65%');
  assert.equal(await text('#gc-letter'), 'B');
  assert.equal(await text('#gc-note'), '');
  await page.click('#gc-scale summary');
  await page.check('#gc-pm');
  assert.equal(await text('#gc-letter'), 'B+');
  assert.equal(await page.inputValue('#gc-min-2'), '90');
  await page.uncheck('#gc-pm');
  assert.equal(await text('#gc-letter'), 'B');

  // Copy summary.
  await page.click('#gc-copy');
  await page.waitForFunction(() => document.querySelector('#gc-copy').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), [
    'Homework: 92.00%, weight 20%', 'Quizzes: 85.00%, weight 15%', 'Midterm exam: 78.00%, weight 25%',
    'Final exam: 95.00%, weight 40%', 'Current grade: 88.65% (B)',
  ].join('\n'));

  // 89.5 exactly: a B on a strict scale, an A when rounding to a whole percent.
  await setRows([['Test 1', '89', '50'], ['Test 2', '90', '50']]);
  assert.equal(await text('#gc-avg'), '89.50%');
  assert.equal(await text('#gc-letter'), 'B');
  await page.check('#gc-round');
  assert.equal(await text('#gc-letter'), 'A');
  assert.equal(await text('#gc-s-letter'), 'A (90%)');
  await page.uncheck('#gc-round');

  // Exact maths: 90, 90, 90 with weights 0.1 each is exactly 90 (plain floating
  // point gives 89.99999999999999, which would be a B).
  await setRows([['A', '90', '0.1'], ['B', '90', '0.1'], ['C', '90', '0.1']]);
  assert.equal(await text('#gc-avg'), '90.00%');
  assert.equal(await text('#gc-letter'), 'A');
  assert.match(await text('#gc-note'), /add up to 0.3%, not 100%/);

  // Weights over 100 are normalised and flagged: (90 x 50 + 80 x 60) / 110 = 84.5454…
  await setRows([['Exams', '90', '50'], ['Labs', '80', '60']]);
  assert.equal(await text('#gc-avg'), '84.55%');
  assert.match(await text('#gc-note'), /add up to 110%, more than 100%/);

  // Lists: percentages are averaged, fractions are added as points.
  await setRows([['Essays', '88; 92; 95', '100']]);
  assert.equal(await text('#gc-avg'), '91.67%');
  assert.equal(await row(1).locator('.gc-r-sub').textContent(), 'average of 3');
  await k(1, 'score').fill('90,85');
  assert.equal(await text('#gc-avg'), '87.50%');
  await k(1, 'score').fill('9 / 10 + 45/50 + 18/20');
  assert.equal(await row(1).locator('.gc-r-sub').textContent(), '72/80 points');
  assert.equal(await text('#gc-avg'), '90.00%');

  // Editable scale: A from 92 makes 90% a B; an out-of-order scale is an error.
  await page.fill('#gc-min-0', '92');
  assert.equal(await text('#gc-letter'), 'B');
  assert.match(await text('#gc-scale-sum'), /A 92, B 80/);
  await page.fill('#gc-min-1', '95');
  assert.match(await text('#gc-scale-msg'), /lower than the one before it \(check B\)/);
  assert.equal(await text('#gc-letter'), '');
  await page.click('#gc-scale-reset');
  assert.equal(await text('#gc-scale-msg'), '');
  assert.equal(await page.inputValue('#gc-min-0'), '90');
  assert.equal(await text('#gc-letter'), 'A');

  // Errors appear once you leave the field, and the row is left out.
  await k(1, 'score').fill('18/20, 90');
  await k(1, 'score').press('Tab');
  assert.match(await row(1).locator('.gc-err').textContent(), /either points .* or percentages/);
  assert.equal(await k(1, 'score').getAttribute('aria-invalid'), 'true');
  assert.equal(await text('#gc-avg'), '–');
  await k(1, 'score').fill('5/0');
  await k(1, 'score').press('Tab');
  assert.match(await row(1).locator('.gc-err').textContent(), /can’t be 0/);
  await k(1, 'score').fill('abc');
  await k(1, 'score').press('Tab');
  assert.match(await row(1).locator('.gc-err').textContent(), /“abc” isn’t a score/);
  await k(1, 'score').fill('75');
  assert.equal(await row(1).locator('.gc-err').textContent(), '');
  assert.equal(await text('#gc-avg'), '75.00%');
  assert.equal(await text('#gc-letter'), 'C');
  // A score without a weight is flagged only after focus leaves the row.
  await k(2, 'name').fill('Labs');
  await k(2, 'score').fill('80');
  await k(2, 'score').press('Tab');
  assert.equal(await row(2).locator('.gc-err').textContent(), '');
  await k(2, 'weight').press('Shift+Tab');
  await k(2, 'score').press('Shift+Tab');
  await k(2, 'name').press('Shift+Tab');
  assert.match(await row(2).locator('.gc-err').textContent(), /weight/);
  await k(2, 'weight').fill('25');
  // (75 x 100 + 80 x 25) / 125 = 76
  assert.equal(await text('#gc-avg'), '76.00%');

  // Enter in the last row's weight adds a row; removing keeps focus on a remove button.
  await k(3, 'weight').press('Enter');
  assert.equal(await page.locator('#gc-rows .gc-row').count(), 4);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Name, row 4');
  await row(4).locator('.gc-del').click();
  assert.equal(await page.locator('#gc-rows .gc-row').count(), 3);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove row 3');

  // Regressions found in review.
  // Weights are shown exactly as typed (a tiny weight was shown as "0", "divided by 0").
  await setRows([['Quiz', '90', '0.00001']]);
  assert.equal(await text('#gc-avg'), '90.00%');
  assert.equal(await text('#gc-note'), 'Your weights add up to 0.00001%, not 100%. The graded weights were normalised (divided by 0.00001), so this is your grade on the work graded so far.');
  // A box holding only separators is an error, not a silent "not graded yet".
  await k(1, 'score').fill(',');
  await k(1, 'score').press('Tab');
  assert.equal(await row(1).locator('.gc-err').textContent(), '“,” isn’t a score. Use a percentage like 92 or points like 45/50.');
  assert.equal(await row(1).locator('.gc-r-sub').textContent(), '');
  assert.equal(await text('#gc-avg'), '–');
  // Full-width digits are read as digits.
  await k(1, 'score').fill('９２');
  assert.equal(await text('#gc-avg'), '92.00%');
  // A letter minimum above 100 gets its own message (it said "lower than the one before it").
  await page.fill('#gc-min-0', '101');
  assert.equal(await text('#gc-scale-msg'), 'Enter a minimum from 0 to 100 for A.');
  await page.fill('#gc-min-0', '90');
  assert.equal(await text('#gc-scale-msg'), '');
  // A click on "+ Add row" while focus is in a row, then typing in the new row
  // before the deferred check runs: the new row is where focus is, so it is not
  // flagged yet (it was, from a stale "row being left").
  await k(1, 'score').focus();
  await page.evaluate(() => {
    const add = document.querySelector('#gc-add');
    add.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    add.focus();
    add.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    add.click();
    const row = [...document.querySelectorAll('#gc-rows .gc-row')].pop();
    const score = row.querySelector('[data-k="score"]');
    score.focus();
    score.value = '80';
    score.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  assert.equal(await row(4).locator('.gc-err').textContent(), '');
  await row(4).locator('.gc-del').click();

  // The mode switch shows keyboard focus: the checked segment is filled with the
  // accent colour, so the ring goes around the whole control.
  await page.focus('input[name="gc-mode"][value="weights"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.gc-seg'));
    return { style: s.outlineStyle, offset: s.outlineOffset, color: s.outlineColor, bg: getComputedStyle(document.querySelector('.tool-card')).backgroundColor };
  });
  assert.equal(ring.style, 'solid');
  assert.equal(ring.offset, '2px');
  assert.notEqual(ring.color, ring.bg);

  // Points mode: the sample points are 184/200 + 51/60 + 78/100 = 313/360 = 86.94%.
  await page.reload();
  await page.check('input[name="gc-mode"][value="points"]');
  assert.equal(await k(1, 'earned').isVisible(), true);
  assert.equal(await k(1, 'score').isVisible(), false);
  assert.equal(await text('#gc-avg'), '86.94%');
  assert.equal(await text('#gc-letter'), 'B');
  assert.equal(await text('#gc-s-graded'), '313 / 360');
  assert.match(await text('#gc-note'), /1 row worth 100 points is not graded yet/);
  // Extra credit: 5 points with 0 possible gives 318/360 = 88.33%.
  await page.click('#gc-add');
  await k(5, 'name').fill('Extra credit');
  await k(5, 'earned').fill('5');
  await k(5, 'possible').fill('0');
  assert.equal(await text('#gc-avg'), '88.33%');
  assert.equal(await row(5).locator('.gc-r-sub').textContent(), 'extra credit points');
  await k(5, 'earned').fill('0');
  await k(5, 'earned').press('Tab');
  await page.click('#gc-copy');
  assert.match(await row(5).locator('.gc-err').textContent(), /can’t be 0/);
  assert.equal(await text('#gc-avg'), '86.94%');

  // One short summary is announced after typing pauses.
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    window.__gcChanges = 0;
    new MutationObserver(() => window.__gcChanges++).observe(document.querySelector('#gc-status'), { childList: true, characterData: true, subtree: true });
  });
  await k(4, 'earned').pressSequentially('91', { delay: 40 });
  // (313 + 91) / 460 = 87.826…
  await page.waitForFunction(() => /^Current grade 87\.83 percent, B\. 1 row needs attention\.$/.test(document.querySelector('#gc-status').textContent), null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__gcChanges), 1);
};
