// Live routing check against real NOAA ENC data. Writes diag/report.md, diag/report.json and screenshots.
// build 123 check
import { chromium } from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('diag', { recursive: true });
const CASES = [
  ['SSA to St. Michaels', { lat: 38.97542, lon: -76.48041, name: 'Severn Sailing Association' }, { lat: 38.7854, lon: -76.2233, name: 'St. Michaels' }],
  ['SSA to Rock Hall', { lat: 38.97542, lon: -76.48041, name: 'SSA' }, { lat: 39.1346, lon: -76.2397, name: 'Rock Hall' }],
  ['Annapolis harbor to Thomas Point', { lat: 38.9765, lon: -76.4840, name: 'Ego Alley' }, { lat: 38.8990, lon: -76.4360, name: 'Thomas Point' }],
  ['SSA to Back Creek', { lat: 38.97542, lon: -76.48041, name: 'SSA' }, { lat: 38.9660, lon: -76.4740, name: 'Back Creek' }],
  ['SSA to Oxford', { lat: 38.97542, lon: -76.48041, name: 'SSA' }, { lat: 38.6930, lon: -76.1720, name: 'Oxford' }],
  ['SSA to Baltimore Inner Harbor', { lat: 38.97542, lon: -76.48041, name: 'SSA' }, { lat: 39.2830, lon: -76.6080, name: 'Inner Harbor' }],
];
const ENC = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/';
// independent land check: sample the route every ~25 m against NOAA Land_Area polygons from the harbour and approach charts
async function landPolys(bb) {
  const out = [];
  for (const svc of ['enc_harbour', 'enc_approach', 'enc_coastal']) {
    try {
      const meta = await (await fetch(ENC + svc + '/MapServer?f=json')).json();
      const lay = (meta.layers || []).find((l) => /\.Land_Area$/i.test(l.name)); if (!lay) continue;
      for (let off = 0; off < 20000; off += 1000) {
        const u = ENC + svc + '/MapServer/' + lay.id + '/query?where=1%3D1&geometry=' + bb.join('%2C') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=OBJECTID&returnGeometry=true&outSR=4326&resultOffset=' + off + '&resultRecordCount=1000&f=json';
        const j = await (await fetch(u)).json(); (j.features || []).forEach((f) => f.geometry && f.geometry.rings && out.push({ svc, rings: f.geometry.rings }));
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
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push('pageerror ' + String(e).slice(0, 200)));
await page.addInitScript(() => { localStorage.setItem('tl.welcomed', 'true'); localStorage.setItem('tl.toured', 'true'); localStorage.setItem('tl.firstRun', '1'); localStorage.setItem('tl.boat', JSON.stringify({ name: 'Test', draftFt: 4, safetyFt: 2, airDraftFt: 50 })); });
await page.goto('http://localhost:8765/index.html'); await page.waitForTimeout(4000);
const report = [];
// service facts
const facts = await page.evaluate(async () => { const o = {}; for (const s of ['enc_coastal', 'enc_approach', 'enc_harbour']) { try { const j = await (await fetch('https://encdirect.noaa.gov/arcgis/rest/services/encdirect/' + s + '/MapServer?f=json')).json(); o[s] = { layers: (j.layers || []).length, maxRecordCount: j.maxRecordCount, depth: (j.layers || []).find((l) => /\.Depth_Area$/i.test(l.name))?.id }; const d = o[s].depth; if (d != null) { const L = await (await fetch('https://encdirect.noaa.gov/arcgis/rest/services/encdirect/' + s + '/MapServer/' + d + '?f=json')).json(); o[s].pagination = L.advancedQueryCapabilities && L.advancedQueryCapabilities.supportsPagination; o[s].fields = (L.fields || []).map((f) => f.name).filter((n) => /drval|objnam/i.test(n)); } } catch (e) { o[s] = 'ERR ' + e.message; } } return o; });
for (const [name, a, b] of CASES) {
  const t0 = Date.now();
  const r = await page.evaluate(async ([a, b]) => { const T = window.Tideline; T.WR.lastErr = null; try { const leg = await T.waterLeg(a, b); return { ok: leg.ok, why: leg.why, shallow: leg.shallow, pts: (leg.pts || []).map((p) => ({ lat: p.lat, lon: p.lon })), lastErr: T.WR.lastErr, ids: T.WR.ids }; } catch (e) { return { err: String(e && e.stack || e).slice(0, 400), lastErr: T.WR.lastErr }; } }, [a, b]);
  r.secs = Math.round((Date.now() - t0) / 1000);
  const full = [a].concat(r.pts && r.pts.length ? r.pts.slice(1, -1) : [], [b]);
  const lats = full.map((p) => p.lat), lons = full.map((p) => p.lon);
  const bb = [Math.min(...lons) - 0.02, Math.min(...lats) - 0.02, Math.max(...lons) + 0.02, Math.max(...lats) + 0.02].map((v) => v.toFixed(4));
  const polys = await landPolys(bb); const hits = [];
  for (let i = 1; i < full.length; i++) { const p0 = full[i - 1], p1 = full[i], n = Math.max(2, Math.ceil(nm(p0, p1) * 1852 / 25)); for (let q = 1; q < n; q++) { const f = q / n, la = p0.lat + (p1.lat - p0.lat) * f, lo = p0.lon + (p1.lon - p0.lon) * f, s = onLand(polys, lo, la); if (s) { hits.push({ leg: i, lat: +la.toFixed(5), lon: +lo.toFixed(5), svc: s }); break; } } }
  const dist = full.reduce((s, p, i) => i ? s + nm(full[i - 1], p) : 0, 0);
  report.push({ name, ...r, ids: undefined, turnPts: full.length - 2, routeNm: +dist.toFixed(1), straightNm: +nm(a, b).toFixed(1), landPolys: polys.length, landErr: polys.err, landHits: hits });
  // picture
  await page.evaluate(([a, b, pts]) => { const T = window.Tideline; T.RT.pts = [Object.assign({}, a, { stop: true })].concat(pts.slice(1, -1).map((p) => ({ lat: p.lat, lon: p.lon, turn: true })), [Object.assign({}, b, { stop: true })]); T.drawRoute(); T.map.fitBounds(T.L.latLngBounds(T.RT.pts.map((p) => [p.lat, p.lon])).pad(0.15)); }, [a, b, r.pts || []]);
  await page.waitForTimeout(5000); await page.screenshot({ path: 'diag/' + name.replace(/\W+/g, '_') + '.png' });
}
const md = ['# Live route check', '', 'Run ' + new Date().toISOString(), '', '## NOAA services', '```', JSON.stringify(facts, null, 1), '```', '', '## Routes', ''];
report.forEach((r) => md.push('- **' + r.name + '**: ' + (r.err ? 'ERROR ' + r.err : (r.ok ? 'ok' : 'NOT ok (' + r.why + ')') + ', ' + r.turnPts + ' turn points, ' + r.routeNm + ' nm (straight ' + r.straightNm + ' nm), ' + r.secs + ' s') + (r.lastErr ? ', lastErr: ' + r.lastErr : '') + ', land polygons checked ' + r.landPolys + (r.landErr ? ' (' + r.landErr + ')' : '') + ', **crosses land: ' + (r.landHits.length ? 'YES at ' + JSON.stringify(r.landHits) : 'no') + '**'));
md.push('', '## Network failures', ...netErr.slice(0, 40).map((x) => '- ' + x), '', '## Console errors', ...logs.slice(0, 40).map((x) => '- ' + x));
fs.writeFileSync('diag/report.md', md.join('\n')); fs.writeFileSync('diag/report.json', JSON.stringify({ facts, report, netErr, logs }, null, 1));
console.log(md.join('\n'));
await browser.close();
