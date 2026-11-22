// Expected results come from tests/fixtures/bmi-calculator/expected.json, written by
// expected.py next to it: exact fractions for adults, every weight tried in turn for
// the healthy ranges, and the CDC method with Python's NormalDist for children (checked
// there against the CDC's own percentile and z-score columns). Nothing is read back
// from the page. The CDC's worked examples (99.7683rd and 92.2nd percentiles) and its
// 5 ft 9 in table (125 to 168 lb healthy, 169 overweight, 203 obesity) are among them.
const fs = require('fs');
const path = require('path');
const { devices } = require('playwright');

module.exports = async ({ page, open, assert, fixtures, base, url }) => {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'expected.json'), 'utf8'));
  const text = sel => page.locator(sel).textContent();
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const aria = sel => page.$eval(sel, el => [el.getAttribute('aria-describedby'), el.getAttribute('aria-invalid')]);
  const invalid = () => page.$$eval('.bm input', els => els.filter(e => e.getAttribute('aria-invalid') === 'true').map(e => e.id).sort().join(' '));
  const read = () => page.evaluate(() => {
    const t = id => document.getElementById(id).textContent;
    return {
      k: t('bm-k'), bmi: t('bm-bmi'), cat: t('bm-cat'), says: t('bm-says'), note: t('bm-note'),
      facts: [...document.querySelectorAll('#bm-facts li')].map(l => l.textContent),
      copy: document.getElementById('bm-copy').disabled, table: !document.getElementById('bm-table-box').hidden,
      chart: (document.querySelector('#bm-chart svg title') || {}).textContent || '',
    };
  });
  const tableRow = label => page.$$eval('#bm-tbody tr', (trs, l) => {
    const tr = trs.find(r => r.cells[0].textContent === l);
    return tr ? [...tr.cells].map(c => c.textContent) : null;
  }, label);
  // CSV requests, to check that the CDC data is fetched only for children.
  const csv = [];
  page.on('request', r => { if (r.url().endsWith('/bmi-age-2022.csv')) csv.push(r.url()); });

  await page.clock.install({ time: new Date('2026-11-22T12:00:00') });
  await open();

  // ---- An American browser opens in feet, inches and pounds with an example ----
  assert.deepEqual([await page.inputValue('#bm-hu'), await page.inputValue('#bm-wu'), await page.inputValue('#bm-ft'), await page.inputValue('#bm-in'), await page.inputValue('#bm-lb')],
    ['ftin', 'lb', '5', '7', '145']);
  let r = await read();
  assert.deepEqual([r.k, r.bmi, r.cat, r.says], ['Your BMI', '22.7', 'Healthy weight', 'A BMI of 22.7 is in the healthy weight range (18.5 to 24.9).']);
  assert.deepEqual(r.facts, ['Healthy weight for 5 ft 7 in: 118 to 159 lb (BMI 18.5 to 24.9).']);
  assert.equal(r.note, 'Adult categories, for ages 20 and over: for anyone younger, enter the age. CDC and WHO adult categories. BMI is a screening measure, not a diagnosis.');
  assert.equal(r.chart, 'BMI chart: weight against height for adults');
  assert.match(await page.$eval('#bm-chart svg desc', d => d.textContent), /Your point: 5 ft 7 in, 145 lb, BMI 22\.7, in the healthy weight band\.$/);
  assert.equal(await page.isVisible('#bm-sex-set'), false, 'no sex question for an adult');
  assert.deepEqual(await tableRow('5 ft 7 in (your height)'), ['5 ft 7 in (your height)', '118 to 159 lb', '160 lb', '192 lb']);
  assert.equal(await page.$$eval('#bm-tbody tr', trs => trs.length), 12);
  const guide = await page.locator('.prose').textContent();
  for (const want of ['= 22.9', '= 22.7', '125 to\n  168 lb'.replace(/\n\s+/, ' ')]) assert.ok(guide.replace(/\s+/g, ' ').includes(want), `guide has ${want}`);

  // ---- Adults: known answers in every unit ----
  const RANGE = {
    Underweight: ['below 18.5', 'below 18.5'], 'Healthy weight': ['18.5 to 24.9', '18.5 to 22.9'], Overweight: ['25.0 to 29.9', '23.0 to 27.4'],
    'Obesity, class 1': ['30.0 to 34.9', '27.5 to 32.4'], 'Obesity, class 2': ['35.0 to 39.9', '32.5 to 37.4'], 'Obesity, class 3 (severe obesity)': ['40.0 or more', '37.5 or more'],
  };
  const says = (bmi, cat, nice) => `A BMI of ${bmi} is in the ${cat.startsWith('Obesity') ? `obesity range, class ${/class (\d)/.exec(cat)[1]}` : `${cat.toLowerCase()} range`} (${RANGE[cat][nice ? 1 : 0]}).`;
  const RATIO = { healthy: 'healthy, no increased health risk (0.4 to 0.49).', increased: 'increased health risk (0.5 to 0.59).', further: 'further increased health risk (0.6 or more).',
    below: 'below the bands NICE uses, which start at 0.4.', only: 'NICE uses the ratio only for a BMI under 35.' };
  // The height goes in last, feet after inches: feet and inches typed in one box
  // are split into the two boxes when it loses the focus.
  const setAdult = async c => {
    await page.selectOption('#bm-hu', c.hu);
    await page.selectOption('#bm-wu', c.wu);
    await page.setChecked('#bm-nice', !!c.nice);
    await page.fill('#bm-waist', c.waist || '');
    await page.fill('#bm-years', c.age || '');
    await page.fill('#bm-months', '');
    if (c.wu === 'kg') await page.fill('#bm-kg', c.kg);
    else if (c.wu === 'lb') await page.fill('#bm-lb', c.lb);
    else { await page.fill('#bm-stlb', c.stlb); await page.fill('#bm-st', c.st); }
    if (c.hu === 'cm') await page.fill('#bm-cm', c.cm);
    else { await page.fill('#bm-in', c.in); await page.fill('#bm-ft', c.ft); }
  };
  for (const c of data.adults) {
    await setAdult(c);
    r = await read();
    const hText = c.hu === 'cm' ? `${c.cmValue} cm` : `${Math.floor(c.inches / 12)} ft ${c.inches % 12} in`;
    assert.deepEqual([r.bmi, r.cat, r.says], [c.bmi, c.cat, says(c.bmi, c.cat, c.nice)], c.name);
    assert.equal(r.facts[0], `Healthy weight for ${hText}: ${c.range.healthy} (BMI 18.5 to ${c.nice ? '22.9' : '24.9'}).`, c.name);
    assert.equal(r.facts[1], c.ratio ? `Waist-to-height ratio ${c.ratio}: ${RATIO[c.ratioBand]}` : undefined, `waist, ${c.name}`);
    assert.equal(await text('#bm-h-read'), c.read || '', `height read back, ${c.name}`);
    assert.equal(await text('#bm-w-read'), c.wread || '', `weight read back, ${c.name}`);
    assert.deepEqual(await tableRow(`${hText} (your height)`) || await tableRow(hText), [await tableRow(`${hText} (your height)`) ? `${hText} (your height)` : hText, c.range.healthy, c.range.over, c.range.obese], `chart row, ${c.name}`);
    assert.equal(await invalid(), '', c.name);
    assert.equal(r.note.includes('NICE'), !!c.nice, c.name);
    // Your own height is marked in the chart, or added to it once.
    const listed = c.hu === 'cm' ? +c.cmValue % 5 === 0 && +c.cmValue >= 145 && +c.cmValue <= 200 : +c.inches % 2 === 0 && +c.inches >= 58 && +c.inches <= 78;
    assert.equal(await page.$$eval('#bm-tbody tr', t => t.length), (c.hu === 'cm' ? 12 : 11) + (listed ? 0 : 1), `chart rows, ${c.name}`);
    assert.equal(await page.$$eval('#bm-tbody tr.is-you', t => t.length), 1, c.name);
  }
  // The CDC's 5 ft 9 in example, row by row.
  await setAdult(data.adults.find(c => c.name === 'guide, imperial'));
  assert.deepEqual(await tableRow('5 ft 9 in (your height)'), ['5 ft 9 in (your height)', '125 to 168 lb', '169 lb', '203 lb']);
  assert.equal(await text('#bm-table-note'), 'Weights for each category at each height, for adults of 20 and over: healthy weight is a BMI of 18.5 to 24.9, overweight from 25 and obesity from 30. Below the healthy range is underweight.');
  // Copy brings the result up to date first, and says what it is.
  await page.$eval('#bm-lb', el => { el.value = '160'; });
  await page.click('#bm-copy');
  assert.equal(await clipboard(), ['BMI 23.6: healthy weight (18.5 to 24.9, adult categories)', 'Height 5 ft 9 in, weight 160 lb',
    'Healthy weight for 5 ft 9 in: 125 to 168 lb (BMI 18.5 to 24.9).', 'BMI is a screening measure, not a diagnosis.'].join('\n'));
  assert.equal(csv.length, 0, 'the CDC data is not loaded for adults');

  // ---- Children and teenagers: the CDC percentile ----
  await page.selectOption('#bm-hu', 'cm');
  await page.selectOption('#bm-wu', 'kg');
  await page.fill('#bm-waist', '');
  await page.setChecked('#bm-nice', false);
  await page.fill('#bm-cm', '140');
  await page.fill('#bm-kg', '41.552');
  await page.fill('#bm-years', '9');
  await page.fill('#bm-months', '6');
  r = await read();
  assert.deepEqual([r.k, r.bmi, r.cat, r.says, r.copy, r.table], ['BMI for a child aged 9 years 6 months', '21.2', '', 'Choose female or male to compare this BMI with children of the same sex and age.', true, false]);
  assert.equal(await page.isVisible('#bm-sex-set'), true);
  assert.equal(await page.isVisible('#bm-bg-field'), false, 'the adult thresholds are not offered under 18');
  assert.equal(csv.length, 0, 'nothing is loaded before the sex is known');
  const kids = s => s === '1' ? 'boys' : 'girls';
  const CRANGE = { Underweight: 'below the 5th percentile', 'Healthy weight': 'the 5th to below the 85th percentile', Overweight: 'the 85th to below the 95th percentile',
    Obesity: 'the 95th percentile or above', 'Severe obesity': '120% of the 95th percentile or more, or a BMI of 35 or more' };
  for (const c of data.children) {
    await page.fill('#bm-cm', c.cm);
    await page.fill('#bm-kg', c.kg);
    await page.fill('#bm-years', String(c.years));
    await page.fill('#bm-months', c.months ? String(c.months) : '');
    await page.check(`input[name="bm-sex"][value="${c.sex}"]`);
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('bm-says').textContent));
    r = await read();
    const label = `${c.sex === '1' ? 'boy' : 'girl'} ${c.years} y ${c.months} m, BMI ${c.bmi}`;
    const age = `${c.years} years${c.months ? ` ${c.months} month${c.months === 1 ? '' : 's'}` : ''}`;
    assert.equal(r.k, `BMI for a ${c.sex === '1' ? 'boy' : 'girl'} aged ${age}`, label);
    assert.equal(r.bmi, c.bmi, label);
    assert.equal(r.cat, c.cat + (c.severe ? `, class ${c.cls}` : ''), label);
    const lead = c.pctText === 'below the 1st' ? `Below the 1st percentile: a BMI lower than that of 99% of ` : c.pctText === 'above the 99.99th' ? 'Above the 99.99th percentile: a BMI higher than that of 99.99% of '
      : `The ${c.pctText} percentile: a BMI higher than that of ${c.pct}% of `;
    assert.equal(r.says, `${lead}${kids(c.sex)} of the same age in the CDC growth charts. ${c.cat} is ${CRANGE[c.cat]}.`, label);
    const facts = [`BMI z-score: ${c.zText}${c.z >= 8.21 ? ' or more' : ''}.`];
    if (c.of95) facts.push(`This BMI is ${c.of95}% of the 95th percentile (${c.p95.toFixed(1)} at this age). Severe obesity starts at 120% (CDC), and 140% or more is class 3 (American Academy of Pediatrics).`);
    if (c.adult) facts.push(`Adult categories, which the NHS uses from 18: ${c.adult.toLowerCase()} (${RANGE[c.adult][0]}).`);
    assert.deepEqual(r.facts, facts, label);
    assert.equal(r.chart, `BMI-for-age chart for ${kids(c.sex)}, 2 to 20 years (CDC)`, label);
    assert.equal(r.table, !!c.adult, `adult chart table, ${label}`);
    assert.equal(await page.isVisible('#bm-bg-field'), !!c.adult, label);
  }
  assert.equal(csv.length, 1, 'the CDC data is fetched once');
  // The CDC's worked examples are among the cases.
  const ex = data.children.slice(0, 4).map(c => [c.bmi, c.pctText, c.zText]);
  assert.deepEqual(ex, [['22.6', '99.7th', '2.83'], ['21.2', '92nd', '1.42'], ['27.2', '93rd', '1.50'], ['24.1', '98.7th', '2.23']]);
  // Copy for a child, and the line read out.
  await page.fill('#bm-cm', '140');
  await page.fill('#bm-kg', '41.552');
  await page.fill('#bm-years', '9');
  await page.fill('#bm-months', '6');
  await page.check('input[name="bm-sex"][value="2"]');
  await page.click('#bm-copy');
  assert.equal(await clipboard(), ['BMI 21.2 for a girl aged 9 years 6 months: 92nd percentile, overweight (CDC growth charts)', 'Height 140 cm, weight 41.552 kg', 'BMI z-score: 1.42.',
    'BMI is a screening measure, not a diagnosis.'].join('\n'));
  await page.clock.runFor(2000); // once typing pauses
  assert.equal(await text('#bm-status'), 'BMI 21.2, 92nd percentile for a girl aged 9 years 6 months: overweight.');
  assert.match(await page.$eval('#bm-chart svg desc', d => d.textContent), /BMI of 21\.2 at 9 years 6 months, the 92nd percentile\.$/);
  // The chart follows the width of the page.
  const w1 = await page.$eval('#bm-chart svg', s => +s.getAttribute('width'));
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForFunction(w => +document.querySelector('#bm-chart svg').getAttribute('width') < w, w1);
  await page.setViewportSize({ width: 1280, height: 900 });
  // From 20 the adult result is back; under 2 there is no BMI at all.
  await page.fill('#bm-years', '20');
  await page.fill('#bm-months', '');
  r = await read();
  assert.deepEqual([r.k, r.cat, r.table, await page.isVisible('#bm-sex-set')], ['Your BMI', 'Healthy weight', true, false]);
  await page.fill('#bm-years', '1');
  await page.fill('#bm-months', '11');
  r = await read();
  assert.deepEqual([r.k, r.bmi, r.cat, r.copy, r.chart, r.table], ['BMI for a child under 2', '–', '', true, '', false]);
  assert.equal(r.says, 'The CDC\'s BMI-for-age charts start at 2 years. For children under 2, the CDC recommends the WHO growth standards, so ask a doctor or health visitor to check growth.');

  // ---- Age from dates: completed months, as the CDC counts them ----
  await page.check('#bm-usedates');
  assert.equal(await page.inputValue('#bm-dom'), '2026-11-22', 'the date measured starts as today');
  await page.fill('#bm-dob', '2016-05-23');
  assert.equal(await text('#bm-k'), 'BMI for a girl aged 10 years 5 months'); // one day short of 6 months
  await page.fill('#bm-dob', '2016-05-22');
  assert.equal(await text('#bm-k'), 'BMI for a girl aged 10 years 6 months');
  await page.fill('#bm-dob', '2024-01-31');
  await page.fill('#bm-dom', '2026-02-28');
  assert.equal(await text('#bm-k'), 'BMI for a girl aged 2 years 1 month'); // 31 January to 28 February is a whole month
  await page.fill('#bm-dom', '2026-02-27');
  assert.equal(await text('#bm-k'), 'BMI for a girl aged 2 years');
  await page.fill('#bm-dom', '2026-12-01');
  await page.press('#bm-dom', 'Enter');
  assert.equal(await text('#bm-age-msg'), 'The date measured cannot be after today.');
  assert.deepEqual(await aria('#bm-dom'), ['bm-age-msg', 'true']);
  await page.fill('#bm-dom', '2015-01-01');
  await page.press('#bm-dom', 'Enter');
  assert.equal(await text('#bm-age-msg'), 'The date of birth is after the date measured.');
  assert.deepEqual([await aria('#bm-dob'), await page.getAttribute('#bm-dom', 'aria-invalid')], [['bm-age-msg', 'true'], null]);
  await page.fill('#bm-dob', '');
  r = await read();
  assert.equal(r.says, 'Enter the date of birth and the date measured.');
  await page.uncheck('#bm-usedates');
  assert.equal(await page.isVisible('#bm-years'), true);

  // ---- Errors: shown once typing pauses or the box is left, the box at fault marked ----
  await page.fill('#bm-years', '');
  await page.fill('#bm-months', '');
  const VALID = { '#bm-cm': '170', '#bm-kg': '65', '#bm-waist': '', '#bm-years': '', '#bm-months': '', '#bm-ft': '5', '#bm-in': '7', '#bm-st': '10', '#bm-stlb': '5' };
  // The box at fault is filled last: leaving a box shows its message at once.
  const errorCase = async (fill, msgId, want, bad) => {
    for (const [sel] of fill) await page.fill(sel, VALID[sel]);
    assert.equal(await text(msgId), '', `a valid value clears the message before: ${want}`);
    for (const [sel, v] of fill) await page.fill(sel, v);
    assert.equal(await text(msgId), '', `no message while typing: ${want}`);
    await page.clock.runFor(1000);
    assert.equal(await text(msgId), want);
    assert.equal(await invalid(), bad, want);
    for (const id of bad.split(' ')) assert.ok((await aria('#' + id))[0].split(' ').includes(msgId.slice(1)), `${id} points at ${msgId}`);
    r = await read();
    assert.deepEqual([r.bmi, r.cat, r.copy, r.says], ['–', '', true, 'Correct the box marked in red to see the BMI.'], want);
  };
  await errorCase([['#bm-cm', '29']], '#bm-h-msg', 'Enter a height from 30 to 275 cm.', 'bm-cm');
  await errorCase([['#bm-cm', '5\'9"']], '#bm-h-msg', 'That looks like feet and inches: choose ft and in as the unit.', 'bm-cm');
  await errorCase([['#bm-cm', '170²']], '#bm-h-msg', 'Enter the height as a number, such as 170 or 170.5.', 'bm-cm');
  await page.fill('#bm-cm', '170');
  await errorCase([['#bm-kg', '0,500']], '#bm-w-msg', 'Enter a weight from 4.5 to 454 kg.', 'bm-kg');
  await errorCase([['#bm-kg', '65\t70']], '#bm-w-msg', 'Enter the weight as a number, such as 65 or 65.5.', 'bm-kg');
  await errorCase([['#bm-kg', '1٬000']], '#bm-w-msg', 'Enter the weight as a number, such as 65 or 65.5.', 'bm-kg'); // Arabic thousands separator
  await errorCase([['#bm-kg', '1,000']], '#bm-w-msg', 'Enter a weight from 4.5 to 454 kg.', 'bm-kg');
  await errorCase([['#bm-kg', '65'], ['#bm-waist', '400']], '#bm-waist-msg', 'Enter a waist from 30 to 250 cm, or leave it empty.', 'bm-waist');
  await page.fill('#bm-waist', '');
  await errorCase([['#bm-years', '121']], '#bm-age-msg', 'Enter the age in whole years, from 0 to 120.', 'bm-years');
  await errorCase([['#bm-years', '3.5']], '#bm-age-msg', 'Enter the age in whole years, from 0 to 120.', 'bm-years');
  await errorCase([['#bm-years', '3'], ['#bm-months', '12']], '#bm-age-msg', 'Enter the extra months as a whole number from 0 to 11.', 'bm-months');
  await page.fill('#bm-years', '');
  await page.fill('#bm-months', '');
  await page.selectOption('#bm-hu', 'ftin');
  await errorCase([['#bm-in', ''], ['#bm-ft', '5.9']], '#bm-h-msg', 'Enter whole feet and put the rest in inches: 5 and 9 for 5 ft 9 in.', 'bm-ft');
  await errorCase([['#bm-ft', '5'], ['#bm-in', '12']], '#bm-h-msg', 'Inches must be under 12 when the feet are filled in.', 'bm-in');
  await errorCase([['#bm-in', '1'], ['#bm-ft', '9']], '#bm-h-msg', 'Enter a height from 1 ft to 9 ft.', 'bm-ft bm-in');
  await page.fill('#bm-ft', '5');
  await page.fill('#bm-in', '7');
  await page.selectOption('#bm-wu', 'stlb');
  await errorCase([['#bm-stlb', ''], ['#bm-st', '10.5']], '#bm-w-msg', 'Enter whole stones and put the rest in pounds: 11 and 4 for 11 st 4 lb.', 'bm-st');
  await errorCase([['#bm-st', '10'], ['#bm-stlb', '14']], '#bm-w-msg', 'Pounds must be under 14 when the stones are filled in.', 'bm-stlb');
  // Leaving the box shows a message at once; fixing it clears the mark.
  await page.fill('#bm-stlb', '20');
  await page.locator('#bm-stlb').blur();
  assert.equal(await text('#bm-w-msg'), 'Pounds must be under 14 when the stones are filled in.');
  await page.fill('#bm-stlb', '5');
  assert.deepEqual([await text('#bm-w-msg'), await invalid(), await text('#bm-bmi')], ['', '', '22.7']);
  // Digits from other scripts, full-width digits and the stones box on its own.
  await page.fill('#bm-st', '١٠'); // Arabic-Indic 10
  await page.fill('#bm-stlb', '٥');
  assert.equal(await text('#bm-bmi'), '22.7');
  await page.fill('#bm-st', '');
  await page.fill('#bm-stlb', '１４５'); // 145 lb as pounds only
  assert.equal(await text('#bm-bmi'), '22.7');

  // ---- A megabyte pasted into each box is refused at once ----
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const threadMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime').value * 1000;
  for (const [unitSel, unit, id] of [['#bm-hu', 'cm', 'bm-cm'], ['#bm-hu', 'ftin', 'bm-ft'], ['#bm-hu', 'ftin', 'bm-in'], ['#bm-wu', 'kg', 'bm-kg'], ['#bm-wu', 'lb', 'bm-lb'],
    ['#bm-wu', 'stlb', 'bm-st'], ['#bm-wu', 'stlb', 'bm-stlb'], [null, null, 'bm-waist'], [null, null, 'bm-years'], [null, null, 'bm-months']]) {
    if (unitSel) await page.selectOption(unitSel, unit);
    const before = await page.inputValue('#' + id);
    const t0 = await threadMs();
    await page.$eval('#' + id, el => { el.value = '7'.repeat(1 << 20); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    const spent = await threadMs() - t0;
    assert.ok(spent < 1500, `a megabyte in #${id} took ${Math.round(spent)} ms of main-thread time`);
    assert.equal(await page.getAttribute('#' + id, 'aria-invalid'), 'true', `#${id} is marked`);
    assert.match(await page.evaluate(i => document.getElementById(document.getElementById(i).getAttribute('aria-describedby').split(' ').pop()).textContent, id), /^That is too long for/);
    await page.fill('#' + id, before);
  }

  // ---- Switching units converts, and switching straight back restores what was typed ----
  await page.selectOption('#bm-hu', 'cm');
  await page.fill('#bm-cm', '170');
  await page.selectOption('#bm-wu', 'kg');
  await page.fill('#bm-kg', '65');
  await page.selectOption('#bm-hu', 'ftin');
  assert.deepEqual([await page.inputValue('#bm-ft'), await page.inputValue('#bm-in')], ['5', '6.9']);
  await page.selectOption('#bm-hu', 'cm');
  assert.equal(await page.inputValue('#bm-cm'), '170');
  await page.selectOption('#bm-wu', 'stlb');
  assert.deepEqual([await page.inputValue('#bm-st'), await page.inputValue('#bm-stlb')], ['10', '3.3']);
  await page.fill('#bm-stlb', '4');
  await page.selectOption('#bm-wu', 'kg');
  assert.equal(await page.inputValue('#bm-kg'), '65.3', 'an edited value is converted, not restored');
  // The waist follows the height unit.
  await page.fill('#bm-waist', '80');
  await page.selectOption('#bm-hu', 'ftin');
  assert.deepEqual([await page.inputValue('#bm-waist'), await text('#bm-waist-u')], ['31.5', 'in']);
  // Feet and inches typed in one box are split when the box is left.
  await page.fill('#bm-in', '');
  await page.fill('#bm-ft', '5\' 11"');
  assert.equal(await text('#bm-h-read'), 'Read as 5 ft 11 in.');
  await page.locator('#bm-ft').blur();
  assert.deepEqual([await page.inputValue('#bm-ft'), await page.inputValue('#bm-in')], ['5', '11']);

  // ---- The CDC data cannot be loaded: a message and a way to try again ----
  // (in a page of its own, as the failed request is logged as a console error)
  {
    const ctx = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
    const q = await ctx.newPage();
    await q.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)).*/, route => route.abort());
    let fail = true;
    await q.route('**/bmi-age-2022.csv', route => (fail ? route.fulfill({ status: 503, body: 'down' }) : route.continue()));
    await q.goto(url, { waitUntil: 'load' });
    await q.fill('#bm-years', '9');
    await q.check('input[name="bm-sex"][value="1"]');
    await q.waitForFunction(() => document.getElementById('bm-load-msg').textContent !== '');
    assert.equal(await q.locator('#bm-load-msg').textContent(), 'The CDC growth data could not be loaded. Check your connection and try again.');
    assert.equal(await q.isVisible('#bm-retry'), true);
    fail = false;
    await q.click('#bm-retry');
    await q.waitForFunction(() => /percentile/.test(document.getElementById('bm-says').textContent));
    assert.deepEqual([await q.locator('#bm-load-msg').textContent(), await q.isVisible('#bm-retry')], ['', false]);
    await ctx.close();
  }
  // Fields put back by the browser after the Back button are counted again.
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load' });
  await page.$eval('#bm-years', el => { el.value = '9'; window.dispatchEvent(new Event('pageshow')); });
  assert.equal(await text('#bm-k'), 'BMI for a child aged 9 years');

  // ---- Keyboard only ----
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load' });
  await page.focus('#bm-hu');
  await page.keyboard.press('ArrowUp'); // ft and in -> cm
  assert.equal(await page.inputValue('#bm-hu'), 'cm');
  await page.focus('#bm-cm');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('180');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bm-hu');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bm-lb');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('200');
  await page.keyboard.press('Enter');
  assert.deepEqual([await text('#bm-bmi'), await text('#bm-cat')], ['28.0', 'Overweight']);
  await page.focus('#bm-nice');
  await page.keyboard.press('Space');
  assert.equal(await text('#bm-cat'), 'Obesity, class 1');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid', 'the focused box shows a focus ring');
  await page.clock.runFor(100);
  assert.equal(await text('#bm-status'), 'BMI 28.0: obesity, class 1.');

  // ---- The FAQ ends with privacy ----
  const faqs = await page.locator('.faq summary').allTextContents();
  assert.ok(/sent anywhere/i.test(faqs[faqs.length - 1]), faqs.join(' | '));
  assert.ok(faqs.some(q => /women/.test(q)) && faqs.some(q => /percentile/.test(q)));

  const browser = page.context().browser();
  // ---- A British browser: feet, inches, stones and pounds ----
  const gb = await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  const gbPage = await gb.newPage();
  await gbPage.goto(url, { waitUntil: 'load' });
  assert.deepEqual([await gbPage.inputValue('#bm-hu'), await gbPage.inputValue('#bm-wu'), await gbPage.inputValue('#bm-st'), await gbPage.inputValue('#bm-stlb'), await gbPage.locator('#bm-bmi').textContent()],
    ['ftin', 'stlb', '10', '5', '22.7']);
  assert.equal((await gbPage.locator('#bm-facts li').first().textContent()), 'Healthy weight for 5 ft 7 in: 8 st 6 lb to 11 st 5 lb (BMI 18.5 to 24.9).');
  await gb.close();
  // ---- A German browser: metric, and a decimal comma ----
  const de = await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });
  const dePage = await de.newPage();
  await dePage.goto(url, { waitUntil: 'load' });
  assert.deepEqual([await dePage.inputValue('#bm-hu'), await dePage.inputValue('#bm-wu'), await dePage.inputValue('#bm-cm'), await dePage.inputValue('#bm-kg')], ['cm', 'kg', '170', '65']);
  await dePage.fill('#bm-kg', '70,5');
  await dePage.fill('#bm-cm', '172,5');
  assert.equal(await dePage.locator('#bm-bmi').textContent(), '23.7');
  await de.close();

  // ---- A phone with a touch screen ----
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await phone.newPage();
  await p.goto(url, { waitUntil: 'load' });
  await p.tap('#bm-ft');
  await p.fill('#bm-ft', '6');
  await p.tap('#bm-in');
  await p.fill('#bm-in', '0');
  await p.tap('#bm-lb');
  await p.fill('#bm-lb', '180');
  assert.deepEqual([await p.locator('#bm-bmi').textContent(), await p.locator('#bm-cat').textContent()], ['24.4', 'Healthy weight']);
  await p.tap('text=Work out the age from dates');
  assert.equal(await p.isVisible('#bm-dob'), true);
  await p.fill('#bm-dob', '1990-04-01');
  assert.deepEqual([await p.locator('#bm-bmi').textContent(), await p.locator('#bm-cat').textContent()], ['24.4', 'Healthy weight']);
  const modes = await p.$$eval('.bm input[type="text"]', els => els.map(e => [e.id, e.getAttribute('inputmode')]));
  for (const [id, mode] of modes) assert.equal(mode, /^bm-(ft|st|years|months)$/.test(id) ? 'numeric' : 'decimal', `${id} asks for the right keypad`);
  const sizes = await p.$$eval('.bm input:not([type="radio"]):not([type="checkbox"]), .bm select, .bm button, .bm .check', els => els.filter(e => e.offsetParent).map(e => ({
    id: e.id || e.textContent.trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height), font: parseFloat(getComputedStyle(e).fontSize), field: e.matches('input, select'),
  })));
  assert.ok(sizes.length >= 10, `found ${sizes.length} controls`);
  for (const s of sizes) {
    assert.ok(s.h >= 44, `${s.id} is ${s.h}px tall`);
    if (s.field) assert.ok(s.font >= 16, `${s.id} has ${s.font}px type`);
  }
  for (const width of [320, 340, 360, 390, 414, 480, 540]) {
    await p.setViewportSize({ width, height: 800 });
    const cut = await p.evaluate(() => {
      const c = document.createElement('canvas').getContext('2d'), out = [];
      for (const s of document.querySelectorAll('.bm select')) {
        const cs = getComputedStyle(s);
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 28;
        for (const o of s.options) if (c.measureText(o.textContent).width > room) out.push(`${s.id}: ${o.textContent}`);
      }
      for (const b of document.querySelectorAll('.bm button')) if (b.offsetParent && b.scrollWidth > b.clientWidth + 1) out.push(b.textContent);
      return out;
    });
    assert.deepEqual(cut, [], `cut off at ${width}px`);
    await p.waitForTimeout(50);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll at ${width}px`);
    assert.ok(await p.$eval('#bm-chart svg', s => s.getBoundingClientRect().right <= document.querySelector('.tool-card').getBoundingClientRect().right + 0.5), `the chart fits at ${width}px`);
  }
  await phone.close();
};
