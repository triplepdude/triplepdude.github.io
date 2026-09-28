// Expected values were computed independently with pyproj (PROJ, EPSG:326xx/327xx UTM)
// and the `mgrs` Python package (GEOTRANS), not with this page.
module.exports = async ({ page, open, assert }) => {
  await open();

  const val = id => page.textContent(id);
  const mode = m => page.check(`input[name="mg-mode"][value="${m}"]`);
  const ll = async s => { await mode('ll'); await page.fill('#mg-ll', s); };
  // Errors from typing wait for a pause or for the field to lose focus; blur to read them now.
  const err = async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    return page.textContent('#mg-error');
  };
  const within = (actual, lat, lon, tol, what) => {
    const [a, b] = actual.split(',').map(Number);
    assert.ok(Math.abs(a - lat) <= tol && Math.abs(b - lon) <= tol, `${what}: got ${actual}, want ${lat}, ${lon}`);
  };

  // Default point on load (New York): pyproj zone 18N E 585631.3970 N 4511326.9229.
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  assert.equal(await val('#mg-r-utm'), '18T 585631 4511327');
  assert.equal(await val('#mg-r-dd'), '40.748440, -73.985664');
  assert.equal(await val('#mg-r-dms'), '40\u00B044\'54.38"N 73\u00B059\'08.39"W');
  assert.equal(await val('#mg-r-ddm'), '40\u00B044.9064\'N 73\u00B059.1398\'W');
  assert.match(await val('#mg-r-mgrs-sub'), /18TWL8563111326/);
  assert.match(await val('#mg-r-gzd'), /zone 18 covers 78\u00B0W to 72\u00B0W, band T covers 40\u00B0N to 48\u00B0N/);

  // Precision levels truncate (mgrs package: 18TWL85631132, 18TWL856113, 18TWL8511, 18TWL81).
  const levels = { 4: '18T WL 8563 1132', 3: '18T WL 856 113', 2: '18T WL 85 11', 1: '18T WL 8 1' };
  for (const [p, want] of Object.entries(levels)) {
    await page.selectOption('#mg-prec', p);
    assert.equal(await val('#mg-big'), want);
  }
  await page.selectOption('#mg-prec', '5');

  // Norway exception: Bergen is in zone 32V (it would be 31V without the exception).
  await ll('60.39299, 5.32415');
  assert.equal(await val('#mg-big'), '32V KN 97477 00830');
  assert.equal(await val('#mg-r-utm'), '32V 297477 6700830');
  assert.match(await val('#mg-r-gzd'), /3\u00B0E to 12\u00B0E \(widened for the Norway exception\)/);

  // Southern hemisphere: Sydney. UTM rounds (334901), MGRS truncates (34900).
  await ll('-33.8568, 151.2153');
  assert.equal(await val('#mg-big'), '56H LH 34900 52288');
  assert.equal(await val('#mg-r-utm'), '56H 334901 6252289');
  assert.match(await val('#mg-r-utm-sub'), /southern hemisphere/);

  // Svalbard exception: zone 33X, 9\u00B0E to 21\u00B0E.
  await ll('78.2232 N, 15.6267 E');
  assert.equal(await val('#mg-big'), '33X WG 14278 83355');
  assert.equal(await val('#mg-r-utm'), '33X 514279 8683355');
  assert.match(await val('#mg-r-gzd'), /9\u00B0E to 21\u00B0E \(widened for the Svalbard exception\)/);

  // DMS and DDM input with hemisphere letters, and a point on the equator and a central meridian.
  await ll('51\u00B028\'40.1"N 0\u00B000\'05.3"W');
  assert.equal(await val('#mg-big'), '30U YC 08215 07225');
  assert.equal(await val('#mg-r-utm'), '30U 708216 5707225');
  await ll('22\u00B057.115\' S, 43\u00B012.629\' W');
  assert.equal(await val('#mg-big'), '23K PQ 83478 60685');
  assert.equal(await val('#mg-r-dms'), '22\u00B057\'06.90"S 43\u00B012\'37.74"W');
  await ll('0, 3');
  assert.equal(await val('#mg-big'), '31N EA 00000 00000');
  // Longitude first is fine when labelled.
  await ll('W 73.985664 N 40.748440');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');

  // Example button uses DMS: 60\u00B023'34.8"N 5\u00B019'26.9"E -> 32VKN9747600831.
  await page.click('button[data-example^="60"]');
  assert.equal(await val('#mg-big'), '32V KN 97476 00831');

  // Antimeridian (pyproj/mgrs): zone 60 just west of 180\u00B0, zone 1 just east of it.
  await ll('-16.5, 179.9999');
  assert.equal(await val('#mg-big'), '60K ZG 20277 73373');
  assert.equal(await val('#mg-r-utm'), '60K 820277 8173373');
  await ll('-16.5, -179.9999');
  assert.equal(await val('#mg-big'), '1K AB 79722 73373');
  assert.equal(await val('#mg-r-utm'), '1K 179723 8173373');
  // 64\u00B0N is outside the Norway exception (band W); just below it is 32V.
  await ll('64, 5');
  assert.equal(await val('#mg-big'), '31W EL 97812 98548');
  await ll('63.9999, 5');
  assert.equal(await val('#mg-big'), '32V LS 04448 03141');
  // The edges of MGRS coverage: 84\u00B0N and 80\u00B0S are still in the grid.
  await ll('84, 20');
  assert.equal(await val('#mg-big'), '33X WP 58278 30624');
  await ll('-80, -60');
  assert.equal(await val('#mg-big'), '21C VM 41867 16915');
  // A hair south of the equator is band M with a northing just under 10,000,000 m.
  await ll('-0.0000001, 0');
  assert.equal(await val('#mg-big'), '31M AV 66021 99999');
  // Pasted formats: brackets, a geo: URI (RFC 5870) and colon-separated DMS.
  await ll('(40.748440, -73.985664)');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  await ll('[40.748440, -73.985664]');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  await ll('geo:40.748440,-73.985664;u=35');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  // Regression: decimal commas (European style) were rejected.
  await ll('40,748440 -73,985664');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  await ll('40,748440; -73,985664');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  await ll('40:44:54.38N 73:59:08.39W');
  assert.equal(await val('#mg-r-dd'), '40.748439, -73.985664');
  assert.equal(await err(), '');
  // The page says up front that polar areas are not covered.
  assert.match(await page.textContent('#mg-panel-ll .hint'), /80\u00B0S to 84\u00B0N; the polar UPS grid is not supported/);

  // ---- MGRS to latitude/longitude: the centre of the square (pyproj inverse at +0.5 m). ----
  await mode('mgrs');
  await page.fill('#mg-mgrs', '32VKN9747700830');
  within(await val('#mg-r-dd'), 60.392994010, 5.324153053, 1.5e-6, '32VKN9747700830');
  assert.equal(await val('#mg-big'), '32V KN 97477 00830');
  assert.match(await val('#mg-note'), /centre of the 1 m square/);
  await page.fill('#mg-mgrs', '56h lh 34900 52288');
  within(await val('#mg-r-dd'), -33.856802269, 151.215299200, 1.5e-6, '56HLH3490052288');
  // 4 digits = 1 km square; the precision menu follows the input.
  await page.fill('#mg-mgrs', '33X WG 14 83');
  within(await val('#mg-r-dd'), 78.224473574, 15.636480511, 1.5e-6, '33XWG1483');
  assert.equal(await page.inputValue('#mg-prec'), '2');
  assert.equal(await val('#mg-big'), '33X WG 14 83');
  assert.match(await val('#mg-note'), /1 km square/);
  await page.selectOption('#mg-prec', '5');

  // MGRS errors.
  const mgrsErrors = {
    '18TWL123': /same number of digits/,
    // Regression: two digit groups of different lengths were silently split in half (8563 111326 -> 85631 11326).
    '18T WL 8563 111326': /same number of digits.*You gave 4 and 6/,
    '33ZXX': /UPS/,
    '32XMH1234': /32X does not exist/,
    '18TIL1234': /never uses the letters I and O/,
    '18TAL1234': /Column letter A is not used in zone 18/,
    '18TWW1234': /Row letter W/,
    '61TWL1234': /between 1 and 60/,
    'hello': /doesn.t look like an MGRS reference/
  };
  for (const [s, re] of Object.entries(mgrsErrors)) {
    await page.fill('#mg-mgrs', s);
    assert.match(await err(), re, s);
    assert.equal(await page.isVisible('#mg-out'), false);
  }

  // Only the 100 km square: the result is its centre (pyproj: E 550000, N 4550000 in zone 18N).
  await page.fill('#mg-mgrs', '18TWL');
  within(await val('#mg-r-dd'), 41.099739709, -74.404583508, 1.5e-6, '18TWL');
  assert.match(await val('#mg-note'), /100 km square/);
  assert.equal(await err(), '');
  await page.fill('#mg-mgrs', '18TWL8');
  assert.match(await err(), /You gave 1 digit\./);

  // ---- UTM to latitude/longitude ----
  await mode('utm');
  await page.fill('#mg-zone', '56');
  await page.selectOption('#mg-hemi', 'S');
  await page.fill('#mg-east', '334900');
  await page.fill('#mg-north', '6252288');
  within(await val('#mg-r-dd'), -33.856806698, 151.215293704, 1.5e-6, 'UTM 56S');
  assert.equal(await val('#mg-big'), '56H LH 34900 52288');
  // Bergen given in zone 31 (pyproj: 628077, 6697438) is re-expressed in standard zone 32.
  await page.fill('#mg-zone', '31');
  await page.selectOption('#mg-hemi', 'N');
  await page.fill('#mg-east', '628,077');
  await page.fill('#mg-north', '6697438');
  within(await val('#mg-r-dd'), 60.392991290, 5.324147283, 1.5e-6, 'UTM 31N');
  assert.equal(await val('#mg-big'), '32V KN 97477 00830');
  assert.match(await val('#mg-note'), /standard UTM zone 32/);
  await page.fill('#mg-zone', '61');
  assert.match(await err(), /zone must be a whole number from 1 to 60/);
  await page.fill('#mg-zone', '31');
  await page.fill('#mg-north', '9999999');
  assert.match(await err(), /north of 84/);
  await page.fill('#mg-north', 'abc');
  assert.match(await err(), /northing must be a number/);

  // Switching modes carries the point over: lat/long -> UTM fields.
  await ll('40.748440, -73.985664');
  await mode('utm');
  assert.equal(await page.inputValue('#mg-zone'), '18');
  assert.equal(await page.inputValue('#mg-hemi'), 'N');
  assert.equal(await page.inputValue('#mg-east'), '585631');
  assert.equal(await page.inputValue('#mg-north'), '4511327');
  within(await val('#mg-r-dd'), 40.748440736, -73.985668691, 1.5e-6, 'rounded UTM');
  assert.equal(await val('#mg-big'), '18T WL 85631 11327');
  await mode('mgrs');
  assert.equal(await page.inputValue('#mg-mgrs'), '18T WL 85631 11327');

  // ---- Latitude/longitude errors ----
  const llErrors = {
    '85, 10': /UPS/,
    '-80.5, 10': /south of 80/,
    '91, 0': /Latitude must be between/,
    '10, 200': /Longitude must be between/,
    '40.7': /exactly two coordinates/,
    '40 N 50 S': /Both coordinates are latitudes/,
    '40 60 0 N, 10 E': /less than 60/,
    'forty, ten': /Unexpected/
  };
  for (const [s, re] of Object.entries(llErrors)) {
    await ll(s);
    assert.match(await err(), re, s);
  }
  await ll('40.748440, -73.985664');
  assert.equal(await err(), '');

  // Typing a coordinate key by key doesn't announce a format error on every keystroke; a
  // half-typed value only reports its error after a pause, in a polite status region.
  assert.equal(await page.getAttribute('#mg-error', 'role'), 'status');
  await page.fill('#mg-ll', '');
  await page.evaluate(() => {
    window.__mgErrors = [];
    const box = document.querySelector('#mg-error');
    new MutationObserver(() => { if (box.textContent) window.__mgErrors.push(box.textContent); })
      .observe(box, { childList: true, characterData: true, subtree: true });
  });
  // Regression: the big result was an aria-live region, so every keystroke announced a new reference.
  // Now one summary is announced after typing pauses.
  assert.equal(await page.getAttribute('#mg-big', 'aria-live'), null);
  assert.equal(await page.getAttribute('#mg-note', 'aria-live'), null);
  await page.evaluate(() => {
    window.__mgStatus = [];
    const box = document.querySelector('#mg-status');
    new MutationObserver(() => window.__mgStatus.push(box.textContent)).observe(box, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#mg-ll').pressSequentially('51.5007, -0.1246', { delay: 30 });
  await page.waitForFunction(() => window.__mgStatus.length > 0, null, { timeout: 3000 });
  await page.waitForTimeout(300);
  const said = await page.evaluate(() => window.__mgStatus);
  assert.deepEqual(said, [`MGRS ${await val("#mg-big")}.`], JSON.stringify(said));
  assert.deepEqual(await page.evaluate(() => window.__mgErrors), []);
  assert.equal(await page.textContent('#mg-error'), '');
  assert.match(await val('#mg-big'), /^30U XC \d{5} \d{5}$/);
  await page.locator('#mg-ll').pressSequentially('x');
  assert.equal(await page.textContent('#mg-error'), '');
  await page.waitForFunction(() => document.querySelector('#mg-error').textContent !== '', null, { timeout: 2000 });
  assert.equal((await page.evaluate(() => window.__mgErrors)).length, 1);
  await ll('40.748440, -73.985664');

  // The focused segment of the "Convert from" control shows a visible ring whether or not it is
  // the checked (filled) one.
  const segShadow = () => page.$eval('input[name="mg-mode"]:focus-visible', el => getComputedStyle(el.closest('label')).boxShadow);
  await page.focus('#mg-ll');
  await page.keyboard.press('Shift+Tab');
  while (!(await page.evaluate(() => document.activeElement.name === 'mg-mode'))) await page.keyboard.press('Shift+Tab');
  const checkedShadow = await segShadow();
  assert.match(checkedShadow, /inset.*inset/, 'focus ring on the checked segment');
  const [accentText, accent] = await page.evaluate(() => {
    const d = document.createElement('div');
    document.body.appendChild(d);
    d.style.color = 'var(--accent-text)';
    const t = getComputedStyle(d).color;
    d.style.color = 'var(--accent)';
    const a = getComputedStyle(d).color;
    d.remove();
    return [t, a];
  });
  assert.ok(checkedShadow.includes(accentText) && checkedShadow.includes(accent), checkedShadow);
  await page.keyboard.press('ArrowRight');
  assert.match(await segShadow(), /inset.*inset/, 'focus ring after moving with the arrow keys');
  await mode('ll');

  // ---- USNG: the same reference written with spaces, plus its short in-zone form. ----
  await ll('40.748440, -73.985664');
  assert.equal(await val('#mg-r-usng'), '18T WL 85631 11326');
  assert.match(await val('#mg-r-usng-sub'), /shortened to WL 85631 11326\./);
  assert.match(await val('#mg-r-utm-sub'), /^Zone 18, northern hemisphere: 18N 585631 4511327/);

  // ---- DDM input in the Garmin style (hemisphere first). mgrs package: 18TWL8563111326 and
  // 32VKN9747600831; the decimal degrees are 44.906/60 and 59.140/60 worked out by hand. ----
  await ll('N40 44.906 W073 59.140');
  assert.equal(await val('#mg-r-dd'), '40.748433, -73.985667');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  assert.equal(await val('#mg-r-ddm'), '40°44.9060\'N 73°59.1400\'W');
  await ll('N60 23.580 E005 19.448');
  assert.equal(await val('#mg-big'), '32V KN 97476 00831');
  await page.click('button[data-example^="S22"]');
  assert.equal(await val('#mg-big'), '23K PQ 83478 60685');

  // ---- Regression: a value that rounds to zero printed as -0.000000 with a south hemisphere. ----
  await ll('-0.0000001, 0');
  assert.equal(await val('#mg-r-dd'), '0.000000, 0.000000');
  assert.equal(await val('#mg-r-dms'), '0°00\'00.00"N 0°00\'00.00"E');

  // ---- Regression: the reference this page gives for 84°N could not be read back, because the
  // centre of its square lies a hair north of 84° (pyproj: 84.000001, 20.000036). ----
  await mode('mgrs');
  await page.fill('#mg-mgrs', '33XWP5827830624');
  assert.equal(await err(), '');
  assert.equal(await val('#mg-r-dd'), '84.000001, 20.000036');
  assert.equal(await val('#mg-big'), '33X WP 58278 30624');
  assert.match(await val('#mg-note'), /just north of 84°N/);
  // A typed latitude past 84°N is still refused, and so is a USNG reference with a prefix typo.
  await page.fill('#mg-mgrs', 'USNG: 18T WL 85631 11326');
  assert.equal(await val('#mg-big'), '18T WL 85631 11326');
  await ll('84.2, 20');
  assert.match(await err(), /north of 84/);

  // ---- One-line UTM input. Expected points from pyproj (EPSG 326xx/327xx inverse). ----
  await mode('utm');
  const utm = async s => { await page.fill('#mg-utm-line', s); };
  await utm('18T 585628 4511322');
  within(await val('#mg-r-dd'), 40.748396012, -73.985704906, 1e-6, '18T line');
  assert.equal(await val('#mg-big'), '18T WL 85628 11322');
  assert.deepEqual([await page.inputValue('#mg-zone'), await page.inputValue('#mg-hemi'), await page.inputValue('#mg-east'), await page.inputValue('#mg-north')], ['18', 'N', '585628', '4511322']);
  await utm('Zone 18T, 585628mE, 4511322mN');
  assert.equal(await val('#mg-big'), '18T WL 85628 11322');
  await utm('18T 4511322N 585628E');
  assert.equal(await val('#mg-big'), '18T WL 85628 11322');
  // Metre units and thousands separators.
  await utm('18T 585,628m 4,511,322m');
  assert.equal(await val('#mg-big'), '18T WL 85628 11322');
  // N: northern hemisphere either way.
  await utm('18N 585628 4511322');
  assert.equal(await val('#mg-big'), '18T WL 85628 11322');
  assert.match(await val('#mg-note'), /18N: N is read as the northern hemisphere/);
  // S with a northing inside band S (32-40°N) is band S; outside it, the southern hemisphere.
  await utm('18S 585628 4200000');
  within(await val('#mg-r-dd'), 37.943553619, -74.025466449, 1e-6, '18S as band S');
  assert.equal(await val('#mg-big'), '18S WH 85628 00000');
  assert.match(await val('#mg-note'), /read as latitude band S/);
  assert.equal(await page.inputValue('#mg-hemi'), 'N');
  // A typed UTM value is exact, so its 1 m square is 34901 52289 (the mgrs package, going through
  // latitude and longitude, lands a micrometre short and writes 34900).
  await utm('56S 334901 6252289');
  within(await val('#mg-r-dd'), -33.85679784, 151.215304696, 1e-6, '56S as south');
  assert.equal(await val('#mg-big'), '56H LH 34901 52289');
  assert.match(await val('#mg-note'), /read as the southern hemisphere/);
  assert.equal(await page.inputValue('#mg-hemi'), 'S');
  await utm('18 south 585628 4200000');
  within(await val('#mg-r-dd'), -52.343607525, -73.743025547, 1e-6, '18 south');
  // A wrong band letter is pointed out; bad lines are explained.
  await utm('18X 585628 4511322');
  assert.match(await val('#mg-note'), /this point lies in band T, not X/);
  const utmErrors = { '18B 585628 4511322': /polar UPS grid/, '61T 585628 4511322': /1 to 60/, '18T 585628': /easting and then the northing/,
    '18T 58 45': /eastings lie between/, '18Q 585628E 4511322E': /Both numbers are labelled easting/, '18TT 585628 4511322': /"TT" is not a latitude band/ };
  for (const [s, re] of Object.entries(utmErrors)) {
    await utm(s);
    assert.match(await err(), re, s);
  }
  // Editing a field rewrites the line in its canonical form.
  await utm('18T 585628 4511322');
  await page.fill('#mg-east', '585631');
  assert.equal(await page.inputValue('#mg-utm-line'), '18T 585631 4511322');

  // ---- Batch: lines in mixed formats, and CSV with named columns. Expected values from the mgrs
  // package and pyproj (Empire State 18TWL8563111326, E 585631.40 N 4511326.92; Sydney
  // 56HLH3490052288, E 334900.57 N 6252288.75; Big Ben 30UXC9956409429; Tokyo 54SUE8843549293). ----
  await mode('batch');
  assert.equal(await page.isVisible('#mg-out'), false);
  const batchRows = () => page.$$eval('#mg-batch-body tr', trs => trs.map(t => [...t.children].map(c => c.textContent)));
  const batch = async text => {
    await page.evaluate(() => { document.querySelector('#mg-batch-sum').textContent = ''; });
    await page.fill('#mg-batch', text);
    await page.waitForFunction(() => /^Converted/.test(document.querySelector('#mg-batch-sum').textContent));
  };
  await batch('40.748440, -73.985664\n18T WL 85631 11326\n56H 334901 6252289\nN60 23.580 E005 19.448\n\nhello');
  let rowsNow = await batchRows();
  assert.deepEqual(rowsNow.map(r => [r[0], r[3]]), [['1', '18TWL8563111326'], ['2', '18TWL8563111326'], ['3', '56HLH3490152289'], ['4', '32VKN9747600831'], ['6', '']]);
  assert.match(rowsNow[4][5], /Unexpected "h"/);
  assert.equal(await page.textContent('#mg-batch-sum'), 'Converted 4 of 5 rows. Row 6 could not be read. See the note column.');
  // The CSV example: named columns, DMS in a cell, a row with an impossible latitude.
  await page.click('#mg-batch-example');
  await page.waitForFunction(() => /^Converted 4 of 5/.test(document.querySelector('#mg-batch-sum').textContent));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mg-batch-csv')]);
  assert.equal(dl.suggestedFilename(), 'coordinates-converted.csv');
  const csvText = require('fs').readFileSync(await dl.path(), 'utf8');
  assert.ok(csvText.startsWith('\uFEFF'), 'BOM for spreadsheet apps');
  const csv = csvText.slice(1).trim().split('\r\n');
  assert.equal(csv[0], 'name,latitude,longitude,latitude_converted,longitude_converted,mgrs,utm_zone,utm_band,utm_hemisphere,utm_easting,utm_northing,note,error');
  assert.equal(csv[1], 'Empire State Building,40.748440,-73.985664,40.748440,-73.985664,18TWL8563111326,18,T,N,585631.40,4511326.92,,');
  assert.equal(csv[2], 'Sydney Opera House,-33.8568,151.2153,-33.856800,151.215300,56HLH3490052288,56,H,S,334900.57,6252288.75,,');
  assert.match(csv[3], /^Big Ben,"51°30'02\.6""N","0°07'28\.7""W",51\.500722,-0\.124639,30UXC9956409429,30,U,N,699564\.74,5709429\.93,,$/);
  assert.equal(csv[4].split(',').slice(5, 11).join(','), '54SUE8843549293,54,S,N,388435.69,3949293.98');
  assert.match(csv[5], /^Nowhere,95,10(,){10}"Latitude must be between -90 and 90 degrees/);
  // Precision applies to the batch too (mgrs package at 4 digits per axis: 18TWL85631132).
  await page.selectOption('#mg-prec', '4');
  await page.waitForFunction(() => document.querySelector('#mg-batch-body td:nth-child(4)').textContent === '18TWL85631132');
  await page.selectOption('#mg-prec', '5');
  // Zone, hemisphere, easting and northing columns; quoted names; semicolons; formula-like cells.
  await batch('id;zone;hemisphere;easting;northing\n"=HYPERLINK(""x"")";56;S;334901;6252289\n"Smith; J";18;N;585628;4511322');
  rowsNow = await batchRows();
  assert.deepEqual(rowsNow.map(r => r[3]), ['56HLH3490152289', '18TWL8562811322']);
  const copied = await (async () => { await page.click('#mg-batch-copy'); return page.evaluate(() => navigator.clipboard.readText()); })();
  const copiedLines = copied.trim().split('\r\n');
  assert.equal(copiedLines[0], 'id,zone,hemisphere,easting,northing,latitude,longitude,mgrs,utm_zone,utm_band,utm_hemisphere,utm_easting,utm_northing,note,error');
  assert.ok(copiedLines[1].startsWith('"\'=HYPERLINK(""x"")",56,S,'), copiedLines[1]);
  assert.ok(copiedLines[2].startsWith('Smith; J,18,N,585628,4511322,40.748396,-73.985705,18TWL8562811322'), copiedLines[2]);
  // Decimal commas in a semicolon-separated file (European spreadsheets).
  await batch('name;lat;lon\nESB;40,748440;-73,985664');
  assert.equal((await batchRows())[0][3], '18TWL8563111326');
  // Regression: a UTM line with thousands separators or with the band joined to the easting was
  // read as latitude/longitude and rejected; decimal commas on a plain line failed too.
  await batch('Zone 18T, 585,628mE, 4,511,322mN\n18T585628 4511322\n40,748440 -73,985664\n-33.8568, 151.2153');
  const fixedRows = await batchRows();
  assert.deepEqual(fixedRows.map(r => r[3]), ['18TWL8562811322', '18TWL8562811322', '18TWL8563111326', '56HLH3490052288'], JSON.stringify(fixedRows));
  // A coordinate starting with a minus sign is not a formula, so it is written unchanged.
  await page.click('#mg-batch-copy');
  const plainCsv = (await page.evaluate(() => navigator.clipboard.readText())).trim().split('\r\n');
  assert.ok(plainCsv[4].startsWith('"-33.8568, 151.2153",-33.856800,151.215300,56HLH3490052288,'), plainCsv[4]);
  // A header with no rows under it says so instead of "0 of 0".
  await page.fill('#mg-batch', 'name,lat,lon\n');
  await page.waitForFunction(() => /no coordinates below the header/.test(document.querySelector('#mg-batch-sum').textContent));
  // Download before anything is entered explains what to do.
  await page.fill('#mg-batch', '');
  await page.waitForTimeout(400);
  await page.click('#mg-batch-csv');
  assert.match(await page.textContent('#mg-batch-sum'), /Paste some coordinates first/);
  // A tab-separated file opened from disk, with an MGRS column.
  await page.setInputFiles('#mg-batch-file', { name: 'points.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('label\tMGRS\nNYC\t18TWL8563111326\n') });
  await page.waitForFunction(() => document.querySelector('#mg-batch-sum').textContent === 'Converted 1 of 1 row.');
  within((await batchRows())[0][2], 40.748440, -73.985664, 1e-5, 'TSV MGRS row');
  // 20,000 rows are converted in slices, so the page never freezes.
  const lines = Array.from({ length: 20000 }, (_, i) => `${(-60 + i * 0.006).toFixed(4)}, ${(-170 + i * 0.017).toFixed(4)}`).join('\n');
  const longest = await page.evaluate(async text => {
    const tasks = [];
    const obs = new PerformanceObserver(l => l.getEntries().forEach(e => tasks.push(e.duration)));
    const el = document.querySelector('#mg-batch');
    el.value = text;
    await new Promise(r => setTimeout(r, 300));
    obs.observe({ entryTypes: ['longtask'] });
    el.dispatchEvent(new Event('input', { bubbles: true }));
    while (!/^Converted 20,000/.test(document.querySelector('#mg-batch-sum').textContent)) await new Promise(r => setTimeout(r, 20));
    obs.disconnect();
    return Math.max(0, ...tasks);
  }, lines);
  assert.ok(longest < 200, `batch blocked the page for ${Math.round(longest)} ms`);
  assert.equal(await page.locator('#mg-batch-body tr').count(), 200);
  assert.match(await page.textContent('#mg-batch-more'), /first 200 of 20,000 rows/);
  await mode('ll');
  assert.equal(await page.isVisible('#mg-out'), true);
  await ll('40.748440, -73.985664');

  // Copy button.
  await page.click('.mg-head button');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '18T WL 85631 11326');

  // ---- Use my location: denied first, then allowed ----
  await page.click('#mg-locate');
  await page.waitForFunction(() => /denied|not available|could not/.test(document.querySelector('#mg-error').textContent));
  assert.match(await err(), /Location access was denied/);
  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(['geolocation'], { origin });
  await page.context().setGeolocation({ latitude: -33.8568, longitude: 151.2153, accuracy: 12 });
  await page.click('#mg-locate');
  await page.waitForFunction(() => document.querySelector('#mg-ll').value === '-33.856800, 151.215300');
  assert.equal(await val('#mg-big'), '56H LH 34900 52288');
  assert.match(await val('#mg-note'), /about \u00B112 m/);
  assert.equal(await page.textContent('#mg-locate'), 'Use my location');
};
