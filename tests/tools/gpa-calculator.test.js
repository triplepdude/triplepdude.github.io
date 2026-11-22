const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

// Expected GPAs come from tests/fixtures/gpa-calculator/expected.py, which works
// them out with Python's fractions.Fraction, never from this page's code.
module.exports = async ({ page, open, assert, fixtures, url }) => {
  const X = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  await open();
  const text = s => page.locator(s).textContent();
  const results = async () => ({ gpa: await text('#gp-gpa'), wgpa: await text('#gp-wgpa'), credits: await text('#gp-credits') });
  const expect = e => ({ gpa: e.gpa, wgpa: e.wgpa, credits: e.credits });
  const sem = i => page.locator('.gp-sem').nth(i);
  const row = (s, r) => sem(s).locator('.gp-row').nth(r);
  const f = (s, r) => ({ name: row(s, r).locator('input').nth(0), grade: row(s, r).locator('select').nth(0), cr: row(s, r).locator('input').nth(1), type: row(s, r).locator('select').nth(1) });
  const course = async (s, r, name, grade, credits, type) => {
    const x = f(s, r);
    await x.name.fill(name); await x.grade.selectOption(grade); await x.cr.fill(credits); await x.type.selectOption(type);
  };
  const semLines = () => page.$$eval('.gp-sem-gpa', ps => ps.map(p => p.textContent));
  const tab = async sel => { await page.locator(sel).press('Tab'); };

  // ---- The example: 49.7 grade points over 14 credits, weighted 55.2. ----
  assert.deepEqual(await results(), expect(X.default));
  assert.equal(await text('#gp-work'), `Unweighted: 49.7 grade points ÷ 14 credits = 3.55; weighted: 55.2 ÷ 14 = ${X.default.wwork}`);
  assert.equal(X.default.wwork, '3.9428…');
  assert.equal(await text('#gp-plan-out'), `You need an average GPA of ${X.default.plan.need} over your next 15 credits to reach 3.7. That is between an A− (3.7) and an A (4.0).`);
  assert.deepEqual(await semLines(), ['GPA 3.55, weighted 3.94, from 14 credits']);
  assert.equal(await text('#gp-res-h'), 'Your GPA');
  // A first visit keeps a clean address; nothing is written until something changes.
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => location.hash), '');
  // The needed average is rounded up, never to the nearest: 3.9333… needs 3.94.
  await page.fill('#gp-left', '9');
  assert.equal(X.round_up.plan.need, '3.94');
  assert.equal(await text('#gp-plan-out'), 'You need an average GPA of 3.94 over your next 9 credits to reach 3.7. That is between an A− (3.7) and an A (4.0).');
  await page.fill('#gp-left', '15');
  // Every field of a course has its own name for screen readers.
  assert.deepEqual(await row(0, 1).locator('label').allTextContents(), ['Course 2 name', 'Grade, course 2', 'Credits, course 2', 'Type, course 2']);
  assert.equal(await row(0, 1).locator('button').getAttribute('aria-label'), 'Remove course 2');
  // The scale table: 4.0 scale with +0.5 and +1.0, and no bonus for an F.
  const scaleRows = () => page.$$eval('#gp-scale-body tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent).join(' ')));
  let sr = await scaleRows();
  assert.equal(sr.length, 13);
  assert.equal(sr[2], 'A− 90–92 3.7 4.2 4.7');
  assert.equal(sr[12], 'F Below 60 0.0 0.0 0.0');

  // ---- Scales: A+ is 4.33 or 4.3, A− is 3.67 on the thirds scale. ----
  await page.selectOption('#gp-scale', 's433');
  await f(0, 0).grade.selectOption('A+');
  assert.deepEqual(await results(), expect(X.scale433_aplus));
  assert.equal((await scaleRows())[0], 'A+ 97–100 4.33 4.83 5.33');
  await page.selectOption('#gp-scale', 's43');
  assert.deepEqual(await results(), expect(X.scale43_aplus));
  await page.selectOption('#gp-scale', 'thirds');
  await f(0, 0).grade.selectOption('A');
  assert.deepEqual(await results(), expect(X.thirds));
  assert.equal((await scaleRows())[3], 'B+ 87–89 3.33 3.83 4.33');
  await page.selectOption('#gp-scale', 'std');
  // Honors worth 1 instead of 0.5.
  await page.fill('#gp-hon', '1');
  assert.deepEqual(await results(), expect(X.honors_bonus_1));
  assert.equal((await scaleRows())[1], 'A 93–96 4.0 5.0 5.0');
  await page.fill('#gp-hon', '0.5');
  // An F in an AP class earns no bonus: 34.9 / 14 and 36.4 / 14.
  await f(0, 2).grade.selectOption('F');
  assert.deepEqual(await results(), expect(X.f_in_ap));
  await f(0, 2).grade.selectOption('A-');
  // With only regular classes there is one GPA and no weighted figure or planner choice.
  for (const r of [1, 2]) await f(0, r).type.selectOption('r');
  assert.equal(await page.isVisible('#gp-w-stat'), false);
  assert.equal(await page.isVisible('#gp-basis-f'), false);
  assert.equal(await text('#gp-gpa-l'), 'GPA');
  assert.equal(await text('#gp-work'), '49.7 grade points ÷ 14 credits = 3.55');
  // An AP class with no grade yet does not make a weighted GPA either.
  await sem(0).locator('.gp-add').click();
  await f(0, 4).type.selectOption('a');
  await f(0, 4).cr.fill('4');
  assert.equal(await page.isVisible('#gp-w-stat'), false);
  await row(0, 4).locator('.gp-del').click();
  assert.equal(await sem(0).locator('.gp-row').count(), 4);
  await f(0, 1).type.selectOption('h');
  await f(0, 2).type.selectOption('a');
  assert.equal(await text('#gp-gpa-l'), 'Unweighted GPA');

  // ---- A second semester, typed in: B− x 4 + A x 2, PE pass/fail not counted. ----
  await page.click('#gp-add-sem');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll('.gp-sem')[1].querySelector('input')), true);
  await course(1, 0, 'Chemistry', 'B-', '4', 'r');
  await course(1, 1, 'Art', 'A', '2', 'r');
  await course(1, 2, 'PE', '', '1', 'r');
  await page.fill('#gp-target', '3.5');
  await page.fill('#gp-left', '30');
  // (49.7 + 18.8) / 20 is exactly 3.425, which floating point rounds down to 3.42.
  assert.deepEqual(await results(), expect(X.two_sems));
  assert.deepEqual(await semLines(), ['GPA 3.55, weighted 3.94, from 14 credits', 'GPA 3.13, weighted 3.13, from 6 credits']);
  assert.equal(await text('#gp-res-h'), 'Your cumulative GPA');
  assert.equal(await text('#gp-plan-out'), `You need an average GPA of ${X.two_sems.plan.need} over your next 30 credits to reach 3.5. That is between a B+ (3.3) and an A− (3.7).`);
  assert.deepEqual(await row(1, 0).locator('label').allTextContents(), ['Course 1 name, semester 2', 'Grade, course 1 of semester 2', 'Credits, course 1 of semester 2', 'Type, course 1 of semester 2']);
  // A grade without credits is not counted, and the semester says so.
  await f(1, 3).grade.selectOption('C');
  assert.equal((await semLines())[1], 'GPA 3.13, weighted 3.13, from 6 credits · 1 graded course has no credits yet');
  assert.equal(await f(1, 3).cr.getAttribute('aria-invalid'), null);
  await f(1, 3).grade.selectOption('');

  // ---- Earlier semesters: 3.2 over 60 credits. Half of the pair is a prompt. ----
  await page.fill('#gp-prev-gpa', '3.2');
  await tab('#gp-prev-gpa');
  assert.match(await text('#gp-work'), /Your GPA so far is left out until you enter the credits it covers\.$/);
  assert.equal(await page.getAttribute('#gp-prev-cr', 'aria-invalid'), null);
  assert.equal(await text('#gp-prev-msg'), '');
  assert.deepEqual(await results(), expect(X.two_sems));
  await page.fill('#gp-prev-cr', '60');
  assert.deepEqual(await results(), expect(X.two_sems_prev));
  assert.equal(await text('#gp-work'), `Unweighted: 260.5 grade points ÷ 80 credits = ${X.two_sems_prev.work}; weighted: 266 ÷ 80 = ${X.two_sems_prev.wwork}; includes 3.2 over 60 credits from earlier semesters`);
  let p = X.two_sems_prev.plan;
  assert.equal(await text('#gp-plan-out'), `Not reachable in 30 credits: you would need an average of ${p.need}, and the most is 4.0. With ${p.word} you would finish with ${p.best}. To reach 3.5 with ${p.word} you need at least ${p.more} more credits.`);
  // Planning on the weighted GPA, where AP classes can go above 4.0.
  await page.selectOption('#gp-basis', 'w');
  assert.equal(await text('#gp-plan-out'), `You need an average weighted GPA of ${X.two_sems_prev_w.plan.need} over your next 30 credits to reach 3.5. That is between an A− (3.7) and an A (4.0) in regular classes.`);
  await page.selectOption('#gp-basis', 'u');
  await page.fill('#gp-target', '3.3');
  assert.equal(await text('#gp-plan-out'), `You need an average GPA of ${X.two_sems_prev_t33.plan.need} over your next 30 credits to reach 3.3. That is between a B+ (3.3) and an A− (3.7).`);
  await page.fill('#gp-target', '2');
  assert.equal(await text('#gp-plan-out'), `You keep a GPA of at least 2 whatever you get: even an F in every remaining course leaves ${X.two_sems_prev_safe.plan.floor}.`);
  // A 4.0 target cannot be reached once any grade is below an A.
  await page.fill('#gp-target', '4');
  assert.match(await text('#gp-plan-out'), /^Not reachable in 30 credits: .* A GPA of exactly 4 needs the top grade in every course, and some of yours are lower\.$/);
  await page.fill('#gp-target', '3.5');
  // A weighted GPA so far counts in the weighted figure only.
  await page.fill('#gp-prev-w', '3.6');
  await page.selectOption('#gp-basis', 'w');
  assert.deepEqual(await results(), expect(X.two_sems_prev_pw));
  assert.equal(await text('#gp-work'), `Unweighted: 260.5 grade points ÷ 80 credits = ${X.two_sems_prev_pw.work}; weighted: 290 ÷ 80 = ${X.two_sems_prev_pw.wwork}; includes 3.2 (weighted 3.6) over 60 credits from earlier semesters`);
  assert.equal(await text('#gp-plan-out'), `You need an average weighted GPA of ${X.two_sems_prev_pw.plan.need} over your next 30 credits to reach 3.5. That is between a B (3.0) and a B+ (3.3) in regular classes.`);
  // The address keeps it, so a reload brings it back.
  await page.waitForFunction(() => location.hash.includes('&p=3.2,60,3.6&'));
  await page.reload();
  assert.equal(await page.inputValue('#gp-prev-w'), '3.6');
  assert.deepEqual(await results(), expect(X.two_sems_prev_pw));
  // A GPA so far above 4.0 is a weighted one: it was added to the unweighted figure, giving 4.32 on a 4.0 scale.
  await page.fill('#gp-prev-gpa', '4.5');
  await tab('#gp-prev-gpa');
  assert.equal(await text('#gp-prev-msg'), 'Enter your GPA so far as a number from 0 to 4.0, such as 3.2. A weighted GPA above that goes under Weighted GPA so far.');
  assert.equal(await page.getAttribute('#gp-prev-gpa', 'aria-invalid'), 'true');
  assert.equal(await text('#gp-gpa'), '–');
  // Only a weighted GPA and credits: a prompt, not an error.
  await page.fill('#gp-prev-gpa', '');
  assert.match(await text('#gp-work'), /Your earlier semesters are left out until you enter their unweighted GPA under GPA so far\.$/);
  assert.equal(await page.getAttribute('#gp-prev-w', 'aria-invalid'), null);
  await page.fill('#gp-prev-gpa', '3.2');
  await page.fill('#gp-prev-w', '');
  await page.selectOption('#gp-basis', 'u');
  assert.deepEqual(await results(), expect(X.two_sems_prev));

  // ---- Copy and download act on the current state. ----
  await page.click('#gp-copy');
  await page.waitForFunction(() => document.querySelector('#gp-copy').textContent === 'Copied!');
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
  assert.deepEqual(copied.slice(0, 9), [
    'Semester 1: GPA 3.55, weighted 3.94, 14 credits',
    '  Biology: A, 4 credits',
    '  English: B+, 3 credits, Honors',
    '  Calculus: A−, 4 credits, AP / IB',
    '  History: B, 3 credits',
    'Semester 2: GPA 3.13, weighted 3.13, 6 credits',
    '  Chemistry: B−, 4 credits',
    '  Art: A, 2 credits',
    '  PE: no grade, 1 credit',
  ]);
  assert.deepEqual(copied.slice(9, 11), ['Earlier semesters: GPA 3.2 over 60 credits', `Cumulative GPA: ${X.two_sems_prev.gpa} (weighted ${X.two_sems_prev.wgpa}), 80 credits`]);
  assert.match(copied[11], /^Target: Not reachable in 30 credits/);
  assert.equal(copied[12], 'Scale: 4.0 scale (A− = 3.7); Honors +0.5, AP / IB +1');
  // A name that a spreadsheet would run as a formula is defused; commas and quotes are quoted.
  await f(1, 1).name.fill('=SUM(1), "2D"');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#gp-csv')]);
  assert.equal(dl.suggestedFilename(), 'gpa.csv');
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.ok(csv.startsWith('\uFEFFsemester,course,grade,credits,type,grade_points,weighted_points\r\n'), csv.slice(0, 80));
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[1], '1,Biology,A,4,Regular,16,16');
  assert.equal(lines[3], '1,Calculus,A−,4,AP / IB,14.8,18.8');
  assert.equal(lines[6], '2,"\'=SUM(1), ""2D""",A,2,Regular,8,8');
  assert.equal(lines[7], '2,PE,no grade,1,Regular,,');
  assert.equal(lines[8], 'earlier,Earlier semesters,GPA 3.2,60,,192,192');
  assert.equal(lines.length, 10);
  assert.equal(lines[9], '');
  await f(1, 1).name.fill('Art');

  // ---- The page address keeps everything, so a reload brings it back. ----
  // The address is written a moment after the last change; a reload sooner than that
  // starts from the address as it was, so wait for the latest state.
  await page.waitForFunction(() => location.hash.includes('&p=3.2,60&') && location.hash.includes(';Art,A,2,r;'));
  await page.reload();
  assert.deepEqual(await results(), expect(X.two_sems_prev));
  assert.equal(await f(1, 2).name.inputValue(), 'PE');
  assert.equal(await page.inputValue('#gp-prev-cr'), '60');
  await page.click('#gp-link');
  await page.waitForFunction(() => document.querySelector('#gp-link').textContent === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.evaluate(() => location.href));
  // The link holds the courses and grades, and the hint beside the button says so.
  assert.equal(await page.getAttribute('#gp-link', 'aria-describedby'), 'gp-link-hint');
  assert.equal(await text('#gp-link-hint'), 'Copy link puts your courses and grades in the link, so anyone you send it to can see them.');
  // Back from another page shows results for what the boxes hold.
  await f(0, 3).cr.fill('5');
  await page.waitForFunction(() => location.hash.includes('History,B,5,r'));
  const after = await results();
  assert.notDeepEqual(after, expect(X.two_sems_prev));
  await page.goto(url.replace(/gpa-calculator\/$/, ''));
  await page.goBack();
  await page.waitForSelector('.gp-row');
  assert.equal(await f(0, 3).cr.inputValue(), '5');
  assert.deepEqual(await results(), after);
  await f(0, 3).cr.fill('3');

  // ---- Errors: each box points at its message and is marked while it shows. ----
  await f(0, 0).cr.fill('abc');
  await f(0, 0).cr.press('Tab');
  const msgId = await f(0, 0).cr.getAttribute('aria-describedby');
  assert.match(msgId, /^gp-m\d+$/);
  assert.equal(await text('#' + msgId), 'Enter the credits as a number from 0 to 100, such as 3.');
  assert.equal(await page.locator('#' + msgId).evaluate(e => e.classList.contains('error')), true);
  assert.equal(await f(0, 0).cr.getAttribute('aria-invalid'), 'true');
  assert.equal(await text('#gp-gpa'), '–');
  assert.equal(await text('#gp-work'), 'Fix the boxes marked above to see your GPA.');
  assert.equal(await text('#gp-plan-out'), 'Fix the boxes marked above first.');
  await f(0, 0).cr.fill('4');
  assert.equal(await f(0, 0).cr.getAttribute('aria-invalid'), null);
  assert.equal(await text('#' + msgId), '');
  for (const [sel, v, msg, re] of [
    ['#gp-hon', '3', '#gp-set-msg', /^The Honors bonus must be a number from 0 to 2, such as 0\.5\.$/],
    ['#gp-ap', '-1', '#gp-set-msg', /^The AP \/ IB bonus must be a number from 0 to 2, such as 1\.$/],
    ['#gp-prev-gpa', '6', '#gp-prev-msg', /^Enter your GPA so far as a number from 0 to 4\.0, such as 3\.2\. A weighted GPA above that goes under Weighted GPA so far\.$/],
    ['#gp-prev-w', '6', '#gp-prev-msg', /^Enter your weighted GPA so far as a number from 0 to 5\.0, such as 3\.6\.$/],
    ['#gp-prev-cr', '10000', '#gp-prev-msg', /^Enter the credits as a number from 0 to 9,999, such as 60\.$/],
    ['#gp-target', '4.5', '#gp-plan-msg', /^Enter a target GPA from 0 to 4\.0, such as 3\.5\.$/],
    ['#gp-left', '0', '#gp-plan-msg', /^Enter the credits still to take as a number above 0, up to 9,999, such as 30\.$/],
  ]) {
    const old = await page.inputValue(sel);
    await page.fill(sel, v);
    await tab(sel);
    assert.match(await text(msg), re, sel);
    assert.equal(await page.getAttribute(sel, 'aria-invalid'), 'true', sel);
    assert.ok((await page.getAttribute(sel, 'aria-describedby')).split(' ').includes(msg.slice(1)), sel);
    await page.fill(sel, old);
    assert.equal(await page.getAttribute(sel, 'aria-invalid'), null, sel);
    assert.equal(await text(msg), '', sel);
  }
  assert.deepEqual(await results(), expect(X.two_sems_prev));

  // ---- Number formats in a credits box (Biology, A; the rest add up to 76 credits). ----
  const credits = async v => { await f(0, 0).cr.fill(v); await f(0, 0).cr.press('Tab'); return { credits: await text('#gp-credits'), invalid: await f(0, 0).cr.getAttribute('aria-invalid') }; };
  for (const [v, want] of [['3,5', '79.5'], ['0,500', '76.5'], ['.5', '76.5'], ['\uFEFF4', '80'], ['4\u200B', '80'], ['4.', '80'], [' 4 ', '80'], ['３', '79'], ['٣٫٥', '79.5'], ['۴', '80']]) {
    assert.deepEqual(await credits(v), { credits: want, invalid: null }, v);
  }
  // Thousands, a raised 2, a tab between pasted cells, minus signs and the Arabic
  // thousands separator are never read as a small number of credits.
  for (const v of ['1,000', '١٬٠٠٠', '5²', '3\t4', '3 4', '-3', '1e2', '4,5,6', '0x10']) {
    assert.deepEqual(await credits(v), { credits: '–', invalid: 'true' }, JSON.stringify(v));
  }
  await credits('4');

  // ---- A megabyte pasted into any box is refused or cut at once, without freezing. ----
  const big = 'a'.repeat(58) + '😀' + '9'.repeat(1e6);
  for (const sel of ['#gp-hon', '#gp-ap', '#gp-prev-gpa', '#gp-prev-cr', '#gp-prev-w', '#gp-target', '#gp-left', '.gp-cr input', '.gp-name input']) {
    const ms = await page.evaluate(([sel, v]) => {
      const el = document.querySelector(sel), old = el.value, t0 = performance.now();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const took = performance.now() - t0;
      window.__kept = el.value;
      el.value = old;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return took;
    }, [sel, big]);
    assert.ok(ms < 300, `${sel} took ${Math.round(ms)} ms`);
    if (sel === '.gp-name input') assert.equal(await page.evaluate(() => window.__kept), 'a'.repeat(58) + '😀');
  }
  // A name is cut at 60 characters without splitting an emoji in half.
  await page.evaluate(() => {
    const el = document.querySelector('.gp-name input');
    el.value = 'b'.repeat(59) + '😀';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await f(0, 0).name.inputValue(), 'b'.repeat(59));
  // A name pasted with a tab from a spreadsheet stays on one line, with a space.
  await page.evaluate(() => {
    const el = document.querySelector('.gp-name input');
    el.value = 'Bio\tlogy';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await f(0, 0).name.inputValue(), 'Bio logy');
  await f(0, 0).name.fill('Biology');
  assert.deepEqual(await results(), expect(X.two_sems_prev));

  // ---- Keyboard: add, fill and remove a course without the mouse. ----
  await sem(1).locator('.gp-add').focus();
  await page.keyboard.press('Enter');
  assert.equal(await sem(1).locator('.gp-row').count(), 5);
  assert.equal(await page.evaluate(() => document.activeElement.closest('.gp-row') === document.querySelectorAll('.gp-sem')[1].querySelectorAll('.gp-row')[4]), true);
  await page.keyboard.type('Music');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown'); // A+
  await page.keyboard.press('ArrowDown'); // A
  await page.keyboard.press('Tab');
  await page.keyboard.type('2');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove course 5 of semester 2');
  // 260.5 + 8 = 268.5 over 82 credits.
  assert.equal(await text('#gp-gpa'), '3.27');
  assert.equal(await text('#gp-credits'), '82');
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(ring, 'solid');
  await page.keyboard.press('Enter');
  assert.equal(await sem(1).locator('.gp-row').count(), 4);
  assert.equal(await page.evaluate(() => document.activeElement.closest('.gp-row') === document.querySelectorAll('.gp-sem')[1].querySelectorAll('.gp-row')[3]), true);
  assert.deepEqual(await results(), expect(X.two_sems_prev));
  // Removing a semester renumbers what follows and moves focus to a heading.
  await page.click('#gp-add-sem');
  await sem(0).locator('.gp-del-sem').click();
  assert.deepEqual(await page.$$eval('.gp-h', hs => hs.map(h => h.textContent)), ['Semester 1', 'Semester 2']);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Semester 1');
  // No honors or AP class is left, so there is no weighted figure.
  assert.deepEqual(await semLines(), ['GPA 3.13 from 6 credits', 'No GPA yet']);

  // ---- One short summary is announced after typing pauses, only when it changes. ----
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    window.__changes = 0;
    new MutationObserver(() => window.__changes++).observe(document.querySelector('#gp-status'), { childList: true, characterData: true, subtree: true });
  });
  await f(1, 0).grade.selectOption('A');
  await f(1, 0).cr.pressSequentially('3', { delay: 30 });
  // (6 x 3.1333 + 12) / ... : 18.8 + 12 over 9 credits, plus 192 over 60 -> 222.8 / 69.
  await page.waitForFunction(() => /^Cumulative GPA 3\.23, from 69 credits\.$/.test(document.querySelector('#gp-status').textContent), null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__changes), 1);
  await f(1, 1).name.fill('Art history');
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(() => window.__changes), 1);

  // ---- Exact letter, from a link: (3.625 x 28 - 49.7) / 14 is exactly 3.7. ----
  const ex = 'c=Biology,A,4,r;English,B%2B,3,h;Calculus,A-,4,a;History,B,3,r';
  await page.goto(url + '#v=1&s=std&h=0.5&a=1&t=3.625,14,u&' + ex);
  assert.deepEqual(await results(), expect(X.exact_letter));
  assert.equal(await text('#gp-plan-out'), `You need an average GPA of ${X.exact_letter.plan.need} over your next 14 credits to reach 3.625. That is an A− average (3.7).`);
  // Editing the address by hand loads the new state.
  await page.evaluate(() => { location.hash = location.hash.replace('t=3.625,14,u', 't=3.7,15,u'); });
  await page.waitForFunction(() => document.querySelector('#gp-target').value === '3.7');
  assert.equal(await text('#gp-plan-out'), `You need an average GPA of ${X.default.plan.need} over your next 15 credits to reach 3.7. That is between an A− (3.7) and an A (4.0).`);

  // ---- Just under a half: 3.42499 shows as 3.42, so the working must not say 3.4250. ----
  await page.goto(url + '#v=1&s=std&h=0.5&a=1&p=3.42499,100&t=3.7,15,u&c=');
  assert.equal(await text('#gp-gpa'), X.near_half.gpa);
  assert.equal(await text('#gp-work'), `342.499 grade points ÷ 100 credits = ${X.near_half.work}; includes 3.42499 over 100 credits from earlier semesters`);
  // The best result, 3.4999, misses 3.5; rounded it would read 3.50, as if it did not.
  await page.goto(url + '#v=1&s=std&h=0.5&a=1&p=3.494899,100&t=3.5,1,u&c=');
  const nb = X.best_near_target.plan;
  assert.equal(nb.best, '3.4999');
  assert.equal(await text('#gp-plan-out'), `Not reachable in 1 credit: you would need an average of ${nb.need}, and the most is 4.0. With ${nb.word} you would finish with ${nb.best}. To reach 3.5 with ${nb.word} you need at least ${nb.more} more credits.`);
  // The best weighted grade on the 4.3 scale is an A+ in an AP / IB class; with a bigger
  // Honors bonus it is an A in an Honors class.
  for (const [hash, key, most, target] of [['s=s43&h=0.5&a=1&t=5.2,15,w&', 's43_w_out', '5.3', '5.2'], ['s=std&h=1.5&a=1&t=5.4,15,w&', 'hon_big_w_out', '5.5', '5.4']]) {
    await page.goto(url + '#v=1&' + hash + ex);
    const q = X[key].plan;
    assert.equal(await text('#gp-plan-out'), `Not reachable in 15 credits: you would need an average of ${q.need}, and the most is ${most}. With ${q.word} you would finish with ${q.best}. To reach ${target} with ${q.word} you need at least ${q.more} more credits.`, key);
  }
  // A scale named after something every object has, such as constructor, is unknown: the
  // menu shows the standard scale instead of going blank.
  for (const s of ['constructor', '__proto__', 'toString']) {
    await page.goto('about:blank');
    await page.goto(url + '#v=1&s=' + s + '&c=A%2C3%2C');
    assert.equal(await page.inputValue('#gp-scale'), 'std', s);
  }
  // A weighted GPA so far comes back from a link.
  await page.goto(url + '#v=1&s=std&h=0.5&a=1&p=3.2,60,3.6&t=3.5,30,w&' + ex);
  assert.equal(await page.inputValue('#gp-prev-w'), '3.6');
  // (55.2 + 3.6 x 60) / 74 = 3.6649
  assert.equal(await text('#gp-wgpa'), '3.66');

  // ---- Too much to keep in the address: the same 8,000-character limit when
  // writing and reading, and the visitor is told. ----
  // Four semesters of 29 courses with 60-letter names and a fifth of three
  // courses make 7,990 characters, the page's own way of writing them.
  const longRow = 'x'.repeat(60) + ',A,3,r';
  const semStr = Array(29).fill(longRow).join(';');
  const fits = 'v=1&s=std&h=0.5&a=1&t=3.7,15,u&c=' + Array(4).fill(semStr).join('|') + '|' + Array(3).fill('z'.repeat(55) + ',A,3,r').join(';');
  assert.equal(fits.length, 7990);
  await page.goto('about:blank');
  await page.goto(url + '#' + fits);
  assert.equal(await page.locator('.gp-row').count(), 119);
  assert.equal(await text('#gp-credits'), '357');
  assert.equal(await text('#gp-hash-note'), '');
  // 30 courses is the most a semester holds.
  await sem(3).locator('.gp-add').click();
  assert.equal(await sem(3).locator('.gp-add').isDisabled(), true);
  await page.waitForFunction(() => location.hash.length > 7990);
  // One more course with a name tips it over 8,000: the address is cleared and the visitor told.
  await sem(4).locator('.gp-add').click();
  await page.keyboard.type('y'.repeat(20));
  await page.waitForFunction(() => location.hash === '');
  assert.equal(await text('#gp-hash-note'), 'This is too much to keep in the page address (over 8,000 characters), so a reload would lose it. Download the .csv to keep a copy.');
  await page.click('#gp-link');
  await page.waitForFunction(() => document.querySelector('#gp-link').textContent === 'Too long for a link');
  await page.goto('about:blank');
  await page.goto(url + '#' + fits + ';' + longRow + ';' + longRow + ';' + longRow);
  assert.equal(await text('#gp-hash-note'), 'The page address holds more than 8,000 characters of courses, too much to read, so the example is shown instead.');
  assert.deepEqual(await results(), expect(X.default));
  await open();
  // 16 semesters is the most the page holds, and it says so.
  for (let i = 1; i < 16; i++) await page.click('#gp-add-sem');
  assert.equal(await page.locator('.gp-sem').count(), 16);
  assert.equal(await page.isDisabled('#gp-add-sem'), true);
  assert.equal(await page.isVisible('#gp-sem-max'), true);
  await open();

  // The guide links the two grade tools, which exist.
  const links = await page.$$eval('.prose a[href^="/"], .faq a[href^="/"]', as => as.map(a => a.getAttribute('href')));
  assert.deepEqual(links, ['/final-grade-calculator/', '/grade-calculator/']);
  for (const href of links) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '_tools', href.replace(/\//g, '') + '.html')), href);

  // ---- Decimal-comma locale: any single comma is a decimal comma there, the
  // Arabic thousands separator still groups thousands. ----
  const de = await page.context().browser().newContext({ locale: 'de-DE' });
  try {
    const p2 = await de.newPage();
    await p2.goto(url);
    const cr = p2.locator('.gp-row').nth(0).locator('input').nth(1);
    for (const [v, want] of [['1,000', '11'], ['0,500', '10.5'], ['3,5', '13.5'], ['1.000,5', '–'], ['١٬٠٠٠', '–'], ['1,000.5', '–']]) {
      await cr.fill(v);
      assert.equal(await p2.textContent('#gp-credits'), want, `de-DE credits ${v}`);
    }
  } finally {
    await de.close();
  }

  // ---- A phone with a touch screen: fields big enough, nothing cut off. ----
  const phone = await page.context().browser().newContext({ ...devices['Pixel 7'] });
  try {
    const p3 = await phone.newPage();
    await p3.goto(url);
    await p3.locator('.gp-add').first().tap();
    const r5 = p3.locator('.gp-row').nth(4);
    await r5.locator('input').nth(0).tap();
    await p3.keyboard.type('Drama');
    await r5.locator('select').nth(0).selectOption('B');
    await r5.locator('input').nth(1).tap();
    await p3.keyboard.type('2');
    // (49.7 + 6) / 16 = 3.48125, weighted (55.2 + 6) / 16 = 3.825.
    assert.equal(await p3.textContent('#gp-gpa'), '3.48');
    assert.equal(await p3.textContent('#gp-wgpa'), '3.83');
    for (const w of [320, 360, 390, 480, 590, 610, 640]) {
      await p3.setViewportSize({ width: w, height: 800 });
      const probs = await p3.evaluate(() => {
        const out = [], c = document.createElement('canvas').getContext('2d');
        for (const el of document.querySelectorAll('.tool-card input:not([type=hidden]), .tool-card select, .tool-card button')) {
          if (!el.getClientRects().length) continue;
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          if (r.height < 43.5) out.push(`${el.id || el.textContent} is ${r.height}px tall`);
          if (el.tagName !== 'BUTTON' && parseFloat(cs.fontSize) < 16) out.push(`${el.id} text is ${cs.fontSize}`);
          if (el.tagName === 'SELECT') {
            c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            const widest = Math.max(...[...el.options].map(o => c.measureText(o.text).width));
            const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
            if (widest > room) out.push(`${el.id} options are cut off (${Math.round(widest)} > ${Math.round(room)})`);
          }
          if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 1) out.push(`button ${el.textContent} is cut off`);
        }
        for (const t of document.querySelectorAll('.tool-card .table-wrap')) if (t.scrollWidth > t.clientWidth + 1) out.push(`a table needs ${t.scrollWidth - t.clientWidth}px more`);
        return out;
      });
      assert.deepEqual(probs, [], `at ${w}px`);
    }
  } finally {
    await phone.close();
  }
};
