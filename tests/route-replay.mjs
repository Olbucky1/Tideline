// Offline route test: replays the known-good trips in tests/route-cases.json against a saved snapshot of NOAA ENC Direct
// (the build sandbox cannot reach NOAA). Every NOAA query the app makes is answered from the snapshot; everything else
// off localhost is blocked. Each route is then checked independently: sampled every 25 m against the snapshot's
// Land_Area polygons, and its length compared with the straight line.
//
//   node tests/route-replay.mjs [snapshotDir] [--router=old|new|both] [--only=id,id]
//
// snapshotDir defaults to diag/enc (get it with: git archive origin/diag diag/enc | tar x).
// Writes diag/replay.md and diag/replay.json. Exit code 1 if any case marked must:"ok" fails or crosses land.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const args = process.argv.slice(2), opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const SNAP = args.find((a) => !a.startsWith('--')) || 'diag/enc';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/route-cases.json'), 'utf8'));
const routers = opt.router === 'old' ? ['old'] : opt.router === 'new' ? ['new'] : ['old', 'new'];
const only = opt.only ? opt.only.split(',') : null;

// ---- the snapshot: layer lists per chart scale, features per layer id
const SNAP_BB = CASES.snapshotBox; // [w, s, e, n]
const meta = {}, feats = {};
for (const svc of ['enc_general', 'enc_coastal', 'enc_approach', 'enc_harbour']) {
  const f = path.join(SNAP, svc + '.meta.json'); if (!fs.existsSync(f)) continue;
  meta[svc] = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const file of fs.readdirSync(SNAP)) {
    const m = file.match(new RegExp('^' + svc + '\\.(\\d+)\\.json$')); if (!m) continue;
    const j = JSON.parse(fs.readFileSync(path.join(SNAP, file), 'utf8'));
    feats[svc + '.' + m[1]] = (j.features || []).map((x) => { const bb = fbb(x.geometry); return { x, bb }; });
  }
}
if (!Object.keys(meta).length) { console.error('No snapshot in ' + SNAP + '. Run: git archive origin/diag diag/enc | tar x'); process.exit(2); }
function fbb(g) { if (!g) return null; if (g.x != null) return [g.x, g.y, g.x, g.y]; let a = 180, b = 90, c = -180, d = -90; (g.rings || g.paths || []).forEach((r) => r.forEach(([x, y]) => { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; })); return [a, b, c, d]; }
function answer(url) {
  const u = new URL(url), m = u.pathname.match(/encdirect\/(enc_\w+)\/MapServer(?:\/(\d+)\/query)?$/); if (!m) return null;
  const svc = m[1]; if (!meta[svc]) return { error: { message: 'not in snapshot' } };
  if (!m[2]) return meta[svc];
  const g = (u.searchParams.get('geometry') || '').split(',').map(Number), off = +(u.searchParams.get('resultOffset') || 0), n = +(u.searchParams.get('resultRecordCount') || 1000);
  const all = (feats[svc + '.' + m[2]] || []).filter((o) => o.bb && !(o.bb[2] < g[0] || o.bb[0] > g[2] || o.bb[3] < g[1] || o.bb[1] > g[3]));
  return { features: all.slice(off, off + n).map((o) => o.x), exceededTransferLimit: all.length > off + n };
}
// ---- independent land check, from the snapshot's land areas at harbour, approach and coastal scale
const land = ['enc_harbour', 'enc_approach', 'enc_coastal'].flatMap((svc) => { const l = (meta[svc] && meta[svc].layers || []).find((x) => /\.Land_Area$/i.test(x.name)); return l ? (feats[svc + '.' + l.id] || []).filter((o) => o.x.geometry && o.x.geometry.rings).map((o) => ({ svc, bb: o.bb, rings: o.x.geometry.rings })) : []; });
function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function onLand(lon, lat) { for (const p of land) { if (lon < p.bb[0] || lon > p.bb[2] || lat < p.bb[1] || lat > p.bb[3]) continue; let n = 0; for (const r of p.rings) if (inRing(r, lon, lat)) n++; if (n % 2) return p.svc; } return null; }
const nm = (a, b) => { const R = 3440.065, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lon - a.lon) * t, h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const inBox = (p, bb) => p.lon >= bb[0] && p.lon <= bb[2] && p.lat >= bb[1] && p.lat <= bb[3];

// ---- a tiny static server for the app
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => srv.listen(0, r)); const PORT = srv.address().port;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 820 }, serviceWorkers: 'block' });
await ctx.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith('http://localhost:' + PORT)) return route.continue();
  if (/encdirect|charttools\.noaa/.test(url)) { const j = answer(url); return j ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) }) : route.abort(); }
  return route.abort();
});
const page = await ctx.newPage(), errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
await page.addInitScript(() => { localStorage.setItem('tl.welcomed', 'true'); localStorage.setItem('tl.toured', 'true'); localStorage.setItem('tl.firstRun', '1'); localStorage.setItem('tl.boat', JSON.stringify({ name: 'Test', draftFt: 4, safetyFt: 2, airDraftFt: 45 })); });
await page.goto('http://localhost:' + PORT + '/index.html'); await page.waitForFunction(() => window.Tideline && window.Tideline.routeByWater, null, { timeout: 30000 });

if (opt.script) { // drive the page: the module's default export gets (page, { port, root })
  const mod = await import(path.resolve(opt.script)); const res = await mod.default(page, { port: PORT, root: ROOT }); console.log(JSON.stringify({ res, errs }, null, 1)); await browser.close(); srv.close(); process.exit(errs.length ? 1 : 0); }
if (opt.eval) { // probe: run a script in the page against the snapshot and print what it returns
  const out = await page.evaluate(fs.readFileSync(opt.eval, 'utf8')); console.log(JSON.stringify(out, null, 1)); await browser.close(); srv.close(); process.exit(0); }
const results = [];
const list = CASES.cases.filter((c) => (!only || only.includes(c.id)) && inBox(c.a, SNAP_BB) && inBox(c.b, SNAP_BB));
for (const c of list) for (const rt of routers) {
  const t0 = Date.now();
  const r = await page.evaluate(async ([c, rt]) => {
    const T = window.Tideline; T.S.settings.newRouter = rt === 'new'; T.WR.lastErr = null;
    try { const out = await T.routeByWater([{ lat: c.a.lat, lon: c.a.lon, name: c.a.name }, { lat: c.b.lat, lon: c.b.lon, name: c.b.name }]);
      return { pts: out.map((p) => ({ lat: p.lat, lon: p.lon, stop: !!p.stop, unchecked: p.unchecked || null, ch: p.ch || 0 })), lastErr: T.WR.lastErr, conf: T.routeConfidence ? T.routeConfidence(out).level : null };
    } catch (e) { return { err: String(e) }; }
  }, [c, rt]);
  const secs = (Date.now() - t0) / 1000;
  if (r.err) { results.push({ id: c.id, name: c.name, router: rt, err: r.err, pass: false }); continue; }
  const pts = r.pts, hits = [];
  for (let i = 1; i < pts.length; i++) { if (pts[i].stop && pts[i].unchecked === 'land') continue; // the dashed walk from the nearest water to a pin on land: flagged in the app, not a route
    const p0 = pts[i - 1], p1 = pts[i], n = Math.max(2, Math.ceil(nm(p0, p1) * 1852 / 25)); for (let q = 1; q < n; q++) { const f = q / n, la = p0.lat + (p1.lat - p0.lat) * f, lo = p0.lon + (p1.lon - p0.lon) * f; if (nm(c.a, { lat: la, lon: lo }) < 0.1 || nm(c.b, { lat: la, lon: lo }) < 0.1) continue; const s = onLand(lo, la); if (s) { hits.push({ leg: i, lat: +la.toFixed(5), lon: +lo.toFixed(5), svc: s }); break; } } }
  const routeNm = pts.reduce((s, p, i) => i ? s + nm(pts[i - 1], p) : 0, 0), straight = nm(c.a, c.b), ratio = routeNm / straight;
  const unchecked = pts.filter((p) => p.unchecked).map((p) => p.unchecked);
  const fails = [];
  if (hits.length) fails.push('crosses land');
  if (c.must === 'ok' && unchecked.length) fails.push('not checked: ' + unchecked.join(','));
  if (c.mustFlag && !unchecked.length) fails.push('should be flagged as not fully checked, but is not');
  if (c.maxRatio && ratio > c.maxRatio) fails.push('too long: ' + ratio.toFixed(2) + '× straight (max ' + c.maxRatio + ')');
  results.push({ id: c.id, name: c.name, router: rt, secs: +secs.toFixed(1), routeNm: +routeNm.toFixed(1), straightNm: +straight.toFixed(1), ratio: +ratio.toFixed(2), turns: pts.length - 2, chPct: pts.length > 2 ? Math.round(100 * pts.filter((p) => p.ch).length / pts.length) : 0, conf: r.conf, unchecked, landHits: hits.slice(0, 3), pass: !fails.length, fails, pts });
  console.log((fails.length ? 'FAIL ' : 'ok   ') + rt.padEnd(4) + ' ' + c.id.padEnd(22) + ' ' + routeNm.toFixed(1).padStart(5) + ' nm (' + ratio.toFixed(2) + '×) ' + secs.toFixed(0).padStart(3) + ' s ' + (r.conf || '') + ' ' + fails.join('; '));
}
await browser.close(); srv.close();
fs.mkdirSync(path.join(ROOT, 'diag'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'diag/replay.json'), JSON.stringify({ when: new Date().toISOString(), snapshot: SNAP, results, errs }, null, 1));
const md = ['# Offline route replay', '', 'Snapshot: `' + SNAP + '` (box ' + SNAP_BB.join(', ') + '). ' + list.length + ' of ' + CASES.cases.length + ' cases are inside the snapshot; the rest need the live check.', '',
  '| Case | Router | Result | Route nm | × straight | Turns | Secs | Notes |', '|---|---|---|---|---|---|---|---|',
  ...results.map((x) => '| ' + x.name + ' | ' + x.router + ' | ' + (x.pass ? 'pass' : '**FAIL**') + ' | ' + (x.routeNm ?? '') + ' | ' + (x.ratio ?? '') + ' | ' + (x.turns ?? '') + ' | ' + (x.secs ?? '') + ' | ' + (x.err || (x.fails || []).join('; ')) + ' |'),
  '', errs.length ? '## Page errors\n' + errs.map((e) => '- ' + e).join('\n') : 'No page errors.'];
fs.writeFileSync(path.join(ROOT, 'diag/replay.md'), md.join('\n'));
const bad = results.filter((x) => !x.pass && (CASES.cases.find((c) => c.id === x.id) || {}).must === 'ok' && (x.router === 'old' ? opt.strictOld : true));
console.log('\n' + results.filter((x) => x.pass).length + '/' + results.length + ' pass. Report: diag/replay.md');
process.exit(bad.length || errs.length ? 1 : 0);
