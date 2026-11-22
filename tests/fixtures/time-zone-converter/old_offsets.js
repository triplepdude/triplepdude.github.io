// Offsets of the zones in the tz check (_tools/time-zone-converter.html) as a runtime with OLDER
// time zone data gives them, 2026 to 2040: run it with a Node.js (or paste the function into the
// console of a browser) whose tz data predates the changes, for example Node 22 (tz 2025b):
//   node old_offsets.js > old.json
// Prints {zone: [[UTC seconds, offset in minutes], ...]}, one entry per change, found by sampling
// every hour and bisecting each change to the minute. stale_table.py compares it with new tzdata.
const ZONES = ['America/Vancouver', 'America/Edmonton', 'America/Inuvik', 'America/Winnipeg',
  'America/Havana', 'Africa/Casablanca', 'Africa/El_Aaiun', 'Europe/Chisinau'];
function offsets(zones) {
  const fmts = {};
  function off(z, s) {
    const f = fmts[z] || (fmts[z] = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    const o = {};
    f.formatToParts(new Date(s * 1000)).forEach(x => { o[x.type] = x.value; });
    return (Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) / 1000 - s) / 60;
  }
  const start = Date.UTC(2026, 0, 1) / 1000, end = Date.UTC(2041, 0, 1) / 1000, out = {};
  for (const z of zones) {
    const list = [];
    let t = start, cur = off(z, t);
    list.push([t, cur]);
    while (t < end) {
      const n = t + 3600, o = off(z, n);
      if (o !== cur) {
        let lo = t, hi = n;
        while (hi - lo > 60) { const mid = Math.floor((lo + hi) / 120) * 60; if (mid <= lo) break; if (off(z, mid) === cur) lo = mid; else hi = mid; }
        list.push([hi, o]);
        cur = o;
      }
      t = n;
    }
    out[z] = list;
  }
  return out;
}
if (typeof module !== 'undefined' && require.main === module) {
  console.log(JSON.stringify({ runtime: 'node ' + process.versions.node + ', tz ' + process.versions.tz, tz: offsets(ZONES) }));
}
