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

  // Numbers with separators are one word, and don't end a sentence.
  await page.fill('#wc-input', 'It costs 3.5 million. Up 1,000 at 10:30!');
  assert.equal(await val('#wc-words'), '8');
  assert.equal(await val('#wc-sentences'), '2');

  // A decomposed accent (e + U+0301) must not split the word.
  await page.fill('#wc-input', 'cafe\u0301 au lait');
  assert.equal(await val('#wc-words'), '3');
  assert.equal(await val('#wc-chars'), '12');

  // Han and Kana count one word per character; Korean is space-separated.
  await page.fill('#wc-input', '日本語を話します。');
  assert.equal(await val('#wc-words'), '8');
  assert.equal(await val('#wc-sentences'), '1');
  await page.fill('#wc-input', '안녕하세요 세계');
  assert.equal(await val('#wc-words'), '2');

  // 1,000 words: 4 min 12 sec reading, 6 min 40 sec speaking (as the FAQ says).
  await page.fill('#wc-input', Array(1000).fill('word').join(' '));
  assert.equal(await val('#wc-reading'), '4 min 12 sec');
  assert.equal(await val('#wc-speaking'), '6 min 40 sec');

  await page.click('#wc-clear');
  assert.equal(await val('#wc-words'), '0');
  assert.equal(await page.inputValue('#wc-input'), '');
};
