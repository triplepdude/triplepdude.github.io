// Known answers follow the ls -l conventions (s/S, t/T) and were checked
// against GNU coreutils: on Linux the test also runs the page's numeric and
// symbolic commands through the real chmod on a temp file and compares the
// result from `stat -c '%a %A'`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async ({ page, open, assert }) => {
  await open();
  const text = sel => page.locator(sel).textContent();
  const val = sel => page.inputValue(sel);
  const bits = () => page.$$eval('input[data-bit]', els => els.filter(e => e.checked).reduce((a, e) => a + Number(e.dataset.bit), 0));
  const state = async () => ({
    oct: await val('#cm-octal'), sym: await val('#cm-symbolic'), num: await text('#cm-cmd-num'),
    cmd: await text('#cm-cmd-sym'), ls: await text('#cm-ls'), bits: await bits()
  });

  // Default: 755.
  let s = await state();
  assert.deepEqual(s, { oct: '755', sym: 'rwxr-xr-x', num: 'chmod 755 file', cmd: 'chmod u=rwx,g=rx,o=rx file', ls: '-rwxr-xr-x', bits: 0o755 });
  assert.equal(await text('#cm-d-u'), '7');
  assert.equal(await text('#cm-d-g'), '5');
  assert.equal(await text('#cm-d-o'), '5');
  assert.match(await text('#cm-explain'), /Owner can read, write and execute it\.Group can read and execute it\.Others can read and execute it\./);

  // Octal -> everything else, including the special bits.
  const cases = [
    ['644', 'rw-r--r--', 'u=rw,g=r,o=r'],
    ['600', 'rw-------', 'u=rw,g=,o='],
    ['4755', 'rwsr-xr-x', 'u=rwxs,g=rx,o=rx'],
    ['1777', 'rwxrwxrwt', 'u=rwx,g=rwx,o=rwx,+t'],
    ['2750', 'rwxr-s---', 'u=rwx,g=rxs,o='],
    ['4644', 'rwSr--r--', 'u=rws,g=r,o=r'],
    ['1776', 'rwxrwxrwT', 'u=rwx,g=rwx,o=rw,+t'],
    ['2644', 'rw-r-Sr--', 'u=rw,g=rs,o=r'],
    ['7777', 'rwsrwsrwt', 'u=rwxs,g=rwxs,o=rwx,+t'],
    ['7000', '--S--S--T', 'u=s,g=s,o=,+t'],
    ['000', '---------', 'u=,g=,o='],
  ];
  for (const [oct, sym, cmd] of cases) {
    await page.fill('#cm-octal', oct);
    s = await state();
    assert.equal(s.sym, sym, oct);
    assert.equal(s.ls, '-' + sym, oct);
    assert.equal(s.num, 'chmod ' + oct + ' file', oct);
    assert.equal(s.cmd, 'chmod ' + cmd + ' file', oct);
    assert.equal(s.bits, parseInt(oct, 8), oct);
    assert.equal(await text('#cm-err'), '', oct);
  }
  // Leading zeros are accepted; the numeric command is normalised.
  await page.fill('#cm-octal', '0644');
  assert.equal((await state()).num, 'chmod 644 file');
  await page.fill('#cm-octal', '00755');
  assert.equal((await state()).sym, 'rwxr-xr-x');

  // Invalid octal input is rejected and leaves the last good mode alone.
  for (const [bad, re] of [['8', /8 is not an octal digit/], ['789', /8 is not an octal digit/], ['79', /9 is not an octal digit/], ['0x1f', /digits 0 to 7/], ['12345', /Too many digits/], ['-755', /digits 0 to 7/]]) {
    await page.fill('#cm-octal', bad);
    assert.match(await text('#cm-err'), re, bad);
    assert.equal((await state()).sym, 'rwxr-xr-x', bad);
  }
  // A short value waits for more digits and complains only on blur.
  await page.fill('#cm-octal', '64');
  assert.equal(await text('#cm-err'), '');
  await page.locator('#cm-octal').blur();
  assert.match(await text('#cm-err'), /Enter 3 digits/);
  await page.fill('#cm-octal', '640');
  assert.equal(await text('#cm-err'), '');
  assert.equal((await state()).sym, 'rw-r-----');

  // Symbolic -> octal, with an optional file type and ACL/SELinux marker.
  for (const [sym, oct] of [['rwsr-xr-x', '4755'], ['-rw-r--r--', '644'], ['rwxr-s---', '2750'], ['rwSr--r--', '4644'], ['rwxrwxrwT', '1776'], ['-rw-r--r--.', '644'], ['-rwxr-x---+', '750']]) {
    await page.fill('#cm-symbolic', sym);
    assert.equal(await val('#cm-octal'), oct, sym);
    assert.equal(await bits(), parseInt(oct, 8), sym);
    assert.equal(await page.isChecked('#cm-dir'), false, sym);
  }
  await page.fill('#cm-symbolic', 'drwxrwxrwt');
  assert.equal(await val('#cm-octal'), '1777');
  assert.equal(await page.isChecked('#cm-dir'), true, 'd sets Directory');
  assert.equal(await text('#cm-ls'), 'drwxrwxrwt');
  assert.equal(await text('#cm-cmd-num'), 'chmod 1777 dir');
  assert.match(await text('#cm-explain'), /Others can list the contents, add or remove files and enter it\./);
  assert.match(await text('#cm-explain'), /sticky: only a file’s owner/);
  assert.match(await text('#cm-dirnote'), /To clear it too, use chmod 01777 dir\.$/);
  for (const [bad, re] of [['rwxrwxrwz', /Character 9 \(others execute\) must be x, t, T or -/], ['rwtr-xr-x', /Character 3 \(owner execute\) must be x, s, S or -/], ['qrwxr-xr-x', /file type/], ['rwxr-xr-xrwx', /Expected 9 characters/]]) {
    await page.fill('#cm-symbolic', bad);
    assert.match(await text('#cm-err'), re, bad);
    assert.equal(await val('#cm-octal'), '1777', bad);
  }
  await page.fill('#cm-symbolic', 'rwx');
  assert.equal(await text('#cm-err'), '');
  await page.locator('#cm-symbolic').blur();
  assert.match(await text('#cm-err'), /Expected 9 characters/);
  // Typing an ls -l string that starts with its file type shows no error
  // until it is complete (the d is not read as a permission).
  await page.fill('#cm-octal', '644');
  await page.uncheck('#cm-dir');
  await page.fill('#cm-symbolic', '');
  for (const ch of 'drwxr-x---') {
    await page.locator('#cm-symbolic').press(ch === '-' ? 'Minus' : ch);
    assert.equal(await text('#cm-err'), '', 'while typing ' + (await val('#cm-symbolic')));
  }
  assert.equal(await val('#cm-octal'), '750');
  assert.equal(await page.isChecked('#cm-dir'), true);
  await page.fill('#cm-symbolic', 'drwxr-xr-');
  await page.locator('#cm-symbolic').blur();
  assert.match(await text('#cm-err'), /Expected 9 characters/);
  await page.fill('#cm-octal', '1777');

  // Checkboxes -> octal and symbolic, live.
  await page.fill('#cm-octal', '000');
  await page.uncheck('#cm-dir');
  for (const label of ['Owner read', 'Owner write', 'Group read', 'Others read']) await page.getByLabel(label, { exact: true }).check();
  assert.equal(await val('#cm-octal'), '644');
  assert.equal(await val('#cm-symbolic'), 'rw-r--r--');
  await page.getByLabel('Owner execute').check();
  await page.locator('input[data-bit="2048"]').check();
  assert.equal(await val('#cm-octal'), '4744');
  assert.equal(await val('#cm-symbolic'), 'rwsr--r--');
  assert.equal(await text('#cm-d-s'), '4');
  await page.getByLabel('Owner execute').uncheck();
  assert.equal(await val('#cm-symbolic'), 'rwSr--r--');
  assert.match(await text('#cm-warnings'), /nobody can execute the file \(shown as S\), so it has no effect/);
  // Linux still honours setuid when group or others may execute (fs/exec.c
  // bprm_fill_uid checks only S_ISUID), so S is not "no effect" there.
  await page.getByLabel('Group execute').check();
  assert.equal(await val('#cm-symbolic'), 'rwSr-xr--');
  assert.match(await text('#cm-warnings'), /owner cannot execute the file \(shown as S\)\. Group members or others who run it still get the owner’s rights/);
  assert.doesNotMatch(await text('#cm-warnings'), /no effect/);
  await page.getByLabel('Group execute').uncheck();
  await page.locator('input[data-bit="2048"]').uncheck();
  await page.locator('input[data-bit="512"]').check();
  await page.getByLabel('Others execute').check();
  assert.equal(await val('#cm-octal'), '1645');
  assert.equal(await val('#cm-symbolic'), 'rw-r--r-t');

  // Warnings.
  await page.fill('#cm-octal', '777');
  assert.match(await text('#cm-warnings'), /Anyone on the system can change this file/);
  await page.check('#cm-dir');
  assert.match(await text('#cm-warnings'), /delete or replace files in this directory\. Add the sticky bit \(1777\)/);
  await page.fill('#cm-octal', '2777');
  assert.match(await text('#cm-warnings'), /sticky bit \(3777\)/);
  await page.fill('#cm-octal', '1777');
  assert.equal(await text('#cm-warnings'), '', 'sticky directory is fine');
  await page.fill('#cm-octal', '776');
  assert.equal(await text('#cm-warnings'), '', 'write without execute does nothing on a directory');
  await page.uncheck('#cm-dir');
  assert.match(await text('#cm-warnings'), /Anyone on the system can change this file/);
  await page.fill('#cm-octal', '077');
  assert.match(await text('#cm-warnings'), /owner has fewer rights/);
  assert.match(await text('#cm-explain'), /Owner has no access\..*Others can read, write and execute it\./);

  // File name, quoting and recursion.
  await page.fill('#cm-octal', '750');
  await page.fill('#cm-file', "my file's.sh");
  assert.equal(await text('#cm-cmd-num'), "chmod 750 'my file'\\''s.sh'");
  await page.fill('#cm-file', '-weird');
  assert.equal(await text('#cm-cmd-num'), 'chmod 750 ./-weird');
  // A leading dash needs ./ even when the name is quoted.
  await page.fill('#cm-file', '-my file');
  assert.equal(await text('#cm-cmd-num'), "chmod 750 './-my file'");
  // Wildcards stay unquoted so the shell expands them; $ is quoted.
  await page.fill('#cm-file', '*.sh');
  assert.equal(await text('#cm-cmd-num'), 'chmod 750 *.sh');
  await page.fill('#cm-file', '$HOME/x');
  assert.equal(await text('#cm-cmd-num'), "chmod 750 '$HOME/x'");
  await page.fill('#cm-file', 'public_html');
  await page.check('#cm-rec');
  assert.equal(await text('#cm-cmd-num'), 'chmod -R 750 public_html');
  assert.equal(await text('#cm-cmd-sym'), 'chmod -R u=rwx,g=rx,o= public_html');
  await page.uncheck('#cm-rec');
  await page.fill('#cm-file', '');

  // Live regions: typing a file name must not re-read the explanation or the
  // commands on every key; one short status follows once typing pauses.
  assert.equal(await page.locator('.cm-cmds[aria-live]').count(), 0);
  await page.evaluate(() => {
    window.__live = [];
    document.querySelectorAll('[aria-live], [role=alert], [role=status]').forEach(r => new MutationObserver(() =>
      window.__live.push([r.id || r.className, r.textContent.trim()])
    ).observe(r, { childList: true, subtree: true, characterData: true }));
  });
  await page.focus('#cm-file');
  await page.keyboard.type('deploy.sh', { delay: 30 });
  assert.equal(await text('#cm-cmd-num'), 'chmod 750 deploy.sh', 'commands still update at once');
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.evaluate(() => window.__live), [['cm-status', 'chmod 750 deploy.sh.']]);
  // A mode change still updates the explanation; so does the Directory box.
  await page.evaluate(() => { window.__live = []; });
  await page.check('#cm-dir');
  await page.waitForTimeout(1200);
  const live = await page.evaluate(() => window.__live);
  assert.ok(live.some(l => /Others have no access/.test(l[1]) || /Owner can list the contents/.test(l[1])), JSON.stringify(live));
  assert.match((await page.evaluate(() => window.__live)).filter(l => l[0] === 'cm-status').pop()[1], /^chmod 750 deploy\.sh\. GNU chmod keeps/);
  await page.fill('#cm-octal', '755');
  assert.match(await text('#cm-explain'), /Others can list the contents and enter it\./);
  await page.uncheck('#cm-dir');
  await page.fill('#cm-file', '');
  await page.fill('#cm-octal', '750');

  // Presets.
  assert.equal(await page.locator('#cm-presets tr').count(), 10);
  await page.click('button[data-preset="1777"]');
  assert.equal(await val('#cm-octal'), '1777');
  assert.equal(await val('#cm-symbolic'), 'rwxrwxrwt');
  assert.equal(await page.isChecked('#cm-dir'), true);
  await page.click('button[data-preset="2775"]');
  assert.equal(await text('#cm-dirnote'), '', 'no note when setgid is part of the mode');
  await page.click('button[data-preset="755"]');
  assert.match(await text('#cm-dirnote'), /use chmod 00755 dir\.$/);
  await page.click('button[data-preset="4755"]');
  assert.equal(await text('#cm-dirnote'), '', 'no note for files');
  assert.equal(await val('#cm-symbolic'), 'rwsr-xr-x');
  assert.equal(await page.isChecked('#cm-dir'), false);
  await page.click('button[data-preset="600"]');
  assert.equal(await text('#cm-cmd-sym'), 'chmod u=rw,g=,o= file');
  const presetSyms = await page.$$eval('#cm-presets tr', trs => trs.map(tr => tr.cells[0].textContent + ' ' + tr.cells[1].textContent));
  assert.deepEqual(presetSyms, ['644 rw-r--r--', '600 rw-------', '400 r--------', '755 rwxr-xr-x', '700 rwx------', '750 rwxr-x---', '777 rwxrwxrwx', '4755 rwsr-xr-x', '2775 rwxrwsr-x', '1777 rwxrwxrwt']);

  // Copy button.
  await page.fill('#cm-octal', '2775');
  await page.click('button[aria-label="Copy symbolic chmod command"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'chmod u=rwx,g=rwxs,o=rx file');

  // Independent check with GNU chmod: both commands must produce the mode
  // and the ls string the page shows.
  let gnu = false;
  try { gnu = process.platform === 'linux' && /GNU coreutils/.test(execFileSync('chmod', ['--version']).toString()); } catch (e) { gnu = false; }
  if (gnu) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chmod-test-'));
    try {
      for (const oct of ['644', '755', '4755', '1777', '2750', '4644', '1776', '2644', '0600', '6711', '7000']) {
        await page.fill('#cm-octal', oct);
        const st = await state();
        for (const cmd of [st.num, st.cmd]) {
          const f = path.join(dir, 'file');
          fs.rmSync(f, { force: true });
          fs.writeFileSync(f, '');
          fs.chmodSync(f, 0o7777); // start from 7777 so the command must also clear bits
          execFileSync('chmod', [cmd.split(' ')[1], f]);
          const [a, A] = execFileSync('stat', ['-c', '%a %A', f]).toString().trim().split(' ');
          assert.equal(parseInt(a, 8), parseInt(oct, 8), `${cmd} -> ${a}`);
          assert.equal(A, st.ls, `${cmd} -> ${A}`);
        }
      }
      // The quoting must survive a real shell: odd names and a wildcard.
      await page.uncheck('#cm-dir');
      await page.fill('#cm-octal', '640');
      for (const [name, files] of [["-x y's", ["-x y's"]], ['*.sh', ['a.sh', 'b c.sh']], ['$HOME', ['$HOME']]]) {
        const sub = fs.mkdtempSync(path.join(dir, 'q-'));
        for (const f of files) { fs.writeFileSync(path.join(sub, f), ''); fs.chmodSync(path.join(sub, f), 0o777); }
        await page.fill('#cm-file', name);
        for (const cmd of [await text('#cm-cmd-num'), await text('#cm-cmd-sym')]) {
          for (const f of files) fs.chmodSync(path.join(sub, f), 0o777);
          execFileSync('sh', ['-c', cmd], { cwd: sub });
          for (const f of files) assert.equal((fs.statSync(path.join(sub, f)).mode & 0o7777).toString(8), '640', `${cmd} on ${f}`);
        }
      }
      await page.fill('#cm-file', '');
      // On a directory, the numeric command keeps setuid/setgid (GNU rule),
      // and the five-digit form the page suggests clears them.
      await page.check('#cm-dir');
      await page.fill('#cm-octal', '750');
      const d = path.join(dir, 'dir');
      fs.mkdirSync(d);
      const st = await state();
      fs.chmodSync(d, 0o6775);
      execFileSync('chmod', [st.num.split(' ')[1], d]);
      assert.equal(execFileSync('stat', ['-c', '%a', d]).toString().trim(), '6750', 'GNU keeps dir setuid/setgid');
      const suggested = (await text('#cm-dirnote')).match(/use chmod (\d+) dir\.$/)[1];
      assert.equal(suggested, '00750');
      execFileSync('chmod', [suggested, d]);
      assert.equal(execFileSync('stat', ['-c', '%a %A', d]).toString().trim(), '750 ' + st.ls);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
};
