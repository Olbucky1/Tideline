// Live routing check against real NOAA ENC data, for every trip in tests/route-cases.json, with the standard and the new router.
// Runs on GitHub Actions (the build workspace cannot reach NOAA). Writes diag/report.md, diag/report.json and a screenshot per trip.
// Each route is checked independently: sampled every 25 m against NOAA Land_Area polygons, its length against the straight line,
// and (new router) that it passes the expected passage nodes and offers the expected alternative.
// build 187
import { chromium } from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('diag', { recursive: true });
const C = JSON.parse(fs.readFileSync('tests/route-cases.json', 'utf8'));
const only = (process.env.ONLY || '').split(',').filter(Boolean), routers = (process.env.ROUTERS || 'old,new').split(',');
const CASES = C.cases.filter((c) => !only.length || only.includes(c.id));
const ENC = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJ(u) { for (let i = 0; i < 4; i++) { try { const r = await fetch(u); if (r.status === 429 || r.status >= 500) { await sleep(2500 * (i + 1)); continue; } return await r.json(); } catch (e) { await sleep(2000); } } throw new Error('NOAA unreachable'); }
const landIds = {};
async function landPolys(bb) { // NOAA Land_Area polygons from the harbour, approach and coastal charts
  const out = [];
  for (const svc of ['enc_harbour', 'enc_approach', 'enc_coastal']) {
    try {
      if (landIds[svc] == null) { const meta = await getJ(ENC + svc + '/MapServer?f=json'); const l = (meta.layers || []).find((x) => /\.Land_Area$/i.test(x.name)); landIds[svc] = l ? l.id : -1; }
      if (landIds[svc] < 0) continue;
      for (let off = 0; off < 30000; off += 1000) {
        const u = ENC + svc + '/MapServer/' + landIds[svc] + '/query?where=1%3D1&geometry=' + bb.join('%2C') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=OBJECTID&returnGeometry=true&outSR=4326&resultOffset=' + off + '&resultRecordCount=1000&f=json';
        const j = await getJ(u); (j.features || []).forEach((f) => f.geometry && f.geometry.rings && out.push({ svc, rings: f.geometry.rings }));
        if (!j.exceededTransferLimit) break;
      }
    } catch (e) { out.err = (out.err || '') + svc + ': ' + e.message + '; '; }
  }
  return out;
}
function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function onLand(polys, lon, lat) { for (const p of polys) { let n = 0; for (const r of p.rings) if (inRing(r, lon, lat)) n++; if (n % 2) return p.svc; } return null; }
const nm = (a, b) => { const R = 3440.065, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lon - a.lon) * t, h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 800 }, serviceWorkers: 'block' });
const page = await ctx.newPage(); const netErr = [], logs = [];
page.on('requestfailed', (r) => { if (/noaa/.test(r.url())) netErr.push(r.failure()?.errorText + ' ' + r.url().slice(0, 140)); });
page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|tideline-ais/.test(m.text())) logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push('pageerror ' + String(e).slice(0, 200)));
await page.addInitScript(() => { localStorage.setItem('tl.welcomed', 'true'); localStorage.setItem('tl.toured', 'true'); localStorage.setItem('tl.firstRun', '1'); localStorage.setItem('tl.boat', JSON.stringify({ name: 'Test', draftFt: 4, safetyFt: 2, airDraftFt: 45 })); });
await page.goto('http://localhost:8765/index.html'); await page.waitForTimeout(4000);
const report = [];
for (const c of CASES) for (const rt of routers) {
  const t0 = Date.now();
  const r = await page.evaluate(async ([c, rt]) => {
    const T = window.Tideline; T.S.settings.newRouter = rt === 'new'; T.WR.lastErr = null;
    try {
      const g = T.PN_ALT && T.PN_ALT[0], excl = rt === 'new' && c.use === 'outside' && g ? g.inside : undefined;
      const out = await T.routeByWater([{ lat: c.a.lat, lon: c.a.lon, name: c.a.name }, { lat: c.b.lat, lon: c.b.lon, name: c.b.name }], { excl });
      return { pts: out.map((p) => ({ lat: p.lat, lon: p.lon, stop: !!p.stop, unchecked: p.unchecked || null, pn: p.pn || null })), ways: rt === 'new' && T.rtWays ? T.rtWays(out).map((w) => w.g.id + ':' + w.way) : [], conf: T.routeConfidence ? T.routeConfidence(out) : null, lastErr: T.WR.lastErr };
    } catch (e) { return { err: String(e) }; }
  }, [c, rt]);
  const secs = Math.round((Date.now() - t0) / 1000);
  if (r.err) { report.push({ id: c.id, name: c.name, router: rt, err: r.err, pass: false }); continue; }
  const pts = r.pts, lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const bb = [Math.min(...lons) - 0.02, Math.min(...lats) - 0.02, Math.max(...lons) + 0.02, Math.max(...lats) + 0.02].map((v) => v.toFixed(4));
  const polys = await landPolys(bb), hits = [];
  for (let i = 1; i < pts.length; i++) { if (pts[i].stop && pts[i].unchecked === 'land') continue; const p0 = pts[i - 1], p1 = pts[i], n = Math.max(2, Math.ceil(nm(p0, p1) * 1852 / 25)); for (let q = 1; q < n; q++) { const f = q / n, la = p0.lat + (p1.lat - p0.lat) * f, lo = p0.lon + (p1.lon - p0.lon) * f; if (nm(c.a, { lat: la, lon: lo }) < 0.1 || nm(c.b, { lat: la, lon: lo }) < 0.1) continue; const s = onLand(polys, lo, la); if (s) { hits.push({ leg: i, lat: +la.toFixed(5), lon: +lo.toFixed(5), svc: s }); break; } } }
  const routeNm = pts.reduce((s, p, i) => i ? s + nm(pts[i - 1], p) : 0, 0), ratio = routeNm / nm(c.a, c.b), unchecked = pts.filter((p) => p.unchecked).map((p) => p.unchecked), pns = new Set(pts.map((p) => p.pn).filter(Boolean));
  const fails = [];
  if (hits.length) fails.push('crosses land');
  if (c.must === 'ok' && unchecked.length) fails.push('not checked: ' + unchecked.join(','));
  if (c.mustFlag && !unchecked.length) fails.push('should be flagged as not fully checked');
  if (c.maxRatio && ratio > c.maxRatio) fails.push('too long: ' + ratio.toFixed(2) + '× (max ' + c.maxRatio + ')');
  if (rt === 'new' && c.via) { const miss = c.via.filter((k) => !pns.has(k)); if (miss.length) fails.push('does not pass ' + miss.join(', ')); }
  if (rt === 'new' && c.alt && !r.ways.some((w) => w.startsWith(c.alt + ':'))) fails.push('alternative "' + c.alt + '" not offered');
  report.push({ id: c.id, name: c.name, router: rt, pass: !fails.length, fails, secs, routeNm: +routeNm.toFixed(1), ratio: +ratio.toFixed(2), turns: pts.length - 2, conf: r.conf && r.conf.level, ways: r.ways, unchecked, landPolys: polys.length, landErr: polys.err, landHits: hits.slice(0, 3), lastErr: r.lastErr, pts });
  console.log((fails.length ? 'FAIL ' : 'ok   ') + rt + ' ' + c.id + ' ' + routeNm.toFixed(1) + ' nm ' + secs + ' s ' + fails.join('; '));
  await page.evaluate((pts) => { const T = window.Tideline; T.RT.pts = pts.map((p) => Object.assign({ lat: p.lat, lon: p.lon }, p.stop ? { stop: true } : { turn: true }, p.unchecked ? { unchecked: p.unchecked } : {})); T.RT.trip = true; T.drawRoute(); T.map.fitBounds(T.L.latLngBounds(T.RT.pts.map((p) => [p.lat, p.lon])).pad(0.15)); }, pts);
  await page.waitForTimeout(3500); await page.screenshot({ path: 'diag/' + c.id + '-' + rt + '.png' });
}
const md = ['# Live route check (build 187 test set)', '', 'Run ' + new Date().toISOString() + ' · ' + report.filter((r) => r.pass).length + '/' + report.length + ' pass', '',
  '| Trip | Router | Result | nm | × straight | Confidence | Secs | Notes |', '|---|---|---|---|---|---|---|---|',
  ...report.map((r) => '| ' + r.name + ' | ' + r.router + ' | ' + (r.pass ? 'pass' : '**FAIL**') + ' | ' + (r.routeNm ?? '') + ' | ' + (r.ratio ?? '') + ' | ' + (r.conf || '') + ' | ' + (r.secs ?? '') + ' | ' + (r.err || (r.fails || []).join('; ')) + (r.ways && r.ways.length ? ' · ways: ' + r.ways.join(', ') : '') + (r.landErr ? ' · land check: ' + r.landErr : '') + ' |'),
  '', '## Network failures', ...netErr.slice(0, 40).map((x) => '- ' + x), '', '## Console errors', ...logs.slice(0, 40).map((x) => '- ' + x)];
fs.writeFileSync('diag/report.md', md.join('\n')); fs.writeFileSync('diag/report.json', JSON.stringify({ report, netErr, logs }, null, 1));
console.log(md.join('\n'));
await browser.close();
