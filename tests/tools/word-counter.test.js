module.exports = async ({ page, open, assert }) => {
  await open();
  const val = id => page.locator(id).textContent();

  assert.equal(await val('#wc-words'), '0');

  await page.fill('#wc-input', "Hello world. It's a well-known fact!\n\nSecond paragraph here? Yes.");
  assert.equal(await val('#wc-words'), '10');
  assert.equal(await val('#wc-sentences'), '4');
  assert.equal(await val('#wc-paragraphs'), '2');
  assert.equal(await val('#wc-chars'), '65');
  assert.equal(await val('#wc-chars-ns'), '55');

  // Emoji and combining accents count as one character each.
  await page.fill('#wc-input', 'café 👍🏽');
  assert.equal(await val('#wc-chars'), '6');
  assert.equal(await val('#wc-words'), '1');

  // 476 words at 238 wpm is exactly 2 minutes.
  await page.fill('#wc-input', Array(476).fill('word').join(' '));
  assert.equal(await val('#wc-reading'), '2 min');

  await page.click('#wc-clear');
  assert.equal(await val('#wc-words'), '0');
  assert.equal(await page.inputValue('#wc-input'), '');
};
