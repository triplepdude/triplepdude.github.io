const fs = require('fs');

// Expected values computed independently with Python's ipaddress module:
//   iface = ipaddress.IPv4Interface(case); n = iface.network
//   network_address, broadcast_address, hosts()[0], hosts()[-1], num_addresses, netmask, hostmask,
//   int(iface.ip), iface.ip.reverse_pointer, format(int(iface.ip), '032b')
const CASES = [
  { in: '192.168.1.10/24', network: '192.168.1.0', broadcast: '192.168.1.255', first: '192.168.1.1', last: '192.168.1.254', usable: '254', total: '256', netmask: '255.255.255.0', wildcard: '0.0.0.255', cidr: '192.168.1.0/24', int: '3232235786', hex: '0xC0A8010A', rev: '10.1.168.192.in-addr.arpa', bin: '11000000101010000000000100001010', cls: 'C', type: /Private network \(RFC 1918\)/ },
  { in: '10.20.30.40 255.255.240.0', network: '10.20.16.0', broadcast: '10.20.31.255', first: '10.20.16.1', last: '10.20.31.254', usable: '4,094', total: '4,096', netmask: '255.255.240.0', wildcard: '0.0.15.255', cidr: '10.20.16.0/20', int: '169090600', hex: '0x0A141E28', rev: '40.30.20.10.in-addr.arpa', bin: '00001010000101000001111000101000', cls: 'A', type: /RFC 1918/ },
  { in: '172.16.5.4 0.0.15.255', network: '172.16.0.0', broadcast: '172.16.15.255', first: '172.16.0.1', last: '172.16.15.254', usable: '4,094', total: '4,096', netmask: '255.255.240.0', wildcard: '0.0.15.255', cidr: '172.16.0.0/20', int: '2886731012', hex: '0xAC100504', rev: '4.5.16.172.in-addr.arpa', bin: '10101100000100000000010100000100', cls: 'B', type: /RFC 1918/ },
  { in: '100.64.1.1/10', network: '100.64.0.0', broadcast: '100.127.255.255', first: '100.64.0.1', last: '100.127.255.254', usable: '4,194,302', total: '4,194,304', netmask: '255.192.0.0', wildcard: '0.63.255.255', cidr: '100.64.0.0/10', int: '1681916161', hex: '0x64400101', rev: '1.1.64.100.in-addr.arpa', bin: '01100100010000000000000100000001', cls: 'A', type: /carrier-grade NAT \(RFC 6598\)/ },
  { in: '8.8.8.8/32', network: '8.8.8.8', broadcast: null, first: '8.8.8.8', last: '8.8.8.8', usable: '1', total: '1', netmask: '255.255.255.255', wildcard: '0.0.0.0', cidr: '8.8.8.8/32', int: '134744072', hex: '0x08080808', rev: '8.8.8.8.in-addr.arpa', bin: '00001000000010000000100000001000', cls: 'A', type: /^Public/ },
  { in: '10.0.0.1/31', network: '10.0.0.0', broadcast: null, first: '10.0.0.0', last: '10.0.0.1', usable: '2', total: '2', netmask: '255.255.255.254', wildcard: '0.0.0.1', cidr: '10.0.0.0/31', int: '167772161', hex: '0x0A000001', rev: '1.0.0.10.in-addr.arpa', bin: '00001010000000000000000000000001', cls: 'A', type: /RFC 1918/ },
  { in: '0.0.0.0/0', network: '0.0.0.0', broadcast: '255.255.255.255', first: '0.0.0.1', last: '255.255.255.254', usable: '4,294,967,294', total: '4,294,967,296', netmask: '0.0.0.0', wildcard: '255.255.255.255', cidr: '0.0.0.0/0', int: '0', hex: '0x00000000', rev: '0.0.0.0.in-addr.arpa', bin: '0'.repeat(32), cls: 'A', type: /This network/ },
  { in: '224.0.0.251/4', network: '224.0.0.0', broadcast: '239.255.255.255', first: '224.0.0.1', last: '239.255.255.254', usable: '268,435,454', total: '268,435,456', netmask: '240.0.0.0', wildcard: '15.255.255.255', cidr: '224.0.0.0/4', int: '3758096635', hex: '0xE00000FB', rev: '251.0.0.224.in-addr.arpa', bin: '11100000000000000000000011111011', cls: 'D', type: /^Multicast/ },
  { in: '169.254.10.20/16', network: '169.254.0.0', broadcast: '169.254.255.255', first: '169.254.0.1', last: '169.254.255.254', usable: '65,534', total: '65,536', netmask: '255.255.0.0', wildcard: '0.0.255.255', cidr: '169.254.0.0/16', int: '2851998228', hex: '0xA9FE0A14', rev: '20.10.254.169.in-addr.arpa', bin: '10101001111111100000101000010100', cls: 'B', type: /^Link-local/ },
  { in: '127.0.0.1/8', network: '127.0.0.0', broadcast: '127.255.255.255', first: '127.0.0.1', last: '127.255.255.254', usable: '16,777,214', total: '16,777,216', netmask: '255.0.0.0', wildcard: '0.255.255.255', cidr: '127.0.0.0/8', int: '2130706433', hex: '0x7F000001', rev: '1.0.0.127.in-addr.arpa', bin: '01111111000000000000000000000001', cls: 'A', type: /^Loopback/ },
  { in: '203.0.113.77/27', network: '203.0.113.64', broadcast: '203.0.113.95', first: '203.0.113.65', last: '203.0.113.94', usable: '30', total: '32', netmask: '255.255.255.224', wildcard: '0.0.0.31', cidr: '203.0.113.64/27', int: '3405803853', hex: '0xCB00714D', rev: '77.113.0.203.in-addr.arpa', bin: '11001011000000000111000101001101', cls: 'C', type: /Documentation, TEST-NET-3/ },
  { in: '198.51.100.200 / 30', network: '198.51.100.200', broadcast: '198.51.100.203', first: '198.51.100.201', last: '198.51.100.202', usable: '2', total: '4', netmask: '255.255.255.252', wildcard: '0.0.0.3', cidr: '198.51.100.200/30', int: '3325256904', hex: '0xC63364C8', rev: '200.100.51.198.in-addr.arpa', bin: '11000110001100110110010011001000', cls: 'C', type: /TEST-NET-2/ },
  { in: '1.2.3.4/128.0.0.0', network: '0.0.0.0', broadcast: '127.255.255.255', first: '0.0.0.1', last: '127.255.255.254', usable: '2,147,483,646', total: '2,147,483,648', netmask: '128.0.0.0', wildcard: '127.255.255.255', cidr: '0.0.0.0/1', int: '16909060', hex: '0x01020304', rev: '4.3.2.1.in-addr.arpa', bin: '00000001000000100000001100000100', cls: 'A', type: /^Public/ },
];

module.exports = async ({ page, open, assert }) => {
  await open();
  // First text node of a cell (cells for /31 and /32 broadcast carry an explanatory <small>).
  const cell = id => page.$eval('#sc-' + id, el => (el.firstChild ? el.firstChild.textContent : ''));
  const text = sel => page.locator(sel).textContent();

  // Default on load.
  assert.equal(await page.inputValue('#sc-ip'), '192.168.1.10/24');
  assert.equal(await text('#sc-big'), '192.168.1.0/24');
  assert.equal(await text('#sc-type-badge'), 'Private');
  assert.equal(await text('#sc-class-badge'), 'Class C');

  for (const c of CASES) {
    await page.fill('#sc-ip', c.in);
    assert.equal(await text('#sc-msg'), '', `${c.in}: no error`);
    for (const k of ['network', 'first', 'last', 'usable', 'total', 'netmask', 'wildcard', 'cidr', 'int', 'hex', 'rev']) {
      assert.equal(await cell(k), c[k], `${c.in}: ${k}`);
    }
    assert.equal(await cell('address'), c.in.split(/[\s/]+/)[0]);
    if (c.broadcast) assert.equal(await cell('broadcast'), c.broadcast, `${c.in}: broadcast`);
    else assert.equal(await cell('broadcast'), 'None', `${c.in}: no broadcast for /31 and /32`);
    assert.match(await cell('class'), new RegExp('^' + c.cls + ' '), `${c.in}: class`);
    assert.match(await cell('type'), c.type, `${c.in}: type`);
    assert.equal(await text('#sc-big'), c.cidr);
    assert.equal(await page.inputValue('#sc-prefix'), c.cidr.split('/')[1], `${c.in}: mask list follows the input`);
    const bin = (await page.locator('#sc-bin dd').first().textContent()).replace(/\./g, '');
    assert.equal(bin, c.bin, `${c.in}: binary`);
    const bold = await page.locator('#sc-bin dd').first().locator('.sc-n').textContent().catch(() => '');
    assert.equal(bold.replace(/\./g, '').length, +c.cidr.split('/')[1], `${c.in}: network bits highlighted`);
  }

  // Notes: wildcard reading, /31 explanation, network/broadcast address warnings, larger-than-range.
  await page.fill('#sc-ip', '172.16.5.4 0.0.15.255');
  assert.match(await text('#sc-note'), /read as a wildcard mask.*255\.255\.240\.0/);
  await page.fill('#sc-ip', '10.0.0.1/31');
  assert.match(await text('#sc-broadcast'), /RFC 3021/);
  await page.fill('#sc-ip', '192.168.1.255/24');
  assert.match(await text('#sc-note'), /broadcast address of this subnet/);
  await page.fill('#sc-ip', '192.168.1.0/24');
  assert.match(await text('#sc-note'), /network address of this subnet/);
  await page.fill('#sc-ip', '10.1.1.1/7');
  assert.match(await text('#sc-note'), /larger than 10\.0\.0\.0\/8/);
  await page.fill('#sc-ip', '010.1.1.1/8');
  assert.match(await text('#sc-note'), /leading zeros/);
  assert.equal(await cell('network'), '10.0.0.0');

  // Example buttons fill the input.
  await page.click('button[data-example="10.1.2.3 0.0.255.255"]');
  assert.equal(await page.inputValue('#sc-ip'), '10.1.2.3 0.0.255.255');
  assert.equal(await text('#sc-big'), '10.1.0.0/16');

  // Range boundaries (from RFC 1918 / RFC 6598 block edges).
  const typeOf = async ip => { await page.fill('#sc-ip', ip + '/32'); return text('#sc-type-badge'); };
  assert.equal(await typeOf('172.31.255.255'), 'Private');
  assert.equal(await typeOf('172.32.0.0'), 'Public');
  assert.equal(await typeOf('172.15.255.255'), 'Public');
  assert.equal(await typeOf('100.127.255.255'), 'CGNAT');
  assert.equal(await typeOf('100.128.0.0'), 'Public');
  assert.equal(await typeOf('192.169.0.1'), 'Public');
  assert.equal(await typeOf('255.255.255.255'), 'Broadcast');
  assert.equal(await typeOf('240.0.0.1'), 'Reserved');
  assert.equal(await text('#sc-class-badge'), 'Class E');

  // Address only, then the mask list.
  await page.fill('#sc-ip', '10.1.2.3');
  assert.equal(await text('#sc-big'), '10.1.2.3/32'); // no mask typed: the list keeps the last one, /32
  await page.selectOption('#sc-prefix', '16');
  assert.equal(await page.inputValue('#sc-ip'), '10.1.2.3/16');
  assert.equal(await cell('network'), '10.1.0.0');
  assert.equal(await cell('broadcast'), '10.1.255.255');

  // Validation errors.
  const errs = [
    ['', /Enter an IPv4 address/],
    ['256.1.1.1/24', /256 .*out of range/],
    ['1.2.3/24', /four numbers.*has 3/],
    ['1.2.3.4/33', /\/33 is not a valid prefix/],
    ['1.2.3.4 255.0.255.0', /not contiguous/],
    ['1.2.3.4 255.255.255.1', /not contiguous/],
    ['2001:db8::1/64', /IPv6/],
    ['1.2..4/24', /empty part/],
    ['1.2.3.x/24', /"x" .*not a number/],
    ['1.2.3.4/', /after the slash/],
    ['1.2.3.4/24 extra', /one prefix or mask/],
  ];
  for (const [v, re] of errs) {
    await page.fill('#sc-ip', v);
    assert.match(await text('#sc-msg'), re, `error for "${v}"`);
    assert.equal(await page.isVisible('#sc-out'), false, `results hidden for "${v}"`);
    assert.equal(await page.isVisible('#sc-split-out'), false);
  }

  // Splitter: 192.168.0.0/24 (python: n.subnets(new_prefix=26/27/28)).
  await page.fill('#sc-ip', '192.168.0.0/24');
  const rows = () => page.$$eval('#sc-split-body tr', trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent)));
  let r = await rows();
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], ['1', '192.168.0.0/26', '192.168.0.1 – 192.168.0.62', '192.168.0.63', '62']);
  assert.deepEqual(r[3], ['4', '192.168.0.192/26', '192.168.0.193 – 192.168.0.254', '192.168.0.255', '62']);
  await page.fill('#sc-split-num', '5');
  r = await rows();
  assert.equal(r.length, 8);
  assert.equal(r[1][1], '192.168.0.32/27');
  assert.equal(r[7][1], '192.168.0.224/27');
  assert.match(await text('#sc-split-info'), /not a power of two.*8 subnets of \/27 \(255\.255\.255\.224\), 30 usable hosts each/);
  await page.fill('#sc-split-num', '1000');
  assert.match(await text('#sc-split-msg'), /at most 256 subnets/);
  await page.fill('#sc-split-num', '256');
  r = await rows();
  assert.equal(r.length, 256);
  assert.deepEqual(r[255], ['256', '192.168.0.255/32', '192.168.0.255 – 192.168.0.255', '—', '1']);

  await page.selectOption('#sc-split-mode', 'prefix');
  await page.selectOption('#sc-split-prefix', '28');
  r = await rows();
  assert.equal(r.length, 16);
  assert.deepEqual(r[15], ['16', '192.168.0.240/28', '192.168.0.241 – 192.168.0.254', '192.168.0.255', '14']);

  await page.selectOption('#sc-split-mode', 'hosts');
  assert.equal(await page.inputValue('#sc-split-num'), '50');
  r = await rows();
  assert.equal(r.length, 4, '50 hosts need a /26');
  await page.fill('#sc-split-num', '62');
  assert.equal((await rows()).length, 4, '62 hosts still fit a /26');
  await page.fill('#sc-split-num', '63');
  assert.equal((await rows()).length, 2, '63 hosts need a /25');
  await page.fill('#sc-split-num', '300');
  assert.match(await text('#sc-split-msg'), /only 254 usable hosts/);
  await page.fill('#sc-split-num', '');
  assert.match(await text('#sc-split-msg'), /Enter how many hosts/);
  await page.fill('#sc-split-num', '2.5');
  assert.match(await text('#sc-split-msg'), /Enter how many hosts/);

  // CSV export (python: ip_network('172.16.0.0/12').subnets(new_prefix=14)).
  await page.fill('#sc-ip', '172.16.0.0/12');
  await page.selectOption('#sc-split-mode', 'count');
  await page.fill('#sc-split-num', '4');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sc-csv')]);
  assert.equal(dl.suggestedFilename(), 'subnets-172.16.0.0-12-to-14.csv');
  const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split(/\r\n/);
  assert.deepEqual(csv, [
    'Subnet,Network,First host,Last host,Broadcast,Usable hosts,Netmask',
    '172.16.0.0/14,172.16.0.0,172.16.0.1,172.19.255.254,172.19.255.255,262142,255.252.0.0',
    '172.20.0.0/14,172.20.0.0,172.20.0.1,172.23.255.254,172.23.255.255,262142,255.252.0.0',
    '172.24.0.0/14,172.24.0.0,172.24.0.1,172.27.255.254,172.27.255.255,262142,255.252.0.0',
    '172.28.0.0/14,172.28.0.0,172.28.0.1,172.31.255.254,172.31.255.255,262142,255.252.0.0',
  ]);

  // Big split: table capped at 1,024 rows, CSV has all 65,536 (python: 10.0.0.0/8 -> /24, [1023] = 10.3.255.0/24).
  await page.fill('#sc-ip', '10.0.0.0/8');
  await page.selectOption('#sc-split-mode', 'prefix');
  await page.selectOption('#sc-split-prefix', '24');
  assert.match(await text('#sc-split-info'), /65,536 subnets of \/24.*first 1,024.*all of them/);
  r = await rows();
  assert.equal(r.length, 1024);
  assert.equal(r[1023][1], '10.3.255.0/24');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#sc-csv')]);
  const big = fs.readFileSync(await dl2.path(), 'utf8').trim().split(/\r\n/);
  assert.equal(big.length, 65537);
  assert.equal(big[1025].split(',')[0], '10.4.0.0/24');
  assert.equal(big[65536].split(',')[0], '10.255.255.0/24');

  // /31 split into two /32 host routes; hosts mode explains why it can't.
  await page.fill('#sc-ip', '10.0.0.0/30');
  await page.selectOption('#sc-split-mode', 'count');
  await page.fill('#sc-split-num', '2');
  r = await rows();
  assert.deepEqual(r.map(x => x[1]), ['10.0.0.0/31', '10.0.0.2/31']);
  assert.equal(r[0][3], '—');
  await page.fill('#sc-ip', '8.8.8.8/32');
  assert.match(await text('#sc-split-msg'), /can't be split/);

  // Copy results.
  await page.fill('#sc-ip', '192.168.1.10/24');
  await page.click('#sc-copy');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clip.includes('Network address: 192.168.1.0') && clip.includes('Wildcard mask: 0.0.0.255'), clip);
};
