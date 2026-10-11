/* Tideline — a simple marine GPS for anyone on the water. Prototype v0.1 */
(() => {
'use strict';

/* ---------- small helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('tl.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tl.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
};
const saveTimers = {};
function saveSoon(key, getter, ms = 3000) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => store.set(key, getter()), ms);
}

/* ---------- state ---------- */
const DEFAULTS = {
  speedUnit: 'kn', distUnit: 'nm', boatLen: 27, gpsToBow: 20, cruise: 5,
  chart: 'noaa', seamarks: true, night: false, keepAwake: true, sim: false, simRate: 5,
  boatType: 'sail', underSail: true, boatName: '', aisCoach: false, aisShow: true, voice: true, skipper: '', iconStyle: 'boat',
  wx: 'none', bridges: true, bridgeMargin: 2, cockpit: false, theme: 'auto', satOver: true, chartOnSat: 0.6, sailSpeed: 5, navMode: 'engine', rings: false, easy: false, coachMode: 'off', chips: false, satSrc: 'std',
};
const savedSettings = store.get('settings', {});
if (savedSettings.coachMode == null && savedSettings.aisCoach != null) savedSettings.coachMode = !savedSettings.aisCoach ? 'off' : savedSettings.voice === false ? 'chime' : 'voice';
const S = {
  settings: Object.assign({}, DEFAULTS, savedSettings),
  fix: null, hist: [], sog: null, cog: null, lastFixAt: 0, firstFix: true,
  trip: store.get('trip', { dist: 0, max: 0, moving: 0, start: Date.now() }),
  goto: store.get('goto', null),
  mob: store.get('mob', null),
  anchor: store.get('anchor', null),
  anchorForm: store.get('anchorForm', { depth: 10, rode: 70, radius: null }),
  waypoints: store.get('waypoints', []),
  tracks: store.get('tracks', []),
  rec: store.get('rec', { on: false, pts: [], start: null }),
  weather: store.get('weather', null),
  tide: store.get('tide', null),
  follow: true, measure: { on: false, pts: [] }, tab: 'chart', sheetPoint: null,
  alarmOn: false, alarmKind: null, snoozeUntil: 0, gpsErr: null,
};
const saveSettings = () => store.set('settings', S.settings);

/* ---------- geodesy (nautical miles, degrees true) ---------- */
const R_NM = 3440.065, FT_PER_NM = 6076.12, M_PER_NM = 1852, KN_PER_MS = 1.943844;
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function distNm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function destination(p, brgDeg, nm) {
  const d = nm / R_NM, t = rad(brgDeg), la = rad(p.lat), lo = rad(p.lon);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(t));
  const lo2 = lo + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: deg(la2), lon: ((deg(lo2) + 540) % 360) - 180 };
}
function crossTrackNm(start, end, pos) {
  const d13 = distNm(start, pos) / R_NM;
  return Math.asin(Math.sin(d13) * Math.sin(rad(bearing(start, pos)) - rad(bearing(start, end)))) * R_NM; // + = right of track
}
function smoothAngle(prev, next, k) {
  const diff = ((next - prev + 540) % 360) - 180;
  return (prev + diff * k + 360) % 360;
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/* ---------- formatting ---------- */
const SPEED_LBL = { kn: 'kn', mph: 'mph', kmh: 'km/h' };
function speedOut(kn) { const u = S.settings.speedUnit; return u === 'kn' ? kn : u === 'mph' ? kn * 1.150779 : kn * 1.852; }
function fmtSpeed(kn) { return kn == null ? '–' : speedOut(kn).toFixed(1); }
function distParts(nm) {
  const u = S.settings.distUnit;
  if (u === 'km') { const m = nm * M_PER_NM; return m < 1000 ? [Math.round(m), 'm'] : [(m / 1000).toFixed(m < 10000 ? 2 : 1), 'km']; }
  if (u === 'mi') { const mi = nm * 1.150779; return mi < 0.1 ? [Math.round(mi * 5280), 'ft'] : [mi.toFixed(mi < 10 ? 2 : 1), 'mi']; }
  return nm < 0.1 ? [Math.round(nm * FT_PER_NM), 'ft'] : [nm.toFixed(nm < 10 ? 2 : 1), 'nm'];
}
const fmtDist = (nm) => distParts(nm).join(' ');
const lenUnit = () => (S.settings.distUnit === 'km' ? 'm' : 'ft');
const ftToLen = (ft) => (lenUnit() === 'm' ? ft * 0.3048 : ft);
const lenToFt = (v) => (lenUnit() === 'm' ? v / 0.3048 : v);
const fmtLen = (ft) => Math.round(ftToLen(ft)) + ' ' + lenUnit();
const fmtBrg = (d) => (d == null ? '–' : String(Math.round((d + 360) % 360) % 360).padStart(3, '0'));
function fmtDur(hours) {
  if (!isFinite(hours) || hours < 0) return '–';
  const m = Math.round(hours * 60);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' m';
}
const fmtHM = (sec) => { const m = Math.floor(sec / 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function ddm(v, isLat) {
  const h = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
  return String(d).padStart(isLat ? 2 : 3, '0') + '°' + m.toFixed(3).padStart(6, '0') + "'" + h;
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass16 = (d) => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function armed(btn, label) { // two-tap confirm, no dialogs
  if (btn.dataset.armed === '1') return true;
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = old; } }, 3500);
  return false;
}

/* ---------- map & layers ---------- */
const last = store.get('lastPos', null);
const map = L.map('map', { zoomControl: false, tapHold: true, worldCopyJump: true, maxZoom: 19, minZoom: 3, scrollWheelZoom: false, zoomSnap: 0, zoomDelta: 1 })
  .setView(last ? [last.lat, last.lon] : [38.975, -76.47], last ? 14 : 12);
map.attributionControl.setPrefix(false);
/* Mac trackpads and mice: two-finger swipe pans the chart, pinch zooms smoothly, a mouse wheel zooms smoothly around the pointer */
(() => {
  const el = map.getContainer(); let zoomAcc = 0, raf = null, at = null;
  const flush = () => { raf = null; if (!zoomAcc) return; const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), map.getZoom() + zoomAcc)); zoomAcc = 0; map.setZoomAround(at, z, { animate: false }); };
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1, dx = e.deltaX * px, dy = e.deltaY * px;
    const mouseWheel = e.deltaMode !== 0 || (e.wheelDeltaY && Math.abs(e.wheelDeltaY) % 120 === 0 && !e.deltaX) || (Math.abs(dy) >= 100 && !dx && Number.isInteger(dy));
    if (e.ctrlKey || mouseWheel) { // pinch, or a real mouse wheel: smooth zoom around the pointer
      at = map.mouseEventToContainerPoint(e);
      zoomAcc += -dy * (e.ctrlKey ? 0.012 : 0.0035);
      if (!raf) raf = requestAnimationFrame(flush);
    } else { // two-finger swipe: pan like a document
      if (typeof setFollow === 'function' && S.follow) setFollow(false);
      map.panBy([dx, dy], { animate: false });
    }
  }, { passive: false });
})();

const NOAA = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/MapServer/export';
const HALF = 20037508.342789244;
const TILE_PX = (window.devicePixelRatio || 1) > 1 ? 512 : 256;
function noaaUrl(x, y, z, transparent) {
  const size = (2 * HALF) / Math.pow(2, z);
  const xmin = -HALF + x * size, ymax = HALF - y * size;
  const bbox = [xmin, ymax - size, xmin + size, ymax].map((v) => v.toFixed(2)).join(',');
  return NOAA + '?bbox=' + bbox + '&bboxSR=3857&imageSR=3857&size=' + TILE_PX + ',' + TILE_PX +
    '&dpi=' + (TILE_PX === 512 ? 192 : 96) + '&format=png&transparent=' + (transparent ? 'true' : 'false') +
    '&layers=show:0,1,2,3,4,5,6,7&f=image';
}
const NoaaLayer = L.TileLayer.extend({
  getTileUrl(c) { return noaaUrl(c.x, c.y, c.z, this.options.transparentChart); },
});
const LAYERS = {
  noaa: new NoaaLayer('', { maxZoom: 19, maxNativeZoom: 18, updateWhenZooming: false, keepBuffer: 4, attribution: 'Chart: NOAA Office of Coast Survey' }),
  // a fast, cached ocean basemap under the NOAA chart, so the screen is never blank while NOAA draws its tiles
  ocean: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 13, attribution: 'Base: Esri, GEBCO, NOAA' }),
  noaaOver: new NoaaLayer('', { maxZoom: 19, maxNativeZoom: 18, transparentChart: true, opacity: 0.62, updateWhenZooming: false, keepBuffer: 4, attribution: 'Chart: NOAA' }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' }),
  satHD: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, attribution: 'Imagery: USGS The National Map' }),
  places: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13.99, maxNativeZoom: 13, minZoom: 5, opacity: 0.8, zIndex: 3, attribution: 'Labels: Esri' }), // quiet grey town names, gone before street names appear
  roads: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, opacity: 0.45, zIndex: 2, attribution: 'Roads: Esri' }),
  street: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
  seamarks: L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 18, attribution: 'Seamarks: OpenSeaMap' }),
};
const CHARTS = {
  noaa: { name: 'NOAA chart', note: 'Official US charts: depths, buoys, lights', layers: ['noaa'] },
  street: { name: 'Street map', note: 'Roads, marinas and shoreline, worldwide', layers: ['street'] },
  satellite: { name: 'Satellite only', note: 'Aerial photo, worldwide', layers: ['satellite'] },
};
if (S.settings.chart === 'hybrid') { S.settings.chart = 'noaa'; S.settings.satOver = true; }
function chartLayerKeys() {
  const ch = CHARTS[S.settings.chart] ? S.settings.chart : 'noaa';
  let keys;
  if (ch !== 'satellite' && S.settings.satOver && !S.satFailed) keys = [S.settings.satSrc === 'hd' ? 'satHD' : 'satellite', ch === 'noaa' ? 'noaaOver' : 'street']; // satellite under a see-through chart
  else keys = ch === 'satellite' && S.settings.satSrc === 'hd' ? ['satHD'] : ch === 'noaa' ? ['ocean', 'noaa'] : CHARTS[ch].layers.slice();
  if (S.settings.seamarks && ch !== 'noaa') keys.push('seamarks');
  if (ch !== 'street' && S.settings.landPlaces !== false) keys.push('places');
  if (ch !== 'street' && S.settings.landRoads) keys.push('roads');
  return keys;
}
let demoChart = null;
function applyChart() {
  Object.values(LAYERS).forEach((l) => { if (map.hasLayer(l)) map.removeLayer(l); });
  if (window.TL_DEMO) { // hosted demo: a sample chart image instead of live chart tiles
    if (!demoChart) demoChart = L.imageOverlay(window.TL_DEMO.chart, window.TL_DEMO.bounds, { zIndex: 1, attribution: 'Sample chart for demonstration only' });
    demoChart.addTo(map).bringToBack(); return;
  }
  const keys = chartLayerKeys();
  keys.forEach((k) => LAYERS[k].addTo(map));
  const over = S.settings.satOver && !S.satFailed && S.settings.chart !== 'satellite';
  const sb = $('btnSat'); if (sb) sb.classList.toggle('on', over || S.settings.chart === 'satellite');
  LAYERS.noaaOver.setOpacity(over ? S.settings.chartOnSat : 0.62);
  LAYERS.street.setOpacity(over ? S.settings.chartOnSat : 1);
}

/* overlays */
const C = { teal: '#2BB3A3', amber: '#E8952B', navy: '#0E1F2E', red: '#D64545', purple: '#6B4FBB' };
const trackLine = L.polyline(S.rec.pts.map((p) => [p[0], p[1]]), { color: C.teal, weight: 4, opacity: 0.9, interactive: false }).addTo(map);
const shownTrack = L.polyline([], { color: C.purple, weight: 4, opacity: 0.85, interactive: false }).addTo(map);
const projLine = L.polyline([], { color: C.navy, weight: 2, dashArray: '3 6', interactive: false }).addTo(map);
const gotoLine = L.polyline([], { color: C.amber, weight: 3, dashArray: '9 7', interactive: false }).addTo(map);
const accCircle = L.circle([0, 0], { radius: 1, color: '#0E3A5B', weight: 1, opacity: 0.5, fillOpacity: 0.08, interactive: false });
const boatIcon = L.divIcon({
  className: 'boat-icon', iconSize: [36, 36], iconAnchor: [18, 18],
  html: '<svg width="36" height="36" viewBox="0 0 36 36"><g id="boatRot"><path id="boatShape" d="M18 3 L28 31 L18 25 L8 31 Z" fill="#0E1F2E" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></g></svg>',
});
const boatMarker = L.marker([0, 0], { icon: boatIcon, interactive: false, keyboard: false, zIndexOffset: 1000 });
const gotoMarker = L.circleMarker([0, 0], { radius: 9, color: C.amber, weight: 3, fillColor: '#fff', fillOpacity: 1 });
const mobMarker = L.marker([0, 0], { interactive: false, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: '<svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="12" fill="#D64545" stroke="#fff" stroke-width="3"/><path d="M10 10l10 10M20 10L10 20" stroke="#fff" stroke-width="3"/></svg>' }) });
const wpLayer = L.layerGroup().addTo(map);
const anchorLayer = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map);

function renderWaypoints() {
  wpLayer.clearLayers();
  S.waypoints.forEach((w) => {
    const m = L.marker([w.lat, w.lon], {
      icon: L.divIcon({ className: 'wp-icon', iconSize: [20, 20], iconAnchor: [10, 10], html: '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 2 L18 10 L10 18 L2 10 Z" fill="#0E3A5B" stroke="#fff" stroke-width="2.5"/></svg>' }),
    });
    m.bindTooltip(esc(w.name), { permanent: true, direction: 'right', offset: [10, 0], className: 'wp-label' });
    m.on('click', () => openPointSheet(L.latLng(w.lat, w.lon), w));
    wpLayer.addLayer(m);
  });
}

/* ---------- sheet (bottom card for a point, layers) ---------- */
const sheet = $('sheet');
function openSheet(html) { sheet.innerHTML = '<div class="grab"></div><button type="button" class="sheet-x" data-sheetx aria-label="Close">&times;</button>' + html; sheet.hidden = false; }
function closeSheet() { sheet.hidden = true; sheet.innerHTML = ''; S.sheetPoint = null; }

function legInfo(from, to) {
  const d = distNm(from, to), b = bearing(from, to);
  const moving = (S.sog || 0) > 0.6;
  const spd = moving ? S.sog : S.settings.cruise;
  return { d, b, hrs: d / spd, spdNote: moving ? 'at ' + fmtSpeed(S.sog) + ' ' + SPEED_LBL[S.settings.speedUnit] : 'at cruising ' + fmtSpeed(S.settings.cruise) + ' ' + SPEED_LBL[S.settings.speedUnit] };
}
function trio(info) {
  const [dv, du] = distParts(info.d);
  return '<div class="trio"><div><span class="lbl">DISTANCE</span><b class="tnum">' + dv + '</b><span class="unit">' + du + '</span></div>' +
    '<div><span class="lbl">BEARING</span><b class="tnum">' + fmtBrg(info.b) + '°</b><span class="unit">true</span></div>' +
    '<div><span class="lbl">TIME</span><b class="tnum">' + fmtDur(info.hrs).replace(' min', 'm') + '</b><span class="unit">' + esc(info.spdNote) + '</span></div></div>';
}
function openPointSheet(latlng, wp) {
  if (S.measure.on) return;
  const p = { lat: latlng.lat, lon: ((latlng.lng + 540) % 360) - 180 };
  S.sheetPoint = { p, wp: wp || null };
  let html = '<h3>' + (wp ? esc(wp.name) : 'Dropped pin') + '</h3><div class="sub tnum">' + ddm(p.lat, true) + '  ' + ddm(p.lon, false) + '</div>';
  html += S.fix ? trio(legInfo(S.fix, p)) : '<p class="sub">Distance from you appears once GPS has a fix.</p>';
  html += '<div class="pt-acts"><button class="btn primary" data-act="goto">Navigate to</button>' +
    '<button class="btn" data-act="ptwx">Weather here</button><button class="btn" data-act="ptmeasure">Measure from here</button>' +
    (wp ? '<button class="btn" data-act="delwp">Delete</button>' : '<button class="btn" data-act="savewp">Save</button>') +
    '</div><div id="ptWx"></div><div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>';
  openSheet(html);
}
async function pointWeather(p) {
  const box = $('ptWx'); if (!box) return;
  box.innerHTML = '<p class="sub">Getting the forecast for this spot…</p>';
  try {
    const ll = '?latitude=' + p.lat.toFixed(3) + '&longitude=' + p.lon.toFixed(3);
    const [w, m] = await Promise.all([
      fetch('https://api.open-meteo.com/v1/forecast' + ll + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=GMT&forecast_days=2').then((r) => r.json()),
      fetch('https://marine-api.open-meteo.com/v1/marine' + ll + '&hourly=wave_height&length_unit=imperial&timezone=GMT&forecast_days=2').then((r) => r.json()).catch(() => null),
    ]);
    const h = w.hourly, now = Date.now(), rows = [];
    for (let i = 0; i < h.time.length && rows.length < 8; i++) {
      const t = Date.parse(h.time[i] + 'Z'); if (t < now - 1800000) continue;
      if (rows.length && (t - rows[rows.length - 1].t) < 3 * 3600000 - 1) continue;
      const wv = m && m.hourly && m.hourly.wave_height ? m.hourly.wave_height[i] : null;
      rows.push({ t, spd: h.wind_speed_10m[i], dir: h.wind_direction_10m[i], gust: h.wind_gusts_10m[i], wv });
    }
    if (!$('ptWx')) return;
    $('ptWx').innerHTML = '<div class="pt-wx">' + rows.map((r) => '<div><small>' + fmtClock(r.t) + '</small><i style="--c:' + colFor(WIND_COL, r.spd) + '">' + windArrow(r.dir) + '</i><b class="tnum">' + Math.round(speedOut(r.spd)) + '</b><small>g' + Math.round(speedOut(r.gust)) + (r.wv != null ? ' · ' + waveLen(r.wv) : '') + '</small></div>').join('') + '</div><p class="hint" style="margin:6px 0 0">Model forecast for this spot, every 3 hours. ' + SPEED_LBL[S.settings.speedUnit] + '; g = gust.</p>';
  } catch (e) { if ($('ptWx')) $('ptWx').innerHTML = '<p class="sub">No forecast: check signal.</p>'; }
}
function optSeg(name, opts, cur) {
  return '<div class="seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-opt="' + name + '" data-val="' + v + '" class="' + (String(cur) === String(v) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
}
function tog(id, label, note, on) {
  return '<label class="opt"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span>' + label + (note ? '<small>' + note + '</small>' : '') + '</span></label>';
}
function openLayersSheet() {
  const st = S.settings;
  let html = '<div class="mo"><div class="mo-top"><h3>Map options</h3><span><button type="button" class="btn small" data-act="mohelp">Help</button> <button type="button" class="btn small" data-act="mosettings">All settings</button></span></div>' + '<div class="mo-h">Color mode</div>' + optSeg('theme', [['auto', 'Auto'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']], st.theme || 'auto') + '' + (window.TL_DEMO ? '<p class="hint" style="margin:6px 0 0">This demo uses a sample chart, because hosted demo pages can\'t load live chart or satellite images. NOAA charts and satellite work in the full app.</p>' : '');
  html += '<div class="mo-h">Chart</div>' + optSeg('chart', Object.entries(CHARTS).map(([k, c]) => [k, c.name.replace(' only', '')]), st.chart);
  html += '<div class="mo-h">Overlays</div>';
  html += tog('satBox', 'Satellite imagery', 'Aerial photo under the chart', st.satOver && st.chart !== 'satellite');
  if (st.satOver && st.chart !== 'satellite') html += '<div class="field" style="margin:4px 0 8px"><label for="satMix">Chart on top: <b id="satMixVal">' + Math.round(st.chartOnSat * 100) + '%</b></label><input id="satMix" type="range" min="20" max="100" step="5" value="' + Math.round(st.chartOnSat * 100) + '"></div>';
  if (st.satOver || st.chart === 'satellite') html += '<div class="mo-h">Satellite imagery</div>' + optSeg('satSrc', [['std', 'Standard'], ['hd', 'HD (US waters)']], st.satSrc || 'std');
  html += tog('aisBox', 'AIS boats', S.settings.sim ? 'Demo shows sample boats. Live AIS comes from your boat\'s receiver' : 'Live AIS needs your boat\'s AIS receiver connected (app-store version)', S.settings.aisShow !== false);
  html += tog('chipsBox', 'Wind, waves and tide on the chart', 'Off keeps the chart calm; the status line shows wind', st.chips);
  html += tog('mpBox', 'Marinas, clubs, fuel and ramps', 'Named on the chart when you zoom in', S.settings.mplaces !== false);
  html += tog('placesBox', 'Town names', 'A faint outline on land so you know where you are', S.settings.landPlaces !== false) + tog('roadsBox', 'Roads', 'Faint major roads on land', !!S.settings.landRoads);
  html += tog('ringsBox', 'Range rings', 'Distance rings around your boat', st.rings);
  html += tog('bridgesBox', 'Bridge clearances', 'Labels and warnings checked against your boat', st.bridges);
  html += tog('seamarksBox', 'Buoys and lights on street and satellite maps', 'From OpenSeaMap, a community chart', st.seamarks);
  html += '<div class="mo-h">Weather on the chart (pick any)</div>' + tog('wxWind', 'Wind', 'Forecast arrows, speed and gust', wxOn('wind')) + tog('wxWaves', 'Waves', 'Forecast wave height', wxOn('waves')) + tog('wxRain', 'Rain radar', 'Live NEXRAD, every 5 minutes', wxOn('rain'));

  html += tog('easyBox', 'Easy view', 'Bigger icons and text', st.easy);
  html += '<div class="row-btns" style="margin-top:12px"><button class="btn" data-act="cockpit">Cockpit display</button><button class="btn primary" data-act="close">Done</button></div></div>';
  openSheet(html);
}
sheet.addEventListener('click', (e) => {
  const o = e.target.closest('[data-opt]'); if (!o) return;
  const k = o.dataset.opt, v = o.dataset.val;
  S.settings[k] = v; saveSettings();
  if (k === 'chart' || k === 'satSrc') { S.satFailed = false; applyChart(); }
  if (k === 'wx') applyWx();
  if (k === 'theme') { applyNight(); updateBoat(); }
  openLayersSheet();
});
sheet.addEventListener('input', (e) => {
  if (e.target.id === 'satMix') { S.settings.chartOnSat = +e.target.value / 100; $('satMixVal').textContent = e.target.value + '%'; applyChart(); saveSoon('settings', () => S.settings, 800); }
});
(() => { const ch = document.querySelector('.topbar .chips'); if (ch) { ch.classList.add('chips-free'); $('app').appendChild(ch); } })(); // chips get their own spot top-right
function applyCalm() { document.documentElement.classList.toggle('calm', !S.settings.chips); placeFabs(); }
function applyEasy() { document.documentElement.classList.toggle('easy', !!S.settings.easy); }
/* range rings around the boat, scaled to the zoom */
const ringLayer = L.layerGroup().addTo(map);
function drawRings() {
  ringLayer.clearLayers();
  if (!S.settings.rings || !S.fix) return;
  const z = map.getZoom(), radii = z >= 16 ? [0.1, 0.25] : z >= 14 ? [0.25, 0.5, 1] : z >= 12 ? [0.5, 1, 2] : [1, 2, 4];
  radii.forEach((r) => {
    ringLayer.addLayer(L.circle([S.fix.lat, S.fix.lon], { radius: r * M_PER_NM, color: '#0E1F2E', weight: 1, opacity: 0.45, fill: false, interactive: false }));
    const p = destination(S.fix, 180, r);
    ringLayer.addLayer(L.marker([p.lat, p.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'ring-lbl', iconSize: [44, 14], iconAnchor: [22, 7], html: fmtDist(r).replace(' ', '&#8202;') }) }));
  });
}
map.on('zoomend', drawRings);
sheet.addEventListener('change', (e) => {
  if (e.target.name === 'chart') { S.settings.chart = e.target.value; saveSettings(); applyChart(); }
  if (e.target.id === 'seamarksBox') { S.settings.seamarks = e.target.checked; saveSettings(); applyChart(); }
  if (e.target.id === 'wxWind' || e.target.id === 'wxWaves' || e.target.id === 'wxRain') setWxL({ wxWind: 'wind', wxWaves: 'waves', wxRain: 'rain' }[e.target.id], e.target.checked);
  if (e.target.id === 'bridgesBox') { S.settings.bridges = e.target.checked; saveSettings(); refreshBridges(true); }
  if (e.target.id === 'satBox') { S.settings.satOver = e.target.checked; if (S.settings.chart === 'satellite') S.settings.chart = 'noaa'; saveSettings(); applyChart(); openLayersSheet(); }
  if (e.target.id === 'mpBox') { S.settings.mplaces = e.target.checked; saveSettings(); refreshMarinePlaces(); }
  if (e.target.id === 'placesBox') { S.settings.landPlaces = e.target.checked; saveSettings(); applyChart(); }
  if (e.target.id === 'roadsBox') { S.settings.landRoads = e.target.checked; saveSettings(); applyChart(); }
  if (e.target.id === 'aisBox') { S.settings.aisShow = e.target.checked; saveSettings(); updateAis(); }
  if (e.target.id === 'chipsBox') { S.settings.chips = e.target.checked; saveSettings(); applyCalm(); }
  if (e.target.id === 'ringsBox') { S.settings.rings = e.target.checked; saveSettings(); drawRings(); }
  if (e.target.id === 'easyBox') { S.settings.easy = e.target.checked; saveSettings(); applyEasy(); }
});
sheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-sheetx]')) { if (typeof RT !== 'undefined' && RT.edit) routeMode(false); if (S.measure.on) setMeasure(false); closeSheet(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, sp = S.sheetPoint;
  if (act === 'close') closeSheet();
  if (act === 'goto' && sp) { setGoto(sp.wp ? sp.wp.name : sp.place ? sp.place.name : sp.spot ? (sp.spot.species || 'Fishing spot') : 'Dropped pin', sp.p.lat, sp.p.lon); closeSheet(); }
  if (act === 'savewp' && sp) {
    const n = S.waypoints.length + 1;
    const w = { id: Date.now(), name: sp.place ? sp.place.name : 'Waypoint ' + n, lat: sp.p.lat, lon: sp.p.lon };
    S.waypoints.push(w); store.set('waypoints', S.waypoints); renderWaypoints(); closeSheet();
    toast('Saved ' + w.name + ' to your waypoints');
  }
  if (act === 'delwp' && sp && sp.wp) {
    if (!armed(b, 'Tap again to delete')) return;
    S.waypoints = S.waypoints.filter((w) => w.id !== sp.wp.id); store.set('waypoints', S.waypoints); renderWaypoints(); closeSheet();
  }
  if (act === 'measureclear') { clearMeasure(); closeSheet(); }
  if (act === 'rtwipe') { clearRouteEverywhere(); return; }
  if (act === 'rtedit2') { closeSheet(); routeMode(true); return; }
  if (act === 'mosettings') { closeSheet(); setTab('settings'); }
  if (act === 'mohelp') { closeSheet(); openHelp(); }
  if (act === 'ptwx' && sp) { b.disabled = true; pointWeather(sp.p); }
  if (act === 'ptmeasure' && sp) { const ll = L.latLng(sp.p.lat, sp.p.lon); closeSheet(); setMeasure(true, ll); }
});

/* ---------- measure: drag-to-measure ruler (savvy navvy style) ---------- */
const M = { a: null, b: null, ring: true, drag: null, zoomAt: 0 };
const handleIcon = (cls) => L.divIcon({ className: '', iconSize: [48, 48], iconAnchor: [24, 24], html: '<div class="m-handle ' + cls + '"><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="11"/><path d="M24 6v12M24 30v12M6 24h12M30 24h12"/></svg></div>' });
function setMeasure(on, from) {
  S.measure.on = on; measureLayer.clearLayers(); M.a = M.b = null;
  $('btnMeasure').classList.toggle('on', on);
  closeSheet();
  if (!on) return;
  const c = map.getCenter(), sz = map.getSize();
  const useBoat = S.fix && map.getBounds().contains([S.fix.lat, S.fix.lon]);
  const start = from || (useBoat ? L.latLng(S.fix.lat, S.fix.lon) : map.containerPointToLatLng([sz.x * 0.4, sz.y * 0.55]));
  const sp = map.latLngToContainerPoint(start);
  const end = map.containerPointToLatLng([Math.min(sz.x - 70, sp.x + sz.x * 0.3), Math.max(130, sp.y - sz.y * 0.22)]);
  void c;
  M.line = L.polyline([], { color: C.navy, weight: 3, dashArray: '8 6', interactive: false }).addTo(measureLayer);
  M.circle = L.circle(start, { radius: 1, color: C.navy, weight: 1.5, dashArray: '4 6', fill: false, interactive: false }).addTo(measureLayer);
  M.label = L.tooltip({ permanent: true, direction: 'top', className: 'measure-label', offset: [0, -24] });
  M.a = L.marker(start, { icon: handleIcon('start'), keyboard: false, zIndexOffset: 1200 }).addTo(measureLayer);
  M.b = L.marker(end, { icon: handleIcon('end'), keyboard: false, zIndexOffset: 1300 }).addTo(measureLayer);
  M.b.bindTooltip(M.label);
  [M.a, M.b].forEach((mk) => wireHandle(mk));
  updateMeasure();
  toast('Drag either circle to measure. Drag to the edge and the chart zooms out.', 4000);
}
function wireHandle(mk) {
  const el = mk.getElement(); if (!el) return;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    M.drag = mk; map.dragging.disable(); el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (M.drag !== mk) return;
    const r = map.getContainer().getBoundingClientRect(), pt = L.point(e.clientX - r.left, e.clientY - r.top), sz = map.getSize();
    const edge = pt.x < 48 || pt.y < 110 || pt.x > sz.x - 48 || pt.y > sz.y - 150;
    if (edge && Date.now() - M.zoomAt > 650 && map.getZoom() > map.getMinZoom()) { // zoom out so you can see where you're dragging
      M.zoomAt = Date.now();
      const other = mk === M.a ? M.b : M.a;
      map.setZoomAround(other.getLatLng(), map.getZoom() - 1, { animate: false });
    }
    mk.setLatLng(map.containerPointToLatLng(pt)); updateMeasure();
  });
  const up = () => { if (M.drag === mk) { M.drag = null; map.dragging.enable(); updateMeasure(true); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function updateMeasure(settled) {
  if (!M.a || !M.b) return;
  const a = M.a.getLatLng(), b = M.b.getLatLng(), pa = { lat: a.lat, lon: a.lng }, pb = { lat: b.lat, lon: b.lng };
  const info = legInfo(pa, pb);
  M.line.setLatLngs([a, b]);
  M.circle.setLatLng(a).setRadius(info.d * M_PER_NM).setStyle({ opacity: M.ring ? 0.7 : 0 });
  M.label.setContent('<b>' + fmtDist(info.d) + '</b><span>Bearing ' + fmtBrg(info.b) + '°T</span>');
  M.b.openTooltip();
  if (settled || sheet.hidden || !sheet.querySelector('.m-sheet')) {
    openSheet('<div class="m-sheet"><h3>Measure</h3><div class="sub">Drag the circles. The dashed ring shows the same distance in every direction.</div>' + trio(info) +
      '<div class="row-btns">' + (S.fix ? '<button class="btn" data-act="mfromboat">From my boat</button>' : '') + '<button class="btn" data-act="mring">' + (M.ring ? 'Hide ring' : 'Show ring') + '</button><button class="btn" data-act="mgoto">Go to end</button><button class="btn primary" data-act="mdone">Done</button></div></div>');
  } else {
    const t = sheet.querySelector('.trio'); if (t) t.outerHTML = trio(info);
  }
}
function measureTap(ll) { if (M.b) { M.b.setLatLng(ll); updateMeasure(true); } }
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !M.a) return;
  const act = b.dataset.act;
  if (act === 'mfromboat' && S.fix) { M.a.setLatLng([S.fix.lat, S.fix.lon]); updateMeasure(true); }
  if (act === 'mring') { M.ring = !M.ring; updateMeasure(true); }
  if (act === 'mgoto') { const ll = M.b.getLatLng(); setMeasure(false); setGoto('Measured point', ll.lat, ll.lng); }
  if (act === 'mdone') setMeasure(false);
});
function clearMeasure() { setMeasure(false); }

/* ---------- route planner (manual, savvy navvy style) ---------- */
S.routes = store.get('routes', []);
const RT = { edit: false, pts: store.get('routeDraft', []), marks: L.layerGroup().addTo(map), line: L.polyline([], { color: '#C2185B', weight: 5, opacity: 0.9, interactive: true }).addTo(map), depart: null, drag: null };
function dragHandle(mk, onMove, onEnd) { // finger drag for a marker, with zoom-out at the screen edge
  const el = mk.getElement(); if (!el) return;
  el.style.touchAction = 'none';
  let active = false, zoomAt = 0;
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); active = true; map.dragging.disable(); el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    const r = map.getContainer().getBoundingClientRect(), pt = L.point(e.clientX - r.left, e.clientY - r.top), sz = map.getSize();
    if ((pt.x < 48 || pt.y < 110 || pt.x > sz.x - 48 || pt.y > sz.y - 150) && Date.now() - zoomAt > 650 && map.getZoom() > map.getMinZoom()) { zoomAt = Date.now(); map.setZoom(map.getZoom() - 1, { animate: false }); }
    mk.setLatLng(map.containerPointToLatLng(pt)); onMove(mk.getLatLng());
  });
  const up = () => { if (active) { active = false; map.dragging.enable(); if (onEnd) onEnd(); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('click', (e) => e.stopPropagation());
}
function clearRouteEverywhere() { if (S.goto && S.goto.route) endGoto(); RT.pts = []; store.set('routeDraft', []); if (RT.edit) routeMode(false); drawRoute(); closeSheet(); toast('Route cleared'); }
function openRouteMenu() {
  openSheet('<h3>Route</h3><div class="sub">' + RT.pts.length + ' points' + (S.goto && S.goto.route ? ' · you are navigating it' : '') + '</div><div class="row-btns"><button class="btn danger" data-act="rtwipe">Clear this route</button><button class="btn" data-act="rtedit2">Edit</button><button class="btn ghost" data-act="close">Close</button></div>');
}
function drawRoute() {
  RT.marks.clearLayers();
  const show = RT.edit || (S.goto && S.goto.route);
  RT.line.setLatLngs(show ? RT.pts.map((p) => [p.lat, p.lon]) : []);
  if (!show) return;
  RT.pts.forEach((p, i) => {
    const mk = L.marker([p.lat, p.lon], { keyboard: false, zIndexOffset: 1100, icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: '<div class="rt-pt' + (RT.edit ? ' edit' : '') + '">' + (i + 1) + '</div>' }) }).addTo(RT.marks);
    if (!RT.edit) mk.on('click', () => openRouteMenu());
    if (RT.edit) dragHandle(mk, (ll) => { p.lat = ll.lat; p.lon = ll.lng; RT.line.setLatLngs(RT.pts.map((q) => [q.lat, q.lon])); }, () => { store.set('routeDraft', RT.pts); renderRouteSheet(); });
  });
}
setTimeout(() => RT.line.on('click', (e) => { L.DomEvent.stop(e); if (!RT.edit) openRouteMenu(); }), 0);
function routeMode(on) {
  RT.edit = on; $('btnRoute').classList.toggle('on', on);
  if (on) { if (S.measure.on) setMeasure(false); setTab('chart'); if (!RT.depart) RT.depart = Date.now(); renderRouteSheet(); toast(RT.pts.length ? 'Drag a waypoint to move it. Tap the chart to add more.' : 'Tap the chart to set your start, then each waypoint.', 4000); }
  else closeSheet();
  drawRoute();
}
function routeAdd(ll) { RT.pts.push({ lat: ll.lat, lon: ll.lng }); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }
function windAt(t) {
  const h = S.weather && S.weather.hours; if (!h || !h.length) return null;
  let best = h[0]; h.forEach((x) => { if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x; });
  return Math.abs(best.t - t) < 2 * 3600000 ? best : null;
}
function bridgesOnLeg(a, b) {
  const out = []; if (typeof BR === 'undefined') return out;
  const len = distNm(a, b);
  BR.list.forEach((br) => { if (distNm(a, br) + distNm(br, b) - len < 0.06) { const j = judgeBridge(br); if (j.level !== 'ok' && j.level !== 'info') out.push({ br, j }); } });
  return out;
}
function routeStats() {
  const spd = (S.sog || 0) > 1 ? S.sog : navSpeed(), legs = [];
  let t = RT.depart || Date.now(), total = 0;
  for (let i = 1; i < RT.pts.length; i++) {
    const a = RT.pts[i - 1], b = RT.pts[i], d = distNm(a, b), hrs = d / spd;
    legs.push({ i, d, brg: bearing(a, b), hrs, start: t, wind: windAt(t), bridges: bridgesOnLeg(a, b) });
    t += hrs * 3600000; total += d;
  }
  const hrs = total / spd, fuel = S.settings.navMode !== 'sail' && S.boat.gph ? hrs * S.boat.gph : null;
  return { legs, total, hrs, arrive: t, spd, fuel };
}
const toLocalInput = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
function renderRouteSheet() {
  if (!RT.edit) return;
  const st = routeStats(), n = RT.pts.length;
  let h = '<div class="rt-sheet"><h3>Route</h3>';
  if (n < 2) {
    h += '<div class="sub">' + (n ? 'Now tap where you want to go. Add as many waypoints as you like.' : 'Tap the chart to set your start, or start from your boat.') + '</div>';
    h += '<div class="row-btns">' + (S.fix ? '<button class="btn primary" data-act="rtboat">Start from my boat</button>' : '') + (n ? '<button class="btn" data-act="rtundo">Undo</button>' : '') + '<button class="btn ghost" data-act="rtclose">Close</button></div>';
    if (S.routes.length && !n) h += '<div class="mo-h">Saved routes</div>' + S.routes.slice().reverse().map((r) => '<div class="li"><div class="li-main"><b>' + esc(r.name) + '</b><span class="tnum">' + r.pts.length + ' waypoints</span></div><div class="li-btns"><button class="btn small" data-act="rtload" data-id="' + r.id + '">Open</button><button class="btn small" data-act="rtdel" data-id="' + r.id + '">Delete</button></div></div>').join('');
    h += '</div>'; openSheet(h); return;
  }
  const [dv, du] = distParts(st.total);
  h += '<div class="trio"><div><span class="lbl">DISTANCE</span><b class="tnum">' + dv + '</b><span class="unit">' + du + '</span></div><div><span class="lbl">TIME</span><b class="tnum">' + fmtDur(st.hrs).replace(' min', 'm') + '</b><span class="unit">at ' + fmtSpeed(st.spd) + ' ' + SPEED_LBL[S.settings.speedUnit] + '</span></div><div><span class="lbl">ARRIVE</span><b class="tnum">' + fmtClock(st.arrive) + '</b><span class="unit">' + new Date(st.arrive).toLocaleDateString([], { weekday: 'short' }) + '</span></div></div>' +
    (st.fuel != null ? '<div class="sub tnum" style="margin:-4px 0 8px">Fuel about ' + (Math.round(st.fuel * 10) / 10) + ' gal at ' + S.boat.gph + ' gal/h' + (S.boat.tankGal ? ' · ' + Math.round(st.fuel / S.boat.tankGal * 100) + '% of your tank' : '') + '. An estimate: keep a third in reserve.</div>' : '');
  h += '<div class="field" style="margin:4px 0 8px"><label for="rtDepart">Depart</label><input id="rtDepart" type="datetime-local" value="' + toLocalInput(RT.depart || Date.now()) + '"></div>';
  h += '<div class="rt-legs">' + st.legs.map((l) => '<div class="rt-leg"><span class="rt-n">' + l.i + '→' + (l.i + 1) + '</span><span class="tnum">' + fmtDist(l.d) + ' · ' + fmtBrg(l.brg) + '°T · ' + fmtDur(l.hrs).replace(' min', 'm') + '</span><span class="rt-w">' + (l.wind ? compass16(l.wind.dir) + ' ' + Math.round(speedOut(l.wind.spd)) + ' g' + Math.round(speedOut(l.wind.gust)) : '') + '</span></div>' +
    l.bridges.map((x) => '<div class="rt-warn v-' + x.j.level + '">' + esc(x.br.name) + ': ' + esc(x.j.text) + '</div>').join('')).join('') + '</div>';
  h += '<p class="hint" style="margin:6px 0">Straight lines between your waypoints. Tideline does not check depth along the route yet: check the chart for shoals, and the wind shown is the forecast where you are now.</p>';
  h += '<div class="row-btns"><button class="btn primary" data-act="rtstart">Start</button><button class="btn" data-act="rtsave">Save</button><button class="btn" data-act="rtundo">Undo</button><button class="btn" data-act="rtrev">Reverse</button><button class="btn ghost" data-act="rtclear">Clear</button><button class="btn ghost" data-act="rtclose">Close</button></div></div>';
  openSheet(h);
}
sheet.addEventListener('change', (e) => { if (e.target.id === 'rtDepart') { const t = Date.parse(e.target.value); if (t) { RT.depart = t; renderRouteSheet(); } } });
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !b.dataset.act.startsWith('rt')) return;
  const act = b.dataset.act;
  if (act === 'rtboat' && S.fix) { RT.pts.unshift({ lat: S.fix.lat, lon: S.fix.lon }); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }
  if (act === 'rtundo') { RT.pts.pop(); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }
  if (act === 'rtrev') { RT.pts.reverse(); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }
  if (act === 'rtclear') { if (!armed(b, 'Tap again to clear')) return; RT.pts = []; store.set('routeDraft', []); drawRoute(); renderRouteSheet(); }
  if (act === 'rtclose') routeMode(false);
  if (act === 'rtsave') { const r = { id: Date.now(), name: 'Route ' + (S.routes.length + 1) + ' · ' + new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }), pts: RT.pts.map((p) => ({ lat: p.lat, lon: p.lon })) }; S.routes.push(r); store.set('routes', S.routes); toast('Saved as ' + r.name); }
  if (act === 'rtload') { const r = S.routes.find((x) => String(x.id) === b.dataset.id); if (r) { RT.pts = r.pts.map((p) => ({ lat: p.lat, lon: p.lon })); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); map.fitBounds(L.latLngBounds(RT.pts.map((p) => [p.lat, p.lon])).pad(0.2)); } }
  if (act === 'rtdel') { S.routes = S.routes.filter((x) => String(x.id) !== b.dataset.id); store.set('routes', S.routes); renderRouteSheet(); }
  if (act === 'rtstart') {
    let i = 0; if (S.fix && distNm(S.fix, RT.pts[0]) < 0.15) i = 1;
    const pts = RT.pts.map((p) => ({ lat: p.lat, lon: p.lon }));
    RT.edit = false; $('btnRoute').classList.remove('on'); closeSheet(); drawRoute();
    routeLeg(pts, i);
  }
});
function routeLeg(pts, i) {
  const p = pts[i]; setGoto((p.name ? p.name + ' · ' : '') + 'stop ' + (i + 1) + ' of ' + pts.length, p.lat, p.lon);
  S.goto.route = { pts, i }; store.set('goto', S.goto); updateGoto(); RT.pts = pts; drawRoute();
}

/* ---------- go to / navigation ---------- */
function setGoto(name, lat, lon) {
  S.goto = { name, lat, lon, from: S.fix ? { lat: S.fix.lat, lon: S.fix.lon } : null, arrived: false };
  store.set('goto', S.goto);
  updateGoto(); renderStrip(); setTab('chart');
  if (S.fix) { setFollow(false); map.fitBounds(L.latLngBounds([[S.fix.lat, S.fix.lon], [lat, lon]]).pad(0.25), { maxZoom: 16 }); }
}
function endGoto() { S.goto = null; store.set('goto', null); updateGoto(); renderStrip(); if (typeof drawRoute === 'function') drawRoute(); }
function updateGoto() {
  const g = S.goto;
  if (!g) { gotoLine.setLatLngs([]); if (map.hasLayer(gotoMarker)) map.removeLayer(gotoMarker); $('gotoRow').hidden = true; return; }
  gotoMarker.setLatLng([g.lat, g.lon]); if (!map.hasLayer(gotoMarker)) gotoMarker.addTo(map);
  if (!S.fix) { gotoLine.setLatLngs([]); $('gotoRow').hidden = false; $('gotoRow').innerHTML = '<div class="g-main"><span class="g-name">To ' + esc(g.name) + '</span><span class="g-val">Waiting for GPS…</span></div><button class="btn small" data-act="endgoto">End</button>'; return; }
  if (!g.from) { g.from = { lat: S.fix.lat, lon: S.fix.lon }; store.set('goto', g); }
  gotoLine.setLatLngs([[S.fix.lat, S.fix.lon], [g.lat, g.lon]]);
  const info = legInfo(S.fix, g);
  if (info.d < 0.03 && !g.arrived) {
    g.arrived = true; store.set('goto', g); beep(2);
    if (g.route && g.route.i + 1 < g.route.pts.length) { const r = g.route; toast('Waypoint reached. Next: waypoint ' + (r.i + 2) + '.'); headsUp('Waypoint reached. Next leg.'); setTimeout(() => routeLeg(r.pts, r.i + 1), 50); return; }
    toast(g.route ? 'Route complete. Welcome in.' : 'Arrived at ' + g.name);
  }
  let xteHtml = '';
  const legLen = distNm(g.from, g);
  if (legLen > 0.05 && info.d > 0.03) {
    const x = crossTrackNm(g.from, g, S.fix);
    if (Math.abs(x) > 0.01) xteHtml = '<span class="g-xte">' + fmtDist(Math.abs(x)) + ' ' + (x > 0 ? 'right' : 'left') + ' of the line · steer ' + (x > 0 ? 'left' : 'right') + '</span>';
  }
  const eta = isFinite(info.hrs) ? fmtClock(Date.now() + info.hrs * 3600000) : '–';
  $('gotoRow').hidden = false;
  $('gotoRow').innerHTML = '<div class="g-main"><span class="g-name">To ' + esc(g.name) + (g.arrived ? ' · arrived' : '') + '</span>' +
    '<span class="g-val tnum">' + fmtDist(info.d) + ' · ' + fmtBrg(info.b) + '°T · ' + fmtDur(info.hrs) + ' · ETA ' + eta + '</span>' + xteHtml +
    '</div><button class="btn small" data-act="endgoto">End</button>';
}

/* ---------- bottom strip ---------- */
function cellH(lbl, num, unit, cls) { return '<div class="cell' + (cls ? ' ' + cls : '') + '"><span class="lbl">' + lbl + '</span><span class="num">' + num + '</span><span class="unit">' + unit + '</span></div>'; }
function renderPages() {
  const w = S.weather, tn = tideNow(), now = Date.now();
  const sun = w && (w.sunset || []).find((t) => t > now), rise = w && (w.sunrise || []).find((t) => t > now);
  const night = sun && rise && rise < sun;
  $('strip2').innerHTML = cellH('WIND', w && w.cur ? Math.round(speedOut(w.cur.spd)) : '–', w && w.cur ? compass16(w.cur.dir) + ' · g' + Math.round(speedOut(w.cur.gust)) : SPEED_LBL[S.settings.speedUnit]) +
    cellH('WAVES', w && w.wave && w.wave.h != null ? (lenUnit() === 'm' ? (w.wave.h * 0.3048).toFixed(1) : w.wave.h.toFixed(1)) : '–', lenUnit()) +
    cellH('TIDE', tn ? (lenUnit() === 'm' ? (tn.v * 0.3048).toFixed(1) : tn.v.toFixed(1)) : '–', tn ? (tn.rising == null ? lenUnit() : (tn.rising ? 'rising' : 'falling') + (tn.next ? ' · ' + (tn.next.type === 'H' ? 'H ' : 'L ') + fmtClock(tn.next.t).replace(/\s/g, '') : '')) : lenUnit()) +
    cellH('GPS', S.fix && S.fix.acc ? '±' + Math.round(ftToLen(S.fix.acc * 3.28084)) : '–', S.fix ? lenUnit() + (S.lastFixAt ? ' · ' + Math.max(0, Math.round((now - S.lastFixAt) / 1000)) + 's' : '') : 'no fix');
  $('strip3').innerHTML = cellH('POSITION', S.fix ? ddm(S.fix.lat, true) + '<br>' + ddm(S.fix.lon, false) : '–', S.fix && S.fix.acc ? '±' + Math.round(ftToLen(S.fix.acc * 3.28084)) + ' ' + lenUnit() : '', 'pos') +
    cellH('TIME', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, ''), new Date().getHours() < 12 ? 'am' : 'pm') +
    cellH(night ? 'SUNRISE' : 'SUNSET', (night ? rise : sun) ? fmtClock(night ? rise : sun).replace(/\s?(AM|PM)/i, '') : '–', (night ? rise : sun) ? (new Date(night ? rise : sun).getHours() < 12 ? 'am' : 'pm') : '');
}
$('pages').addEventListener('scroll', () => {
  const pg = $('pages'), i = Math.round(pg.scrollLeft / Math.max(1, pg.clientWidth));
  $('pageDots').querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === i));
  if (i) renderPages();
}, { passive: true });
function renderStrip() {
  if ($('pages').scrollLeft > 4) renderPages();
  $('sA').closest('.strip').classList.toggle('two', !S.goto);
  $('sSog').textContent = S.fix ? fmtSpeed(S.sog || 0) : '–';
  $('sSogU').textContent = SPEED_LBL[S.settings.speedUnit];
  const moving = (S.sog || 0) > 0.6;
  $('sCog').textContent = moving && S.cog != null ? fmtBrg(S.cog) : '–';
  if (S.goto && S.fix) {
    const [dv, du] = distParts(distNm(S.fix, S.goto));
    $('sAL').textContent = 'TO TARGET'; $('sA').textContent = dv; $('sAU').textContent = du;
    $('sBL').textContent = 'BEARING'; $('sB').textContent = fmtBrg(bearing(S.fix, S.goto)) + '°'; $('sBU').textContent = 'true';
  } else {
    const [dv, du] = distParts(S.trip.dist);
    $('sAL').textContent = 'TRIP'; $('sA').textContent = dv; $('sAU').textContent = du;
    $('sBL').textContent = 'UNDERWAY'; $('sB').textContent = fmtHM(S.trip.moving); $('sBU').textContent = 'h:mm';
  }
}

/* ---------- GPS ---------- */
function setGps(cls, text) { $('gpsDot').className = 'dot ' + cls; $('gpsText').textContent = text; renderStatusWx(); }
$('gpsPill').addEventListener('click', (e) => { if (tideNow()) { e.stopImmediatePropagation(); WX.view = 'tide'; WX.open = true; setTab('weather'); } }, true);
function renderStatusWx() {
  const el = $('statusWx'); if (!el) return;
  const w = S.weather, ob = typeof nearestObs === 'function' ? nearestObs() : null;
  if (ob) el.textContent = ' · ' + compass16(ob.dir) + ' ' + Math.round(speedOut(ob.spd)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ' · ' + agoTxt(ob.t);
  else if (w && w.cur) el.textContent = ' · ' + compass16(w.cur.dir) + ' ' + Math.round(speedOut(w.cur.spd)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ' · ' + agoTxt(w.at);
  else el.textContent = '';
  const tn = typeof tideNow === 'function' ? tideNow() : null;
  if (tn) el.textContent += ' · Tide ' + tideLen(tn.v) + (tn.rising == null ? '' : tn.rising ? ' ↑' : ' ↓');
}
let watchId = null;
const DESK = window.matchMedia('(hover: hover) and (pointer: fine)').matches && !('ontouchstart' in window);
function deskNoGps(msg) { if (DESK) { setGps('desk', 'Planning on this computer · no GPS'); document.documentElement.classList.add('nogps'); return true; } setGps('bad', msg); return false; }
function stopGPS() { if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId); watchId = null; stopSim(); }
function startGPS() {
  stopGPS();
  S.hist = []; S.firstFix = true;
  if (S.settings.sim) { startSim(); return; }
  if (!('geolocation' in navigator)) { deskNoGps('This browser has no GPS'); return; }
  if (!window.isSecureContext) { setGps('bad', 'GPS needs the https address'); return; }
  setGps('', 'Finding GPS…');
  watchId = navigator.geolocation.watchPosition((p) => {
    S.gpsErr = null; document.documentElement.classList.remove('nogps');
    onFix({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp || Date.now() });
  }, (err) => {
    S.gpsErr = err.code;
    if (err.code === 1) { if (!deskNoGps('Location is blocked')) toast('Allow location for this site in your browser settings, then reload.', 5000); }
    else if (err.code === 2) deskNoGps('No GPS signal');
    else if (DESK && !S.fix) deskNoGps('');
    else setGps('fair', 'Waiting for GPS…');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

const jump = { cand: null, n: 0 };
function plausible(f, prev) {
  if (S.settings.sim || !prev) return true;
  const dt = (f.t - prev.t) / 1000; if (!(dt > 0)) return true;
  const dM = distNm(prev, f) * M_PER_NM, noise = (f.acc || 10) + (prev.acc || 10);
  if (dM <= noise) return true;
  const kn = (dM / M_PER_NM) / (dt / 3600), accel = Math.abs(kn - (S.sog || 0)) / dt; // knots per second
  return kn < 70 && (kn < 12 || accel < 2.5);
}
function onFix(f) {
  const prev = S.fix;
  if (!plausible(f, prev)) {
    // A sudden jump: accept it only after three fixes agree on the new spot.
    if (jump.cand && distNm(jump.cand, f) * M_PER_NM < (f.acc || 10) * 2) jump.n++; else { jump.cand = f; jump.n = 1; }
    S.lastFixAt = Date.now(); S.jumps = (S.jumps || 0) + 1;
    if (jump.n < 3) return;
  }
  jump.cand = null; jump.n = 0;
  S.fix = f; S.lastFixAt = Date.now();
  S.hist.push(f); while (S.hist.length > 40 || (S.hist.length && f.t - S.hist[0].t > 90000)) S.hist.shift();
  const ref = (ms) => { for (let i = S.hist.length - 1; i >= 0; i--) if (S.hist[i].t <= f.t - ms) return S.hist[i]; return null; };

  // speed over ground
  let kn = null;
  if (f.speed != null && !Number.isNaN(f.speed) && f.speed >= 0) kn = f.speed * KN_PER_MS;
  else {
    const r = ref(4000);
    if (r) {
      const dM = distNm(r, f) * M_PER_NM, dtH = (f.t - r.t) / 3600000;
      kn = dM < Math.max(f.acc, r.acc) * 0.6 ? 0 : (dM / M_PER_NM) / dtH;
    }
  }
  if (kn != null && (kn > 70 || (kn > 40 && kn > (S.sog || 0) * 3 + 10))) kn = null; // ignore impossible speeds
  if (kn != null && isFinite(kn)) S.sog =S.sog == null ? kn : S.sog * 0.45 + kn * 0.55;
  const moving = (S.sog || 0) > 0.6;

  // course over ground
  let c = null;
  if (moving && f.heading != null && !Number.isNaN(f.heading) && f.heading >= 0) c = f.heading;
  else if (moving) { const r = ref(5000); if (r && distNm(r, f) * M_PER_NM > 8) c = bearing(r, f); }
  if (c != null) S.cog = S.cog == null ? c : smoothAngle(S.cog, c, 0.5);

  // trip log
  if (prev && moving) {
    const d = distNm(prev, f), dt = (f.t - prev.t) / 1000;
    if (d < 0.5 && dt > 0 && dt < 120 && d / (dt / 3600) < 45) { S.trip.dist += d; S.trip.moving += dt; }
  }
  if (moving && S.sog > S.trip.max) S.trip.max = S.sog;
  saveSoon('trip', () => S.trip, 5000);
  saveSoon('lastPos', () => ({ lat: S.fix.lat, lon: S.fix.lon }), 15000);

  recordPoint(f, moving);
  const accTxt = '±' + Math.round(ftToLen(f.acc * 3.28084)) + ' ' + lenUnit();
  if (S.settings.sim) setGps('good', 'Demo GPS');
  else setGps(f.acc <= 12 ? 'good' : f.acc <= 35 ? 'fair' : 'bad', 'GPS ' + accTxt);

  updateBoat(); updateGoto(); checkAnchor(f); updateMob();
  if (S.settings.sim) simAis();
  updateAis(); renderStrip(); renderLive();
  maybeWeather(); maybeTide(); maybeObsWind();
}

function updateBoat() {
  const f = S.fix; if (!f) return;
  const ll = [f.lat, f.lon];
  boatMarker.setLatLng(ll); if (!map.hasLayer(boatMarker)) boatMarker.addTo(map);
  accCircle.setLatLng(ll).setRadius(f.acc || 1); if (!map.hasLayer(accCircle)) accCircle.addTo(map);
  const moving = (S.sog || 0) > 0.6;
  const el = boatMarker.getElement();
  if (el) {
    const g = el.querySelector('#boatRot'), shape = el.querySelector('#boatShape');
    const useBoat = S.settings.iconStyle === 'boat';
    const hdg = useBoat ? (S.cog != null ? S.cog : 0) : (moving && S.cog != null ? S.cog : 0);
    if (g) g.setAttribute('transform', 'rotate(' + hdg + ' 18 18)');
    let d;
    if (!useBoat) d = moving && S.cog != null ? 'M18 3 L28 31 L18 25 L8 31 Z' : 'M18 8 a10 10 0 1 0 0.01 0 Z';
    else if (S.settings.boatType === 'sail') d = 'M18 2 C24.5 9 25.5 21 23.5 34 L12.5 34 C10.5 21 11.5 9 18 2 Z M18 12 L18 30';
    else d = 'M18 2 C25.5 8 27 19 26 34 L10 34 C9 19 10.5 8 18 2 Z M12.5 17 Q18 13 23.5 17';
    if (shape) { shape.setAttribute('d', d); shape.setAttribute('fill', useBoat ? (S.settings.night ? '#E5544A' : '#0E3A5B') : '#0E1F2E'); }
  }
  if (moving && S.cog != null) { const e = destination(f, S.cog, S.sog * 10 / 60); projLine.setLatLngs([ll, [e.lat, e.lon]]); }
  else projLine.setLatLngs([]);
  drawRings();
  if (S.firstFix) { S.firstFix = false; const z = map.getZoom(); map.setView(ll, z >= 11 && z <= 14 ? z : 12); }
  else if (S.follow) map.panTo(ll, { animate: true, duration: 0.5 });
}
function setFollow(on) {
  S.follow = on; $('btnFollow').classList.toggle('attn', !on);
  if (on && S.fix) map.setView([S.fix.lat, S.fix.lon], Math.max(map.getZoom(), 11));
}

/* track recording */
function recordPoint(f, moving) {
  if (!S.rec.on) return;
  const lp = S.rec.pts[S.rec.pts.length - 1];
  const far = !lp || distNm({ lat: lp[0], lon: lp[1] }, f) * M_PER_NM > Math.max(15, f.acc || 0);
  const late = lp && moving && f.t - lp[2] > 60000;
  if (far || late) {
    S.rec.pts.push([+f.lat.toFixed(6), +f.lon.toFixed(6), f.t]);
    if (S.rec.pts.length > 20000) S.rec.pts.shift();
    trackLine.addLatLng([f.lat, f.lon]);
    saveSoon('rec', () => S.rec, 8000);
  }
}
function trackDist(pts) { let d = 0; for (let i = 1; i < pts.length; i++) d += distNm({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }); return d; }

/* ---------- MOB ---------- */
const mobBtn = $('btnMOB');
let mobHold = null;
mobBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault(); audio();
  mobBtn.classList.add('holding');
  mobHold = setTimeout(() => { mobBtn.classList.remove('holding'); triggerMob(); }, 1000);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => mobBtn.addEventListener(ev, () => {
  if (mobHold) { clearTimeout(mobHold); mobHold = null; }
  if (mobBtn.classList.contains('holding')) { mobBtn.classList.remove('holding'); toast('Press and hold MOB for one second to mark a person overboard.'); }
}));
function triggerMob() {
  mobHold = null;
  if (!S.fix) { toast('No GPS position yet'); return; }
  S.mob = { lat: S.fix.lat, lon: S.fix.lon, t: Date.now() };
  store.set('mob', S.mob);
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 600]);
  beep(4);
  setGoto('Man overboard', S.mob.lat, S.mob.lon);
  setFollow(true);
  updateMob();
}
function updateMob() {
  const b = $('mobBanner');
  if (!S.mob) { b.hidden = true; if (map.hasLayer(mobMarker)) map.removeLayer(mobMarker); return; }
  mobMarker.setLatLng([S.mob.lat, S.mob.lon]); if (!map.hasLayer(mobMarker)) mobMarker.addTo(map);
  const secs = Math.floor((Date.now() - S.mob.t) / 1000);
  const el = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  const info = S.fix ? fmtDist(distNm(S.fix, S.mob)) + ' · ' + fmtBrg(bearing(S.fix, S.mob)) + '°T' : '–';
  if (b.hidden || !b.querySelector('[data-act=clearmob]')) {
    b.innerHTML = '<div><div style="font-size:12px;letter-spacing:.08em">MAN OVERBOARD · <span id="mobEl"></span> AGO</div><b class="tnum" id="mobInfo"></b></div><button class="btn small light" data-act="clearmob">Clear</button>';
  }
  b.hidden = false; $('mobEl').textContent = el; $('mobInfo').textContent = info;
}

/* ---------- anchor watch ---------- */
const anchorPos = () => (S.anchor ? { lat: S.anchor.lat, lon: S.anchor.lon } : null);
function suggestRadiusFt(depthFt, rodeFt) {
  const reach = Math.sqrt(Math.max(rodeFt * rodeFt - depthFt * depthFt, 0));
  return { reach, radius: Math.max(50, Math.round((reach + S.settings.gpsToBow + 30) / 5) * 5) };
}
function dropAnchor() {
  if (!S.fix) { toast('No GPS position yet'); return; }
  const f = S.fix, form = S.anchorForm;
  const sug = suggestRadiusFt(form.depth, form.rode);
  let p = { lat: f.lat, lon: f.lon };
  if (S.cog != null && S.settings.gpsToBow > 0) p = destination(p, S.cog, S.settings.gpsToBow / FT_PER_NM);
  S.anchor = { lat: p.lat, lon: p.lon, radiusFt: form.radius || sug.radius, depthFt: form.depth, rodeFt: form.rode, setAt: Date.now(), maxFt: 0, outsideSince: null, swing: [] };
  store.set('anchor', S.anchor);
  S.simDrag = false;
  audio(); wake(); drawAnchor(); renderAnchor(); ripple(p);
  toast('Anchor watch is armed. Keep Tideline open and the phone charging.', 4500);
}
function ripple(p) { // signature moment: one quiet ripple as monitoring arms
  const m = L.marker([p.lat, p.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [10, 10], iconAnchor: [5, 5], html: '<div class="ripple"><i></i><i></i></div>' }) }).addTo(map);
  setTimeout(() => map.removeLayer(m), 2600);
}
function raiseAnchor() { S.anchor = null; store.set('anchor', null); stopAlarm(); S.simDrag = false; drawAnchor(); renderAnchor(); toast('Anchor watch is off'); }
function drawAnchor() {
  anchorLayer.clearLayers(); $('anchorDot').hidden = !S.anchor;
  const a = S.anchor; if (!a) return;
  anchorLayer.addLayer(L.circle([a.lat, a.lon], { radius: a.radiusFt * 0.3048, color: C.teal, weight: 2, dashArray: '6 6', fillOpacity: 0.06, interactive: false }));
  swingLine = null; drawAnchorSwing();
  const m = L.marker([a.lat, a.lon], {
    draggable: true, zIndexOffset: 900,
    icon: L.divIcon({ className: 'anchor-icon', iconSize: [30, 30], iconAnchor: [15, 15], html: '<svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13" fill="#0B1824" stroke="#E8952B" stroke-width="2.5"/><path d="M15 8v13M10 17a5 5 0 0010 0M12 11h6" stroke="#E8952B" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' }),
  });
  m.on('dragend', () => { const ll = m.getLatLng(); a.lat = ll.lat; a.lon = ll.lng; a.maxFt = 0; store.set('anchor', a); drawAnchor(); toast('Anchor position moved'); });
  anchorLayer.addLayer(m);
}
function checkAnchor(f) {
  const a = S.anchor; if (!a) return;
  const pill = $('anStatus'); if (pill) { pill.classList.remove('beat'); void pill.offsetWidth; pill.classList.add('beat'); } // heartbeat: a fix arrived
  const dFt = distNm(a, f) * FT_PER_NM, accFt = (f.acc || 0) * 3.28084;
  a.lastFt = dFt; a.accFt = accFt;
  if (accFt < a.radiusFt * 0.5 && dFt <= a.radiusFt) a.maxFt = Math.max(a.maxFt, dFt);
  const ls = a.swing[a.swing.length - 1];
  if (!ls || distNm({ lat: ls[0], lon: ls[1] }, f) * FT_PER_NM > 10) { a.swing.push([+f.lat.toFixed(6), +f.lon.toFixed(6)]); if (a.swing.length > 400) a.swing.shift(); drawAnchorSwing(); }
  const outside = dFt > a.radiusFt, definite = dFt - accFt > a.radiusFt;
  if (outside) {
    if (!a.outsideSince) a.outsideSince = f.t;
    const held = f.t - a.outsideSince;
    if (!(DESK && !S.settings.sim) && ((held >= 15000 && accFt < a.radiusFt) || (definite && held >= 5000))) {
      fireAlarm('drag', 'Anchor drag', 'You are ' + fmtLen(dFt) + ' from the anchor. Your circle is ' + fmtLen(a.radiusFt) + '.');
    }
  } else a.outsideSince = null;
  saveSoon('anchor', () => S.anchor, 10000);
}
let swingLine = null;
function drawAnchorSwing() {
  if (!S.anchor) return;
  if (swingLine && anchorLayer.hasLayer(swingLine)) swingLine.setLatLngs(S.anchor.swing);
  else { swingLine = L.polyline(S.anchor.swing, { color: C.teal, weight: 2, opacity: 0.7, interactive: false }); anchorLayer.addLayer(swingLine); }
}
function anchorStatus() {
  const a = S.anchor; if (!a) return null;
  if (S.alarmOn && S.alarmKind === 'drag') return ['bad', 'Dragging'];
  if (S.lastFixAt && Date.now() - S.lastFixAt > 30000) return ['bad', 'No GPS'];
  if (a.lastFt != null && a.lastFt > a.radiusFt) return ['warn', 'Outside circle'];
  if (a.accFt != null && a.accFt > a.radiusFt * 0.5) return ['warn', 'GPS weak'];
  return ['good', 'Inside circle'];
}
function windShiftNote() {
  const w = S.weather; if (!w || !w.hours || !w.cur) return null;
  const now = Date.now();
  const next = w.hours.filter((h) => h.t > now && h.t < now + 12 * 3600000);
  const shift = next.find((h) => angDiff(h.dir, w.cur.dir) >= 45 && h.spd >= 6);
  if (!shift) return null;
  return 'Wind turns ' + compass16(shift.dir) + ' ' + Math.round(speedOut(shift.spd)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ' around ' + fmtClock(shift.t) + '. Your boat will swing to the other side of the anchor.';
}

/* ---------- alarm & sound ---------- */
let actx = null, sirenTimer = null, sirenOsc = null, sirenGain = null;
function audio() {
  try {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
    if (actx && actx.state === 'suspended') actx.resume();
  } catch (e) { /* no audio */ }
  return actx;
}
let soundUnlocked = false;
function unlockSound() {
  if (soundUnlocked) return; soundUnlocked = true;
  try { // a silent <audio> clip moves iOS into playback mode so alarms play even with the ringer switch off
    const n = 8000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), w = (o, s2) => [...s2].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    const el = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))); el.setAttribute('playsinline', ''); el.loop = true; el.volume = 0.01;
    el.play().catch(() => { soundUnlocked = false; });
    window.__tlKeepAlive = el;
  } catch (e) { soundUnlocked = false; }
  try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch (e) { /* no speech */ }
}
document.addEventListener('pointerdown', () => { audio(); unlockSound(); wake(); }, { passive: true });
function beep(n = 1) {
  const ctx = audio(); if (!ctx) return;
  for (let i = 0; i < n; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.28;
    o.type = 'square'; o.frequency.value = 1046; g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.22);
  }
}
function startSiren() {
  const ctx = audio(); if (!ctx || sirenOsc) return;
  sirenOsc = ctx.createOscillator(); sirenGain = ctx.createGain();
  sirenOsc.type = 'square'; sirenOsc.frequency.value = 780; sirenGain.gain.value = 0.5;
  sirenOsc.connect(sirenGain).connect(ctx.destination); sirenOsc.start();
  let hi = false;
  sirenTimer = setInterval(() => { hi = !hi; if (sirenOsc) sirenOsc.frequency.setValueAtTime(hi ? 1180 : 780, ctx.currentTime); if (navigator.vibrate) navigator.vibrate(350); }, 420);
}
function stopSiren() {
  clearInterval(sirenTimer); sirenTimer = null;
  if (sirenOsc) { try { sirenOsc.stop(); } catch (e) { /* already stopped */ } sirenOsc.disconnect(); sirenOsc = null; }
}
function nativeNotify(title, body) { // in the native app, also post a system notification
  try {
    const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
    if (LN) LN.requestPermissions().then(() => LN.schedule({ notifications: [{ id: Date.now() % 2000000000, title, body }] }));
  } catch (e) { /* web: no system notifications */ }
}
function fireAlarm(kind, title, text) {
  if (S.alarmOn) { $('alarmText').textContent = text; return; }
  if (Date.now() < S.snoozeUntil) return;
  S.alarmOn = true; S.alarmKind = kind; nativeNotify(title, text);
  $('alarmTitle').textContent = title; $('alarmText').textContent = text; $('alarm').hidden = false;
  startSiren();
}
let testTimer = null;
function testSiren() {
  if (S.alarmOn) return;
  clearTimeout(testTimer); startSiren();
  toast('This is the alarm. Turn the volume up and the ringer on so it wakes you.', 3500);
  testTimer = setTimeout(stopSiren, 3000);
}
function stopAlarm() { S.alarmOn = false; S.alarmKind = null; $('alarm').hidden = true; stopSiren(); }
$('alarmSilence').addEventListener('click', () => { stopAlarm(); S.snoozeUntil = Date.now() + 120000; renderAnchorLive(); toast('Silenced for 2 minutes. The watch is still on.', 3000); });
$('alarmStop').addEventListener('click', () => { stopAlarm(); S.snoozeUntil = 0; if (S.anchor) raiseAnchor(); if (S.mob && S.alarmKind === 'mob') { /* MOB stays until cleared on its banner */ } });

/* screen wake lock */
let wakeLock = null;
async function wake() {
  if (!S.settings.keepAwake) { if (wakeLock) { try { await wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; } return; }
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    wake();
    if (S.anchor && S.hiddenAt && Date.now() - S.hiddenAt > 20000) toast('Anchor watch was paused while Tideline was in the background.', 5000);
  } else S.hiddenAt = Date.now();
});

/* ---------- weather (Open-Meteo) ---------- */
let wxBusy = false;
function refPos() { if (S.fix) return S.fix; const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; }
async function maybeWeather(force) {
  const f = refPos(); if (!f || wxBusy) return;
  const w = S.weather;
  if (!force && w && Date.now() - w.at < 30 * 60000 && distNm(w.pos, f) < 5) return;
  wxBusy = true;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + f.lat.toFixed(3) + '&longitude=' + f.lon.toFixed(3) +
      '&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation' +
      '&daily=sunrise,sunset&wind_speed_unit=kn&temperature_unit=fahrenheit&timezone=auto&forecast_days=2';
    const r = await fetch(url); if (!r.ok) throw new Error('weather ' + r.status);
    const j = await r.json();
    const off = (j.utc_offset_seconds || 0) * 1000;
    const tt = (s) => Date.parse(s + 'Z') - off;
    S.weather = {
      at: Date.now(), pos: { lat: f.lat, lon: f.lon },
      cur: { spd: j.current.wind_speed_10m, dir: j.current.wind_direction_10m, gust: j.current.wind_gusts_10m, temp: j.current.temperature_2m },
      hours: j.hourly.time.map((t, i) => ({ t: tt(t), spd: j.hourly.wind_speed_10m[i], dir: j.hourly.wind_direction_10m[i], gust: j.hourly.wind_gusts_10m[i], temp: j.hourly.temperature_2m ? j.hourly.temperature_2m[i] : null, rain: j.hourly.precipitation ? j.hourly.precipitation[i] : null })),
      sunrise: j.daily.sunrise.map(tt), sunset: j.daily.sunset.map(tt),
    };
    try {
      const m = await fetch('https://marine-api.open-meteo.com/v1/marine?latitude=' + f.lat.toFixed(3) + '&longitude=' + f.lon.toFixed(3) +
        '&current=wave_height,wave_direction,wave_period,sea_surface_temperature&hourly=wave_height&length_unit=imperial&timezone=GMT&forecast_days=2').then((r) => r.json());
      if (m.current && m.current.wave_height != null) S.weather.wave = { h: m.current.wave_height, dir: m.current.wave_direction, per: m.current.wave_period };
      if (m.current && m.current.sea_surface_temperature != null) { const c = m.current.sea_surface_temperature, u = (m.current_units || {}).sea_surface_temperature || '°C'; S.weather.sst = /F/.test(u) ? c : c * 9 / 5 + 32; }
      if (m.hourly) S.weather.waveHours = m.hourly.time.map((t, i) => ({ t: Date.parse(t + 'Z'), h: m.hourly.wave_height[i] }));
    } catch (e) { /* waves are optional */ }
    store.set('weather', S.weather);
  } catch (e) { /* offline: keep the last forecast */ }
  wxBusy = false; renderChips(); renderLive();
}

/* ---------- tides (NOAA CO-OPS) ---------- */
let tideBusy = false;
const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
async function maybeTide(force) {
  const f = refPos(); if (!f || tideBusy) return;
  const t = S.tide;
  if (!force && t && Date.now() - t.at < 3 * 3600000 && t.pos && distNm(t.pos, f) < 10) return;
  tideBusy = true;
  try {
    let st = store.get('stations', null);
    if (!st) {
      const r = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions');
      const j = await r.json();
      st = j.stations.map((s) => [s.id, s.name, +s.lat, +s.lng]);
      store.set('stations', st);
    }
    let best = null, bd = Infinity;
    st.forEach((s) => { const d = distNm(f, { lat: s[2], lon: s[3] }); if (d < bd) { bd = d; best = s; } });
    if (!best || bd > 30) { S.tide = { at: Date.now(), pos: { lat: f.lat, lon: f.lon }, none: true }; }
    else {
      const start = new Date(Date.now() - 6 * 3600000);
      const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=Tideline&begin_date=' + ymd(start) +
        '&range=54&datum=MLLW&station=' + best[0] + '&time_zone=lst_ldt&units=english&format=json&interval=';
      const [h1, h2] = await Promise.all([fetch(base + 'hilo').then((r) => r.json()), fetch(base + 'h').then((r) => r.json())]);
      const pt = (s) => new Date(s.replace(' ', 'T')).getTime();
      let mhw = null;
      try {
        const dj = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/' + best[0] + '/datums.json?units=english').then((r) => r.json());
        const dv = (n) => { const d = (dj.datums || []).find((x) => x.name === n); return d ? +d.value : null; };
        if (dv('MHW') != null && dv('MLLW') != null) mhw = dv('MHW') - dv('MLLW');
      } catch (e) { /* datums not published for this station */ }
      S.tide = {
        at: Date.now(), pos: { lat: f.lat, lon: f.lon }, station: { id: best[0], name: best[1], dist: bd }, mhw,
        hilo: (h1.predictions || []).map((p) => ({ t: pt(p.t), v: +p.v, type: p.type })),
        hourly: (h2.predictions || []).map((p) => ({ t: pt(p.t), v: +p.v })),
      };
    }
    store.set('tide', S.tide);
  } catch (e) { /* offline: keep the last tide table */ }
  tideBusy = false; renderChips(); renderLive();
}
function tideNow() {
  const t = S.tide; if (!t || t.none || !t.hourly || t.hourly.length < 2) return null;
  const now = Date.now(), h = t.hourly;
  let v = null;
  for (let i = 1; i < h.length; i++) if (h[i].t >= now) { const a = h[i - 1], b = h[i]; v = a.v + (b.v - a.v) * ((now - a.t) / (b.t - a.t)); break; }
  const next = (t.hilo || []).find((p) => p.t > now);
  return v == null ? null : { v, rising: next ? next.type === 'H' : null, next };
}
const tideLen = (ft) => (lenUnit() === 'm' ? (ft * 0.3048).toFixed(2) + ' m' : ft.toFixed(1) + ' ft');


/* ---------- weather on the chart: radar, wind, waves ---------- */
const RADAR_URL = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';
const radarLayer = window.TL_DEMO ? L.imageOverlay(window.TL_DEMO.radar, window.TL_DEMO.bounds, { opacity: 0.6, zIndex: 5, attribution: 'Sample radar' }) : L.tileLayer(RADAR_URL + '?t={t}', { t: () => Math.floor(Date.now() / 300000), opacity: 0.6, maxNativeZoom: 10, maxZoom: 19, zIndex: 5, attribution: 'Radar: NWS NEXRAD via Iowa Environmental Mesonet' });
const wxGrid = L.layerGroup();
const WX = { grid: null, busy: false, hour: 0, timer: null, seq: 0 };
const WIND_COL = [[5, '#3F7FB0'], [10, '#1E9E8F'], [15, '#6BBF3B'], [20, '#E8952B'], [25, '#D64545'], [Infinity, '#8E3BB5']];
const WAVE_COL = [[1, '#3F7FB0'], [2, '#1E9E8F'], [3, '#E8952B'], [5, '#D64545'], [Infinity, '#8E3BB5']];
const colFor = (tbl, v) => tbl.find((c) => v < c[0])[1];
const waveLen = (ft) => (lenUnit() === 'm' ? (ft * 0.3048).toFixed(1) + ' m' : ft.toFixed(1) + ' ft');
if (!S.settings.wxL) { const w = S.settings.wx; S.settings.wxL = { wind: w === 'wind', waves: w === 'waves', rain: w === 'radar' }; }
// every launch starts with a clean chart: weather layers are turned on by choice, never left over from last time
S.settings.wxL = { wind: false, waves: false, rain: false };
const wxOn = (k) => !!(S.settings.wxL && S.settings.wxL[k]);
const wxAny = () => wxOn('wind') || wxOn('waves') || wxOn('rain');
function setWxL(k, on) { S.settings.wxL = Object.assign({}, S.settings.wxL, { [k]: on }); saveSettings(); applyWx(); }
function wxTitle() { return [wxOn('wind') && 'Wind', wxOn('waves') && 'Waves', wxOn('rain') && 'Rain'].filter(Boolean).join(' · '); }
function applyWx() {
  if (typeof drawObs === 'function') drawObs();
  if (wxOn('rain')) { if (!map.hasLayer(radarLayer)) radarLayer.addTo(map); if (radarLayer.redraw) radarLayer.redraw(); } else if (map.hasLayer(radarLayer)) map.removeLayer(radarLayer);
  if (wxOn('wind') || wxOn('waves')) { if (!map.hasLayer(wxGrid)) wxGrid.addTo(map); loadGrids(); } else { wxGrid.clearLayers(); if (map.hasLayer(wxGrid)) map.removeLayer(wxGrid); }
  renderWxBar();
}
function gridPoints() {
  const b = map.getBounds(), sz = map.getSize();
  const cols = Math.max(3, Math.min(9, Math.round(sz.x / 130))), rows = Math.max(4, Math.min(11, Math.round(sz.y / 130)));
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const lat = b.getNorth() - (b.getNorth() - b.getSouth()) * (r + 0.5) / rows, lon = b.getWest() + (b.getEast() - b.getWest()) * (c + 0.5) / cols;
    pts.push({ lat: +lat.toFixed(3), lon: +lon.toFixed(3) });
  }
  return pts;
}
WX.grids = {};
function loadGrids(force) { ['wind', 'waves'].forEach((k) => { if (wxOn(k)) loadGrid(k, force); }); drawGrid(); }
async function loadGrid(kind, force) {
  const pts = gridPoints(), key = pts.map((p) => p.lat + ',' + p.lon).join('|'), g = WX.grids[kind];
  if (!force && g && g.key === key && Date.now() - g.at < 30 * 60000) return;
  const seq = (WX.seqs = WX.seqs || {})[kind] = ((WX.seqs || {})[kind] || 0) + 1;
  const ll = '?latitude=' + pts.map((p) => p.lat).join(',') + '&longitude=' + pts.map((p) => p.lon).join(',');
  const url = kind === 'wind'
    ? 'https://api.open-meteo.com/v1/forecast' + ll + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=GMT&forecast_days=3'
    : 'https://marine-api.open-meteo.com/v1/marine' + ll + '&hourly=wave_height,wave_direction,wave_period&length_unit=imperial&timezone=GMT&forecast_days=3';
  WX.busy = true; renderWxBar();
  try {
    const j = await fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    if (seq !== WX.seqs[kind]) return;
    const arr = Array.isArray(j) ? j : [j];
    WX.grids[kind] = { kind, key, at: Date.now(), pts: arr.map((d, i) => {
      const h = d.hourly || {}, times = (h.time || []).map((t) => Date.parse(t + 'Z'));
      return kind === 'wind'
        ? { lat: pts[i].lat, lon: pts[i].lon, t: times, a: h.wind_speed_10m, b: h.wind_direction_10m, c: h.wind_gusts_10m }
        : { lat: pts[i].lat, lon: pts[i].lon, t: times, a: h.wave_height, b: h.wave_direction, c: h.wave_period };
    }) };
    WX.err = false;
  } catch (e) { WX.err = true; }
  WX.busy = false; drawGrid(); renderWxBar();
}
function gridIndex(times) {
  const want = Date.now() + WX.hour * 3600000;
  let best = 0; times.forEach((t, i) => { if (Math.abs(t - want) < Math.abs(times[best] - want)) best = i; });
  return best;
}
function drawGrid() {
  wxGrid.clearLayers();
  const gw = wxOn('wind') && WX.grids.wind, gv = wxOn('waves') && WX.grids.waves; if (!gw && !gv) return;
  const at = {};
  [gw, gv].forEach((g) => { if (!g) return; g.pts.forEach((p) => { if (!p.t.length) return; const k = p.lat + ',' + p.lon, i = gridIndex(p.t); (at[k] = at[k] || { lat: p.lat, lon: p.lon })[g.kind] = { v: p.a && p.a[i], dir: p.b && p.b[i], g: p.c && p.c[i] }; }); });
  Object.values(at).forEach((q) => {
    const w = q.wind && q.wind.v != null && q.wind.dir != null ? q.wind : null, v = q.waves && q.waves.v != null ? q.waves : null;
    if (!w && !v) return;
    let html;
    if (w) {
      const col = colFor(WIND_COL, w.v);
      html = '<div class="wx-pt" style="--c:' + col + '"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><g transform="rotate(' + ((w.dir + 180) % 360) + ' 12 12)"><path d="M12 2v18M12 2l-5.5 6.5M12 2l5.5 6.5" /></g></svg><b>' + Math.round(speedOut(w.v)) + (w.g != null ? '<small>' + Math.round(speedOut(w.g)) + '</small>' : '') + '</b>' +
        (v ? '<span class="wx-wave" style="--w:' + colFor(WAVE_COL, v.v) + '">' + waveLen(v.v).replace(' ', '&#8202;') + '</span>' : '') + '</div>';
    } else {
      html = '<div class="wv-pt" style="--c:' + colFor(WAVE_COL, v.v) + '" title="Waves ' + waveLen(v.v) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1M2 16c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/></svg><b>' + waveLen(v.v).replace(' ', '&#8202;') + '</b></div>';
    }
    wxGrid.addLayer(L.marker([q.lat, q.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [56, w && v ? 62 : 46], iconAnchor: [28, 23], html }) }));
  });
}
function hourLabel(h) {
  if (!h) return 'Now';
  // future hours are labelled as forecast so tomorrow's wind never reads as today's
  const d = new Date(Date.now() + h * 3600000);
  const day = d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ';
  return 'Forecast ' + day + d.toLocaleTimeString([], { hour: 'numeric' }) + ' (+' + h + 'h)';
}

/* air and water temperature: model values, labelled as such; NOAA station water temperature when one is close */
function tempTxt(f) { return f == null ? '–' : (S.settings.speedUnit === 'kmh' || S.settings.speedUnit === 'ms' ? Math.round((f - 32) * 5 / 9) + '°C' : Math.round(f) + '°F'); }
function tempsLine(t) {
  const w = S.weather; if (!w) return '';
  const air = t && WX.hour ? seriesAt(w.hours, t, 'temp') : w.cur && w.cur.temp;
  const water = S.waterObs && Date.now() - S.waterObs.t < 3 * 3600000 ? { v: S.waterObs.f, src: 'measured ' + S.waterObs.name } : w.sst != null ? { v: w.sst, src: 'model' } : null;
  return '<div class="tl-temps"><span>Air <b>' + tempTxt(air) + '</b></span>' + (water ? '<span>Water <b>' + tempTxt(water.v) + '</b> <small>' + esc(water.src) + '</small></span>' : '') + '</div>';
}
async function maybeWaterTemp() {
  const f = S.fix; if (!f || (S.waterObs && Date.now() - S.waterObs.at < 30 * 60000)) return;
  try {
    let st = store.get('wtStations', null);
    if (!st) { const j = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=watertemp').then((r) => r.json()); st = (j.stations || []).map((x) => [x.id, x.name, +x.lat, +x.lng]); store.set('wtStations', st); }
    const near = st.map((x) => ({ x, d: distNm(f, { lat: x[2], lon: x[3] }) })).sort((a, b) => a.d - b.d)[0];
    if (!near || near.d > 15) return;
    const j = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature&date=latest&station=' + near.x[0] + '&units=english&time_zone=gmt&application=Tideline&format=json').then((r) => r.json());
    const d = j.data && j.data[0]; if (!d || d.v === '') return;
    S.waterObs = { f: +d.v, t: Date.parse(d.t.replace(' ', 'T') + 'Z'), name: near.x[1].replace(/,.*$/, ''), at: Date.now() };
  } catch (e) { /* optional */ }
}
setInterval(maybeWaterTemp, 10 * 60000); setTimeout(maybeWaterTemp, 8000);
/* Orca-style timeline on the Weather tab: one row on a phone, tap to open the hours */
function seriesAt(arr, t, key) { if (!arr || !arr.length) return null; let best = arr[0]; arr.forEach((x) => { if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x; }); return Math.abs(best.t - t) < 2 * 3600000 ? best[key] : null; }
function tideAtT(t) { const h = S.tide && S.tide.hourly; if (!h || h.length < 2) return null; for (let i = 1; i < h.length; i++) if (h[i].t >= t) { const a = h[i - 1], b = h[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t)); } return null; }
function tideTable() {
  const ev = (S.tide.hilo || []).filter((p) => p.t > Date.now() - 3 * 3600000).slice(0, 6); if (!ev.length) return '';
  let day = '';
  return '<div class="tl-table">' + ev.map((p) => { const d = new Date(p.t).toLocaleDateString([], { weekday: 'short' }), show = d !== day; day = d; return '<div class="' + (p.t < Date.now() ? 'past' : '') + '"><em>' + (show ? d : '') + '</em><b>' + (p.type === 'H' ? 'High' : 'Low') + '</b><span class="tnum">' + fmtClock(p.t) + '</span><span class="tnum">' + tideLen(p.v) + '</span></div>'; }).join('') + '</div>' +
    (S.tide.station ? '<a class="tl-link" href="https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=' + esc(S.tide.station.id) + '" target="_blank" rel="noopener">Full NOAA tide tables for ' + esc(S.tide.station.name.replace(/,.*$/, '')) + ' ›</a>' : '');
}
function tideCurve(sel) {
  const t0 = Date.now() - 2 * 3600000, t1 = Date.now() + 46 * 3600000, h = (S.tide.hourly || []).filter((x) => x.t >= t0 && x.t <= t1);
  if (h.length < 3) return '<p class="sub">No tide table yet.</p>';
  const lo = Math.min(...h.map((x) => x.v)) - 0.3, hi = Math.max(...h.map((x) => x.v)) + 0.3, W = 960, H = 92;
  const X = (t) => ((t - t0) / (t1 - t0)) * W, Y = (v) => H - 14 - ((v - lo) / (hi - lo)) * (H - 30);
  const path = h.map((x, i) => (i ? 'L' : 'M') + X(x.t).toFixed(1) + ' ' + Y(x.v).toFixed(1)).join('');
  const st = Date.now() + sel * 3600000, sv = tideAtT(st);
  const lab = (S.tide.hilo || []).filter((p) => p.t > t0 && p.t < t1).map((p) => '<text x="' + X(p.t).toFixed(0) + '" y="' + (p.type === 'H' ? Y(p.v) - 6 : Y(p.v) + 14).toFixed(0) + '" text-anchor="middle">' + (p.type === 'H' ? 'High ' : 'Low ') + fmtClock(p.t) + '</text>').join('');
  return '<svg class="tl-tide" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Tide curve"><path d="' + path + ' L' + W + ' ' + H + ' L0 ' + H + 'Z" class="fill"/><path d="' + path + '" class="line"/>' +
    '<line x1="' + X(Date.now()) + '" x2="' + X(Date.now()) + '" y1="0" y2="' + H + '" class="now"/>' + (sv != null ? '<circle cx="' + X(st) + '" cy="' + Y(sv) + '" r="6" class="sel"/>' : '') + lab + '</svg>';
}
function renderTimeline(el) {
  const v = WX.view || 'wind', w = S.weather, wide = isWide(), open = wide || WX.open;
  const tabs = [['wind', 'Wind'], ['waves', 'Waves'], ['rain', 'Rain'], ['tide', 'Tide']];
  const t = Date.now() + WX.hour * 3600000;
  let now = '';
  if (v === 'wind') { const s = seriesAt(w && w.hours, t, 'spd'), d = seriesAt(w && w.hours, t, 'dir'), g = seriesAt(w && w.hours, t, 'gust'); now = s != null ? compass16(d) + ' ' + Math.round(speedOut(s)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ', gust ' + Math.round(speedOut(g)) : 'No forecast yet'; }
  if (v === 'waves') { const h = seriesAt(w && w.waveHours, t, 'h'); now = h != null ? 'Waves ' + waveLen(h) : 'No wave forecast here'; }
  if (v === 'rain') now = 'Live radar · updates every 5 min';
  if (v === 'tide') { const tv = tideAtT(t); now = tv != null ? 'Tide ' + tideLen(tv) + ' above MLLW' + (S.tide.station ? ' · ' + esc(S.tide.station.name.replace(/,.*$/, '')) : '') : 'No tide station nearby'; }
  const chips = [['wind', 'Wind'], ['waves', 'Waves'], ['rain', 'Rain']].map(([k, l]) => '<button type="button" data-tlv="' + k + '" class="' + (wxOn(k) ? 'on' : '') + (v === k ? ' focus' : '') + '" aria-pressed="' + wxOn(k) + '">' + l + '</button>').join('') +
    '<button type="button" data-tlv="tide" class="' + (v === 'tide' ? 'on focus' : '') + '">Tide</button>';
  const parts = [];
  { const s2 = seriesAt(w && w.hours, t, 'spd'), d = seriesAt(w && w.hours, t, 'dir'), g = seriesAt(w && w.hours, t, 'gust'); if (s2 != null) parts.push(compass16(d) + ' ' + Math.round(speedOut(s2)) + (g != null ? ' g' + Math.round(speedOut(g)) : '') + ' ' + SPEED_LBL[S.settings.speedUnit]); }
  { const wv = seriesAt(w && w.waveHours, t, 'h'); if (wv != null) parts.push(waveLen(wv)); }
  { const tv = tideAtT(t); if (tv != null) parts.push('tide ' + tideLen(tv)); }
  if (w) { const air = WX.hour ? seriesAt(w.hours, t, 'temp') : w.cur && w.cur.temp, water = S.waterObs ? S.waterObs.f : w.sst; if (air != null) parts.push('air ' + tempTxt(air)); if (water != null) parts.push('water ' + tempTxt(water)); }
  let h = '<button type="button" class="tl-x" data-tlx aria-label="Close weather">&times;</button>' + (wide ? '' : '<button type="button" class="tl-grab" data-tlopen aria-label="' + (open ? 'Show less' : 'Show the hours') + '"><i></i></button>') +
    '<div class="tl-chips">' + chips + '</div>' +
    '<div class="tl-sum"><b>' + (WX.hour ? hourLabel(WX.hour).replace('Forecast ', '') : 'Now') + '</b> ' + esc(parts.join(' · ') || 'Waiting for forecast') + '</div>';
  if (open) {
    if (v === 'wind' || v === 'waves') {
      const cells = [];
      for (let k = 0; k <= 47; k++) {
        const tt = Date.now() + k * 3600000, val = v === 'wind' ? seriesAt(w && w.hours, tt, 'spd') : seriesAt(w && w.waveHours, tt, 'h');
        const dir = v === 'wind' ? seriesAt(w && w.hours, tt, 'dir') : null, d = new Date(tt);
        const day = d.getHours() === 0 ? '<em>' + d.toLocaleDateString([], { weekday: 'short' }) + '</em>' : '';
        cells.push('<button type="button" class="tl-h' + (k === WX.hour ? ' on' : '') + '" data-tlh="' + k + '">' + day + '<small>' + (k ? d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s?(AM|PM)/i, (m) => m.trim()[0].toLowerCase()) : 'Now') + '</small>' +
          '<i style="--c:' + (val == null ? 'var(--line)' : colFor(v === 'wind' ? WIND_COL : WAVE_COL, val)) + '">' + (dir != null ? windArrow(dir) : '') + '</i><b class="tnum">' + (val == null ? '–' : v === 'wind' ? Math.round(speedOut(val)) : (lenUnit() === 'm' ? (val * 0.3048).toFixed(1) : val.toFixed(1))) + '</b></button>');
      }
      h += '<div class="tl-hours" id="tlHours">' + cells.join('') + '</div>';
      if (false) h += '<div class="wx-legend">' + (v === 'wind' ? WIND_COL : WAVE_COL).map((c, i) => '<span><i style="background:' + c[1] + '"></i>' + (v === 'wind' ? ['<5', '5', '10', '15', '20', '25+'] : ['<1', '1', '2', '3', '5+'])[i] + '</span>').join('') + '<span class="u">' + (v === 'wind' ? SPEED_LBL[S.settings.speedUnit] : lenUnit()) + ' · model forecast' + (w ? ', fetched ' + agoTxt(w.at) : '') + '</span></div>';
    } else if (v === 'tide') {
      h += S.tide && !S.tide.none ? tideCurve(WX.hour) + '<input type="range" id="tlTide" min="0" max="46" value="' + WX.hour + '" aria-label="Time"><p class="hint" style="margin:2px 0 0">NOAA predictions' + (S.tide.station ? ' for ' + esc(S.tide.station.name) + ', ' + fmtDist(S.tide.station.dist) + ' away' : '') + '. Wind can push water above or below these.</p>' + tideTable() : '<p class="sub">No NOAA tide station within 30 nm.</p>';
    } else {
      h += '<div class="tl-sum" style="opacity:.8">Live radar on the chart, updated every 5 minutes.</div>';
    }
  }
  el.className = 'wxbar tl' + (WX.hour > 0 && v !== 'rain' ? ' future' : '') + (open ? ' open' : '');
  el.innerHTML = h;
  const hs = $('tlHours'), on = hs && hs.querySelector('.on'); if (on && hs.scrollWidth > hs.clientWidth) hs.scrollLeft = Math.max(0, on.offsetLeft - hs.clientWidth / 2 + on.offsetWidth / 2);
}
document.addEventListener('click', (e) => {
  const tv = e.target.closest('[data-tlv]');
  if (tv) {
    const k = tv.dataset.tlv;
    if (k === 'tide') { WX.view = WX.view === 'tide' ? (['wind', 'waves', 'rain'].find(wxOn) || 'wind') : 'tide'; if (WX.view === 'tide') WX.open = true; renderWxBar(); return; }
    const on = !wxOn(k); S.settings.wxL = Object.assign({}, S.settings.wxL, { [k]: on });
    if (on) WX.view = k; else if (WX.view === k) WX.view = ['wind', 'waves', 'rain'].find(wxOn) || 'wind';
    applyWx(); return;
  }
  const tl = e.target.closest('[data-tll]');
  if (tl) { const k = tl.dataset.tll; S.settings.wxL = Object.assign({}, S.settings.wxL, { [k]: !wxOn(k) }); applyWx(); return; }
  const th = e.target.closest('[data-tlh]');
  if (th) { WX.hour = +th.dataset.tlh; drawGrid(); renderWxBar(); return; }
  if (e.target.closest('[data-tlopen]')) { WX.open = !WX.open; renderWxBar(); }
  if (e.target.closest('[data-tlx]')) { setTab('chart'); }
});
function tideSet(h) {
  WX.hour = Math.max(0, Math.min(46, Math.round(h * 4) / 4));
  const svg = document.querySelector('.tl-tide'); if (svg) svg.outerHTML = tideCurve(WX.hour);
  const sl = $('tlTide'); if (sl) sl.value = WX.hour;
  const t = Date.now() + WX.hour * 3600000, tv = tideAtT(t), n = document.querySelector('.tl-now'), nx = (S.tide.hilo || []).find((p) => p.t > t), rising = nx ? nx.type === 'H' : null;
  if (n) { n.querySelector('b').textContent = WX.hour ? new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'Now'; n.querySelector('span').textContent = tv != null ? tideLen(tv) + (rising == null ? '' : rising ? ' rising' : ' falling') + (nx ? ' · ' + (nx.type === 'H' ? 'high ' : 'low ') + fmtClock(nx.t) : '') : ''; }
}
document.addEventListener('pointerdown', (e) => {
  const svg = e.target.closest('.tl-tide'); if (!svg) return; e.preventDefault();
  const move = (ev) => { const r = document.querySelector('.tl-tide').getBoundingClientRect(); const fx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); tideSet(fx * 48 - 2); };
  move(e); const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
});
document.addEventListener('input', (e) => { if (e.target.id === 'tlTide') tideSet(+e.target.value); });

/* forecast scrubber: time bubble above the thumb, hour and day steps, and a colour strip of what is coming */
const RAIN_COL = [[0.1, 'transparent'], [1, '#9CCBF0'], [4, '#3F8FD8'], [10, '#1F4FB0'], [Infinity, '#7B2FBF']];
function hourSeverity(k) {
  const w = S.weather, t = Date.now() + k * 3600000, cols = [];
  const lvl = (tbl, v) => tbl.findIndex((c) => v < c[0]);
  if (wxOn('wind')) { const g = seriesAt(w && w.hours, t, 'gust'), sp = seriesAt(w && w.hours, t, 'spd'); const v = Math.max(sp || 0, (g || 0) * 0.8); if (sp != null) cols.push([lvl(WIND_COL, v), colFor(WIND_COL, v)]); }
  if (wxOn('waves')) { const v = seriesAt(w && w.waveHours, t, 'h'); if (v != null) cols.push([lvl(WAVE_COL, v) + 0.5, colFor(WAVE_COL, v)]); }
  if (wxOn('rain')) { const v = seriesAt(w && w.hours, t, 'rain'); if (v != null && v >= 0.1) cols.push([lvl(RAIN_COL, v) + 1.5, colFor(RAIN_COL, v)]); }
  if (!cols.length) return 'var(--line)';
  return cols.sort((a, b) => b[0] - a[0])[0][1];
}
function forecastScrubber() {
  const max = 47, k = Math.min(max, WX.hour), strip = [];
  for (let i = 0; i <= max; i++) strip.push('<i style="background:' + hourSeverity(i) + '"></i>');
  const marks = []; for (let i = 0; i <= max; i++) { const d = new Date(Date.now() + i * 3600000); if (d.getHours() === 0) marks.push('<em style="left:' + (i / max * 100).toFixed(1) + '%">' + d.toLocaleDateString([], { weekday: 'short' }) + '</em>'); }
  return '<div class="scrub"><button type="button" class="sc-b" data-wxstep="-24" aria-label="Back a day">«</button><button type="button" class="sc-b" data-wxstep="-1" aria-label="Back an hour">‹</button>' +
    '<div class="sc-mid"><div class="sc-bub" id="wxBub" style="left:' + (k / max * 100).toFixed(1) + '%">' + scrubLabel(k) + '</div><div class="sc-strip" aria-hidden="true">' + strip.join('') + '</div>' + marks.join('') +
    '<input type="range" id="wxHour" min="0" max="' + max + '" step="1" value="' + k + '" aria-label="Forecast time"></div>' +
    '<button type="button" class="sc-b" data-wxstep="1" aria-label="Forward an hour">›</button><button type="button" class="sc-b" data-wxstep="24" aria-label="Forward a day">»</button></div>';
}
function scrubLabel(k) { if (!k) return 'Now'; const d = new Date(Date.now() + k * 3600000); return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: 'numeric' }); }
function setWxHour(k) {
  WX.hour = Math.max(0, Math.min(47, k)); const r = $('wxHour'); if (r) r.value = WX.hour;
  const b = $('wxBub'); if (b) { b.textContent = scrubLabel(WX.hour); b.style.left = (WX.hour / 47 * 100).toFixed(1) + '%'; }
  $('wxBar').classList.toggle('future', WX.hour > 0); drawGrid();
}
document.addEventListener('click', (e) => { const st = e.target.closest('[data-wxstep]'); if (st) setWxHour(WX.hour + +st.dataset.wxstep); });
function renderWxBar() {
  const el = $('wxBar'), k = S.settings.wx; if (!el) return;
  if (S.tab === 'weather') { el.hidden = false; renderTimeline(el); return; }
  el.className = 'wxbar';
  if (!wxAny()) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const grids = ['wind', 'waves'].filter(wxOn).map((k) => WX.grids[k]).filter(Boolean), age = grids.length ? Math.round((Date.now() - Math.min(...grids.map((g) => g.at))) / 60000) : null;
  const status = WX.busy ? 'Loading…' : grids.length ? 'Model forecast · ' + (age < 1 ? 'just now' : age + ' min ago') : wxOn('rain') && !wxOn('wind') && !wxOn('waves') ? 'Live radar · every 5 min' : WX.err ? 'No forecast: check signal' : '';
  const timed = wxOn('wind') || wxOn('waves') || wxOn('rain');
  let h = '<div class="wx-mini" title="' + esc(status) + '"><b>' + wxTitle() + '</b><span class="wx-st">' + esc(status) + '</span><button type="button" class="x" data-wx="none" aria-label="Hide weather on the chart">&times;</button></div>';
  if (timed) h += forecastScrubber();
  el.classList.toggle('future', WX.hour > 0);
  el.innerHTML = h;
}
document.addEventListener('input', (e) => {
  if (e.target.id !== 'wxHour') return;
  setWxHour(+e.target.value);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-wx]'); if (!b) return;
  if (b.dataset.wx === 'none') { S.settings.wxL = { wind: false, waves: false, rain: false }; saveSettings(); applyWx(); }
});
map.on('moveend', () => { if (!S.fix) { clearTimeout(S.noFixT); S.noFixT = setTimeout(() => { maybeWeather(); maybeTide(); }, 1500); }
  if (wxOn('wind') || wxOn('waves')) { clearTimeout(WX.timer); WX.timer = setTimeout(() => loadGrids(), 700); } });
setInterval(() => { if (wxOn('rain') && radarLayer.redraw) radarLayer.redraw(); if (wxOn('wind') || wxOn('waves')) loadGrids(); }, 300000);


/* ---------- observed wind: NOAA CO-OPS weather stations (free, public domain) ---------- */
S.obs = store.get('obs', []);
const obsLayer = L.layerGroup().addTo(map);
let obsBusy = false, obsAt = 0;
async function maybeObsWind(force) {
  const f = refPos(); if (!f || obsBusy || (!force && Date.now() - obsAt < 6 * 60000)) return;
  obsBusy = true; obsAt = Date.now();
  try {
    let st = store.get('metStations', null);
    if (!st) {
      const j = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=met').then((r) => r.json());
      st = j.stations.map((x) => [x.id, x.name, +x.lat, +x.lng]); store.set('metStations', st);
    }
    const near = st.map((x) => ({ id: x[0], name: x[1], lat: x[2], lon: x[3], d: distNm(f, { lat: x[2], lon: x[3] }) })).filter((x) => x.d < 30).sort((a, b) => a.d - b.d).slice(0, 4);
    const got = await Promise.all(near.map(async (x) => {
      try {
        const j = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=' + x.id + '&product=wind&units=english&time_zone=gmt&format=json&application=Tideline').then((r) => r.json());
        const d = j.data && j.data[0]; if (!d || d.s === '' || d.d === '') return null;
        return Object.assign(x, { spd: +d.s, dir: +d.d, gust: d.g === '' ? null : +d.g, t: Date.parse(d.t.replace(' ', 'T') + 'Z') });
      } catch (e) { return null; }
    }));
    S.obs = got.filter(Boolean); store.set('obs', S.obs);
  } catch (e) { /* offline: keep last readings */ }
  obsBusy = false; drawObs(); renderChips(); renderLive();
}
const agoTxt = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 90 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
function nearestObs() {
  if (!S.obs.length) return null; const rp = refPos();
  const o = S.obs.filter((x) => Date.now() - x.t < 45 * 60000).map((x) => Object.assign(x, { d: distNm(rp, x) })).sort((a, b) => a.d - b.d)[0];
  return o && o.d < 15 ? o : null;
}
function drawObs() {
  obsLayer.clearLayers();
  if (map.getZoom() < 9 || !(S.settings.chips || wxOn('wind'))) return; // station wind pins only when you ask for wind on the chart
  S.obs.forEach((o) => {
    const old = Date.now() - o.t > 45 * 60000;
    const html = '<div class="obs-pin' + (old ? ' old' : '') + '"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(' + ((o.dir + 180) % 360) + ' 12 12)"><path d="M12 3v16M12 3l-5 6M12 3l5 6"/></g></svg><b>' + compass16(o.dir) + ' ' + Math.round(speedOut(o.spd)) + '</b>' + (o.gust ? '<span>g' + Math.round(speedOut(o.gust)) + '</span>' : '') + '</div>';
    const m = L.marker([o.lat, o.lon], { zIndexOffset: 500, keyboard: false, icon: L.divIcon({ className: '', iconSize: [90, 26], iconAnchor: [45, 13], html }) });
    m.on('click', () => toast('Measured wind at NOAA ' + o.name + ': ' + compass16(o.dir) + ' ' + Math.round(speedOut(o.spd)) + ' ' + SPEED_LBL[S.settings.speedUnit] + (o.gust ? ', gusts ' + Math.round(speedOut(o.gust)) : '') + ', ' + agoTxt(o.t) + '.', 4500));
    obsLayer.addLayer(m);
  });
}
map.on('zoomend', drawObs);

/* ---------- top chips ---------- */
function windArrow(dir) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(' + ((dir + 180) % 360) + ' 12 12)"><path d="M12 3v16M12 3l-5 6M12 3l5 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></g></svg>';
}
function placeFabs() {
  const ch = document.querySelector('.chips'), fc = $('fabs'); if (!ch || !fc) return;
  const r = ch.getBoundingClientRect();
  fc.style.top = isWide() && r.height ? Math.max(170, r.bottom + 10) + 'px' : '';
}
function renderChips() {
  const w = S.weather, wc = $('windChip');
  if (w && w.cur) {
    wc.hidden = false;
    const ob = nearestObs();
    const cap = ob ? 'Measured ' + esc(ob.name.replace(/,.*$/, '')) + ' ' + compass16(ob.dir) + ' ' + Math.round(speedOut(ob.spd)) + ' · ' + agoTxt(ob.t) : 'Forecast · ' + agoTxt(w.at);
    wc.innerHTML = '<span class="c-main">' + windArrow(w.cur.dir) + '<b>' + compass16(w.cur.dir) + ' ' + Math.round(speedOut(w.cur.spd)) + '</b>' + SPEED_LBL[S.settings.speedUnit] + ' · gust ' + Math.round(speedOut(w.cur.gust)) + '</span><small>' + cap + '</small>';
  } else wc.hidden = true;
  const wv = $('waveChip');
  if (w && w.wave && w.wave.h != null) { wv.hidden = false; wv.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10c3-3 6-3 9 0s6 3 9 0M3 16c3-3 6-3 9 0s6 3 9 0" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>Waves <b>' + waveLen(w.wave.h) + '</b>'; wv.innerHTML = '<span class="c-main">' + wv.innerHTML + '</span>'; }
  else wv.hidden = true;
  const old = w && Date.now() - w.at > 3 * 3600000;
  wc.classList.toggle('stale', !!old); wv.classList.toggle('stale', !!old);
  if (old) wc.title = 'Forecast is ' + Math.round((Date.now() - w.at) / 3600000) + ' hours old';
  const tn = tideNow(), tc = $('tideChip');
  if (tn) { tc.hidden = false; tc.className = 'chip light'; tc.innerHTML = '<span class="c-main"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8M8.5 6.5L12 3l3.5 3.5M3 16c3-2.5 6-2.5 9 0s6 2.5 9 0M3 20.5c3-2.5 6-2.5 9 0s6 2.5 9 0" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>Tide ' + (tn.rising == null ? '' : tn.rising ? '↑ ' : '↓ ') + '<b>' + tideLen(tn.v) + '</b></span>' + (S.tide.station ? '<small>' + esc(S.tide.station.name.replace(/,.*$/, '')) + ' · ' + fmtDist(S.tide.station.dist) + ' away</small>' : ''); }
  else tc.hidden = true;
  placeFabs(); renderStatusWx();
}

/* ---------- panels ---------- */
const app = $('app');
const wideMQ = window.matchMedia('(min-width: 900px)');
const isWide = () => wideMQ.matches;
const PANELS = { dash: 'panelDash', anchor: 'panelAnchor', log: 'panelLog', settings: 'panelSettings', search: 'panelSearch', boat: 'panelBoat', nav: 'panelNav', menu: 'panelMenu', safety: 'panelSafety', side: 'panelSide' };
const TAB_GROUP = { chart: 'chart', search: 'chart', nav: 'nav', log: 'nav', weather: 'weather', anchor: 'anchor', menu: 'menu', boat: 'menu', dash: 'menu', settings: 'menu', safety: 'menu' };
function visiblePanel() {
  if (S.tab !== 'chart' && S.tab !== 'weather') return S.tab;
  return isWide() ? 'side' : null;
}
function setTab(t) {
  if (S.settings.cockpit && $('cockpit') && !$('cockpit').hidden) setCockpit(false);
  const was = S.tab; S.tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === (TAB_GROUP[t] || t)));
  if (t === 'weather' && was !== 'weather') { S.wxPrev = Object.assign({}, S.settings.wxL); WX.view = WX.view || 'wind'; const want = store.get('wxTabL', { wind: true, waves: false, rain: false }); S.settings.wxL = Object.assign({}, want); applyWx(); }
  if (t !== 'weather' && was === 'weather') { store.set('wxTabL', S.settings.wxL); S.settings.wxL = S.wxPrev || { wind: false, waves: false, rain: false }; WX.hour = 0; applyWx(); }
  app.classList.toggle('wide', isWide());
  const vis = visiblePanel();
  Object.entries(PANELS).forEach(([k, id]) => { $(id).hidden = k !== vis; });
  if (!isWide() && t !== 'chart') closeSheet();
  if (vis === 'dash') renderDash();
  if (vis === 'anchor') renderAnchor();
  if (vis === 'log') renderLog();
  if (vis === 'settings') renderSettings();
  if (vis === 'boat') renderBoat();
  if (vis === 'nav') renderNav();
  if (vis === 'side') renderSide();
  if (vis === 'menu') renderMenu();
  if (vis === 'safety') renderSafety();
  setTimeout(() => map.invalidateSize(), 60);
}
document.querySelector('.tabbar').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
wideMQ.addEventListener ? wideMQ.addEventListener('change', () => setTab(S.tab)) : wideMQ.addListener(() => setTab(S.tab));
function renderLive() {
  const v = visiblePanel();
  if (v === 'dash') renderDashBody();
  if (v === 'side') renderSide();
  if (v === 'anchor') renderAnchorLive();
  if (v === 'log') renderRecLive();
}



/* iPad side column: the four things a skipper glances at, each with its source and age */
function ageS(t) { if (!t) return ''; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? s + 's ago' : agoTxt(t); }
function openSideCustom() {
  const cur = S.settings.sideSlots || ['speed', 'course', 'wind', 'auto'];
  const opts = CK_OPTS.filter(([v]) => v !== 'chart' && v !== 'off').concat([['auto', 'Tide, or destination when navigating']]);
  openSheet('<h3>Gauges beside the chart</h3><div class="sub">Pick up to four. They show in this order.</div>' + [0, 1, 2, 3].map((i) => '<div class="field"><label>Gauge ' + (i + 1) + '</label><select data-sidepick="' + i + '"><option value="off">None</option>' + opts.map(([v, l]) => '<option value="' + v + '"' + (cur[i] === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>').join('') + '<div class="row-btns"><button class="btn primary" data-act="close">Done</button></div>');
}
sheet.addEventListener('change', (e) => { const sp = e.target.closest('[data-sidepick]'); if (!sp) return; const cur = (S.settings.sideSlots || ['speed', 'course', 'wind', 'auto']).slice(); while (cur.length < 4) cur.push('off'); cur[+sp.dataset.sidepick] = sp.value; S.settings.sideSlots = cur.filter((x) => x !== 'off'); if (!S.settings.sideSlots.length) S.settings.sideSlots = ['speed']; saveSettings(); renderSide(); });
function renderSide() {
  const p = $('panelSide'); if (!p) return;
  if (S.settings.sideStyle !== 'text') {
    const ids = (S.settings.sideSlots || ['speed', 'course', 'wind', 'auto']).filter((x) => x !== 'chart' && x !== 'off');
    let h = '';
    if (S.goto && S.fix) { const d = distNm(S.fix, S.goto), mv = (S.sog || 0) > 0.6, hrs = mv ? d / S.sog : NaN; h += '<button type="button" class="sd sd-dest" data-sact="nav"><small>Next destination</small><b>' + esc(S.goto.name) + '</b><span class="tnum">' + fmtDist(d) + (isFinite(hrs) ? ' · ETA ' + fmtClock(Date.now() + hrs * 3600000) : '') + '</span></button>'; }
    h += '<div class="side-g" data-n="' + ids.length + '">' + ids.map((id) => '<div class="sg">' + ckGauge(id) + '</div>').join('') + '</div>';
    h += '<div class="side-btns"><button type="button" class="btn small" data-sact="dash">Full screen</button><button type="button" class="btn small" data-sact="sidecust">Choose gauges</button><button type="button" class="btn small" data-sact="sidetext">Plain numbers</button></div>';
    p.innerHTML = h; p.classList.add('gmode'); return;
  }
  p.classList.remove('gmode');
  const f = S.fix, g = S.goto, w = S.weather, ob = nearestObs(), src = S.settings.sim ? 'Demo GPS' : 'GPS';
  const moving = (S.sog || 0) > 0.6;
  let h = '';
  if (g && f) { const d = distNm(f, g), hrs = moving ? d / S.sog : NaN; h += '<button type="button" class="sd sd-dest" data-sact="nav"><small>Next destination</small><b>' + esc(g.name) + '</b><span class="tnum">' + fmtDist(d) + '</span><em class="tnum">' + (isFinite(hrs) ? 'ETA ' + fmtClock(Date.now() + hrs * 3600000) + ' (' + fmtDur(hrs) + ')' : fmtBrg(bearing(f, g)) + '°T') + '</em></button>'; }
  h += '<div class="sd"><small>Speed (SOG)</small><div class="sd-v tnum">' + (f ? fmtSpeed(S.sog || 0) : '–') + '<i>' + SPEED_LBL[S.settings.speedUnit] + '</i></div><em>' + (f ? src + ' · ' + ageS(S.lastFixAt) : 'Waiting for GPS') + '</em></div>';
  h += '<div class="sd"><small>Course (COG)</small><div class="sd-v tnum">' + (moving && S.cog != null ? fmtBrg(S.cog) + '°' : '–') + '<i>T</i></div><em>' + (f ? (moving ? src + ' · ' + ageS(S.lastFixAt) : 'Shown once moving') : '') + '</em></div>';
  const wd = ob ? { dir: ob.dir, spd: ob.spd, gust: ob.gust, cap: 'Measured · ' + esc(ob.name.replace(/,.*$/, '')) + ' · ' + agoTxt(ob.t) } : w && w.cur ? { dir: w.cur.dir, spd: w.cur.spd, gust: w.cur.gust, cap: 'Forecast · ' + agoTxt(w.at) } : null;
  h += '<div class="sd"><small>Wind</small><div class="sd-v tnum">' + (wd ? compass16(wd.dir) + ' ' + Math.round(speedOut(wd.spd)) : '–') + '<i>' + SPEED_LBL[S.settings.speedUnit] + '</i></div><em>' + (wd ? (wd.gust != null ? 'Gust ' + Math.round(speedOut(wd.gust)) + ' · ' : '') + wd.cap : 'No wind data yet') + '</em></div>';
  const tn = tideNow();
  if (tn) h += '<button type="button" class="sd sd-small" data-sact="tide"><small>Tide</small><b class="tnum">' + tideLen(tn.v) + ' ' + (tn.rising == null ? '' : tn.rising ? 'rising' : 'falling') + '</b>' + tideCurve(0) + '<em>' + (tn.next ? (tn.next.type === 'H' ? 'High ' : 'Low ') + fmtClock(tn.next.t) + ' · ' : '') + 'NOAA · tap to slide through the day</em></button>';
  h += '<button type="button" class="btn sd-more" data-sact="dash">More instruments</button><button type="button" class="btn sd-more" data-sact="sidegauge">Show as gauges</button>';
  p.innerHTML = h;
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-sact]'); if (!b) return; if (b.dataset.sact === 'dash') setCockpit(true); if (b.dataset.sact === 'nav') setTab('nav'); if (b.dataset.sact === 'sidetext') { S.settings.sideStyle = 'text'; saveSettings(); renderSide(); } if (b.dataset.sact === 'sidegauge') { S.settings.sideStyle = 'gauge'; saveSettings(); renderSide(); } if (b.dataset.sact === 'sidecust') openSideCustom(); if (b.dataset.sact === 'tide') { WX.view = 'tide'; WX.open = true; setTab('weather'); } });


/* Captain's resources: official sources, linked rather than copied (Argo-style), so they are always current */
function openResources() {
  const f = S.fix || map.getCenter(), lat = (f.lat).toFixed(4), lon = (f.lon != null ? f.lon : f.lng).toFixed(4), st = S.tide && S.tide.station;
  const L2 = (href, title, sub) => '<a class="res" href="' + href + '" target="_blank" rel="noopener"><b>' + title + '</b><span>' + sub + '</span></a>';
  const h = '<h3>Captain\'s resources</h3><div class="sub">Official sources. They open in your browser, so they are always the current edition.</div>' +
    '<div class="mo-h">Before you go</div>' +
    L2('https://forecast.weather.gov/MapClick.php?lat=' + lat + '&lon=' + lon, 'NWS forecast for this spot', 'Marine point forecast, advisories and warnings') +
    L2('https://www.weather.gov/marine/', 'NWS marine forecasts', 'Coastal waters zones, small craft advisories') +
    (st ? L2('https://tidesandcurrents.noaa.gov/stationhome.html?id=' + encodeURIComponent(st.id), 'NOAA tides and currents: ' + esc(st.name.replace(/,.*$/, '')), 'Predictions, observed water level, datums') : L2('https://tidesandcurrents.noaa.gov/', 'NOAA tides and currents', 'Predictions and observed water levels')) +
    '<div class="mo-h">Pilotage and notices</div>' +
    L2('https://nauticalcharts.noaa.gov/publications/coast-pilot/index.html', 'U.S. Coast Pilot', 'Approaches, anchorages, local knowledge. Chesapeake Bay is Coast Pilot 3') +
    L2('https://www.navcen.uscg.gov/local-notices-to-mariners-by-cg-district', 'Local Notices to Mariners', 'Buoys moved, lights out, dredging, closures. Chesapeake is District 5') +
    L2('https://www.ecfr.gov/current/title-33/chapter-I/subchapter-J/part-117', 'Drawbridge rules (33 CFR 117)', 'Opening schedules and restrictions, bridge by bridge') +
    L2('https://www.navcen.uscg.gov/navigation-rules-amalgamated', 'Navigation Rules (COLREGS and Inland)', 'The official text') +
    '<p class="hint">Tideline links to these rather than copying them, so you never read an out-of-date notice.</p>' +
    '<div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>';
  setTab('chart'); openSheet(h);
}

/* ---------- destination suggestions as you type ---------- */
function lev(a, b) { if (Math.abs(a.length - b.length) > 2) return 9; const d = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } } return d[b.length]; }
function fuzzyScore(q, name) { // 0 = no match; tolerant of typos like "severance" for "severn"
  const qs = q.toLowerCase().split(/\s+/).filter(Boolean), ns = String(name || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean); if (!qs.length || !ns.length) return 0;
  let sc = 0; for (const w of qs) { let best = 0; for (const n of ns) { if (n.startsWith(w)) best = Math.max(best, 3); else if (w.length >= 4 && (n.startsWith(w.slice(0, 4)) || lev(w, n.slice(0, w.length)) <= (w.length > 6 ? 2 : 1))) best = Math.max(best, 2); } if (!best && w.length > 2) return 0; sc += best; }
  return sc;
}
const sugCache = new Map();
async function suggestPlaces(q, center) {
  const c = center || searchCenter(), out = [];
  S.waypoints.forEach((w) => { const sc = fuzzyScore(q, w.name); if (sc) out.push({ name: w.name, sub: 'Your waypoint', lat: w.lat, lon: w.lon, type: 'place', score: sc + 2, wp: w }); });
  (searchResults || []).forEach((p) => { const sc = fuzzyScore(q, p.name); if (sc) out.push({ name: p.name, sub: PLACE_TYPES[p.type].label, lat: p.lat, lon: p.lon, type: p.type, score: sc + 1, place: p }); });
  const key = q.toLowerCase() + '|' + c.lat.toFixed(1) + ',' + c.lon.toFixed(1);
  let ph = sugCache.get(key);
  if (!ph) {
    try {
      const j = await fetch('https://photon.komoot.io/api/?limit=8&q=' + encodeURIComponent(q) + '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lon.toFixed(3)).then((r) => r.json());
      ph = (j.features || []).map((f) => { const pr = f.properties || {}, [lon, lat] = f.geometry.coordinates;
        const marine = /marina|harbour|slipway|boat|fuel|sailing|yacht/.test((pr.osm_value || '') + ' ' + (pr.name || '').toLowerCase());
        return { name: pr.name || pr.street || 'Unnamed place', sub: [pr.osm_value && pr.osm_value.replace(/_/g, ' '), pr.city || pr.county, pr.state].filter(Boolean).join(' · '), lat, lon, type: /marina/.test(pr.osm_value || '') ? 'marina' : 'place', score: marine ? 2.5 : 1.5 }; });
      sugCache.set(key, ph);
    } catch (e) { ph = []; }
  }
  ph.forEach((x) => { if (!out.some((o) => o.name === x.name && distNm(o, x) < 0.2)) out.push(Object.assign({}, x)); });
  out.forEach((o) => { o.d = distNm(c, o); });
  return out.sort((a, b) => b.score - a.score || a.d - b.d).slice(0, 8);
}
function placeSugHtml(list, attr) {
  if (!list.length) return '<div class="sug-empty">No matches yet. Try a shorter name, or pick a spot on the chart.</div>';
  return list.map((o, i) => '<button type="button" class="sug" ' + attr + '="' + i + '"><b>' + esc(o.name) + '</b><span>' + esc(o.sub || '') + '</span><em class="tnum">' + fmtDist(o.d) + '</em></button>').join('');
}

/* ---------- multi-stop trip planner: type each stop, see legs, save, start ---------- */
S.trip2 = store.get('tripDraft', { name: '', stops: [] });
function saveTripDraft() { store.set('tripDraft', S.trip2); }
function tripLegs(stops) {
  const spd = navSpeed(), legs = []; let tot = 0;
  for (let i = 1; i < stops.length; i++) { const d = distNm(stops[i - 1], stops[i]); legs.push({ a: stops[i - 1], b: stops[i], d, hrs: d / spd, brg: bearing(stops[i - 1], stops[i]) }); tot += d; }
  return { legs, tot, hrs: tot / spd, fuel: S.settings.navMode !== 'sail' && S.boat.gph ? (tot / spd) * S.boat.gph : null };
}
function tripCard() {
  const st = S.trip2.stops, L2 = tripLegs(st);
  let h = '<div class="card"><h4>Plan a trip</h4><p class="hint" style="margin:-4px 0 8px">Add stops in order, like Rock Hall, St. Michaels, Solomons, Annapolis, back to Rock Hall.</p>';
  h += '<div class="tp-stops">' + st.map((p, i) => '<div class="tp-stop"><span class="tp-n">' + (i + 1) + '</span><div class="tp-main"><b>' + esc(p.name) + '</b>' + (i ? '<span class="tnum">' + fmtDist(L2.legs[i - 1].d) + ' · ' + fmtDur(L2.legs[i - 1].hrs).replace(' min', 'm') + ' · ' + fmtBrg(L2.legs[i - 1].brg) + '°T</span>' : '<span>Start</span>') + '</div>' +
    '<button type="button" class="tp-b" data-tpup="' + i + '" aria-label="Move up"' + (i ? '' : ' disabled') + '>↑</button><button type="button" class="tp-b" data-tpx="' + i + '" aria-label="Remove">×</button></div>').join('') + '</div>';
  h += '<div class="tp-add"><input id="tpQ" type="search" autocomplete="off" placeholder="' + (st.length ? 'Add the next stop…' : 'Where do you start? (or tap My boat)') + '"><div id="tpSugs" class="sugs" hidden></div>' +
    '<div class="nf-quick" style="margin-left:0">' + (S.fix && !st.length ? '<button type="button" class="btn small" data-act="tpboat">My boat</button>' : '') + (st.length > 1 ? '<button type="button" class="btn small" data-act="tpback">Back to start</button>' : '') + '</div></div>';
  if (st.length > 1) {
    h += '<div class="tp-sum tnum"><b>' + fmtDist(L2.tot) + '</b> · ' + fmtDur(L2.hrs) + ' at ' + fmtSpeed(navSpeed()) + ' ' + SPEED_LBL[S.settings.speedUnit] + (L2.fuel != null ? ' · about ' + (Math.round(L2.fuel * 10) / 10) + ' gal' : '') + '</div>' +
      '<p class="hint" style="margin:4px 0 8px">Straight lines between stops can cross land or shoals. Tap Edit on chart to add turning points, and check the chart.</p>' +
      '<div class="field"><label for="tpName">Trip name</label><input id="tpName" value="' + esc(S.trip2.name) + '" placeholder="' + esc(st[0].name + ' to ' + st[st.length - 1].name) + '"></div>' +
      '<div class="row-btns"><button class="btn primary" data-act="tpstart">Start</button><button class="btn" data-act="tpedit">Edit on chart</button><button class="btn" data-act="tpsave">Save trip</button><button class="btn ghost" data-act="tpclear">Clear</button></div>';
  }
  return h + '</div>';
}
let tpSugList = [], tpT = null, tpSeq = 0;
$('panelNav').addEventListener('input', (e) => {
  if (e.target.id === 'tpName') { S.trip2.name = e.target.value; saveTripDraft(); return; }
  if (e.target.id !== 'tpQ') return;
  const q = e.target.value.trim(), box = $('tpSugs'); clearTimeout(tpT);
  if (q.length < 2) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<div class="sug-empty">Searching…</div>';
  const last = S.trip2.stops[S.trip2.stops.length - 1];
  tpT = setTimeout(async () => { const seq = ++tpSeq; const list = await suggestPlaces(q, last || S.fix || searchCenter()); if (seq !== tpSeq || !$('tpSugs')) return; tpSugList = list; $('tpSugs').innerHTML = placeSugHtml(list, 'data-tpsug'); }, 250);
});
$('panelNav').addEventListener('click', (e) => {
  const g = e.target.closest('[data-tpsug]'); if (g) { const o = tpSugList[+g.dataset.tpsug]; S.trip2.stops.push({ name: o.name.replace(/\s*\(sample spot\)/, ''), lat: o.lat, lon: o.lon }); saveTripDraft(); renderNav(); setTimeout(() => { const q = $('tpQ'); if (q) q.focus(); }, 30); return; }
  const up = e.target.closest('[data-tpup]'); if (up) { const i = +up.dataset.tpup, a = S.trip2.stops; if (i > 0) { [a[i - 1], a[i]] = [a[i], a[i - 1]]; saveTripDraft(); renderNav(); } return; }
  const x = e.target.closest('[data-tpx]'); if (x) { S.trip2.stops.splice(+x.dataset.tpx, 1); saveTripDraft(); renderNav(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return; const act = b.dataset.act, st = S.trip2.stops;
  if (act === 'tpboat' && S.fix) { st.push({ name: 'My boat', lat: S.fix.lat, lon: S.fix.lon }); saveTripDraft(); renderNav(); }
  if (act === 'tpback' && st.length) { st.push(Object.assign({}, st[0])); saveTripDraft(); renderNav(); }
  if (act === 'tpclear') { if (!armed(b, 'Tap again to clear')) return; S.trip2 = { name: '', stops: [] }; saveTripDraft(); renderNav(); }
  const name = S.trip2.name || (st.length ? st[0].name + ' to ' + st[st.length - 1].name : 'Trip');
  if (act === 'tpsave' && st.length > 1) { S.routes.push({ id: Date.now(), name, pts: st.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })) }); store.set('routes', S.routes); toast('Saved “' + name + '” in My trips'); renderNav(); }
  if (act === 'tpedit' && st.length > 1) { RT.pts = st.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })); store.set('routeDraft', RT.pts); routeMode(true); map.fitBounds(L.latLngBounds(RT.pts.map((q) => [q.lat, q.lon])).pad(0.15)); }
  if (act === 'tpstart' && st.length > 1) { const pts = st.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })); let i = 0; if (S.fix && distNm(S.fix, pts[0]) < 0.3) i = 1; RT.pts = pts; drawRoute(); routeLeg(pts, i); }
}, true);

/* ---------- trip photos and replay: match camera-roll photos to a recorded track by time ---------- */
const PDB = { db: null };
function pdb() { return PDB.db || (PDB.db = new Promise((res, rej) => { const r = indexedDB.open('tideline-photos', 1); r.onupgradeneeded = () => r.result.createObjectStore('p', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); }
async function pPut(o) { const db = await pdb(); return new Promise((res, rej) => { const tx = db.transaction('p', 'readwrite'); tx.objectStore('p').put(o); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function pAll(trackId) { const db = await pdb(); return new Promise((res) => { const out = [], c = db.transaction('p').objectStore('p').openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) { res(out.sort((a, b) => a.t - b.t)); return; } if (cur.value.track === trackId) out.push(cur.value); cur.continue(); }; c.onerror = () => res(out); }); }
async function exifInfo(file) { // DateTimeOriginal and GPS from a JPEG, if the phone kept them
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer(), v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return {};
    let o = 2;
    while (o < v.byteLength - 4) {
      const mk = v.getUint16(o), len = v.getUint16(o + 2);
      if (mk === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) {
        const t0 = o + 10, le = v.getUint16(t0) === 0x4949, u16 = (x) => v.getUint16(x, le), u32 = (x) => v.getUint32(x, le);
        const ifd = (start) => { const n = u16(start), m = {}; for (let i = 0; i < n; i++) { const e = start + 2 + i * 12; m[u16(e)] = { type: u16(e + 2), count: u32(e + 4), off: e + 8 }; } return m; };
        const str = (en) => { const p = en.count > 4 ? t0 + u32(en.off) : en.off; let s2 = ''; for (let i = 0; i < en.count - 1; i++) s2 += String.fromCharCode(v.getUint8(p + i)); return s2; };
        const rat3 = (en) => { const p = t0 + u32(en.off); const r = (k) => u32(p + k * 8) / u32(p + k * 8 + 4); return r(0) + r(1) / 60 + r(2) / 3600; };
        const i0 = ifd(t0 + u32(t0 + 4)), out = {};
        if (i0[0x8769]) { const ex = ifd(t0 + u32(i0[0x8769].off)); if (ex[0x9003]) { const m2 = str(ex[0x9003]).match(/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/); if (m2) out.t = new Date(+m2[1], m2[2] - 1, +m2[3], +m2[4], +m2[5], +m2[6]).getTime(); } }
        if (i0[0x8825]) { const gp = ifd(t0 + u32(i0[0x8825].off)); if (gp[2] && gp[4]) { out.lat = rat3(gp[2]) * (gp[1] && str(gp[1]) === 'S' ? -1 : 1); out.lon = rat3(gp[4]) * (gp[3] && str(gp[3]) === 'W' ? -1 : 1); } }
        return out;
      }
      if ((mk & 0xFF00) !== 0xFF00) break; o += 2 + len;
    }
  } catch (e) { /* no metadata */ }
  return {};
}
function trackPosAt(t, time) {
  const p = t.pts; if (!p.length || time < p[0][2] - 30 * 60000 || time > p[p.length - 1][2] + 30 * 60000) return null;
  if (time <= p[0][2]) return { lat: p[0][0], lon: p[0][1] };
  for (let i = 1; i < p.length; i++) if (p[i][2] >= time) { const a = p[i - 1], b = p[i], k = (time - a[2]) / Math.max(1, b[2] - a[2]); return { lat: a[0] + (b[0] - a[0]) * k, lon: a[1] + (b[1] - a[1]) * k }; }
  const l = p[p.length - 1]; return { lat: l[0], lon: l[1] };
}
async function addTripPhotos(t, files) {
  let placed = 0, skipped = 0;
  for (const f of files) {
    const ex = await exifInfo(f), time = ex.t || f.lastModified;
    const pos = ex.lat != null ? { lat: ex.lat, lon: ex.lon } : trackPosAt(t, time);
    if (!pos) { skipped++; continue; }
    let thumb; try { thumb = await resizePhoto(f); } catch (e) { skipped++; continue; }
    await pPut({ id: t.id + '-' + time + '-' + Math.random().toString(36).slice(2, 6), track: t.id, t: time, lat: pos.lat, lon: pos.lon, img: thumb });
    placed++;
  }
  toast(placed + ' photo' + (placed === 1 ? '' : 's') + ' added to this trip' + (skipped ? '. ' + skipped + ' weren\'t taken during it.' : '.'), 4500);
  showTrip(t);
}
const tripPhotoLayer = L.layerGroup().addTo(map);
let replay = null;
async function showTrip(t, play) {
  shownTrack.setLatLngs(t.pts.map((p) => [p[0], p[1]])); tripPhotoLayer.clearLayers();
  setTab('chart'); setFollow(false); map.fitBounds(shownTrack.getBounds().pad(0.15));
  const ph = await pAll(t.id);
  ph.forEach((x) => { const mk = L.marker([x.lat, x.lon], { icon: L.divIcon({ className: 'ph-pin', iconSize: [40, 40], iconAnchor: [20, 20], html: '<img src="' + x.img + '" alt="">' }), zIndexOffset: 900 }); mk.on('click', () => openPhoto(t, x)); tripPhotoLayer.addLayer(mk); });
  openSheet('<h3>' + esc(t.name) + '</h3><div class="sub tnum">' + fmtDist(t.dist) + ' · ' + fmtDur((t.end - t.start) / 3600000) + ' · ' + ph.length + ' photo' + (ph.length === 1 ? '' : 's') + '</div>' +
    '<div class="row-btns"><button class="btn primary" data-act="trplay" data-id="' + t.id + '"' + (t.pts.length < 2 ? ' disabled' : '') + '>Replay trip</button><label class="btn">Add photos<input type="file" accept="image/*" multiple data-trphotos="' + t.id + '" hidden></label><button class="btn ghost" data-act="close">Close</button></div>' +
    '<p class="hint">Pick the photos you took on this trip. Tideline places each one where the boat was at that moment, using the time the photo was taken.</p>');
  if (play) playTrip(t, ph);
}
function openPhoto(t, x) { openSheet('<img class="ph-big" src="' + x.img + '" alt=""><div class="sub tnum">' + new Date(x.t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + '</div><div class="row-btns"><button class="btn" data-act="trback" data-id="' + t.id + '">Back to trip</button><button class="btn ghost" data-act="close">Close</button></div>'); }
function playTrip(t, ph) {
  if (replay) cancelAnimationFrame(replay.raf);
  const p = t.pts, t0 = p[0][2], t1 = p[p.length - 1][2], dur = Math.min(30000, Math.max(12000, p.length * 40)), boat = L.circleMarker([p[0][0], p[0][1]], { radius: 9, color: '#fff', weight: 3, fillColor: '#087E83', fillOpacity: 1 }).addTo(tripPhotoLayer);
  const trail = L.polyline([], { color: '#087E83', weight: 5, opacity: 0.9, interactive: false }).addTo(tripPhotoLayer);
  const shown = new Set(), start = performance.now(); closeSheet();
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur), time = t0 + (t1 - t0) * k, pos = trackPosAt(t, time) || { lat: p[0][0], lon: p[0][1] };
    boat.setLatLng([pos.lat, pos.lon]); trail.setLatLngs(p.filter((q) => q[2] <= time).map((q) => [q[0], q[1]]).concat([[pos.lat, pos.lon]]));
    ph.forEach((x) => { if (!shown.has(x.id) && x.t <= time) { shown.add(x.id); const pop = L.popup({ closeButton: false, autoPan: false, className: 'ph-pop', offset: [0, -16] }).setLatLng([x.lat, x.lon]).setContent('<img src="' + x.img + '" alt="">').openOn(map); setTimeout(() => map.closePopup(pop), 2200); } });
    if (k < 1) replay.raf = requestAnimationFrame(step); else { replay = null; toast('Trip replay finished'); }
  };
  replay = { raf: requestAnimationFrame(step) };
}
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const t = S.tracks.find((x) => String(x.id) === b.dataset.id); if (!t) return;
  if (b.dataset.act === 'trplay') pAll(t.id).then((ph) => playTrip(t, ph));
  if (b.dataset.act === 'trback') showTrip(t);
});
sheet.addEventListener('change', (e) => { const inp = e.target.closest('[data-trphotos]'); if (!inp || !inp.files.length) return; const t = S.tracks.find((x) => String(x.id) === inp.dataset.trphotos); if (t) addTripPhotos(t, Array.from(inp.files)); });

/* ---------- Help: type a question, get the answer and a button that takes you there ---------- */
const HELP = [
  ['turn off weather wind waves rain colors layers clear chart', 'Turn weather off the chart', 'Tap the × on the weather bar at the bottom, or open Map options and untick Wind, Waves and Rain. Every launch starts clean anyway.', 'mapopts'],
  ['satellite imagery aerial photo hd globe', 'Satellite view', 'Tap the globe button on the right: chart over satellite, then satellite only, then back to the chart. HD imagery is in Map options.', 'mapopts'],
  ['night dark red dusk day colors theme brightness', 'Day, dusk and night colors', 'Tap the sun or moon button on the right side of the chart. Each tap changes Day, Dusk, Night or Automatic.', null],
  ['tide tides high low curve when', 'Tides', 'Tap the tide in the status line at the top. Drag along the curve to see the height at any time and the next high or low.', 'tide'],
  ['anchor alarm silence stop disarm turn off beeping', 'Silence or turn off the anchor alarm', 'On the alarm, tap Silence 2 min or Turn off anchor watch. On the Anchor tab, press and hold Disarm watch.', 'anchor'],
  ['navigate destination go to where search marina club', 'Go somewhere', 'Open Navigate and type the place in To. Pick it from the list and tap Go direct. Or press and hold any spot on the chart and tap Navigate to.', 'nav'],
  ['route trip multi stop plan save rock hall', 'Plan a trip with several stops', 'In Navigate, use Plan a trip: add each stop, then Save trip or Start. Edit on chart lets you add turning points.', 'nav'],
  ['measure distance ruler how far', 'Measure a distance', 'Tap the ruler on the right, then drag either circle. Drag to the edge and the chart zooms out.', null],
  ['ais boats ships traffic vessels', 'AIS boats', 'AIS boats show when Tideline gets AIS data: from your boat\'s AIS receiver (coming in the app-store version) or an internet AIS feed. Turn them on or off in Map options.', 'mapopts'],
  ['instruments gauges cockpit dashboard customize', 'Instruments and gauges', 'Menu › Instruments. Tap Customize to choose which gauges you see, including a small chart.', 'gauges'],
  ['fish fishing spot mark catch', 'Fishing spots', 'In your boat profile choose Fishing. A fish button appears on the chart; tap it to save the spot with tide, wind and water temperature.', 'boat'],
  ['photos trip replay pictures video', 'Trip photos and replay', 'Record a track, then Menu › Tracks and waypoints › Photos and replay. Add that day\'s photos and tap Replay trip.', 'log'],
  ['offline save charts no signal download', 'Charts with no signal', 'Settings › Offline charts saves the area you are looking at so it works without signal.', 'settings'],
  ['bridge clearance height drawbridge tender', 'Bridges', 'Bridge pins show the height under the bridge. Tap one for the tender\'s phone and VHF channel, and check it against the clearance printed on the NOAA chart.', null],
  ['settings units feet meters knots', 'Settings', 'Menu › Settings, or Map options › All settings.', 'settings'],
  ['laptop computer gps no gps planning mac', 'Using Tideline on a laptop', 'A computer has no GPS, so Tideline works as a planner: search, plan trips, check weather and tides for wherever the chart is. Drag with the trackpad, pinch to zoom, right-click a spot for options.', null],
  ['right click long press options spot here', 'Options for a spot', 'Press and hold on a phone, or right-click on a computer, for Navigate to, Weather here, Measure from here and Save.', null],
  ['coach rules colregs give way stand on', 'Rules of the Road coach', 'Optional, off by default. Turn it on in Settings › Captain\'s coach.', 'settings'],
  ['mob man overboard', 'Man overboard', 'Press and hold the red MOB button. It marks the spot and guides you back.', null],
];
function openHelp(q) {
  const list = (q ? HELP.map((h) => ({ h, sc: fuzzyScore(q, h[0] + ' ' + h[1]) })).filter((x) => x.sc).sort((a, b) => b.sc - a.sc).map((x) => x.h) : HELP).slice(0, q ? 5 : 8);
  const body = list.map((h, i) => '<div class="hp"><b>' + h[1] + '</b><p>' + h[2] + '</p>' + (h[3] ? '<button type="button" class="btn small" data-help="' + h[3] + '">Show me</button>' : '') + '</div>').join('') || '<p class="sub">No answer yet. Try other words, like “tide” or “anchor alarm”.</p>';
  if (!q) { setTab('chart'); openSheet('<h3>Help</h3><div class="field"><input id="helpQ" type="search" placeholder="Ask a question, e.g. how do I turn off the weather" autocomplete="off"></div><div id="helpList">' + body + '</div>'); setTimeout(() => { const i = $('helpQ'); if (i) i.focus(); }, 60); }
  else $('helpList').innerHTML = body;
}
sheet.addEventListener('input', (e) => { if (e.target.id === 'helpQ') openHelp(e.target.value.trim()); });
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-help]'); if (!b) return; const a = b.dataset.help; closeSheet();
  if (a === 'mapopts') openLayersSheet();
  else if (a === 'tide') { WX.view = 'tide'; WX.open = true; setTab('weather'); }
  else if (a === 'gauges') { setTab('chart'); setCockpit(true); }
  else setTab(a);
});
/* ---------- Menu ---------- */
const ICON = {
  boat: '<path d="M3 15h18l-3 5H6z"/><path d="M12 3v12M12 4l6 9h-6"/>', dash: '<path d="M4 16a8 8 0 1116 0"/><path d="M12 16l4-5"/>',
  log: '<path d="M4 4h12l4 4v12H4z"/><path d="M8 10h8M8 14h8M8 18h5"/>', safety: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  rules: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5M8 7h8M8 11h6"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 3.5"/><circle cx="12" cy="16.8" r="0.6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  cockpit: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 15v-3M12 15V9M16 15v-5"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
};
function menuTile(act, icon, title, sub) {
  return '<button type="button" class="m-row" data-mact="' + act + '"><i><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[icon] + '</svg></i><span class="m-txt"><b>' + title + '</b><span>' + sub + '</span></span><svg class="m-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>';
}
function renderMenu() {
  const grp = (t, rows) => '<div class="m-h">' + t + '</div><div class="m-list">' + rows + '</div>';
  $('panelMenu').innerHTML = '<div class="p-head"><div><div class="eyebrow">Tideline</div><h2>Menu</h2></div></div>' +
    grp('Your boat', menuTile('boat', 'boat', esc(S.settings.boatName || 'Your boat'), 'Profile, lights now, maintenance') +
      menuTile('dash', 'dash', 'Instruments', 'Gauges for speed, course, wind and tide') +
      menuTile('log', 'log', 'Tracks and waypoints', 'Record, photos and replay, export GPX')) +
    grp('On the water', menuTile('search', 'search', 'Search', 'Marinas, fuel, ramps, bridges') +
      menuTile('pro', 'rules', 'Captain\'s resources', 'Coast Pilot, notices, marine forecast') +
      menuTile('rules', 'rules', 'Rules of the Road', 'Search the Navigation Rules') +
      menuTile('safety', 'safety', 'Safety and education', 'VHF, safety check, float plan')) +
    grp('App', menuTile('mapopts', 'layers', 'Map options', 'Chart, satellite, weather, colors') +
      menuTile('settings', 'settings', 'Settings', 'Units, coach, display, offline charts') +
      menuTile('help', 'help', 'Help', 'Ask how to do anything')) +
    '<p class="hint" style="margin-top:14px">Tideline prototype 0.6. A navigation aid: keep a proper lookout and carry official charts.</p>';
}
$('panelMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mact]'); if (!b) return;
  const a = b.dataset.mact;
  if (a === 'rules') { setTab('search'); renderCats(); $('searchInput').value = 'Rules of the Road'; $('searchInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return; }
  if (a === 'cockpit' || a === 'dash') { setTab('chart'); setCockpit(true); return; }
  if (a === 'search') { $('searchPill').click(); return; }
  if (a === 'help') { openHelp(); return; }
  if (a === 'pro') { openResources(); return; }
  if (a === 'mapopts') { setTab('chart'); openLayersSheet(); return; }
  setTab(a);
});

/* ---------- Navigate (Argo layout, savvy navvy details) ---------- */
function navSpeed() { return S.settings.navMode === 'sail' ? (S.settings.sailSpeed || 5) : S.settings.cruise; }
function renderNav() {
  const g = S.goto, st = S.settings;
  let h = '<div class="p-head"><div><div class="eyebrow">Navigate</div><h2>Where to?</h2></div></div>';
  if (g) h += '<div class="card nav-active"><div class="li"><div class="li-main"><b>Navigating to ' + esc(g.name) + '</b><span class="tnum">' + (S.fix ? fmtDist(distNm(S.fix, g)) + ' · ' + fmtBrg(bearing(S.fix, g)) + '°T' : 'Waiting for GPS') + '</span></div><div class="li-btns"><button class="btn small" data-act="navshow">Show</button><button class="btn small danger" data-act="navend">End</button></div></div></div>';
  h += '<div class="card"><div class="nav-fields">' +
    '<div class="nf"><span class="nf-dot from"></span><div><small>From</small><b>' + (S.fix ? 'My boat' : 'Tap the chart in the route planner') + '</b></div></div>' +
    '<div class="nf"><span class="nf-dot to"></span><div style="flex:1;min-width:0"><small>To</small><input id="navToQ" type="search" autocomplete="off" enterkeyhint="search" placeholder="Marina, club, anchorage, town…" value="' + esc(S.navDest ? S.navDest.name : '') + '"><div id="navSugs" class="sugs" hidden></div></div></div>' +
    '<div class="nf-quick"><button type="button" class="btn small" data-act="navpick">Pick on the chart</button>' + S.waypoints.slice(-3).reverse().map((w) => '<button type="button" class="btn small" data-wpdest="' + w.id + '">' + esc(w.name) + '</button>').join('') + '</div></div>' +
    '<div class="set-row"><div class="sr-text"><b>Under</b></div></div>' + optSeg2('navMode', [['engine', 'Engine · ' + fmtSpeed(st.cruise) + ' ' + SPEED_LBL[st.speedUnit]], ['sail', 'Sail · ' + fmtSpeed(st.sailSpeed || 5) + ' ' + SPEED_LBL[st.speedUnit]]], st.navMode) +
    '<div class="row-btns" style="margin-top:12px"><button class="btn primary" data-act="navgo">Go direct</button><button class="btn" data-act="navplan">Plan a route</button></div>' +
    '<p class="hint" style="margin:8px 0 0">Autoroute, which finds a safe path for your draft, comes later. Routes are straight lines you place.</p></div>';
  h += tripCard();
  h += '<div class="card"><h4>My trips</h4>' +
    (S.routes.length ? S.routes.slice().reverse().map((r) => { const d = r.pts.reduce((a, p, i) => (i ? a + distNm(r.pts[i - 1], p) : 0), 0);
      return '<div class="li"><div class="li-main"><b>' + esc(r.name) + '</b><span class="tnum">' + (r.pts.some((p) => p.name) ? esc(r.pts.map((p) => p.name || '·').join(' → ')) : r.pts.length + ' waypoints') + ' · ' + fmtDist(d) + '</span></div><div class="li-btns"><button class="btn small primary" data-act="navtrip" data-id="' + r.id + '">Plan</button><button class="btn small" data-act="navroute" data-id="' + r.id + '">Chart</button></div></div>'; }).join('') :
      '<div class="empty">Saved routes appear here. Plan a route and tap Save.</div>') +
    ((S.settings.useMode === 'fish' || S.spots.length) ? '<h4 style="margin-top:14px">My fishing spots</h4>' + (S.spots.length ? S.spots.slice().reverse().slice(0, 12).map((sp) => '<div class="li"><div class="li-main"><b>' + esc(sp.species || 'Spot') + '</b><span class="tnum">' + new Date(sp.t).toLocaleDateString([], { month: 'short', day: 'numeric' }) + (S.fix ? ' · ' + fmtDist(distNm(S.fix, sp)) : '') + ' · ' + esc(spotSummary(sp)) + '</span></div><div class="li-btns"><button class="btn small" data-spot="' + sp.id + '">Open</button></div></div>').join('') : '<div class="empty">Tap the fish button on the chart to save a spot with the tide, wind and water temperature.</div>') : '') +
    '<div class="row-btns" style="margin-top:8px"><button class="btn" data-act="navlog">Tracks and waypoints</button>' + (S.rec.on ? '<button class="btn danger" data-act="navrecstop">Stop recording</button>' : '<button class="btn" data-act="navrec">Record track</button>') + '</div></div>';
  $('panelNav').innerHTML = h;
}
function optSeg2(name, opts, cur) {
  return '<div class="seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-nseg="' + name + '" data-val="' + v + '" class="' + (String(cur) === String(v) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
}
$('panelNav').addEventListener('click', (e) => {
  const sg = e.target.closest('[data-nseg]'); if (sg) { S.settings[sg.dataset.nseg] = sg.dataset.val; saveSettings(); renderNav(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, dest = S.navDest || null;
  if (act === 'navpick') { setTab('chart'); toast('Press and hold the spot you want, then tap Navigate to.', 4000); return; }
  if (act === 'navgo') {
    if (dest) { setGoto(dest.name, dest.lat, dest.lon); S.navDest = null; return; }
    toast('Type a destination first, or press and hold a spot on the chart.', 3500); const q = $('navToQ'); if (q) q.focus();
  }
  if (act === 'navplan') { RT.pts = []; if (S.fix) RT.pts.push({ lat: S.fix.lat, lon: S.fix.lon }); if (dest) RT.pts.push({ lat: dest.lat, lon: dest.lon }); store.set('routeDraft', RT.pts); routeMode(true); }
  if (act === 'navroute') { const r = S.routes.find((x) => String(x.id) === b.dataset.id); if (r) { RT.pts = r.pts.map((q) => ({ lat: q.lat, lon: q.lon })); store.set('routeDraft', RT.pts); routeMode(true); map.fitBounds(L.latLngBounds(RT.pts.map((q) => [q.lat, q.lon])).pad(0.2)); } }
  if (act === 'navtrip') { const r = S.routes.find((x) => String(x.id) === b.dataset.id); if (r) { S.trip2 = { name: r.name, stops: r.pts.map((p, i) => ({ name: p.name || 'Waypoint ' + (i + 1), lat: p.lat, lon: p.lon })) }; saveTripDraft(); renderNav(); } }
  if (act === 'navshow') setTab('chart');
  if (act === 'navend') { endGoto(); renderNav(); }
  if (act === 'navlog') setTab('log');
  if (act === 'navrec' || act === 'navrecstop') { const btn = document.createElement('button'); btn.dataset.act = act === 'navrec' ? 'recstart' : 'recstop'; $('panelLog').appendChild(btn); btn.click(); btn.remove(); renderNav(); }
});
let navSugList = [], navSugT = null, navSugSeq = 0;
$('panelNav').addEventListener('input', (e) => {
  if (e.target.id !== 'navToQ') return;
  const q = e.target.value.trim(); S.navDest = null; clearTimeout(navSugT);
  const box = $('navSugs'); if (q.length < 2) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<div class="sug-empty">Searching…</div>';
  navSugT = setTimeout(async () => { const seq = ++navSugSeq; const list = await suggestPlaces(q, S.fix || searchCenter()); if (seq !== navSugSeq || !$('navSugs')) return; navSugList = list; $('navSugs').innerHTML = placeSugHtml(list, 'data-nsug'); }, 250);
});
$('panelNav').addEventListener('click', (e) => {
  const so = e.target.closest('[data-spot]'); if (so) { const sp = S.spots.find((x) => String(x.id) === so.dataset.spot); if (sp) { setTab('chart'); map.setView([sp.lat, sp.lon], Math.max(map.getZoom(), 15)); openSpot(sp); } return; }
  const g = e.target.closest('[data-nsug]'); if (g) { const o = navSugList[+g.dataset.nsug]; S.navDest = { name: o.name, lat: o.lat, lon: o.lon }; $('navToQ').value = o.name; $('navSugs').hidden = true; return; }
  const w = e.target.closest('[data-wpdest]'); if (w) { const wp = S.waypoints.find((x) => String(x.id) === w.dataset.wpdest); if (wp) { S.navDest = { name: wp.name, lat: wp.lat, lon: wp.lon }; $('navToQ').value = wp.name; } }
}, true);

/* ---------- Safety and education (secondary to the coach; kept short) ---------- */
const VSC = ['State registration and numbers displayed', 'A wearable life jacket for everyone aboard, the right size', 'A throwable device (boats 16 ft and over)', 'Fire extinguishers, charged and in date', 'Visual distress signals, in date (coastal waters)', 'Horn or whistle', 'Navigation lights working', 'Engine-space ventilation and backfire flame arrester (gas engines)', 'Oil pollution and garbage placards (boats 26 ft and over)', 'Marine head with a legal holding tank or treatment system'];
function renderSafety() {
  const done = store.get('vsc', {}), pos = S.fix ? ddm(S.fix.lat, true) + ' ' + ddm(S.fix.lon, false) : '[your position]';
  const boat = S.settings.boatName || '[boat name]';
  const fp = store.get('floatplan', { who: '', back: '', where: '', contact: '' });
  $('panelSafety').innerHTML = '<div class="p-head"><div><div class="eyebrow">Safety and education</div><h2>Be ready</h2></div><button class="btn small" data-act="sfback">Menu</button></div>' +
    '<div class="card"><h4>Emergency on VHF channel 16</h4><div class="script tnum">MAYDAY, MAYDAY, MAYDAY. This is ' + esc(boat) + ', ' + esc(boat) + ', ' + esc(boat) + '. MAYDAY ' + esc(boat) + '. My position is ' + esc(pos) + '. [What is wrong.] [How many people aboard.] [Boat description.] Over.</div>' +
    '<p class="hint">Use MAYDAY for danger to life or the boat; PAN-PAN for urgent but not life-threatening. On shore, call 911.</p></div>' +
    '<div class="card"><h4>VHF channels</h4><div class="facts" style="margin:0"><span>16</span><span>Distress, safety and calling. Monitor it underway.</span><span>9</span><span>Calling for recreational boats; many marinas.</span><span>13</span><span>Bridge to bridge: ships, tugs and drawbridges.</span><span>22A</span><span>Coast Guard working channel, when they ask you to switch.</span><span>68, 69, 71, 72</span><span>Boat to boat chatter.</span><span>WX 1–7</span><span>NOAA Weather Radio.</span></div></div>' +
    '<div class="card"><h4>Float plan</h4><p class="hint" style="margin:0 0 8px">Leave it with someone ashore. Tideline copies it as a message you can text.</p>' +
    '<div class="field"><label for="fpWho">Who is aboard</label><input id="fpWho" value="' + esc(fp.who) + '"></div><div class="field"><label for="fpWhere">Where you are going</label><input id="fpWhere" value="' + esc(fp.where) + '"></div>' +
    '<div class="grid2"><div class="field"><label for="fpBack">Back by</label><input id="fpBack" type="datetime-local" value="' + esc(fp.back) + '"></div><div class="field"><label for="fpContact">Who to call if late</label><input id="fpContact" value="' + esc(fp.contact) + '"></div></div>' +
    '<div class="row-btns"><button class="btn primary" data-act="fpcopy">Copy float plan</button></div></div>' +
    '<div class="card"><h4>Vessel safety check</h4><p class="hint" style="margin:0 0 6px">The basics the Coast Guard Auxiliary checks. Tap each one as you confirm it.</p>' +
    VSC.map((t, i) => '<label class="opt"><input type="checkbox" data-vsc="' + i + '"' + (done[i] ? ' checked' : '') + '><span>' + t + '</span></label>').join('') +
    '<p class="hint">A free check from the Coast Guard Auxiliary covers state rules too: <a href="https://www.uscgboating.org" target="_blank" rel="noopener">uscgboating.org</a>.</p></div>' +
    '<div class="card"><h4>Boating at night</h4><ul class="todo"><li>Turn on your navigation lights from sunset to sunrise (Rule 20). The Boat tab shows exactly which ones.</li><li>Slow down: lights on shore hide buoys and boats.</li><li>Use red light inside the cockpit, and Tideline\'s night mode.</li><li>Count the flashes on lights and check them against the chart.</li></ul></div>';
}
$('panelSafety').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'sfback') setTab('menu');
  if (b.dataset.act === 'fpcopy') {
    const fp = { who: $('fpWho').value, where: $('fpWhere').value, back: $('fpBack').value, contact: $('fpContact').value }; store.set('floatplan', fp);
    const bk = fp.back ? new Date(fp.back).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '[time]';
    const txt = 'Float plan: ' + (S.settings.boatName || 'our boat') + ' (' + boatSummary() + '). Aboard: ' + (fp.who || '?') + '. Going: ' + (fp.where || '?') + '. Back by ' + bk + '. If we are not back or in touch by then, call ' + (fp.contact || 'the Coast Guard') + ' and give them this message.' + (S.fix ? ' Last position ' + ddm(S.fix.lat, true) + ' ' + ddm(S.fix.lon, false) + '.' : '');
    const done = () => toast('Float plan copied. Paste it into a text message.');
    try { navigator.clipboard.writeText(txt).then(done, () => toast(txt, 9000)); } catch (err) { toast(txt, 9000); }
  }
});
$('panelSafety').addEventListener('change', (e) => { const c = e.target.closest('[data-vsc]'); if (c) { const d = store.get('vsc', {}); d[c.dataset.vsc] = c.checked; store.set('vsc', d); } });

/* Dash */
function dial(cog, moving) {
  const card = moving && cog != null ? -cog : 0;
  let ticks = '';
  for (let a = 0; a < 360; a += 10) {
    const long = a % 30 === 0, r1 = long ? 78 : 83;
    ticks += '<line x1="100" y1="' + (100 - r1) + '" x2="100" y2="' + (100 - 90) + '" transform="rotate(' + a + ' 100 100)" stroke="var(--p-muted)" stroke-width="' + (long ? 2 : 1) + '"/>';
  }
  const lab = (t, a, col) => '<text x="100" y="40" text-anchor="middle" transform="rotate(' + a + ' 100 100)" font-family="var(--f-num)" font-size="18" font-weight="700" fill="' + col + '">' + t + '</text>';
  return '<svg viewBox="0 0 200 200" role="img" aria-label="Course ' + (moving ? fmtBrg(cog) : 'not moving') + '">' +
    '<circle cx="100" cy="100" r="92" fill="none" stroke="var(--tile-line)" stroke-width="2"/>' +
    '<g transform="rotate(' + card + ' 100 100)">' + ticks + lab('N', 0, 'var(--amber)') + lab('E', 90, 'var(--p-muted)') + lab('S', 180, 'var(--p-muted)') + lab('W', 270, 'var(--p-muted)') + '</g>' +
    '<path d="M100 6 L108 22 L92 22 Z" fill="var(--p-ink)"/>' +
    '<text x="100" y="114" text-anchor="middle" font-family="var(--f-num)" font-size="44" font-weight="600" fill="var(--p-ink)">' + (moving && cog != null ? fmtBrg(cog) + '°' : '–') + '</text>' +
    '<text x="100" y="136" text-anchor="middle" font-size="12" fill="var(--p-muted)">course, true</text></svg>';
}
function tideSvg() {
  const t = S.tide; if (!t || !t.hourly || t.hourly.length < 3) return '';
  const now = Date.now(), from = now - 6 * 3600000, to = now + 24 * 3600000;
  const pts = t.hourly.filter((p) => p.t >= from && p.t <= to); if (pts.length < 3) return '';
  const vs = pts.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs), W = 340, H = 56;
  const X = (tt) => ((tt - from) / (to - from)) * W, Y = (v) => H - 6 - ((v - lo) / (hi - lo || 1)) * (H - 12);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
  const tn = tideNow(); const nx = X(now);
  return '<svg class="tide-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Tide for the next 24 hours">' +
    '<path d="' + d + '" fill="none" stroke="var(--teal-hi)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>' +
    '<line x1="' + nx + '" x2="' + nx + '" y1="0" y2="' + H + '" stroke="var(--amber)" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
    (tn ? '<circle cx="' + nx + '" cy="' + Y(tn.v) + '" r="4" fill="var(--amber)"/>' : '') + '</svg>';
}
function renderDash() {
  $('panelDash').innerHTML =
    '<div class="p-head"><div><div class="eyebrow" id="dashEyebrow"></div><h2 id="dashTitle">Instruments</h2></div>' +
    '<div class="row-btns" style="flex:none"><button class="btn small" data-act="night">' + (S.settings.night ? 'Day' : 'Night') + '</button></div></div>' +
    '<div id="dashBody" class="stack"></div>' +
    '<div class="p-btns"><button class="btn" data-act="resettrip">Reset trip</button></div>';
  renderDashBody();
}
function renderDashBody() {
  const body = $('dashBody'); if (!body) return;
  const f = S.fix, moving = (S.sog || 0) > 0.6, su = SPEED_LBL[S.settings.speedUnit];
  $('dashEyebrow').textContent = !f ? 'WAITING FOR GPS' : moving ? 'UNDERWAY · ' + fmtHM(S.trip.moving) : 'STOPPED';
  $('dashTitle').textContent = S.goto ? 'To ' + S.goto.name : 'Instruments';
  const avg = S.trip.moving > 60 ? S.trip.dist / (S.trip.moving / 3600) : null;
  let h = '<div class="grid2">' +
    '<div class="tile"><span class="eyebrow">Course</span><div class="dial-wrap">' + dial(S.cog, moving) + '</div></div>' +
    '<div class="tile"><span class="eyebrow">Speed</span><span class="big tnum">' + (f ? fmtSpeed(S.sog || 0) : '–') + '</span><span class="note">' + su + ' over ground</span>' +
    '<span class="note" style="margin-top:auto">Max ' + fmtSpeed(S.trip.max) + ' · Avg ' + (avg == null ? '–' : fmtSpeed(avg)) + '</span></div></div>';
  if (S.goto && f) {
    const info = legInfo(f, S.goto), [dv, du] = distParts(info.d);
    let x = '';
    if (S.goto.from && distNm(S.goto.from, S.goto) > 0.05) { const xn = crossTrackNm(S.goto.from, S.goto, f); x = fmtDist(Math.abs(xn)) + (Math.abs(xn) > 0.01 ? (xn > 0 ? ' R' : ' L') : ''); }
    h += '<div class="grid3"><div class="tile"><span class="eyebrow">To go</span><span class="mid tnum">' + dv + '</span><span class="note">' + du + '</span></div>' +
      '<div class="tile"><span class="eyebrow">Bearing</span><span class="mid tnum">' + fmtBrg(info.b) + '°</span><span class="note">true</span></div>' +
      '<div class="tile"><span class="eyebrow">ETA</span><span class="mid tnum">' + (isFinite(info.hrs) ? fmtClock(Date.now() + info.hrs * 3600000).replace(/\s?[AP]M/i, '') : '–') + '</span><span class="note">' + fmtDur(info.hrs) + '</span></div>' +
      (x ? '<div class="tile span3"><span class="eyebrow">Off the line</span><span class="note" style="font-size:15px;color:var(--p-ink)">' + x + ' of the straight line to the target</span></div>' : '') + '</div>';
  }
  const [tv, tu] = distParts(S.trip.dist);
  h += '<div class="grid2"><div class="tile"><span class="eyebrow">Trip</span><span class="mid tnum">' + tv + '</span><span class="note">' + tu + ' in ' + fmtHM(S.trip.moving) + ' underway</span></div>' +
    '<div class="tile"><span class="eyebrow">Position</span><span class="tnum" style="font-family:var(--f-num);font-size:21px;font-weight:600;line-height:1.25;margin-top:4px">' +
    (f ? ddm(f.lat, true) + '<br>' + ddm(f.lon, false) : '–') + '</span><span class="note">' + (f ? '±' + fmtLen((f.acc || 0) * 3.28084) + ' accuracy' : '') + '</span></div></div>';
  const w = S.weather;
  if (w && w.cur) {
    const now = Date.now();
    const hrs = w.hours.filter((x) => x.t > now).filter((x, i) => i % 3 === 0).slice(0, 4);
    const sunset = (w.sunset || []).find((t) => t > now), sunrise = (w.sunrise || []).find((t) => t > now);
    h += '<div class="tile"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="eyebrow">Wind · forecast</span><span class="note">' + Math.round(w.cur.temp) + '°F</span></div>' +
      '<div style="display:flex;align-items:baseline;gap:10px"><span class="mid tnum">' + compass16(w.cur.dir) + ' ' + Math.round(speedOut(w.cur.spd)) + '</span><span class="note">' + su + ', gusts ' + Math.round(speedOut(w.cur.gust)) + '</span></div>' +
      '<div class="hilo">' + hrs.map((x) => '<span>' + fmtClock(x.t) + '</span><span class="tnum">' + compass16(x.dir) + ' ' + Math.round(speedOut(x.spd)) + ' g' + Math.round(speedOut(x.gust)) + '</span>').join('') + '</div>' +
      '<span class="note" style="margin-top:6px">' + (sunset ? 'Sunset ' + fmtClock(sunset) : '') + (sunrise ? ' · Sunrise ' + fmtClock(sunrise) : '') + '</span></div>';
  }
  const t = S.tide, tn = tideNow();
  if (t && t.none) h += '<div class="tile"><span class="eyebrow">Tide</span><span class="note">No NOAA tide station within 30 nm.</span></div>';
  else if (t && t.station) {
    const ups = (t.hilo || []).filter((p) => p.t > Date.now()).slice(0, 4);
    h += '<div class="tile"><div style="display:flex;justify-content:space-between;gap:10px"><span class="eyebrow">Tide</span><span class="note" style="text-align:right">' + esc(t.station.name) + '</span></div>' +
      (tn ? '<span class="mid tnum">' + tideLen(tn.v) + ' ' + (tn.rising == null ? '' : tn.rising ? 'rising' : 'falling') + '</span>' : '') + tideSvg() +
      '<div class="hilo">' + ups.map((p) => '<span>' + (p.type === 'H' ? 'High' : 'Low') + ' ' + fmtClock(p.t) + '</span><span class="tnum">' + tideLen(p.v) + '</span>').join('') + '</div></div>';
  }
  if (!w && !t) h += '<p class="hint">Wind and tide appear once there is a GPS fix and an internet connection.</p>';
  body.innerHTML = h;
}
$('panelDash').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'night') { S.settings.theme = S.settings.night ? 'day' : 'night'; saveSettings(); applyNight(); renderDash(); }
  if (b.dataset.act === 'resettrip') { if (!armed(b, 'Tap again to reset')) return; S.trip = { dist: 0, max: 0, moving: 0, start: Date.now() }; store.set('trip', S.trip); renderDashBody(); renderStrip(); }
});

/* Anchor panel */
function renderAnchor() {
  const p = $('panelAnchor');
  if (!S.anchor) {
    const f = S.anchorForm, sug = suggestRadiusFt(f.depth, f.rode), r = f.radius || sug.radius;
    const scope = f.depth > 0 ? f.rode / f.depth : 0;
    p.innerHTML =
      '<div class="p-head"><div><div class="eyebrow">Anchor watch</div><h2>Set your anchor alarm</h2></div></div>' +
      '<div class="stack">' +
      '<div class="grid2"><div class="field"><label for="anDepth">Water depth (' + lenUnit() + ')</label><input id="anDepth" type="number" inputmode="decimal" min="1" value="' + Math.round(ftToLen(f.depth)) + '"></div>' +
      '<div class="field"><label for="anRode">Rode let out (' + lenUnit() + ')</label><input id="anRode" type="number" inputmode="decimal" min="1" value="' + Math.round(ftToLen(f.rode)) + '"></div></div>' +
      '<div class="grid2"><div class="field"><label for="anBow">Bow height above water (' + lenUnit() + ')</label><input id="anBow" type="number" inputmode="decimal" min="0" value="' + Math.round(ftToLen(f.bow == null ? 4 : f.bow)) + '"></div>' +
      '<div class="field"><label>Rode</label><div class="seg" role="group" style="background:var(--tile);border-color:var(--tile-line)"><button type="button" data-rodetype="mixed" class="' + (f.rodeType !== 'chain' ? 'on' : '') + '" style="color:inherit">Chain + rope</button><button type="button" data-rodetype="chain" class="' + (f.rodeType === 'chain' ? 'on' : '') + '" style="color:inherit">All chain</button></div></div></div>' +
      '<div class="field"><label>Bottom</label><div class="seg" role="group" style="background:var(--tile);border-color:var(--tile-line)">' + BOTTOMS.map(([v, l]) => '<button type="button" data-bottom="' + v + '" class="' + ((f.bottom || '') === v ? 'on' : '') + '" style="color:inherit">' + l + '</button>').join('') + '</div></div>' +
      '<div id="anAdvice">' + adviceHtml() + '</div>' +
      '<div class="tile' + (scope && scope < 5 ? ' warn' : '') + '" id="anSug">' + sugHtml(f, sug, scope) + '</div>' +
      '<div class="field"><label for="anRadius">Alarm circle: <b id="anRadiusVal">' + fmtLen(r) + '</b></label><input id="anRadius" type="range" min="40" max="600" step="5" value="' + Math.round(r) + '"></div>' +
      '<button class="btn primary big" data-act="drop">Drop anchor here</button>' +
      '<div class="p-btns" style="margin-top:0"><button class="btn" data-act="testsiren">Test the alarm sound</button><button class="btn" data-act="docktest">Dock test</button></div>' +
      '<p class="hint">Dock test: sets a 40 ft circle where you stand. Walk the phone away and the alarm should sound about 15 seconds after you leave it.</p>' +
      '<p class="hint">Tap when the anchor hits the bottom. The circle centers on your bow, using where you keep the phone (Settings: ' + fmtLen(S.settings.gpsToBow) + ' from the bow). You can drag the anchor on the chart to fine-tune it.</p>' +
      '<p class="hint">Keep Tideline open with the screen on and the phone charging, and turn the ringer on. Phone browsers pause web apps when the screen locks.</p>' +
      '</div>';
    return;
  }
  p.innerHTML =
    '<div class="p-head"><div><div class="eyebrow" id="anSince"></div><h2>' + (S.anchor.test ? 'Dock test' : 'Anchor watch') + '</h2></div><span id="anStatus" class="status-pill"></span></div>' +
    '<div class="stack"><div class="tile" style="padding:8px"><div id="anSvg"></div></div>' +
    '<div class="grid3" id="anTiles"></div><div id="anNote"></div>' +
    '<div class="field"><label for="anRadius2">Alarm circle: <b id="anRadiusVal2">' + fmtLen(S.anchor.radiusFt) + '</b></label><input id="anRadius2" type="range" min="40" max="600" step="5" value="' + Math.round(S.anchor.radiusFt) + '"></div>' +
    '<div class="p-btns" style="margin-top:0"><button class="btn" data-act="fit" id="anFit">Fit circle to swing</button><button class="btn" data-act="showanchor">Show on chart</button><button class="btn" data-act="testsiren">Test sound</button></div>' +
    (S.settings.sim ? '<div class="p-btns" style="margin-top:0"><button class="btn" data-act="simdrag">Demo: make the anchor drag</button></div>' : '') +
    '<button class="btn danger big hold" data-hold="raise"><span class="hold-fill"></span><span>Disarm watch</span><small>Press and hold</small></button>' +
    '<p class="hint" style="text-align:center;margin-top:-4px">Monitoring movement only. Holding is not confirmed.</p>' +
    '<p class="hint">Alarm sounds after 15 seconds outside the circle, so GPS jumps don\'t set it off. Keep the screen on and the phone charging.</p>' +
    '<div id="anLights">' + lightsAdvice() + '</div></div>';
  renderAnchorLive();
}

/* press-and-hold buttons (disarm anchor watch) */
const holdT = new WeakMap();
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-hold]'); if (!b) return;
  b.classList.add('holding');
  holdT.set(b, setTimeout(() => { b.classList.remove('holding'); if (navigator.vibrate) navigator.vibrate(40); if (b.dataset.hold === 'raise') raiseAnchor(); }, 1200));
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => document.addEventListener(ev, (e) => {
  const b = e.target.closest && e.target.closest('[data-hold]'); if (!b || !holdT.has(b)) return;
  clearTimeout(holdT.get(b)); holdT.delete(b);
  if (b.classList.contains('holding')) { b.classList.remove('holding'); toast('Keep holding to disarm the anchor watch.', 2000); }
}, true));
const ANCHORS = {
  newgen: { name: 'New-generation', good: ['mud', 'sand', 'shell'], poor: ['rock'], note: 'Sets fast and resets well when the wind shifts.' },
  plow: { name: 'Plow', good: ['mud', 'sand', 'grass'], poor: [], note: 'Good all-round holding; can take longer to set.' },
  claw: { name: 'Claw', good: ['sand', 'shell', 'rock'], poor: ['mud', 'grass'], note: 'Sets quickly but holds less per pound, especially in soft mud.' },
  fluke: { name: 'Fluke', good: ['mud', 'sand'], poor: ['grass', 'rock', 'shell'], note: 'Excellent in sand and firm mud, but may not reset if the wind or tide swings the boat around.' },
  grapnel: { name: 'Grapnel', good: ['rock'], poor: ['mud', 'sand', 'grass'], note: 'Meant for small boats or temporary stops, not overnight.' },
  other: { name: 'Other', good: [], poor: [], note: '' },
};
const BOTTOMS = [['mud', 'Mud'], ['sand', 'Sand'], ['grass', 'Grass'], ['rock', 'Rock/shell'], ['', 'Not sure']];
function rodeAdvice() {
  const f = S.anchorForm, bow = f.bow == null ? 4 : f.bow, now = Date.now(), reasons = [];
  let rise = 0, fall = 0;
  const t = S.tide, tn = tideNow();
  if (t && t.hilo && tn) {
    const next = t.hilo.filter((p) => p.t > now && p.t < now + 14 * 3600000);
    const hi = Math.max(tn.v, ...next.map((p) => p.v)), lo = Math.min(tn.v, ...next.map((p) => p.v));
    rise = Math.max(0, hi - tn.v); fall = Math.max(0, tn.v - lo);
  }
  const w = S.weather, gusts = w && w.hours ? Math.max(w.cur ? w.cur.gust : 0, ...w.hours.filter((h) => h.t > now && h.t < now + 14 * 3600000).map((h) => h.gust)) : null;
  const chain = f.rodeType === 'chain';
  let scope = chain ? 4 : 5;
  if (gusts != null && gusts >= 15) scope = chain ? 5 : 7;
  if (gusts != null && gusts >= 25) scope = chain ? 7 : 8;
  const depthHigh = f.depth + rise, rode = Math.ceil((scope * (depthHigh + bow)) / 5) * 5;
  const swing = Math.sqrt(Math.max(rode * rode - (depthHigh + bow) ** 2, 0)) + S.settings.boatLen;
  let verdict = 'good';
  const draft = S.boat.draftFt;
  if (draft) {
    const lowDepth = f.depth - fall, margin = lowDepth - draft;
    if (margin < 1) { verdict = 'poor'; reasons.push(['bad', 'Only ' + fmtLen(Math.max(margin, 0)) + ' under your keel at low tide (' + fmtLen(lowDepth) + ' of water, ' + fmtLen(draft) + ' draft). Move to deeper water.']); }
    else if (margin < 2) { verdict = 'fair'; reasons.push(['warn', fmtLen(margin) + ' under your keel at low tide. Tight; allow for waves and soft bottom.']); }
    else reasons.push(['ok', fmtLen(margin) + ' under your keel at low tide.']);
  } else reasons.push(['warn', 'Add your draft in Boat to check depth at low tide.']);
  if (gusts != null) {
    if (gusts >= 25) { verdict = 'poor'; reasons.push(['bad', 'Gusts to ' + Math.round(speedOut(gusts)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ' forecast. Pick a well-protected spot, set the anchor hard, and consider staying in a marina.']); }
    else if (gusts >= 15) { if (verdict === 'good') verdict = 'fair'; reasons.push(['warn', 'Gusts to ' + Math.round(speedOut(gusts)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ' forecast. Extra scope, and back down firmly to set.']); }
    else reasons.push(['ok', 'Light wind forecast (gusts to ' + Math.round(speedOut(gusts)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ').']);
    if (w.cur) reasons.push(['info', 'Wind from the ' + compass16(w.cur.dir) + ' now. Look for land or a point to the ' + compass16(w.cur.dir) + ' of you for shelter; Tideline can\'t judge protection from the chart yet.']);
  } else reasons.push(['warn', 'No forecast yet. Wind advice appears once you have signal.']);
  if (rise > 0.3) reasons.push(['info', 'Tide rises ' + tideLen(rise) + ' before the next low, so the rode is sized for high water.']);
  const wn = windShiftNote(); if (wn) { if (verdict === 'good') verdict = 'fair'; reasons.push(['warn', wn]); }
  // your gear
  const B = S.boat, A = ANCHORS[B.anchorType], bottom = f.bottom === 'rock' ? 'rock' : f.bottom;
  if (B.rodeTotalFt) {
    if (B.rodeTotalFt < rode) { verdict = rode > B.rodeTotalFt * 1.25 ? 'poor' : (verdict === 'good' ? 'fair' : verdict); reasons.push(['bad', 'You carry ' + fmtLen(B.rodeTotalFt) + ' of rode but this calls for ' + fmtLen(rode) + '. Find shallower water or a more sheltered spot.']); }
    else reasons.push(['ok', 'You have enough rode (' + fmtLen(B.rodeTotalFt) + ' aboard).']);
    if (!chain && B.chainFt != null && B.chainFt < S.settings.boatLen) reasons.push(['warn', 'Only ' + fmtLen(B.chainFt) + ' of chain. A common guideline is at least a boat length of chain ahead of the rope, to protect it from chafe and help the anchor dig in.']);
  }
  if (A) {
    if (bottom && A.poor.includes(bottom)) { if (verdict === 'good') verdict = 'fair'; reasons.push(['warn', 'A ' + A.name.toLowerCase() + ' anchor often holds poorly in ' + bottom + '. ' + A.note]); }
    else if (bottom && A.good.includes(bottom)) reasons.push(['ok', 'A ' + A.name.toLowerCase() + ' anchor usually holds well in ' + bottom + '.']);
    if (B.anchorType === 'fluke' && wn) reasons.push(['warn', 'With the wind shift coming, a fluke anchor may break out instead of resetting. Consider a second anchor or a different spot.']);
    if (B.anchorType === 'grapnel') { verdict = 'poor'; reasons.push(['bad', A.note]); }
    if (gusts != null && gusts >= 20) reasons.push(['info', 'Strong gusts: check your ' + (B.anchorLb ? B.anchorLb + ' lb ' : '') + 'anchor is at or above the size its maker recommends for a ' + Math.round(S.settings.boatLen) + ' ft boat in storm conditions.']);
  } else reasons.push(['info', 'Add your anchor type, weight and rode in Boat so Tideline can check your gear.']);
  if (!bottom) reasons.push(['info', 'The chart shows the bottom type near you (M = mud, S = sand, Sh = shell, Rk = rock).']);
  return { scope, rode, swing, gusts, verdict, reasons, chain };
}
function adviceHtml() {
  const a = rodeAdvice(), V = { good: ['good', 'Looks like a good spot'], fair: ['warn', 'Usable, with care'], poor: ['bad', 'Not a good spot tonight'] }[a.verdict];
  const ico = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
  return '<div class="tile" style="gap:8px"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span class="eyebrow">Recommended rode</span><span class="status-pill ' + V[0] + '">' + V[1] + '</span></div>' +
    '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span class="mid tnum">' + fmtLen(a.rode) + '</span><span class="note">' + a.scope + ':1 scope, ' + (a.chain ? 'all chain' : 'chain and rope') + '</span></div>' +
    '<span class="note">Scope is measured from the bow roller to the bottom at high water. Your boat will swing about ' + fmtLen(a.swing) + ' around the anchor.</span>' +
    '<div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">' + a.reasons.map((r) => '<div style="display:flex;gap:8px;font-size:13.5px;line-height:1.4"><b style="flex:none;width:18px;text-align:center;color:' + (r[0] === 'bad' ? 'var(--red)' : r[0] === 'warn' ? 'var(--amber)' : r[0] === 'ok' ? 'var(--teal-hi)' : 'var(--p-muted)') + '">' + ico[r[0]] + '</b><span>' + esc(r[1]) + '</span></div>').join('') + '</div>' +
    '<button type="button" class="btn small" data-act="userode" style="align-self:flex-start;margin-top:4px">Use ' + fmtLen(a.rode) + ' of rode</button>' +
    '<span class="note" style="font-size:11.5px">Typical seamanship guidance, not a guarantee. Bottom type, shelter and swing room matter as much as scope.</span></div>';
}
function sugHtml(f, sug, scope) {
  return '<span class="eyebrow">Suggested circle</span><span class="mid tnum">' + fmtLen(sug.radius) + '</span>' +
    '<span class="note">' + fmtLen(sug.reach) + ' of rode reach + ' + fmtLen(S.settings.gpsToBow) + ' from phone to bow + margin</span>' +
    '<span class="note" style="margin-top:4px">Scope ' + (scope ? scope.toFixed(1) + ':1' : '–') + (scope && scope < 5 ? ' · short scope; 5:1 or more holds better' : '') + '</span>';
}
function renderAnchorLive() {
  const a = S.anchor, svgBox = $('anSvg'); if (!a || !svgBox) return;
  const st = anchorStatus(); const sp = $('anStatus'); sp.className = 'status-pill ' + st[0]; sp.textContent = st[1];
  $('anSince').textContent = 'Since ' + fmtClock(a.setAt);
  const scale = 128 / a.radiusFt, cx = 160, cy = 160;
  const toXY = (lat, lon) => {
    const dx = (lon - a.lon) * Math.cos(rad(a.lat)) * 60 * FT_PER_NM, dy = (lat - a.lat) * 60 * FT_PER_NM;
    const x = dx * scale, y = -dy * scale, m = Math.hypot(x, y), cap = 150;
    return m > cap ? [cx + x * cap / m, cy + y * cap / m] : [cx + x, cy + y];
  };
  let s = '<svg class="anchor-svg" viewBox="0 0 320 320" role="img" aria-label="Boat position inside the anchor circle">' +
    '<circle cx="160" cy="160" r="128" fill="var(--teal)" fill-opacity="0.07" stroke="var(--teal)" stroke-width="2" stroke-dasharray="6 6"/>';
  if (a.maxFt > 0) s += '<circle cx="160" cy="160" r="' + (a.maxFt * scale).toFixed(1) + '" fill="none" stroke="var(--teal-hi)" stroke-opacity="0.5" stroke-width="1.5"/>';
  if (a.swing.length > 1) s += '<polyline fill="none" stroke="var(--teal-hi)" stroke-opacity="0.75" stroke-width="2" points="' + a.swing.map((p) => toXY(p[0], p[1]).map((v) => v.toFixed(1)).join(',')).join(' ') + '"/>';
  s += '<circle cx="160" cy="160" r="10" fill="var(--panel)" stroke="var(--amber)" stroke-width="2"/><path d="M160 154v12M155 162a5 5 0 0010 0" stroke="var(--amber)" stroke-width="1.8" fill="none"/>';
  if (S.fix) {
    const [bx, by] = toXY(S.fix.lat, S.fix.lon), ar = Math.min(140, (a.accFt || 0) * scale);
    s += '<circle cx="' + bx + '" cy="' + by + '" r="' + ar.toFixed(1) + '" fill="var(--p-ink)" fill-opacity="0.08"/>' +
      '<circle cx="' + bx + '" cy="' + by + '" r="7" fill="var(--p-ink)" stroke="var(--panel)" stroke-width="2"/>';
  }
  s += '<text x="160" y="16" text-anchor="middle" font-size="12" fill="var(--p-muted)">N</text>';
  if (S.weather && S.weather.cur) s += '<g transform="translate(290 34)"><g transform="rotate(' + ((S.weather.cur.dir + 180) % 360) + ')"><path d="M0 -14v26M0 12l-5 -7M0 12l5 -7" stroke="var(--p-muted)" stroke-width="2" fill="none"/></g></g><text x="290" y="64" text-anchor="middle" font-size="11" fill="var(--p-muted)">' + compass16(S.weather.cur.dir) + ' ' + Math.round(speedOut(S.weather.cur.spd)) + '</text>';
  s += '</svg>';
  svgBox.innerHTML = s;
  const mins = Math.floor((Date.now() - a.setAt) / 60000);
  $('anTiles').innerHTML =
    '<div class="tile"><span class="eyebrow">From anchor</span><span class="mid tnum">' + (a.lastFt != null ? Math.round(ftToLen(a.lastFt)) : '–') + '</span><span class="note">' + lenUnit() + '</span></div>' +
    '<div class="tile"><span class="eyebrow">Max swing</span><span class="mid tnum">' + Math.round(ftToLen(a.maxFt)) + '</span><span class="note">' + lenUnit() + '</span></div>' +
    '<div class="tile"><span class="eyebrow">GPS</span><span class="mid tnum">±' + (a.accFt != null ? Math.round(ftToLen(a.accFt)) : '–') + '</span><span class="note">' + lenUnit() + ' · ' + (mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h') + ' set</span></div>';
  const wn = windShiftNote();
  $('anNote').innerHTML = wn ? '<div class="tile warn"><b>Wind shift ahead</b><span style="font-size:13.5px">' + esc(wn) + '</span></div>' : '';
  const fit = $('anFit'); if (fit) fit.disabled = !(a.maxFt > 20 && Date.now() - a.setAt > 10 * 60000);
}
$('panelAnchor').addEventListener('input', (e) => {
  const id = e.target.id, f = S.anchorForm;
  if (id === 'anBow') { f.bow = lenToFt(parseFloat(e.target.value) || 0); store.set('anchorForm', f); $('anAdvice').innerHTML = adviceHtml(); return; }
  if (id === 'anDepth' || id === 'anRode') {
    const v = lenToFt(parseFloat(e.target.value) || 0);
    if (id === 'anDepth') f.depth = v; else f.rode = v;
    f.radius = null;
    const sug = suggestRadiusFt(f.depth, f.rode), scope = f.depth > 0 ? f.rode / f.depth : 0;
    const box = $('anSug'); box.innerHTML = sugHtml(f, sug, scope); box.className = 'tile' + (scope && scope < 5 ? ' warn' : '');
    $('anRadius').value = sug.radius; $('anRadiusVal').textContent = fmtLen(sug.radius);
    if (id === 'anDepth') $('anAdvice').innerHTML = adviceHtml();
    store.set('anchorForm', f);
  }
  if (id === 'anRadius') { f.radius = +e.target.value; $('anRadiusVal').textContent = fmtLen(f.radius); store.set('anchorForm', f); }
  if (id === 'anRadius2' && S.anchor) { S.anchor.radiusFt = +e.target.value; $('anRadiusVal2').textContent = fmtLen(S.anchor.radiusFt); store.set('anchor', S.anchor); drawAnchor(); renderAnchorLive(); }
});
$('panelAnchor').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'drop') { if (DESK && !S.settings.sim) { toast('Anchor watch needs real GPS. Use it on your phone or iPad on the boat.', 4500); return; } dropAnchor(); }
  if (act === 'userode') { const a = rodeAdvice(); S.anchorForm.rode = a.rode; S.anchorForm.radius = null; store.set('anchorForm', S.anchorForm); renderAnchor(); toast('Rode set to ' + fmtLen(a.rode)); }
  if (act === 'raise') raiseAnchor();
  if (act === 'fit' && S.anchor) { S.anchor.radiusFt = Math.round((S.anchor.maxFt + 40) / 5) * 5; store.set('anchor', S.anchor); drawAnchor(); renderAnchor(); toast('Circle set to ' + fmtLen(S.anchor.radiusFt)); }
  if (act === 'showanchor' && S.anchor) { setTab('chart'); setFollow(false); map.setView([S.anchor.lat, S.anchor.lon], 18); }
  if (act === 'simdrag') { S.simDrag = true; toast('Demo: the boat is drifting off its anchor'); }
  if (act === 'testsiren') testSiren();
  if (act === 'docktest') { const keep = S.anchorForm.radius; S.anchorForm.radius = 40; dropAnchor(); S.anchorForm.radius = keep; if (S.anchor) { S.anchor.test = true; store.set('anchor', S.anchor); renderAnchor(); } toast('Dock test on: walk about 50 ft away with the phone.', 4500); }
});
$('panelAnchor').addEventListener('click', (e) => {
  const bt = e.target.closest('[data-bottom]');
  if (bt && !S.anchor) { S.anchorForm.bottom = bt.dataset.bottom; store.set('anchorForm', S.anchorForm); renderAnchor(); return; }
  const rt = e.target.closest('[data-rodetype]');
  if (rt && !S.anchor) { S.anchorForm.rodeType = rt.dataset.rodetype; store.set('anchorForm', S.anchorForm); renderAnchor(); return; }
  const sp = e.target.closest('[data-special]');
  if (sp && S.anchor) { S.anchor.special = sp.dataset.special; store.set('anchor', S.anchor); $('anLights').innerHTML = lightsAdvice(); }
  const rb = e.target.closest('[data-rule]');
  if (rb) { if (!isWide()) setTab('chart'); openRuleSheet(rb.dataset.rule); }
});

/* Log panel */
function renderLog() {
  const p = $('panelLog');
  let h = '<div class="p-head"><div><div class="eyebrow">Log</div><h2>Tracks and waypoints</h2></div></div>';
  h += '<div class="card"><h4>Track recording</h4><div class="li"><div class="li-main" id="recLive"></div><div class="li-btns">' +
    (S.rec.on ? '<button class="btn small danger" data-act="recstop">Stop and save</button>' : '<button class="btn small primary" data-act="recstart">Start recording</button>') + '</div></div></div>';
  h += '<div class="card"><h4>Saved tracks</h4>' + (S.tracks.length ? S.tracks.slice().reverse().map((t) =>
    '<div class="li"><div class="li-main"><b>' + esc(t.name) + '</b><span class="tnum">' + fmtDist(t.dist) + ' · ' + fmtDur((t.end - t.start) / 3600000) + '</span></div><div class="li-btns">' +
    '<button class="btn small primary" data-act="triptrack" data-id="' + t.id + '">Photos and replay</button><button class="btn small" data-act="showtrack" data-id="' + t.id + '">Show</button><button class="btn small" data-act="gpxtrack" data-id="' + t.id + '">GPX</button><button class="btn small" data-act="deltrack" data-id="' + t.id + '">Delete</button></div></div>').join('') :
    '<div class="empty">No saved tracks yet. Start recording before you leave the dock.</div>') + '</div>';
  h += '<div class="card"><h4>Waypoints</h4>' + (S.waypoints.length ? S.waypoints.map((w) =>
    '<div class="li"><div class="li-main" style="flex:1"><input type="text" aria-label="Waypoint name" data-wp="' + w.id + '" value="' + esc(w.name) + '" style="border:0;background:transparent;font:inherit;font-weight:600;color:inherit;padding:0;min-height:28px;width:100%"><span class="tnum">' + ddm(w.lat, true) + ' ' + ddm(w.lon, false) + (S.fix ? ' · ' + fmtDist(distNm(S.fix, w)) : '') + '</span></div><div class="li-btns">' +
    '<button class="btn small primary" data-act="gowp" data-id="' + w.id + '">Go</button><button class="btn small" data-act="delwp2" data-id="' + w.id + '">Delete</button></div></div>').join('') :
    '<div class="empty">Long-press anywhere on the chart to drop a pin and save it.</div>') + '</div>';
  h += '<div class="p-btns"><button class="btn" data-act="gpxall">Export everything as GPX</button>' + (shownTrack.getLatLngs().length ? '<button class="btn" data-act="hidetrack">Hide shown track</button>' : '') + '</div>';
  p.innerHTML = h; renderRecLive();
}
function renderRecLive() {
  const el = $('recLive'); if (!el) return;
  $('recDot').hidden = !S.rec.on;
  if (!S.rec.on) { el.innerHTML = '<b>Not recording</b><span>Records your path while the app is open</span>'; return; }
  const pts = S.rec.pts, dur = pts.length ? (Date.now() - S.rec.start) / 3600000 : 0;
  el.innerHTML = '<b>Recording</b><span class="tnum">' + fmtDist(trackDist(pts)) + ' · ' + fmtDur(dur) + ' · ' + pts.length + ' points</span>';
}
function gpx(tracks, wps) {
  const x = (s) => esc(s);
  let g = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Tideline" xmlns="http://www.topografix.com/GPX/1/1">\n';
  wps.forEach((w) => { g += '<wpt lat="' + w.lat.toFixed(6) + '" lon="' + w.lon.toFixed(6) + '"><name>' + x(w.name) + '</name></wpt>\n'; });
  tracks.forEach((t) => {
    g += '<trk><name>' + x(t.name) + '</name><trkseg>\n';
    t.pts.forEach((p) => { g += '<trkpt lat="' + p[0] + '" lon="' + p[1] + '"><time>' + new Date(p[2]).toISOString() + '</time></trkpt>\n'; });
    g += '</trkseg></trk>\n';
  });
  return g + '</gpx>\n';
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('panelLog').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = +b.dataset.id;
  if (act === 'recstart') { S.rec = { on: true, pts: [], start: Date.now() }; trackLine.setLatLngs([]); if (S.fix) recordPoint(S.fix, true); store.set('rec', S.rec); renderLog(); toast('Recording your track'); }
  if (act === 'recstop') {
    const pts = S.rec.pts;
    if (pts.length > 1) {
      const t = { id: Date.now(), name: new Date(S.rec.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + fmtClock(S.rec.start), start: S.rec.start, end: Date.now(), dist: trackDist(pts), pts };
      S.tracks.push(t); store.set('tracks', S.tracks); toast('Track saved');
    } else toast('Track was too short to save');
    S.rec = { on: false, pts: [], start: null }; store.set('rec', S.rec); trackLine.setLatLngs([]); renderLog();
  }
  const t = S.tracks.find((x) => x.id === id);
  if (act === 'triptrack' && t) { showTrip(t); return; }
  if (act === 'showtrack' && t) { shownTrack.setLatLngs(t.pts.map((p) => [p[0], p[1]])); setTab('chart'); setFollow(false); map.fitBounds(shownTrack.getBounds().pad(0.15)); }
  if (act === 'hidetrack') { shownTrack.setLatLngs([]); renderLog(); }
  if (act === 'gpxtrack' && t) download('tideline-track-' + t.id + '.gpx', gpx([t], []));
  if (act === 'deltrack' && t) { if (!armed(b, 'Tap again')) return; S.tracks = S.tracks.filter((x) => x.id !== id); store.set('tracks', S.tracks); renderLog(); }
  const w = S.waypoints.find((x) => x.id === id);
  if (act === 'gowp' && w) setGoto(w.name, w.lat, w.lon);
  if (act === 'delwp2' && w) { if (!armed(b, 'Tap again')) return; S.waypoints = S.waypoints.filter((x) => x.id !== id); store.set('waypoints', S.waypoints); renderWaypoints(); renderLog(); }
  if (act === 'gpxall') download('tideline-export.gpx', gpx(S.tracks, S.waypoints));
});
$('panelLog').addEventListener('change', (e) => {
  const id = +e.target.dataset.wp; if (!id) return;
  const w = S.waypoints.find((x) => x.id === id); if (!w) return;
  w.name = e.target.value.trim() || w.name; store.set('waypoints', S.waypoints); renderWaypoints();
});

/* Settings panel */
function seg(key, opts) {
  return '<div class="seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-seg="' + key + '" data-val="' + v + '" class="' + (String(S.settings[key]) === String(v) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
}
function sw(key, label, note) {
  return '<div class="set-row"><div class="sr-text"><b>' + label + '</b>' + (note ? '<span>' + note + '</span>' : '') + '</div><label class="switch"><input type="checkbox" data-sw="' + key + '"' + (S.settings[key] ? ' checked' : '') + ' aria-label="' + label + '"><i></i></label></div>';
}
function numRow(key, label, note, toDisplay) {
  return '<div class="set-row"><div class="sr-text"><b>' + label + '</b><span>' + note + '</span></div><input type="number" inputmode="decimal" data-num="' + key + '" value="' + Math.round(toDisplay(S.settings[key]) * 10) / 10 + '" aria-label="' + label + '"></div>';
}

/* where the phone lives: tap a spot on the boat instead of measuring to the bow */
function gpsSpotHtml() {
  const L = S.settings.boatLen || 27, d = Math.min(L, Math.max(0, S.settings.gpsToBow || 0)), x = 20 + (d / L) * 280; // bow at x=20, stern at x=300
  const sail = S.settings.boatType === 'sail';
  const presets = sail ? [['Bow', 0.08], ['Mast', 0.38], ['Cabin', 0.55], ['Cockpit', 0.8]] : [['Bow', 0.08], ['Center console', 0.5], ['Helm', 0.62], ['Stern', 0.92]];
  return '<div class="set-block"><b>Where you keep the phone or GPS</b><span class="note">Tap the spot on your boat. It puts the anchor circle on your bow, not on your phone.</span>' +
    '<svg class="gps-hull" viewBox="0 0 320 90" role="img" aria-label="Tap where the phone is on the boat" data-hull>' +
    '<path d="M20 45 C60 12 200 10 300 20 L300 70 C200 80 60 78 20 45Z" class="hull"/>' + (sail ? '<line x1="126" y1="45" x2="126" y2="4" class="mast"/>' : '') +
    '<text x="22" y="86" class="lbl">bow</text><text x="270" y="86" class="lbl">stern</text>' +
    '<circle cx="' + x.toFixed(0) + '" cy="45" r="11" class="spot"/><path d="M' + x.toFixed(0) + ' 39v12M' + (x - 6).toFixed(0) + ' 45h12" class="spot-x"/></svg>' +
    '<div class="nf-quick" style="margin:4px 0">' + presets.map(([l, f]) => '<button type="button" class="btn small" data-gpsf="' + f + '">' + l + '</button>').join('') + '</div>' +
    '<span class="note tnum">' + fmtLen(d) + ' from the bow, on a ' + fmtLen(L) + ' boat</span></div>';
}
function setGpsSpot(frac) { const L = S.settings.boatLen || 27; S.settings.gpsToBow = Math.round(Math.min(1, Math.max(0, frac)) * L); saveSettings(); renderSettings(); }
$('panelSettings').addEventListener('click', (e) => {
  const pf = e.target.closest('[data-gpsf]'); if (pf) { setGpsSpot(+pf.dataset.gpsf); return; }
  const hull = e.target.closest('[data-hull]'); if (hull) { const r = hull.getBoundingClientRect(), xv = (e.clientX - r.left) / r.width * 320; setGpsSpot((xv - 20) / 280); }
});
function renderSettings() {
  const p = $('panelSettings');
  p.innerHTML = '<div class="p-head"><div><div class="eyebrow">Settings</div><h2>App settings</h2></div><button class="btn small" data-act="toboat">Back to Boat</button></div>' +
    '<div class="card"><h4>Units</h4><div class="set-row"><div class="sr-text"><b>Speed</b></div></div>' + seg('speedUnit', [['kn', 'Knots'], ['mph', 'mph'], ['kmh', 'km/h']]) +
    '<div class="set-row"><div class="sr-text"><b>Distance</b></div></div>' + seg('distUnit', [['nm', 'Nautical mi'], ['mi', 'Miles'], ['km', 'Km']]) + '<div style="height:12px"></div></div>' +
    '<div class="card"><h4>Your boat</h4>' +
    '<div class="set-row"><div class="sr-text"><b>Boat type</b><span>Used by the rules coach</span></div></div>' + seg('boatType', [['sail', 'Sailboat'], ['power', 'Powerboat']]) +
    '<div class="set-row"><div class="sr-text"><b>Boat name</b><span>Used in radio scripts</span></div><input type="text" data-text="boatName" value="' + esc(S.settings.boatName) + '" placeholder="Name" aria-label="Boat name" style="width:150px;min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;font-size:16px;padding:0 10px"></div>' +
    numRow('boatLen', 'Boat length (' + lenUnit() + ')', 'Used for the anchor circle', ftToLen) +
    gpsSpotHtml() +
    numRow('cruise', 'Usual speed (' + SPEED_LBL[S.settings.speedUnit] + ')', 'Your normal speed under power. Used to estimate arrival times when you are planning or not moving yet', speedOut) +
    numRow('bridgeMargin', 'Bridge safety margin (' + lenUnit() + ')', 'Warns when a bridge leaves less room than this over your air draft', ftToLen) + '</div>' +
    '<div class="card"><h4>Captain\'s coach</h4><div class="set-row"><div class="sr-text"><b>How the coach speaks up</b><span>Off: no tips. Chime: a gentle ding-ding and a card you can tap for more. Spoken: a calm voice too, like turn-by-turn directions.</span></div></div>' + seg('coachMode', [['off', 'Off'], ['chime', 'Chime'], ['voice', 'Spoken']]) + '<div style="height:10px"></div><div class="row-btns"><button class="btn" data-act="testvoice">Test the sound</button>' + (('speechSynthesis' in window) ? '<div class="field" style="margin-top:8px"><label for="voicePick">Voice</label><select id="voicePick"><option value="">Best on this device' + (bestVoice() ? ' (' + esc(bestVoice().name) + ')' : '') + '</option>' + voiceOptions().map((v) => '<option value="' + esc(v.name) + '"' + (S.settings.voiceName === v.name ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('') + '</select><p class="hint" style="margin:4px 0 0">For a more natural voice on iPhone or Mac: Settings › Accessibility › Spoken Content › Voices › English, and download an Enhanced or Premium voice. Then pick it here.</p></div>' : '') + '</div><div style="height:10px"></div>' +
    '<p class="hint" style="margin:0 0 12px">Live AIS needs the app-store version with an AIS receiver or feed. Demo mode shows simulated traffic so you can try the coach.</p></div>' +
    '<div class="card"><h4>Display</h4><div class="set-row"><div class="sr-text"><b>Light</b><span>Auto switches day, dusk and red night at civil twilight</span></div></div>' + seg('theme', [['auto', 'Auto'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']]) + '<div style="height:10px"></div>' + sw('keepAwake', 'Keep screen on', 'Recommended underway and at anchor') +
    '<div class="set-row"><div class="sr-text"><b>Cockpit display</b><span>Huge numbers for an iPad or spare phone mounted on deck. Taps are locked; press and hold to exit.</span></div></div><div class="row-btns"><button class="btn" data-act="cockpit">Open cockpit display</button></div><div style="height:12px"></div></div>' +
    '<div class="card"><h4>Offline charts</h4><div class="set-row"><div class="sr-text"><b>Save this area</b><span>Downloads the NOAA chart for the area you see now plus 3 closer zoom levels, so it works without signal. Satellite and street maps need signal.</span></div></div>' +
    '<div class="row-btns"><button class="btn primary" data-act="offline">Save charts for this area</button><button class="btn" data-act="offlineclear">Clear saved charts</button></div>' +
    '<div id="offStatus" class="hint" style="margin:10px 0 4px"></div><div class="progress" id="offBarWrap" hidden><i id="offBar"></i></div><div style="height:12px"></div></div>' +
    '<div class="card"><h4>Demo mode</h4>' + sw('sim', 'Simulate a sail', 'Fake GPS: a trip from Annapolis to the Magothy. Try everything from your couch.') +
    '<div class="set-row"><div class="sr-text"><b>Demo speed</b></div></div>' + seg('simRate', [[1, 'Real time'], [5, '5×'], [20, '20×']]) + '<div style="height:12px"></div></div>' +
    '<div class="card"><h4>About</h4><p class="hint">Tideline prototype 0.1. A navigation aid, not a replacement for official charts, a proper lookout or good seamanship. ' +
    'Charts from NOAA Office of Coast Survey; tides from NOAA CO-OPS; wind from Open-Meteo; imagery from Esri; street map from OpenStreetMap; seamarks from OpenSeaMap.</p>' +
    '<div class="row-btns" style="margin-bottom:12px"><button class="btn" data-act="resetall">Erase all Tideline data</button></div></div>';
  offlineCount();
}
$('panelSettings').addEventListener('click', async (e) => {
  const sb = e.target.closest('[data-seg]');
  if (sb) {
    const k = sb.dataset.seg, v = sb.dataset.val; S.settings[k] = k === 'simRate' ? +v : v; saveSettings();
    if (k === 'theme') { applyNight(); updateBoat(); }
    if (k === 'coachMode') { syncCoach(); if (v !== 'off') { unlockSound(); v === 'voice' ? speak('Coach on. I will speak up only when it matters.') : chime(); } }
    renderSettings(); renderStrip(); renderChips(); updateGoto(); renderModeChip(); updateAis();
    return;
  }
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'toboat') setTab('boat');
  if (b.dataset.act === 'testvoice') { unlockSound(); audio(); if (S.settings.coachMode === 'voice') speak('This is the Tideline coach. Sound is working.'); else chime(); }
  if (b.dataset.act === 'offline') saveOffline();
  if (b.dataset.act === 'offlineclear') { if ('caches' in window) await caches.delete('tl-tiles'); offlineCount(); toast('Saved charts cleared'); }
  if (b.dataset.act === 'resetall') {
    if (!armed(b, 'Tap again to erase everything')) return;
    try { Object.keys(localStorage).filter((k) => k.startsWith('tl.')).forEach((k) => localStorage.removeItem(k)); } catch (err) { /* ignore */ }
    location.reload();
  }
});
$('panelSettings').addEventListener('change', (e) => {
  if (e.target.id === 'voicePick') { S.settings.voiceName = e.target.value; saveSettings(); const was = S.settings.voice; S.settings.voice = true; speak('This is the Tideline voice.'); S.settings.voice = was; return; }
  const swk = e.target.dataset.sw, nk = e.target.dataset.num, tk = e.target.dataset.text;
  if (tk) { S.settings[tk] = e.target.value.trim(); saveSettings(); }
  if (swk) {
    S.settings[swk] = e.target.checked; saveSettings();
    if (swk === 'night') applyNight();
    if (swk === 'keepAwake') wake();
    if (swk === 'aisCoach') updateAis();
    if (swk === 'sim') { ais.clear(); demoAisAt = 0; S.sog = null; S.cog = null; S.fix = null; startGPS(); if (S.settings.sim) { map.setView([SIM_ROUTE[0][0], SIM_ROUTE[0][1]], 15); setFollow(true); } }
  }
  if (nk) {
    const v = parseFloat(e.target.value); if (!(v > 0)) return;
    S.settings[nk] = nk === 'cruise' ? v / speedOut(1) : lenToFt(v); saveSettings();
  }
});
function sunElev(lat, lon, t) { // degrees above the horizon (NOAA approximation, good to about a degree)
  const d = new Date(t), jd = t / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L0 = (280.46 + 0.9856474 * n) % 360, g = rad((357.528 + 0.9856003 * n) % 360);
  const lam = rad(L0 + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)), eps = rad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)), ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24, ha = rad(gmst * 15 + lon) - ra;
  void d;
  return deg(Math.asin(Math.sin(rad(lat)) * Math.sin(dec) + Math.cos(rad(lat)) * Math.cos(dec) * Math.cos(ha)));
}
function themeNow() {
  const th = S.settings.theme || 'auto'; if (th !== 'auto') return th;
  const p = S.fix || store.get('lastPos', null) || { lat: 38.97, lon: -76.48 };
  const e = sunElev(p.lat, p.lon, Date.now());
  return e > 4 ? 'day' : e > -6 ? 'dusk' : 'night';
}
function applyNight() {
  const th = themeNow(), root = document.documentElement;
  S.settings.night = th === 'night';
  root.toggleAttribute('data-night', th === 'night'); root.toggleAttribute('data-dusk', th === 'dusk');
  renderThemeBtn(th);
  document.querySelector('meta[name=theme-color]').setAttribute('content', th === 'night' ? '#0A0202' : th === 'dusk' ? '#0F1A25' : '#0B1824');
}
setInterval(() => { if ((S.settings.theme || 'auto') === 'auto') applyNight(); }, 60000);


/* quick day / dusk / night switch on the chart, and a quick sheet with settings one tap away */
const THEME_ICON = {
  day: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  dusk: '<path d="M3 17h18M6 13a6 6 0 0112 0"/><path d="M12 3v3M4.2 6.2l2 2M19.8 6.2l-2 2M8 21h8"/>',
  night: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
};
function renderThemeBtn(th) {
  const b = $('btnTheme'), ic = $('themeIcon'); if (!b || !ic) return;
  ic.innerHTML = THEME_ICON[th] || THEME_ICON.day;
  b.setAttribute('aria-label', 'Colors: ' + th + ((S.settings.theme || 'auto') === 'auto' ? ' (automatic)' : '') + '. Tap to change.');
}
$('btnTheme').addEventListener('click', () => {
  const cur = S.settings.theme || 'auto', now = themeNow();
  // cycle Day -> Dusk -> Night -> Auto, starting from what is on screen now
  const next = cur === 'auto' ? ({ day: 'dusk', dusk: 'night', night: 'day' })[now] : cur === 'day' ? 'dusk' : cur === 'dusk' ? 'night' : 'auto';
  S.settings.theme = next; saveSettings(); applyNight(); updateBoat();
  toast(next === 'auto' ? 'Colors: automatic (switches at twilight, now ' + themeNow() + ')' : 'Colors: ' + next + '. Tap again to change.', 2200);
});


/* ---------- fishing spots: one tap saves the spot with the conditions at that moment ---------- */
S.spots = store.get('spots', []);
const spotLayer = L.layerGroup().addTo(map);
const FISH_SVG = '<path d="M3 12c3-4 7-5 11-5 3 0 5 2 6 5-1 3-3 5-6 5-4 0-8-1-11-5z"/><path d="M3 12l-1-3M3 12l-1 3"/><circle cx="16" cy="11" r="1"/>';
function applyUseMode() {
  const m = S.settings.useMode || 'cruise';
  $('btnFish').hidden = m !== 'fish';
  document.documentElement.dataset.use = m;
  drawSpots();
}
function drawSpots() {
  spotLayer.clearLayers();
  S.spots.forEach((sp) => {
    const mk = L.marker([sp.lat, sp.lon], { icon: L.divIcon({ className: 'spot-pin', iconSize: [28, 28], iconAnchor: [14, 14], html: '<svg viewBox="0 0 24 24" aria-hidden="true">' + FISH_SVG + '</svg>' }), zIndexOffset: 600 });
    mk.on('click', () => openSpot(sp));
    spotLayer.addLayer(mk);
  });
}
function conditionsNow() {
  const w = S.weather, tn = tideNow(), ob = nearestObs();
  return {
    tide: tn ? { v: tn.v, rising: tn.rising, next: tn.next ? { type: tn.next.type, t: tn.next.t } : null } : null,
    wind: ob ? { dir: ob.dir, spd: ob.spd } : w && w.cur ? { dir: w.cur.dir, spd: w.cur.spd } : null,
    water: S.waterObs ? S.waterObs.f : w && w.sst != null ? w.sst : null, air: w && w.cur ? w.cur.temp : null,
  };
}
function spotSummary(sp) {
  const c = sp.cond || {}, bits = [];
  if (c.tide) bits.push('Tide ' + tideLen(c.tide.v) + (c.tide.rising == null ? '' : c.tide.rising ? ' rising' : ' falling'));
  if (c.wind) bits.push(compass16(c.wind.dir) + ' ' + Math.round(speedOut(c.wind.spd)) + ' ' + SPEED_LBL[S.settings.speedUnit]);
  if (c.water != null) bits.push('water ' + tempTxt(c.water));
  return bits.join(' · ');
}
function markFish() {
  if (!S.fix) { toast('Waiting for GPS before marking a spot.'); return; }
  const sp = { id: Date.now(), lat: S.fix.lat, lon: S.fix.lon, t: Date.now(), species: '', notes: '', cond: conditionsNow() };
  S.spots.push(sp); store.set('spots', S.spots); drawSpots();
  if (navigator.vibrate) navigator.vibrate(30);
  openSpot(sp, true);
}
function openSpot(sp, fresh) {
  S.sheetPoint = { p: { lat: sp.lat, lon: sp.lon }, wp: null, spot: sp };
  const d = new Date(sp.t);
  openSheet('<h3>' + (fresh ? 'Spot saved' : esc(sp.species || 'Fishing spot')) + '</h3><div class="sub tnum">' + d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' + ddm(sp.lat, true) + ' ' + ddm(sp.lon, false) + '</div>' +
    '<p class="sub" style="margin:6px 0 10px">' + esc(spotSummary(sp) || 'Conditions not available') + '</p>' +
    '<div class="field"><label for="spSpecies">What you caught</label><input id="spSpecies" value="' + esc(sp.species) + '" placeholder="Rockfish, 24 in"></div>' +
    '<div class="field"><label for="spNotes">Notes</label><input id="spNotes" value="' + esc(sp.notes) + '" placeholder="Bait, depth, lure, structure"></div>' +
    '<div class="row-btns"><button class="btn primary" data-act="spsave">Save</button><button class="btn" data-act="goto">Navigate to</button><button class="btn" data-act="spdel">Delete</button></div>' +
    '<p class="hint">Your spots stay private on this device.</p>');
}
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !S.sheetPoint || !S.sheetPoint.spot) return;
  const sp = S.sheetPoint.spot;
  if (b.dataset.act === 'spsave') { sp.species = $('spSpecies').value.trim(); sp.notes = $('spNotes').value.trim(); store.set('spots', S.spots); closeSheet(); toast('Spot saved'); }
  if (b.dataset.act === 'spdel') { if (!armed(b, 'Tap again to delete')) return; S.spots = S.spots.filter((x) => x.id !== sp.id); store.set('spots', S.spots); drawSpots(); closeSheet(); }
});
$('btnFish').addEventListener('click', markFish);

/* ---------- offline chart saving ---------- */
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = rad(lat); return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
function tileUrl(key, x, y, z) {
  if (key === 'noaa') return noaaUrl(x, y, z, false);
  if (key === 'noaaOver') return noaaUrl(x, y, z, true);
  return L.Util.template(LAYERS[key]._url, { x, y, z, s: 'a', r: '' });
}
async function askPersist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* not supported */ }
}
async function persistNote() {
  try { if (navigator.storage && navigator.storage.persisted) return (await navigator.storage.persisted()) ? ' Kept permanently on this device.' : ' Your browser may clear them if storage runs low; add Tideline to your home screen to keep them.'; } catch (e) { /* ignore */ }
  return '';
}
async function offlineCount() {
  const el = $('offStatus'); if (!el) return;
  if (!('caches' in window)) { el.textContent = 'This browser cannot save charts offline.'; return; }
  try { const c = await caches.open('tl-tiles'); const n = (await c.keys()).length; el.textContent = n ? n + ' chart tiles saved on this device.' + (await persistNote()) : 'No charts saved yet.'; } catch (e) { el.textContent = ''; }
}
let offBusy = false;
async function saveOffline() {
  if (offBusy) return;
  if (!('caches' in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) { toast('Open Tideline from its web address (and reload once) to save charts offline.', 4500); return; }
  const b = map.getBounds(), z0 = Math.max(map.getZoom(), 8), z1 = Math.min(z0 + 3, 18);
  // Only the NOAA chart is saved: OpenStreetMap and Esri tiles may not be stored for offline use.
  let keys = chartLayerKeys().filter((k) => k.startsWith('noaa'));
  if (!keys.length) keys = ['noaa'];
  const jobs = [];
  await askPersist();
  for (let z = z0; z <= z1; z++) {
    const x0 = lon2x(b.getWest(), z), x1 = lon2x(b.getEast(), z), y0 = lat2y(b.getNorth(), z), y1 = lat2y(b.getSouth(), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.forEach((k) => jobs.push(tileUrl(k, x, y, z)));
  }
  if (jobs.length > 6000) { toast('That area needs ' + jobs.length + ' tiles. Zoom in a little and try again.', 4500); return; }
  offBusy = true; $('offBarWrap').hidden = false;
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const url = jobs[i++];
      try { await fetch(url, { mode: 'no-cors' }); } catch (e) { failed++; }
      done++;
      if (done % 10 === 0 || done === jobs.length) { const bar = $('offBar'), st = $('offStatus'); if (bar) bar.style.width = (100 * done / jobs.length) + '%'; if (st) st.textContent = 'Saving ' + done + ' of ' + jobs.length + ' tiles…'; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  offBusy = false; const w = $('offBarWrap'); if (w) w.hidden = true;
  toast(failed ? 'Saved, but ' + failed + ' tiles failed. Try again with signal.' : 'Charts saved for offline use');
  offlineCount();
}

/* ---------- demo mode (simulated GPS) ---------- */
const SIM_ROUTE = [[38.9772, -76.4818], [38.9735, -76.4690], [38.9640, -76.4450], [38.9850, -76.4200], [39.0300, -76.4050], [39.0560, -76.4170], [39.0640, -76.4400], [39.0705, -76.4620]];
let simTimer = null;
const sim = { i: 0, pos: null };
function startSim() {
  stopSim();
  if (!sim.pos) sim.pos = { lat: SIM_ROUTE[0][0], lon: SIM_ROUTE[0][1] };
  setGps('good', 'Demo GPS');
  simTimer = setInterval(simStep, 1000); simStep();
}
function stopSim() { if (simTimer) clearInterval(simTimer); simTimer = null; }
function simStep() {
  const rate = S.settings.simRate || 1, kn = 6;
  let speed = 0, heading = null;
  if (S.anchor) {
    if (S.simDrag) { sim.pos = destination(sim.pos, 200, (0.7 * rate) / M_PER_NM); speed = 0.7; heading = 200; }
    else {
      const t = Date.now() / 60000, sw = 70 / FT_PER_NM; // gentle swing around the anchor
      const c = { lat: S.anchor.lat, lon: S.anchor.lon };
      sim.pos = destination(c, 20 + 40 * Math.sin(t), sw);
    }
  } else if (sim.i < SIM_ROUTE.length - 1) {
    let step = (kn * rate) / 3600;
    while (step > 0 && sim.i < SIM_ROUTE.length - 1) {
      const nx = { lat: SIM_ROUTE[sim.i + 1][0], lon: SIM_ROUTE[sim.i + 1][1] }, d = distNm(sim.pos, nx);
      heading = bearing(sim.pos, nx);
      if (d <= step) { sim.pos = nx; sim.i++; step -= d; } else { sim.pos = destination(sim.pos, heading, step); step = 0; }
    }
    speed = kn;
  }
  const n = () => (Math.random() - 0.5) * 4 / 111000; // about ±2 m of GPS noise
  onFix({ lat: sim.pos.lat + n(), lon: sim.pos.lon + n(), acc: 5, speed: speed / KN_PER_MS, heading, t: Date.now() });
}

/* ---------- Rules of the Road: library ---------- */
const RULES = window.TL_RULES || [];
const ruleLabel = (r) => (r.n === 'VHF' ? 'Radio' : 'Rule ' + r.n);
const ruleSummary = (r) => r.p.map((x) => x[2]).join(' ');
const ruleBase = (cite) => String(cite).split('(')[0];
const citeLabel = (cite) => (cite === 'VHF' ? 'Radio' : 'Rule ' + cite);
const DISCLAIMER = 'Tideline\'s plain-language reading of the Navigation Rules, not the official text. AIS can be late, wrong or missing, and many boats don\'t carry it. You are responsible for following the Rules and keeping a look-out.';
function openRuleSheet(cite) {
  const r = RULES.find((x) => x.n === ruleBase(cite)); if (!r) return;
  const focus = String(cite) !== r.n ? String(cite) : null;
  const parts = r.p.map((x) => {
    const hit = focus && x[0] === focus;
    return '<div style="display:grid;grid-template-columns:auto 1fr;gap:10px;padding:10px 12px;border-radius:12px;margin-bottom:6px;' + (hit ? 'background:var(--amber-bg);border:1px solid var(--amber)' : 'background:var(--surface2)') + '">' +
      '<b class="tnum" style="white-space:nowrap">' + esc(x[0]) + '</b><span style="font-size:14.5px;line-height:1.5">' + esc(x[2]) +
      (x[1] ? ' <span class="badge" style="margin-left:4px;' + (x[1] === 'Inland' ? '' : 'background:#E8E6F7;color:#3E2E8C') + '">' + (x[1] === 'Inland' ? 'Inland Rules' : 'International only') + '</span>' : '') + '</span></div>';
  }).join('');
  openSheet('<h3>' + ruleLabel(r) + ' · ' + esc(r.t) + '</h3><div class="sub">Plain-language summary, by subsection' + (focus ? ' · ' + esc(citeLabel(focus)) + ' highlighted' : '') + '</div>' + parts +
    '<div class="row-btns" style="margin-top:10px"><a class="btn" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="' + window.TL_RULES_URL + '" target="_blank" rel="noopener">Official text (USCG)</a><button class="btn ghost" data-act="close">Close</button></div>' +
    '<p class="disclaim">' + DISCLAIMER + ' Chesapeake Bay and most US harbors are inside the COLREGS demarcation lines, where the Inland Rules (33 CFR Part 83) apply; offshore, the International Rules apply. Subsections marked "Inland Rules" or "International only" differ between the two.</p>');
}
function ruleMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return RULES.map((r) => {
    const hay = (r.n + ' rule ' + r.t + ' ' + r.k + ' ' + r.p.map((x) => x[0] + ' ' + x[2]).join(' ')).toLowerCase();
    const score = words.reduce((a, w) => a + (hay.includes(w) ? (r.k.includes(w) || r.t.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
    return { r, score, all: words.every((w) => hay.includes(w)) };
  }).filter((x) => x.all && x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.r);
}
function renderRuleResults(list) {
  $('ruleResults').innerHTML = list.slice(0, 6).map((r) =>
    '<button type="button" class="res" data-rule="' + r.n + '"><span class="rule-num">' + (r.n === 'VHF' ? '16' : r.n) + '</span>' +
    '<span class="res-main"><b>' + ruleLabel(r) + ' · ' + esc(r.t) + '</b><span>' + esc(ruleSummary(r)) + '</span></span></button>').join('');
}

/* ---------- AIS and the rules coach ---------- */
const NAV_STATUS = { 2: 'not under command', 3: 'restricted in ability to maneuver', 4: 'constrained by its draft', 7: 'engaged in fishing' };
const ais = new Map();
const aisLayer = L.layerGroup().addTo(map);
let coachMuteUntil = 0, coachTarget = null, lastCoachAlert = 0;
const windFrom = () => (S.weather && S.weather.cur ? S.weather.cur.dir : 225);
const ownSailing = () => S.settings.boatType === 'sail' && S.settings.underSail;
function tackOf(cog, wind) {
  const a = ((wind - cog) % 360 + 360) % 360;
  if (a < 30 || a > 330) return null; // head to wind: no tack
  return a < 180 ? 'starboard' : 'port';
}
const relBearing = (from, cog, to) => ((bearing(from, to) - cog) % 360 + 360) % 360;
function cpaOf(o, t) {
  const kx = Math.cos(rad(o.lat)) * 60;
  const rx = (t.lon - o.lon) * kx, ry = (t.lat - o.lat) * 60;
  const ov = [o.sog * Math.sin(rad(o.cog)), o.sog * Math.cos(rad(o.cog))], tv = [t.sog * Math.sin(rad(t.cog)), t.sog * Math.cos(rad(t.cog))];
  const vx = tv[0] - ov[0], vy = tv[1] - ov[1], v2 = vx * vx + vy * vy;
  const tc = v2 < 1e-6 ? 0 : -(rx * vx + ry * vy) / v2;
  return { cpa: Math.hypot(rx + vx * Math.max(tc, 0), ry + vy * Math.max(tc, 0)), tcpa: tc, range: Math.hypot(rx, ry) };
}
function evaluate(t) {
  const f = S.fix; if (!f) return null;
  const o = { lat: f.lat, lon: f.lon, sog: S.sog || 0, cog: S.cog == null ? 0 : S.cog };
  const c = cpaOf(o, t);
  const rbT = relBearing(o, o.cog, t), rbO = relBearing(t, t.cog, o);
  const W = windFrom(), sail = ownSailing(), tSail = t.type === 'sail' || t.status === 8;
  const res = { t, cpa: c.cpa, tcpa: c.tcpa, range: c.range, brg: bearing(o, t), rules: [], todo: [], hail: null };
  // bearing trend (Rule 7)
  const h = t.hist.filter((x) => x.time > Date.now() - 90000);
  if (h.length >= 3) {
    const db = Math.abs(((h[h.length - 1].brg - h[0].brg + 540) % 360) - 180), dr = h[h.length - 1].range - h[0].range;
    res.steady = db < 3 && dr < -0.02;
  }
  const risk = c.tcpa > 0.008 && ((c.tcpa < 0.33 && c.cpa < 0.25) || (res.steady && c.range < 1.5));
  if (!risk) return Object.assign(res, { level: 'none' });
  res.age = Math.round((Date.now() - (t.seen || Date.now())) / 1000);
  if (res.age > 180) return Object.assign(res, { level: 'caution', role: 'check', head: 'Advice paused: the last AIS report from ' + (t.name || 'this vessel') + ' is ' + Math.round(res.age / 60) + ' min old.', rules: ['5', '7(b)'], todo: ['Keep a proper lookout by sight and hearing (Rule 5). Old AIS positions can be far off.'] });
  res.level = c.cpa < 0.08 && c.tcpa < 0.1 ? 'danger' : 'caution';
  const name = t.name || 'the other vessel';
  const typeWord = t.type === 'ship' ? 'ship' : tSail ? 'sailboat' : t.type === 'fishing' ? 'fishing boat' : 'powerboat';
  const side = rbT < 180 ? 'starboard' : 'port';
  const giveWay = (head, rules, todo) => Object.assign(res, { role: 'give', head, rules, todo });
  const standOn = (head, rules, todo) => Object.assign(res, { role: 'stand', head, rules, todo });
  const GIVE_TODO = ['Act now and make it obvious: a clear turn, usually to starboard, or slow right down (Rules 16 and 8(b)).', 'Pass astern of ' + name + '. Do not cross ahead (Rule 15(a) for power vessels crossing).', 'Keep watching until it is past and clear (Rule 8(d)).'];
  const STAND_TODO = ['Hold your course and speed so ' + name + ' can predict you (Rule 17(a)(i)).', 'If it is not giving way, sound five short blasts (Rule 34(d)) and call it on the radio. You may then act (Rule 17(a)(ii)).', 'If a collision can\'t be avoided by its action alone, you must act (Rule 17(b)). Avoid turning to port for a boat on your port side (Rule 17(c)).'];
  if (rbT > 112.5 && rbT < 247.5 && t.sog > o.sog) standOn(typeWord[0].toUpperCase() + typeWord.slice(1) + ' overtaking you. It must keep clear.', ['13(a)', '13(b)', '17(a)(i)'], STAND_TODO);
  else if (rbO > 112.5 && rbO < 247.5 && o.sog > t.sog) giveWay('You are overtaking ' + name + '. You keep clear.', ['13(a)', '13(d)', '16'], ['Pass with plenty of room, and agree the side by radio (Inland Rule 34(h)) or sound signal (Rule 34(c)) if it is tight.', 'Stay clear until you are well past and clear (Rule 13(d)).']);
  else if (NAV_STATUS[t.status] && !(sail && tSail)) giveWay(name + ' is ' + NAV_STATUS[t.status] + '. Keep out of its way.', t.status === 4 ? ['18(d)', '3(h)'] : [sail ? '18(b)' : '18(a)', t.status === 7 ? '3(d)' : t.status === 3 ? '3(g)' : '3(f)', '16'], GIVE_TODO);
  else if (t.type === 'ship' && t.len >= 50) giveWay('Large ship. You must not impede it.', ['9(b)', '9(d)', '8(f)'], ['Get out of the channel or well to the side of its track, early (Rules 9(b) and 8(f)).', 'Don\'t cross ahead of it in the channel (Rule 9(d)). A ship can take a mile or more to stop.', 'If unsure, call it on VHF 13 (33 CFR Part 26) or 16.']);
  else if (sail && tSail) {
    const myTack = tackOf(o.cog, W), itsTack = tackOf(t.cog, W);
    res.tacks = { mine: myTack, its: itsTack };
    if (myTack && itsTack) {
      // Tack comes from forecast wind and AIS course: an estimate, so it never assigns right of way by itself.
      let est;
      if (myTack !== itsTack) est = myTack === 'port' ? 'you on port tack, it on starboard: you would keep clear' : 'you on starboard tack, it on port: it would keep clear';
      else {
        const up = [Math.sin(rad(W)), Math.cos(rad(W))];
        const rx = (t.lon - o.lon) * Math.cos(rad(o.lat)), ry = t.lat - o.lat;
        est = rx * up[0] + ry * up[1] > 0 ? 'same tack with it to windward: it would keep clear' : 'same tack with you to windward: you would keep clear';
      }
      Object.assign(res, { role: 'check', head: 'Sailboat converging. Its tack is estimated, so right of way can\'t be assigned yet.', rules: ['12(a)', '12(a)(iii)', '16'],
        todo: ['Look at its sails: a boat with its boom on its starboard side is on port tack, and a port-tack boat keeps clear of a starboard-tack boat (Rule 12(a)(i)). If you can\'t tell, keep clear (Rule 12(a)(iii)).', 'Estimate only, from forecast wind: ' + est + '.', 'Make any change early and obvious (Rule 8(b)).'] });
    } else giveWay('Sailboat close by and its tack is unclear. Keep clear to be safe.', ['12(a)(iii)', '16'], GIVE_TODO);
  } else if (sail && !tSail) standOn('Powerboat crossing. As a sailboat you are usually stand-on, but watch it closely.', ['18(a)', '17(a)(i)', '17(b)'], STAND_TODO.concat(['Many powerboats don\'t give way. Be ready to act early (Rule 17(a)(ii)).']));
  else if (!sail && tSail) giveWay('Sailboat. Under power, you keep clear of it.', ['18(a)', '3(c)', '16'], GIVE_TODO);
  else if ((rbT < 8 || rbT > 352) && angDiff(o.cog, t.cog) > 168) Object.assign(res, { role: 'both', head: 'Head-on with ' + name + '. Both boats turn to starboard.', rules: ['14(a)', '14(c)', '8(b)'], todo: ['Turn to starboard now, clearly, so you pass port to port (Rule 14(a)).', 'One short blast: Inland, "I intend to leave you on my port side" (Inland Rule 34(a)(i)); International, "I am altering to starboard" (Rule 34(a)).'] });
  else if (side === 'starboard') giveWay('Crossing from your starboard side. You give way.', ['15(a)', '16'], GIVE_TODO);
  else standOn('Crossing from your port side. It gives way.', ['15(a)', '17(a)(i)', '17(c)'], STAND_TODO);
  if (sail && tSail) res.assume = 'Assuming both boats are under sail and neither is motoring. AIS can\'t tell whether its engine is on. Tack is from the ' + (S.weather ? 'forecast' : 'assumed') + ' wind (' + compass16(W) + ').';
  else if (tSail && !sail) res.assume = 'Assuming it is under sail. If it is motoring, it is a power-driven vessel.';
  else if (!tSail && t.type !== 'ship') res.assume = 'Based on what its AIS reports. Check its lights or shapes to confirm.';
  res.todo = res.todo.concat(['Whoever has right of way, every skipper must act to avoid a collision. Show your intentions early and clearly (Rules 2(a), 8(a), 17(b)).']);
  res.rules = res.rules.concat(['2(a)', '8(a)']);
  if (!sail && S.settings.boatType === 'sail') res.note = 'You are motoring, so the Rules treat you as a power-driven vessel even with sails up (Rule 3(b) and 3(c)).';
  if (res.steady) res.rules.push('7(d)(i)');
  res.hail = (t.type === 'ship' ? 'VHF 13 or 16' : 'VHF 16') + ': "' + (t.name || 'Vessel') + ', ' + (t.name ? '' : typeWord + ' ') + 'this is the ' + (S.settings.boatType === 'sail' ? 'sailboat' : 'boat') + (S.settings.boatName ? ' ' + S.settings.boatName : '') + ', about ' + fmtDist(c.range) + ' off your ' + (rbO < 180 ? 'starboard' : 'port') + ' side. ' + (res.role === 'give' || res.role === 'check' ? 'What are your intentions? I can pass astern of you.' : res.role === 'both' ? 'I am turning to starboard, port to port.' : 'I am holding course and speed. Please confirm your intentions.') + ' Over."';
  return res;
}
function aisIcon(t, level) {
  const col = level === 'danger' ? '#D64545' : level === 'caution' ? '#E8952B' : t.type === 'ship' ? '#5B6B7A' : t.type === 'sail' ? '#6B4FBB' : '#3D7D9C';
  const big = t.type === 'ship';
  const path = big ? 'M12 1 L17 7 L17 25 L7 25 L7 7 Z' : 'M12 3 L18 23 L12 19 L6 23 Z';
  return L.divIcon({ className: 'ais-icon', iconSize: [24, 26], iconAnchor: [12, 13], html: '<svg width="24" height="26" viewBox="0 0 24 26"><g transform="rotate(' + t.cog + ' 12 13)"><path d="' + path + '" fill="' + col + '" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></g></svg>' });
}
function updateAis() {
  aisLayer.clearLayers();
  if (!S.fix || S.settings.aisShow === false) { $('coachCard').hidden = true; return; }
  let worst = null;
  ais.forEach((t) => {
    const r = evaluate(t); t.eval = r;
    if (r && r.level !== 'none') { const score = (r.level === 'danger' ? 0 : 10) + r.tcpa * 10; if (!worst || score < worst.score) worst = { r, score }; }
    const m = L.marker([t.lat, t.lon], { icon: aisIcon(t, r ? r.level : 'none'), zIndexOffset: 800 });
    m.bindTooltip(esc(t.name || 'AIS target'), { permanent: true, direction: 'right', offset: [12, 0], className: 'ais-label' });
    m.on('click', () => openAisSheet(t));
    aisLayer.addLayer(m);
    if (r && r.level !== 'none' && r.tcpa > 0) {
      const ahead = (pos, cog, sog) => destination(pos, cog, sog * r.tcpa);
      const a = ahead(t, t.cog, t.sog), b = ahead(S.fix, S.cog || 0, S.sog || 0);
      aisLayer.addLayer(L.polyline([[t.lat, t.lon], [a.lat, a.lon]], { color: r.level === 'danger' ? C.red : C.amber, weight: 2, dashArray: '4 5', interactive: false }));
      aisLayer.addLayer(L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: r.level === 'danger' ? C.red : C.amber, weight: 1.5, opacity: 0.7, interactive: false }));
    }
  });
  coachTarget = worst && S.settings.aisCoach ? worst.r : null;
  renderCoach();
}
const coachDismissed = new Set();
function renderCoach() {
  const card = $('coachCard'), r = coachTarget;
  if (!r || Date.now() < coachMuteUntil || (coachDismissed.has(r.t.mmsi) && r.level !== 'danger')) { card.hidden = true; return; }
  voiceCoach(r);
  if (r.level === 'danger' && Date.now() - lastCoachAlert > 30000) { lastCoachAlert = Date.now(); beep(3); if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([200, 100, 200]); }
  const roleTxt = r.role === 'give' ? 'LIKELY GIVE-WAY' : r.role === 'stand' ? 'LIKELY STAND-ON' : r.role === 'check' ? 'CHECK BY EYE' : 'BOTH TURN';
  card.className = 'coach' + (r.level === 'danger' ? ' danger' : r.role === 'stand' ? ' stand' : '');
  card.hidden = false;
  card.innerHTML = '<button type="button" class="card-x" data-act="coachx" aria-label="Close">&times;</button><div class="coach-top"><span class="role' + (r.level === 'danger' ? ' danger' : r.role === 'stand' ? ' stand' : '') + '">' + roleTxt + '</span>' +
    '<span class="tnum" style="font-size:13px;color:var(--ink2)">' + esc(r.t.name || 'AIS') + ' · CPA ' + fmtDist(r.cpa) + ' in ' + fmtDur(r.tcpa) + '</span></div>' +
    '<div class="coach-head">' + esc(r.head) + ' <span style="font-weight:500;color:var(--ink2);font-size:13px;white-space:nowrap">' + esc(citeLabel(r.rules[0])) + '</span></div>' +
    '<div class="coach-text">' + esc(r.todo[0]) + (r.steady ? ' Bearing steady and range closing.' : '') + '</div>' +
    '<div class="coach-text" style="font-size:12px;font-style:italic">' + esc((r.assume ? r.assume + ' ' : '') + 'AIS report ' + (r.age != null ? (r.age < 60 ? r.age + ' s' : Math.round(r.age / 60) + ' min') : '') + ' old.') + '</div>' +
    '<div class="coach-btns"><button class="btn small primary" data-act="coachmore">What to do</button><button class="btn small" data-act="coachmute">Mute 5 min</button></div>';
}
function openAisSheet(t) {
  const r = t.eval || evaluate(t);
  let h = '<h3>' + esc(t.name || 'AIS target') + '</h3><div class="sub">' + esc((t.type === 'ship' ? 'Ship' : t.type === 'sail' ? 'Sailing vessel' : t.type === 'fishing' ? 'Fishing vessel' : 'Power vessel') + (t.len ? ' · ' + Math.round(t.len) + ' m' : '') + (NAV_STATUS[t.status] ? ' · ' + NAV_STATUS[t.status] : '') + (t.demo ? ' · demo target' : '')) + '</div>';
  const facts = [['MMSI', t.mmsi], ['Call sign', t.callsign], ['Length', t.len ? Math.round(t.len) + ' m (' + Math.round(t.len * 3.28) + ' ft)' : ''], ['Beam', t.beam ? Math.round(t.beam) + ' m (' + Math.round(t.beam * 3.28) + ' ft)' : ''], ['Draft', t.draft ? t.draft + ' m (' + Math.round(t.draft * 3.28) + ' ft)' : ''], ['Heading', t.hdg != null ? fmtBrg(t.hdg) + '°T' : ''], ['Destination', t.dest], ['ETA', t.eta], ['Status', NAV_STATUS[t.status] || (t.status === 8 ? 'under way sailing' : t.status === 1 ? 'at anchor' : t.status === 0 ? 'under way using engine' : '')], ['Last report', t.seen ? Math.max(0, Math.round((Date.now() - t.seen) / 1000)) + ' s ago' + (t.demo ? ' (demo)' : '') : '']].filter((x) => x[1]);
  const mmsi = t.mmsi && /^\d{9}$/.test(String(t.mmsi)) ? String(t.mmsi) : null;
  h += '<div style="display:flex;gap:12px;margin-bottom:12px"><div style="width:96px;height:72px;border-radius:10px;background:var(--surface2);display:grid;place-items:center;flex:none;font-size:11.5px;color:var(--ink2);text-align:center;padding:4px">' + (t.photo ? '<img src="' + esc(t.photo) + '" alt="" style="width:96px;height:72px;object-fit:cover;border-radius:10px">' : 'No photo') + '</div>' +
    '<div class="facts" style="margin:0;font-size:13px;flex:1">' + facts.map((f) => '<span>' + esc(f[0]) + '</span><span>' + esc(f[1]) + '</span>').join('') + '</div></div>';
  if (mmsi) h += '<p class="sub" style="margin:-4px 0 12px">Photos and history: <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:' + mmsi + '" target="_blank" rel="noopener" style="color:var(--accent)">MarineTraffic</a> · <a href="https://www.vesselfinder.com/vessels/details/' + mmsi + '" target="_blank" rel="noopener" style="color:var(--accent)">VesselFinder</a></p>';
  if (r) {
    h += '<div class="trio"><div><span class="lbl">CLOSEST</span><b class="tnum">' + distParts(r.cpa).join(' ') + '</b><span class="unit">' + (r.tcpa > 0 ? 'in ' + fmtDur(r.tcpa) : 'already past') + '</span></div>' +
      '<div><span class="lbl">RANGE</span><b class="tnum">' + distParts(r.range).join(' ') + '</b><span class="unit">' + fmtBrg(r.brg) + '°T' + (r.steady ? ' · steady' : '') + '</span></div>' +
      '<div><span class="lbl">ITS SPEED</span><b class="tnum">' + fmtSpeed(t.sog) + '</b><span class="unit">' + fmtBrg(t.cog) + '°T</span></div></div>';
    if (r.level !== 'none') {
      h += '<div class="badges"><span class="role' + (r.level === 'danger' ? ' danger' : r.role === 'stand' ? ' stand' : '') + '">' + (r.role === 'give' ? 'LIKELY GIVE-WAY' : r.role === 'stand' ? 'LIKELY STAND-ON' : r.role === 'check' ? 'CHECK BY EYE' : 'BOTH TURN') + '</span></div>';
      h += '<p style="font-weight:600;font-size:16px;margin:0 0 8px">' + esc(r.head) + '</p>';
      if (r.tacks) h += '<p class="sub" style="margin:0 0 8px">Wind from ' + compass16(windFrom()) + ' (' + (S.weather ? 'forecast' : 'assumed') + '): you on ' + (r.tacks.mine || 'no') + ' tack, it on ' + (r.tacks.its || 'unknown') + ' tack.</p>';
      if (r.note) h += '<p class="sub" style="margin:0 0 8px">' + esc(r.note) + '</p>';
      if (r.assume) h += '<p class="sub" style="margin:0 0 8px;font-style:italic">' + esc(r.assume) + '</p>';
      h += '<ol class="todo">' + r.todo.map((x) => '<li>' + esc(x) + '</li>').join('') + (r.steady ? '<li>The bearing isn\'t changing while the range closes: that is the classic sign of a collision course (Rule 7(d)(i)).</li>' : '') + '</ol>';
      h += '<div class="lbl" style="margin-bottom:6px">IF YOU NEED TO CALL IT</div><div class="script">' + esc(r.hail) + '</div>';
      h += '<div class="lbl" style="margin-bottom:6px">RULES THAT APPLY · TAP TO READ</div><div>' + Array.from(new Set(r.rules)).map((c) => { const ru = RULES.find((x) => x.n === ruleBase(c)); if (!ru) return ''; const part = ru.p.find((x) => x[0] === c); return '<button class="rulechip" data-rule="' + c + '" style="text-align:left;height:auto;padding:8px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%"><span>' + esc(citeLabel(c)) + ' · ' + esc(ru.t) + '</span>' + (part ? '<span style="font-weight:400;font-size:12.5px;color:var(--ink2);line-height:1.35">' + esc(part[2]) + '</span>' : '') + '</button>'; }).join('') + '</div>';
    } else h += '<p class="sub">No risk of collision right now. Tideline keeps watching it.</p>';
  }
  h += '<div class="row-btns" style="margin-top:6px"><button class="btn ghost" data-act="close">Close</button></div><p class="disclaim">' + DISCLAIMER + '</p>';
  openSheet(h);
}
sheet.addEventListener('click', (e) => { const b = e.target.closest('[data-rule]'); if (b) openRuleSheet(b.dataset.rule); });
$('coachCard').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !coachTarget) return;
  if (b.dataset.act === 'coachmore') openAisSheet(coachTarget.t);
  if (b.dataset.act === 'coachx') { coachDismissed.add(coachTarget && coachTarget.t.mmsi); renderCoach(); return; }
  if (b.dataset.act === 'coachmute') { coachMuteUntil = Date.now() + 5 * 60000; renderCoach(); toast('Coach muted for 5 minutes. Targets still show on the chart.'); }
});
function aisUpsert(t) {
  const prev = ais.get(t.id);
  const hist = prev ? prev.hist : [];
  if (S.fix) { hist.push({ time: Date.now(), brg: bearing(S.fix, t), range: distNm(S.fix, t) }); while (hist.length > 40) hist.shift(); }
  ais.set(t.id, Object.assign(prev || {}, t, { hist, seen: Date.now() }));
}
/* demo AIS traffic: a crossing sailboat, a ship in the channel, a powerboat overtaking */
let demoAisAt = 0;
function simAis() {
  const f = S.fix; if (!f) return;
  const rate = S.settings.simRate || 1;
  ais.forEach((t, id) => {
    if (!t.demo) return;
    const p = destination(t, t.cog, t.sog * rate / 3600); t.lat = p.lat; t.lon = p.lon;
    if (distNm(f, t) > 4) ais.delete(id); else aisUpsert(t);
  });
  if (S.anchor || ais.size || Date.now() - demoAisAt < 20000) return;
  demoAisAt = Date.now();
  const cog = S.cog || 45, W = windFrom();
  const meet = destination(f, cog, 6 * 8 / 60); // where we will be in 8 minutes
  const cands = [90, -90, 70, -70, 110, -110, 50, -50, 130, -130].map((d) => (cog + d + 360) % 360);
  const sc = cands.find((c) => { const a = ((W - c) % 360 + 360) % 360; return a > 45 && a < 150; }) || cands[0];
  const sStart = destination(meet, (sc + 180) % 360, 5 * 8.2 / 60);
  aisUpsert({ id: 'demo-sail', demo: true, name: 'BLUE HERON', type: 'sail', status: 8, len: 11, beam: 3.6, draft: 1.7, callsign: 'DEMO1', dest: 'ANNAPOLIS', lat: sStart.lat, lon: sStart.lon, sog: 5, cog: sc });
  const shipStart = destination(destination(f, cog, 3.2), (cog + 90) % 360, 0.12);
  aisUpsert({ id: 'demo-ship', demo: true, name: 'DEMO CARRIER', type: 'ship', status: 0, len: 190, beam: 32, draft: 10.4, callsign: 'DEMO2', dest: 'BALTIMORE', eta: 'Today 16:30', lat: shipStart.lat, lon: shipStart.lon, sog: 11, cog: (cog + 180) % 360 });
  const pStart = destination(destination(f, (cog + 180) % 360, 0.7), (cog + 90) % 360, 0.04);
  aisUpsert({ id: 'demo-power', demo: true, name: 'REEL TIME', type: 'power', status: 0, len: 9, beam: 3, draft: 0.8, lat: pStart.lat, lon: pStart.lon, sog: 17, cog });
}
function renderModeChip() {
  const c = $('modeChip');
  if (S.settings.boatType !== 'sail') { c.hidden = true; return; }
  c.hidden = false; c.innerHTML = (S.settings.underSail ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v14H5zM14 6c3 3 4 7 4 11h-4zM3 19h18l-2 2H5z" fill="currentColor"/></svg>Under sail' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15h18l-3 5H6zM8 15V9h6l3 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>Motoring');
  c.title = 'Tap to switch between under sail and motoring';
  placeFabs();
}
window.addEventListener('resize', () => placeFabs());
$('modeChip').addEventListener('click', () => {
  S.settings.underSail = !S.settings.underSail; saveSettings(); renderModeChip(); updateAis();
  toast(S.settings.underSail ? 'Under sail: the Rules treat you as a sailing vessel.' : 'Motoring: the Rules treat you as a power-driven vessel, even with sails up.', 4000);
});

/* ---------- anchor lights helper (Rule 30) ---------- */
function lightsAdvice() {
  const a = S.anchor; if (!a) return '';
  const lenM = S.settings.boatLen * 0.3048, sp = a.special || 'unsure';
  const w = S.weather, now = Date.now();
  const sunset = w && (w.sunset || []).find((t) => t > now - 3 * 3600000), sunrise = w && (w.sunrise || []).find((t) => t > now);
  const when = sunset && sunrise ? 'from sunset (' + fmtClock(sunset) + ') to sunrise (' + fmtClock(sunrise) + ')' : 'from sunset to sunrise';
  let head, body;
  if (sp === 'yes' && lenM < 20) { head = 'No anchor light required here'; body = 'Boats under 20 m anchored in a designated special anchorage area don\'t need the anchor light or ball (Inland Rule 30(g)), or the fog bell (Inland Rule 35(l)). Many skippers show a light anyway.'; }
  else if (lenM < 7 && sp === 'no') { head = 'Probably no light required'; body = 'Under 7 m and not in or near a channel, fairway, anchorage or where boats normally go, you don\'t need the light or ball (Inland Rule 30(e)). If boats pass near you, show it.'; }
  else { head = 'Show your anchor light ' + when; body = 'One all-round white light where it can best be seen (Rule 30(b), boats under 50 m), and one black ball forward by day (Rule 30(a)(i)).' + (sp === 'unsure' ? ' Special anchorage areas are marked on the chart with a magenta anchor and dashed outline.' : ''); }
  return '<div class="lights-card"><span class="eyebrow">Lights and shapes · ' + Math.round(lenM * 10) / 10 + ' m boat</span>' +
    '<span style="font-size:13px;color:var(--p-muted)">Are you in a designated special anchorage area?</span>' +
    '<div class="seg" role="group">' + [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']].map(([v, l]) => '<button type="button" data-special="' + v + '" class="' + (sp === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
    '<b style="font-size:16px">' + esc(head) + '</b><span style="font-size:13.5px;color:var(--p-muted);line-height:1.45">' + esc(body) + '</span>' +
    '<button type="button" class="btn small" data-rule="' + (sp === 'yes' && lenM < 20 ? '30(g)' : lenM < 7 && sp === 'no' ? '30(e)' : '30(b)') + '" style="align-self:flex-start">Read Rule 30</button></div>';
}

/* ---------- voice coach ---------- */
const spoken = new Map(); // target id -> highest level already spoken
let lastSpokeAt = 0;
function syncCoach() { const m = S.settings.coachMode || 'voice'; S.settings.aisCoach = m !== 'off'; S.settings.voice = m === 'voice'; saveSettings(); updateAis(); }
function chime() { // gentle two-note heads-up
  const ctx = audio(); if (!ctx) return;
  [[1318.5, 0], [1046.5, 0.22]].forEach(([f, d]) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + d;
    o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.6);
  });
}
function headsUp(text) { if (S.settings.voice) speak(text); else chime(); }
/* pick the most natural voice this device has: Premium / Enhanced / Natural / Neural voices first */
function voiceScore(x) {
  if (!/^en(-|_|$)/i.test(x.lang)) return -1;
  let sc = /en-US/i.test(x.lang) ? 2 : 1;
  if (/premium/i.test(x.name)) sc += 40; if (/enhanced/i.test(x.name)) sc += 30; if (/natural|neural|online/i.test(x.name)) sc += 35;
  if (/siri/i.test(x.name)) sc += 25; if (/^(Ava|Zoe|Evan|Nathan|Samantha|Allison|Susan|Tom|Joelle|Noelle)\b/i.test(x.name)) sc += 10;
  if (/Google US English|Google UK English/i.test(x.name)) sc += 12;
  if (/compact|eloquence|fred|albert|bad news|bahh|bells|boing|bubbles|cellos|zarvox|whisper|trinoids|wobble|jester|organ|superstar|ralph|kathy|junior|grandma|grandpa|rocko|shelley|sandy|flo|reed/i.test(x.name)) sc -= 50;
  return sc;
}
function bestVoice() {
  const all = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : [];
  if (S.settings.voiceName) { const pick = all.find((x) => x.name === S.settings.voiceName); if (pick) return pick; }
  return all.filter((x) => voiceScore(x) >= 0).sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
}
try { if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { if (S.tab === 'settings') renderSettings(); }); } catch (e) { /* no speech */ }
function voiceOptions() {
  const all = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter((x) => voiceScore(x) >= 0).sort((a, b) => voiceScore(b) - voiceScore(a)) : [];
  return all.slice(0, 12);
}
function speak(text) {
  if (!S.settings.voice || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95; u.pitch = 1; u.lang = 'en-US';
    const v = bestVoice(); if (v) { u.voice = v; u.lang = v.lang; }
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch (e) { /* speech unavailable */ }
}
function voiceCoach(r) {
  if (!r || Date.now() < coachMuteUntil) return;
  const rank = { caution: 1, danger: 2 }[r.level] || 0, prev = spoken.get(r.t.id) || 0;
  if (rank <= prev) return;
  if (rank === 1 && Date.now() - lastSpokeAt < 45000) return; // never chatter
  spoken.set(r.t.id, rank); lastSpokeAt = Date.now();
  const who = S.settings.skipper ? S.settings.skipper + ', ' : '';
  const typeWord = r.t.type === 'ship' ? 'Ship' : r.t.type === 'sail' ? 'Sailboat' : 'Boat';
  const rel = ((r.brg - (S.cog || 0)) % 360 + 360) % 360;
  const where = rel < 22 || rel > 338 ? 'dead ahead' : rel < 90 ? 'on your starboard bow' : rel < 180 ? 'on your starboard quarter' : rel < 270 ? 'on your port quarter' : 'on your port bow';
  const role = r.role === 'give' ? 'You are likely the give-way vessel.' : r.role === 'stand' ? 'You are likely the stand-on vessel. Hold course and speed, and be ready to act if they do not.' : r.role === 'check' ? 'Check it by eye.' : 'Both of you should turn to starboard.';
  headsUp((r.level === 'danger' ? who + 'close quarters. ' : who + 'heads up. ') + typeWord + ' ' + (r.t.name || '') + ', ' + where + ', ' + fmtDist(r.range).replace('nm', 'nautical miles').replace('ft', 'feet') + '. ' + r.head.replace(/\(.*?\)/g, '') + ' ' + role + ' ' + r.todo[0].replace(/\(.*?\)/g, ''));
}

/* ---------- boat profile ---------- */
const BOAT_DEFAULT = { make: '', model: '', year: '', beamFt: null, draftFt: null, airDraftFt: null, engineMake: '', engineModel: '', engineHp: null, engineKind: 'outboard', engineHours: 0, batteryKind: 'lead', batteryInstalled: '', photo: null, anchorType: '', anchorLb: null, chainFt: null, rodeTotalFt: null };
S.boat = Object.assign({}, BOAT_DEFAULT, store.get('boat', {}));
const saveBoat = () => { store.set('boat', S.boat); if (S.fleet) saveFleet(); };
/* ---------- several boats (delivery captains), and the captain's own profile ---------- */
const BOAT_SET_KEYS = ['boatName', 'boatType', 'boatLen', 'gpsToBow', 'cruise', 'sailSpeed', 'useMode', 'iconStyle', 'underSail', 'navMode'];
S.fleet = store.get('fleet', null);
if (!S.fleet) { S.fleet = { active: 1, boats: [{ id: 1, boat: S.boat, set: {} }] }; BOAT_SET_KEYS.forEach((k) => { S.fleet.boats[0].set[k] = S.settings[k]; }); }
S.captain = store.get('captain', { name: S.settings.skipper || '', photo: '', license: '', phone: '' });
function saveFleet() { const cur = S.fleet.boats.find((x) => x.id === S.fleet.active); if (cur) { cur.boat = S.boat; cur.set = {}; BOAT_SET_KEYS.forEach((k) => { cur.set[k] = S.settings[k]; }); } try { store.set('fleet', S.fleet); } catch (e) { toast('Storage is full: try smaller boat photos.'); } }
function switchBoat(id) {
  saveFleet();
  const nb = S.fleet.boats.find((x) => x.id === id); if (!nb) return;
  S.fleet.active = id; S.boat = Object.assign({}, BOAT_DEFAULT, nb.boat || {}); Object.assign(S.settings, nb.set || {});
  saveBoat(); saveSettings(); store.set('fleet', S.fleet); applyUseMode(); renderModeChip(); updateBoat(); renderBoat();
  toast('Now on ' + (S.settings.boatName || 'this boat'));
}
function addBoat() {
  saveFleet();
  const id = Date.now(); S.fleet.boats.push({ id, boat: Object.assign({}, BOAT_DEFAULT), set: { boatName: 'New boat', boatType: 'sail', boatLen: 30, gpsToBow: 22, cruise: 6, sailSpeed: 5, useMode: S.settings.useMode || 'cruise' } });
  switchBoat(id); boatEditing = true; renderBoat();
}
function fleetHtml() {
  const c = S.captain;
  const cap = '<div class="card cap"><label class="cap-ph">' + (c.photo ? '<img src="' + c.photo + '" alt="">' : '<span>Add photo</span>') + '<input type="file" accept="image/*" id="capPhoto" hidden></label>' +
    '<div class="cap-f"><small>Captain</small><input id="capName" placeholder="Your name" value="' + esc(c.name || S.settings.skipper || '') + '"><input id="capLic" placeholder="USCG license, optional (e.g. 100-ton Master)" value="' + esc(c.license || '') + '"></div></div>';
  const list = S.fleet.boats.map((x) => { const nm = (x.id === S.fleet.active ? S.settings.boatName : x.set && x.set.boatName) || 'Boat', bb = x.id === S.fleet.active ? S.boat : x.boat || {};
    return '<div class="li"><div class="li-main fl-main">' + (bb.photo ? '<img class="fl-ph" src="' + bb.photo + '" alt="">' : '<span class="fl-ph"></span>') + '<span><b>' + esc(nm) + '</b><span>' + esc([bb.make, bb.model].filter(Boolean).join(' ') || '') + '</span></span></div><div class="li-btns">' +
      (x.id === S.fleet.active ? '<span class="badge">On board</span>' : '<button class="btn small primary" data-fl="' + x.id + '">Switch</button><button class="btn small" data-fldel="' + x.id + '">Remove</button>') + '</div></div>'; }).join('');
  return cap + '<div class="card"><h4>My boats</h4>' + list + '<div class="row-btns" style="margin-top:8px"><button class="btn" data-act="fladd">Add another boat</button></div><p class="hint" style="margin:6px 0 0">Delivery captains: keep a profile for every boat you run, with its draft, air draft, engine and photo, and switch in one tap.</p></div>';
}

let boatEditing = false;
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 480, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = reject; img.src = url;
  });
}
const lenM = () => S.settings.boatLen * 0.3048;
/* a few well-known boats, from the builders' published specs; anything filled in is shown so the owner can check it */
const BOAT_DB = [
  { make: 'Catalina', model: '22', loa: 21.5, lwl: 19.33, beam: 7.67, disp: 2490, type: 'sail' },
  { make: 'Catalina', model: '27', loa: 27.0, lwl: 21.75, beam: 8.83, draft: 4.0, disp: 6850, type: 'sail' },
  { make: 'Catalina', model: '30', loa: 29.92, lwl: 25.0, beam: 10.83, draft: 5.25, disp: 10200, type: 'sail' },
  { make: 'J/Boats', alias: /^j\/?\s*24$/i, model: 'J/24', loa: 24.0, lwl: 20.0, beam: 8.9, draft: 4.0, disp: 3100, type: 'sail' },
];
function boatLookup(make, model) {
  const mk = String(make || '').toLowerCase().trim(), md = String(model || '').toLowerCase().replace(/\s+/g, '').trim();
  return BOAT_DB.find((x) => (x.alias && (x.alias.test(model) || x.alias.test(make + ' ' + model))) || (x.make.toLowerCase() === mk && x.model.toLowerCase().replace(/\s+/g, '') === md)) || null;
}
function hullSpeed() { // displacement hulls: 1.34 × √(waterline length in feet)
  const lwl = S.boat.lwlFt || (S.settings.boatType === 'sail' && S.settings.boatLen ? S.settings.boatLen * 0.83 : null);
  return lwl ? { kn: 1.34 * Math.sqrt(lwl), est: !S.boat.lwlFt } : null;
}
function boatSummary() {
  const b = S.boat, bits = [];
  if (b.make || b.model) bits.push([b.year, b.make, b.model].filter(Boolean).join(' '));
  bits.push(fmtLen(S.settings.boatLen) + ' long');
  if (b.beamFt) bits.push(fmtLen(b.beamFt) + ' beam');
  if (b.draftFt) bits.push(fmtLen(b.draftFt) + ' draft');
  if (b.airDraftFt) bits.push(fmtLen(b.airDraftFt) + ' air draft');
  const hs = hullSpeed(); if (hs && S.settings.boatType === 'sail') bits.push('hull speed ' + fmtSpeed(hs.kn) + ' ' + SPEED_LBL[S.settings.speedUnit] + (hs.est ? ' (estimated)' : ''));
  if (b.anchorType) bits.push((ANCHORS[b.anchorType] || {}).name + (b.anchorLb ? ' ' + b.anchorLb + ' lb' : '') + ' anchor' + (b.rodeTotalFt ? ', ' + fmtLen(b.rodeTotalFt) + ' rode' : ''));
  return bits.join(' · ');
}
function profileHtml() {
  const b = S.boat, st = S.settings;
  const photo = b.photo ? '<img src="' + b.photo + '" alt="Your boat" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px;display:block">' :
    '<div style="height:120px;border-radius:12px;background:var(--surface2);display:grid;place-items:center;color:var(--ink2);font-size:14px">Add a photo of your boat</div>';
  if (!boatEditing) {
    return '<div class="card" style="padding:14px"><label style="display:block;cursor:pointer">' + photo + '<input type="file" accept="image/*" id="boatPhoto" style="display:none"></label>' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-top:12px"><div style="min-width:0"><div style="font-size:20px;font-weight:600">' + esc(st.boatName || 'Your boat') + '</div>' +
      '<div class="sub" style="margin:2px 0 0">' + esc(boatSummary()) + '</div>' +
      (b.engineMake || b.engineHp ? '<div class="sub" style="margin:2px 0 0">' + esc([b.engineMake, b.engineModel, b.engineHp ? b.engineHp + ' hp' : '', b.engineKind].filter(Boolean).join(' · ')) + ' · ' + Math.round(b.engineHours || 0) + ' engine hours</div>' : '') +
      '</div><button class="btn small" data-act="editboat">Edit</button></div></div>';
  }
  const f = (id, label, val, type = 'text', extra = '') => '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '" ' + (type === 'number' ? 'inputmode="decimal" ' : '') + 'value="' + (val == null ? '' : esc(val)) + '" ' + extra + '></div>';
  const sel = (id, label, val, opts) => '<div class="field"><label for="' + id + '">' + label + '</label><select id="' + id + '">' + opts.map(([v, l]) => '<option value="' + v + '"' + (v === val ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>';
  const L2 = (ft) => (ft == null || ft === '' ? '' : Math.round(ftToLen(ft) * 10) / 10);
  return '<div class="card" style="padding:14px"><div class="stack">' +
    '<div class="grid2">' + f('bName', 'Boat name', st.boatName) + f('bSkipper', 'Your first name (voice coach)', st.skipper) + '</div>' +
    '<div class="grid2">' + sel('bType', 'Type', st.boatType, [['sail', 'Sailboat'], ['power', 'Powerboat']]) + f('bYear', 'Year', b.year, 'number') + '</div>' +
    sel('bUse', 'Mainly used for (sets up the tools you see)', st.useMode || 'cruise', [['cruise', 'Cruising and day trips'], ['fish', 'Fishing (marks your spots)'], ['race', 'Racing (more coming)'], ['pro', 'Delivery or professional captain']]) +
    '<div class="grid2">' + f('bMake', 'Make', b.make) + f('bModel', 'Model', b.model) + '</div>' +
    '<div class="grid2">' + f('bLen', 'Length (' + lenUnit() + ')', L2(st.boatLen), 'number') + f('bBeam', 'Beam (' + lenUnit() + ')', L2(b.beamFt), 'number') + '</div>' +
    '<div class="grid2">' + f('bLwl', 'Waterline length (' + lenUnit() + ')', L2(b.lwlFt), 'number') + f('bDisp', 'Displacement (lb)', b.dispLb, 'number') + '</div>' +
    '<p class="hint" id="bDbNote" style="margin:-2px 0 4px">Enter make and model: known boats fill in their specs for you to check.</p>' +
    '<div class="grid2">' + f('bDraft', 'Draft (' + lenUnit() + ')', L2(b.draftFt), 'number') + f('bAir', 'Air draft (' + lenUnit() + ')' + (st.boatType === 'sail' ? ', masthead and antennas' : ', highest point'), L2(b.airDraftFt), 'number') + '</div>' +
    '<div class="grid2">' + sel('bEngKind', 'Engine', b.engineKind, [['outboard', 'Outboard'], ['inboard-diesel', 'Inboard diesel'], ['inboard-gas', 'Inboard gas'], ['sterndrive', 'Sterndrive'], ['pod', 'Pod drive (IPS etc.)'], ['none', 'No engine']]) + f('bHp', 'Horsepower', b.engineHp, 'number') + '</div>' +
    '<div class="grid2">' + f('bEngMake', 'Engine make', b.engineMake) + f('bEngModel', 'Engine model', b.engineModel) + '</div>' +
    '<div class="grid2">' + f('bHours', 'Engine hours now', b.engineHours, 'number') + sel('bIcon', 'Chart icon', st.iconStyle, [['boat', 'Boat outline'], ['arrow', 'Arrow']]) + '</div>' +
    '<div class="grid2">' + sel('bAnchor', 'Main anchor', b.anchorType, [['', 'Choose…'], ['newgen', 'New-generation (Rocna, Mantus, Spade, Vulcan…)'], ['plow', 'Plow (CQR, Delta)'], ['claw', 'Claw (Bruce)'], ['fluke', 'Fluke (Danforth, Fortress)'], ['grapnel', 'Grapnel'], ['other', 'Other']]) + f('bAnchorLb', 'Anchor weight (lb)', b.anchorLb, 'number') + '</div>' +
    '<div class="grid2">' + f('bChain', 'Chain (' + lenUnit() + ')', L2(b.chainFt), 'number') + f('bRode', 'Total rode incl. chain (' + lenUnit() + ')', L2(b.rodeTotalFt), 'number') + '</div>' +
    '<div class="grid2">' + f('bSafe', 'Safety buffer under keel (' + lenUnit() + ')', L2(b.safetyFt == null ? 2 : b.safetyFt), 'number') + f('bGph', 'Fuel burn at cruise (gal/h)', b.gph, 'number') + '</div>' +
    '<div class="grid2">' + f('bTank', 'Fuel tank (gal)', b.tankGal, 'number') + f('bMmsi', 'MMSI (from your VHF or AIS)', b.mmsi, 'text', 'inputmode="numeric" maxlength="9"') + '</div>' +
    '<div class="grid2">' + sel('bBatt', 'House battery', b.batteryKind, [['lead', 'Flooded lead-acid'], ['agm', 'AGM'], ['gel', 'Gel'], ['lifepo4', 'Lithium (LiFePO4)']]) + f('bBattDate', 'Installed', b.batteryInstalled, 'month') + '</div>' +
    '<div class="row-btns"><button class="btn primary" data-act="saveboat">Save</button><button class="btn ghost" data-act="cancelboat">Cancel</button></div></div></div>';
}
function saveBoatForm() {
  const v = (id) => ($(id) ? $(id).value.trim() : ''), n = (id) => { const x = parseFloat(v(id)); return isFinite(x) ? x : null; };
  const st = S.settings, b = S.boat;
  st.boatName = v('bName'); st.skipper = v('bSkipper'); st.boatType = v('bType'); st.useMode = v('bUse') || 'cruise'; applyUseMode(); st.iconStyle = v('bIcon');
  if (n('bLen')) st.boatLen = lenToFt(n('bLen'));
  b.year = v('bYear'); b.make = v('bMake'); b.model = v('bModel');
  b.beamFt = n('bBeam') != null ? lenToFt(n('bBeam')) : null; b.draftFt = n('bDraft') != null ? lenToFt(n('bDraft')) : null; b.airDraftFt = n('bAir') != null ? lenToFt(n('bAir')) : null;
  b.engineKind = v('bEngKind'); b.engineHp = n('bHp'); b.engineMake = v('bEngMake'); b.engineModel = v('bEngModel'); b.engineHours = n('bHours') || 0;
  b.batteryKind = v('bBatt'); b.batteryInstalled = v('bBattDate');
  b.lwlFt = n('bLwl') != null ? lenToFt(n('bLwl')) : null; b.dispLb = n('bDisp');
  { const hs = hullSpeed(); if (hs && st.boatType === 'sail' && (!st.sailSpeed || st.sailSpeed === 5)) st.sailSpeed = Math.round(hs.kn * 0.8 * 10) / 10; }
  b.safetyFt = n('bSafe') != null ? lenToFt(n('bSafe')) : 2; b.gph = n('bGph'); b.tankGal = n('bTank'); b.mmsi = /^\d{9}$/.test(v('bMmsi')) ? v('bMmsi') : '';
  if (v('bMmsi') && !b.mmsi) toast('MMSI should be 9 digits. Left blank.');
  b.anchorType = v('bAnchor'); b.anchorLb = n('bAnchorLb'); b.chainFt = n('bChain') != null ? lenToFt(n('bChain')) : null; b.rodeTotalFt = n('bRode') != null ? lenToFt(n('bRode')) : null;
  if (b.chainFt && b.rodeTotalFt) { S.anchorForm.rodeType = b.chainFt >= b.rodeTotalFt - 1 ? 'chain' : 'mixed'; store.set('anchorForm', S.anchorForm); }
  saveSettings(); saveBoat(); boatEditing = false; renderModeChip(); updateBoat(); renderBoat(); toast('Boat saved');
}

/* ---------- your lights, shapes and sound signals right now ---------- */
function isNight() {
  const w = S.weather, now = Date.now();
  if (w && w.sunrise && w.sunset) {
    const ss = w.sunset.filter((t) => t <= now).pop(), sr = w.sunrise.filter((t) => t <= now).pop();
    if (ss || sr) return (ss || 0) > (sr || 0);
  }
  const h = new Date().getHours(); return h < 7 || h >= 19;
}
let fogMode = false;
function ownLights() {
  const m = lenM(), sail = S.settings.boatType === 'sail', underSail = sail && S.settings.underSail;
  const night = isNight(), out = [];
  let state;
  if (S.anchor) {
    state = 'At anchor';
    const sp = S.anchor.special || 'unsure';
    if (sp === 'yes' && m < 20) out.push(['No anchor light or ball required', 'You are under 20 m in a designated special anchorage area.', 'Inland 30(g)']);
    else if (m < 7 && sp === 'no') out.push(['No anchor light or ball required', 'Under 7 m and away from channels, fairways, anchorages and traffic.', 'Inland 30(e)']);
    else if (night) out.push(['One all-round white light', 'Where it can best be seen. Boats 50 m and over need two.', '30(b), 30(a)']);
    else out.push(['One black ball, forward', 'Hoist it where it can best be seen.', '30(a)(i)']);
  } else if (underSail) {
    state = 'Under sail';
    if (night) out.push(m < 20 ? ['Sidelights and sternlight, or a masthead tricolor', 'Red and green sidelights plus a white sternlight, or all three in one masthead lantern. Never the tricolor with the engine on.', '25(a), 25(b)'] : ['Sidelights and sternlight', 'Red and green sidelights plus a white sternlight.', '25(a)']);
    else out.push(['No shape required', 'A sailing vessel shows no day shape.', '25']);
    if (night && m < 7) out.push(['Under 7 m', 'Show sidelights and sternlight if practicable; otherwise keep a white light ready.', '25(d)(i)']);
  } else {
    state = sail ? 'Motoring (power-driven)' : 'Under way, power';
    if (night) out.push(m < 12 ? ['Masthead light, sidelights and sternlight', 'Or, under 12 m, an all-round white light plus sidelights. A sailboat motoring turns on its steaming light, not the tricolor.', '23(a), 23(d)'] : ['Masthead light, sidelights and sternlight', sail ? 'Steaming (masthead) light on, tricolor off.' : 'Masthead light forward, red and green sidelights, white sternlight.', '23(a)']);
    if (sail && !night) out.push(m < 12 ? ['Cone, point down (if sails are up)', 'Motorsailing by day calls for a cone forward. Inland: not required under 12 m.', '25(e)'] : ['Cone, point down (if sails are up)', 'Motorsailing by day: show a cone, point down, forward.', '25(e)']);
  }
  if (fogMode) {
    if (S.anchor) {
      const sp = S.anchor.special;
      if (sp === 'yes' && m < 20) out.push(['Fog signal: not required', 'Under 20 m in a special anchorage area.', 'Inland 35(l)']);
      else out.push(m < 12 ? ['Fog signal: some efficient sound signal', 'At least every 2 minutes. Under 12 m you need not ring a bell.', '35(j)'] : ['Fog signal: ring the bell', 'Rapidly for about 5 seconds, at least every minute.', '35(g)']);
    } else if (underSail) out.push(['Fog signal: one prolonged, two short', 'At least every 2 minutes.', '35(c)']);
    else out.push(['Fog signal: one prolonged blast', 'At least every 2 minutes when making way; two prolonged when stopped.', '35(a), 35(b)']);
    out.push(['Slow down, engine ready', 'There is no stand-on vessel in fog. Listen, and post a look-out.', '19(b), 6, 5']);
  }
  return { state, night, out };
}
function lightsCoachHtml() {
  const L = ownLights();
  return '<div class="card" style="padding:4px 14px 12px"><h4>Your lights and shapes now</h4>' +
    '<div class="sub" style="margin:0 0 8px">' + esc(L.state) + ' · ' + (L.night ? 'night' : 'day') + ' · ' + Math.round(lenM() * 10) / 10 + ' m boat</div>' +
    L.out.map((o) => '<div class="li"><div class="li-main"><b style="white-space:normal">' + esc(o[0]) + '</b><span>' + esc(o[1]) + '</span></div><button class="btn small" data-rule="' + esc(o[2].replace('Inland ', '').split(',')[0].trim()) + '">' + esc((o[2].startsWith('Inland') ? '' : 'Rule ') + o[2]) + '</button></div>').join('') +
    '<label class="opt" style="border:0;padding:8px 0 0"><input type="checkbox" id="fogBox"' + (fogMode ? ' checked' : '') + '><span>Fog or poor visibility<small>Adds the sound signals you should be making</small></span></label></div>';
}

/* ---------- what am I looking at? lights and shapes ---------- */
const LIGHT_IDS = [
  { id: 'pw-head', mode: 'night', dots: [[30, 14, 'w'], [22, 40, 'r'], [38, 40, 'g']], name: 'Power vessel, coming straight at you', cite: '23(a), 14(b)', match: ['power', 'ship'], advice: 'You see its masthead light and both sidelights: it is head-on. Both power vessels turn to starboard and pass port to port. A sailboat under sail stands on, but act early if it doesn\'t turn.', next: '14(a)' },
  { id: 'pw-red', mode: 'night', dots: [[30, 14, 'w'], [26, 40, 'r']], name: 'Power vessel, showing its port (red) side', cite: '23(a), 21(b)', match: ['power', 'ship'], advice: 'It is crossing from your right to your left. If it is on your starboard side and you are both power-driven, you give way: "if to starboard red appear, it\'s your duty to keep clear" (Rule 15(a)).', next: '15(a)' },
  { id: 'pw-green', mode: 'night', dots: [[30, 14, 'w'], [34, 40, 'g']], name: 'Power vessel, showing its starboard (green) side', cite: '23(a), 21(b)', match: ['power', 'ship'], advice: 'It is crossing from your left to your right. If it is on your port side and you are both power-driven, it should give way; hold your course and speed (Rule 17(a)(i)) and watch it.', next: '17(a)' },
  { id: 'white', mode: 'night', dots: [[30, 30, 'w']], name: 'A single white light', cite: '21(c), 23(d), 30(b)', match: ['power', 'sail'], advice: 'Could be a sternlight (you are behind it: if you are faster, you keep clear, Rule 13), a small powerboat under 12 m, or a boat at anchor. Watch whether its bearing changes, and check the chart for an anchorage.', next: '13(a)' },
  { id: 'sail-head', mode: 'night', dots: [[22, 36, 'r'], [38, 36, 'g']], name: 'Sailing vessel, coming straight at you', cite: '25(a)', match: ['sail'], advice: 'Red and green with no white light above: a sailboat under sail, bow toward you. Under power, you keep clear of it (Rule 18(a)). If you are sailing too, Rule 12 decides by tack.', next: '18(a)' },
  { id: 'sail-red', mode: 'night', dots: [[30, 36, 'r']], name: 'Sailing vessel, port side', cite: '25(a)', match: ['sail'], advice: 'Red with no white above: a sailboat (or a very small boat) showing its port side, crossing from your right to your left.', next: '12(a)' },
  { id: 'sail-green', mode: 'night', dots: [[30, 36, 'g']], name: 'Sailing vessel, starboard side', cite: '25(a)', match: ['sail'], advice: 'Green with no white above: a sailboat showing its starboard side, crossing from your left to your right.', next: '12(a)' },
  { id: 'sail-rg-mast', mode: 'night', dots: [[30, 8, 'r'], [30, 18, 'g'], [26, 42, 'r']], name: 'Sailing vessel with red-over-green masthead lights', cite: '25(c)', match: ['sail'], advice: 'Optional all-round red over green at the masthead, plus sidelights. It is a sailing vessel under sail.', next: '18(a)' },
  { id: 'nuc', mode: 'night', dots: [[30, 14, 'r'], [30, 30, 'r']], name: 'Not under command', cite: '27(a)(i)', match: [], status: 2, advice: 'Two all-round red lights, one above the other: it cannot maneuver. Everyone keeps clear of it (Rule 18(a)(i), 18(b)(i)).', next: '18(a)' },
  { id: 'ram', mode: 'night', dots: [[30, 10, 'r'], [30, 24, 'w'], [30, 38, 'r']], name: 'Restricted in ability to maneuver', cite: '27(b)(i)', match: [], status: 3, advice: 'Red-white-red: dredging, cable work, a tow it can\'t steer away from, or divers. Keep well clear (Rule 18(a)(ii), 18(b)(ii)). Look for green lights on the side you may pass (Rule 27(d)).', next: '18(a)' },
  { id: 'trawl', mode: 'night', dots: [[30, 14, 'g'], [30, 28, 'w']], name: 'Fishing: trawling', cite: '26(b)(i)', match: ['fishing'], status: 7, advice: 'Green over white: a trawler with a net out behind it. Keep clear (Rule 18(a)(iii), 18(b)(iii)) and don\'t pass close astern.', next: '18(a)' },
  { id: 'fish', mode: 'night', dots: [[30, 14, 'r'], [30, 28, 'w']], name: 'Fishing, other than trawling', cite: '26(c)(i)', match: ['fishing'], status: 7, advice: 'Red over white: fishing with nets or lines that limit it. Keep clear (Rule 18(a)(iii), 18(b)(iii)). An extra white light may point toward gear over 150 m out (Rule 26(c)(ii)).', next: '18(a)' },
  { id: 'tow', mode: 'night', dots: [[30, 8, 'w'], [30, 20, 'w'], [26, 42, 'r']], name: 'Towing vessel', cite: '24(a)(i)', match: ['power'], advice: 'Two white masthead lights in a vertical line (three if the tow is over 200 m). Look for the tow behind it and never cross between a tug and its tow.', next: '24(a)' },
  { id: 'pilot', mode: 'night', dots: [[30, 14, 'w'], [30, 28, 'r']], name: 'Pilot vessel on duty', cite: '29(a)(i)', match: ['power'], advice: 'White over red: a pilot boat working with ships. Expect a ship nearby.', next: '29(a)' },
  { id: 'cbd', mode: 'night', dots: [[30, 8, 'r'], [30, 20, 'r'], [30, 32, 'r']], name: 'Constrained by her draft (International)', cite: '28', match: ['ship'], status: 4, advice: 'Three red lights in a line: a deep-draft ship that can\'t leave the deep water. Don\'t impede it (Rule 18(d), International).', next: '18(d)' },
  { id: 'anchored-big', mode: 'night', dots: [[18, 18, 'w'], [42, 32, 'w']], name: 'Vessel at anchor, 50 m or more', cite: '30(a)', match: ['ship'], status: 1, advice: 'One white light forward and a lower one aft: a large vessel at anchor. Give it room; it may swing.', next: '30(a)' },
  { id: 'ball', mode: 'day', shapes: [['ball', 26]], name: 'One ball: at anchor', cite: '30(a)(i)', match: [], status: 1, advice: 'A black ball forward means the vessel is anchored.', next: '30(a)' },
  { id: 'two-balls', mode: 'day', shapes: [['ball', 16], ['ball', 36]], name: 'Two balls: not under command', cite: '27(a)(ii)', match: [], status: 2, advice: 'It cannot maneuver. Keep clear (Rule 18).', next: '18(a)' },
  { id: 'bdb', mode: 'day', shapes: [['ball', 10], ['diamond', 26], ['ball', 42]], name: 'Ball-diamond-ball: restricted in ability to maneuver', cite: '27(b)(ii)', match: [], status: 3, advice: 'Dredging, survey, cable work or a restricted tow. Keep well clear (Rule 18).', next: '18(a)' },
  { id: 'cone-down', mode: 'day', shapes: [['coneDown', 26]], name: 'Cone, point down: motorsailing', cite: '25(e)', match: ['sail'], advice: 'A sailboat with sails up and engine on. The Rules treat it as a power-driven vessel (Rule 3(b), 3(c)).', next: '3(c)' },
  { id: 'cones', mode: 'day', shapes: [['coneDown', 16], ['coneUp', 34]], name: 'Two cones, points together: fishing', cite: '26(b)(i), 26(c)(i)', match: ['fishing'], status: 7, advice: 'Engaged in fishing. Keep clear (Rule 18).', next: '18(a)' },
  { id: 'diamond', mode: 'day', shapes: [['diamond', 26]], name: 'Diamond: tow longer than 200 m', cite: '24(a)(v)', match: ['power'], advice: 'A long tow. Look for the towed vessel and pass well clear, never between them.', next: '24(a)' },
  { id: 'cyl', mode: 'day', shapes: [['cyl', 26]], name: 'Cylinder: constrained by her draft (International)', cite: '28', match: ['ship'], status: 4, advice: 'A deep-draft ship. Don\'t impede it (Rule 18(d)).', next: '18(d)' },
  { id: 'three-balls', mode: 'day', shapes: [['ball', 8], ['ball', 26], ['ball', 44]], name: 'Three balls: aground', cite: '30(d)(ii)', match: [], advice: 'A vessel aground. There is shallow water there. Stay clear.', next: '30(d)' },
  { id: 'alpha', mode: 'day', shapes: [['alpha', 26]], name: 'Blue-and-white "A" flag: divers down', cite: '27(e)', match: [], status: 3, advice: 'Divers in the water. Keep well clear and go slowly.', next: '27(e)' },
];
const LCOL = { r: '#FF4A3D', g: '#38E07B', w: '#FFFFFF', y: '#FFD23F' };
function lightPic(o) {
  let s = '<svg width="60" height="56" viewBox="0 0 60 56" aria-hidden="true">';
  if (o.mode === 'night') {
    s += '<rect width="60" height="56" rx="10" fill="#0A1420"/>';
    o.dots.forEach(([x, y, c]) => { s += '<circle cx="' + x + '" cy="' + y + '" r="7" fill="' + LCOL[c] + '" fill-opacity="0.25"/><circle cx="' + x + '" cy="' + y + '" r="3.6" fill="' + LCOL[c] + '"/>'; });
  } else {
    s += '<rect width="60" height="56" rx="10" fill="#DCEAF2"/><line x1="30" y1="2" x2="30" y2="54" stroke="#7A8794" stroke-width="1.5"/>';
    o.shapes.forEach(([k, y]) => {
      if (k === 'ball') s += '<circle cx="30" cy="' + y + '" r="6.5" fill="#111"/>';
      if (k === 'diamond') s += '<path d="M30 ' + (y - 9) + 'l7 9l-7 9l-7-9z" fill="#111"/>';
      if (k === 'coneDown') s += '<path d="M23 ' + (y - 7) + 'h14l-7 13z" fill="#111"/>';
      if (k === 'coneUp') s += '<path d="M30 ' + (y - 7) + 'l7 13h-14z" fill="#111"/>';
      if (k === 'cyl') s += '<rect x="25" y="' + (y - 9) + '" width="10" height="18" fill="#111"/>';
      if (k === 'alpha') s += '<path d="M14 ' + (y - 12) + 'h16v24h-16z" fill="#fff" stroke="#999"/><path d="M30 ' + (y - 12) + 'h16l-6 12l6 12h-16z" fill="#1F4FA8"/>';
    });
  }
  return s + '</svg>';
}
let idMode = 'night', compassHeading = null;
function openIdentify() {
  let h = '<h3>What am I looking at?</h3><div class="sub">Tap what you see. Tideline names it, cites the rule and checks it against AIS.</div>' +
    '<div class="seg" role="group" style="margin-bottom:12px"><button type="button" data-idmode="night" class="' + (idMode === 'night' ? 'on' : '') + '">Lights at night</button><button type="button" data-idmode="day" class="' + (idMode === 'day' ? 'on' : '') + '">Shapes by day</button></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">' +
    LIGHT_IDS.filter((o) => o.mode === idMode).map((o) => '<button type="button" class="btn" data-lid="' + o.id + '" style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 8px;height:auto;font-size:12.5px;font-weight:500;text-align:center">' + lightPic(o) + '<span>' + esc(o.name) + '</span></button>').join('') +
    '</div><p class="disclaim">Photo recognition of lights is planned for the app-store version. ' + DISCLAIMER + '</p>';
  openSheet(h);
}
function aisMatches(o) {
  if (!S.fix || !ais.size) return [];
  const list = [];
  ais.forEach((t) => {
    const d = distNm(S.fix, t); if (d > 3) return;
    const brg = bearing(S.fix, t);
    let score = 0;
    if (o.status != null && t.status === o.status) score += 3;
    if (o.match.includes(t.type)) score += 2;
    if (compassHeading != null) score += angDiff(brg, compassHeading) < 15 ? 3 : angDiff(brg, compassHeading) < 35 ? 1 : -2;
    list.push({ t, d, brg, score });
  });
  return list.sort((a, b) => b.score - a.score || a.d - b.d).slice(0, 3);
}
function showIdResult(o) {
  const m = aisMatches(o);
  let h = '<div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">' + lightPic(o) + '<div><h3 style="margin:0">' + esc(o.name) + '</h3><div class="sub" style="margin:2px 0 0">Rule ' + esc(o.cite) + '</div></div></div>' +
    '<p style="font-size:15px;line-height:1.5;margin:0 0 12px">' + esc(o.advice) + '</p>';
  h += '<div class="lbl" style="margin-bottom:6px">AIS CHECK' + (compassHeading != null ? ' · AIMED AT ' + fmtBrg(compassHeading) + '°' : '') + '</div>';
  if (!m.length) h += '<p class="sub">No AIS targets nearby. Many small boats, fishing boats and tows don\'t transmit AIS, so trust your eyes.</p>';
  else h += m.map((x) => '<div class="li"><div class="li-main"><b>' + esc(x.t.name || 'AIS target') + '</b><span>' + esc((x.t.type === 'ship' ? 'Ship' : x.t.type === 'sail' ? 'Sailing vessel' : x.t.type === 'fishing' ? 'Fishing vessel' : 'Power vessel') + (NAV_STATUS[x.t.status] ? ' · ' + NAV_STATUS[x.t.status] : '')) + ' · ' + fmtDist(x.d) + ' at ' + fmtBrg(x.brg) + '°' + (x.score >= 4 ? ' · likely match' : '') + '</span></div><button class="btn small" data-aisid="' + esc(x.t.id) + '">Details</button></div>').join('');
  h += '<div class="row-btns" style="margin-top:12px"><button class="btn" data-act="aim">' + (compassHeading == null ? 'Aim phone at it' : 'Re-aim') + '</button><button class="btn" data-rule="' + esc(o.cite.split(',')[0].trim()) + '">Read the rule</button><button class="btn ghost" data-act="identify">Back</button></div>' +
    '<p class="disclaim">' + DISCLAIMER + '</p>';
  S.lastId = o.id;
  openSheet(h);
}
function startCompass() {
  const onOri = (e) => {
    let hdg = e.webkitCompassHeading != null ? e.webkitCompassHeading : (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (hdg != null) compassHeading = (hdg + 360) % 360;
  };
  const go = () => { window.addEventListener('deviceorientation', onOri, true); window.addEventListener('deviceorientationabsolute', onOri, true); setTimeout(() => { if (compassHeading == null) toast('No compass reading from this device'); else { const o = LIGHT_IDS.find((x) => x.id === S.lastId); if (o) showIdResult(o); } }, 1200); };
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then((r) => (r === 'granted' ? go() : toast('Compass permission was declined'))).catch(() => toast('Compass not available'));
  else go();
  toast('Point the top of the phone at the vessel…');
}
sheet.addEventListener('click', (e) => {
  const m = e.target.closest('[data-idmode]'); if (m) { idMode = m.dataset.idmode; openIdentify(); return; }
  const l = e.target.closest('[data-lid]'); if (l) { showIdResult(LIGHT_IDS.find((x) => x.id === l.dataset.lid)); return; }
  const a = e.target.closest('[data-aisid]'); if (a) { const t = ais.get(a.dataset.aisid); if (t) openAisSheet(t); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'identify') openIdentify();
  if (b.dataset.act === 'aim') startCompass();
});

/* ---------- maintenance ---------- */
S.maint = store.get('maint', { items: [], log: [] });
let maintAll = false;
const saveMaint = () => store.set('maint', S.maint);
const TEMPLATES = {
  outboard: [['Change gearcase (lower unit) oil', 'engine', 12, 100], ['Change engine oil and filter (4-stroke)', 'engine', 12, 100], ['Replace water pump impeller', 'engine', 24, 200], ['Replace spark plugs', 'engine', 24, 200], ['Replace fuel filter / water separator', 'engine', 12, 100], ['Inspect and replace anodes', 'engine', 12, null], ['Grease steering, tilt and swivel points', 'engine', 6, 50]],
  'inboard-diesel': [['Change engine oil and filter', 'engine', 12, 150], ['Replace primary and secondary fuel filters', 'engine', 12, 200], ['Replace raw water pump impeller', 'engine', 12, 300], ['Inspect belts and hoses', 'engine', 6, 100], ['Replace coolant', 'engine', 24, null], ['Inspect exhaust elbow and mixing elbow', 'engine', 24, null], ['Inspect and replace engine anodes / zincs', 'engine', 12, null]],
  'inboard-gas': [['Change engine oil and filter', 'engine', 12, 100], ['Replace fuel filter / water separator', 'engine', 12, 100], ['Replace raw water pump impeller', 'engine', 24, 200], ['Replace spark plugs', 'engine', 24, 200], ['Inspect belts and hoses', 'engine', 6, 100], ['Check flame arrestor', 'engine', 12, null]],
  sterndrive: [['Change engine oil and filter', 'engine', 12, 100], ['Change drive gear oil', 'engine', 12, 100], ['Replace raw water pump impeller', 'engine', 24, 200], ['Inspect bellows and gimbal bearing', 'engine', 12, null], ['Replace drive anodes', 'engine', 12, null]],
  pod: [['Dealer service per manufacturer schedule', 'engine', 12, 250], ['Change engine oil and filters', 'engine', 12, 250], ['Change drive oil', 'engine', 12, 250], ['Replace pod anodes', 'engine', 12, null]],
  sail: [['Rigging inspection (swages, pins, chainplates)', 'rig', 12, null], ['Service winches', 'rig', 12, null], ['Inspect sails and stitching', 'rig', 12, null], ['Check running rigging for chafe', 'rig', 6, null]],
  all: [['Exercise seacocks and through-hulls', 'hull', 6, null], ['Haul out, bottom paint and running gear', 'hull', 12, null], ['Test bilge pumps and float switches', 'hull', 3, null], ['Check battery terminals and voltage', 'electrical', 1, null], ['Check fire extinguisher gauges', 'safety', 1, null], ['Check flare expiration dates', 'safety', 12, null], ['Inspect PFDs and inflatable cartridges', 'safety', 12, null], ['Renew EPIRB/PLB registration (NOAA)', 'safety', 24, null]],
};
function addTemplates() {
  const kind = S.boat.engineKind, rows = [].concat(TEMPLATES[kind] || [], S.settings.boatType === 'sail' ? TEMPLATES.sail : [], TEMPLATES.all);
  let n = 0;
  rows.forEach(([name, sys, months, hours]) => {
    if (S.maint.items.some((i) => i.name === name)) return;
    S.maint.items.push({ id: Date.now() + Math.random(), name, sys, months, hours, lastDate: null, lastHours: null, typical: true }); n++;
  });
  saveMaint(); renderBoat(); toast(n ? 'Added ' + n + ' typical tasks. Edit the intervals to match your manual.' : 'Those tasks are already on your list');
}
function dueInfo(i) {
  const now = Date.now(), hrs = S.boat.engineHours || 0;
  if (!i.lastDate) return { cls: 'unknown', text: 'Never logged', sort: 1e12 - 1 };
  const byDate = i.months ? i.lastDate + i.months * 30.44 * 86400000 : null;
  const byHours = i.hours && i.lastHours != null ? i.lastHours + i.hours : null;
  const daysLeft = byDate ? (byDate - now) / 86400000 : Infinity, hoursLeft = byHours != null ? byHours - hrs : Infinity;
  const over = daysLeft < 0 || hoursLeft < 0, soon = daysLeft < 30 || hoursLeft < 10;
  const parts = [];
  if (byDate) parts.push(daysLeft < 0 ? Math.round(-daysLeft) + ' days overdue' : 'due ' + new Date(byDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
  if (byHours != null) parts.push(hoursLeft < 0 ? Math.round(-hoursLeft) + ' h overdue' : 'or at ' + Math.round(byHours) + ' h');
  return { cls: over ? 'over' : soon ? 'soon' : 'ok', text: parts.join(' '), sort: Math.min(daysLeft, hoursLeft * 3) };
}
function maintHtml() {
  const items = S.maint.items.slice().sort((a, b) => dueInfo(a).sort - dueInfo(b).sort);
  const pill = (c) => ({ over: '<span class="badge" style="background:#FDE2E2;color:#9B1C1C">Overdue</span>', soon: '<span class="badge" style="background:var(--amber-bg);color:var(--amber-ink)">Due soon</span>', ok: '<span class="badge">OK</span>', unknown: '<span class="badge" style="background:var(--surface2);color:var(--ink2)">Not logged</span>' }[c]);
  const q = encodeURIComponent([S.boat.engineMake, S.boat.engineModel].filter(Boolean).join(' '));
  let h = '<div class="card" style="padding:4px 14px 12px"><h4>Maintenance</h4>';
  h += '<div class="set-row"><div class="sr-text"><b>Engine hours</b><span>Update after each trip</span></div><input type="number" inputmode="decimal" id="mHours" value="' + Math.round(S.boat.engineHours || 0) + '" aria-label="Engine hours"></div>';
  if (!items.length) h += '<div class="empty">No tasks yet. Add the typical schedule for your boat, then edit it to match your manuals.</div>';
  const shown = maintAll ? items : items.slice(0, 5);
  h += shown.map((i) => { const d = dueInfo(i); return '<div class="li" style="align-items:flex-start"><div class="li-main"><b style="white-space:normal">' + esc(i.name) + '</b><span>' + pill(d.cls) + ' ' + esc(d.text) + '</span>' +
    '<span style="font-size:12px">Every ' + [i.months ? i.months + ' mo' : '', i.hours ? i.hours + ' h' : ''].filter(Boolean).join(' or ') + (i.typical ? ' (typical, check your manual)' : '') + (i.lastDate ? ' · last ' + new Date(i.lastDate).toLocaleDateString() : '') + '</span>' +
    '<a href="https://www.youtube.com/results?search_query=' + encodeURIComponent(i.name + ' ' + (i.sys === 'engine' ? decodeURIComponent(q) : (S.boat.make || 'boat'))) + '" target="_blank" rel="noopener" style="font-size:12.5px;color:var(--accent)">How-to videos</a></div>' +
    '<div class="li-btns" style="flex-direction:column"><button class="btn small primary" data-mdone="' + i.id + '">Done today</button><button class="btn small" data-mdel="' + i.id + '">Remove</button></div></div>'; }).join('');
  if (items.length > 5) h += '<button class="btn small" data-act="mall" style="margin-top:8px">' + (maintAll ? 'Show fewer' : 'Show all ' + items.length + ' tasks') + '</button>';
  h += '<div class="row-btns" style="margin-top:10px"><button class="btn" data-act="mtemplates">Add typical tasks for my boat</button><button class="btn" data-act="mlog">Log other work</button></div>';
  h += '<div id="mLogForm"></div>';
  if (S.maint.log.length) h += '<h4>Recent work</h4>' + S.maint.log.slice(-6).reverse().map((l) => '<div class="li"><div class="li-main"><b style="white-space:normal">' + esc(l.text) + '</b><span>' + new Date(l.date).toLocaleDateString() + (l.hours != null ? ' · ' + Math.round(l.hours) + ' h' : '') + (l.cost ? ' · $' + esc(l.cost) : '') + '</span></div></div>').join('');
  if (q) h += '<p class="hint" style="margin:10px 0 0">Owner\'s manual: <a href="https://www.google.com/search?q=' + q + '+owner%27s+manual+maintenance+schedule" target="_blank" rel="noopener" style="color:var(--accent)">find the ' + esc(decodeURIComponent(q)) + ' manual</a></p>';
  return h + '</div>';
}
function batteryHtml() {
  const b = S.boat, age = b.batteryInstalled ? (Date.now() - Date.parse(b.batteryInstalled + '-01')) / (365.25 * 86400000) : null;
  return '<div class="card" style="padding:4px 14px 12px"><h4>Battery check</h4>' +
    '<div class="set-row"><div class="sr-text"><b>Resting voltage</b><span>Measured after 2+ hours with nothing charging or running</span></div><input type="number" inputmode="decimal" step="0.01" id="battV" placeholder="12.6" aria-label="Battery voltage"></div>' +
    '<div id="battOut" class="hint" style="margin:6px 0 4px">' + (age != null ? 'Installed ' + age.toFixed(1) + ' years ago. ' + (b.batteryKind === 'lifepo4' ? 'Lithium batteries often last 8 years or more.' : 'Lead-acid, AGM and gel batteries typically last 3 to 6 years.') : 'Add the install date in your boat profile to track its age.') + '</div></div>';
}
function batteryVerdict(v) {
  const k = S.boat.batteryKind;
  if (!(v > 5 && v < 20)) return '';
  if (k === 'lifepo4') {
    if (v >= 13.3) return 'About full.'; if (v >= 13.1) return 'Roughly 50 to 90 percent.'; if (v >= 12.9) return 'Low, roughly 20 percent. Charge soon.';
    return 'Very low for lithium. Charge now and check the battery management system for a cut-off.';
  }
  const t = k === 'gel' ? [12.85, 12.6, 12.4, 12.2] : k === 'agm' ? [12.8, 12.6, 12.4, 12.2] : [12.65, 12.45, 12.25, 12.05];
  if (v >= t[0]) return 'About full.';
  if (v >= t[1]) return 'About 75 percent. Fine.';
  if (v >= t[2]) return 'About 50 percent. Recharge soon; regularly going below half shortens its life.';
  if (v >= t[3]) return 'About 25 percent. Recharge now.';
  if (v >= 11.0) return 'Deeply discharged. Recharge fully, then re-test after resting. If it won\'t hold above 12.4 V, plan to replace it.';
  return 'Below 11 volts: likely a failed cell or a battery that has been flat for a long time. Have it load-tested and plan to replace it.';
}

/* ---------- Boat tab ---------- */
function renderBoat() {
  const p = $('panelBoat');
  const due = S.maint.items.filter((i) => ['over', 'soon'].includes(dueInfo(i).cls)).length;
  $('maintDot').hidden = !due;
  p.innerHTML = '<div class="p-head"><div><div class="eyebrow">Boat</div><h2>' + esc(S.settings.boatName || 'Your boat') + '</h2></div><button class="btn small" data-act="appsettings">App settings</button></div>' +
    fleetHtml() + profileHtml() + lightsCoachHtml() +
    '<div class="card" style="padding:12px 14px"><div class="li" style="border:0;padding:0"><div class="li-main"><b>What am I looking at?</b><span>Identify a vessel from its lights or shapes, cross-checked with AIS</span></div><button class="btn small primary" data-act="identify">Identify</button></div></div>' +
    maintHtml() + batteryHtml() +
    '<p class="hint">Coming in the app-store version: photo recognition of lights, engine fault-code lookup, and live battery and engine data from onboard monitors.</p>';
}
$('panelBoat').addEventListener('click', async (e) => {
  const fl = e.target.closest('[data-fl]'); if (fl) { switchBoat(+fl.dataset.fl); return; }
  const fd = e.target.closest('[data-fldel]'); if (fd) { if (!armed(fd, 'Tap again')) return; S.fleet.boats = S.fleet.boats.filter((x) => x.id !== +fd.dataset.fldel); store.set('fleet', S.fleet); renderBoat(); return; }
  const r = e.target.closest('[data-rule]'); if (r) { if (!isWide()) setTab('chart'); openRuleSheet(r.dataset.rule); return; }
  const dn = e.target.closest('[data-mdone]');
  if (dn) { const i = S.maint.items.find((x) => String(x.id) === dn.dataset.mdone); if (i) { i.lastDate = Date.now(); i.lastHours = S.boat.engineHours || 0; S.maint.log.push({ id: Date.now(), date: Date.now(), hours: i.lastHours, text: i.name }); saveMaint(); renderBoat(); toast('Logged: ' + i.name); } return; }
  const dl = e.target.closest('[data-mdel]');
  if (dl) { if (!armed(dl, 'Tap again')) return; S.maint.items = S.maint.items.filter((x) => String(x.id) !== dl.dataset.mdel); saveMaint(); renderBoat(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'appsettings') setTab('settings');
  if (act === 'fladd') addBoat();
  if (act === 'editboat') { boatEditing = true; renderBoat(); }
  if (act === 'cancelboat') { boatEditing = false; renderBoat(); }
  if (act === 'saveboat') saveBoatForm();
  if (act === 'identify') { if (!isWide()) setTab('chart'); openIdentify(); }
  if (act === 'mtemplates') addTemplates();
  if (act === 'mall') { maintAll = !maintAll; renderBoat(); }
  if (act === 'mlog') $('mLogForm').innerHTML = '<div class="stack" style="margin-top:10px"><div class="field"><label for="mText">What was done</label><input id="mText" type="text" placeholder="Replaced reverse lock bracket"></div><div class="grid2"><div class="field"><label for="mCost">Cost ($)</label><input id="mCost" type="number" inputmode="decimal"></div><div class="field"><label for="mDate">Date</label><input id="mDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></div></div><button class="btn primary" data-act="msave">Save to log</button></div>';
  if (act === 'msave') { const t = $('mText').value.trim(); if (!t) return; S.maint.log.push({ id: Date.now(), date: Date.parse($('mDate').value) || Date.now(), hours: S.boat.engineHours || 0, text: t, cost: $('mCost').value }); saveMaint(); renderBoat(); toast('Saved to the maintenance log'); }
});
$('panelBoat').addEventListener('change', async (e) => {
  if (e.target.id === 'capPhoto' && e.target.files[0]) { try { S.captain.photo = await resizePhoto(e.target.files[0]); store.set('captain', S.captain); renderBoat(); } catch (err) { toast('Could not read that photo'); } }
  if (e.target.id === 'capName' || e.target.id === 'capLic') { S.captain.name = $('capName').value.trim(); S.captain.license = $('capLic').value.trim(); S.settings.skipper = S.captain.name.split(' ')[0] || S.settings.skipper; saveSettings(); store.set('captain', S.captain); }
  if (e.target.id === 'boatPhoto' && e.target.files[0]) {
    try { S.boat.photo = await resizePhoto(e.target.files[0]); saveBoat(); renderBoat(); } catch (err) { toast('Could not read that photo'); }
  }
  if (e.target.id === 'fogBox') { fogMode = e.target.checked; renderBoat(); }
  if (e.target.id === 'mHours') { S.boat.engineHours = parseFloat(e.target.value) || 0; saveBoat(); renderBoat(); }
});
$('panelBoat').addEventListener('change', (e) => {
  if (e.target.id !== 'bMake' && e.target.id !== 'bModel') return;
  const d = boatLookup($('bMake') && $('bMake').value, $('bModel') && $('bModel').value); if (!d) return;
  const L3 = (ft) => String(Math.round(ftToLen(ft) * 10) / 10), put = (id, v) => { const el = $(id); if (el && v != null && !el.value) el.value = v; };
  put('bLen', L3(d.loa)); put('bLwl', L3(d.lwl)); put('bBeam', L3(d.beam)); if (d.draft) put('bDraft', L3(d.draft)); put('bDisp', d.disp);
  const hs = 1.34 * Math.sqrt(lenToFt(parseFloat($('bLwl').value) || ftToLen(d.lwl)));
  if ($('bDbNote')) $('bDbNote').textContent = 'Filled in from the published ' + d.make + ' ' + d.model + ' specs (hull speed about ' + fmtSpeed(hs) + ' ' + SPEED_LBL[S.settings.speedUnit] + '). Check them against your boat; keels and rigs vary.';
});
$('panelBoat').addEventListener('input', (e) => {
  if (e.target.id === 'battV') $('battOut').textContent = batteryVerdict(parseFloat(e.target.value)) || 'Enter a reading such as 12.4';
});

/* ---------- search: marinas, fuel, pump-outs, markers, places ---------- */
const PLACE_TYPES = {
  marina: { label: 'Marina', color: '#0E3A5B', icon: '<path d="M12 4v16M6 10h12M5 14c0 4 3 6 7 6s7-2 7-6"/>' },
  fuel: { label: 'Fuel dock', color: '#C77A12', icon: '<path d="M5 20V5a1 1 0 011-1h7a1 1 0 011 1v15M4 20h11M14 9h2a2 2 0 012 2v5a1.5 1.5 0 003 0V9l-3-3"/><path d="M7 8h5"/>' },
  pumpout: { label: 'Pump-out', color: '#1F8F82', icon: '<path d="M12 3c3 4 5 7 5 10a5 5 0 01-10 0c0-3 2-6 5-10z"/>' },
  ramp: { label: 'Boat ramp', color: '#5B6B7A', icon: '<path d="M3 19L21 9M3 19h18"/>' },
  anchorage: { label: 'Anchorage', color: '#2E6D9E', icon: '<circle cx="12" cy="5" r="2"/><path d="M12 7v13M5 13a7 7 0 0014 0M8 10h8"/>' },
  lighthouse: { label: 'Lighthouse', color: '#B0412F', icon: '<path d="M9 21l1.5-13h3L15 21M8 8h8M10 5h4v3h-4zM12 2v3M5 6l-2-1M19 6l2-1"/>' },
  marker: { label: 'Marker', color: '#2C8A3E', icon: '<path d="M8 20h8M12 4l4 13H8z"/>' },
  bridge: { label: 'Bridge', color: '#6B4FBB', icon: '<path d="M3 10h18M5 10v8M19 10v8M5 15c2-3 5-4 7-4s5 1 7 4"/>' },
  club: { label: 'Yacht or sailing club', color: '#1B4F8A', icon: '<path d="M12 3v15M12 4l6 9h-6M5 19h14l-2 2H7z"/>' },
  place: { label: 'Place', color: '#4A5A68', icon: '<path d="M12 21s-7-7-7-12a7 7 0 0114 0c0 5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>' },
};
const SEARCH_CATS = [
  ['marina', 'Marinas', 30, 'nwr[leisure=marina];nwr["seamark:harbour:category"~"marina"];'],
  ['fuel', 'Fuel', 30, 'nwr[waterway=fuel];nwr[amenity=fuel][boat=yes];nwr["seamark:small_craft_facility:category"~"fuel_station"];nwr[leisure=marina]["fuel:diesel"="yes"];'],
  ['pumpout', 'Pump-out', 30, 'nwr[amenity=sanitary_dump_station];nwr[waterway=sanitary_dump_station];nwr["seamark:small_craft_facility:category"~"pump-out"];nwr[leisure=marina][sanitary_dump_station=yes];'],
  ['ramp', 'Boat ramps', 25, 'nwr[leisure=slipway];'],
  ['anchorage', 'Anchorages', 30, 'nwr["seamark:type"=anchorage];'],
  ['lighthouse', 'Lighthouses', 40, 'nwr[man_made=lighthouse];node["seamark:type"=light_major];'],
  ['marker', 'Markers & lights', 6, 'node["seamark:type"~"^(buoy_lateral|beacon_lateral|buoy_cardinal|beacon_cardinal|buoy_safe_water|buoy_special_purpose|buoy_isolated_danger|beacon_special_purpose|light_minor)$"];'],
  ['bridge', 'Bridges', 25, 'nwr["seamark:type"=bridge];'],
  ['rules', 'Rules of the Road', 0, ''],
];
const OVERPASS = 'https://overpass-api.de/api/interpreter?data=';
const resultsLayer = L.layerGroup().addTo(map);
let searchSeq = 0, searchResults = [], searchCat = null;
const placeIcon = (type, size = 28) => {
  const t = PLACE_TYPES[type] || PLACE_TYPES.place;
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="' + t.color + '" stroke="#fff" stroke-width="2.5"/><g transform="translate(7 7) scale(0.58)" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' + t.icon + '</g></svg>';
};
PLACE_TYPES.rules = { label: 'Rules', color: '#0E3A5B', icon: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5M8 7h8M8 11h6"/>' };
const icoChip = (type) => { const t = PLACE_TYPES[type]; return '<i style="background:' + t.color + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + t.icon + '</svg></i>'; };
function searchCenter() { if (S.fix) return { lat: S.fix.lat, lon: S.fix.lon, from: 'you' }; const c = map.getCenter(); return { lat: c.lat, lon: c.lng, from: 'map' }; }

const FACILITY = { visitor_berth: 'Transient slips', visitors_mooring: 'Moorings', fuel_station: 'Fuel', 'pump-out': 'Pump-out', boat_hoist: 'Boat lift', slipway: 'Ramp', chandler: 'Chandlery', showers: 'Showers', toilets: 'Restrooms', laundrette: 'Laundry', restaurant: 'Restaurant', electricity: 'Shore power', water_tap: 'Water', boatyard: 'Boatyard', refuse_bin: 'Trash', sailmaker: 'Sailmaker', provisions: 'Provisions' };
const COLORS = { white: 'W', red: 'R', green: 'G', yellow: 'Y', blue: 'Bu', orange: 'Or' };
function lightText(t) {
  const ch = t['seamark:light:character'] || t['seamark:light:1:character']; if (!ch) return '';
  const col = (t['seamark:light:colour'] || t['seamark:light:1:colour'] || '').split(';').map((c) => COLORS[c] || '').join('');
  const per = t['seamark:light:period'] || t['seamark:light:1:period'];
  return [ch, col, per ? per + 's' : ''].filter(Boolean).join(' ');
}
function classify(t) {
  const st = t['seamark:type'] || '', scf = t['seamark:small_craft_facility:category'] || '';
  if (t.man_made === 'lighthouse' || st === 'light_major') return 'lighthouse';
  if (t.amenity === 'sanitary_dump_station' || t.waterway === 'sanitary_dump_station' || (/pump-out/.test(scf) && !t.leisure)) return 'pumpout';
  if (t.waterway === 'fuel' || (t.amenity === 'fuel' && t.boat === 'yes') || (/fuel_station/.test(scf) && !t.leisure)) return 'fuel';
  if (t.leisure === 'marina' || /marina/.test(t['seamark:harbour:category'] || '')) return 'marina';
  if (t.leisure === 'slipway') return 'ramp';
  if (/sailing|yacht|boat/.test((t.club || '') + ' ' + (t.sport || '')) || /yacht club|sailing (club|association|center)/i.test(t.name || '')) return 'club';
  if (st === 'anchorage') return 'anchorage';
  if (/^(buoy|beacon|light_minor)/.test(st)) return 'marker';
  if (st === 'bridge') return 'bridge';
  return 'place';
}
function markerName(t) {
  const st = t['seamark:type'] || '';
  const col = (t['seamark:' + st + ':colour'] || '').split(';')[0];
  const shape = t['seamark:' + st + ':shape'] || '';
  const kind = st.startsWith('buoy') ? (shape === 'can' ? 'can' : shape === 'conical' ? 'nun' : 'buoy') : st.startsWith('beacon') ? 'daybeacon' : 'light';
  const num = t['seamark:name'] || t.ref || '';
  return [col ? col[0].toUpperCase() + col.slice(1) : '', kind, num ? '"' + num.replace(/"/g, '') + '"' : ''].filter(Boolean).join(' ');
}
function toPlace(el) {
  const t = el.tags || {}, lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
  if (lat == null) return null;
  const type = classify(t);
  let name = t.name || t['seamark:name'] || '';
  if (type === 'marker') name = t.name || markerName(t);
  if (!name) name = PLACE_TYPES[type].label;
  const scf = (t['seamark:small_craft_facility:category'] || '').split(';').map((s) => FACILITY[s]).filter(Boolean);
  if (t['fuel:diesel'] === 'yes' && !scf.includes('Fuel')) scf.push('Fuel');
  if (t.sanitary_dump_station === 'yes' && !scf.includes('Pump-out')) scf.push('Pump-out');
  return { id: el.type + el.id, name, type, lat, lon, tags: t, badges: scf, light: lightText(t) };
}
async function overpass(body) {
  const q = '[out:json][timeout:25];(' + body + ');out center tags 120;';
  const r = await fetch(OVERPASS + encodeURIComponent(q));
  if (!r.ok) throw new Error('overpass ' + r.status);
  return (await r.json()).elements || [];
}
function around(body, nm, c) {
  const m = Math.round(nm * M_PER_NM);
  return body.split(';').filter(Boolean).map((p) => p + '(around:' + m + ',' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5) + ');').join('');
}
function finishResults(list, seq, c, label) {
  if (seq !== searchSeq) return;
  const seen = new Set();
  searchResults = list.filter(Boolean).filter((p) => { const k = p.name.toLowerCase() + '|' + p.lat.toFixed(3) + '|' + p.lon.toFixed(3); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((p) => Object.assign(p, { d: distNm(c, p), b: bearing(c, p) })).sort((a, b) => a.d - b.d).slice(0, 60);
  $('searchStatus').textContent = searchResults.length ? searchResults.length + ' ' + label + ', nearest first from ' + (c.from === 'you' ? 'you' : 'the map') : 'Nothing found nearby. Try another word or move the chart.';
  $('searchShowMap').hidden = !searchResults.length;
  renderResults(); drawResults();
}
async function categorySearch(key) {
  const cat = SEARCH_CATS.find((x) => x[0] === key); if (!cat) return;
  searchCat = key; renderCats(); $('searchInput').value = '';
  if (key === 'rules') {
    searchSeq++; searchResults = []; $('searchResults').innerHTML = ''; resultsLayer.clearLayers(); $('searchShowMap').hidden = true;
    renderRuleResults(RULES); $('ruleResults').innerHTML = RULES.map((r) => '<button type="button" class="res" data-rule="' + r.n + '"><span class="rule-num">' + (r.n === 'VHF' ? '16' : r.n) + '</span><span class="res-main"><b>' + ruleLabel(r) + ' · ' + esc(r.t) + '</b><span>' + esc(ruleSummary(r)) + '</span></span></button>').join('');
    $('searchStatus').textContent = 'Navigation Rules in plain language. Tap one to read it.';
    return;
  }
  $('ruleResults').innerHTML = '';
  const seq = ++searchSeq, c = searchCenter();
  $('searchStatus').textContent = 'Searching ' + cat[1].toLowerCase() + ' within ' + cat[2] + ' nm…'; $('searchResults').innerHTML = '';
  try {
    const els = await overpass(around(cat[3], cat[2], c));
    finishResults(els.map(toPlace), seq, c, cat[1].toLowerCase());
  } catch (e) { if (seq === searchSeq) $('searchStatus').textContent = 'Search needs an internet connection. Try again when you have signal.'; }
}
async function textSearch(q) {
  searchCat = null; renderCats();
  const seq = ++searchSeq, c = searchCenter();
  renderRuleResults(ruleMatches(q));
  $('searchStatus').textContent = 'Searching…';
  const rx = q.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const body = around('nwr["name"~"' + rx + '",i];nwr["seamark:name"~"' + rx + '",i];', 40, c);
  const [ov, sg] = await Promise.allSettled([overpass(body), suggestPlaces(q, c)]);
  const nom = { status: sg.status, value: sg.status === 'fulfilled' ? sg.value.filter((x) => !x.wp && !x.place).map((x, i) => ({ place_id: 'ph' + i + Date.now(), name: x.name, display_name: x.name + ', ' + (x.sub || ''), type: x.type, lat: x.lat, lon: x.lon })) : null };
  if (seq !== searchSeq) return;
  const list = [];
  if (ov.status === 'fulfilled') ov.value.forEach((el) => list.push(toPlace(el)));
  if (nom.status === 'fulfilled' && Array.isArray(nom.value)) nom.value.forEach((n) => list.push({ id: 'nom' + n.place_id, name: n.name || n.display_name.split(',')[0], type: n.type === 'marina' ? 'marina' : 'place', lat: +n.lat, lon: +n.lon, tags: { address: n.display_name }, badges: [], light: '' }));
  if (ov.status === 'rejected' && nom.status === 'rejected') { $('searchStatus').textContent = 'Search needs an internet connection. Try again when you have signal.'; return; }
  // named marine places first, then towns and addresses
  finishResults(list, seq, c, 'results');
}
function renderCats() {
  $('catRow').innerHTML = SEARCH_CATS.map(([k, label]) => '<button type="button" class="cat' + (searchCat === k ? ' on' : '') + '" data-cat="' + k + '">' + icoChip(k) + label + '</button>').join('');
}
function placeSub(p) {
  const bits = [PLACE_TYPES[p.type].label];
  if (p.light) bits.push(p.light);
  if (p.badges.length) bits.push(p.badges.slice(0, 3).join(', '));
  else if (p.tags['addr:city']) bits.push(p.tags['addr:city']);
  else if (p.tags.address) bits.push(p.tags.address.split(',').slice(1, 3).join(',').trim());
  return bits.join(' · ');
}
function renderResults() {
  $('searchResults').innerHTML = searchResults.map((p, i) => {
    const [dv, du] = distParts(p.d);
    return '<button type="button" class="res" data-i="' + i + '"><span class="res-ico" style="background:' + PLACE_TYPES[p.type].color + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + PLACE_TYPES[p.type].icon + '</svg></span>' +
      '<span class="res-main"><b>' + esc(p.name) + '</b><span>' + esc(placeSub(p)) + '</span></span>' +
      '<span class="res-dist"><b class="tnum">' + dv + '</b><span>' + du + ' · ' + fmtBrg(p.b) + '°</span></span></button>';
  }).join('');
}
function drawResults() {
  resultsLayer.clearLayers();
  searchResults.forEach((p) => {
    const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'place-pin', iconSize: [28, 28], iconAnchor: [14, 14], html: placeIcon(p.type) }) });
    m.on('click', () => openPlaceSheet(p));
    resultsLayer.addLayer(m);
  });
}
function openPlaceSheet(p) {
  S.sheetPoint = { p: { lat: p.lat, lon: p.lon }, wp: null, place: p };
  const t = p.tags, facts = [];
  const add = (k, v) => { if (v) facts.push('<span>' + k + '</span><span>' + v + '</span>'); };
  add('VHF', t['seamark:radio_station:channel'] || t.vhf || t['communication:vhf'] || t['vhf:channel']);
  const phone = t.phone || t['contact:phone'];
  if (phone) add('Phone', '<span class="tnum" style="user-select:all">' + esc(phone) + '</span> <a href="tel:' + esc(phone.replace(/[^+\d]/g, '')) + '">Call</a>');
  const web = t.website || t['contact:website'];
  if (web) add('Website', '<a href="' + esc(/^https?:/.test(web) ? web : 'https://' + web) + '" target="_blank" rel="noopener">' + esc(web.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</a>');
  add('Hours', t.opening_hours && esc(t.opening_hours));
  const fuels = Object.keys(t).filter((k) => /^fuel:/.test(k) && t[k] === 'yes').map((k) => k.slice(5).replace('octane_', '').replace('_', ' '));
  if (fuels.length) add('Fuel', esc(fuels.join(', ')));
  add('Light', p.light && esc(p.light));
  add('Depth', t.depth && esc(t.depth) + (/[a-z]/i.test(t.depth) ? '' : ' m'));
  add('Clearance', t['seamark:bridge:clearance_height'] && esc(t['seamark:bridge:clearance_height']) + ' m');
  add('Slips', t.capacity && esc(t.capacity));
  add('Address', t.address ? esc(t.address) : [t['addr:housenumber'], t['addr:street'], t['addr:city']].filter(Boolean).map(esc).join(' '));
  let html = '<h3>' + esc(p.name) + '</h3><div class="sub">' + PLACE_TYPES[p.type].label + ' · <span class="tnum">' + ddm(p.lat, true) + ' ' + ddm(p.lon, false) + '</span></div>';
  if (p.badges.length) html += '<div class="badges">' + p.badges.map((b) => '<span class="badge">' + esc(b) + '</span>').join('') + '</div>';
  if (S.fix) html += trio(legInfo(S.fix, p));
  if (facts.length) html += '<div class="facts">' + facts.join('') + '</div>';
  html += '<div class="row-btns"><button class="btn primary" data-act="goto">Go to</button><button class="btn" data-act="savewp">Save</button><button class="btn ghost" data-act="close">Close</button></div>';
  html += '<p class="hint" style="margin:12px 0 0;font-size:12px">Place details from OpenStreetMap contributors. Call ahead to confirm fuel and hours.</p>';
  openSheet(html);
}
function showPlace(p) {
  setTab('chart'); setFollow(false);
  map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
  openPlaceSheet(p);
}
let searchDebounce;
$('searchPill').addEventListener('click', () => { setTab('search'); renderCats(); if (!searchResults.length) $('searchStatus').textContent = 'Pick a category or type a name. Nearest results come first.'; setTimeout(() => $('searchInput').focus(), 50); });
$('searchBack').addEventListener('click', () => setTab('chart'));
let srchSugList = [], srchSugSeq = 0;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounce); const q = e.target.value.trim(), box = $('searchSugs');
  if (q.length < 2) { box.hidden = true; return; }
  searchDebounce = setTimeout(async () => { const seq = ++srchSugSeq; const list = await suggestPlaces(q); if (seq !== srchSugSeq) return; srchSugList = list; box.hidden = false; box.innerHTML = placeSugHtml(list, 'data-ssug') + '<button type="button" class="sug all" data-ssugall="1"><b>Search everything for “' + esc(q) + '”</b><span>Marinas, marks and places within 40 nm</span></button>'; }, 250);
});
$('searchSugs').addEventListener('click', (e) => {
  const a = e.target.closest('[data-ssugall]'); if (a) { $('searchSugs').hidden = true; textSearch($('searchInput').value.trim()); return; }
  const g = e.target.closest('[data-ssug]'); if (!g) return; const o = srchSugList[+g.dataset.ssug]; $('searchSugs').hidden = true;
  if (o.place) { showPlace(o.place); return; }
  showPlace({ id: 'sug' + Date.now(), name: o.name, type: o.type || 'place', lat: o.lat, lon: o.lon, tags: { address: o.sub || '' }, badges: [], light: '' });
});
$('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchDebounce); $('searchSugs').hidden = true; const q = e.target.value.trim(); if (q.length >= 2) textSearch(q); e.target.blur(); } });
$('catRow').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (b) categorySearch(b.dataset.cat); });
$('ruleResults').addEventListener('click', (e) => { const b = e.target.closest('[data-rule]'); if (b) { setTab('chart'); openRuleSheet(b.dataset.rule); } });
$('searchResults').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) showPlace(searchResults[+b.dataset.i]); });
$('searchShowMap').addEventListener('click', () => {
  setTab('chart'); setFollow(false);
  if (searchResults.length) map.fitBounds(L.latLngBounds(searchResults.map((p) => [p.lat, p.lon])).pad(0.2), { maxZoom: 15 });
});

/* ---------- controls ---------- */
$('btnFollow').addEventListener('click', () => {
  if (S.fix) { setFollow(true); return; }
  // no GPS (laptop): take me home — your home waypoint if saved, otherwise Annapolis
  const home = S.waypoints.find((w) => /home/i.test(w.name)) || { lat: 38.975, lon: -76.47, name: 'Annapolis' };
  map.setView([home.lat, home.lon], 12); toast('No GPS here, so this is ' + (home.name || 'home') + '. Drag the chart to plan anywhere.', 3500);
});
$('btnZoomIn').addEventListener('click', () => map.zoomIn());
$('btnZoomOut').addEventListener('click', () => map.zoomOut());
$('btnMeasure').addEventListener('click', () => { if (RT.edit) routeMode(false); setMeasure(!S.measure.on); });
$('btnRoute').addEventListener('click', () => routeMode(!RT.edit));
/* satellite: one tap, saved as a preference; falls back to the chart alone if imagery won't load */
const satErr = { n: 0, ok: 0 };
['satellite', 'satHD'].forEach((k) => LAYERS[k].on('tileload', () => { satErr.ok++; }));
['satellite', 'satHD'].forEach((k) => LAYERS[k].on('tileerror', () => {
  satErr.n++;
  if (!S.satFailed && satErr.n >= 16 && satErr.ok === 0 && (S.settings.satOver || S.settings.chart === 'satellite')) { S.satFailed = true; applyChart(); toast('Satellite imagery is not loading here, so you are seeing the chart alone. Tap the globe to try again.', 5000); }
}));
$('btnSat').addEventListener('click', () => {
  if (window.TL_DEMO) { toast('The demo uses a sample chart. In the app, this button lays the chart over satellite imagery.', 4500); return; }
  // cycle: chart only -> chart over satellite -> satellite only -> chart only
  const st = S.settings, mode = st.chart === 'satellite' ? 'sat' : st.satOver ? 'blend' : 'chart';
  S.satFailed = false; satErr.n = satErr.ok = 0;
  if (mode === 'chart') { st.chart = 'noaa'; st.satOver = true; }
  else if (mode === 'blend') { st.chart = 'satellite'; }
  else { st.chart = 'noaa'; st.satOver = false; }
  saveSettings(); applyChart();
  toast(st.chart === 'satellite' ? 'Satellite only (' + (st.satSrc === 'hd' ? 'HD' : 'standard') + '). Tap again for the chart.' : st.satOver ? 'Chart over satellite. Tap again for satellite only.' : 'Chart only. Tap again for satellite.', 2600);
});

/* quick layers: one tap on the layers button shows every on/off choice as big toggles */
const QUICK = [
  ['sat', 'Satellite', () => S.settings.satOver || S.settings.chart === 'satellite', (on) => { S.settings.satOver = on; if (!on && S.settings.chart === 'satellite') S.settings.chart = 'noaa'; S.satFailed = false; applyChart(); }],
  ['wind', 'Wind', () => wxOn('wind'), (on) => setWxL('wind', on)],
  ['waves', 'Waves', () => wxOn('waves'), (on) => setWxL('waves', on)],
  ['rain', 'Rain radar', () => wxOn('rain'), (on) => setWxL('rain', on)],
  ['mp', 'Marinas & clubs', () => S.settings.mplaces !== false, (on) => { S.settings.mplaces = on; refreshMarinePlaces(); }],
  ['br', 'Bridges', () => S.settings.bridges !== false, (on) => { S.settings.bridges = on; refreshBridges(true); }],
  ['ais', 'AIS boats', () => S.settings.aisShow !== false, (on) => { S.settings.aisShow = on; updateAis(); }],
  ['towns', 'Town names', () => S.settings.landPlaces !== false, (on) => { S.settings.landPlaces = on; applyChart(); }],
  ['roads', 'Roads', () => !!S.settings.landRoads, (on) => { S.settings.landRoads = on; applyChart(); }],
  ['rings', 'Range rings', () => !!S.settings.rings, (on) => { S.settings.rings = on; drawRings(); }],
  ['chips', 'Wind & tide chips', () => !!S.settings.chips, (on) => { S.settings.chips = on; applyCalm(); }],
];
function renderQuick() {
  const q = $('quick'), sz = S.settings.pinSize || 'M';
  q.innerHTML = '<div class="q-head"><b>On the chart</b><button type="button" class="sheet-x" data-qx aria-label="Close">&times;</button></div><div class="q-grid">' +
    QUICK.map(([k, l, get]) => '<button type="button" class="q-t' + (get() ? ' on' : '') + '" data-q="' + k + '" aria-pressed="' + get() + '"><i></i>' + l + '</button>').join('') + '</div>' +
    '<div class="q-h">Symbol and label size</div><div class="seg">' + [['S', 'Small'], ['M', 'Medium'], ['L', 'Large'], ['XL', 'Extra large']].map(([v, l]) => '<button type="button" data-qsz="' + v + '" class="' + (sz === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
    (RT.line.getLatLngs().length ? '<button type="button" class="btn small q-more" data-qclear>Clear the route line</button>' : '') +
    '<button type="button" class="btn small q-more" data-qmore>More map options</button>';
}
function toggleQuick(show) { const q = $('quick'); const on = show == null ? q.hidden : show; if (on) { closeSheet(); renderQuick(); } q.hidden = !on; $('btnLayers').classList.toggle('on', on); }
$('quick').addEventListener('click', (e) => {
  if (e.target.closest('[data-qx]')) { toggleQuick(false); return; }
  if (e.target.closest('[data-qclear]')) { toggleQuick(false); clearRouteEverywhere(); return; }
  if (e.target.closest('[data-qmore]')) { toggleQuick(false); openLayersSheet(); return; }
  const z = e.target.closest('[data-qsz]'); if (z) { S.settings.pinSize = z.dataset.qsz; saveSettings(); applyPinSize(); renderQuick(); return; }
  const t = e.target.closest('[data-q]'); if (!t) return; const it = QUICK.find((x) => x[0] === t.dataset.q); if (!it) return;
  it[3](!it[2]()); saveSettings(); renderQuick();
});
map.on('click', () => { if (!$('quick').hidden) toggleQuick(false); });
function applyPinSize() { const sz = S.settings.pinSize || 'M'; document.documentElement.dataset.pins = sz; if (typeof drawMarinePlaces === 'function') drawMarinePlaces(); if (typeof drawBridges === 'function') drawBridges(); }
$('btnLayers').addEventListener('click', () => toggleQuick());
$('windChip').addEventListener('click', () => { setTab('chart'); setWxL('wind', !wxOn('wind')); });
$('windChip').dataset.tip = 'Wind: tap to show wind across the chart'; $('waveChip').dataset.tip = 'Waves: tap to show waves across the chart'; $('tideChip').dataset.tip = 'Tide: tap for the tide curve'; $('modeChip').dataset.tip = 'Tap to switch between sail and engine';
$('waveChip').addEventListener('click', () => { setTab('chart'); setWxL('waves', !wxOn('waves')); });
$('tideChip').addEventListener('click', () => { WX.view = 'tide'; WX.open = true; setTab('weather'); });
$('gpsPill').addEventListener('click', () => {
  if (S.fix) toast(ddm(S.fix.lat, true) + '  ' + ddm(S.fix.lon, false));
  else if (S.gpsErr === 1) toast('Location is blocked for this site. Allow it in your browser settings and reload.', 5000);
  else toast('Waiting for a GPS fix. Open sky helps. Settings › Demo mode lets you try the app without GPS.', 5000);
});
$('bottomStack').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'endgoto') endGoto();
  if (b.dataset.act === 'clearmob') {
    if (!armed(b, 'Tap again')) return;
    S.mob = null; store.set('mob', null); updateMob();
    if (S.goto && S.goto.name === 'Man overboard') endGoto();
  }
});
map.on('dragstart', () => setFollow(false));
map.on('contextmenu', (e) => openPointSheet(e.latlng));
map.on('click', (e) => {
  if (S.measure.on) { measureTap(e.latlng); return; }
  if (RT.edit) { routeAdd(e.latlng); return; }
  if (!sheet.hidden) closeSheet();
});


/* ---------- bridges: clearance labels and checks against your boat ---------- */
const BR = { list: new Map(store.get('bridges', [])), tiles: store.get('bridgeTiles', {}), busy: false, timer: null, warned: new Map(), layer: L.layerGroup().addTo(map) };
const M2FT = 3.28084;
const num = (v) => { const n = parseFloat(String(v || '').replace(',', '.')); return isFinite(n) ? n : null; };
const isFeet = (v) => /ft|feet|'|"/i.test(String(v || ''));
function toBridge(el) {
  const t = el.tags || {}, lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
  if (lat == null) return null;
  const cat = t['seamark:bridge:category'] || '';
  const movable = /opening|bascule|swing|lifting|draw|retractable|transporter/.test(cat) || !!t['bridge:movable'];
  const h = (k) => { const v = num(t[k]); return v == null ? null : isFeet(t[k]) ? v : v * M2FT; }; // OpenSeaMap stores metres; some mappers type feet
  const closed = h('seamark:bridge:clearance_height_closed') ?? h('seamark:bridge:clearance_height') ?? (num(t.maxheight) != null && t['seamark:type'] === 'bridge' ? num(t.maxheight) * M2FT : null);
  return {
    id: el.type + el.id, lat, lon, name: t.name || t['seamark:name'] || t['bridge:name'] || (movable ? 'Drawbridge' : 'Bridge'),
    closed, open: h('seamark:bridge:clearance_height_open'), width: h('seamark:bridge:clearance_width'), movable, cat,
    vhf: t['seamark:radio_station:channel'] || t.vhf || t['communication:vhf'] || t['vhf:channel'] || '',
    phone: t.phone || t['contact:phone'] || '', hours: t['seamark:bridge:opening_hours'] || t.opening_hours || '',
  };
}
function tideAboveMHW() {
  const tn = tideNow(), t = S.tide;
  if (!tn || !t || t.mhw == null) return null;
  return { ft: tn.v - t.mhw, station: t.station };
}
function judgeBridge(b) {
  const air = S.boat.airDraftFt, beam = S.boat.beamFt, margin = S.settings.bridgeMargin || 0, tide = tideAboveMHW();
  const out = { level: 'info', tide, eff: null, notes: [], unc: null };
  if (b.closed == null) { out.text = 'Clearance unknown. Check the chart and verify before proceeding.'; out.level = b.movable ? 'caution' : 'info'; return out; }
  // Uncertainty: the nearest tide station may not match the water at the bridge; wind and surge add more.
  out.unc = tide ? Math.min(2, 0.5 + 0.1 * (tide.station.dist || 0)) : 1;
  out.eff = b.closed - (tide ? tide.ft : 0);
  if (!air) { out.text = 'Estimated clearance ' + fmtLen(out.eff) + '. Add your air draft in Boat to get a check.'; return out; }
  const room = out.eff - out.unc - air, est = 'estimated ' + fmtLen(out.eff) + ' (±' + tideLen(out.unc) + ')';
  if (room >= margin) { out.level = 'ok'; out.text = 'Clearance ' + est + ', your air draft ' + fmtLen(air) + '. Estimated margin ' + fmtLen(room + out.unc) + '.'; }
  else if (out.eff - air >= 0) { out.level = 'caution'; out.text = 'Estimated margin only ' + fmtLen(Math.max(0, out.eff - air)) + ', below your ' + fmtLen(margin) + ' setting (clearance ' + est + ', air draft ' + fmtLen(air) + '). Water level and clearance are uncertain. Verify clearance before proceeding.'; }
  else if (b.movable) { out.level = 'opening'; out.text = 'Too low for you closed: clearance ' + est + ', air draft ' + fmtLen(air) + '. You need an opening' + (b.vhf ? '; call on VHF ' + b.vhf : '') + '.'; }
  else { out.level = 'no'; out.text = 'Too low: clearance ' + est + ', air draft ' + fmtLen(air) + '. Do not attempt.'; }
  if (b.width != null && beam) {
    if (b.width < beam) { out.level = 'no'; out.notes.push('Too narrow: ' + fmtLen(b.width) + ' wide, your beam ' + fmtLen(beam) + '.'); }
    else if (b.width < beam + 2 * margin + 4) { if (out.level === 'ok') out.level = 'caution'; out.notes.push('Narrow: ' + fmtLen(b.width) + ' between fenders, your beam ' + fmtLen(beam) + '.'); }
  }
  if (!tide) out.notes.push('Tide not applied: no datum for the nearest station. Above-average tides or surge leave less room.');
  return out;
}
const BR_COL = { ok: '#2E8B57', caution: '#E8952B', opening: '#E8952B', no: '#D64545', info: '#0E3A5B' };
function drawBridges() {
  BR.layer.clearLayers();
  if (!S.settings.bridges || map.getZoom() < 12) return;
  const b = map.getBounds().pad(0.2);
  const taken = [];
  BR.list.forEach((br) => {
    if (!b.contains([br.lat, br.lon])) return;
    if (br.closed == null && map.getZoom() < 15.5) return; // no charted height: only show when zoomed right in
    const pt = map.latLngToContainerPoint([br.lat, br.lon]); if (taken.some((q) => Math.abs(q.x - pt.x) < 96 && Math.abs(q.y - pt.y) < 30)) return; taken.push(pt);
    const j = judgeBridge(br), col = BR_COL[j.level];
    const h = br.closed == null ? '?' : Math.round(ftToLen(j.eff != null ? j.eff : br.closed));
    const html = '<div class="br-pin" style="--c:' + col + '" title="Height under the bridge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h18M5 9v9M19 9v9M5 14c2-3 5-4 7-4s5 1 7 4"/></svg><b>' + h + '</b>' + lenUnit() + '<span>' + (br.movable ? 'high · opens' : 'high') + '</span></div>';
    const m = L.marker([br.lat, br.lon], { zIndexOffset: 600, keyboard: false, icon: L.divIcon({ className: '', iconSize: [92, 28], iconAnchor: [46, 14], html }) });
    m.on('click', () => openBridgeSheet(br));
    BR.layer.addLayer(m);
  });
}
function openBridgeSheet(br) {
  const j = judgeBridge(br), rows = [];
  const add = (k, v) => { if (v) rows.push('<span>' + k + '</span><span>' + v + '</span>'); };
  add(br.movable ? 'Height when closed' : 'Height under the bridge', br.closed != null ? fmtLen(br.closed) + ' at high water' : 'Not listed');
  if (br.open != null) add('Open clearance', fmtLen(br.open));
  if (br.width != null) add('Width of the opening', fmtLen(br.width));
  if (j.tide) add('Tide now', (j.tide.ft >= 0 ? tideLen(j.tide.ft) + ' above' : tideLen(-j.tide.ft) + ' below') + ' average high water, from ' + esc(j.tide.station.name) + ' (' + fmtDist(j.tide.station.dist) + ' away)');
  if (j.eff != null && j.tide) add('Clearance now', fmtLen(j.eff));
  add('Your air draft', S.boat.airDraftFt ? fmtLen(S.boat.airDraftFt) : '<a href="#" data-act="editboatair">Add it</a>');
  if (S.boat.beamFt) add('Your beam', fmtLen(S.boat.beamFt));
  add('VHF', br.vhf && esc(br.vhf));
  if (br.phone) add('Bridge tender', '<span class="tnum">' + esc(br.phone) + '</span> <a href="tel:' + esc(br.phone.replace(/[^+\d]/g, '')) + '">Call</a>');
  add('Openings', br.hours ? esc(br.hours) : br.movable ? 'Schedules and restrictions: Coast Guard drawbridge rules (33 CFR 117)' : '');
  S.sheetPoint = { p: { lat: br.lat, lon: br.lon }, place: { name: br.name } };
  openSheet('<h3>' + esc(br.name) + '</h3><div class="verdict v-' + j.level + '">' + esc(j.text) + (j.notes.length ? '<br>' + j.notes.map(esc).join('<br>') : '') + '</div><div class="facts">' + rows.join('') + '</div>' +
    '<p class="hint"><b>Source: OpenSeaMap volunteers, not yet checked against NOAA.</b> The NOAA chart prints the official clearance beside each bridge (zoom in). If they differ, trust the chart. Clearance is measured at average high water. Predicted tide is applied where the station publishes its datums; wind and surge can raise the water further. Verify by eye and with the bridge tender.</p>' +
    '<div class="row-btns"><button class="btn primary" data-act="goto">Go to</button>' + (br.movable ? '<a class="btn" href="https://www.ecfr.gov/current/title-33/chapter-I/subchapter-J/part-117" target="_blank" rel="noopener">Opening rules</a>' : '') + '<button class="btn ghost" data-act="close">Close</button></div>');
}
const TILE_DEG = 0.1;
async function refreshBridges(force) {
  if (!S.settings.bridges) { BR.layer.clearLayers(); $('bridgeCard').hidden = true; return; }
  drawBridges();
  if (BR.busy || map.getZoom() < 11) return;
  const b = map.getBounds(), keys = [];
  for (let la = Math.floor(b.getSouth() / TILE_DEG); la <= Math.floor(b.getNorth() / TILE_DEG); la++)
    for (let lo = Math.floor(b.getWest() / TILE_DEG); lo <= Math.floor(b.getEast() / TILE_DEG); lo++) {
      const k = la + ',' + lo;
      if (force || !BR.tiles[k] || Date.now() - BR.tiles[k] > 14 * 86400000) keys.push([la, lo, k]);
    }
  if (!keys.length) return;
  BR.busy = true;
  const batch = keys.slice(0, 30);
  const s0 = Math.min(...batch.map((k) => k[0])), w0 = Math.min(...batch.map((k) => k[1])), n0 = Math.max(...batch.map((k) => k[0])) + 1, e0 = Math.max(...batch.map((k) => k[1])) + 1;
  try {
    const bb = '(' + (s0 * TILE_DEG).toFixed(2) + ',' + (w0 * TILE_DEG).toFixed(2) + ',' + (n0 * TILE_DEG).toFixed(2) + ',' + (e0 * TILE_DEG).toFixed(2) + ')';
    const els = await overpass('nwr["seamark:type"="bridge"]' + bb + ';way["bridge:movable"]' + bb + ';nwr[~"^seamark:bridge:clearance"~"."]' + bb + ';');
    els.map(toBridge).filter(Boolean).forEach((br) => {
      const dup = [...BR.list.values()].find((o) => o.id !== br.id && distNm(o, br) < 0.08 && (o.name === br.name || br.closed == null));
      if (dup) { if (dup.closed == null && br.closed != null) { BR.list.delete(dup.id); BR.list.set(br.id, br); } return; }
      BR.list.set(br.id, br);
    });
    batch.forEach((k) => { BR.tiles[k[2]] = Date.now(); });
    if (BR.list.size > 1500) BR.list = new Map([...BR.list.entries()].slice(-1500));
    store.set('bridges', [...BR.list.entries()]); store.set('bridgeTiles', BR.tiles);
  } catch (e) { /* offline: keep what we have */ }
  BR.busy = false; drawBridges(); checkBridgesAhead();
  if (keys.length > 30) { clearTimeout(BR.timer); BR.timer = setTimeout(() => refreshBridges(), 1500); }
}
map.on('moveend', () => { clearTimeout(BR.timer); BR.timer = setTimeout(() => refreshBridges(), 900); });
/* ---------- marine places on the chart: marinas, yacht and sailing clubs, fuel docks, ramps ---------- */
const MP = { list: new Map(store.get('mplaces', [])), tiles: store.get('mpTiles', {}), layer: L.layerGroup().addTo(map), busy: false, timer: null };
function hasFuel(t) { t = t || {}; return t.waterway === 'fuel' || t.amenity === 'fuel' || /fuel_station/.test(t['seamark:small_craft_facility:category'] || '') || Object.keys(t).some((k) => /^fuel:/.test(k) && t[k] === 'yes'); }
function drawMarinePlaces() {
  MP.layer.clearLayers();
  if (S.settings.mplaces === false || map.getZoom() < 12.5) return;
  const b = map.getBounds().pad(0.1), z = map.getZoom(), taken = [];
  const rank = { fuel: 0, club: 1, marina: 2, pumpout: 3, ramp: 4 };
  [...MP.list.values()].filter((p) => b.contains([p.lat, p.lon])).sort((a, c) => (rank[a.type] ?? 9) - (rank[c.type] ?? 9)).forEach((p) => {
    const pt = map.latLngToContainerPoint([p.lat, p.lon]); if (taken.some((q) => Math.abs(q.x - pt.x) < 110 && Math.abs(q.y - pt.y) < 22)) return; taken.push(pt);
    const t = PLACE_TYPES[p.type] || PLACE_TYPES.place, sz = S.settings.pinSize || 'M', named = sz !== 'S' && z >= (sz === 'M' ? 14.5 : sz === 'L' ? 14 : 13.5) && p.name && p.name !== t.label;
    const fuel = p.type !== 'fuel' && hasFuel(p.tags);
    const html = '<div class="mp-pin" title="' + esc(p.name) + (fuel ? ' · fuel dock' : '') + '"><i style="background:' + t.color + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + t.icon + '</svg>' + (fuel ? '<u class="fuel-dot" aria-label="fuel"><svg viewBox="0 0 24 24"><path d="M12 3c3 4 5 7 5 10a5 5 0 01-10 0c0-3 2-6 5-10z"/></svg></u>' : '') + '</i>' + (named ? '<span>' + esc(p.name) + (fuel ? ' <b class="fuel-tag">FUEL</b>' : '') + '</span>' : '') + '</div>';
    const m = L.marker([p.lat, p.lon], { zIndexOffset: 500, keyboard: false, icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html }) });
    m.on('click', () => openPlaceSheet(Object.assign({ badges: [], light: '' }, p)));
    MP.layer.addLayer(m);
  });
}
async function refreshMarinePlaces() {
  drawMarinePlaces();
  if (S.settings.mplaces === false || MP.busy || map.getZoom() < 11.5) return;
  const b = map.getBounds(), keys = [];
  for (let la = Math.floor(b.getSouth() / TILE_DEG); la <= Math.floor(b.getNorth() / TILE_DEG); la++)
    for (let lo = Math.floor(b.getWest() / TILE_DEG); lo <= Math.floor(b.getEast() / TILE_DEG); lo++) { const k = la + ',' + lo; if (!MP.tiles[k] || Date.now() - MP.tiles[k] > 14 * 86400000) keys.push([la, lo, k]); }
  if (!keys.length) return;
  MP.busy = true; const batch = keys.slice(0, 20);
  const s0 = Math.min(...batch.map((k) => k[0])), w0 = Math.min(...batch.map((k) => k[1])), n0 = Math.max(...batch.map((k) => k[0])) + 1, e0 = Math.max(...batch.map((k) => k[1])) + 1;
  const bb = '(' + (s0 * TILE_DEG).toFixed(2) + ',' + (w0 * TILE_DEG).toFixed(2) + ',' + (n0 * TILE_DEG).toFixed(2) + ',' + (e0 * TILE_DEG).toFixed(2) + ')';
  try {
    const els = await overpass(['nwr[leisure=marina]', 'nwr[club~"sailing|yacht|boat"]', 'nwr[sport=sailing][name]', 'nwr[name~"Yacht Club|Sailing"]', 'nwr[waterway=fuel]', 'nwr[amenity=fuel][boat=yes]', 'nwr[leisure=slipway]', 'nwr[amenity=sanitary_dump_station]'].map((q) => q + bb).join(';') + ';');
    els.map(toPlace).filter(Boolean).forEach((p) => { if (p.type === 'place' && /yacht|sailing/i.test(p.name)) p.type = 'club'; if (p.type !== 'place') MP.list.set(p.id, { id: p.id, name: p.name, type: p.type, lat: p.lat, lon: p.lon, tags: p.tags }); });
    batch.forEach((k) => { MP.tiles[k[2]] = Date.now(); });
    if (MP.list.size > 2000) MP.list = new Map([...MP.list.entries()].slice(-2000));
    try { store.set('mplaces', [...MP.list.entries()]); store.set('mpTiles', MP.tiles); } catch (e) { /* storage full */ }
  } catch (e) { /* offline */ }
  MP.busy = false; drawMarinePlaces();
  if (keys.length > 20) { clearTimeout(MP.timer); MP.timer = setTimeout(refreshMarinePlaces, 1500); }
}
map.on('moveend', () => { clearTimeout(MP.timer); MP.timer = setTimeout(refreshMarinePlaces, 1100); });
map.on('zoomend', drawMarinePlaces);
setTimeout(refreshMarinePlaces, 2000);

function checkBridgesAhead() {
  const card = $('bridgeCard'), f = S.fix;
  if (!S.settings.bridges || !S.goto || !f || !(S.sog > 1.5) || S.cog == null) { card.hidden = true; return; }
  let hit = null;
  BR.list.forEach((br) => {
    const d = distNm(f, br); if (d > 2.5) return;
    const off = angDiff(bearing(f, br), S.cog); if (off > 30 && d > 0.15) return;
    if (BR.dismissed && BR.dismissed.has(br.id)) return;
    const j = judgeBridge(br); if (j.level === 'ok' || j.level === 'info') return;
    if (!hit || d < hit.d) hit = { br, j, d };
  });
  if (!hit) { card.hidden = true; return; }
  const { br, j, d } = hit;
  card.hidden = false; card.className = 'bridge-card v-' + j.level;
  card.innerHTML = '<button type="button" class="card-x" data-bclose="' + esc(br.id) + '" aria-label="Close">&times;</button><div class="bc-top"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10h18M5 10v8M19 10v8M5 15c2-3 5-4 7-4s5 1 7 4"/></svg><b>' + esc(br.name) + '</b><span class="tnum">' + fmtDist(d) + ' ahead · ' + fmtDur(d / Math.max(S.sog, 0.5)).replace(' min', 'm') + '</span></div>' +
    '<div class="bc-text">' + esc(j.text) + (j.notes.length ? ' ' + j.notes.map(esc).join(' ') : '') + '</div>' +
    '<div class="bc-btns">' + (br.phone ? '<a class="btn small" href="tel:' + esc(br.phone.replace(/[^+\d]/g, '')) + '">Call tender</a>' : '') + '<button type="button" class="btn small" data-bridge="' + esc(br.id) + '">Details</button></div>';
  const prev = BR.warned.get(br.id);
  if (prev !== j.level) {
    BR.warned.set(br.id, j.level);
    const who = S.settings.skipper ? S.settings.skipper + ', ' : '';
    headsUp(who + 'bridge ahead, ' + fmtDist(d).replace('nm', 'nautical miles').replace('ft', 'feet') + '. ' + j.text.replace(/VHF/g, 'channel'));
    if (j.level === 'no' || j.level === 'opening') beep(2);
  }
}
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-bclose]'); if (x) { (BR.dismissed = BR.dismissed || new Set()).add(x.dataset.bclose); $('bridgeCard').hidden = true; return; }
  const b = e.target.closest('[data-bridge]'); if (b) { const br = BR.list.get(b.dataset.bridge); if (br) openBridgeSheet(br); }
  const a = e.target.closest('[data-act="editboatair"]'); if (a) { e.preventDefault(); closeSheet(); setTab('boat'); }
});
setInterval(checkBridgesAhead, 5000);


/* ---------- cockpit display: big, glanceable, tap-locked (iPad on deck) ---------- */
let cockTimer = null;
/* ---------- instrument gauges: glass-cockpit style, all text inside SVG so nothing is ever cut off ---------- */
const G = { cx: 100, cy: 100 };
function polar(r, deg) { const a = (deg - 90) * Math.PI / 180; return [G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)]; }
function arcPath(r, a0, a1) { const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1), large = a1 - a0 > 180 ? 1 : 0; return 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1); }
function gWrap(label, svg, foot, cls) { return '<div class="gauge' + (cls ? ' ' + cls : '') + '"><div class="g-lbl">' + label + '</div><svg viewBox="0 0 200 200" aria-hidden="true">' + svg + '</svg><div class="g-foot">' + (foot || '&nbsp;') + '</div></div>'; }
function speedGauge(v, max, top) {
  const A0 = -135, A1 = 135, f = (x) => A0 + (A1 - A0) * Math.min(1, Math.max(0, x / top));
  let ticks = '';
  for (let k = 0; k <= top; k += top <= 12 ? 1 : 5) { const big = k % (top <= 12 ? 2 : 10) === 0, [x0, y0] = polar(big ? 76 : 80, f(k)), [x1, y1] = polar(88, f(k)); ticks += '<line x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y2="' + y1.toFixed(1) + '" class="g-tick' + (big ? ' big' : '') + '"/>'; if (big) { const [tx, ty] = polar(64, f(k)); ticks += '<text x="' + tx.toFixed(1) + '" y="' + (ty + 4).toFixed(1) + '" class="g-num">' + k + '</text>'; } }
  const val = v == null ? null : v;
  const [mx, my] = polar(92, f(max || 0));
  return '<path d="' + arcPath(84, A0, A1) + '" class="g-track"/>' + (val ? '<path d="' + arcPath(84, A0, f(val)) + '" class="g-fill"/>' : '') + ticks +
    (max ? '<circle cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="3.5" class="g-max"/>' : '') +
    '<text x="100" y="112" class="g-big">' + (val == null ? '–' : fmtSpeed(val)) + '</text><text x="100" y="138" class="g-unit">' + SPEED_LBL[S.settings.speedUnit] + '</text>';
}
function compassGauge(cog) {
  const rot = cog == null ? 0 : -cog; let card = '';
  for (let d = 0; d < 360; d += 10) { const big = d % 30 === 0, [x0, y0] = polar(big ? 74 : 79, d), [x1, y1] = polar(86, d); card += '<line x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y2="' + y1.toFixed(1) + '" class="g-tick' + (big ? ' big' : '') + '"/>'; }
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, d]) => { const [x, y] = polar(66, d); card += '<text x="' + x.toFixed(1) + '" y="' + (y + 5).toFixed(1) + '" class="g-card' + (t === 'N' ? ' n' : '') + '" transform="rotate(' + (-rot) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')">' + t + '</text>'; });
  return '<circle cx="100" cy="100" r="88" class="g-ring"/><g transform="rotate(' + rot + ' 100 100)">' + card + '</g><path d="M100 6 L93 20 L107 20 Z" class="g-lubber"/>' +
    '<circle cx="100" cy="100" r="52" class="g-hub"/><text x="100" y="110" class="g-big cmp">' + (cog == null ? '–' : fmtBrg(cog) + '°') + '</text><text x="100" y="132" class="g-unit">' + (cog == null ? 'not moving' : 'true · ' + compass16(cog)) + '</text>';
}
function windGauge(dir, spd, gust, cog) {
  const rel = dir == null ? null : ((dir - (cog || 0)) % 360 + 360) % 360; // where the wind comes from, relative to the bow
  let ticks = '';
  for (let d = 0; d < 360; d += 30) { const [x0, y0] = polar(80, d), [x1, y1] = polar(88, d); ticks += '<line x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y2="' + y1.toFixed(1) + '" class="g-tick big"/>'; }
  const port = '<path d="' + arcPath(84, 300, 340) + '" class="g-port"/>', stbd = '<path d="' + arcPath(84, 20, 60) + '" class="g-stbd"/>';
  let arrow = '';
  if (rel != null) { const [ax, ay] = polar(86, rel), [bx, by] = polar(58, rel); arrow = '<line x1="' + ax.toFixed(1) + '" y1="' + ay.toFixed(1) + '" x2="' + bx.toFixed(1) + '" y2="' + by.toFixed(1) + '" class="g-wind"/><circle cx="' + ax.toFixed(1) + '" cy="' + ay.toFixed(1) + '" r="7" class="g-windhead"/>'; }
  return '<circle cx="100" cy="100" r="88" class="g-ring"/>' + port + stbd + ticks + '<path d="M100 60 C112 76 112 120 106 140 L94 140 C88 120 88 76 100 60Z" class="g-hull"/>' + arrow +
    '<text x="100" y="112" class="g-big sm">' + (spd == null ? '–' : Math.round(speedOut(spd))) + '</text><text x="100" y="134" class="g-unit">' + (gust != null ? 'gust ' + Math.round(speedOut(gust)) : SPEED_LBL[S.settings.speedUnit]) + '</text>';
}
function tideGauge(tn) {
  const t = S.tide, now = Date.now(), hl = (t.hilo || []), prev = hl.filter((p) => p.t <= now).pop(), next = tn.next;
  const lo = Math.min(prev ? prev.v : tn.v, next ? next.v : tn.v), hi = Math.max(prev ? prev.v : tn.v, next ? next.v : tn.v);
  const frac = hi - lo > 0.05 ? (tn.v - lo) / (hi - lo) : 0.5, A0 = -120, A1 = 120, a = A0 + (A1 - A0) * frac;
  const [px, py] = polar(84, a);
  return '<path d="' + arcPath(84, A0, A1) + '" class="g-track"/><path d="' + arcPath(84, A0, a) + '" class="g-fill tide"/><circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="6" class="g-dot"/>' +
    '<text x="34" y="176" class="g-num">' + (lo).toFixed(1) + '</text><text x="166" y="176" class="g-num">' + (hi).toFixed(1) + '</text>' +
    '<text x="100" y="106" class="g-big sm">' + tideLen(tn.v).split(' ')[0] + '</text><text x="100" y="130" class="g-unit">' + lenUnit() + ' · ' + (tn.rising == null ? '' : tn.rising ? 'rising ▲' : 'falling ▼') + '</text>';
}
function steerGauge(brg, cog, d) {
  const off = cog == null ? 0 : ((brg - cog + 540) % 360) - 180;
  const [ax, ay] = polar(74, off), [bx, by] = polar(40, off);
  return '<circle cx="100" cy="100" r="88" class="g-ring"/><path d="M100 6 L93 20 L107 20 Z" class="g-lubber"/><line x1="' + bx.toFixed(1) + '" y1="' + by.toFixed(1) + '" x2="' + ax.toFixed(1) + '" y2="' + ay.toFixed(1) + '" class="g-steer"/><circle cx="' + ax.toFixed(1) + '" cy="' + ay.toFixed(1) + '" r="8" class="g-steerhead"/>' +
    '<text x="100" y="112" class="g-big sm">' + distParts(d)[0] + '</text><text x="100" y="134" class="g-unit">' + distParts(d)[1] + ' · ' + fmtBrg(brg) + '°T</text>';
}
function anchorGauge(ft, radius) {
  const frac = radius ? Math.min(1.2, (ft || 0) / radius) : 0, A0 = -135, A1 = 135, a = A0 + (A1 - A0) * Math.min(1, frac / 1.2), lim = A0 + (A1 - A0) / 1.2;
  return '<path d="' + arcPath(84, A0, A1) + '" class="g-track"/><path d="' + arcPath(84, lim, A1) + '" class="g-danger"/><path d="' + arcPath(84, A0, a) + '" class="g-fill' + (frac > 1 ? ' bad' : '') + '"/>' +
    '<text x="100" y="112" class="g-big sm">' + (ft == null ? '–' : Math.round(ftToLen(ft))) + '</text><text x="100" y="134" class="g-unit">' + lenUnit() + ' of ' + fmtLen(radius) + '</text>';
}
const CK_OPTS = [['speed', 'Speed'], ['course', 'Course (compass)'], ['wind', 'Wind'], ['tide', 'Tide'], ['dest', 'To destination'], ['anchor', 'Anchor watch'], ['position', 'GPS position'], ['time', 'Time and sun'], ['chart', 'Small chart'], ['off', 'Off']];
function ckSlots() { const sl = S.settings.ckSlots; return Array.isArray(sl) && sl.length ? sl : ['speed', 'course', 'wind', 'auto']; }
function ckGauge(id) {
  const w = S.weather, tn = tideNow(), ob = nearestObs(), moving = (S.sog || 0) > 0.6;
  if (id === 'auto') id = S.goto && S.fix ? 'dest' : 'tide';
  if (id === 'speed') { const hs = hullSpeed(); const top = S.settings.boatType === 'power' ? (S.trip && S.trip.max > 30 ? 50 : 40) : hs ? Math.max(8, Math.ceil(hs.kn * 1.4 / 2) * 2) : 10; return gWrap('SPEED', speedGauge(S.fix ? S.sog || 0 : null, S.trip && S.trip.max, top), S.trip && S.trip.max ? 'Max ' + fmtSpeed(S.trip.max) + ' · GPS' : 'Speed over ground · GPS'); }
  if (id === 'course') return gWrap('COURSE', compassGauge(moving ? S.cog : null), 'Course over ground');
  if (id === 'wind') { const wd = ob ? { dir: ob.dir, spd: ob.spd, gust: ob.gust, cap: 'Measured · ' + agoTxt(ob.t) } : w && w.cur ? { dir: w.cur.dir, spd: w.cur.spd, gust: w.cur.gust, cap: 'Forecast · ' + agoTxt(w.at) } : null; return gWrap('WIND ' + (wd ? compass16(wd.dir) : ''), windGauge(wd && wd.dir, wd && wd.spd, wd && wd.gust, moving ? S.cog : 0), wd ? wd.cap + (moving ? ' · arrow relative to bow' : ' · arrow: north up') : 'No wind data yet'); }
  if (id === 'tide') return tn ? gWrap('TIDE', tideGauge(tn), tn.next ? (tn.next.type === 'H' ? 'High ' : 'Low ') + fmtClock(tn.next.t) + ' · NOAA' : 'NOAA prediction') : gWrap('TIDE', '<text x="100" y="108" class="g-unit">No tide station yet</text>', '');
  if (id === 'dest') { if (!(S.goto && S.fix)) return gWrap('DESTINATION', '<text x="100" y="100" class="g-unit">Not navigating</text><text x="100" y="122" class="g-unit">Start one in Navigate</text>', ''); const li = legInfo(S.fix, S.goto); return gWrap('TO ' + esc(S.goto.name.toUpperCase()), steerGauge(li.b, moving ? S.cog : null, li.d), isFinite(li.hrs) ? 'ETA ' + fmtClock(Date.now() + li.hrs * 3600000) + ' · ' + fmtDur(li.hrs) : 'Steer to the arrow'); }
  if (id === 'anchor') return S.anchor ? gWrap('ANCHOR', anchorGauge(S.anchor.lastFt, S.anchor.radiusFt), S.alarmOn ? 'ALARM' : 'Distance from anchor', S.alarmOn ? 'alarm' : '') : gWrap('ANCHOR', '<text x="100" y="108" class="g-unit">Watch is off</text>', '');
  if (id === 'position') { const f = S.fix; return gWrap('GPS POSITION', '<text x="100" y="84" class="g-big pos">' + (f ? ddm(f.lat, true) : '–') + '</text><text x="100" y="124" class="g-big pos">' + (f ? ddm(f.lon, false) : '') + '</text><text x="100" y="156" class="g-unit">' + (f && f.acc ? '±' + Math.round(ftToLen(f.acc * 3.28084)) + ' ' + lenUnit() + ' accuracy' : 'No fix') + '</text>', S.lastFixAt ? 'Last fix ' + Math.max(0, Math.round((Date.now() - S.lastFixAt) / 1000)) + ' s ago' : ''); }
  if (id === 'time') { const now = Date.now(), ss = w && (w.sunset || []).find((t) => t > now), sr = w && (w.sunrise || []).find((t) => t > now); return gWrap('TIME', '<text x="100" y="108" class="g-big">' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, '') + '</text><text x="100" y="140" class="g-unit">' + (ss ? 'Sunset ' + fmtClock(ss) : '') + (sr ? (ss ? ' · ' : '') + 'Sunrise ' + fmtClock(sr) : '') + '</text>', ''); }
  return '';
}
let ckMap = null, ckMark = null, ckEdit = false;
function buildCockpit() {
  const grid = $('cockpit').querySelector('.ck-grid'), sl = ckSlots().filter((x) => x !== 'off');
  if (ckMap) { ckMap.remove(); ckMap = null; }
  grid.dataset.n = sl.length + (ckEdit && sl.length < 6 ? 1 : 0);
  grid.innerHTML = sl.map((id, i) => '<div class="ck-slot' + (id === 'chart' ? ' chart' : '') + '" data-slot="' + i + '">' + (id === 'chart' ? '<div class="gauge"><div class="g-lbl">CHART</div><div class="ck-map" id="ckMap"></div></div>' : '') + '</div>').join('') +
    (ckEdit && sl.length < 6 ? '<div class="ck-slot add"><button type="button" class="ck-add" data-ckadd>+ Add a gauge</button></div>' : '');
  if (sl.includes('chart')) {
    ckMap = L.map('ckMap', { zoomControl: false, attributionControl: false, dragging: true, zoomSnap: 0 });
    const base = LAYERS[S.settings.chart === 'street' ? 'street' : S.settings.chart === 'satellite' ? 'satellite' : 'noaa'];
    if (window.TL_DEMO) L.imageOverlay(window.TL_DEMO.chart, window.TL_DEMO.bounds).addTo(ckMap); else L.tileLayer(base._url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', base.options).addTo(ckMap);
    if (!window.TL_DEMO && S.settings.chart === 'noaa') { ckMap.eachLayer((l) => ckMap.removeLayer(l)); new NoaaLayer('', { maxZoom: 19, maxNativeZoom: 18 }).addTo(ckMap); }
    ckMark = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#087E83', fillOpacity: 1 }).addTo(ckMap);
    const f = S.fix || refPos(); ckMap.setView([f.lat, f.lon], 14);
  }
  if (ckEdit) grid.classList.add('editing'); else grid.classList.remove('editing');
  const lay = S.settings.ckLayout || 'grid'; grid.className = grid.className.replace(/\blay-\S+/g, '').trim() + ' lay-' + (sl.includes('chart') ? lay : 'grid');
  const lb = $('cockpit').querySelector('.ck-lay'); if (lb) { lb.hidden = !ckEdit; lb.innerHTML = '<span>Layout</span>' + [['grid', 'Even grid'], ['half', 'Chart half'], ['big', 'Chart two-thirds'], ['top', 'Chart on top']].map(([v, l]) => '<button type="button" data-cklay="' + v + '" class="' + (lay === v ? 'on' : '') + '">' + l + '</button>').join(''); }
  { const rows = Math.max(1, Math.ceil((sl.length - 1) / 2)), wide = window.innerWidth >= 900, sp = sl.includes('chart') && (lay === 'half' || lay === 'big') && wide;
    grid.style.gridTemplateRows = sp ? 'repeat(' + rows + ', minmax(0, 1fr))' : '';
    const cs = grid.querySelector('.ck-slot.chart'); if (cs) cs.style.gridRow = sp ? '1 / span ' + rows : ''; }
  if (ckMap) setTimeout(() => ckMap.invalidateSize(), 60);
  renderCockpit();
}
function renderCockpit() {
  const el = $('cockpit'); if (!el || el.hidden) return;
  const sl = ckSlots().filter((x) => x !== 'off');
  el.querySelectorAll('.ck-slot[data-slot]').forEach((box) => {
    const i = +box.dataset.slot, id = sl[i];
    const pick = ckEdit ? '<select class="ck-pick" data-ckpick="' + i + '" aria-label="Choose gauge">' + CK_OPTS.concat([['auto', 'Tide, or destination when navigating']]).map(([v, l]) => '<option value="' + v + '"' + (v === id ? ' selected' : '') + '>' + (v === 'off' ? 'Remove this gauge' : l) + '</option>').join('') + '</select>' : '';
    if (id === 'chart') { const old = box.querySelector('.ck-pick'); if (old) old.remove(); if (pick) box.insertAdjacentHTML('afterbegin', pick); if (ckMap && S.fix) { ckMark.setLatLng([S.fix.lat, S.fix.lon]); ckMap.panTo([S.fix.lat, S.fix.lon], { animate: false }); } return; }
    if (box.querySelector('select:focus')) return;
    box.innerHTML = pick + ckGauge(id);
  });
  const acc = S.fix && S.fix.acc != null ? '±' + Math.round(ftToLen(S.fix.acc * 3.28084)) + ' ' + lenUnit() : '';
  const age = S.lastFixAt ? Math.round((Date.now() - S.lastFixAt) / 1000) : null;
  el.querySelector('.ck-gps').className = 'ck-gps ' + (age != null && age < 10 ? 'ok' : 'bad');
  el.querySelector('.ck-gps').textContent = DESK && !S.fix ? 'No GPS on this computer' : 'GPS ' + (age == null ? 'searching' : age < 10 ? 'live ' + acc : 'no fix for ' + age + ' s');
  el.querySelector('.ck-time').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.querySelector('.ck-edit').textContent = ckEdit ? 'Done' : 'Customize';
}
$('cockpit').addEventListener('change', (e) => {
  const sel = e.target.closest('[data-ckpick]'); if (!sel) return;
  const sl = ckSlots().filter((x) => x !== 'off').slice(); sl[+sel.dataset.ckpick] = sel.value;
  S.settings.ckSlots = sl.filter((x) => x !== 'off'); if (!S.settings.ckSlots.length) S.settings.ckSlots = ['speed'];
  saveSettings(); buildCockpit();
});
$('cockpit').addEventListener('click', (e) => {
  if (e.target.closest('[data-ckadd]')) { const sl = ckSlots().slice(); sl.push(['speed', 'course', 'wind', 'tide', 'position', 'chart'].find((x) => !sl.includes(x)) || 'time'); S.settings.ckSlots = sl; saveSettings(); buildCockpit(); }
  if (e.target.closest('.ck-edit')) { ckEdit = !ckEdit; buildCockpit(); }
  const ly = e.target.closest('[data-cklay]'); if (ly) { S.settings.ckLayout = ly.dataset.cklay; let sl = ckSlots().slice(); if (ly.dataset.cklay !== 'grid' && !sl.includes('chart')) { sl.unshift('chart'); S.settings.ckSlots = sl.slice(0, 6); } if (ly.dataset.cklay !== 'grid') { sl = S.settings.ckSlots.filter((x) => x !== 'chart'); S.settings.ckSlots = ['chart'].concat(sl); } saveSettings(); buildCockpit(); }
});
function setCockpit(on) {
  S.settings.cockpit = on; saveSettings();
  const el = $('cockpit'); el.hidden = !on; $('app').classList.toggle('ck-on', on);
  clearInterval(cockTimer);
  if (on) { closeSheet(); ckEdit = false; buildCockpit(); cockTimer = setInterval(renderCockpit, 1000); wake(); } else if (ckMap) { ckMap.remove(); ckMap = null; }
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-act="ckclose"]')) setCockpit(false); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-act="cockpit"]')) setCockpit(true); });

/* ---------- housekeeping ---------- */
setInterval(() => {
  updateMob();
  if (S.lastFixAt && Date.now() - S.lastFixAt > 20000 && !S.settings.sim && !DESK) setGps('bad', 'No GPS fix for ' + Math.round((Date.now() - S.lastFixAt) / 1000) + ' s');
  if (S.anchor && !DESK && S.lastFixAt && Date.now() - S.lastFixAt > 60000) fireAlarm('gps', 'GPS lost', 'No position for over a minute while anchored. Check the boat.');
}, 1000);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline features unavailable */ });
  // a new version was published: reload once so it shows, unless the anchor watch is running
  const hadCtl = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadCtl || S.updating) return; S.updating = true;
    if (S.anchor || S.mob) toast('A Tideline update is ready. It will load next time you open the app.', 5000);
    else location.reload();
  });
}

/* ---------- start ---------- */
askPersist();
if (S.settings.cockpit) setTimeout(() => setCockpit(true), 300);
// hover tips on a computer: every chart button says what it does
document.querySelectorAll('.fab, #btnMOB').forEach((b) => { const l = b.getAttribute('aria-label'); if (l) b.dataset.tip = l.replace(/, press and hold/i, ' (press and hold)'); });
document.querySelectorAll('.tab').forEach((b) => { b.dataset.tip = { chart: 'The chart', nav: 'Navigate: where to, trips, tracks', weather: 'Weather: wind, waves, rain, tide', anchor: 'Anchor watch', menu: 'Menu: boat, settings, help' }[b.dataset.tab] || ''; });
if (DESK && S.anchor && !S.settings.sim) { S.anchor = null; store.set('anchor', null); stopAlarm(); drawAnchor(); setTimeout(() => toast('Anchor watch turned off: this computer has no GPS. Use your phone or iPad for anchor watch.', 6000), 1500); }
setTimeout(() => { if (!S.fix) { maybeWeather(); maybeTide(); maybeObsWind(); } }, 2500); // no GPS (laptop): use the chart's position
drawRoute();
applyNight(); applyEasy(); applyCalm(); applyUseMode(); applyPinSize(); applyChart(); applyWx(); refreshBridges(); renderModeChip(); renderWaypoints(); drawAnchor(); updateGoto(); updateMob(); renderStrip(); renderChips();
$('recDot').hidden = !S.rec.on;
setTab('chart');
startGPS();
wake();
window.Tideline = { S, map, ais, setTab, resetDemoAis: () => { ais.clear(); demoAisAt = 0; spoken.clear(); }, openAis: (id) => { const t = ais.get(id); if (t) openAisSheet(t); }, closeSheet }; // debugging and demo recording
})();
