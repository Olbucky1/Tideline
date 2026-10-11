// Download a snapshot of NOAA ENC Direct layers for the Annapolis area so routing can be replayed offline.
import fs from 'node:fs';
const ENC = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/';
const BB = [-76.75, 38.55, -75.95, 39.40];
const WANT = /\.(Depth_Area|Dredged_Area|Land_Area|Restricted_Area|Bridge_line|Bridge_area|Shoreline_Construction_area|Shoreline_Construction_line|Wreck_point|Obstruction_point|Coastline_line)$/i;
fs.mkdirSync('diag/enc', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJ(u, tries = 4) { for (let i = 0; i < tries; i++) { try { const r = await fetch(u); if (r.status === 429 || r.status >= 500) { await sleep(3000 * (i + 1)); continue; } return await r.json(); } catch (e) { await sleep(2000); } } throw new Error('failed ' + u.slice(0, 120)); }
const log = [];
for (const svc of ['enc_general', 'enc_coastal', 'enc_approach', 'enc_harbour']) {
  const meta = await getJ(ENC + svc + '/MapServer?f=json'); fs.writeFileSync('diag/enc/' + svc + '.meta.json', JSON.stringify(meta));
  for (const l of (meta.layers || []).filter((x) => WANT.test(x.name))) {
    const feats = []; let tiles = 0;
    // tile the box so each request stays small
    const step = svc === 'enc_harbour' || svc === 'enc_approach' ? 0.1 : 0.4;
    const seen = new Set();
    for (let x = BB[0]; x < BB[2]; x += step) for (let y = BB[1]; y < BB[3]; y += step) {
      for (let off = 0; off < 30000; off += 1000) {
        const u = ENC + svc + '/MapServer/' + l.id + '/query?where=1%3D1&geometry=' + [x, y, x + step, y + step].map((v) => v.toFixed(4)).join('%2C') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&maxAllowableOffset=0.00002&geometryPrecision=6&resultOffset=' + off + '&resultRecordCount=1000&f=json';
        let j; try { j = await getJ(u); } catch (e) { log.push(svc + ' ' + l.name + ' tile fail'); break; }
        tiles++;
        (j.features || []).forEach((f) => { const id = f.attributes && (f.attributes.OBJECTID ?? f.attributes.objectid); if (id != null && seen.has(id)) return; if (id != null) seen.add(id); feats.push(f); });
        if (!j.exceededTransferLimit) break;
      }
    }
    fs.writeFileSync('diag/enc/' + svc + '.' + l.id + '.json', JSON.stringify({ name: l.name, features: feats }));
    log.push(svc + ' ' + l.id + ' ' + l.name + ' ' + feats.length + ' features, ' + tiles + ' requests');
    console.log(log[log.length - 1]);
  }
  const lm = (meta.layers || []).filter((x) => WANT.test(x.name)).map((x) => x.id);
  for (const id of lm) { try { fs.writeFileSync('diag/enc/' + svc + '.' + id + '.meta.json', JSON.stringify(await getJ(ENC + svc + '/MapServer/' + id + '?f=json'))); } catch (e) {} }
}
fs.writeFileSync('diag/enc/log.txt', log.join('\n'));
