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

  // Live regions: nothing that is redrawn per keystroke is live. One short status
  // follows once typing pauses: the command for a name change, the mode summary for a
  // mode change, the error for bad input (never an alert).
  assert.equal(await page.locator('.cm-cmds[aria-live], #cm-explain[aria-live], [role=alert]').count(), 0);
  assert.equal(await page.locator('#cm-explain').evaluate(el => !!el.closest('[aria-live]')), false);
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
  await page.evaluate(() => { window.__live = []; });
  await page.check('#cm-dir');
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.evaluate(() => window.__live), [['cm-status', '750, rwxr-x---. Owner can list the contents, add or remove files and enter it. Group can list the contents and enter it. Others have no access.']]);
  // Typing a new octal mode digit by digit gives one summary, not one per key.
  await page.evaluate(() => { window.__live = []; });
  await page.fill('#cm-octal', '');
  await page.type('#cm-octal', '1777', { delay: 40 });
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.evaluate(() => window.__live), [['cm-status', '1777, rwxrwxrwt. Owner can list the contents, add or remove files and enter it. Group can list the contents, add or remove files and enter it. Others can list the contents, add or remove files and enter it.']]);
  // An error while typing is shown at once but read out politely, once.
  await page.evaluate(() => { window.__live = []; });
  await page.type('#cm-octal', '8', { delay: 40 });
  assert.match(await text('#cm-err'), /8 is not an octal digit/);
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.evaluate(() => window.__live), [['cm-status', '8 is not an octal digit. Each digit must be 0 to 7.']]);
  assert.equal(await page.getAttribute('#cm-octal', 'aria-invalid'), 'true');
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

  // ---------- umask ----------
  const um = async () => ({ u: await val('#cm-umask'), f: await val('#cm-ufile'), d: await val('#cm-udir'), cmd: await text('#cm-umask-cmd'), sym: await text('#cm-umask-sym') });
  assert.deepEqual(await um(), { u: '022', f: '644', d: '755', cmd: 'umask 022', sym: 'u=rwx,g=rx,o=rx' });
  // Known answers: files 666 & ~umask, directories 777 & ~umask, and the umask -S
  // form, all confirmed against real bash below when it is available.
  const UM = [
    ['027', '027', '640', '750', 'u=rwx,g=rx,o='], ['077', '077', '600', '700', 'u=rwx,g=,o='],
    ['002', '002', '664', '775', 'u=rwx,g=rwx,o=rx'], ['000', '000', '666', '777', 'u=rwx,g=rwx,o=rwx'],
    ['777', '777', '000', '000', 'u=,g=,o='], ['0022', '022', '644', '755', 'u=rwx,g=rx,o=rx'],
    ['7', '007', '660', '770', 'u=rwx,g=rwx,o='], ['133', '133', '644', '644', 'u=rw,g=r,o=r'],
    ['u=rwx,g=rx,o=', '027', '640', '750', 'u=rwx,g=rx,o='], ['u=rwx,go=', '077', '600', '700', 'u=rwx,g=,o='],
    ['a=rx', '222', '444', '555', 'u=rx,g=rx,o=rx'], ['1022', '022', '644', '755', 'u=rwx,g=rx,o=rx'],
  ];
  for (const [input, u, f, d, sym] of UM) {
    await page.fill('#cm-umask', input);
    assert.equal(await text('#cm-umask-err'), '', input);
    const r = await um();
    assert.deepEqual([r.f, r.d, r.cmd, r.sym], [f, d, 'umask ' + u, sym], input);
    assert.match(await text('#cm-umask-f'), new RegExp('^' + f + ' '), input);
  }
  assert.match(await text('#cm-umask-note'), /first digit is ignored/);
  // Unnamed classes keep their setting, as in bash (umask 027; umask g=rwx -> 0007).
  await page.fill('#cm-umask', '027');
  await page.fill('#cm-umask', 'g=rwx');
  assert.equal(await text('#cm-umask-cmd'), 'umask 007');
  for (const [bad, re] of [['g-w', /changes the umask the shell already has/], ['abc', /not a umask clause/], ['089', /8 is not an octal digit/], ['', /Enter a umask/], ['12345', /Too many digits/]]) {
    await page.fill('#cm-umask', bad);
    assert.match(await text('#cm-umask-err'), re, bad);
    assert.equal(await page.getAttribute('#cm-umask', 'aria-invalid'), 'true', bad);
    assert.equal(await text('#cm-umask-cmd'), 'umask 007', 'last good umask kept for ' + bad);
  }
  // Reverse: the mode new files or directories should get.
  const FILES = [['640', '027', '750', /026 gives files 640 too/], ['600', '077', '700', /066 gives files 600 too/], ['664', '002', '775', null], ['644', '022', '755', null], ['400', '277', '500', /266 gives files 400/]];
  for (const [f, u, d, note] of FILES) {
    await page.fill('#cm-ufile', f);
    assert.equal(await text('#cm-umask-err'), '', f);
    assert.deepEqual([await val('#cm-umask'), await val('#cm-udir')], [u, d], 'file ' + f);
    if (note) assert.match(await text('#cm-umask-note'), note, f); else assert.equal(await text('#cm-umask-note'), '', f);
  }
  await page.fill('#cm-ufile', '755');
  assert.match(await text('#cm-umask-err'), /never get execute from the umask/);
  await page.fill('#cm-ufile', '64');
  assert.equal(await text('#cm-umask-err'), '', 'waits for the third digit');
  await page.locator('#cm-ufile').blur();
  assert.match(await text('#cm-umask-err'), /Enter 3 digits/);
  for (const [d, u, f] of [['750', '027', '640'], ['700', '077', '600'], ['711', '066', '600'], ['2775', null, null]]) {
    await page.fill('#cm-udir', d);
    if (!u) { assert.match(await text('#cm-umask-err'), /not setuid, setgid or sticky/); continue; }
    assert.deepEqual([await val('#cm-umask'), await val('#cm-ufile')], [u, f], 'dir ' + d);
  }
  await page.click('button[data-umask="077"]');
  assert.deepEqual(await um(), { u: '077', f: '600', d: '700', cmd: 'umask 077', sym: 'u=rwx,g=,o=' });
  assert.equal(await text('#cm-umask-err'), '');
  await page.click('button[data-umask="027"]');
  await page.click('#cm-use-d');
  assert.equal(await val('#cm-octal'), '750');
  assert.equal(await page.isChecked('#cm-dir'), true);
  await page.click('#cm-use-f');
  assert.equal(await val('#cm-octal'), '640');
  assert.equal(await page.isChecked('#cm-dir'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cm-use-f', 'focus stays on the button');

  // Confirm the umask answers with real bash: umask -S, and the modes touch and mkdir create.
  let bash = false;
  try { bash = process.platform === 'linux' && /bash/.test(execFileSync('bash', ['--version']).toString()); } catch (e) { bash = false; }
  if (bash) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umask-test-'));
    try {
      for (const [input, u, f, d, sym] of UM.concat(FILES.map(([ff, uu, dd]) => [uu, uu, ff, dd, null]))) {
        const out = execFileSync('bash', ['-c', `umask ${u} && umask -S && rm -rf f d && touch f && mkdir d && stat -c %a f d`], { cwd: dir }).toString().trim().split('\n');
        if (sym) assert.equal(out[0], sym, `bash umask -S for ${u}`);
        assert.deepEqual(out.slice(1).map(x => x.padStart(3, '0')), [f, d], `bash modes for umask ${u}`);
      }
      // bash leaves unnamed classes alone and ignores a special-bits digit.
      assert.equal(execFileSync('bash', ['-c', 'umask 027; umask g=rwx; umask; umask 1022; umask']).toString().trim(), '0007\n0022');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------- ls -l output ----------
  const lsRows = () => page.$$eval('#cm-ls-body tr', trs => trs.map(tr => ({
    name: tr.cells[0].firstChild ? tr.cells[0].firstChild.textContent : '', target: (tr.cells[0].querySelector('small') || {}).textContent || '',
    type: tr.cells[1].textContent, perm: tr.cells[2].textContent, oct: tr.cells[3].textContent, owner: tr.cells[4].textContent,
    notes: tr.cells[5].textContent, load: !!tr.cells[6].querySelector('button')
  })));
  // The sample on load.
  let ls = await lsRows();
  assert.deepEqual(ls.map(r => [r.name, r.oct, r.owner, r.type]), [
    ['shared', '2775', 'alice:devs', 'Directory, ACL'], ['/usr/bin/passwd', '4755', 'root:root', 'File'],
    ['bin', '777', 'root:root', 'Symbolic link'], ['id ed25519', '600', 'alice:alice', 'File']]);
  assert.equal(ls[2].target, '→ usr/bin');
  assert.equal(ls[2].load, false, 'no Load button for a symbolic link');
  assert.match(ls[0].notes, /ACL.*getfacl.*setgid/);
  assert.match(ls[1].notes, /SELinux/);
  // Hand-written lines for markers and formats this machine may not produce.
  await page.fill('#cm-lsin', [
    'total 12',
    'drwxr-xr-x@ 12 alice  staff   384 Mar  3 09:15 Photos Library.photoslibrary',
    '-rw-r--r-- 1 anna anna 1234  3. Mär 09:15 bericht.txt',
    'crw-rw-rw- 1 root root 1, 3 Sep 19 01:27 /dev/null',
    '-rw-r--r-- 1 root root 4.0K Jan  1  2024 a -> b.txt',
    'brw-rw---- 1 root disk 8, 0 2026-09-19 01:27 /dev/sda',
    'prw-r--r-- 1 root root 0 2026-09-27 20:36:09.294068952 +0000 pipe',
    '-rw-r--r-- 1 root root 0 Sep 27 20:36 \'it\'\\\'\'s here.txt\'',
    './sub:',
    'srwxrwxrwx 1 root root 0 Sep 27 20:36 sock',
  ].join('\n'));
  ls = await lsRows();
  assert.deepEqual(ls.map(r => [r.name, r.type, r.oct, r.owner]), [
    ['Photos Library.photoslibrary', 'Directory', '755', 'alice:staff'],
    ['bericht.txt', 'File', '644', 'anna:anna'],
    ['/dev/null', 'Character device', '666', 'root:root'],
    ['a -> b.txt', 'File', '644', 'root:root'],
    ['/dev/sda', 'Block device', '660', 'root:disk'],
    ['pipe', 'Named pipe (FIFO)', '644', 'root:root'],
    ["it's here.txt", 'File', '644', 'root:root'],
    ['sock', 'Socket', '777', 'root:root'],
  ]);
  assert.match(ls[0].notes, /extended attributes \(macOS/);
  assert.match(ls[2].notes, /Device number 1, 3 \(major, minor\)/);
  assert.equal(await text('#cm-ls-err'), '');
  // Load puts the mode, the type and the name into the calculator; focus stays put.
  await page.fill('#cm-lsin', 'drwxrwsr-x+ 4 alice devs 4096 Mar  3 09:15 shared files');
  await page.click('#cm-ls-body button');
  assert.deepEqual([await val('#cm-octal'), await val('#cm-file'), await page.isChecked('#cm-dir')], ['2775', 'shared files', true]);
  assert.equal(await text('#cm-cmd-num'), "chmod 2775 'shared files'");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Load');
  await page.fill('#cm-file', '');
  // Errors: nothing recognisable, or some lines skipped.
  await page.fill('#cm-lsin', 'hello\nworld');
  assert.match(await text('#cm-ls-err'), /No ls -l lines found/);
  assert.equal(await page.isVisible('#cm-ls-wrap'), false);
  await page.fill('#cm-lsin', 'hello\n-rw-r----- 1 a b 0 Jan  1 12:00 x');
  assert.match(await text('#cm-ls-err'), /1 line was skipped.*"hello"/);
  assert.equal((await lsRows()).length, 1);
  // A whole ls -l line pasted into the Symbolic box works too.
  await page.fill('#cm-symbolic', '-rwxr-x--- 1 a b 0 Jan 1 12:00 x');
  assert.equal(await val('#cm-octal'), '750');
  // A long paste stays fast (only the first 500 entries are listed).
  const lsMs = await page.evaluate(() => {
    const el = document.querySelector('#cm-lsin');
    el.value = Array.from({ length: 5000 }, (_, i) => '-rw-r--r-- 1 user group ' + i + ' Jan  1 12:00 file ' + i).join('\n');
    const t = performance.now();
    el.dispatchEvent(new Event('input'));
    return performance.now() - t;
  });
  assert.ok(lsMs < 300, `5,000 lines took ${lsMs} ms`);
  assert.equal((await lsRows()).length, 500);
  await page.click('#cm-ls-clear');
  assert.equal(await val('#cm-lsin'), '');
  assert.equal(await text('#cm-ls-err'), '');

  // Real ls output: parse what GNU ls prints here and compare with stat.
  let gnuLs = false;
  try { gnuLs = process.platform === 'linux' && /GNU coreutils/.test(execFileSync('ls', ['--version']).toString()); } catch (e) { gnuLs = false; }
  if (gnuLs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'plain.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'my file.txt'), '');
      fs.writeFileSync(path.join(dir, "it's.sh"), '');
      fs.mkdirSync(path.join(dir, 'sub dir'));
      fs.symlinkSync('plain.txt', path.join(dir, 'link'));
      fs.chmodSync(path.join(dir, 'plain.txt'), 0o4751);
      fs.chmodSync(path.join(dir, 'sub dir'), 0o1777);
      fs.chmodSync(path.join(dir, "it's.sh"), 0o2710);
      execFileSync('mkfifo', [path.join(dir, 'fifo')]);
      const stat = Object.fromEntries(execFileSync('bash', ['-c', "stat -c '%n|%a|%U:%G|%F' *"], { cwd: dir }).toString().trim().split('\n')
        .map(l => l.split('|')).map(([n, a, o, t]) => [n, { oct: a, owner: o, type: t }]));
      for (const args of [['-l'], ['-l', '--time-style=long-iso'], ['-l', '--time-style=full-iso'], ['-lis'], ['-lh'], ['-l', '--quoting-style=shell-escape'], ['-l', '--time-style=iso']]) {
        const out = execFileSync('ls', args, { cwd: dir, env: { LC_ALL: 'C', PATH: process.env.PATH } }).toString();
        await page.fill('#cm-lsin', out);
        assert.equal(await text('#cm-ls-err'), '', args.join(' '));
        ls = await lsRows();
        assert.equal(ls.length, Object.keys(stat).length, args.join(' '));
        for (const r of ls) {
          const st = stat[r.name];
          assert.ok(st, `${args.join(' ')}: unknown name ${JSON.stringify(r.name)}`);
          assert.equal(r.oct.padStart(3, '0'), st.oct.padStart(3, '0'), `${args.join(' ')}: ${r.name}`);
          assert.equal(r.owner, st.owner, `${args.join(' ')}: owner of ${r.name}`);
          assert.equal(r.type.replace(', ACL', '').toLowerCase().replace('named pipe (fifo)', 'fifo'), st.type.replace('regular empty file', 'file').replace('regular file', 'file').replace('symbolic link', 'symbolic link'), `${args.join(' ')}: type of ${r.name}`);
        }
        assert.equal(ls.find(r => r.name === 'link').target, '→ plain.txt');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

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
