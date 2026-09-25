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
  await page.locator('#mg-ll').pressSequentially('51.5007, -0.1246', { delay: 30 });
  await page.waitForTimeout(1000);
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
