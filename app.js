/* Tideline — a simple marine GPS for anyone on the water. Prototype v0.1 */
(() => {
'use strict';

/* ---------- small helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('tl.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tl.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } if (window.__tlSync && !SYNC_SKIP.test(k)) window.__tlSync(); },
};
const SYNC_SKIP = /^(aisCache|curSt|cgNotices|loopFR|stations|bridges|bridgeTiles|mplaces|mpTiles|plTiles|weather|tide|encIds|obs|alrSeen|demo|sync)/; // caches stay local; your own data syncs
const saveTimers = {};
function saveSoon(key, getter, ms = 3000) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => store.set(key, getter()), ms);
}

/* ---------- state ---------- */
const DEFAULTS = {
  aisRelay: 'wss://tideline-ais.andy-brickman.workers.dev',
  speedUnit: 'kn', distUnit: 'nm', boatLen: 27, gpsToBow: 20, cruise: 5,
  chart: 'noaa', seamarks: true, night: false, keepAwake: true, sim: false, simRate: 5,
  boatType: 'sail', underSail: true, boatName: '', aisCoach: false, aisShow: true, voice: true, skipper: '', iconStyle: 'boat',
  wx: 'none', bridges: true, bridgeMargin: 2, cockpit: false, theme: 'auto', satOver: true, chartOnSat: 0.6, sailSpeed: 5, navMode: 'engine', rings: false, easy: false, coachMode: 'off', chips: false, satSrc: 'std', curOn: true,
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
const mapRot = () => { try { return map && map.getBearing ? map.getBearing() : 0; } catch (e) { return 0; } }; // how far the chart is turned (course up), so arrows still point true
const map = L.map('map', { rotate: true, touchRotate: false, rotateControl: false, shiftKeyRotate: false, bearing: 0, zoomControl: false, tapHold: true, worldCopyJump: true, maxZoom: 19, minZoom: 3, scrollWheelZoom: false, zoomSnap: 0, zoomDelta: 1 })
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
    '&layers=show:' + chartLayerIds() + noaaDisplay(z) + '&f=image';
}
/* NOAA chart detail: Clean (default), Standard or Full, plus individual choices under Customize.
   Sent to NOAA's Maritime Chart Service as display_params (S-52 ECDIS settings). Codes from the ADMIRALTY/Esri MCS docs:
   DisplayCategory 1 base, 2 standard, 4 other (soundings, cables, pipelines and seabed live in "other");
   on/off parameters use 1 = off, 2 = on; TwoDepthShades 2 = two shades, 1 = four; TextGroups is a ParameterGroup of S-52 text group numbers. */
const CHART_DETAIL = {
  clean: { soundings: 'off', cables: false, lights: false, text: 'few', buoys: 'auto', shades: 2 },
  standard: { soundings: 'shallow', cables: false, lights: true, text: 'names', buoys: 'auto', shades: 2 },
  full: { soundings: 'all', cables: true, lights: true, text: 'all', buoys: 'paper', shades: 4 },
};
// S-52 text groups: 11 important text, 21 names for position reporting (buoy and light names), 23 light descriptions, 24 notes on chart data,
// 25 nature of seabed ("Co,S,Sh"), 26 geographic names, 27 magnetic variation and swept depth, 28 heights of islets, 29 berth numbers, 30 current velocity
const TEXT_GROUPS = { few: [11, 21], names: [11, 21, 26], all: [11, 21, 24, 25, 26, 27, 28, 29, 30] };
if (!S.settings.chartDetail) S.settings.chartDetail = 'clean'; // cleaner chart is the default, for new and existing installs
function chartCfg() {
  const d = S.settings.chartDetail;
  return Object.assign({}, CHART_DETAIL[d] || CHART_DETAIL.clean, d === 'custom' ? S.settings.chartCustom || {} : {});
}
// 2 = every display setting, 1 = only the settings ADMIRALTY documents for this service, 0 = NOAA's plain chart (if NOAA refuses the others)
let noaaDP = 2;
function chartLayerIds() { // MCS layers: 0 info, 1 natural and man-made, 2 depths, 3 seabed and obstructions, 4 traffic routes, 5 special areas, 6 buoys and lights, 7 services, 11 shallow water pattern
  const d = S.settings.chartDetail;
  return d === 'full' ? '0,1,2,3,4,5,6,7' : chartCfg().soundings !== 'off' ? '0,1,2,3,6,7,11' : '0,1,2,3,6,7';
}
function noaaDisplay(z) {
  if (!noaaDP) return '';
  const c = chartCfg(), full = S.settings.chartDetail === 'full', need = S.boat ? wrNeedM() : 1.2, m = (v) => +v.toFixed(1);
  const other = c.soundings !== 'off' || c.cables, groups = TEXT_GROUPS[c.text] || TEXT_GROUPS.few, tg = groups.concat(c.lights ? [23] : []);
  const P = [['DisplayCategory', other ? '1,2,4' : '1,2'], ['SafetyContour', m(need)], ['SafetyDepth', m(need)], ['ShallowContour', m(Math.max(1, need * 0.6))], ['DeepContour', m(Math.max(10, need * 3))],
    ['TwoDepthShades', c.shades === 4 ? 1 : 2], ['DisplaySafeSoundings', c.soundings === 'all' ? 2 : 1]];
  const G = [{ name: 'TextGroups', Parameter: [11, 21, 23, 24, 25, 26, 27, 28, 29, 30].map((g) => ({ name: String(g), value: tg.includes(g) ? 2 : 1 })) }];
  if (noaaDP > 1) { // Esri MCS settings not in the ADMIRALTY list: simplified or paper-chart buoys, smaller symbols when zoomed out, SCAMIN
    const simple = c.buoys === 'simple' || (c.buoys === 'auto' && z < 13);
    P.push(['PointSymbolizationType', simple ? 1 : 2], ['HonorScamin', full && z >= 15 ? 1 : 2]);
    if (c.buoys === 'auto' && z < 13) G.push({ name: 'PointSymbolSize', Parameter: [{ name: 'scaleFactor', value: z < 11 ? 0.6 : 0.75 }] });
  }
  const dp = { ECDISParameters: { version: '10.9', DynamicParameters: { Parameter: P.map(([name, value]) => ({ name, value })), ParameterGroup: G } } };
  return '&display_params=' + encodeURIComponent(JSON.stringify(dp));
}
function redrawNoaa() { ['noaa', 'noaaOver'].forEach((k) => LAYERS[k].redraw()); }
const NoaaLayer = L.TileLayer.extend({
  getTileUrl(c) { return noaaUrl(c.x, c.y, c.z, this.options.transparentChart); },
});
const LAYERS = {
  noaa: new NoaaLayer('', { className: 'noaa-chart-tile', maxZoom: 19, maxNativeZoom: 18, updateWhenZooming: false, keepBuffer: 4, attribution: 'Chart: NOAA Office of Coast Survey' }),
  // a fast, cached ocean basemap under the NOAA chart, so the screen is never blank while NOAA draws its tiles
  ocean: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 13, attribution: 'Base: Esri, GEBCO, NOAA' }),
  noaaOver: new NoaaLayer('', { className: 'noaa-chart-tile', maxZoom: 19, maxNativeZoom: 18, transparentChart: true, opacity: 0.62, updateWhenZooming: false, keepBuffer: 4, attribution: 'Chart: NOAA' }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' }),
  satHD: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, attribution: 'Imagery: USGS The National Map' }),
  places: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13.99, maxNativeZoom: 13, minZoom: 5, opacity: 0.8, zIndex: 3, attribution: 'Labels: Esri' }), // quiet grey town names, gone before street names appear
  roads: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13.49, maxNativeZoom: 12, opacity: 0.4, zIndex: 2, attribution: 'Roads: Esri' }), // main roads only: the layer fades out before neighbourhood streets appear
  street: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
  seamarks: L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 18, attribution: 'Seamarks: OpenSeaMap' }),
};
(() => { let ok = 0, probing = 0; // if NOAA refuses the display settings, step down: fewer settings, then its plain chart
  // a failed tile is checked once: a reply that is not an image means NOAA refused the settings; no reply at all just means no signal
  const onErr = (e) => {
    if (!noaaDP || ok || Date.now() - probing < 20000 || !e.tile || !e.tile.src) return; probing = Date.now();
    fetch(e.tile.src, { cache: 'no-store' }).then((r) => { if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) { noaaDP--; probing = 0; redrawNoaa(); } }).catch(() => { /* offline: keep the settings */ });
  };
  ['noaa', 'noaaOver'].forEach((k) => { LAYERS[k].on('tileload', () => { ok++; }); LAYERS[k].on('tileerror', onErr); });
})();

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
  // town and point names are drawn by Tideline itself as plain text (see PLB), not as outlined tile labels
  if (ch !== 'street' && S.settings.landRoads) keys.push('roads');
  return keys;
}
let demoChart = null;
function applyChart() {
  document.documentElement.classList.toggle('sat', S.settings.chart === 'satellite' || !!S.settings.satOver);
  setTimeout(() => { try { SH.drawnKey = ''; drawShallow(); } catch (e) { /* not ready yet */ } }, 50);
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
function openPointSheet(latlng, wp, auto) {
  if (S.measure.on) return;
  const p = { lat: latlng.lat, lon: ((latlng.lng + 540) % 360) - 180 };
  S.sheetPoint = { p, wp: wp || null };
  let html = '<h3>' + (wp ? esc(wp.name) : auto ? 'This spot' : 'Dropped pin') + '</h3><div class="sub tnum">' + ddm(p.lat, true) + '  ' + ddm(p.lon, false) + '</div>';
  const from = S.fix || homePort();
  if (from) { const d = distNm(from, p); html += '<div class="sub tnum pt-dist">' + fmtDist(d) + ' at ' + fmtBrg(bearing(from, p)) + '°T from ' + (S.fix ? 'you' : esc(from.name)) + (S.fix && (S.sog || 0) > 1 ? ' · about ' + fmtDur(d / S.sog) : '') + '</div>'; }
  html += '<div id="ptNow" class="pt-now"></div>';
  html += '<div class="pt-acts main"><button class="btn primary" data-act="goto">Navigate here</button>' + (S.settings.boatType === 'sail' ? '<button class="btn primary alt" data-act="ptsail">Sail here</button>' : '') +
    (wp ? '<button class="btn" data-act="delwp">Delete</button>' : '<button class="btn" data-act="savewp">Save spot</button>') + '</div>' +
    '<details class="pt-more"><summary>More</summary><div class="pt-acts"><a class="btn" href="' + nwsGraphUrl(p) + '" target="_blank" rel="noopener">NOAA point forecast ↗</a><button class="btn" data-act="ptmeasure">Measure from here</button><button class="btn" data-act="ptwx" hidden>Weather here</button></div></details>' +
    '<div id="ptWx"></div><div class="pm" id="pmBox"></div>' + (auto ? '<p class="hint">Tap anywhere on the chart for that spot. Turn this off in Map options.</p>' : '') + '<div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>';
  openSheet(html); setTimeout(() => placeMedia(p.lat, p.lon, wp ? wp.name : '', $('pmBox')), 30);
  { const b = sheet.querySelector('[data-act="ptwx"]'); if (b) b.disabled = true; pointWeather(p); spotNow(p); }
}
// everything known about one spot: conditions now, water temperature, charted depth and the tidal current at the nearest NOAA station
async function spotNow(p) {
  const el = $('ptNow'); if (!el) return; el.innerHTML = '<p class="sub">Reading this spot…</p>';
  const ll = '?latitude=' + p.lat.toFixed(3) + '&longitude=' + p.lon.toFixed(3);
  const [w, m, dep, cur] = await Promise.all([
    fetchT('https://api.open-meteo.com/v1/forecast' + ll + '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,pressure_msl&wind_speed_unit=kn&temperature_unit=fahrenheit', 12000).then((r) => r.json()).catch(() => null),
    fetchT('https://marine-api.open-meteo.com/v1/marine' + ll + '&current=wave_height,wave_period,sea_surface_temperature&length_unit=imperial', 12000).then((r) => r.json()).catch(() => null),
    (async () => { const e = 0.00015, bb = [p.lon - e, p.lat - e, p.lon + e, p.lat + e]; for (const svc of ['enc_harbour', 'enc_approach', 'enc_coastal']) { try { const d = await encQuery(svc, 'depth', bb, 0.0001); const hit = d.filter((x) => x.d1 != null); if (hit.length) return hit.reduce((a, x) => (x.d1 < a.d1 ? x : a)); } catch (err) { /* next chart */ } } return null; })(),
    (async () => { try { const st = await nearestCurrent(p); if (!st || st.dNm > 5) return null; const pr = await curPred(st); const n = curAt(pr, curTime()); return n ? Object.assign({ st }, n) : null; } catch (e) { return null; } })()
  ]);
  if (!$('ptNow')) return;
  const c = w && w.current, mc = m && m.current, cells = [];
  if (c) cells.push(['Wind', Math.round(speedOut(c.wind_speed_10m)) + (c.wind_gusts_10m ? ' g' + Math.round(speedOut(c.wind_gusts_10m)) : ''), SPEED_LBL[S.settings.speedUnit] + ' from ' + compass16(c.wind_direction_10m)]);
  if (mc && mc.wave_height != null) cells.push(['Waves', mc.wave_height.toFixed(1), 'ft' + (mc.wave_period ? ' · ' + Math.round(mc.wave_period) + ' s' : '')]);
  if (cur) cells.push(['Current', cur.kn < 0.4 ? 'slack' : cur.kn.toFixed(1), cur.kn < 0.4 ? (cur.nextSlack ? '' : '') : 'kn ' + (cur.flood ? 'flood' : 'ebb') + ' → ' + compass16(cur.dir || 0)]);
  if (dep) cells.push(['Charted depth', Math.round(ftToLen(dep.d1 / 0.3048)), lenUnit() + ' at chart datum']);
  if (c) cells.push(['Air', Math.round(c.temperature_2m) + '°', (wmo(c.weather_code)[0] || '').toLowerCase()]);
  if (mc && mc.sea_surface_temperature != null) cells.push(['Water', Math.round(mc.sea_surface_temperature * 9 / 5 + 32) + '°', 'surface, model']);
  if (c && c.pressure_msl) cells.push(['Barometer', Math.round(c.pressure_msl), 'hPa']);
  el.innerHTML = cells.length ? '<div class="pt-grid">' + cells.map(([k, v, u]) => '<div><small>' + k + '</small><b class="tnum">' + esc(String(v)) + '</b><span>' + esc(u) + '</span></div>').join('') + '</div>' + (cur ? '<button type="button" class="btn small" data-curst="' + esc(cur.st.id) + '">Current at ' + esc(cur.st.n.replace(/,.*$/, '')) + ' (' + fmtDist(cur.st.dNm) + ' away) ›</button>' : '') : '<p class="sub">No data reached for this spot: check signal.</p>';
}
sheet.addEventListener('click', async (e) => { const b = e.target.closest('[data-curst]'); if (!b) return; const list = await curStations(); const st = list.find((x) => x.id === b.dataset.curst); if (st) openCurrent(st); });
async function pointTide(p) {
  const box = $('ptWx'); if (!box) return;
  let el = $('ptTide'); if (!el) { el = document.createElement('div'); el.id = 'ptTide'; el.className = 'pt-tide'; box.after(el); }
  el.innerHTML = '<p class="sub">Tide here…</p>';
  try {
    const tt = (S.tide && !S.tide.none && S.tide.station && S.tide.pos && distNm(S.tide.pos, p) < 3) ? S.tide : await tideFor(p);
    if (!$('ptTide')) return;
    if (tt.none) { el.innerHTML = '<p class="sub">No NOAA tide station within 30 nm of this spot.</p>'; return; }
    const ts = tideState(tt), nx = ts && ts.next;
    el.innerHTML = '<div class="pt-tide-h"><b>Tide here: ' + (ts ? tideLen(ts.v) + ', ' + esc(ts.state.toLowerCase()) : '–') + '</b><span>' + (nx ? (nx.type === 'H' ? 'High ' : 'Low ') + fmtClock(nx.t) + ' (' + tideLen(nx.v) + ')' : '') + ' · NOAA ' + esc(tt.station.name.replace(/,.*$/, '')) + ', ' + fmtDist(tt.station.dist) + ' away</span></div>';
  } catch (e) { if ($('ptTide')) el.innerHTML = '<p class="sub">Could not reach NOAA tides.</p>'; }
}
async function pointWeather(p) {
  const box = $('ptWx'); if (!box) return;
  box.innerHTML = '<p class="sub">Getting the forecast for this spot…</p>';
  try {
    const ll = '?latitude=' + p.lat.toFixed(3) + '&longitude=' + p.lon.toFixed(3);
    const [w, m] = await Promise.all([
      fetch('https://api.open-meteo.com/v1/forecast' + ll + wxM() + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=GMT&forecast_days=2').then((r) => r.json()),
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
    pointTide(p);
    $('ptWx').innerHTML = '<div class="pt-wx">' + rows.map((r) => '<div><small>' + fmtClock(r.t) + '</small><i style="--c:' + colFor(WIND_COL, r.spd) + '">' + windArrow(r.dir) + '</i><b class="tnum">' + Math.round(speedOut(r.spd)) + '</b><small>g' + Math.round(speedOut(r.gust)) + (r.wv != null ? ' · ' + waveLen(r.wv) : '') + '</small></div>').join('') + '</div><p class="hint" style="margin:6px 0 0">Model forecast for this spot, every 3 hours. ' + SPEED_LBL[S.settings.speedUnit] + '; g = gust.</p>';
  } catch (e) { if ($('ptWx')) $('ptWx').innerHTML = '<p class="sub">No forecast: check signal.</p>'; }
}
function optSeg(name, opts, cur) {
  return '<div class="seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-opt="' + name + '" data-val="' + v + '" class="' + (String(cur) === String(v) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
}
function tog(id, label, note, on) {
  return '<label class="opt"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span>' + label + (note ? '<small>' + note + '</small>' : '') + '</span></label>';
}
function chartDetailHtml() { // NOAA chart detail: three presets, and each choice on its own under Customize
  const d = S.settings.chartDetail, c = chartCfg(), seg = (k, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-cd="' + k + '" data-val="' + v + '" class="' + (String(cur) === String(v) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
  const ck = (k, label, note, on) => '<label class="opt"><input type="checkbox" data-cdk="' + k + '"' + (on ? ' checked' : '') + '><span>' + label + '<small>' + note + '</small></span></label>';
  let h = '<div class="mo-h">NOAA chart detail</div>' + seg('preset', d === 'custom' ? '' : d, [['clean', 'Clean'], ['standard', 'Standard'], ['full', 'Full chart']]);
  h += '<p class="hint" style="margin:2px 0 6px">' + ({ clean: 'Calm chart: no soundings, cables or bottom notes; water shaded deep or shallow for your draft (' + fmtLen(wrNeedM() / 0.3048) + '), small simple buoys until you zoom in.', standard: 'Adds depth numbers where it is shallow for your boat, and light descriptions.', full: 'Everything on the paper chart: every sounding, cables, pipelines, bottom notes, traffic routes.', custom: 'Your own mix, set below.' }[d] || '') + '</p>';
  h += '<details class="cd-more"' + (d === 'custom' ? ' open' : '') + '><summary>Customize</summary>';
  h += '<div class="cd-l">Depth numbers (soundings)</div>' + seg('soundings', c.soundings, [['off', 'Off'], ['shallow', 'Only shallow'], ['all', 'All']]);
  h += '<small class="hint">Only shallow hides soundings deeper than your safety depth.</small>';
  h += ck('cables', 'Submarine cables and pipelines', 'NOAA draws these in one group with soundings, so they also show whenever soundings are on', c.cables || c.soundings !== 'off');
  h += ck('lights', 'Light descriptions', 'Text such as "Fl G 4s 15ft 5M" next to lights', c.lights);
  h += '<div class="cd-l">Chart text</div>' + seg('text', c.text, [['few', 'Buoy names'], ['names', '+ place names'], ['all', 'All notes']]);
  h += '<small class="hint">All notes adds bottom types (Co, S, Sh), chart notes, heights and berth numbers.</small>';
  h += '<div class="cd-l">Buoy and beacon symbols</div>' + seg('buoys', c.buoys, [['auto', 'Small, detailed up close'], ['simple', 'Simple'], ['paper', 'Paper chart']]);
  h += '<div class="cd-l">Depth shading</div>' + seg('shades', c.shades, [['2', 'Two shades (safe / shallow)'], ['4', 'Four shades']]);
  return h + '</details>';
}
function setChartDetail(k, v, inQuick) {
  const st = S.settings;
  if (k === 'preset') { st.chartDetail = v; st.chartCustom = null; }
  else { const c = chartCfg(); c[k] = k === 'shades' ? +v : v; st.chartCustom = c; st.chartDetail = 'custom'; }
  saveSettings(); noaaDP = 2; redrawNoaa(); if (inQuick) renderQuick(); else openLayersSheet();
}
function openLayersSheet() {
  const st = S.settings;
  let html = '<div class="mo"><div class="mo-top"><h3>Map options</h3><span><button type="button" class="btn small" data-act="mohelp">Help</button> <button type="button" class="btn small" data-act="mosettings">All settings</button></span></div>' + '<div class="mo-h">Color mode</div>' + optSeg('theme', [['auto', 'Auto'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']], st.theme || 'auto') + '' + (window.TL_DEMO ? '<p class="hint" style="margin:6px 0 0">This demo uses a sample chart, because hosted demo pages can\'t load live chart or satellite images. NOAA charts and satellite work in the full app.</p>' : '');
  html += '<div class="mo-h">Chart</div>' + optSeg('chart', Object.entries(CHARTS).map(([k, c]) => [k, c.name.replace(' only', '')]), st.chart);
  if (st.chart !== 'street') html += chartDetailHtml();
  html += '<div class="mo-h">Overlays</div>';
  html += tog('satBox', 'Satellite imagery', 'Aerial photo under the chart', st.satOver && st.chart !== 'satellite');
  if (st.satOver && st.chart !== 'satellite') html += '<div class="field" style="margin:4px 0 8px"><label for="satMix">Chart on top: <b id="satMixVal">' + Math.round(st.chartOnSat * 100) + '%</b></label><input id="satMix" type="range" min="20" max="100" step="5" value="' + Math.round(st.chartOnSat * 100) + '"></div>';
  if (st.satOver || st.chart === 'satellite') html += '<div class="mo-h">Satellite imagery</div>' + optSeg('satSrc', [['std', 'Standard'], ['hd', 'HD (US waters)']], st.satSrc || 'std');
  html += tog('aisBox', 'AIS boats', S.settings.sim ? 'Demo shows sample boats' : S.settings.aisRelay ? 'Live from aisstream.io through your relay: ships and AIS-equipped boats within about 20 nm' + (AISS.n ? ' · ' + [...ais.values()].filter((t) => t.live).length + ' in view' : '') : 'Live ships over the internet need a small relay (below)', S.settings.aisShow !== false);
  if (!S.settings.sim) html += '<div class="ais-key"><input id="aisKeyIn" type="url" autocomplete="off" placeholder="AIS relay address (wss://…)" value="' + esc(S.settings.aisRelay || '') + '"><button type="button" class="btn small" data-act="aiskeysave">' + (S.settings.aisRelay ? 'Update' : 'Save') + '</button></div><p class="hint" style="margin:2px 0 10px">aisstream.io (free) does not let browsers connect directly, so live AIS goes through a small free relay that holds your key. Setup steps: tools/ais-relay in the Tideline repo. ' + (AISS.err ? '<b>' + esc(AISS.err) + '</b>' : '') + '</p>';
  html += tog('aisNamesBox', 'Ship names', 'Off shows icons only; tap a ship for its details', S.settings.aisNames === true);
  html += '<div class="row-btns"><button class="btn small" data-act="aislist">AIS target list</button><button class="btn small" data-act="aispreview">Try AIS demo</button></div>';
  html += tog('chipsBox', 'Wind, waves and tide on the chart', 'Off keeps the chart calm; the status line shows wind', st.chips);
  html += tog('mpBox', 'Marinas, clubs, fuel and ramps', 'Named on the chart when you zoom in', S.settings.mplaces !== false);
  html += tog('placesBox', 'Town names', 'A faint outline on land so you know where you are', S.settings.landPlaces !== false) + tog('roadsBox', 'Roads', 'Faint major roads on land', !!S.settings.landRoads);
  html += tog('ringsBox', 'Range rings', 'Distance rings around your boat', st.rings);
  html += tog('bridgesBox', 'Bridge clearances', 'Labels and warnings checked against your boat', st.bridges);
  html += '<div class="mo-h">Buoy and light markers</div>' + optSeg('navaids', [['night', 'At night'], ['always', 'Always'], ['off', 'Off']], st.navaids || 'night') + '<p class="hint" style="margin:2px 0 10px">Small red and green markers with their numbers, drawn from NOAA chart data. Tap any buoy for what it is.</p>';
  html += '<div class="mo-h">Chart colors</div>' + optSeg('chartTint', [['blue', 'Ocean blue'], ['classic', 'Classic NOAA']], st.chartTint || 'blue');
  html += '<div class="mo-h">Menu color in daytime</div>' + optSeg('menuTone', [['dark', 'Deep navy (more contrast)'], ['light', 'Light']], st.menuTone || 'dark');
  html += '<div class="mo-h">Gauge look</div>' + glPicker(st.gTheme || 'midnight') + optSeg('gStyle', [['analog', 'Analog'], ['hybrid', 'Analog + digital'], ['digital', 'Digital']], st.gStyle || 'hybrid') + '<small class="hint">For the speed circle and the instrument panel.</small>';
  html += '<div class="mo-h">Speed dial size</div>' + optSeg('miSize', [['m', 'Normal'], ['l', 'Large'], ['xl', 'Extra large']], st.miSize || 'l');
  html += '<div class="mo-h">Button names</div>' + optSeg('learnTips', [['false', 'Only when I press and hold'], ['true', 'Also display it on each tap']], String(st.learnTips === true || st.learnTips === 'true'));
  html += '<div class="mo-h">Tapping the chart</div>' + optSeg('spotTap', [['false', 'Tap and hold shows conditions'], ['true', 'A quick tap shows them']], String(st.spotTap === true || st.spotTap === 'true'));
  html += '<div class="mo-h">What are you doing today?</div><div class="btheme-row">' + ACTIVITY.map(([v, l, th]) => '<button type="button" data-activity="' + v + '" class="' + (st.activity === v ? 'on' : '') + '"><i style="background:' + (BTHEMES.find((x) => x[0] === th) || BTHEMES[0])[2] + '"></i>' + l + '</button>').join('') + '</div><small class="hint">Sets the colors and the layers that matter for it. Change anything afterwards.</small>';
  html += '<div class="mo-h">Button theme</div><div class="btheme-row">' + BTHEMES.map(([v, l, c]) => '<button type="button" data-btheme="' + v + '" class="' + ((st.btheme || 'blue') === v ? 'on' : '') + '"><i style="background:' + c + '"></i>' + l + '</button>').join('') + '</div><small class="hint">Day colors for the round buttons. Dusk and Night keep their dim look.</small>';
  html += tog('shallowBox', 'Shallow water warning', 'Tints water shallower than your draft plus buffer, and a lighter tint where it is getting close', st.shallowTint !== false);
  if (st.shallowTint !== false) html += optSeg('shallowStyle', [['coral', 'Soft coral'], ['amber', 'Amber'], ['pale', 'Pale'], ['edge', 'Outline only']], st.shallowStyle || 'coral') + optSeg('shallowLevel', [['1', 'Faint'], ['2', 'Medium'], ['3', 'Strong']], String(st.shallowLevel || 2));
  html += tog('seamarksBox', 'Buoys and lights on street and satellite maps', 'From OpenSeaMap, a community chart', st.seamarks);
  html += '<div class="mo-h">Weather on the chart (pick any)</div>' + tog('wxWind', 'Wind', 'Forecast arrows, speed and gust', wxOn('wind')) + tog('wLinesBox', 'Moving wind lines', 'Light streaks that drift with the forecast wind', S.settings.windLines !== false) + tog('wxWaves', 'Waves', 'Forecast wave height', wxOn('waves')) + tog('wxRain', 'Rain radar', 'Live NEXRAD, every 5 minutes', wxOn('rain'));

  html += tog('easyBox', 'Easy view', 'Bigger icons and text', st.easy);
  html += '<div class="row-btns" style="margin-top:12px"><button class="btn" data-act="cockpit">Cockpit display</button><button class="btn primary" data-act="close">Done</button></div></div>';
  openSheet(html);
}
sheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="aiskeysave"]')) { S.settings.aisRelay = ($('aisKeyIn').value || '').trim(); S.settings.aisShow = true; saveSettings(); AISS.retry = 0; aissConnect(true); toast(S.settings.aisRelay ? 'Relay saved. Ships appear as their next broadcast comes in, usually within a minute or two.' : 'Relay removed.', 4500); return; }
  const cd = e.target.closest('[data-cd]'); if (cd) { setChartDetail(cd.dataset.cd, cd.dataset.val); return; }
  const o = e.target.closest('[data-opt]'); if (!o) return;
  const k = o.dataset.opt, v = o.dataset.val;
  S.settings[k] = v; saveSettings();
  if (k === 'chart' || k === 'satSrc') { S.satFailed = false; applyChart(); }
  if (k === 'wx') applyWx();
  if (k === 'chartTint') applyTint();
  if (k === 'miSize') applyMiSize();
  if (k === 'gStyle') { applyGTheme(); document.documentElement.dataset.gstyle = v; }
  if (k === 'gArt') applyGArt();
  if (k === 'fabLook') applyFabLook();
  if (k === 'menuTone') document.documentElement.classList.toggle('lightmenus', v === 'light');
  if (k === 'learnTips') S.settings.learnTips = v === 'true';
  if (k === 'spotTap') { S.settings.spotTap = v === 'true'; saveSettings(); }
  if (k === 'navaids') { NV.key = ''; drawNavaids(); }
  if (k === 'shallowStyle' || k === 'shallowLevel') { SH.drawnKey = ''; drawShallow(); }
  if (k === 'theme') { applyNight(); updateBoat(); }
  openLayersSheet();
});
sheet.addEventListener('input', (e) => {
  if (e.target.id === 'satMix') { S.settings.chartOnSat = +e.target.value / 100; $('satMixVal').textContent = e.target.value + '%'; applyChart(); saveSoon('settings', () => S.settings, 800); }
});
(() => { // wind, waves, tide and sail/motor live as small buttons at the top of the left column
  const ch = document.querySelector('.topbar .chips'), fc = $('fabs'); if (!ch || !fc) return;
  const grp = document.createElement('div'); grp.className = 'fab-info'; grp.id = 'fabInfo';
  const rb = document.createElement('button'); rb.id = 'rainChip'; rb.type = 'button'; rb.hidden = true; ch.appendChild(rb);
  // one Weather button opens a small row of wind, waves, rain and tide toggles; AIS gets its own button
  const wb = document.createElement('button'); wb.id = 'btnWx'; wb.type = 'button'; wb.className = 'fab wxbtn'; wb.setAttribute('aria-label', 'Weather on the chart: wind, waves, rain, tide, current');
  grp.className = 'wx-pop'; grp.hidden = true;
  ['windChip', 'waveChip', 'rainChip', 'tideChip'].forEach((id) => { const b = $(id); if (b) { b.className = 'fab info'; grp.appendChild(b); } });
  const mc = $('modeChip'); if (mc) { mc.className = 'fab info'; mc.hidden = true; document.body.appendChild(mc); mc.style.display = 'none'; } // sail/motor lives in Layers now
  rb.addEventListener('click', () => { setTab('chart'); setWxL('rain', !wxOn('rain')); });
  const ab = document.createElement('button'); ab.id = 'btnAis'; ab.type = 'button'; ab.className = 'fab aisbtn'; ab.setAttribute('aria-label', 'AIS ships on or off');
  ab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l5 16-5-3-5 3z"/></svg><span class="ais-n"></span>';
  const wrap = document.createElement('div'); wrap.className = 'wx-wrap'; wrap.id = 'wxWrap'; wrap.appendChild(wb); wrap.appendChild(grp);
  const rt = $('btnRoute'); fc.insertBefore(wrap, rt ? rt.nextSibling : null); fc.insertBefore(ab, wrap.nextSibling); ch.remove();
  wb.addEventListener('click', (e) => { e.stopPropagation(); grp.hidden = !grp.hidden; wb.classList.toggle('open', !grp.hidden); });
  document.addEventListener('click', (e) => { if (!grp.hidden && !e.composedPath().some((n) => n.classList && n.classList.contains('wx-wrap'))) { grp.hidden = true; wb.classList.remove('open'); } });
  ab.addEventListener('click', () => { S.settings.aisShow = S.settings.aisShow === false; saveSettings(); updateAis(); try { aissConnect(true); } catch (err) { /* relay not ready */ } renderAisBtn(); toast(S.settings.aisShow ? 'AIS ships on' : 'AIS ships off'); });
})();
function renderWxBtn() {
  const b = $('btnWx'); if (!b) return; const on = ['wind', 'waves', 'rain'].filter(wxOn).concat(S.tideCardOn ? ['tide'] : []).concat(S.settings.curOn ? ['current'] : []);
  const w = S.weather, spd = w && w.cur ? Math.round(speedOut(w.cur.spd)) : null;
  b.classList.toggle('on', on.length > 0);
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 0 7.5z"/></svg><b>' + (spd != null ? spd + '<small class="wx-u">' + SPEED_LBL[S.settings.speedUnit] + '</small>' : '') + '</b>' + (on.length ? '<i class="wx-dots">' + on.map((k) => '<em class="d-' + k + '"></em>').join('') + '</i>' : '');
  b.dataset.tip = 'Weather' + (spd != null ? ': wind ' + spd + ' ' + SPEED_LBL[S.settings.speedUnit] : '') + (on.length ? ' · showing ' + on.join(', ') : '') + '. Tap for wind, waves, rain, tide and current.';
}
function renderAisBtn() {
  const b = $('btnAis'); if (!b) return; const on = S.settings.aisShow !== false, n = [...ais.values()].filter((t) => t.lat != null).length;
  b.classList.toggle('on', on); b.querySelector('.ais-n').textContent = on && n ? n : '';
  b.dataset.tip = on ? 'AIS ships on' + (n ? ' · ' + n + ' in range' : ' · none in range yet') + '. Tap to hide.' : 'AIS ships off. Tap to show ships.';
}
setInterval(() => { renderWxBtn(); renderAisBtn(); }, 2000);
function applyCalm() { document.documentElement.classList.toggle('calm', !S.settings.chips); placeFabs(); }
function applyEasy() { document.documentElement.classList.toggle('easy', !!S.settings.easy); }
/* range rings around the boat, scaled to the zoom */
const ringLayer = L.layerGroup().addTo(map);
// range rings: automatic spacing for the zoom, or your own spacing, number, color and labels
const RING_COL = { dark: '#0E1F2E', blue: '#1565C0', red: '#D32F2F', orange: '#E07A10', white: '#FFFFFF' };
function ringRadii() {
  const st = S.settings, n = Math.max(1, Math.min(6, +st.ringCount || 3)), step = st.ringStep && st.ringStep !== 'auto' ? +st.ringStep : null;
  if (step) return Array.from({ length: n }, (_, i) => +(step * (i + 1)).toFixed(3));
  const z = map.getZoom(), base = z >= 16 ? 0.1 : z >= 15 ? 0.25 : z >= 13.5 ? 0.25 : z >= 12 ? 0.5 : z >= 10.5 ? 1 : 2;
  return Array.from({ length: n }, (_, i) => base * [1, 2, 4, 6, 8, 10][i]);
}
function drawRings() {
  ringLayer.clearLayers();
  const st = S.settings; if (!st.rings) return;
  const c = S.fix || (st.ringCenter === 'chart' ? refPos() : null); if (!c) return;
  const col = RING_COL[st.ringColor || 'dark'] || RING_COL.dark, dash = st.ringDash ? '6 6' : null, w = st.ringWeight || 1.2;
  ringRadii().forEach((r) => {
    ringLayer.addLayer(L.circle([c.lat, c.lon], { radius: r * M_PER_NM, color: col, weight: w, opacity: st.ringColor === 'white' ? 0.85 : 0.55, dashArray: dash, fill: false, interactive: false }));
    if (st.ringLabels === false) return;
    const p = destination(c, 180, r);
    ringLayer.addLayer(L.marker([p.lat, p.lon], { interactive: true, keyboard: false, icon: L.divIcon({ className: 'ring-lbl', iconSize: [48, 16], iconAnchor: [24, 8], html: fmtDist(r).replace(' ', '&#8202;') }) }).on('click', (e) => { L.DomEvent.stop(e); openRingSheet(); }));
  });
}
function ringControlsHtml() {
  const st = S.settings, step = String(st.ringStep || 'auto'), n = String(st.ringCount || 3), seg = (k, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, t]) => '<button type="button" data-ring' + k + '="' + v + '" class="' + (cur === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
  return '<div class="field"><label>Spacing</label>' + seg('step', step, [['auto', 'Auto'], ['0.1', '0.1'], ['0.25', '¼'], ['0.5', '½'], ['1', '1'], ['2', '2'], ['5', '5']].map(([v, t]) => [v, v === 'auto' ? t : t + ' nm'])) + '<small class="hint">Auto picks a spacing that fits the zoom.</small></div>' +
    '<div class="field"><label>How many rings</label>' + seg('n', n, [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']]) + '</div>';
}
function openRingSheet() {
  const st = S.settings, seg = (k, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, t]) => '<button type="button" data-ring' + k + '="' + v + '" class="' + (cur === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
  openSheet('<h3>Range rings</h3><div class="sub">Circles at set distances around your boat</div>' +
    '<div class="field"><label>Rings</label>' + seg('on', String(!!st.rings), [['true', 'On'], ['false', 'Off']]) + '</div>' + ringControlsHtml() +
    '<div class="field"><label>Color</label><div class="ring-cols">' + Object.entries(RING_COL).map(([k, c]) => '<button type="button" data-ringcol="' + k + '" class="' + ((st.ringColor || 'dark') === k ? 'on' : '') + '" style="--c:' + c + '" aria-label="' + k + '"></button>').join('') + '</div></div>' +
    '<div class="field"><label>Line</label>' + seg('dash', String(!!st.ringDash), [['false', 'Solid'], ['true', 'Dashed']]) + seg('w', String(st.ringWeight || 1.2), [['1.2', 'Thin'], ['2', 'Medium'], ['3', 'Bold']]) + '</div>' +
    '<div class="field"><label>Distance labels</label>' + seg('lbl', String(st.ringLabels !== false), [['true', 'Show'], ['false', 'Hide']]) + '</div>' +
    '<div class="field"><label>Without GPS</label>' + seg('ctr', st.ringCenter === 'chart' ? 'chart' : 'boat', [['boat', 'Hide the rings'], ['chart', 'Center on the chart (for planning)']]) + '</div>' +
    '<div class="row-btns"><button class="btn primary" data-act="close">Done</button></div>');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ringstep],[data-ringn],[data-ringcol],[data-ringdash],[data-ringw],[data-ringlbl],[data-ringctr],[data-ringon]'); if (!b) return;
  const st = S.settings, d = b.dataset;
  if (d.ringstep) st.ringStep = d.ringstep; if (d.ringn) st.ringCount = +d.ringn; if (d.ringcol) st.ringColor = d.ringcol; if (d.ringdash) st.ringDash = d.ringdash === 'true';
  if (d.ringw) st.ringWeight = +d.ringw; if (d.ringlbl) st.ringLabels = d.ringlbl === 'true'; if (d.ringctr) st.ringCenter = d.ringctr; if (d.ringon) st.rings = d.ringon === 'true';
  if (!st.rings && !d.ringon) st.rings = true; // choosing a spacing turns them on
  saveSettings(); drawRings(); b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  if (b.closest('#quick') && typeof renderQuick === 'function') renderQuick();
});
map.on('moveend', () => { if (S.settings.rings && !S.fix && S.settings.ringCenter === 'chart') drawRings(); });
map.on('zoomend', drawRings);
map.on('zoomend', () => { clearTimeout(window.__aisZ); window.__aisZ = setTimeout(() => { try { updateAis(); } catch (e) { /* later */ } }, 200); });
sheet.addEventListener('change', (e) => {
  if (e.target.name === 'chart') { S.settings.chart = e.target.value; saveSettings(); applyChart(); }
  if (e.target.id === 'shallowBox') { S.settings.shallowTint = e.target.checked; saveSettings(); SH.drawnKey = ''; drawShallow(); }
  if (e.target.dataset.cdk) { const k = e.target.dataset.cdk, c = chartCfg(); setChartDetail(k, e.target.checked); if (k === 'cables' && !e.target.checked && c.soundings !== 'off') toast('Cables show with soundings on NOAA charts. Set depth numbers to Off to hide them.', 4500); }
  if (e.target.id === 'seamarksBox') { S.settings.seamarks = e.target.checked; saveSettings(); applyChart(); }
  if (e.target.id === 'wLinesBox') { S.settings.windLines = e.target.checked; saveSettings(); drawGrid(); }
  if (e.target.id === 'wxWind' || e.target.id === 'wxWaves' || e.target.id === 'wxRain') setWxL({ wxWind: 'wind', wxWaves: 'waves', wxRain: 'rain' }[e.target.id], e.target.checked);
  if (e.target.id === 'bridgesBox') { S.settings.bridges = e.target.checked; saveSettings(); refreshBridges(true); }
  if (e.target.id === 'satBox') { S.settings.satOver = e.target.checked; if (S.settings.chart === 'satellite') S.settings.chart = 'noaa'; saveSettings(); applyChart(); openLayersSheet(); }
  if (e.target.id === 'mpBox') { S.settings.mplaces = e.target.checked; saveSettings(); refreshMarinePlaces(); }
  if (e.target.id === 'placesBox') { S.settings.landPlaces = e.target.checked; saveSettings(); applyChart(); drawPlaceNames(); loadPlaceNames(); }
  if (e.target.id === 'roadsBox') { S.settings.landRoads = e.target.checked; saveSettings(); applyChart(); }
  if (e.target.id === 'aisBox') { S.settings.aisShow = e.target.checked; saveSettings(); updateAis(); }
  if (e.target.id === 'aisNamesBox') { S.settings.aisNames = e.target.checked; saveSettings(); updateAis(); }
  if (e.target.id === 'chipsBox') { S.settings.chips = e.target.checked; saveSettings(); applyCalm(); }
  if (e.target.id === 'ringsBox') { S.settings.rings = e.target.checked; saveSettings(); drawRings(); }
  if (e.target.id === 'easyBox') { S.settings.easy = e.target.checked; saveSettings(); applyEasy(); }
});
sheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-sheetx]')) { if (typeof RT !== 'undefined' && RT.edit) routeMode(false); if (S.measure.on) setMeasure(false); closeSheet(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, sp = S.sheetPoint;
  if (act === 'close') closeSheet();
  if ((act === 'goto' || act === 'ptsail') && sp) {
    const name = sp.wp ? sp.wp.name : sp.place ? sp.place.name : sp.spot ? (sp.spot.species || 'Fishing spot') : 'Dropped pin', from = S.fix ? { lat: S.fix.lat, lon: S.fix.lon, name: 'Start' } : homePort();
    closeSheet(); if (act === 'ptsail' && !S.settings.underSail) { S.settings.underSail = true; saveSettings(); }
    if (from && distNm(from, sp.p) > 0.3) {
      (async () => { const pts = await routeByWater([{ lat: from.lat, lon: from.lon, name: from.name }, { lat: sp.p.lat, lon: sp.p.lon, name }]); RT.pts = pts; store.set('routeDraft', RT.pts);
        if (act === 'ptsail') { routeMode(true); map.fitBounds(L.latLngBounds(pts.map((q) => [q.lat, q.lon])).pad(0.2)); setTimeout(() => openSailCoach('plan'), 300); }
        else if (S.fix) { let i = 1; routeLeg(pts, i); map.fitBounds(L.latLngBounds(pts.map((q) => [q.lat, q.lon])).pad(0.2)); }
        else { routeMode(true); map.fitBounds(L.latLngBounds(pts.map((q) => [q.lat, q.lon])).pad(0.2)); toast('Route planned from ' + from.name + '. Tap Start when you are under way.', 4500); } })();
    } else setGoto(name, sp.p.lat, sp.p.lon);
  }
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
/* ---------- places a route must not go: Coast Guard event safety zones (33 CFR 165.506) on their dates, and areas you mark yourself ---------- */
// Fireworks safety zones for Sector Maryland-NCR, from the table in 33 CFR 165.506. Enforced 5:30 pm on the date until 1 am the next day unless the Coast Guard announces otherwise.
const EVENT_ZONES = [
  { name: 'Annapolis Fourth of July fireworks', where: 'Severn River and Spa Creek, Annapolis', lat: 38.977222, lon: -76.478056, r: 183, dates: ['07-04'], ref: '33 CFR 165.506, Sector MD-NCR no. 2', note: '200-yard safety zone around the fireworks barge' },
  { name: 'Annapolis New Year’s Eve fireworks', where: 'Spa Creek, Annapolis', lat: 38.975689, lon: -76.482653, r: 122, dates: ['12-31'], ref: '33 CFR 165.506, Sector MD-NCR no. 15', note: '400-foot safety zone' },
  { name: 'Sherwood Forest fireworks', where: 'Severn River, Sherwood Forest', lat: 39.031667, lon: -76.544944, r: 137, dates: ['07-03'], ref: '33 CFR 165.506, Sector MD-NCR no. 26', note: '150-yard safety zone. May instead be the weekend after July 4' },
  { name: 'Kent Island Narrows fireworks', where: 'Chester River, Kent Island Narrows', lat: 38.979167, lon: -76.248, r: 244, dates: ['07-04'], ref: '33 CFR 165.506, Sector MD-NCR no. 25', note: '800-foot safety zone. May instead be a weekday before July 4' },
  { name: 'Baltimore Harbor fireworks', where: 'Baltimore Inner Harbor', lat: 39.276861, lon: -76.598278, r: 244, dates: ['07-04', '12-31'], ref: '33 CFR 165.506, Sector MD-NCR no. 24', note: '800-foot safety zone' },
  { name: 'Inner Harbor fireworks', where: 'Baltimore Inner Harbor, Patapsco River', lat: 39.284444, lon: -76.61, r: 91, dates: ['07-04', '12-31'], ref: '33 CFR 165.506, Sector MD-NCR no. 6', note: '100-yard safety zone' },
  { name: 'Middle Branch fireworks', where: 'Patapsco River, Middle Branch', lat: 39.258797, lon: -76.620542, r: 244, dates: ['07-04'], ref: '33 CFR 165.506, Sector MD-NCR no. 27', note: '800-foot safety zone' }
];
S.avoid = store.get('avoidZones', []);
function eventZoneOn(z, t) { // the evening of the date, through 1 am the next morning
  const d = new Date(t), md = (x) => String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  const prev = new Date(t - 86400000);
  return (z.dates.includes(md(d)) && d.getHours() >= 12) || (z.dates.includes(md(prev)) && d.getHours() < 1);
}
function avoidZonesFor(t) { return EVENT_ZONES.filter((z) => eventZoneOn(z, t)).map((z) => Object.assign({ event: true }, z)).concat(S.avoid); }
function addAvoidZone(lat, lon) { S.avoid.push({ id: Date.now(), lat, lon, r: 150, name: 'My avoid area' }); store.set('avoidZones', S.avoid); drawAvoid(); toast('Avoid area added. Routes now go around it. Tap it to remove.', 4000); if (RT.pts.length > 1 && S.settings.autoWater !== false) { const stops = RT.pts.filter((p) => !p.turn).map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })); routeByWater(stops).then((pts) => { RT.pts = pts; store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }); } }
let AVL = null;
function drawAvoid() {
  if (!AVL) AVL = L.layerGroup().addTo(map); AVL.clearLayers();
  const t = RT.edit ? (RT.depart || Date.now()) : Date.now();
  avoidZonesFor(t).forEach((z) => {
    const c = L.circle([z.lat, z.lon], { radius: z.r, color: '#D32F2F', weight: 2, dashArray: '5 5', fillColor: '#D32F2F', fillOpacity: 0.16 }).addTo(AVL);
    c.on('click', (e) => { L.DomEvent.stop(e); openAvoidSheet(z); });
  });
}
function openAvoidSheet(z) {
  openSheet('<h3>' + esc(z.name) + '</h3>' + (z.event ? '<div class="sub">Coast Guard safety zone · ' + esc(z.where) + '</div><p>' + esc(z.note) + '. No vessel may enter without Coast Guard permission while it is enforced, usually 5:30 pm until 1 am. Routes planned for that evening go around it.</p><p class="hint">' + esc(z.ref) + '. The Coast Guard can change the dates or times; check the Local Notice to Mariners and listen on VHF 16 and 22A.</p><div class="row-btns"><a class="btn" href="https://www.navcen.uscg.gov/msi" target="_blank" rel="noopener">Local Notice to Mariners</a><button class="btn ghost" data-act="close">Close</button></div>'
    : '<div class="sub">Your own area to keep out of</div><p>Routes go around this circle (' + fmtLen(z.r / 0.3048) + ' across the middle to the edge).</p><div class="row-btns"><button class="btn danger" data-avoid-del="' + z.id + '">Remove it</button><button class="btn ghost" data-act="close">Close</button></div>'));
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-avoid-del]'); if (!b) return; S.avoid = S.avoid.filter((z) => String(z.id) !== b.dataset.avoidDel); store.set("avoidZones", S.avoid); drawAvoid(); closeSheet(); toast('Avoid area removed'); });
// Live Coast Guard temporary rules (safety zones, regattas, closures) for Chesapeake waters, from the Federal Register. Titles and dates only: the exact areas are in each notice.
const CGN = { list: store.get('cgNotices', []), at: store.get('cgNoticesAt', 0) };
async function fetchCgNotices(force) {
  if (!force && Date.now() - CGN.at < 6 * 3600000) return CGN.list;
  const q = 'https://www.federalregister.gov/api/v1/documents.json?per_page=40&order=newest&conditions[agencies][]=coast-guard&conditions[type][]=RULE&conditions[term]=' + encodeURIComponent('(Annapolis | Severn | Chesapeake | Baltimore | Patapsco | Magothy | "South River" | "Rhode River" | "West River" | "Chester River" | "Kent Island" | "Eastern Bay" | "Miles River" | "St. Michaels" | Choptank | Patuxent | Solomons) ("safety zone" | "special local" | "regulated area" | "security zone")') + '&fields[]=title&fields[]=html_url&fields[]=publication_date&fields[]=effective_on&fields[]=dates&fields[]=abstract';
  try {
    const j = await fetchT(q, 15000).then((r) => r.json());
    CGN.list = (j.results || []).map((d) => ({ title: d.title, url: d.html_url, pub: d.publication_date, eff: d.effective_on, dates: d.dates || '', abs: d.abstract || '' }));
    CGN.at = Date.now(); store.set('cgNotices', CGN.list); store.set('cgNoticesAt', CGN.at);
  } catch (e) { CGN.err = true; }
  return CGN.list;
}
async function openCgNotices() {
  openSheet('<h3>Closures and safety zones</h3><div class="sub">Checking the Coast Guard…</div>');
  await fetchCgNotices(true);
  const now = Date.now(), up = EVENT_ZONES.map((z) => { const y = new Date().getFullYear(); const next = z.dates.map((md) => { let t = Date.parse(y + '-' + md + 'T17:30'); if (t + 8 * 3600000 < now) t = Date.parse((y + 1) + '-' + md + 'T17:30'); return t; }).sort((a, b) => a - b)[0]; return { z, next }; }).sort((a, b) => a.next - b.next);
  openSheet('<h3>Closures and safety zones</h3><div class="sub">Places a route will not go, and what the Coast Guard has announced</div>' +
    '<div class="mo-h">Every year (built in, routes avoid them on the day)</div>' + up.map(({ z, next }) => '<div class="li"><div class="li-main"><b>' + esc(z.name) + '</b><span>' + new Date(next).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' from 5:30 pm · ' + esc(z.note) + '</span></div><button class="btn small" data-zone-show="' + EVENT_ZONES.indexOf(z) + '">Show</button></div>').join('') +
    '<div class="mo-h">My avoid areas</div>' + (S.avoid.length ? S.avoid.map((z) => '<div class="li"><div class="li-main"><b>' + esc(z.name) + '</b></div><button class="btn small" data-avoid-del="' + z.id + '">Remove</button></div>').join('') : '<p class="sub">None yet. In the route planner, tap “Avoid an area”, then tap the chart.</p>') +
    '<div class="mo-h">Latest Coast Guard rules for Chesapeake waters</div>' + (CGN.list.length ? CGN.list.slice(0, 15).map((d) => '<a class="li" href="' + esc(d.url) + '" target="_blank" rel="noopener"><div class="li-main"><b>' + esc(d.title) + '</b><span>' + esc((d.dates || '').slice(0, 160) || ('Published ' + d.pub)) + '</span></div></a>').join('') : '<p class="sub">' + (CGN.err ? 'Could not reach the Federal Register just now.' : 'Nothing found.') + '</p>') +
    '<p class="hint">These come from the Federal Register and list the exact area in each notice; Tideline cannot yet draw them automatically. Short-notice closures (a search and rescue, a security zone around a ship) are broadcast on VHF 16 and 22A and in the weekly Local Notice to Mariners.</p><div class="row-btns"><a class="btn" href="https://www.navcen.uscg.gov/msi" target="_blank" rel="noopener">Local Notice to Mariners</a><button class="btn ghost" data-act="close">Close</button></div>');
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-zone-show]'); if (b) { const z = EVENT_ZONES[+b.dataset.zoneShow]; closeSheet(); setTab('chart'); map.setView([z.lat, z.lon], 15); L.circle([z.lat, z.lon], { radius: z.r, color: '#D32F2F', weight: 2, dashArray: '5 5', fillOpacity: 0.16 }).addTo(map).bindTooltip(z.name, { permanent: true }).openTooltip(); } if (e.target.closest('[data-cg-notices]')) openCgNotices(); });
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
  const anyBad = show && RT.pts.some((p) => p.unchecked); RT.line.setStyle({ dashArray: anyBad ? '10 8' : null, color: anyBad ? '#E8952B' : '#C2185B' }); // a route that is not fully checked never looks like a normal one
  if (!RT.bad) RT.bad = L.layerGroup().addTo(map); RT.bad.clearLayers();
  if (show) RT.pts.forEach((p, i) => { if (!i || !p.unchecked) return; let k = i - 1; while (k > 0 && RT.pts[k].turn) k--; L.polyline(RT.pts.slice(k, i + 1).map((q) => [q.lat, q.lon]), { color: '#FFB300', weight: 6, dashArray: '2 10', lineCap: 'round', interactive: false }).addTo(RT.bad); });
  drawAvoid();
  if (!show) return;
  let sn = 0;
  RT.pts.forEach((p, i) => {
    const turn = (p.turn || p.via) && !RT.edit; if (!p.turn && !p.via) sn++;
    const mk = L.marker([p.lat, p.lon], { keyboard: false, zIndexOffset: turn ? 1000 : 1100, icon: turn ? L.divIcon({ className: '', iconSize: [12, 12], iconAnchor: [6, 6], html: '<div class="rt-turn"></div>' }) : L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: '<div class="rt-pt' + (RT.edit ? ' edit' : '') + (p.turn || p.via ? ' turn' : '') + '">' + (p.turn || p.via ? '' : sn) + '</div>' }) }).addTo(RT.marks);
    if (!RT.edit) mk.on('click', () => openRouteMenu());
    if (RT.edit) dragHandle(mk, (ll) => { p.lat = ll.lat; p.lon = ll.lng; RT.line.setLatLngs(RT.pts.map((q) => [q.lat, q.lon])); }, () => { if (p.turn) { delete p.turn; p.via = true; } store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); rtRerouteAround(p); });
  });
}
setTimeout(() => RT.line.on('click', (e) => { L.DomEvent.stop(e); if (!RT.edit) openRouteMenu(); }), 0);
function routeMode(on) {
  RT.edit = on; $('btnRoute').classList.toggle('on', on);
  if (on) { if (S.measure.on) setMeasure(false); setTab('chart'); if (!RT.depart) RT.depart = Date.now(); renderRouteSheet(); toast(RT.pts.length ? 'Drag a waypoint to move it. Tap the chart to add more.' : 'Tap the chart to set your start, then each waypoint.', 4000); }
  else closeSheet();
  drawRoute();
}
function rtSearchHtml(n) {
  return '<div class="field rt-q"><input id="rtQ" type="search" autocomplete="off" enterkeyhint="search" placeholder="' + (n ? 'Type the next stop (marina, club, town)…' : 'Type where you start (marina, club, town)…') + '"><div id="rtSugs" class="sugs" hidden></div><small class="hint">' + (n ? 'Or tap the chart to drop a waypoint.' : 'Or tap the chart to set the start.') + '</small></div>';
}
function rtFit() { if (RT.pts.length > 1) map.fitBounds(L.latLngBounds(RT.pts.map((q) => [q.lat, q.lon])).pad(0.2)); else if (RT.pts.length) map.setView([RT.pts[0].lat, RT.pts[0].lon], Math.max(map.getZoom(), 13)); }
let rtList = [], rtT = null;
sheet.addEventListener('input', (e) => {
  if (e.target.id !== 'rtQ') return; const q = e.target.value.trim(), box = $('rtSugs'); clearTimeout(rtT);
  if (q.length < 2) { box.hidden = true; return; } box.hidden = false; box.innerHTML = '<div class="sug-empty">Searching…</div>';
  const last = RT.pts[RT.pts.length - 1];
  rtT = setTimeout(async () => { rtList = await suggestPlaces(q, last || homePort() || searchCenter()); if ($('rtSugs')) $('rtSugs').innerHTML = placeSugHtml(rtList, 'data-rtsug'); }, 250);
});
sheet.addEventListener('click', (e) => {
  const g = e.target.closest('[data-rtsug]'); if (!g) return; const o = rtList[+g.dataset.rtsug];
  RT.pts.push({ lat: o.lat, lon: o.lon, name: o.name.replace(/\s*\(sample spot\)/, '') }); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); rtFit(); rtAutoLeg();
  setTimeout(() => { const q = $('rtQ'); if (q) q.focus(); }, 40);
});
function routeAdd(ll) {
  if (RT.avoidPick) { RT.avoidPick = false; addAvoidZone(ll.lat, ll.lng); renderRouteSheet(); return; }
  RT.pts.push({ lat: ll.lat, lon: ll.lng }); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); rtAutoLeg();
}
// Each new leg follows the water on its own, so a tapped or typed route never cuts across land
function rtQueue(fn) { RT.q = (RT.q || Promise.resolve()).then(fn).catch(() => {}); return RT.q; }
function rtStopBefore(i) { let k = i - 1; while (k >= 0 && RT.pts[k].turn) k--; return k; }
function rtStopAfter(i) { let k = i + 1; while (k < RT.pts.length && RT.pts[k].turn) k++; return k < RT.pts.length ? k : -1; }
async function rtFillLeg(a, b) { // replace whatever lies between stops a and b with water turning points
  let ia = RT.pts.indexOf(a), ib = RT.pts.indexOf(b); if (ia < 0 || ib < 0 || ib <= ia) return;
  let r; try { r = await waterLeg(a, b); } catch (e) { r = { ok: false, why: 'net' }; WR.lastErr = e.message || String(e); }
  ia = RT.pts.indexOf(a); ib = RT.pts.indexOf(b); if (ia < 0 || ib < 0 || ib <= ia) return;
  const mid = (r.ok || r.why === 'partial' || r.why === 'fine') && r.pts ? r.pts.filter((q, k) => !(k === 0 && distNm(q, a) < 0.12) && !(k === r.pts.length - 1 && distNm(q, b) < 0.12)).map((q) => ({ lat: q.lat, lon: q.lon, turn: true })) : [];
  RT.pts.splice(ia + 1, ib - ia - 1, ...mid);
  if (r.ok) delete b.unchecked; else b.unchecked = r.why || 'net';
  return r;
}
function rtAutoLeg() {
  if (S.settings.autoWater === false || RT.pts.length < 2) return;
  const b = RT.pts[RT.pts.length - 1], k = rtStopBefore(RT.pts.length - 1); if (k < 0) return; const a = RT.pts[k];
  RT.busy = (RT.busy || 0) + 1; renderRouteSheet();
  rtQueue(async () => {
    const r = await rtFillLeg(a, b); RT.busy--; store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet();
    if (r && !r.ok) toast(wrWhy(r.why), 6000); else if (r && WR.lowBridges && WR.lowBridges.length) toast('Routed around ' + WR.lowBridges[0] + ': too low for your air draft.', 5000);
  });
}
function rtRerouteAround(p) { // after a stop is dragged, re-run the legs on either side of it
  if (S.settings.autoWater === false) return;
  rtQueue(async () => {
    const i = RT.pts.indexOf(p); if (i < 0) return;
    const ka = rtStopBefore(i), kb = rtStopAfter(i), a = ka >= 0 ? RT.pts[ka] : null, b = kb >= 0 ? RT.pts[kb] : null;
    RT.busy = (RT.busy || 0) + 1; renderRouteSheet();
    if (a) await rtFillLeg(a, p); if (b) await rtFillLeg(p, b);
    RT.busy--; store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet();
  });
}
function wrWhy(why) {
  return why === 'nowater' ? 'That point is not in charted water deep enough for your boat. The leg is shown dashed: move the point onto water.' :
    why === 'nopath' ? 'No water route deep enough for your draft was found for that leg (it may be blocked by shoals, a low bridge or a closed area). Shown dashed: do not follow it.' :
    why === 'fine' ? 'A close check found land, a jetty or shallow water on that leg that the wide search missed. Add a waypoint in open water to guide it; the leg is shown dashed.' :
    why === 'partial' ? 'Part of the NOAA chart for that leg did not load, so the leg is shown dashed and is NOT fully checked. Try Re-route by water when you have a better signal.' :
    'Could not reach NOAA chart data' + (WR.lastErr ? ' (' + WR.lastErr + ')' : '') + ', so that leg is a straight line, shown dashed. It is NOT checked for land or depth.';
}
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
    h += rtSearchHtml(n) + '<div class="row-btns">' + (S.fix ? '<button class="btn primary" data-act="rtboat">Start from my boat</button>' : '') + (homePort() ? '<button class="btn' + (S.fix ? '' : ' primary') + '" data-act="rthome">' + (n ? 'Go to ' : 'Start from ') + esc(homePort().name) + '</button>' : '') + (n ? '<button class="btn" data-act="rtundo">Undo</button>' : '') + '<button class="btn ghost" data-act="rtclose">Close</button></div>';
    if (S.routes.length && !n) h += '<div class="mo-h">Saved routes</div>' + S.routes.slice().reverse().map((r) => '<div class="li"><div class="li-main"><b>' + esc(r.name) + '</b><span class="tnum">' + r.pts.length + ' waypoints</span></div><div class="li-btns"><button class="btn small" data-act="rtload" data-id="' + r.id + '">Open</button><button class="btn small" data-act="rtdel" data-id="' + r.id + '">Delete</button></div></div>').join('');
    h += '</div>'; openSheet(h); return;
  }
  const [dv, du] = distParts(st.total);
  h += '<div class="trio"><div><span class="lbl">DISTANCE</span><b class="tnum">' + dv + '</b><span class="unit">' + du + '</span></div><div><span class="lbl">TIME</span><b class="tnum">' + fmtDur(st.hrs).replace(' min', 'm') + '</b><span class="unit">at ' + fmtSpeed(st.spd) + ' ' + SPEED_LBL[S.settings.speedUnit] + '</span></div><div><span class="lbl">ARRIVE</span><b class="tnum">' + fmtClock(st.arrive) + '</b><span class="unit">' + new Date(st.arrive).toLocaleDateString([], { weekday: 'short' }) + '</span></div></div>' +
    (st.fuel != null ? '<div class="sub tnum" style="margin:-4px 0 8px">Fuel about ' + (Math.round(st.fuel * 10) / 10) + ' gal at ' + S.boat.gph + ' gal/h' + (S.boat.tankGal ? ' · ' + Math.round(st.fuel / S.boat.tankGal * 100) + '% of your tank' : '') + '. An estimate: keep a third in reserve.</div>' : '');
  h += '<div class="field" style="margin:4px 0 8px"><label for="rtDepart">Depart</label><input id="rtDepart" type="datetime-local" value="' + toLocalInput(RT.depart || Date.now()) + '"></div>';
  h += rtSearchHtml(n);
  h += '<div class="rt-legs">' + st.legs.map((l) => '<div class="rt-leg"><span class="rt-n">' + l.i + '→' + (l.i + 1) + '</span><span class="tnum">' + fmtDist(l.d) + ' · ' + fmtBrg(l.brg) + '°T · ' + fmtDur(l.hrs).replace(' min', 'm') + '</span><span class="rt-w">' + (l.wind ? compass16(l.wind.dir) + ' ' + Math.round(speedOut(l.wind.spd)) + ' g' + Math.round(speedOut(l.wind.gust)) : '') + '</span></div>' +
    l.bridges.map((x) => '<div class="rt-warn v-' + x.j.level + '">' + esc(x.br.name) + ': ' + esc(x.j.text) + '</div>').join('')).join('') + '</div>';
  const bad = RT.pts.filter((p) => p.unchecked).length, zones = avoidZonesFor(RT.depart || Date.now());
  h += RT.busy ? '<p class="rt-status">Finding a route through the water…</p>' : bad ? '<p class="rt-status bad">' + bad + ' leg' + (bad > 1 ? 's are' : ' is') + ' NOT checked (dashed). ' + esc(wrWhy(RT.pts.find((p) => p.unchecked).unchecked)) + '</p>' : S.settings.autoWater !== false && RT.pts.some((p) => p.turn) ? (RT.pts.some((p) => p.caution) ? '<p class="rt-status">Follows charted water (some stretches are only charted as a depth range that may be under ' + fmtLen(wrNeedM() / 0.3048) + ', so watch the depth there)' : '<p class="rt-status ok">Follows water at least ' + fmtLen(wrNeedM() / 0.3048) + ' deep (your draft plus buffer)') + (S.boat.airDraftFt ? ', under bridges taller than your ' + fmtLen(S.boat.airDraftFt) + ' air draft' : '') + ', around closed areas' + (zones.length ? ' and ' + zones.length + ' avoid area' + (zones.length > 1 ? 's' : '') : '') + '.</p>' : '';
  h += '<p class="hint" style="margin:6px 0">Each leg follows NOAA chart depths for your boat' + (S.boat.draftFt ? '' : ' (set your draft in Boat for a better route)') + '. Drag any point to reshape it. Always keep a lookout and watch the depth; the wind shown is the forecast where you are now.</p>';
  h += '<div class="row-btns"><button class="btn primary" data-act="rtstart"' + (RT.busy ? ' disabled' : '') + '>Start</button><button class="btn" data-act="rtwater">Re-route by water</button><button class="btn" data-act="rtavoid">Avoid an area</button><button class="btn" data-scact="plan2">Best time to leave</button><button class="btn" data-act="rtautow">Auto-follow water: ' + (S.settings.autoWater === false ? 'off' : 'on') + '</button><button class="btn" data-act="rtsave">Save</button><button class="btn" data-act="rtundo">Undo</button><button class="btn" data-act="rtrev">Reverse</button><button class="btn ghost" data-act="rtclear">Clear</button><button class="btn ghost" data-act="rtclose">Close</button></div></div>';
  openSheet(h);
}
sheet.addEventListener('change', (e) => { if (e.target.id === 'rtDepart') { const t = Date.parse(e.target.value); if (t) { const z0 = avoidZonesFor(RT.depart || Date.now()).length; RT.depart = t; drawAvoid(); const z1 = avoidZonesFor(t); if (z1.length !== z0 && RT.pts.length > 1 && S.settings.autoWater !== false) { if (z1.some((z) => z.event)) toast('Heads up: ' + z1.find((z) => z.event).name + ' that evening. The route keeps out of the safety zone.', 6000); routeByWater(RT.pts.filter((p) => !p.turn).map((p) => ({ lat: p.lat, lon: p.lon, name: p.name }))).then((pts) => { RT.pts = pts; store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }); } else renderRouteSheet(); } } });
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !b.dataset.act.startsWith('rt')) return;
  const act = b.dataset.act;
  if (act === 'rtboat' && S.fix) { RT.pts.unshift({ lat: S.fix.lat, lon: S.fix.lon }); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); if (RT.pts.length > 1) rtRerouteAround(RT.pts[0]); }
  if (act === 'rtavoid') { RT.avoidPick = true; closeSheet(); toast('Tap the chart where the route must not go.', 4000); }
  if (act === 'rtautow') { S.settings.autoWater = S.settings.autoWater === false; saveSettings(); renderRouteSheet(); }
  if (act === 'rtundo') { RT.pts.pop(); while (RT.pts.length && RT.pts[RT.pts.length - 1].turn) RT.pts.pop(); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }
  if (act === 'rtrev') { RT.pts.reverse(); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); }
  if (act === 'rtclear') { if (!armed(b, 'Tap again to clear')) return; RT.pts = []; store.set('routeDraft', []); drawRoute(); renderRouteSheet(); }
  if (act === 'rtclose') routeMode(false);
  if (act === 'rthome' && homePort()) { const hp = homePort(); const had = RT.pts.length; if (had) RT.pts.push({ lat: hp.lat, lon: hp.lon, name: hp.name }); else RT.pts.unshift({ lat: hp.lat, lon: hp.lon, name: hp.name }); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); rtFit(); if (had) rtAutoLeg(); }
  if (act === 'rtwater' && RT.pts.length > 1) { b.disabled = true; (async () => { const keep = RT.pts.filter((p) => !p.turn).map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })); RT.pts = await routeByWater(keep); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); })(); }
  if (act === 'rtsave') { const r = { id: Date.now(), name: 'Route ' + (S.routes.length + 1) + ' · ' + new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }), pts: RT.pts.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name, turn: p.turn || undefined, via: p.via || undefined, unchecked: p.unchecked || undefined })) }; S.routes.push(r); store.set('routes', S.routes); toast('Saved as ' + r.name); }
  if (act === 'rtload') { const r = S.routes.find((x) => String(x.id) === b.dataset.id); if (r) { RT.pts = r.pts.map((p) => Object.assign({ lat: p.lat, lon: p.lon }, p.name ? { name: p.name } : {}, p.turn ? { turn: true } : {}, p.via ? { via: true } : {}, p.unchecked ? { unchecked: p.unchecked } : {})); store.set('routeDraft', RT.pts); drawRoute(); renderRouteSheet(); map.fitBounds(L.latLngBounds(RT.pts.map((p) => [p.lat, p.lon])).pad(0.2)); } }
  if (act === 'rtdel') { S.routes = S.routes.filter((x) => String(x.id) !== b.dataset.id); store.set('routes', S.routes); renderRouteSheet(); }
  if (act === 'rtstart') {
    let i = 0; if (S.fix && distNm(S.fix, RT.pts[0]) < 0.15) i = 1;
    const nBad = RT.pts.filter((p) => p.unchecked).length;
    if (nBad && !RT.badOk) { RT.badOk = true; toast('⚠ ' + nBad + ' leg' + (nBad > 1 ? 's are' : ' is') + ' NOT checked against the chart and may cross land or shoals (dashed orange). Tap Start again to go anyway, or Re-route by water.', 9000); return; }
    RT.badOk = false;
    const pts = RT.pts.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name, turn: p.turn, stop: p.stop, unchecked: p.unchecked }));
    RT.edit = false; $('btnRoute').classList.remove('on'); closeSheet(); drawRoute();
    routeLeg(pts, i);
  }
});
function routeLeg(pts, i) {
  const p = pts[i], hasStops = pts.some((q) => q.stop), stops = hasStops ? pts.filter((q) => q.stop) : pts;
  const nextStop = pts.slice(i).find((q) => !q.turn) || p, sn = stops.indexOf(nextStop) + 1;
  const label = p.turn ? 'Turn, then on to ' + (nextStop.name || 'stop ' + sn) : (p.name ? p.name + ' · ' : '') + 'stop ' + sn + ' of ' + stops.length;
  setGoto(label, p.lat, p.lon);
  S.goto.route = { pts, i }; store.set('goto', S.goto); updateGoto(); RT.pts = pts; drawRoute();
}


/* ---------- route by water: NOAA ENC depth areas → grid → A* path that stays in water deep enough for this boat ---------- */
const WR = { hosts: ['https://encdirect.noaa.gov', 'https://gis.charttools.noaa.gov'], ids: (() => { const o = store.get('encIds7', null); return o && Date.now() - (o.ts || 0) < 7 * 864e5 ? o.ids : {}; })(), cache: new Map(), tiles: new Map(), busy: 0, wait: [], log: [] };
// NOAA rate-limits bursts (HTTP 429) and times out on big boxes (504), so: at most 4 requests at a time, retry with backoff,
// and fetch fixed tiles that are cached and reused by every grid (wide search, fine re-check, the next route).
async function encSlot(fn) { while (WR.busy >= 4) await new Promise((r) => WR.wait.push(r)); WR.busy++; try { return await fn(); } finally { WR.busy--; const n = WR.wait.shift(); if (n) n(); } }
async function encJson(u, ms) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    try {
      const r = await encSlot(() => fetchT(u, ms || 30000));
      if (r.status === 429 || r.status >= 500) { last = 'NOAA ' + r.status; WR.log.push({ u: u.slice(0, 90), st: r.status, ms: Date.now() - t0 }); await new Promise((z) => setTimeout(z, 1200 * (i + 1) + Math.random() * 600)); continue; }
      if (!r.ok) throw new Error('NOAA ' + r.status);
      const j = await r.json(); if (j.error) throw new Error('NOAA: ' + (j.error.message || 'query failed'));
      WR.log.push({ u: u.slice(0, 90), st: 200, ms: Date.now() - t0, n: (j.features || []).length }); if (WR.log.length > 200) WR.log.splice(0, 50);
      return j;
    } catch (e) { last = e.name === 'AbortError' ? 'NOAA timed out' : (e.message || String(e)); if (/^NOAA: /.test(last)) throw e; await new Promise((z) => setTimeout(z, 800 * (i + 1))); }
  }
  throw new Error(last || 'NOAA unreachable');
}
async function encLayerIds(svc) {
  if (WR.ids[svc]) return WR.ids[svc];
  if (WR.idsP && WR.idsP[svc]) return WR.idsP[svc];
  WR.idsP = WR.idsP || {};
  return (WR.idsP[svc] = (async () => {
    for (const h of WR.hosts) {
      try {
        const j = await encJson(h + '/arcgis/rest/services/encdirect/' + svc + '/MapServer?f=json', 15000);
        const find = (re) => { const l = (j.layers || []).find((x) => re.test(x.name)); return l ? l.id : null; };
        const ids = { host: h, wreck: find(/\.Wreck_point$/i), obstr: find(/\.Obstruction_point$/i), depth: find(/\.Depth_Area$/i), dredged: find(/\.Dredged_Area$/i), buoy: find(/\.Buoy_Lateral_point$/i), beacon: find(/\.Beacon_Lateral_point$/i), light: find(/\.Light_point$/i), bridgeL: find(/\.Bridge_line$/i), bridgeA: find(/\.Bridge_area$/i), land: find(/\.Land_Area$/i), restr: find(/\.Restricted_Area(_area)?$/i), slconsA: find(/\.Shoreline_Construction_area$/i), slconsL: find(/\.Shoreline_Construction_line$/i) };
        if (ids.depth != null) { WR.ids[svc] = ids; store.set('encIds7', { ts: Date.now(), ids: WR.ids }); return ids; }
      } catch (e) { WR.lastErr = e.message || String(e); }
    }
    delete WR.idsP[svc]; return null;
  })());
}
const ENC_TILE = { enc_general: 1, enc_coastal: 0.5, enc_approach: 0.25, enc_harbour: 0.2 };
const ENC_OFF = { enc_general: 0.0006, enc_coastal: 0.0002, enc_approach: 0.0001, enc_harbour: 0.00004 };
function encParse(f) {
  const a = f.attributes || {}, k1 = Object.keys(a).find((k) => /^drval1$/i.test(k)), k2 = Object.keys(a).find((k) => /^drval2$/i.test(k)), ko = Object.keys(a).find((k) => /^objectid$/i.test(k));
  const A = {}; Object.keys(a).forEach((k) => { const K = k.toUpperCase(); if (/^(RESTRN|VERCLR|VERCCL|VERCOP|CATBRG|OBJNAM|CATREA)$/.test(K)) A[K] = a[k]; });
  return { id: ko != null ? a[ko] : null, d1: k1 != null && a[k1] != null ? +a[k1] : null, d2: k2 != null && a[k2] != null ? +a[k2] : null, rings: f.geometry.rings || null, paths: f.geometry.paths || null, a: A };
}
async function encTile(svc, layer, tx, ty) {
  const key = svc + '|' + layer + '|' + tx + '|' + ty;
  if (WR.tiles.has(key)) { const v = WR.tiles.get(key); WR.tiles.delete(key); WR.tiles.set(key, v); return v; } // keep recently used tiles
  const p = (async () => {
    const ids = await encLayerIds(svc); if (!ids) throw new Error(WR.lastErr || 'NOAA chart list unavailable'); if (ids[layer] == null) return [];
    const ts = ENC_TILE[svc] || 0.25, bb = [tx * ts, ty * ts, (tx + 1) * ts, (ty + 1) * ts], out = [], seen = new Set();
    for (let page = 0; page < 12; page++) {
      const u = ids.host + '/arcgis/rest/services/encdirect/' + svc + '/MapServer/' + ids[layer] + '/query?where=1%3D1&geometry=' + bb.map((v) => v.toFixed(4)).join('%2C') +
        '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&maxAllowableOffset=' + (ENC_OFF[svc] || 0.0001) + '&geometryPrecision=5&resultOffset=' + (page * 1000) + '&resultRecordCount=1000&f=json';
      const j = await encJson(u, 30000); let added = 0;
      (j.features || []).forEach((f) => { if (!f.geometry || !(f.geometry.rings || f.geometry.paths)) return; const o = encParse(f); if (o.id != null) { if (seen.has(o.id)) return; seen.add(o.id); } out.push(o); added++; });
      if (!j.exceededTransferLimit || !added) break;
      if (page === 11) out.trunc = true;
    }
    return out;
  })();
  WR.tiles.set(key, p); p.catch(() => WR.tiles.delete(key));
  while (WR.tiles.size > 600) WR.tiles.delete(WR.tiles.keys().next().value);
  return p;
}
function encBBox(f) { let a = 180, b = 90, c = -180, d = -90, n = 0; (f.rings || f.paths || []).forEach((r) => r.forEach(([x, y]) => { n++; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; })); return n ? [a, b, c, d] : null; }
function encInside(rings, x, y) { let c = false; rings.forEach((r) => { for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } }); return c; }
async function encQuery(svc, layer, bb) {
  const ts = ENC_TILE[svc] || 0.25, out = [], seen = new Set(); let trunc = false;
  const x0 = Math.floor(bb[0] / ts), x1 = Math.floor(bb[2] / ts), y0 = Math.floor(bb[1] / ts), y1 = Math.floor(bb[3] / ts);
  const jobs = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(encTile(svc, layer, x, y));
  const small = bb[2] - bb[0] < 0.002 && bb[3] - bb[1] < 0.002, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  (await Promise.all(jobs)).forEach((arr) => { if (arr.trunc) trunc = true; arr.forEach((f) => {
    if (f.id != null) { if (seen.has(f.id)) return; seen.add(f.id); }
    const fb = f.bb || (f.bb = encBBox(f)); if (!fb || fb[2] < bb[0] || fb[0] > bb[2] || fb[3] < bb[1] || fb[1] > bb[3]) return;
    if (small && f.rings && !encInside(f.rings, cx, cy)) return; // a point lookup: only the areas the point is actually in
    out.push(f); }); });
  if (trunc) out.trunc = true; return out;
}
function wrNeedM() { const d = S.boat.draftFt, sb = S.boat.safetyFt == null ? 2 : S.boat.safetyFt; return d ? (d + sb) * 0.3048 : 1.2; }
async function waterGrid(a, b, padK) {
  const lat0 = (a.lat + b.lat) / 2, cosL = Math.cos(lat0 * Math.PI / 180), span = distNm(a, b);
  const padNm = Math.max(1.5 * (padK || 1) / 0.25, span * (padK || 0.25)), dLat = padNm / 60, dLon = padNm / 60 / cosL;
  const bb = [Math.min(a.lon, b.lon) - dLon, Math.min(a.lat, b.lat) - dLat, Math.max(a.lon, b.lon) + dLon, Math.max(a.lat, b.lat) + dLat];
  const wM = (bb[2] - bb[0]) * 111320 * cosL, hM = (bb[3] - bb[1]) * 111320;
  const cell = Math.max(30, Math.max(wM, hM) / 1400), W = Math.ceil(wM / cell), H = Math.ceil(hM / cell);
  const cLat = cell / 111320, cLon = cell / (111320 * cosL), off = (cLat / 2).toFixed(6);
  const svcs = span > 45 ? ['enc_general', 'enc_coastal', 'enc_approach'] : span > 6 ? ['enc_coastal', 'enc_approach', 'enc_harbour'] : ['enc_coastal', 'enc_approach', 'enc_harbour'];
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d'), need = wrNeedM(), toX = (lon) => (lon - bb[0]) / cLon, toY = (lat) => (bb[3] - lat) / cLat;
  const ring = (f) => { cx.beginPath(); (f.rings || []).forEach((r) => r.forEach(([lon, lat], i) => { if (i) cx.lineTo(toX(lon), toY(lat)); else cx.moveTo(toX(lon), toY(lat)); })); cx.fill('evenodd'); };
  const line = (f, w) => { cx.lineWidth = w; cx.lineCap = 'round'; cx.beginPath(); (f.paths || []).forEach((r) => r.forEach(([lon, lat], i) => { if (i) cx.lineTo(toX(lon), toY(lat)); else cx.moveTo(toX(lon), toY(lat)); })); cx.stroke(); };
  // fetch every chart scale at once, then paint coarse to fine so the most detailed chart has the last word
  const got = await Promise.all(svcs.map(async (svc) => {
    try {
      const lim = { enc_harbour: 0.3, enc_approach: 0.9 }[svc]; // big boxes: the detailed charts only around the two ends (the middle is open water at coarse cells anyway)
      const zones = lim && (bb[2] - bb[0] > lim || bb[3] - bb[1] > lim) ? [a, b].map((p) => [p.lon - 0.08, p.lat - 0.06, p.lon + 0.08, p.lat + 0.06]) : [bb];
      const Q = (layer) => Promise.all(zones.map((z) => encQuery(svc, layer, z))).then((r) => { const seen = new Set(), o = []; r.forEach((arr) => arr.forEach((f) => { if (f.id != null) { if (seen.has(f.id)) return; seen.add(f.id); } o.push(f); })); o.trunc = r.some((x) => x.trunc); return o; });
      const [d, dr, land, restr, brL, brA, slA, slL, wk, ob] = await Promise.all([Q('depth'), Q('dredged').catch(() => []), Q('land').catch(() => []), Q('restr').catch(() => []), Q('bridgeL').catch(() => []), Q('bridgeA').catch(() => []), Q('slconsA').catch(() => []), Q('slconsL').catch(() => []), span < 20 && typeof encPoints === 'function' ? encPoints(svc, 'wreck', zones[0]).catch(() => []) : [], span < 20 && typeof encPoints === 'function' ? encPoints(svc, 'obstr', zones[0]).catch(() => []) : []]);
      return { svc, d, dr, land: land.concat(slA), sl: slL, restr, br: brL.concat(brA), haz: wk.concat(ob), trunc: d.trunc || land.trunc };
    } catch (e) { WR.lastErr = e.message || String(e); return { svc, failed: true }; }
  }));
  if (got.every((x) => x.failed)) return null; // NOAA could not be reached at all: report it as a network problem, not as "no water"
  const partial = got.some((x) => x.failed || x.trunc); // a chart scale that did not load (or came back cut short) means the leg is not fully checked
  // Paint each chart scale on its own canvas, then merge coarse to fine: where a finer chart has coverage it has the last word.
  // Inside a scale, every area is filled AND outlined in its own colour, so the seams between neighbouring depth areas don't read
  // as land; land, piers and shoals are drawn last and a little wider, so thin land is never blended away.
  const g = new Uint8Array(W * H); // 0 blocked, 1 good, 2 maybe; nothing charted = blocked
  const allowMaybe = S.settings.routeMaybe !== false; // "maybe" = a charted depth RANGE that includes enough water (coastal 0–18 ft bands)
  const restrAll = [], brAll = [];
  const paint = (f, col, w) => { cx.fillStyle = col; cx.strokeStyle = col; cx.lineWidth = w; cx.lineJoin = 'round'; cx.beginPath(); (f.rings || []).forEach((r) => r.forEach(([lon, lat], i) => { if (i) cx.lineTo(toX(lon), toY(lat)); else cx.moveTo(toX(lon), toY(lat)); })); cx.fill('evenodd'); cx.stroke(); };
  got.forEach((x) => {
    if (!x || x.failed) return;
    cx.clearRect(0, 0, W, H);
    const areas = x.d.concat(x.dr).filter((f) => f.d1 != null && f.rings).map((f) => ({ f, k: f.d1 >= need ? 1 : f.d2 != null && f.d2 > need ? 2 : 0 }));
    [1, 2, 0].forEach((k) => areas.forEach((o) => { if (o.k === k) paint(o.f, k === 1 ? '#ff0000' : k === 2 ? '#00ff00' : '#000000', 1); })); // shallower drawn last: a shared edge goes to the shallower side
    x.land.forEach((f) => { if (f.rings) paint(f, '#000000', 1.1); }); // land and piers/jetties from the same chart wipe out any water under them
    cx.strokeStyle = '#000000'; (x.sl || []).forEach((f) => { if (f.paths) line(f, 2.5); });
    cx.fillStyle = '#000000'; (x.haz || []).forEach((h) => { const vs = h.a.VALSOU != null ? +h.a.VALSOU : null; if (vs == null || vs < need) { cx.beginPath(); cx.arc(toX(h.lon), toY(h.lat), 2.2, 0, Math.PI * 2); cx.fill(); } }); // wrecks and obstructions shallower than you need
    const px = cx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) {
      const al = px[i * 4 + 3]; if (al < 30) continue; // this chart says nothing here: keep the coarser answer
      const r0 = px[i * 4], g0 = px[i * 4 + 1], dark = r0 < 120 && g0 < 120;
      if (al < 200) { if (dark) g[i] = 0; continue; } // edge of this chart's coverage: only let it block
      g[i] = r0 > 170 && g0 < 90 ? 1 : g0 > 170 && r0 < 90 ? (allowMaybe ? 2 : 0) : 0;
    }
    restrAll.push(...x.restr); brAll.push(...x.br);
  });
  // areas you may not enter: charted "entry prohibited" and "area to be avoided", low bridges, event safety zones on the trip day, your own avoid areas
  cx.clearRect(0, 0, W, H); cx.fillStyle = '#000000'; cx.strokeStyle = '#000000';
  restrAll.forEach((f) => { const r = String(f.a.RESTRN || '').split(',').map(Number); if (f.rings && (r.includes(7) || r.includes(14))) paint(f, '#000000', 1); });
  const air = S.boat.airDraftFt ? (S.boat.airDraftFt + 2) * 0.3048 : null, lowBr = [];
  brAll.forEach((f) => {
    const cat = String(f.a.CATBRG || '').split(',').map(Number), opens = cat.some((c) => [2, 3, 4, 5, 7, 8].includes(c));
    const clr = opens ? null : (f.a.VERCLR != null ? +f.a.VERCLR : f.a.VERCCL != null ? +f.a.VERCCL : null);
    if (air && clr != null && clr > 0 && clr < air) { lowBr.push(f.a.OBJNAM || 'a bridge'); if (f.rings) paint(f, '#000000', 1); if (f.paths) line(f, 3); }
  });
  cx.fillStyle = '#000000'; avoidZonesFor(RT.depart || Date.now()).forEach((z) => { const [x, y] = [toX(z.lon), toY(z.lat)], r = z.r / cell + 1; cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fill(); });
  WR.lowBridges = lowBr;
  { const px = cx.getImageData(0, 0, W, H).data; for (let i = 0; i < W * H; i++) if (px[i * 4 + 3] > 40) g[i] = 0; }
  // distance (in cells) to the nearest blocked cell, so the path keeps off the shore and the shoals
  const dist = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) dist[i] = g[i] ? 1e6 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!dist[i]) continue; let m = dist[i]; if (x) m = Math.min(m, dist[i - 1] + 1); if (y) m = Math.min(m, dist[i - W] + 1); if (x && y) m = Math.min(m, dist[i - W - 1] + 1.41); if (y && x < W - 1) m = Math.min(m, dist[i - W + 1] + 1.41); dist[i] = m; }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (!dist[i]) continue; let m = dist[i]; if (x < W - 1) m = Math.min(m, dist[i + 1] + 1); if (y < H - 1) m = Math.min(m, dist[i + W] + 1); if (x < W - 1 && y < H - 1) m = Math.min(m, dist[i + W + 1] + 1.41); if (y < H - 1 && x) m = Math.min(m, dist[i + W - 1] + 1.41); dist[i] = m; }
  return { W, H, g, dist, bb, cLat, cLon, cell, partial, toXY: (p) => [Math.floor((p.lon - bb[0]) / cLon), Math.floor((bb[3] - p.lat) / cLat)], toLL: (x, y) => ({ lat: bb[3] - (y + 0.5) * cLat, lon: bb[0] + (x + 0.5) * cLon }) };
}
function wrSnap(G, x, y) {
  const ok = (i) => G.g[i] === 1 || G.g[i] === 2, maxR = Math.max(2, Math.ceil((G.snapM || 500) / G.cell)); // nudge a dock or club pin onto navigable water nearby (500 m)
  for (let r = 0; r <= maxR; r++) {
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= G.W || yy >= G.H) continue;
      const i = yy * G.W + xx; if (ok(i)) { const d = dx * dx + dy * dy - (G.g[i] === 1 ? 0.5 : 0); if (d < bd) { bd = d; best = i; } }
    }
    if (best >= 0) return best;
  }
  return -1;
}
function wrNearestReach(G, from, x, y, maxM) { // flood the water connected to 'from'; return the reached cell closest to (x, y) within maxM
  const N = G.W * G.H, seen = new Uint8Array(N), q = new Int32Array(N); let h = 0, tl = 0, best = -1, bd = (maxM / G.cell) ** 2;
  q[tl++] = from; seen[from] = 1;
  while (h < tl) { const i = q[h++], cx0 = i % G.W, cy0 = (i / G.W) | 0, d = (cx0 - x) ** 2 + (cy0 - y) ** 2; if (d < bd) { bd = d; best = i; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const xx = cx0 + dx, yy = cy0 + dy; if (xx < 0 || yy < 0 || xx >= G.W || yy >= G.H) continue; const j = yy * G.W + xx; if (seen[j] || !G.g[j]) continue; if (dx && dy && (!G.g[cy0 * G.W + xx] || !G.g[yy * G.W + cx0])) continue; seen[j] = 1; q[tl++] = j; } }
  return best;
}
function wrAstar(G, s, t) {
  const N = G.W * G.H, gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const tx = t % G.W, ty = (t / G.W) | 0, hh = (i) => { const dx = Math.abs(i % G.W - tx), dy = Math.abs(((i / G.W) | 0) - ty); return Math.max(dx, dy) + 0.41 * Math.min(dx, dy); };
  const heap = [], push = (i, f) => { heap.push([f, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  const step = (i) => { const d = G.dist[i]; return (G.g[i] === 2 ? 4 : 1) + (d < 4 ? (4 - d) * 0.7 : 0); };
  gs[s] = 0; push(s, hh(s));
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  let n = 0;
  while (heap.length) {
    const [, i] = pop(); if (closed[i]) continue; closed[i] = 1;
    if (i === t) break; if (++n > 4e6) return null;
    const x = i % G.W, y = (i / G.W) | 0;
    for (const [dx, dy, c] of NB) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= G.W || yy >= G.H) continue;
      const j = yy * G.W + xx; if (!G.g[j] || closed[j]) continue;
      if (dx && dy && (!G.g[y * G.W + xx] || !G.g[yy * G.W + x])) continue; // no squeezing diagonally between two land cells
      const ng = gs[i] + c * step(j); if (ng < gs[j]) { gs[j] = ng; from[j] = i; push(j, ng + hh(j)); }
    }
  }
  if (from[t] < 0 && s !== t) return null;
  const path = []; for (let i = t; i >= 0; i = from[i]) { path.push(i); if (i === s) break; }
  return path.reverse();
}
function wrClear(G, i, j) { // straight line between two cells stays in water, off the edges
  let x0 = i % G.W, y0 = (i / G.W) | 0; const x1 = j % G.W, y1 = (j / G.W) | 0, dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, minD = Math.min(G.dist[i], G.dist[j], 2.5), maybe = G.g[i] === 2 || G.g[j] === 2;
  for (;;) {
    const k = y0 * G.W + x0; if (!G.g[k] || G.dist[k] < minD - 0.01) return false; if (G.g[k] === 2 && !maybe) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
async function waterLeg(a, b) {
  if (distNm(a, b) < 0.15) return { ok: true, pts: [] };
  // try a box just around the two points first; if land closes it off (a peninsula, an island), look wider for the way around
  let G = null, path = null, s = -1, t = -1, far = 0;
  for (const k of [0.25, 0.9, 2]) {
    G = await waterGrid(a, b, k); if (!G) return { ok: false, why: 'net' };
    const [ax, ay] = G.toXY(a), [bx, by] = G.toXY(b); s = wrSnap(G, ax, ay); t = wrSnap(G, bx, by);
    if (s < 0 || t < 0) { G.snapM = 3000; if (s < 0) s = wrSnap(G, ax, ay); if (t < 0) t = wrSnap(G, bx, by); G.snapM = 0; far = 1; } // a town or inland pin: go to the nearest navigable water
    if (s < 0 || t < 0) return { ok: false, why: 'nowater' };
    path = wrAstar(G, s, t); if (path) break;
    // a pin can snap into a pocket of water that does not connect (the creek on the other side of town): try the nearest
    // water to each end that IS connected to the other end, within 3 km
    const tt = wrNearestReach(G, s, bx, by, 3000); if (tt >= 0) { path = wrAstar(G, s, tt); if (path) { t = tt; far = 1; break; } }
    const ss = wrNearestReach(G, t, ax, ay, 3000); if (ss >= 0) { path = wrAstar(G, ss, t); if (path) { s = ss; far = 1; break; } }
  }
  if (!path) return { ok: false, why: 'nopath' };
  const keep = [path[0]]; let k = 0;
  while (k < path.length - 1) { let j = path.length - 1; while (j > k + 1 && !wrClear(G, path[k], path[j])) j = Math.max(k + 1, Math.floor(k + (j - k) * 0.85)); keep.push(path[j]); k = j; }
  const shallow = path.some((i) => G.g[i] === 2);
  let pts = keep.map((i) => G.toLL(i % G.W, (i / G.W) | 0)), partial = G.partial;
  const sP = pts[0], tP = pts[pts.length - 1], dockA = distNm(a, sP), dockB = distNm(b, tP);
  // the search grid gets coarser over long distances; re-check every straight piece (water to water) on a fine grid so a thin spit or jetty can't slip through
  const allowMaybe = S.settings.routeMaybe !== false;
  const fineBad = (F, p0, p1, d, skipA, skipB) => { let bad = 0; const n = Math.ceil(d * 1852 / (F.cell * 0.7));
    for (let q = 1; q < n; q++) { const f = q / n, m = f * d * 1852; if (m < skipA || d * 1852 - m < skipB) continue; const ll = { lat: p0.lat + (p1.lat - p0.lat) * f, lon: p0.lon + (p1.lon - p0.lon) * f }, [x, y] = F.toXY(ll); const c = F.g[y * F.W + x]; if (!c || (c === 2 && !allowMaybe)) bad++; }
    return bad; };
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i], d = distNm(p0, p1); if (d < 0.05) continue;
    const skipA = i === 1 ? 150 : 0, skipB = i === pts.length - 1 ? 150 : 0; // the first/last 150 m are the way out of the slip
    const F = await waterGrid(p0, p1, 0.02); if (!F) { partial = true; continue; } if (F.partial) partial = true;
    if (fineBad(F, p0, p1, d, skipA, skipB) <= 1) continue;
    // the coarse search cut a corner (a shoal point, a spit): find this piece again on a fine grid and splice it in
    const L2 = await waterGrid(p0, p1, 0.3); if (!L2) { partial = true; continue; }
    const [x0, y0] = L2.toXY(p0), [x1, y1] = L2.toXY(p1), s2 = wrSnap(L2, x0, y0), t2 = wrSnap(L2, x1, y1), path2 = s2 >= 0 && t2 >= 0 ? wrAstar(L2, s2, t2) || ((r) => r >= 0 ? wrAstar(L2, s2, r) : null)(wrNearestReach(L2, s2, x1, y1, 400)) : null;
    if (!path2) return { ok: false, why: 'fine', pts, at: p0 }; // keep the rough path; it is drawn dashed
    const kp = [path2[0]]; let k2 = 0; while (k2 < path2.length - 1) { let j = path2.length - 1; while (j > k2 + 1 && !wrClear(L2, path2[k2], path2[j])) j = Math.max(k2 + 1, Math.floor(k2 + (j - k2) * 0.85)); kp.push(path2[j]); k2 = j; }
    const mid = kp.slice(1, -1).map((c) => L2.toLL(c % L2.W, (c / L2.W) | 0));
    pts.splice(i, 0, ...mid); i += mid.length; // the spliced pieces come from a 30 m grid: no further re-check needed
    if (pts.length > 400) return { ok: false, why: 'fine', pts, at: p0 };
  }
  if (partial) return { ok: false, why: 'partial', pts, shallow };
  return { ok: true, shallow, pts, dockA, dockB, far };
}
// turn a list of stops into stops plus turning points that stay in the water
async function routeByWater(stops) {
  const out = [], notes = []; let failed = 0;
  toast('Finding a route through the water…', 20000);
  for (let i = 0; i < stops.length; i++) {
    const p = stops[i];
    if (i) {
      const prev = stops[i - 1];
      let r; try { r = await waterLeg(prev, p); } catch (e) { r = { ok: false, why: 'net' }; WR.lastErr = e.message || String(e); }
      p.__ok = r.ok; p.__why = r.why; p.__sh = !!r.shallow;
      if (r.ok || ((r.why === 'partial' || r.why === 'fine') && r.pts)) {
        r.pts.forEach((q, k) => { if (k === 0 && distNm(q, prev) < 0.12) return; if (k === r.pts.length - 1 && distNm(q, p) < 0.12) return; out.push({ lat: q.lat, lon: q.lon, turn: true }); });
        if (r.dockB > 0.15) notes.push((p.name || 'Stop ' + (i + 1)) + ' is not on charted water; the route reaches the nearest navigable water about ' + fmtDist(r.dockB) + ' away. Find the marina or dock there.');
        if (r.shallow) notes.push('Part of the way to ' + (p.name || 'stop ' + (i + 1)) + ' crosses areas the chart only gives as a depth range that may be shallower than you need. Watch the depth there.');
      }
      if (!r.ok) failed++;
    }
    const o = Object.assign({}, p, { stop: true }); delete o.__ok; delete o.__why; delete o.unchecked; delete o.caution; if (p.__sh) o.caution = 1; delete o.__sh; if (i && p.__ok === false) o.unchecked = p.__why || 'net'; out.push(o);
  }
  if (failed) toast(wrWhy((out.find((q) => q.unchecked) || {}).unchecked), 8000);
  else toast(notes.length ? notes[0] : 'Route stays in water NOAA charts at ' + fmtLen(wrNeedM() / 0.3048) + ' or deeper (your draft plus buffer). Still watch the chart and depth.', 5000);
  return out;
}

/* ---------- buoys, beacons and lights from the NOAA chart data: tap for what it is; coloured at night so red and green still read ---------- */
const NV = { layer: null, tiles: new Map(), key: '' };
async function encPoints(svc, layer, bb) {
  const ids = await encLayerIds(svc); if (!ids || ids[layer] == null) return [];
  const key = 'p' + svc + layer + bb.join(','); if (WR.cache.has(key)) return WR.cache.get(key);
  const u = ids.host + '/arcgis/rest/services/encdirect/' + svc + '/MapServer/' + ids[layer] + '/query?where=1%3D1&geometry=' + bb.map((v) => v.toFixed(5)).join('%2C') +
    '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=1000&f=json';
  const j = await encJson(u, 20000);
  const out = (j.features || []).filter((f) => f.geometry && f.geometry.x != null).map((f) => { const a = {}; Object.keys(f.attributes || {}).forEach((k) => { a[k.toUpperCase()] = f.attributes[k]; }); return { lat: f.geometry.y, lon: f.geometry.x, a, kind: layer }; });
  WR.cache.set(key, out); return out;
}
const S57_COL = { 1: 'white', 2: 'black', 3: 'red', 4: 'green', 5: 'blue', 6: 'yellow', 11: 'orange' };
function navaidInfo(p) {
  const a = p.a, cols = String(a.COLOUR || '').split(',').map((c) => S57_COL[+c]).filter(Boolean), col = cols[0] || (p.kind === 'light' ? 'white' : 'other');
  const name = a.OBJNAM || '', num = (name.match(/(?:Buoy|Light|Beacon|Daybeacon|Daymark)\s+"?([A-Z0-9]{1,4})"?\s*$/i) || [])[1] || '';
  const shp = +a.BOYSHP || 0, bcn = +a.BCNSHP || 0;
  const shape = p.kind === 'buoy' ? ({ 1: 'nun', 2: 'can', 3: 'sphere', 4: 'pillar', 5: 'spar' }[shp] || 'buoy') : p.kind === 'beacon' ? ({ 1: 'pile', 3: 'tower', 4: 'lattice tower', 5: 'pile', 7: 'post' }[bcn] || 'daybeacon') : 'light';
  const chr = a.LITCHR ? ({ 1: 'F', 2: 'Fl', 3: 'LFl', 4: 'Q', 7: 'Iso', 8: 'Oc' }[+a.LITCHR] || '') : '';
  const rhythm = p.kind === 'light' && chr ? chr + (a.SIGGRP && a.SIGGRP !== '()' ? a.SIGGRP.replace(/[()]/g, '') : '') + ' ' + ({ red: 'R', green: 'G', white: 'W', yellow: 'Y' }[col] || '') + (a.SIGPER ? ' ' + a.SIGPER + 's' : '') : '';
  const label = ({ red: 'R', green: 'G', yellow: 'Y', white: 'W' }[col] || '') + (num ? ' ' + num : '');
  return { col, cols, num, shape, name, rhythm: rhythm.trim(), label: label.trim() };
}
function navaidOn() { return S.settings.navaids === 'always' || (S.settings.navaids !== 'off' && document.documentElement.hasAttribute('data-night')); }
async function drawNavaids() {
  if (!NV.layer) NV.layer = L.layerGroup().addTo(map);
  const z = map.getZoom();
  if (z < 12 || S.settings.chart === 'street') { NV.layer.clearLayers(); NV.key = ''; return; }
  const svc = z >= 14 ? 'enc_harbour' : 'enc_approach', step = svc === 'enc_harbour' ? 0.04 : 0.12, b = map.getBounds().pad(0.1), keys = [];
  for (let la = Math.floor(b.getSouth() / step) * step; la < b.getNorth(); la += step) for (let lo = Math.floor(b.getWest() / step) * step; lo < b.getEast(); lo += step) keys.push([svc, +la.toFixed(3), +lo.toFixed(3)].join(':'));
  if (keys.length > 24) return;
  await Promise.all(keys.filter((k) => !NV.tiles.has(k)).map(async (k) => {
    NV.tiles.set(k, null); const [, la, lo] = k.split(':').map(Number), bb = [lo, la, lo + step, la + step];
    try { const r = await Promise.all(['buoy', 'beacon', 'light'].map((l) => encPoints(svc, l, bb).catch(() => []))); NV.tiles.set(k, r.flat()); } catch (e) { NV.tiles.delete(k); }
  }));
  const vis = navaidOn(), key = keys.join('|') + vis + Math.round(z * 2);
  if (key === NV.key) return; NV.key = key;
  NV.layer.clearLayers(); const seen = new Set();
  keys.forEach((k) => (NV.tiles.get(k) || []).forEach((p) => {
    const id = p.lat.toFixed(5) + p.lon.toFixed(5); if (seen.has(id)) return; seen.add(id);
    const n = navaidInfo(p), showLbl = vis && z >= 13.5 && n.label;
    const glyph = p.kind === 'light' ? '<i class="nv-light"></i>' : n.shape === 'nun' ? '<i class="nv-nun"></i>' : n.shape === 'can' ? '<i class="nv-can"></i>' : '<i class="nv-dot"></i>';
    const html = '<div class="nv nv-' + n.col + (vis ? ' show' : '') + '">' + glyph + (showLbl ? '<b>' + esc(n.label) + '</b>' : '') + '</div>';
    const m = L.marker([p.lat, p.lon], { keyboard: false, zIndexOffset: 500, icon: L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12], html }) });
    m.on('click', () => openNavaid(p, n)); NV.layer.addLayer(m);
  }));
}
// a name and a photo for anything you tap: Wikipedia for named places (lighthouses), Wikimedia Commons photos taken near the spot
async function placeMedia(lat, lon, name, box) {
  if (!box) return;
  const W = 'https://en.wikipedia.org/w/api.php?origin=*&format=json&', C = 'https://commons.wikimedia.org/w/api.php?origin=*&format=json&';
  try {
    let title = null, img = null, extract = '';
    const g = await fetchT(W + 'action=query&list=geosearch&gscoord=' + lat.toFixed(5) + '|' + lon.toFixed(5) + '&gsradius=600&gslimit=8', 9000).then((r) => r.json());
    const hits = ((g.query || {}).geosearch || []), want = (name || '').toLowerCase().replace(/\b(light|buoy|beacon|daybeacon)\b/g, '').trim();
    const pick = hits.find((h) => /lighthouse|light station|light\b|shoal|point|bridge|tower|yacht|club|marina|harbor/i.test(h.title) && (!want || h.title.toLowerCase().includes(want.split(' ')[0]))) || hits.find((h) => /lighthouse|light\b/i.test(h.title)) || (name ? null : hits[0]);
    if (pick) {
      title = pick.title;
      const d = await fetchT(W + 'action=query&prop=pageimages|extracts&exintro=1&explaintext=1&exsentences=2&piprop=thumbnail&pithumbsize=640&pageids=' + pick.pageid, 9000).then((r) => r.json());
      const pg = Object.values((d.query || {}).pages || {})[0] || {}; if (pg.thumbnail) img = pg.thumbnail.source; extract = pg.extract || '';
    }
    let credit = title ? 'Wikipedia' : '';
    if (!img) {
      const c = await fetchT(C + 'action=query&generator=geosearch&ggscoord=' + lat.toFixed(5) + '|' + lon.toFixed(5) + '&ggsradius=300&ggslimit=6&ggsnamespace=6&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640', 9000).then((r) => r.json());
      const f = Object.values((c.query || {}).pages || {}).find((x) => x.imageinfo && /\.(jpe?g|png)$/i.test(x.title));
      if (f) { img = f.imageinfo[0].thumburl; const m = f.imageinfo[0].extmetadata || {}; credit = 'Photo: ' + ((m.Artist && m.Artist.value || '').replace(/<[^>]+>/g, '').trim() || 'Wikimedia Commons') + (m.LicenseShortName ? ' · ' + m.LicenseShortName.value : '') + ' · Wikimedia Commons'; }
    }
    if (!document.body.contains(box)) return;
    box.innerHTML = (title ? '<div class="pm-title">' + esc(title) + '</div>' : '') + (img ? '<img class="pm-img" src="' + esc(img) + '" alt="" loading="lazy">' : '') + (extract ? '<p class="pm-x">' + esc(extract) + '</p>' : '') + (credit && (img || extract) ? '<p class="hint pm-c">' + esc(credit) + (title ? ' · <a href="https://en.wikipedia.org/wiki/' + encodeURIComponent(title) + '" target="_blank" rel="noopener">more</a>' : '') + '</p>' : '');
  } catch (e) { if (document.body.contains(box)) box.innerHTML = ''; }
}
function openNavaid(p, n) {
  if (!n.name) { let best = null, bd = 0.06; NV.tiles.forEach((v) => (v || []).forEach((q) => { const nm = q.a && q.a.OBJNAM; if (nm && q !== p) { const d = distNm(p, q); if (d < bd) { bd = d; best = nm; } } })); if (best) n.name = best; }
  setTimeout(() => placeMedia(p.lat, p.lon, n.name, $('pmBox')), 30);
  const what = (n.cols.length > 1 ? n.cols.join(' and ') : n.col) + ' ' + n.shape;
  const side = n.col === 'red' ? 'Red, right, returning: keep it on your starboard side heading in from sea.' : n.col === 'green' ? 'Keep it on your port side heading in from sea.' : '';
  const named = n.name && p.kind === 'light' && !/buoy/i.test(n.name);
  openSheet('<h3>' + (named ? esc(n.name) : esc(what.charAt(0).toUpperCase() + what.slice(1)) + (n.num ? ' "' + esc(n.num) + '"' : '')) + '</h3><div class="sub">' + (named ? esc(n.rhythm ? 'Light · ' + n.rhythm : 'Light') : esc(n.name || 'Aid to navigation')) + '</div>' +
    (n.rhythm ? '<p><b>Light:</b> ' + esc(n.rhythm) + (p.a.VALNMR ? ', visible ' + esc(p.a.VALNMR) + ' nm' : '') + (p.a.HEIGHT ? ', ' + Math.round(p.a.HEIGHT / 0.3048) + ' ft high' : '') + '</p>' : '') +
    '<div class="pm" id="pmBox"><p class="sub">Looking for a photo…</p></div>' + (side ? '<p class="hint">' + side + '</p>' : '') + '<p class="hint">From NOAA chart data (ENC). Positions of buoys can shift: always check against what you see.</p><div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>');
}
map.on('moveend', () => { clearTimeout(NV.t); NV.t = setTimeout(drawNavaids, 500); });
setTimeout(drawNavaids, 3500);

/* ---------- shallow water tint: NOAA ENC depth areas shaded by this boat's draft, so shoals stand out without reading numbers ---------- */
const SH = { layer: null, tiles: new Map(), busy: 0, drawnKey: '' };
function shallowOn() { return S.settings.shallowTint !== false && S.settings.chart !== 'street'; }
// shallow tint styles: kept light so the Bay never turns into a sheet of mud
function shallowStyleFor(shallow, night) {
  const lv = [0.55, 1, 1.5][(+S.settings.shallowLevel || 2) - 1], sty = S.settings.shallowStyle || 'coral';
  const P = { coral: ['#FF7A6B', '#FFD27A', 0.2, 0.12], amber: ['#F5A623', '#FFE08A', 0.2, 0.12], pale: ['#FFFFFF', '#FFFFFF', 0.5, 0.25], edge: ['#E5484D', '#E8A33A', 0, 0] }[sty];
  const sat = document.documentElement.classList.contains('sat'); // over satellite water coral reads as purple: use warm sand and amber there
  const col = night ? (shallow ? '#C0392B' : '#8A4A2A') : sat ? (shallow ? '#FFB547' : '#FFE29A') : (shallow ? P[0] : P[1]);
  const fo = (shallow ? P[2] : P[3]) * lv * (night ? 0.9 : 1);
  if (sat && sty !== 'edge') return { fillColor: col, fillOpacity: (shallow ? 0.26 : 0.14) * lv, stroke: shallow, color: '#FFC56B', weight: 0.8, opacity: 0.45 };
  return sty === 'edge' ? { fillOpacity: 0, stroke: true, color: col, weight: shallow ? 1.6 * lv : 1, opacity: shallow ? 0.75 : 0.45, dashArray: shallow ? null : '4 4' } : { fillColor: col, fillOpacity: fo, stroke: shallow, color: col, weight: 0.8, opacity: 0.35 * lv };
}
async function drawShallow() {
  if (!SH.layer) SH.layer = L.layerGroup().addTo(map);
  const z = map.getZoom();
  if (!shallowOn() || z < 10.5) { SH.layer.clearLayers(); SH.drawnKey = ''; return; }
  const svc = z >= 13.5 ? 'enc_harbour' : 'enc_approach', step = svc === 'enc_harbour' ? 0.04 : 0.15, b = map.getBounds().pad(0.15);
  const keys = [];
  for (let la = Math.floor(b.getSouth() / step) * step; la < b.getNorth(); la += step) for (let lo = Math.floor(b.getWest() / step) * step; lo < b.getEast(); lo += step) keys.push(svc + ':' + la.toFixed(3) + ':' + lo.toFixed(3));
  if (keys.length > 30) return;
  const need = wrNeedM(), dk = keys.join('|') + need + document.documentElement.hasAttribute('data-night');
  await Promise.all(keys.filter((k) => !SH.tiles.has(k)).map(async (k) => {
    SH.tiles.set(k, null); const [, la, lo] = k.split(':').map(Number);
    try { const f = await encQuery(svc, 'depth', [lo, la, lo + step, la + step], svc === 'enc_harbour' ? 0.00005 : 0.0002); SH.tiles.set(k, f); } catch (e) { SH.tiles.delete(k); }
  }));
  const dk2 = dk + (S.settings.shallowStyle || 'coral') + (S.settings.shallowLevel || 2);
  if (dk2 === SH.drawnKey) return; SH.drawnKey = dk2;
  const night = document.documentElement.hasAttribute('data-night'), rend = SH.rend || (SH.rend = L.canvas({ padding: 0.2 }));
  SH.layer.clearLayers(); const seen = new Set();
  keys.forEach((k) => (SH.tiles.get(k) || []).forEach((f) => {
    if (f.d1 == null) return;
    const shallow = (f.d2 != null ? f.d2 : f.d1 + 2) <= need, close = !shallow && f.d1 < need;
    if (!shallow && !close) return;
    const id = f.d1 + ':' + f.rings[0].length + ':' + f.rings[0][0].join(','); if (seen.has(id)) return; seen.add(id);
    const st = shallowStyleFor(shallow, night);
    SH.layer.addLayer(L.polygon(f.rings.map((r) => r.map(([lo2, la2]) => [la2, lo2])), Object.assign({ renderer: rend, stroke: false, interactive: false }, st)));
  }));
}
map.on('moveend', () => { clearTimeout(SH.t); SH.t = setTimeout(drawShallow, 400); });
setTimeout(drawShallow, 3000);

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
  const isTurn = g.route && g.route.pts[g.route.i] && g.route.pts[g.route.i].turn;
  if (info.d < (isTurn ? 0.08 : 0.03) && !g.arrived) {
    g.arrived = true; store.set('goto', g);
    if (g.route && g.route.i + 1 < g.route.pts.length) { const r = g.route, nx = r.pts[r.i + 1]; if (isTurn) { beep(1); const nb = fmtBrg(bearing(S.fix, nx)); toast('Turn to ' + nb + '°T'); headsUp('Turn to ' + nb + ' degrees.'); } else { beep(2); toast('Stop reached. On to the next one.'); headsUp('Stop reached. Next leg.'); } setTimeout(() => routeLeg(r.pts, r.i + 1), 50); return; }
    beep(2);
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
  const legBad = g.route && g.route.pts.slice(0, g.route.i + 1).some((p, k, arr) => k === arr.length - 1 && p.unchecked) || (g.route && g.route.pts[g.route.i] && g.route.pts[g.route.i].unchecked);
  $('gotoRow').innerHTML = (legBad ? '<div class="g-warn">⚠ This leg is NOT checked against the chart: it may cross land or shoals. Watch the chart and depth.</div>' : '') + '<div class="g-main"><span class="g-name">To ' + esc(g.name) + (g.arrived ? ' · arrived' : '') + '</span>' +
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
function applyStatus() { document.documentElement.classList.toggle('no-status', !S.settings.statusOn); }
setTimeout(applyStatus, 0);
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
    if (g) g.setAttribute('transform', 'rotate(' + (hdg + mapRot()) + ' 18 18)');
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
// weather model choice (Open-Meteo runs them all): Best for here, or pick one, like PredictWind
const WX_MODELS = [['best_match', 'Best for here', 'Open-Meteo picks the sharpest model for each place'], ['ncep_hrrr_conus', 'HRRR 3 km', 'US only, next 18–48 h, catches sea breezes and storms'], ['ecmwf_ifs025', 'ECMWF 25 km', 'European model, often best beyond 2 days'], ['ncep_gfs_seamless', 'GFS', 'US global model'], ['icon_seamless', 'ICON', 'German DWD model'], ['gem_seamless', 'GEM', 'Canadian model'], ['ncep_nbm_conus', 'NBM', 'NWS blend of models, US only']];
const wxM = () => { const m = S.settings.wxModel || 'best_match'; return m === 'best_match' ? '' : '&models=' + m; };
async function maybeWeather(force) {
  const f = refPos(); if (!f || wxBusy) return;
  const w = S.weather;
  if (!force && w && w.press && w.press.length && Date.now() - w.at < 30 * 60000 && distNm(w.pos, f) < 5) return;
  wxBusy = true;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + f.lat.toFixed(3) + '&longitude=' + f.lon.toFixed(3) + wxM() +
      '&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,pressure_msl,weather_code,cloud_cover&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation,pressure_msl,weather_code' +
      '&daily=sunrise,sunset&wind_speed_unit=kn&temperature_unit=fahrenheit&timezone=auto&forecast_days=7&past_days=1';
    const r = await fetch(url);
    if (!r.ok && wxM()) { S.settings.wxModel = 'best_match'; saveSettings(); toast('That weather model is not available here, so Tideline switched back to Best for here.', 5000); wxBusy = false; return maybeWeather(true); }
    if (!r.ok) throw new Error('weather ' + r.status);
    const j = await r.json();
    const off = (j.utc_offset_seconds || 0) * 1000;
    const tt = (s) => Date.parse(s + 'Z') - off;
    S.weather = {
      at: Date.now(), pos: { lat: f.lat, lon: f.lon },
      cur: { spd: j.current.wind_speed_10m, dir: j.current.wind_direction_10m, gust: j.current.wind_gusts_10m, temp: j.current.temperature_2m, p: j.current.pressure_msl, code: j.current.weather_code, cloud: j.current.cloud_cover },
      press: j.hourly.pressure_msl ? j.hourly.time.map((t, i) => ({ t: tt(t), p: j.hourly.pressure_msl[i], code: j.hourly.weather_code ? j.hourly.weather_code[i] : null })) : [],
      hours: j.hourly.time.map((t, i) => ({ t: tt(t), spd: j.hourly.wind_speed_10m[i], dir: j.hourly.wind_direction_10m[i], gust: j.hourly.wind_gusts_10m[i], temp: j.hourly.temperature_2m ? j.hourly.temperature_2m[i] : null, rain: j.hourly.precipitation ? j.hourly.precipitation[i] : null, code: j.hourly.weather_code ? j.hourly.weather_code[i] : null })),
      sunrise: j.daily.sunrise.map(tt), sunset: j.daily.sunset.map(tt),
    };
    try {
      const m = await fetch('https://marine-api.open-meteo.com/v1/marine?latitude=' + f.lat.toFixed(3) + '&longitude=' + f.lon.toFixed(3) +
        '&current=wave_height,wave_direction,wave_period,sea_surface_temperature&hourly=wave_height&length_unit=imperial&timezone=GMT&forecast_days=7').then((r) => r.json());
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
function fetchT(url, ms) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 15000); return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t)); }
// smooth hourly heights from high/low times (cosine between each pair), for NOAA subordinate stations that only publish highs and lows
function hiloToHourly(hl) {
  const out = []; if (hl.length < 2) return out;
  const t0 = Math.ceil(hl[0].t / 3600000) * 3600000;
  for (let t = t0, i = 0; t <= hl[hl.length - 1].t; t += 3600000) {
    while (i < hl.length - 2 && hl[i + 1].t < t) i++;
    const a = hl[i], b = hl[i + 1], f = (t - a.t) / (b.t - a.t);
    out.push({ t, v: a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2 });
  }
  return out;
}
// NOAA tide predictions for any point: nearest stations within 30 nm, hourly heights (built from highs and lows when NOAA only publishes those)
async function tideFor(f) {
  let st = store.get('stations2', null);
  if (!st) {
    const j = await fetchT('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions').then((r) => r.json());
    st = j.stations.map((s2) => [s2.id, s2.name, +s2.lat, +s2.lng]); store.set('stations2', st);
  }
  const near = st.map((s2) => [s2, distNm(f, { lat: s2[2], lon: s2[3] })]).filter((x) => x[1] <= 30).sort((a2, b2) => a2[1] - b2[1]).slice(0, 4);
  const start = new Date(Date.now() - 30 * 3600000), pt = (x) => Date.parse(x.replace(' ', 'T') + ':00Z');
  for (const [best, bd] of near) {
    const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=Tideline&begin_date=' + ymd(start) +
      '&range=180&datum=MLLW&station=' + best[0] + '&time_zone=gmt&units=english&format=json&interval=';
    const [h1, h2] = await Promise.all([fetchT(base + 'hilo').then((r) => r.json()).catch(() => ({})), fetchT(base + 'h').then((r) => r.json()).catch(() => ({}))]);
    const hilo = (h1.predictions || []).map((x) => ({ t: pt(x.t), v: +x.v, type: x.type }));
    let hourly = (h2.predictions || []).map((x) => ({ t: pt(x.t), v: +x.v }));
    if (hourly.length < 2) hourly = hiloToHourly(hilo);
    if (hourly.length < 2) continue;
    let mhw = null;
    try { const dj = await fetchT('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/' + best[0] + '/datums.json?units=english').then((r) => r.json()); const dv = (n) => { const d = (dj.datums || []).find((x) => x.name === n); return d ? +d.value : null; }; if (dv('MHW') != null && dv('MLLW') != null) mhw = dv('MHW') - dv('MLLW'); } catch (e) { /* no datums */ }
    return { at: Date.now(), pos: { lat: f.lat, lon: f.lon }, station: { id: best[0], name: best[1], dist: bd }, mhw, hilo, hourly, fromHilo: !(h2.predictions || []).length };
  }
  return { at: Date.now(), pos: { lat: f.lat, lon: f.lon }, none: true, err: near.length ? 'NOAA did not answer' : null };
}
async function maybeTide(force) {
  const f = refPos(); if (!f || tideBusy) return;
  const t = S.tide;
  if (!force && t && Date.now() - t.at < 3 * 3600000 && t.pos && distNm(t.pos, f) < 10 && (t.none ? Date.now() - t.at < 1800000 : tideNow())) return;
  tideBusy = true;
  try { S.tide = await tideFor(f); store.set('tide', S.tide); checkWaterLevel(true); } catch (e) { S.tideErr = Date.now(); }
  tideBusy = false; renderChips(); renderLive(); try { renderWxBar(); renderSide(); } catch (e) { /* not ready */ }
}
// what the tide is doing: flood (rising), ebb (falling) or slack (near the turn). Height-based; tidal current can lag the height by an hour or more.
function tideState(tt, at) {
  tt = tt || S.tide; at = at || Date.now(); if (!tt || tt.none || !tt.hourly) return null;
  const v = (x) => { const h = tt.hourly; for (let i = 1; i < h.length; i++) if (h[i].t >= x) { const a2 = h[i - 1], b2 = h[i]; return a2.v + (b2.v - a2.v) * ((x - a2.t) / (b2.t - a2.t)); } return null; };
  const now = v(at), soon = v(at + 1800000); if (now == null || soon == null) return null;
  const turn = (tt.hilo || []).find((p) => Math.abs(p.t - at) < 40 * 60000), next = (tt.hilo || []).find((p) => p.t > at);
  const state = turn ? (turn.type === 'H' ? 'Slack, high water' : 'Slack, low water') : soon > now ? 'Flood' : 'Ebb';
  return { v: now, state, short: turn ? 'SLACK' : soon > now ? 'FLOOD' : 'EBB', rising: soon > now, next, rate: (soon - now) * 2 };
}
// measured water level vs. the prediction at the NOAA station: wind and pressure push the Bay well away from the tide table
async function checkWaterLevel(force) {
  const t = S.tide; if (!t || t.none || !t.station) return;
  if (!force && S.wl && Date.now() - S.wl.at < 12 * 60000 && S.wl.id === t.station.id) return;
  try {
    const j = await fetchT('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_level&application=Tideline&date=latest&datum=MLLW&station=' + t.station.id + '&time_zone=gmt&units=english&format=json', 12000).then((r) => r.json());
    const d = j.data && j.data[0]; if (!d || d.v === '') { S.wl = { at: Date.now(), id: t.station.id, none: true }; return; }
    const ot = Date.parse(d.t.replace(' ', 'T') + ':00Z'), pred = tideAtT(ot);
    S.wl = { at: Date.now(), id: t.station.id, obs: +d.v, t: ot, pred, diff: pred != null ? +d.v - pred : null, name: t.station.name };
    if (S.wl.diff != null && Math.abs(S.wl.diff) >= 1.5) { const k = 'wl' + new Date().toDateString() + (S.wl.diff > 0 ? 'h' : 'l'); if (!ALR.seen.has(k)) { ALR.seen.add(k); toast((S.wl.diff > 0 ? 'Unusually high water: ' : 'Unusually low water: ') + Math.abs(S.wl.diff).toFixed(1) + ' ft ' + (S.wl.diff > 0 ? 'above' : 'below') + ' the tide table at ' + S.wl.name.replace(/,.*$/, '') + '. Check depths and docks.', 9000); beep(1); } }
  } catch (e) { /* this station does not measure water level */ }
  try { renderSide(); renderTideCard(); } catch (e) { /* closed */ }
}
setInterval(() => checkWaterLevel(false), 12 * 60000);
// Chesapeake local knowledge: sustained north winds blow water out of the Bay, south winds pile it in; a nor'easter tilts it toward the western shore
function windTideNote() {
  const c = S.fix || refPos(), w = S.weather; if (!w || !w.hours || !inChesapeake(c)) return '';
  const now = Date.now(), past = w.hours.filter((h) => h.t <= now && h.t > now - 30 * 3600000 && h.spd != null);
  if (past.length < 12) return '';
  let u = 0, v2 = 0; past.forEach((h) => { const r = h.dir * Math.PI / 180; u += Math.sin(r) * h.spd; v2 += Math.cos(r) * h.spd; });
  u /= past.length; v2 /= past.length; const spd = Math.hypot(u, v2), from = (Math.atan2(u, v2) * 180 / Math.PI + 360) % 360;
  if (spd < 10) return '';
  const name = compass16(from), wl = S.wl && S.wl.diff != null ? S.wl.diff : null;
  const meas = wl != null && Math.abs(wl) >= 0.5 ? ' NOAA is measuring ' + Math.abs(wl).toFixed(1) + ' ft ' + (wl > 0 ? 'above' : 'below') + ' the prediction at ' + (S.wl.name || '').replace(/,.*$/, '') + '.' : '';
  if (from >= 315 || from <= 30) return 'A day and more of ' + name + ' wind around ' + Math.round(spd) + ' kn pushes water out of the Bay: expect lower tides than the table (a blowout).' + meas;
  if (from > 30 && from < 75) return name + ' wind for a day or more (nor\'easter pattern) piles water against the western shore and drains the eastern shore; tides run high on the western side.' + meas;
  if (from >= 135 && from <= 225) return 'Steady ' + name + ' wind pushes water up the Bay: expect higher tides than the table, especially in the upper Bay.' + meas;
  return meas.trim();
}
function tideEmptyTxt() {
  if (tideBusy || !S.tide) return 'Getting NOAA tide predictions…';
  if (S.tideErr && Date.now() - S.tideErr < 600000) return 'Could not reach NOAA tides just now. Check the connection; it retries when you move the chart.';
  if (S.tide.none && S.tide.err) return 'NOAA tide stations nearby did not answer. Trying again shortly.';
  return 'No NOAA tide station within 30 nm.';
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
  if (wxOn('wind') || wxOn('waves') || wxOn('rain')) { if (!map.hasLayer(wxGrid)) wxGrid.addTo(map); loadGrids(); } else { wxGrid.clearLayers(); if (map.hasLayer(wxGrid)) map.removeLayer(wxGrid); }
  if (!wxOn('wind')) { wsStop(); document.documentElement.classList.remove('wlines'); }
  try { renderChips(); } catch (e) { /* early */ }
  renderWxBar();
}
function gridPoints() {
  const b = map.getBounds(), sz = map.getSize();
  const cols = Math.max(3, Math.min(8, Math.round(sz.x / 170))), rows = Math.max(3, Math.min(9, Math.round(sz.y / 170)));
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const lat = b.getNorth() - (b.getNorth() - b.getSouth()) * (r + 0.5) / rows, lon = b.getWest() + (b.getEast() - b.getWest()) * (c + 0.5) / cols;
    pts.push({ lat: +lat.toFixed(3), lon: +lon.toFixed(3) });
  }
  return pts;
}
WX.grids = {};
function loadGrids(force) { ['wind', 'waves', 'rain'].forEach((k) => { if (wxOn(k)) loadGrid(k, force); }); drawGrid(); }
async function loadGrid(kind, force) {
  const pts = gridPoints(), key = pts.map((p) => p.lat + ',' + p.lon).join('|'), g = WX.grids[kind];
  if (!force && g && g.key === key && Date.now() - g.at < 30 * 60000) return;
  const seq = (WX.seqs = WX.seqs || {})[kind] = ((WX.seqs || {})[kind] || 0) + 1;
  const ll = '?latitude=' + pts.map((p) => p.lat).join(',') + '&longitude=' + pts.map((p) => p.lon).join(',');
  const url = kind === 'rain' ? 'https://api.open-meteo.com/v1/forecast' + ll + '&hourly=precipitation&timezone=GMT&forecast_days=7'
    : kind === 'wind'
    ? 'https://api.open-meteo.com/v1/forecast' + ll + wxM() + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=GMT&forecast_days=7'
    : 'https://marine-api.open-meteo.com/v1/marine' + ll + '&hourly=wave_height,wave_direction,wave_period&length_unit=imperial&timezone=GMT&forecast_days=7';
  WX.busy = true; renderWxBar();
  try {
    const j = await fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    if (seq !== WX.seqs[kind]) return;
    const arr = Array.isArray(j) ? j : [j];
    WX.grids[kind] = { kind, key, at: Date.now(), pts: arr.map((d, i) => {
      const h = d.hourly || {}, times = (h.time || []).map((t) => Date.parse(t + 'Z'));
      if (kind === 'rain') return { lat: pts[i].lat, lon: pts[i].lon, t: times, a: h.precipitation };
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
/* ---------- animated wind lines: light streaks drifting with the forecast wind, like smoke on the water ---------- */
const WS = { cv: null, ctx: null, parts: [], field: null, raf: 0, run: false, moving: false };
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function wsSetup() {
  if (WS.cv) return;
  WS.cv = document.createElement('canvas'); WS.cv.className = 'wind-lines'; map.getContainer().appendChild(WS.cv); WS.ctx = WS.cv.getContext('2d');
  map.on('zoomstart', () => { WS.moving = true; if (WS.ctx) WS.ctx.clearRect(0, 0, WS.cv.width, WS.cv.height); });
  map.on('zoomend resize', () => { WS.moving = false; wsField(); });
  map.on('move', () => { // panning: slide the lines with the chart instead of stopping them
    if (!WS.field || !WS.ref || WS.moving) return;
    const pt = map.latLngToContainerPoint(WS.ref), dx = pt.x - WS.refPt.x, dy = pt.y - WS.refPt.y; if (!dx && !dy) return;
    WS.refPt = pt; WS.field.forEach((f) => { f.x += dx; f.y += dy; }); WS.parts.forEach((q) => { q.x += dx; q.y += dy; });
    if (Math.abs(dx) + Math.abs(dy) > 3) WS.ctx.clearRect(0, 0, WS.sz.x, WS.sz.y); // big pans: start the trails fresh
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) wsStop(); else if (wxOn('wind')) wsStart(); });
}
function wsField() {
  const g = WX.grids.wind; if (!g || !WS.cv) { WS.field = null; return; }
  WS.moving = false;
  const sz = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
  WS.cv.width = sz.x * dpr; WS.cv.height = sz.y * dpr; WS.cv.style.width = sz.x + 'px'; WS.cv.style.height = sz.y + 'px'; WS.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const want = Date.now() + WX.hour * 3600000, rot = mapRot();
  WS.field = g.pts.filter((p) => p.t.length).map((p) => { // blend the two forecast hours either side of the slider time, so the lines change smoothly
    let i0 = 0; for (let i = 0; i < p.t.length; i++) if (p.t[i] <= want) i0 = i; const i1 = Math.min(p.t.length - 1, i0 + 1), f = p.t[i1] > p.t[i0] ? Math.max(0, Math.min(1, (want - p.t[i0]) / (p.t[i1] - p.t[i0]))) : 0;
    const uv = (i) => { const sp = p.a && p.a[i], d = p.b && p.b[i]; if (sp == null || d == null) return null; const to = (d + 180 + rot) * Math.PI / 180; return [Math.sin(to) * sp, -Math.cos(to) * sp, sp]; };
    const a = uv(i0), b = uv(i1) || a; if (!a) return null; const u = a[0] + (b[0] - a[0]) * f, v = a[1] + (b[1] - a[1]) * f, spd = a[2] + (b[2] - a[2]) * f;
    const pt = map.latLngToContainerPoint([p.lat, p.lon]); return { x: pt.x, y: pt.y, u, v, s: spd }; }).filter(Boolean);
  const n = Math.min(1400, Math.round(sz.x * sz.y / 1500));
  if (!WS.parts.length || !WS.sz || WS.sz.x !== sz.x || WS.sz.y !== sz.y) WS.parts = Array.from({ length: n }, () => wsSeed(sz)); // keep the lines flowing while the time slider moves
  WS.ref = map.getCenter(); WS.refPt = map.latLngToContainerPoint(WS.ref);
  WS.sz = sz;
}
function wsSeed(sz) { return { x: Math.random() * sz.x, y: Math.random() * sz.y, age: Math.floor(Math.random() * 80), max: 60 + Math.random() * 60 }; }
function wsAt(x, y) { // inverse-distance blend of the nearby forecast points
  let su = 0, sv = 0, ss = 0, sw = 0;
  for (const f of WS.field) { const d2 = (f.x - x) ** 2 + (f.y - y) ** 2 + 400, w = 1 / (d2 * d2); su += f.u * w; sv += f.v * w; ss += f.s * w; sw += w; }
  return sw ? [su / sw, sv / sw, ss / sw] : [0, 0, 0];
}
const WS_RGBA = {};
function wsColor(s) { // same colour scale as the wind markers and the forecast bar
  const hex = colFor(WIND_COL, s), night = document.documentElement.hasAttribute('data-night');
  const k = hex + night; if (WS_RGBA[k]) return WS_RGBA[k];
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b2 = n & 255;
  return (WS_RGBA[k] = 'rgba(' + r + ',' + g + ',' + b2 + ',' + (night ? 0.5 : 0.62) + ')');
}
function wsFrame() {
  if (!WS.run) return;
  WS.raf = requestAnimationFrame(wsFrame);
  if (WS.moving || !WS.field || !WS.field.length) return;
  const c = WS.ctx, sz = WS.sz, k = 0.09; // pixels per frame per knot: light air barely drifts, a breeze streams
  c.globalCompositeOperation = 'destination-out'; c.fillStyle = 'rgba(0,0,0,0.085)'; c.fillRect(0, 0, sz.x, sz.y);
  c.globalCompositeOperation = 'source-over'; c.lineWidth = 1.4; c.lineCap = 'round';
  for (const p of WS.parts) {
    const [u, v, s] = wsAt(p.x, p.y), nx = p.x + u * k, ny = p.y + v * k;
    if (p.age > 2) { c.strokeStyle = wsColor(s); c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(nx, ny); c.stroke(); }
    p.x = nx; p.y = ny; p.age++;
    if (p.age > p.max || nx < -5 || ny < -5 || nx > sz.x + 5 || ny > sz.y + 5) Object.assign(p, wsSeed(sz), { age: 0 });
  }
}
function wsStart() { wsSetup(); WS.cv.hidden = false; wsField(); if (reduceMotion || WS.run) return; WS.run = true; wsFrame(); }
function wsStop() { WS.run = false; cancelAnimationFrame(WS.raf); if (WS.cv) { WS.ctx.clearRect(0, 0, WS.cv.width, WS.cv.height); WS.cv.hidden = true; } }
const rainGrid = L.layerGroup().addTo(map);
function drawRainForecast() { // future hours: model rain as soft blue patches; hour 0 is the live radar
  rainGrid.clearLayers();
  const g = wxOn('rain') && WX.grids.rain, live = Math.abs(WX.hour) < 0.08, past = WX.hour <= -0.08;
  if (map.hasLayer(radarLayer) !== (wxOn('rain') && live)) { if (wxOn('rain') && live) radarLayer.addTo(map); else if (map.hasLayer(radarLayer)) map.removeLayer(radarLayer); }
  // the past 50 minutes of real radar, in 5-minute frames (Iowa Environmental Mesonet keeps them), so you can see where a storm came from
  const mm = past ? Math.max(5, Math.min(50, Math.round(-WX.hour * 12) * 5)) : 0;
  if (wxOn('rain') && past && !window.TL_DEMO) { const url = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913-m' + String(mm).padStart(2, '0') + 'm/{z}/{x}/{y}.png'; if (!WX.pastRadar) WX.pastRadar = L.tileLayer(url, { opacity: 0.6, zIndex: 5, maxNativeZoom: 12, attribution: 'Radar: Iowa Environmental Mesonet' }); else if (WX.pastRadar._url !== url) WX.pastRadar.setUrl(url, false); if (!map.hasLayer(WX.pastRadar)) WX.pastRadar.addTo(map); }
  else if (WX.pastRadar && map.hasLayer(WX.pastRadar)) map.removeLayer(WX.pastRadar);
  if (past) return;
  if (!g || live) return;
  const sz = map.getSize(), r = Math.max(sz.x, sz.y) / 7, ren = WX.rren || (WX.rren = L.canvas({ padding: 0.3 }));
  g.pts.forEach((p) => { if (!p.t.length || !p.a) return; const v = p.a[gridIndex(p.t)]; if (!(v >= 0.1)) return;
    const col = colFor(RAIN_COL, v), ll = map.containerPointToLatLng(map.latLngToContainerPoint([p.lat, p.lon]).add([r, 0]));
    rainGrid.addLayer(L.circle([p.lat, p.lon], { renderer: ren, radius: map.distance([p.lat, p.lon], ll), stroke: false, fillColor: col, fillOpacity: Math.min(0.45, 0.18 + v / 20), interactive: false })); });
}
function drawGrid() {
  drawRainForecast();
  if (wxOn('wind') && WX.grids.wind && S.settings.windLines !== false) { wsStart(); document.documentElement.classList.add('wlines'); } else { wsStop(); document.documentElement.classList.remove('wlines'); }
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
      html = '<div class="wx-pt" style="--c:' + col + '"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><g transform="rotate(' + ((w.dir + 180 + mapRot()) % 360) + ' 12 12)"><path d="M12 2v18M12 2l-5.5 6.5M12 2l5.5 6.5" /></g></svg><b>' + Math.round(speedOut(w.v)) + (w.g != null ? '<small>' + Math.round(speedOut(w.g)) + '</small>' : '') + '</b>' +
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
/* ---------- moon and sky: moonrise, moonset and phase computed here (after SunCalc), plus the year's big meteor showers ---------- */
const AST = (() => {
  const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;
  const toDays = (d) => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const sidereal = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
  const alt = (H, phi, dc) => Math.asin(Math.sin(phi) * Math.sin(dc) + Math.cos(phi) * Math.cos(dc) * Math.cos(H));
  function moonCoords(d) { const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.229350 * d); const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F), dt = 385001 - 20905 * Math.cos(M); return { ra: ra(l, b), dec: dec(l, b), dist: dt }; }
  function moonAlt(date, lat, lng) { const lw = rad * -lng, phi = rad * lat, d = toDays(date), c = moonCoords(d), H = sidereal(d, lw) - c.ra; let h = alt(H, phi, c.dec); h += rad * 0.017 / Math.tan(h + rad * 10.26 / (h + rad * 5.10)); return h; }
  function moonTimes(date, lat, lng) { // rise and set within the local day of `date`
    const t = new Date(date); t.setHours(0, 0, 0, 0); const hc = 0.133 * rad, hAt = (h) => moonAlt(new Date(t.valueOf() + h * 36e5), lat, lng) - hc;
    let h0 = hAt(0), rise = null, set = null;
    for (let i = 1; i <= 24; i += 2) {
      const h1 = hAt(i), h2 = hAt(i + 1), a = (h0 + h2) / 2 - h1, b2 = (h2 - h0) / 2, xe = -b2 / (2 * a), ye = (a * xe + b2) * xe + h1, dd = b2 * b2 - 4 * a * h1;
      let roots = 0, x1 = 0, x2 = 0;
      if (dd >= 0) { const dx = Math.sqrt(dd) / (Math.abs(a) * 2); x1 = xe - dx; x2 = xe + dx; if (Math.abs(x1) <= 1) roots++; if (Math.abs(x2) <= 1) roots++; if (x1 < -1) x1 = x2; }
      if (roots === 1) { if (h0 < 0) rise = i + x1; else set = i + x1; } else if (roots === 2) { rise = i + (ye < 0 ? x2 : x1); set = i + (ye < 0 ? x1 : x2); }
      if (rise != null && set != null) break; h0 = h2;
    }
    const at = (h) => (h == null ? null : new Date(t.valueOf() + h * 36e5));
    return { rise: at(rise), set: at(set) };
  }
  function phase(date) { // 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter; fraction lit
    const d = toDays(date), M = rad * (357.5291 + 0.98560028 * d), C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)), Ls = M + C + rad * 102.9372 + Math.PI;
    const sun = { ra: ra(Ls, 0), dec: dec(Ls, 0) }, m = moonCoords(d), sdist = 149598000;
    const phi = Math.acos(Math.sin(sun.dec) * Math.sin(m.dec) + Math.cos(sun.dec) * Math.cos(m.dec) * Math.cos(sun.ra - m.ra)), inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
    const angle = Math.atan2(Math.cos(sun.dec) * Math.sin(sun.ra - m.ra), Math.sin(sun.dec) * Math.cos(m.dec) - Math.cos(sun.dec) * Math.sin(m.dec) * Math.cos(sun.ra - m.ra));
    return { frac: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI };
  }
  return { moonTimes, phase };
})();
function moonName(p) { const x = p.phase; return x < 0.03 || x > 0.97 ? 'New moon' : x < 0.22 ? 'Waxing crescent' : x < 0.28 ? 'First quarter' : x < 0.47 ? 'Waxing gibbous' : x < 0.53 ? 'Full moon' : x < 0.72 ? 'Waning gibbous' : x < 0.78 ? 'Last quarter' : 'Waning crescent'; }
// annual meteor-shower peaks (dates move a day either way year to year)
const SHOWERS = [['Quadrantids', 1, 3, 'up to 80 an hour, short sharp peak before dawn'], ['Lyrids', 4, 22, 'about 15 an hour, best after midnight'], ['Eta Aquariids', 5, 6, 'best in the hour before dawn'], ['Perseids', 8, 12, 'up to 60–100 an hour, best after midnight'], ['Draconids', 10, 8, 'best in the early evening'], ['Orionids', 10, 21, 'about 20 an hour after midnight'], ['Leonids', 11, 17, 'about 15 an hour before dawn'], ['Geminids', 12, 14, 'up to 120 an hour, good from mid-evening']];
function skyNotes(date) {
  const d = date || new Date(), c = S.fix || refPos(), out = [], mt = AST.moonTimes(d, c.lat, c.lon), ph = AST.phase(d);
  out.push(moonName(ph) + ' (' + Math.round(ph.frac * 100) + '% lit)' + (mt.rise ? ' · moonrise ' + fmtClock(mt.rise.getTime()) : '') + (mt.set ? ' · moonset ' + fmtClock(mt.set.getTime()) : ''));
  SHOWERS.forEach(([n, mo, day, how]) => { const pk = new Date(d.getFullYear(), mo - 1, day, 23), dd = (pk - d) / 864e5; if (dd > -1.5 && dd < 2.5) out.push('★ ' + n + ' meteor shower ' + (dd < 0.5 && dd > -1.5 ? 'peaks tonight' : 'peaks in ' + Math.round(dd) + ' day' + (Math.round(dd) === 1 ? '' : 's')) + ': ' + how + (ph.frac > 0.6 ? '; a bright moon will wash out the fainter ones' : '; dark skies on the water make it a good one') + '.'); });
  if (ph.frac > 0.97) out.push('Full moon: expect stronger tides (spring tides) and a bright night watch.');
  if (ph.frac < 0.03) out.push('New moon: dark night, stronger spring tides; lights on other boats are easier to see, unlit marks are not.');
  return out;
}
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
  const off = Math.max(0, Math.min(WXH - 46, sel - 24)), t0 = Date.now() + (off - 2) * 3600000, t1 = Date.now() + (off + 46) * 3600000, h = (S.tide.hourly || []).filter((x) => x.t >= t0 && x.t <= t1);
  if (h.length < 3) return '<p class="sub">No tide table yet.</p>';
  const lo = Math.min(...h.map((x) => x.v)) - 0.3, hi = Math.max(...h.map((x) => x.v)) + 0.3, W = 960, H = 92;
  const X = (t) => ((t - t0) / (t1 - t0)) * W, Y = (v) => H - 14 - ((v - lo) / (hi - lo)) * (H - 30);
  const path = h.map((x, i) => (i ? 'L' : 'M') + X(x.t).toFixed(1) + ' ' + Y(x.v).toFixed(1)).join('');
  const st = Date.now() + sel * 3600000, sv = tideAtT(st);
  const lab = (S.tide.hilo || []).filter((p) => p.t > t0 && p.t < t1).map((p) => '<text x="' + X(p.t).toFixed(0) + '" y="' + (p.type === 'H' ? Y(p.v) - 6 : Y(p.v) + 14).toFixed(0) + '" text-anchor="middle">' + (p.type === 'H' ? 'High ' : 'Low ') + fmtClock(p.t) + '</text>').join('');
  return '<svg class="tl-tide" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Tide curve"><path d="' + path + ' L' + W + ' ' + H + ' L0 ' + H + 'Z" class="fill"/><path d="' + path + '" class="line"/>' +
    '<line x1="' + X(Date.now()) + '" x2="' + X(Date.now()) + '" y1="0" y2="' + H + '" class="now"/>' + (sv != null ? '<circle cx="' + X(st) + '" cy="' + Y(sv) + '" r="6" class="sel"/>' : '') + lab + '</svg>';
}
// NWS point forecast: NOAA graphical forecast interface for the selected coordinates
function nwsGraphUrl(p) { return 'https://forecast.weather.gov/MapClick.php?lat=' + p.lat.toFixed(4) + '&lon=' + p.lon.toFixed(4) + '&FcstType=graphical'; }
function nwsPointUrl(p) { return 'https://forecast.weather.gov/MapClick.php?lat=' + p.lat.toFixed(4) + '&lon=' + p.lon.toFixed(4); }
function renderTimeline(el) {
  const v = WX.view || 'wind', w = S.weather, wide = isWide(), open = wide || WX.open;
  const tabs = [['wind', 'Wind'], ['waves', 'Waves'], ['rain', 'Rain'], ['tide', 'Tide']];
  const t = Date.now() + WX.hour * 3600000;
  let now = '';
  if (v === 'wind') { const s = seriesAt(w && w.hours, t, 'spd'), d = seriesAt(w && w.hours, t, 'dir'), g = seriesAt(w && w.hours, t, 'gust'); now = s != null ? compass16(d) + ' ' + Math.round(speedOut(s)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ', gust ' + Math.round(speedOut(g)) : 'No forecast yet'; }
  if (v === 'waves') { const h = seriesAt(w && w.waveHours, t, 'h'); now = h != null ? 'Waves ' + waveLen(h) : 'No wave forecast here'; }
  if (v === 'rain') now = 'Live radar · updates every 5 min';
  let CI = null; try { const st = CUR.chipSt, pr = st && CUR.pred.get(st.id + ':' + ymdUTC(Date.now() - 86400000)); if (pr && pr.ev && pr.ev.length) CI = { st, pr }; } catch (e) { /* currents not loaded yet */ }
  const curTxt = (n) => n ? (n.kn < 0.4 ? 'slack' : n.kn.toFixed(1) + ' kn ' + (n.flood ? 'flood' : 'ebb') + ' toward ' + compass16(n.dir || 0)) : null;
  if (v === 'current') { const n = CI && curAt(CI.pr, t); now = n ? 'Current ' + curTxt(n) + ' · ' + esc(CI.st.n.replace(/,.*$/, '')) : 'Loading current predictions…'; }
  if (v === 'tide') { const tv = tideAtT(t); now = tv != null ? 'Tide ' + tideLen(tv) + ' above MLLW' + (S.tide.station ? ' · ' + esc(S.tide.station.name.replace(/,.*$/, '')) : '') : 'No tide station nearby'; }
  const chips = [['wind', 'Wind'], ['waves', 'Waves'], ['rain', 'Rain']].map(([k, l]) => '<button type="button" data-tlv="' + k + '" class="' + (wxOn(k) ? 'on' : '') + (v === k ? ' focus' : '') + '" aria-pressed="' + wxOn(k) + '">' + l + '</button>').join('') +
    '<button type="button" data-tlv="tide" class="' + (v === 'tide' ? 'on focus' : '') + '">Tide</button>' +
    '<button type="button" data-tlv="current" class="' + (S.settings.curOn ? 'on' : '') + (v === 'current' ? ' focus' : '') + '">Current</button>';
  const parts = [];
  { const s2 = seriesAt(w && w.hours, t, 'spd'), d = seriesAt(w && w.hours, t, 'dir'), g = seriesAt(w && w.hours, t, 'gust'); if (s2 != null) parts.push(compass16(d) + ' ' + Math.round(speedOut(s2)) + (g != null ? ' g' + Math.round(speedOut(g)) : '') + ' ' + SPEED_LBL[S.settings.speedUnit]); }
  { const wv = seriesAt(w && w.waveHours, t, 'h'); if (wv != null) parts.push(waveLen(wv)); }
  { const tv = tideAtT(t); if (tv != null) parts.push('tide ' + tideLen(tv)); }
  { const n = CI && curAt(CI.pr, t); if (n) parts.push('current ' + curTxt(n)); }
  if (w) { const air = WX.hour ? seriesAt(w.hours, t, 'temp') : w.cur && w.cur.temp, water = S.waterObs ? S.waterObs.f : w.sst; if (air != null) parts.push('air ' + tempTxt(air)); if (water != null) parts.push('water ' + tempTxt(water)); }
  const np = S.fix || refPos();
  let h = (wide ? '' : '<button type="button" class="tl-grab" data-tlopen aria-label="' + (open ? 'Show less' : 'Show the hours') + '"><i></i></button>') +
    '<div class="tl-heading">' + (np ? '<a class="nws-btn" href="' + nwsGraphUrl(np) + '" target="_blank" rel="noopener" data-tip="NOAA graphical forecast for this location"><span>NOAA point forecast</span><span aria-hidden="true">↗</span></a>' : '') + '<button type="button" class="tl-x" data-tlx aria-label="Close weather">&times;</button></div>' +
    '<div class="tl-chips">' + chips + '</div>' +
    '<button type="button" class="tl-model" data-wxmodel>' + esc((WX_MODELS.find((m) => m[0] === (S.settings.wxModel || 'best_match')) || WX_MODELS[0])[1]) + ' ▾</button>' +
    '<div class="tl-sum"><b>' + (WX.hour ? hourLabel(WX.hour).replace('Forecast ', '') : 'Now') + '</b> ' + esc(parts.join(' · ') || 'Waiting for forecast') + '</div>' +
    '<div class="tl-sky">' + skyNotes(new Date(Date.now() + WX.hour * 3600000)).map((x) => '<span>' + esc(x) + '</span>').join('') + '</div>';
  if (open) {
    if (v === 'wind' || v === 'waves') {
      const cells = [];
      for (let k = 0; k <= WXH; k++) {
        const tt = Date.now() + k * 3600000, val = v === 'wind' ? seriesAt(w && w.hours, tt, 'spd') : seriesAt(w && w.waveHours, tt, 'h');
        const dir = v === 'wind' ? seriesAt(w && w.hours, tt, 'dir') : null, d = new Date(tt);
        const day = d.getHours() === 0 ? '<em>' + d.toLocaleDateString([], { weekday: 'short' }) + '</em>' : '';
        cells.push('<button type="button" class="tl-h' + (k === Math.round(WX.hour) ? ' on' : '') + '" data-tlh="' + k + '">' + day + '<small>' + (k ? d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s?(AM|PM)/i, (m) => m.trim()[0].toLowerCase()) : 'Now') + '</small>' +
          '<i style="--c:' + (val == null ? 'var(--line)' : colFor(v === 'wind' ? WIND_COL : WAVE_COL, val)) + '">' + (dir != null ? windArrow(dir) : '') + '</i><b class="tnum">' + (val == null ? '–' : v === 'wind' ? Math.round(speedOut(val)) : (lenUnit() === 'm' ? (val * 0.3048).toFixed(1) : val.toFixed(1))) + '</b></button>');
      }
      h += '<div class="tl-hours" id="tlHours">' + cells.join('') + '</div>';
      if (false) h += '<div class="wx-legend">' + (v === 'wind' ? WIND_COL : WAVE_COL).map((c, i) => '<span><i style="background:' + c[1] + '"></i>' + (v === 'wind' ? ['<5', '5', '10', '15', '20', '25+'] : ['<1', '1', '2', '3', '5+'])[i] + '</span>').join('') + '<span class="u">' + (v === 'wind' ? SPEED_LBL[S.settings.speedUnit] : lenUnit()) + ' · model forecast' + (w ? ', fetched ' + agoTxt(w.at) : '') + '</span></div>';
    } else if (v === 'current') {
      if (CI) {
        const cells = [];
        for (let k = 0; k <= WXH; k++) {
          const tt = Date.now() + k * 3600000, n = curAt(CI.pr, tt), d = new Date(tt), day = d.getHours() === 0 ? '<em>' + d.toLocaleDateString([], { weekday: 'short' }) + '</em>' : '';
          cells.push('<button type="button" class="tl-h' + (k === Math.round(WX.hour) ? ' on' : '') + '" data-tlh="' + k + '">' + day + '<small>' + (k ? d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s?(AM|PM)/i, (m) => m.trim()[0].toLowerCase()) : 'Now') + '</small><i style="--c:' + (n ? curColor(n.kn) : 'var(--line)') + '">' + (n && n.kn >= 0.4 ? windArrow(((n.dir || 0) + 180) % 360) : '·') + '</i><b class="tnum">' + (n ? (n.kn < 0.4 ? 'slack' : n.kn.toFixed(1)) : '–') + '</b><span>' + (n && n.kn >= 0.4 ? (n.flood ? 'flood' : 'ebb') : '') + '</span></button>');
        }
        h += '<div class="tl-hours" id="tlHours">' + cells.join('') + '</div><p class="hint" style="margin:2px 0 0">NOAA current predictions at ' + esc(CI.st.n) + '. Arrows point the way the water runs. <a href="#" data-cur-near>This station in detail</a> · the chart shows every nearby station.</p>';
      } else h += '<div class="tl-sum" style="opacity:.8">Loading NOAA current predictions for the nearest station…</div>';
    } else if (v === 'tide') {
      h += S.tide && !S.tide.none ? tideCurve(WX.hour) + '<input type="range" id="tlTide" min="0" max="' + WXH + '" step="any" value="' + WX.hour + '" aria-label="Time"><p class="hint" style="margin:2px 0 0">NOAA predictions' + (S.tide.station ? ' for ' + esc(S.tide.station.name) + ', ' + fmtDist(S.tide.station.dist) + ' away' : '') + '. Wind can push water above or below these.</p>' + tideTable() : '<p class="sub">' + tideEmptyTxt() + '</p>';
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
    if (k === 'current') { const on = !(S.settings.curOn && WX.view === 'current') || !S.settings.curOn; if (on) { WX.view = 'current'; WX.open = true; setCurrents(true); renderCurChip().then(() => renderWxBar()); } else { setCurrents(false); WX.view = ['wind', 'waves', 'rain'].find(wxOn) || 'wind'; } renderWxBar(); return; }
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
  WX.hour = Math.max(0, Math.min(WXH, Math.round(h * 4) / 4));
  const svg = document.querySelector('.tl-tide'); if (svg) svg.outerHTML = tideCurve(WX.hour);
  const sl = $('tlTide'); if (sl) sl.value = WX.hour;
  const t = Date.now() + WX.hour * 3600000, tv = tideAtT(t), n = document.querySelector('.tl-now'), nx = (S.tide.hilo || []).find((p) => p.t > t), rising = nx ? nx.type === 'H' : null;
  if (n) { n.querySelector('b').textContent = WX.hour ? new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'Now'; n.querySelector('span').textContent = tv != null ? tideLen(tv) + (rising == null ? '' : rising ? ' rising' : ' falling') + (nx ? ' · ' + (nx.type === 'H' ? 'high ' : 'low ') + fmtClock(nx.t) : '') : ''; }
}
document.addEventListener('pointerdown', (e) => {
  const svg = e.target.closest('.tl-tide'); if (!svg) return; e.preventDefault();
  const move = (ev) => { const r = document.querySelector('.tl-tide').getBoundingClientRect(); const fx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); { const off = Math.max(0, Math.min(WXH - 46, WX.hour - 24)); tideSet(off + fx * 48 - 2); } };
  move(e); const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
});
document.addEventListener('input', (e) => { if (e.target.id === 'tlTide') tideSet(+e.target.value); });

/* forecast scrubber: time bubble above the thumb, hour and day steps, and a colour strip of what is coming */
const RAIN_COL = [[0.1, 'transparent'], [1, '#9CCBF0'], [4, '#3F8FD8'], [10, '#1F4FB0'], [Infinity, '#7B2FBF']];
const WXH = 167; // forecast hours on the slider: 7 days
function hourSeverity(k, only) { // the colour for one layer at hour k, using the same values the chart shows
  const w = S.weather, t = Date.now() + k * 3600000;
  if (only === 'wind') { const sp = seriesAt(w && w.hours, t, 'spd'); return sp == null ? 'var(--line)' : colFor(WIND_COL, sp); }
  if (only === 'waves') { const v = seriesAt(w && w.waveHours, t, 'h'); return v == null ? 'var(--line)' : colFor(WAVE_COL, v); }
  if (only === 'rain') { const v = seriesAt(w && w.hours, t, 'rain'); return v != null && v >= 0.1 ? colFor(RAIN_COL, v) : 'transparent'; }
  return 'var(--line)';
}
function forecastScrubber() {
  const max = WXH, k = Math.min(max, WX.hour), strip = [], lo = wxOn('rain') ? -0.84 : 0;
  const kinds = ['wind', 'waves', 'rain'].filter(wxOn); if (!kinds.length) kinds.push('wind');
  kinds.forEach((kd) => { const row = []; for (let i = 0; i <= max; i++) row.push('<i style="background:' + hourSeverity(i, kd) + '"></i>'); strip.push('<div class="sc-row" title="' + kd + '">' + row.join('') + '</div>'); });
  const marks = []; for (let i = 0; i <= max; i++) { const d = new Date(Date.now() + i * 3600000); if (d.getHours() === 0) marks.push('<em style="left:' + (i / max * 100).toFixed(1) + '%">' + d.toLocaleDateString([], { weekday: 'short' }) + '</em>'); }
  return '<div class="scrub"><button type="button" class="sc-b" data-wxstep="-24" aria-label="Back a day">«</button><button type="button" class="sc-b" data-wxstep="-1" aria-label="Back an hour">‹</button>' +
    '<div class="sc-mid"><div class="sc-bub" id="wxBub" style="left:' + ((k - lo) / (max - lo) * 100).toFixed(1) + '%">' + scrubLabel(k) + '</div><div class="sc-strip" aria-hidden="true">' + strip.join('') + '</div>' + marks.join('') +
    '<input type="range" id="wxHour" min="' + (wxOn('rain') ? -0.84 : 0) + '" max="' + max + '" step="any" value="' + k + '" aria-label="Forecast time"></div>' +
    '<button type="button" class="sc-b" data-wxstep="1" aria-label="Forward an hour">›</button><button type="button" class="sc-b" data-wxstep="24" aria-label="Forward a day">»</button><button type="button" class="sc-b sc-play' + (WX.play ? ' on' : '') + '" data-wxplay aria-label="' + (WX.play ? 'Pause' : 'Play the forecast') + '" data-tip="' + (WX.play ? 'Pause' : 'Play: watch wind, waves and rain change hour by hour') + '">' + (WX.play ? '❚❚' : '▶') + '</button></div>';
}
function scrubLabel(k) { if (Math.abs(k) < 0.08) return 'Now'; if (k < 0) return Math.round(-k * 60 / 5) * 5 + ' min ago'; const d = new Date(Math.round((Date.now() + k * 3600000) / 300000) * 300000); return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
// the time slider moves smoothly; the map layers redraw at most a few times a second, and whenever the hour changes
function setWxHour(k) {
  WX.hour = Math.max(wxOn('rain') ? -0.84 : 0, Math.min(WXH, k)); const r = $('wxHour'); if (r && document.activeElement !== r) r.value = WX.hour;
  const lo = wxOn('rain') ? -0.84 : 0, b = $('wxBub'); if (b) { b.textContent = scrubLabel(WX.hour); b.style.left = ((WX.hour - lo) / (WXH - lo) * 100).toFixed(2) + '%'; }
  $('wxBar').classList.toggle('future', WX.hour > 0.08);
  const hr = Math.round(WX.hour), now = performance.now();
  if (hr !== WX.drawnHr || now - (WX.drawnAt || 0) > 300) { WX.drawnHr = hr; WX.drawnAt = now; drawGrid(); try { if (curOn()) { drawCurrents(); } } catch (e) { /* currents not ready */ } }
  clearTimeout(WX.settle); WX.settle = setTimeout(() => { drawGrid(); try { if (curOn()) drawCurrents(); } catch (e) { /* later */ } }, 160);
}
document.addEventListener('click', (e) => { const st = e.target.closest('[data-wxstep]'); if (st) { wxStop(); setWxHour(WX.hour + +st.dataset.wxstep); } });
// play the forecast: steps an hour about every 0.9 s through all the layers you have on, then stops at the end
function wxStop() { if (!WX.play) return; clearInterval(WX.play); WX.play = null; renderWxBar(); }
function wxPlay() {
  if (WX.play) { wxStop(); return; }
  if (!wxAny()) { setWxL('wind', true); }
  if (WX.hour >= WXH) setWxHour(0);
  let last = performance.now(); // smooth: about an hour and a half of forecast per second
  WX.play = setInterval(() => { const t = performance.now(), dt = (t - last) / 1000; last = t; if (WX.hour >= WXH) { wxStop(); return; } setWxHour(WX.hour + dt * 1.5); }, 40);
  renderWxBar();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-wxplay]')) wxPlay(); });
document.addEventListener('input', (e) => { if (e.target.id === 'wxHour') wxStop(); }, true);
function renderWxBar() {
  const el = $('wxBar'), k = S.settings.wx; if (!el) return;
  if (S.tab === 'weather') { el.hidden = false; renderTimeline(el); el.insertAdjacentHTML('beforeend', '<button type="button" class="btn small weather-alert-link" data-weather-alerts>⚠ Weather alerts</button><button type="button" class="btn small weather-alert-link" data-cur-near>⇄ Currents near you</button><button type="button" class="btn small weather-alert-link" data-lx-open>⚡ Lightning</button>'); return; }
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
    const html = '<div class="obs-pin' + (old ? ' old' : '') + '"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(' + ((o.dir + 180 + mapRot()) % 360) + ' 12 12)"><path d="M12 3v16M12 3l-5 6M12 3l5 6"/></g></svg><b>' + compass16(o.dir) + ' ' + Math.round(speedOut(o.spd)) + '</b>' + (o.gust ? '<span>g' + Math.round(speedOut(o.gust)) + '</span>' : '') + '</div>';
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
  const ch = document.querySelector('.chips'), fc = $('fabs'); if (!ch || !fc) return; // chips now live in the left column
  const r = ch.getBoundingClientRect();
  fc.style.top = isWide() && r.height ? Math.max(170, r.bottom + 10) + 'px' : '';
}
function renderChips() {
  const w = S.weather, wc = $('windChip'), U = SPEED_LBL[S.settings.speedUnit];
  if (w && w.cur) {
    const ob = nearestObs(), d = ob ? ob : w.cur;
    wc.hidden = false; wc.classList.toggle('on', wxOn('wind'));
    wc.innerHTML = '<span class="fi-ic" style="transform:rotate(' + Math.round((d.dir + 180) % 360) + 'deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M6 9l6-6 6 6"/></svg></span><b>' + Math.round(speedOut(d.spd)) + '</b>';
    wc.dataset.tip = 'Wind ' + compass16(d.dir) + ' ' + Math.round(speedOut(d.spd)) + ' ' + U + ', gust ' + Math.round(speedOut(d.gust)) + (ob ? ' · measured at ' + ob.name.replace(/,.*$/, '') + ', ' + agoTxt(ob.t) : ' · forecast, ' + agoTxt(w.at)) + '. Tap to show wind on the chart.';
  } else wc.hidden = true;
  const wv = $('waveChip');
  if (w && w.wave && w.wave.h != null) {
    wv.hidden = false; wv.classList.toggle('on', wxOn('waves'));
    wv.innerHTML = '<span class="fi-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10c3-3 6-3 9 0s6 3 9 0M3 16c3-3 6-3 9 0s6 3 9 0"/></svg></span><b>' + waveLen(w.wave.h).replace(/\s*(ft|m)$/, '') + '</b>';
    wv.dataset.tip = 'Waves ' + waveLen(w.wave.h) + ' (model forecast). Tap to show waves on the chart.';
  } else wv.hidden = true;
  const old = w && Date.now() - w.at > 3 * 3600000;
  wc.classList.toggle('stale', !!old); wv.classList.toggle('stale', !!old);
  const tn = tideNow(), tc = $('tideChip');
  if (tn) {
    tc.hidden = false;
    tc.innerHTML = '<span class="fi-ic"><svg viewBox="0 0 24 24" aria-hidden="true">' + (tn.rising === false ? '<path d="M12 3v8M8.5 7.5L12 11l3.5-3.5"/>' : '<path d="M12 3v8M8.5 6.5L12 3l3.5 3.5"/>') + '<path d="M3 16c3-2.5 6-2.5 9 0s6 2.5 9 0M3 20.5c3-2.5 6-2.5 9 0s6 2.5 9 0"/></svg></span><b>' + tideLen(tn.v).replace(/\s*(ft|m)$/, '') + '</b>';
    tc.classList.toggle('on', !!S.tideCardOn);
    tc.dataset.tip = 'Tide ' + tideLen(tn.v) + (tn.rising == null ? '' : tn.rising ? ', rising' : ', falling') + (tn.next ? ' · ' + (tn.next.type === 'H' ? 'high ' : 'low ') + fmtClock(tn.next.t) : '') + (S.tide.station ? ' · NOAA ' + S.tide.station.name.replace(/,.*$/, '') : '') + '. Tap to show or hide the tide curve.';
  } else tc.hidden = true;
  const rc = $('rainChip');
  if (rc) { rc.hidden = false; rc.classList.toggle('on', wxOn('rain')); const pr = w && w.hours ? seriesAt(w.hours, Date.now(), 'rain') : null; rc.innerHTML = '<span class="fi-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8.5a3.5 3.5 0 0 1 .5 6.5"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/></svg></span><b>Rain</b>'; rc.dataset.tip = 'Rain radar' + (pr > 0.01 ? ' · rain in the forecast here' : '') + '. Tap to show or hide live radar on the chart.'; }
  placeFabs(); renderStatusWx(); try { renderWxBtn(); } catch (e) { /* early */ }
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
const SIDE_MAX = 10;
function sideIds() { return (S.settings.sideSlots || ['speed', 'depth', 'course', 'wind', 'auto', 'time']).filter((x) => x !== 'chart' && x !== 'off').slice(0, SIDE_MAX); }
function applySideWidth() { document.documentElement.dataset.side = S.settings.sideWidth || 'normal'; setTimeout(() => { try { map.invalidateSize(); } catch (e) { /* not ready */ } }, 60); }
function openSideCustom() {
  const cur = sideIds(), wd = S.settings.sideWidth || 'normal';
  const opts = CK_OPTS.filter(([v]) => v !== 'chart' && v !== 'off').concat([['auto', 'Tide, or destination when navigating']]);
  openSheet('<h3>Gauges beside the chart</h3><div class="sub">Pick up to ten. They fit themselves to the space, in this order.</div>' +
    '<div class="field"><label>Gauge panel size</label><div class="seg" role="group">' + [['normal', 'Narrow'], ['third', 'A third'], ['half', 'Half the screen']].map(([v, l]) => '<button type="button" data-sidew="' + v + '" class="' + (wd === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div></div>' +
    '<div class="side-picks">' + Array.from({ length: SIDE_MAX }, (_, i) => '<div class="field"><label>Gauge ' + (i + 1) + '</label><select data-sidepick="' + i + '"><option value="off">None</option>' + opts.map(([v, l]) => '<option value="' + v + '"' + (cur[i] === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>').join('') + '</div>' +
    '<div class="row-btns"><button class="btn primary" data-act="close">Done</button></div>');
}
sheet.addEventListener('click', (e) => { const b = e.target.closest('[data-sidew]'); if (!b) return; S.settings.sideWidth = b.dataset.sidew; saveSettings(); applySideWidth(); sheet.querySelectorAll('[data-sidew]').forEach((x) => x.classList.toggle('on', x === b)); setTimeout(renderSide, 80); });
sheet.addEventListener('change', (e) => { const sp = e.target.closest('[data-sidepick]'); if (!sp) return; const cur = sideIds(); while (cur.length < SIDE_MAX) cur.push('off'); cur[+sp.dataset.sidepick] = sp.value; S.settings.sideSlots = cur.filter((x) => x !== 'off'); if (!S.settings.sideSlots.length) S.settings.sideSlots = ['speed']; saveSettings(); renderSide(); });
function sideCols(n, W, H) { let best = 1, bs = 0; for (let c = 1; c <= Math.min(n, 5); c++) { const r = Math.ceil(n / c), sz = Math.min(W / c, (H / r) * 1.05); if (sz > bs + 1) { bs = sz; best = c; } } return best; }
applySideWidth(); window.addEventListener('resize', () => { clearTimeout(window.__sgT); window.__sgT = setTimeout(() => { try { renderSide(); } catch (e) { /* later */ } }, 200); });
function renderSide() {
  CK_FALL.clear();
  const p = $('panelSide'); if (!p) return;
  if (S.settings.sideStyle !== 'text') {
    const ids = sideIds();
    let h = '';
    if (S.goto && S.fix) { const d = distNm(S.fix, S.goto), mv = (S.sog || 0) > 0.6, hrs = mv ? d / S.sog : NaN; h += '<button type="button" class="sd sd-dest" data-sact="nav"><small>Next destination</small><b>' + esc(S.goto.name) + '</b><span class="tnum">' + fmtDist(d) + (isFinite(hrs) ? ' · ETA ' + fmtClock(Date.now() + hrs * 3600000) : '') + '</span></button>'; }
    const W = Math.max(200, (p.clientWidth || 400) - 40), H = Math.max(300, (p.clientHeight || 700) - 150), cols = sideCols(ids.length, W, H);
    h += '<div class="side-g" data-n="' + ids.length + '" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">' + ids.map((id) => '<div class="sg">' + ckGauge(id) + '</div>').join('') + '</div>';
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
    L2(nwsGraphUrl({ lat: Number(lat), lon: Number(lon) }), 'NOAA point forecast', 'Graphical forecast for this location') +
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
// Marine first: a boat app suggests places you can reach by water. Streets, shops and
// houses are dropped unless the caller asks for everything (opts.all).
const SUG_MARINE_V = /^(marina|slipway|harbour|harbor|boatyard|ferry_terminal|pier|dock|anchorage|mooring|boat_rental|boat_sharing|boat_storage|yacht_club|sailing|lighthouse|breakwater|quay|wharf|beach|beach_resort|lock_gate|lock|bridge)$/;
const SUG_WATER_V = /^(bay|water|strait|cape|peninsula|island|islet|shoal|reef|river|stream|canal|coastline|lake|reservoir|lagoon|wetland|sound|cove|inlet|harbour|basin)$/;
const SUG_TOWN_V = /^(city|town|village|hamlet|suburb|neighbourhood|quarter|locality)$/;
const SUG_NAME = /\b(marina|harbou?r|yacht|sailing|boat|landing|wharf|docks?|pier|creek|cove|river|bay|island|point|light(house)?|inlet|sound|basin|anchorage|ramp|ferry|club|channel|narrows|shoal|beach|waterfront)\b/i;
function sugClass(pr) {
  const k = pr.osm_key || '', v = pr.osm_value || '', n = pr.name || '';
  if (k === 'seamark' || k === 'waterway' && v !== 'stream' || SUG_MARINE_V.test(v) || k === 'leisure' && /marina|slipway|beach/.test(v) || /\b(sailing|yacht|boat)\b/i.test(n) && /club|sports_centre|clubhouse/.test(v)) return 'marine';
  if (SUG_WATER_V.test(v) || k === 'natural' && /water|bay|beach|strait|cape|coastline/.test(v)) return 'water';
  if (k === 'place' && SUG_TOWN_V.test(v) || /^(city|district|locality)$/.test(pr.type || '')) return 'town';
  if (SUG_NAME.test(n)) return 'water';
  return 'land';
}
async function suggestPlaces(q, center, opts) {
  opts = opts || {};
  const c = center || searchCenter(), out = [];
  S.waypoints.forEach((w) => { const sc = fuzzyScore(q, w.name); if (sc) out.push({ name: w.name, sub: 'Your waypoint', lat: w.lat, lon: w.lon, type: 'place', score: sc + 2, wp: w }); });
  (searchResults || []).forEach((p) => { const sc = fuzzyScore(q, p.name); if (sc) out.push({ name: p.name, sub: PLACE_TYPES[p.type].label, lat: p.lat, lon: p.lon, type: p.type, score: sc + 1, place: p }); });
  // Keep local suggestions first, but reserve room for unbiased worldwide matches.
  async function photonMatches(worldwide) {
    const key = (opts.all ? 'all|' : '') + (worldwide ? 'world' : 'near|' + c.lat.toFixed(1) + ',' + c.lon.toFixed(1)) + '|' + q.trim().toLowerCase();
    if (sugCache.has(key)) return sugCache.get(key);
    const url = 'https://photon.komoot.io/api/?limit=' + (opts.all ? 8 : 15) + '&q=' + encodeURIComponent(q) + (worldwide ? '' : '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lon.toFixed(3));
    const response = await fetchT(url, 10000);
    if (!response.ok) throw new Error('Destination search ' + response.status);
    const j = await response.json();
    const matches = (j.features || []).filter((f) => f.geometry && Array.isArray(f.geometry.coordinates)).map((f) => {
      const pr = f.properties || {}, [lon, lat] = f.geometry.coordinates;
      const cls = sugClass(pr);
      return { name: pr.name || pr.street || 'Unnamed place', sub: [cls === 'town' ? 'town · find its marina or dock' : pr.osm_value && pr.osm_value.replace(/_/g, ' '), pr.city || pr.county, pr.state, pr.country].filter(Boolean).join(' · '), lat, lon, type: /marina/.test(pr.osm_value || '') ? 'marina' : 'place', score: cls === 'marine' ? 3 : cls === 'water' ? 2.5 : cls === 'town' ? 1.2 : 0.8, cls, worldwide };
    }).filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon) && (opts.all || o.cls !== 'land'));
    sugCache.set(key, matches);
    return matches;
  }
  const responses = await Promise.allSettled([photonMatches(false), photonMatches(true)]);
  const near = responses[0].status === 'fulfilled' ? responses[0].value : [];
  const world = responses[1].status === 'fulfilled' ? responses[1].value : [];
  const same = (a, b) => a.name === b.name && distNm(a, b) < 0.2;
  near.forEach((x) => { if (!out.some((o) => same(o, x))) out.push(Object.assign({}, x)); });
  out.forEach((o) => { o.d = distNm(c, o); });
  out.sort((a, b) => b.score - a.score || a.d - b.d);
  const chosen = out.slice(0, 4);
  // Worldwide provider relevance order is retained, so distant cities aren't buried.
  world.forEach((x) => { if (chosen.length < 8 && !chosen.some((o) => same(o, x))) chosen.push(Object.assign({}, x, { d: distNm(c, x) })); });
  out.forEach((x) => { if (chosen.length < 8 && !chosen.some((o) => same(o, x))) chosen.push(x); });
  return chosen;
}
function placeSugHtml(list, attr) {
  if (!list.length) return '<div class="sug-empty">No matches yet. Try a name with its state or country, or pick a spot on the chart.</div>';
  return list.map((o, i) => '<button type="button" class="sug" ' + attr + '="' + i + '"><b>' + esc(o.name) + '</b><span>' + esc((o.worldwide ? 'Worldwide · ' : '') + (o.sub || '')) + '</span><em class="tnum">' + fmtDist(o.d) + '</em></button>').join('');
}

/* ---------- home port ---------- */
if (!S.settings.homePort && !S.settings.homeSeeded) { S.settings.homePort = { name: 'Severn Sailing Association', lat: 38.97542, lon: -76.48041 }; S.settings.homeSeeded = 1; saveSettings(); }
const homePort = () => S.settings.homePort || null;
function openHomePort() {
  const hp = homePort();
  openSheet('<h3>Home port</h3><div class="sub">' + (hp ? 'Now: <b>' + esc(hp.name) + '</b>. ' : '') + 'Used as the start of routes when you plan from a computer, and where Find me goes without GPS.</div>' +
    '<div class="field"><input id="hpQ" type="search" autocomplete="off" placeholder="Marina, club or town…"></div><div id="hpSugs" class="sugs" hidden></div>' +
    '<div class="row-btns">' + (S.fix ? '<button class="btn" data-act="hphere">Where I am now</button>' : '') + '<button class="btn" data-act="hpcenter">Center of the chart</button><button class="btn ghost" data-act="close">Close</button></div>');
  setTimeout(() => { const q = $('hpQ'); if (q) q.focus(); }, 60);
}
function setHomePort(o) { S.settings.homePort = { name: o.name.replace(/\s*\(sample spot\)/, ''), lat: o.lat, lon: o.lon }; saveSettings(); closeSheet(); toast('Home port: ' + S.settings.homePort.name); try { renderNav(); } catch (e) { /* closed */ } }
let hpList = [], hpT = null;
sheet.addEventListener('input', (e) => {
  if (e.target.id !== 'hpQ') return; const q = e.target.value.trim(), box = $('hpSugs'); clearTimeout(hpT);
  if (q.length < 2) { box.hidden = true; return; } box.hidden = false; box.innerHTML = '<div class="sug-empty">Searching…</div>';
  hpT = setTimeout(async () => { hpList = await suggestPlaces(q, homePort() || searchCenter()); if ($('hpSugs')) $('hpSugs').innerHTML = placeSugHtml(hpList, 'data-hpsug'); }, 250);
});
sheet.addEventListener('click', (e) => {
  const g = e.target.closest('[data-hpsug]'); if (g) { setHomePort(hpList[+g.dataset.hpsug]); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'hphere' && S.fix) setHomePort({ name: 'Home port', lat: S.fix.lat, lon: S.fix.lon });
  if (b.dataset.act === 'hpcenter') { const c = map.getCenter(); setHomePort({ name: 'Home port', lat: c.lat, lon: c.lng }); }
});

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
    '<div class="nf-quick" style="margin-left:0">' + (S.fix && !st.length ? '<button type="button" class="btn small" data-act="tpboat">My boat</button>' : '') + (homePort() ? '<button type="button" class="btn small" data-act="tphome">' + esc(homePort().name.length > 22 ? 'Home port' : homePort().name) + '</button>' : '') + (st.length > 1 ? '<button type="button" class="btn small" data-act="tpback">Back to start</button>' : '') + '</div></div>';
  if (st.length > 1) {
    h += '<div class="tp-sum tnum"><b>' + fmtDist(L2.tot) + '</b> · ' + fmtDur(L2.hrs) + ' at ' + fmtSpeed(navSpeed()) + ' ' + SPEED_LBL[S.settings.speedUnit] + (L2.fuel != null ? ' · about ' + (Math.round(L2.fuel * 10) / 10) + ' gal' : '') + '</div>' +
      '<p class="hint" style="margin:4px 0 8px">Start and Edit on chart work out a path through charted water deep enough for your boat, from NOAA chart depths. Check it on the chart before you go.</p>' +
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
  if (act === 'tphome' && homePort()) { st.push(Object.assign({}, homePort())); saveTripDraft(); renderNav(); }
  if (act === 'tpboat' && S.fix) { st.push({ name: 'My boat', lat: S.fix.lat, lon: S.fix.lon }); saveTripDraft(); renderNav(); }
  if (act === 'tpback' && st.length) { st.push(Object.assign({}, st[0])); saveTripDraft(); renderNav(); }
  if (act === 'tpclear') { if (!armed(b, 'Tap again to clear')) return; S.trip2 = { name: '', stops: [] }; saveTripDraft(); renderNav(); }
  const name = S.trip2.name || (st.length ? st[0].name + ' to ' + st[st.length - 1].name : 'Trip');
  if (act === 'tpsave' && st.length > 1) { S.routes.push({ id: Date.now(), name, pts: st.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })) }); store.set('routes', S.routes); toast('Saved “' + name + '” in My trips'); renderNav(); }
  if (act === 'tpedit' && st.length > 1) { (async () => { RT.pts = await routeByWater(st.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name }))); store.set('routeDraft', RT.pts); routeMode(true); map.fitBounds(L.latLngBounds(RT.pts.map((q) => [q.lat, q.lon])).pad(0.15)); })(); return; }
  if (false) { RT.pts = st.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })); store.set('routeDraft', RT.pts); routeMode(true); map.fitBounds(L.latLngBounds(RT.pts.map((q) => [q.lat, q.lon])).pad(0.15)); }
  if (act === 'tpstart' && st.length > 1) { b.disabled = true; (async () => { const pts = await routeByWater(st.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name }))); let i = 0; if (S.fix && distNm(S.fix, pts[0]) < 0.3) i = 1; RT.pts = pts; drawRoute(); routeLeg(pts, i); map.fitBounds(L.latLngBounds(pts.map((q) => [q.lat, q.lon])).pad(0.15)); })(); }
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
    grp('On the water', menuTile('firstmate', 'mate', 'First mate' + (S.settings.mateName ? ' · ' + esc(S.settings.mateName) : ''), 'Ask anything, by voice or typing: “take me home”, “show me the rain”') + menuTile('search', 'search', 'Search', 'Marinas, fuel, ramps, bridges') +
      menuTile('closures', 'rules', 'Closures and safety zones', 'Fireworks zones, Coast Guard notices, your avoid areas') +
      menuTile('pro', 'rules', 'Captain\'s resources', 'Coast Pilot, notices, marine forecast') +
      menuTile('rules', 'rules', 'Rules of the Road', 'Search the Navigation Rules') +
      menuTile('safety', 'safety', 'Safety and education', 'VHF, safety check, float plan') +
      menuTile('month', 'log', new Date().toLocaleString([], { month: 'long' }) + ' on the water', 'Events, seasons and tips for how you boat') +
      menuTile('sailcoach', 'dash', 'Sailing coach', 'Sail plan, trim, which tack, best time to leave') +
      menuTile('loop', 'log', 'Great Loop advisor', 'The route leg by leg, your boat\'s limits, live notices, looper reports') +
      menuTile('fish', 'search', 'Fishing and wildlife', 'What is biting, baits, structure, what people see here')) +
    grp('App', menuTile('mapopts', 'layers', 'Map options', 'Chart, satellite, weather, colors') +
      menuTile('account', 'settings', 'Account and sync', window.__sbEmail ? 'Signed in as ' + esc(window.__sbEmail) : 'Sign in so your boats follow you everywhere') +
      menuTile('settings', 'settings', 'Settings', 'Units, coach, display, offline charts') +
      menuTile('arrange', 'layers', 'Arrange buttons', 'Drag the round buttons where you want them') +
      menuTile('gaugelook', 'dash', 'Gauge look', 'Chrome, brass, glass and more; analog or digital') +
      menuTile('tour', 'help', 'Take the tour', 'A one-minute walk around the app') +
      menuTile('help', 'help', 'Help', 'Ask how to do anything')) +
    '<div class="row-btns" style="margin-top:12px"><button type="button" class="btn" data-mact="backup">Back up my data</button><button type="button" class="btn" data-mact="restore">Restore from a backup</button></div><input type="file" id="restoreIn" accept=".json,application/json" hidden>' + '<button type="button" class="btn" data-mact="update" style="margin-top:8px">Get the latest version</button><p class="hint" style="margin-top:14px">Tideline prototype 0.6 · build 129. A navigation aid: keep a proper lookout and carry official charts.</p>';
}
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'restoreIn') return; const f = e.target.files && e.target.files[0]; if (!f) return;
  try { const o = JSON.parse(await f.text()); if (o.app !== 'Tideline' || !o.data) throw new Error('not a backup');
    if (!confirm('Replace the boats, routes and settings in this browser with the backup from ' + new Date(o.at).toLocaleString() + '?')) return;
    Object.entries(o.data).forEach(([k, v]) => localStorage.setItem(k, v)); toast('Restored. Reloading…'); setTimeout(() => location.reload(), 800);
  } catch (err) { toast('That file is not a Tideline backup'); }
});
$('panelMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mact]'); if (!b) return;
  const a = b.dataset.mact;
  if (a === 'firstmate') { openFirstMate(); return; }
  if (a === 'closures') { openCgNotices(); return; }
  if (a === 'rules') { setTab('search'); renderCats(); $('searchInput').value = 'Rules of the Road'; $('searchInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return; }
  if (a === 'cockpit' || a === 'dash') { setTab('chart'); setCockpit(true); return; }
  if (a === 'search') { $('searchPill').click(); return; }
  if (a === 'help') { openHelp(); return; }
  if (a === 'pro') { openResources(); return; }
  if (a === 'mapopts') { setTab('chart'); openLayersSheet(); return; }
  if (a === 'account') { openAccount(); return; }
  if (a === 'backup') { // everything the app keeps in this browser (boats, routes, tracks, spots, settings, logs, receipts); photos stay on the device
    const o = { app: 'Tideline', v: 1, at: new Date().toISOString(), data: {} };
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('tl.') && !/^tl\.(stations|bridges|mplaces|plTiles|weather|tide|encIds)/.test(k)) o.data[k] = localStorage.getItem(k); }
    download('tideline-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(o)); toast('Backup saved to your Downloads. Open it in another browser with Restore.', 5000); return; }
  if (a === 'restore') { $('restoreIn').click(); return; }
  if (a === 'update') { toast('Getting the latest version…'); (async () => { try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); const ks = await caches.keys(); await Promise.all(ks.filter((k) => k.startsWith('tl-app-')).map((k) => caches.delete(k))); } catch (e) { /* nothing cached */ } location.reload(); })(); return; }
  if (a === 'fish') { setTab('chart'); openFishWild(); return; }
  if (a === 'sailcoach') { openSailCoach(); return; }
  if (a === 'loop') { openLoop(); return; }
  if (a === 'tour') { startTour(0); return; }
  if (a === 'gaugelook') { setTab('chart'); openGaugeLook(); return; }
  if (a === 'arrange') { setTab('chart'); setTimeout(() => arrangeMode(true), 150); return; }
  if (a === 'month') { openThisMonth(); return; }
  setTab(a);
});

/* ---------- Navigate (Argo layout, savvy navvy details) ---------- */
function navSpeed() { return S.settings.navMode === 'sail' ? (S.settings.sailSpeed || 5) : S.settings.cruise; }
function renderNav() {
  const g = S.goto, st = S.settings;
  let h = '<div class="p-head"><div><div class="eyebrow">Navigate</div><h2>Where to?</h2></div></div>';
  if (g) h += '<div class="card nav-active"><div class="li"><div class="li-main"><b>Navigating to ' + esc(g.name) + '</b><span class="tnum">' + (S.fix ? fmtDist(distNm(S.fix, g)) + ' · ' + fmtBrg(bearing(S.fix, g)) + '°T' : 'Waiting for GPS') + '</span></div><div class="li-btns"><button class="btn small" data-act="navshow">Show</button><button class="btn small danger" data-act="navend">End</button></div></div></div>';
  h += planCard();
  h += '<div class="card"><h4>My trips</h4>' +
    (S.routes.length ? S.routes.slice().reverse().map((r) => { const d = r.pts.reduce((a, p, i) => (i ? a + distNm(r.pts[i - 1], p) : 0), 0);
      return '<div class="li"><div class="li-main"><b>' + esc(r.name) + '</b><span class="tnum">' + (r.pts.some((p) => p.name) ? esc(r.pts.map((p) => p.name || '·').join(' → ')) : r.pts.length + ' waypoints') + ' · ' + fmtDist(d) + '</span></div><div class="li-btns"><button class="btn small primary" data-act="navtrip" data-id="' + r.id + '">Plan</button><button class="btn small" data-act="navroute" data-id="' + r.id + '">Chart</button></div></div>'; }).join('') :
      '<div class="empty">Saved routes appear here. Plan a route and tap Save.</div>') +
    ((S.settings.useMode === 'fish' || S.spots.length) ? '<h4 style="margin-top:14px">My fishing spots</h4>' + (S.spots.length ? S.spots.slice().reverse().slice(0, 12).map((sp) => '<div class="li"><div class="li-main"><b>' + esc(sp.species || 'Spot') + '</b><span class="tnum">' + new Date(sp.t).toLocaleDateString([], { month: 'short', day: 'numeric' }) + (S.fix ? ' · ' + fmtDist(distNm(S.fix, sp)) : '') + ' · ' + esc(spotSummary(sp)) + '</span></div><div class="li-btns"><button class="btn small" data-spot="' + sp.id + '">Open</button></div></div>').join('') : '<div class="empty">Tap the fish button on the chart to save a spot with the tide, wind and water temperature.</div>') : '') +
    '<div class="row-btns" style="margin-top:8px"><button class="btn" data-act="navlog">Tracks and waypoints</button>' + (S.rec.on ? '<button class="btn danger" data-act="navrecstop">Stop recording</button>' : '<button class="btn" data-act="navrec">Record track</button>') + '</div></div>';
  $('panelNav').innerHTML = h;
}
/* ---------- route planner, Google Maps style: From (your boat or home port, or anything you type or tap), optional stops, To ---------- */
const boatLabel = () => S.settings.boatName || 'My boat';
S.plan = store.get('plan2', { from: null, via: [], to: null }); S.planEdit = null;
function savePlan() { store.set('plan2', S.plan); }
function planFrom() { if (S.plan.from) return S.plan.from; if (S.fix && Date.now() - (S.lastFixAt || 0) < 120000) return { name: boatLabel(), lat: S.fix.lat, lon: S.fix.lon, live: true }; const hp = homePort(); return hp ? Object.assign({ home: true }, hp) : null; }
/* the trip outlook: what the forecast says for the hours you'd be out, in plain words, and a better time if there is one */
function tripWx(stops, t0, dNm) {
  const w = S.weather; if (!w || !w.hours || !w.hours.length) return null;
  const hrs = dNm / Math.max(1, navSpeed()), t1 = t0 + hrs * 3600000, last = w.hours[w.hours.length - 1].t;
  if (t0 > last) return { beyond: true, last };
  let maxW = 0, maxG = 0, thunder = false, rain = 0, n = 0;
  for (let t = t0; t <= t1 + 1; t += 1800000) { const sp = seriesAt(w.hours, t, 'spd'), gu = seriesAt(w.hours, t, 'gust'), cd = seriesAt(w.hours, t, 'code'), rn = seriesAt(w.hours, t, 'rain'); if (sp == null) continue; n++;
    maxW = Math.max(maxW, sp); maxG = Math.max(maxG, gu || sp); if (cd >= 95) thunder = true; if (rn) rain = Math.max(rain, rn); }
  if (!n) return { beyond: true, last };
  const al = (typeof ALR !== 'undefined' ? ALR.list : []).filter((a) => { const on = Date.parse(a.onset || a.effective || '') || 0, en = Date.parse(a.ends || a.expires || '') || Infinity; return on <= t1 && en >= t0; });
  const sca = al.find((a) => /small craft/i.test(a.event)), bad = al.find((a) => /gale|storm|hurricane|tropical|special marine|tornado|severe thunderstorm|hazardous seas/i.test(a.event));
  const end = stops[stops.length - 1], dark = typeof sunElev === 'function' && sunElev(end.lat, end.lon, t1) < -4, darkStart = typeof sunElev === 'function' && sunElev(stops[0].lat, stops[0].lon, t0) < -4;
  const sail = S.settings.navMode === 'sail';
  let level = 'go', words = [];
  if (bad || thunder || maxG >= 30) { level = 'no'; words.push(bad ? bad.event + ' in effect then' : thunder ? 'thunderstorms in the forecast' : 'gusts to ' + Math.round(speedOut(maxG)) + ' ' + SPEED_LBL[S.settings.speedUnit]); }
  else if (sca || maxG >= 22 || maxW >= 17 || (sail && maxW < 5)) { level = 'care'; if (sca) words.push('Small Craft Advisory' + (hrs < 1.6 ? ', but it is a short run (' + fmtDur(hrs) + ')' : '')); if (maxG >= 22) words.push('gusts to ' + Math.round(speedOut(maxG))); if (sail && maxW < 5) words.push('very light wind: expect to motor'); }
  if (rain > 0.5 && level === 'go') words.push('some rain');
  if (dark) words.push('arrives after dark (' + fmtClock(t1) + ')'); else if (darkStart) words.push('leaves before daylight');
  return { level, words, maxW, maxG, t1, hrs, sca, bad, thunder, dark };
}
function planOutlookHtml(stops, t0, dNm) {
  const r = tripWx(stops, t0, dNm);
  if (!r) return '<p class="hint">The trip forecast appears once the weather has loaded.</p>';
  if (r.beyond) return '<div class="pl-wx care"><b>Too far ahead for the forecast</b><span>The hourly forecast runs to ' + new Date(r.last).toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtClock(r.last) + '. Check back closer to the day.</span></div>';
  const head = r.level === 'no' ? 'Don\'t go then' : r.level === 'care' ? 'Go with care' : 'Good weather window';
  let h = '<div class="pl-wx ' + r.level + '"><b>' + head + '</b><span>Wind ' + Math.round(speedOut(r.maxW)) + ', gusts ' + Math.round(speedOut(r.maxG)) + ' ' + SPEED_LBL[S.settings.speedUnit] + ' while you\'re out · arrive about ' + fmtClock(r.t1) + (r.words.length ? ' · ' + esc(r.words.join(' · ')) : '') + '</span></div>';
  // a better time in the next 48 h of daylight?
  if (r.level !== 'go') {
    const score = (x) => !x || x.beyond ? 999 : (x.level === 'no' ? 100 : x.level === 'care' ? 30 : 0) + x.maxG + (x.dark ? 15 : 0);
    let best = null, bs = score(r) - 8;
    for (let k = 1; k <= 48; k++) { const t = Math.ceil(Date.now() / 3600000) * 3600000 + k * 3600000; if (typeof sunElev === 'function' && sunElev(stops[0].lat, stops[0].lon, t) < 3) continue; const x = tripWx(stops, t, dNm); const sc = score(x); if (sc < bs) { bs = sc; best = { t, x }; } }
    if (best) h += '<button type="button" class="pl-best" data-plbest="' + best.t + '">Better: leave ' + new Date(best.t).toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtClock(best.t) + ' · gusts ' + Math.round(speedOut(best.x.maxG)) + (best.x.level === 'go' ? ', good window' : '') + '</button>';
  }
  return h + '<p class="hint" style="margin:4px 0 0">From the hourly forecast and NWS marine alerts along the way. A guide, not a promise: check the sky before you go.</p>';
}
function planCard() {
  const f = planFrom(), t = S.plan.to, ed = S.planEdit, st = S.settings, need = fmtLen(wrNeedM() / 0.3048);
  const field = (k, ph) => '<input id="plQ" type="search" autocomplete="off" enterkeyhint="search" data-for="' + k + '" placeholder="' + ph + '">';
  const chips = (k) => '<div class="pl-chips">' + (S.fix ? '<button type="button" class="chip-b" data-plq="' + k + ':boat">⦿ ' + esc(boatLabel()) + '</button>' : '') + (homePort() ? '<button type="button" class="chip-b" data-plq="' + k + ':home">⌂ ' + esc(homePort().name.length > 24 ? 'Home port' : homePort().name) + '</button>' : '<button type="button" class="chip-b" data-act="navhome">⌂ Set home port</button>') + '<button type="button" class="chip-b" data-plq="' + k + ':map">◎ Pick on the chart</button>' + S.waypoints.slice(-3).reverse().map((w) => '<button type="button" class="chip-b" data-plwp="' + k + ':' + w.id + '">' + esc(w.name) + '</button>').join('') + '</div>';
  let h = '<div class="card plan"><div class="pl-line">';
  h += '<div class="pl-row"><span class="nf-dot from"></span><div class="pl-f"><small>From</small>' + (ed === 'from' ? field('from', 'Start: marina, club, town…') : '<button type="button" class="pl-val" data-pl="from">' + (f ? esc(f.name) + (f.live ? ' <em>(GPS)</em>' : f.home ? ' <em>(home port)</em>' : '') : '<span class="pl-ph">Choose a start</span>') + '</button>') + '</div>' + (f && t ? '<button type="button" class="pl-swap" data-pl="swap" aria-label="Swap start and destination">⇅</button>' : '') + '</div>';
  if (ed === 'from') h += chips('from');
  S.plan.via.forEach((v, i) => { h += '<div class="pl-row via"><span class="nf-dot via"></span><div class="pl-f"><small>Stop ' + (i + 1) + '</small><b>' + esc(v.name) + '</b></div><button type="button" class="pl-x" data-plx="' + i + '" aria-label="Remove stop">×</button></div>'; });
  if (ed === 'via') h += '<div class="pl-row via"><span class="nf-dot via"></span><div class="pl-f"><small>Add a stop</small>' + field('via', 'Stop on the way…') + '</div></div>' + chips('via');
  h += '<div class="pl-row"><span class="nf-dot to"></span><div class="pl-f"><small>To</small>' + (ed === 'to' || !t ? field('to', 'Where to? marina, club, anchorage, town…') : '<button type="button" class="pl-val" data-pl="to">' + esc(t.name) + '</button>') + '</div>' + (t ? '<button type="button" class="pl-x" data-pl="clearto" aria-label="Clear destination">×</button>' : '') + '</div>';
  if (ed === 'to' || !t) h += chips('to');
  h += '</div><div id="plSugs" class="sugs" hidden></div>';
  if (ed !== 'via' && t) h += '<button type="button" class="pl-add" data-pl="via">+ Add a stop</button>';
  h += '<div class="set-row" style="margin-top:8px"><div class="sr-text"><b>Under</b></div></div>' + optSeg2('navMode', [['engine', 'Engine · ' + fmtSpeed(st.cruise) + ' ' + SPEED_LBL[st.speedUnit]], ['sail', 'Sail · ' + fmtSpeed(st.sailSpeed || 5) + ' ' + SPEED_LBL[st.speedUnit]]], st.navMode);
  const dep = S.plan.depart && S.plan.depart > Date.now() - 3600000 ? S.plan.depart : null;
  h += '<div class="pl-when"><small>Leave</small><div class="seg pl-whenseg"><button type="button" data-plwhen="now" class="' + (dep ? '' : 'on') + '">Now</button><button type="button" data-plwhen="pick" class="' + (dep ? 'on' : '') + '">' + (dep ? new Date(dep).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmtClock(dep) : 'Pick a day and time') + '</button></div>' +
    '<input id="plDepart" type="datetime-local" class="pl-dt" value="' + toLocalInput(dep || Math.ceil(Date.now() / 1800000) * 1800000) + '" min="' + toLocalInput(Date.now() - 600000) + '"' + (S.plWhenOpen ? '' : ' hidden') + '></div>';
  if (f && t) { const d = [f].concat(S.plan.via, [t]).reduce((a, p, i, arr) => i ? a + distNm(arr[i - 1], p) : 0, 0); h += '<div class="tp-sum tnum"><b>' + fmtDist(d) + '</b> straight-line · about ' + fmtDur(d / navSpeed()) + '</div><div id="plOutlook">' + planOutlookHtml([f].concat(S.plan.via, [t]), dep || Date.now(), d) + '</div>'; }
  h += '<div class="row-btns" style="margin-top:10px"><button class="btn primary" data-pl="route"' + (f && t ? '' : ' disabled') + '>Route by water</button><button class="btn" data-pl="direct"' + (t ? '' : ' disabled') + '>Go straight there</button>' + (f && t ? '<button class="btn" data-pl="save">Save</button>' : '') + '</div>';
  h += '<p class="hint" style="margin:8px 0 0">Route by water keeps to charted water at least ' + need + ' deep for your boat, under bridges you fit and around closed areas. You can drag the route on the chart afterwards.</p></div>';
  return h;
}
let plList = [], plT = null, plSeq = 0;
function planSet(k, o) { S.plAll = false; if (k === 'from') S.plan.from = o; else if (k === 'to') S.plan.to = o; else S.plan.via.push(o); S.planEdit = null; savePlan(); renderNav(); }
$('panelNav').addEventListener('input', (e) => {
  if (e.target.id !== 'plQ') return; const q = e.target.value.trim(), box = $('plSugs'); clearTimeout(plT);
  if (q.length < 2) { box.hidden = true; return; } box.hidden = false; box.innerHTML = '<div class="sug-empty">Searching…</div>';
  plT = setTimeout(async () => { const seq = ++plSeq; let list = []; try { list = await suggestPlaces(q, planFrom() || searchCenter(), { all: S.plAll }); } catch (err) { list = []; }
    const kn = FM_KNOWN.filter(([re]) => re.test(q.toLowerCase())).map(([, n, la, lo]) => ({ name: n, lat: la, lon: lo, sub: 'Chesapeake', d: planFrom() ? distNm(planFrom(), { lat: la, lon: lo }) : null }));
    list = kn.concat(list.filter((x) => !kn.some((k) => k.name === x.name))); if (seq !== plSeq || !$('plSugs')) return; plList = list; $('plSugs').innerHTML = (list.length ? placeSugHtml(list, 'data-plsug') : '<div class="sug-empty">No water destinations found. Try a marina, creek, harbor or town, or pick on the chart.</div>') + (S.plAll ? '' : '<button type="button" class="sug all" data-plall="1"><b>Include places on land</b><span>Shops, streets, landmarks (you\'ll need a dock nearby)</span></button>'); }, 250);
});
$('panelNav').addEventListener('change', (e) => { if (e.target.id !== 'plDepart') return; const t = Date.parse(e.target.value); if (t) { S.plan.depart = t; S.plWhenOpen = false; RT.depart = t; savePlan(); renderNav(); } });
$('panelNav').addEventListener('keydown', (e) => { if (e.target.id === 'plQ' && e.key === 'Enter' && plList[0]) { e.preventDefault(); planSet(e.target.dataset.for, { name: plList[0].name.replace(/\s*\(sample spot\)/, ''), lat: plList[0].lat, lon: plList[0].lon }); } });
$('panelNav').addEventListener('click', async (e) => {
  const wh = e.target.closest('button[data-plwhen]'); if (wh) { if (wh.dataset.plwhen === 'now') { S.plan.depart = null; S.plWhenOpen = false; savePlan(); renderNav(); } else { S.plWhenOpen = true; renderNav(); const i = $('plDepart'); if (i) { i.hidden = false; try { i.showPicker && i.showPicker(); } catch (err) { i.focus(); } } } return; }
  const bw = e.target.closest('button[data-plbest]'); if (bw) { S.plan.depart = +bw.dataset.plbest; S.plWhenOpen = false; savePlan(); renderNav(); return; }
  if (e.target.closest('button[data-plall]')) { S.plAll = true; const q = $('plQ'); if (q) q.dispatchEvent(new Event('input', { bubbles: true })); return; }
  const g = e.target.closest('[data-plsug]'); if (g) { const o = plList[+g.dataset.plsug], k = $('plQ') ? $('plQ').dataset.for : 'to'; planSet(k, { name: o.name.replace(/\s*\(sample spot\)/, ''), lat: o.lat, lon: o.lon }); return; }
  const q = e.target.closest('[data-plq]'); if (q) { const [k, what] = q.dataset.plq.split(':');
    if (what === 'boat' && S.fix) planSet(k, k === 'from' ? null : { name: boatLabel(), lat: S.fix.lat, lon: S.fix.lon });
    if (what === 'home' && homePort()) planSet(k, Object.assign({ home: true }, homePort()));
    if (what === 'map') { S.planPick = k; setTab('chart'); toast('Tap the chart where you want ' + (k === 'from' ? 'to start' : k === 'to' ? 'to go' : 'to stop') + '.', 4000); }
    if (k === 'from' && what === 'boat') { S.plan.from = null; savePlan(); renderNav(); }
    return; }
  const w = e.target.closest('[data-plwp]'); if (w) { const [k, id] = w.dataset.plwp.split(':'), wp = S.waypoints.find((x) => String(x.id) === id); if (wp) planSet(k, { name: wp.name, lat: wp.lat, lon: wp.lon }); return; }
  const x = e.target.closest('[data-plx]'); if (x) { S.plan.via.splice(+x.dataset.plx, 1); savePlan(); renderNav(); return; }
  const b = e.target.closest('[data-pl]'); if (!b) return; const a = b.dataset.pl;
  if (a === 'from' || a === 'to' || a === 'via') { S.planEdit = a; renderNav(); setTimeout(() => { const i = $('plQ'); if (i) i.focus(); }, 40); return; }
  if (a === 'clearto') { S.plan.to = null; savePlan(); S.planEdit = 'to'; renderNav(); return; }
  if (a === 'swap') { const f = planFrom(), t = S.plan.to; S.plan.from = t; S.plan.to = f && { name: f.name, lat: f.lat, lon: f.lon }; S.plan.via.reverse(); savePlan(); renderNav(); return; }
  const f = planFrom(), t = S.plan.to;
  if (a === 'direct' && t) { setGoto(t.name, t.lat, t.lon); setTab('chart'); return; }
  if (a === 'save' && f && t) { const stops = [f].concat(S.plan.via, [t]); S.routes.push({ id: Date.now(), name: f.name + ' to ' + t.name, pts: stops.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })) }); store.set('routes', S.routes); toast('Saved in My trips'); renderNav(); return; }
  if (a === 'route' && f && t) {
    b.disabled = true; b.textContent = 'Finding the water route…';
    RT.depart = S.plan.depart && S.plan.depart > Date.now() ? S.plan.depart : Date.now();
    const pts = await routeByWater([f].concat(S.plan.via, [t]).map((p) => ({ lat: p.lat, lon: p.lon, name: p.name })));
    RT.pts = pts; store.set('routeDraft', RT.pts); setTab('chart'); routeMode(true); map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.15));
  }
});
function optSeg2(name, opts, cur) {
  return '<div class="seg" role="group">' + opts.map(([v, l]) => '<button type="button" data-nseg="' + name + '" data-val="' + v + '" class="' + (String(cur) === String(v) ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
}
$('panelNav').addEventListener('click', (e) => {
  const sg = e.target.closest('[data-nseg]'); if (sg) { S.settings[sg.dataset.nseg] = sg.dataset.val; saveSettings(); renderNav(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, dest = S.navDest || null;
  if (act === 'navpick') { setTab('chart'); toast('Press and hold the spot you want, then tap Navigate to.', 4000); return; }
  if (act === 'navhome') { openHomePort(); return; }
  if (act === 'navgo') {
    const from = S.fix || homePort();
    if (dest) { S.navDest = null; if (from && distNm(from, dest) > 0.3) { (async () => { const pts = await routeByWater([{ lat: from.lat, lon: from.lon, name: S.fix ? 'Start' : from.name }, { lat: dest.lat, lon: dest.lon, name: dest.name }]); if (pts.length > 2) routeLeg(pts, 1); else setGoto(dest.name, dest.lat, dest.lon); })(); } else setGoto(dest.name, dest.lat, dest.lon); return; }
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
  root.toggleAttribute('data-night', th === 'night'); root.toggleAttribute('data-dusk', th === 'dusk'); if (typeof SH !== 'undefined') { SH.drawnKey = ''; setTimeout(drawShallow, 50); } if (typeof NV !== 'undefined') { NV.key = ''; setTimeout(drawNavaids, 60); }
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
  try { return aisShipIcon(t, level); } catch (e) { /* ship markers not set up yet: plain arrow below */ } // ship-shaped, sized by length, coloured by type
  const col = level === 'danger' ? '#D64545' : level === 'caution' ? '#E8952B' : t.type === 'ship' ? '#5B6B7A' : t.type === 'sail' ? '#6B4FBB' : '#3D7D9C';
  const big = t.type === 'ship';
  const path = big ? 'M12 1 L17 7 L17 25 L7 25 L7 7 Z' : 'M12 3 L18 23 L12 19 L6 23 Z', age = Date.now() - (t.seen || Date.now()), op = age > 30 * 60000 ? 0.45 : age > 10 * 60000 ? 0.7 : 1;
  if ((t.sog || 0) < 0.5 && level !== 'danger' && level !== 'caution') // moored or anchored: a dot, like other AIS maps
    return L.divIcon({ className: 'ais-icon', iconSize: [14, 14], iconAnchor: [7, 7], html: '<svg width="14" height="14" viewBox="0 0 14 14" style="opacity:' + op + '"><circle cx="7" cy="7" r="5" fill="' + col + '" stroke="#fff" stroke-width="1.6"/></svg>' });
  return L.divIcon({ className: 'ais-icon', iconSize: [24, 26], iconAnchor: [12, 13], html: '<svg width="24" height="26" viewBox="0 0 24 26"><g transform="rotate(' + ((t.cog || 0) + mapRot()) + ' 12 13)"><path d="' + path + '" fill="' + col + '" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></g></svg>' });
}
function updateAis() {
  aisLayer.clearLayers();
  if (S.settings.aisShow === false || (!S.fix && !ais.size)) { $('coachCard').hidden = true; return; }
  let worst = null;
  ais.forEach((t) => {
    const r = S.fix ? evaluate(t) : null; t.eval = r;
    if (r && r.level !== 'none') { const score = (r.level === 'danger' ? 0 : 10) + r.tcpa * 10; if (!worst || score < worst.score) worst = { r, score }; }
    const ic = aisIcon(t, r ? r.level : 'none'), m = L.marker([t.lat, t.lon], { icon: ic, zIndexOffset: 800 + (r && r.level !== 'none' ? 300 : 0) + (S.aisFollow === t.id ? 200 : 0), keyboard: false, bubblingMouseEvents: false });
    const z = map.getZoom(), named = t.name && !/^MMSI /.test(t.name), showName = S.settings.aisNames === true && (z >= 14 || (z >= 12 && ((t.sog || 0) >= 1 || t.type === 'ship' || (t.len || 0) >= 60)) || (r && r.level !== 'none'));
    if (showName) m.bindTooltip(esc(t.name || 'AIS target'), { permanent: true, direction: 'right', offset: [ic.options.labelDx != null ? ic.options.labelDx : 10, 0], className: 'ais-label' + (named ? '' : ' unnamed'), interactive: false });
    m.on('click', (ev) => { S.aisTapAt = Date.now(); if (ev && ev.originalEvent) L.DomEvent.stop(ev.originalEvent); openAisSheet(t); }); // a tap on a ship opens the ship, never the spot card
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
  if (S.aisFollow && typeof aisFollowTick === 'function') aisFollowTick();
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
function openAisList() {
  const targets = [...ais.values()].filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lon)).sort((a, b) => S.fix ? distNm(S.fix, a) - distNm(S.fix, b) : (b.seen || 0) - (a.seen || 0));
  let h = '<h3>AIS targets</h3><p class="sub">' + (S.settings.sim ? 'SIMULATED TRAFFIC · demo GPS, not real boats.' : S.settings.aisRelay ? (AISS.err ? esc(AISS.err) : AISS.n ? 'Receiving AIS reports. Reports can be delayed or missing.' : 'Waiting for AIS reports. Availability depends on feed coverage and connection limits.') : 'No AIS feed configured. Turning on AIS visibility does not supply live traffic.') + '</p>';
  if (!targets.length) h += '<p class="sub">No targets received. Try the demo, or configure your relay in Map options.</p>';
  h += targets.map((t) => '<div class="li"><div class="li-main"><b>' + esc(t.name || 'Unnamed vessel') + '</b><span>' + (t.demo ? 'Demo · ' : '') + (S.fix ? fmtDist(distNm(S.fix, t)) + ' · ' : '') + fmtSpeed(t.sog) + ' · report ' + Math.max(0, Math.round((Date.now() - (t.seen || Date.now())) / 1000)) + ' s ago</span></div><button class="btn small" data-aisid="' + esc(t.id) + '">Details</button></div>').join('');
  h += '<div class="row-btns"><button class="btn" data-act="aislist">Refresh</button><button class="btn" data-act="aispreview">Try AIS demo</button>' + (S.settings.sim ? '<button class="btn" data-act="aisdemostop">Return to real GPS</button>' : '') + '<button class="btn ghost" data-act="close">Close</button></div>';
  openSheet(h);
}
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'aislist') openAisList();
  if (b.dataset.act === 'aispreview' || b.dataset.act === 'aisdemostop') {
    if (S.anchor || S.rec.on) { toast('Stop anchor watch and track recording before changing GPS to or from demo mode.', 5000); return; }
    const on = b.dataset.act === 'aispreview';
    if (on && !S.settings.sim && !armed(b, 'Tap again: uses fake GPS')) return;
    S.settings.sim = on; S.settings.aisShow = true; saveSettings(); aissClose(); ais.clear(); demoAisAt = 0;
    S.fix = null; S.sog = null; S.cog = null;
    if (on) { sim.i = 0; sim.pos = null; }
    startGPS();
    if (on) { map.setView([SIM_ROUTE[0][0], SIM_ROUTE[0][1]], 13); setFollow(true); simAis(); updateAis(); }
    else { updateAis(); aissConnect(true); }
    openAisList(); toast(on ? 'Demo GPS and simulated AIS. Tap Details to inspect a target.' : 'Demo stopped. Waiting for real GPS.', 5000);
  }
});
function openAisSheet(t) {
  const r = t.eval || evaluate(t);
  let h = shipSheetTop(t); // name, type, flag, photo, particulars and links (below)
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
    } else h += '<p class="sub">No close pass predicted from the current AIS reports. Keep a lookout; reports may be incomplete.</p>';
  }
  h += '<div class="row-btns" style="margin-top:6px"><button class="btn ghost" data-act="close">Close</button></div><p class="disclaim">' + DISCLAIMER + '</p>';
  openSheet(h); S.aisSheetId = t.id; shipWiki(t);
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
  ais.set(t.id, Object.assign(prev || {}, t, { hist, seen: Date.now(), cached: false }));
}
/* ---------- live AIS over the internet (aisstream.io, free key): ships and AIS-equipped boats around the chart ---------- */
const AISS = { ws: null, center: null, at: 0, retry: 0, timer: null, n: 0, err: '' };
function aisShipType(code) { const c = +code || 0; if (c === 36) return 'sail'; if (c === 37) return 'power'; if (c === 30) return 'fishing'; if (c === 31 || c === 32 || c === 52) return 'tug'; if (c >= 60 && c < 70) return 'passenger'; if (c >= 70 && c < 90) return 'ship'; return c ? 'other' : null; }
function aissConnect(force) {
  const relay = (S.settings.aisRelay || '').trim();
  if (!relay || S.settings.aisShow === false || S.settings.sim) { aissClose(); return; }
  const c = S.fix || refPos(); if (!c) return;
  if (!force && AISS.ws && AISS.ws.readyState <= 1 && AISS.center && distNm(AISS.center, c) < 8) return;
  aissClose(); AISS.center = { lat: c.lat, lon: c.lon };
  // aisstream.io does not allow browsers to connect directly, so the app talks to a tiny relay you run (see tools/ais-relay in the repo)
  AISS.box = aisBox(); let ws; try { ws = new WebSocket(relay.replace(/^http/, 'ws').replace(/\/$/, '') + '/?bbox=' + AISS.box.join(',')); } catch (e) { AISS.err = 'That relay address is not valid'; return; }
  AISS.ws = ws;
  ws.onopen = () => { AISS.retry = 0; AISS.err = ''; };
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch (e) { return; }
    if (m.error) { AISS.err = m.error; return; }
    const md = m.MetaData || {}, id = 'ais-' + md.MMSI; if (!md.MMSI) return;
    const msg = (m.Message || {})[m.MessageType] || {}, prev = ais.get(id) || { id, mmsi: md.MMSI };
    const t = Object.assign({}, prev, { name: (md.ShipName || prev.name || '').trim() || 'MMSI ' + md.MMSI });
    const position = /Position/.test(m.MessageType);
    if (position) {
      const lat = msg.Latitude ?? md.Latitude ?? md.latitude;
      const lon = msg.Longitude ?? md.Longitude ?? md.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      t.lat = lat; t.lon = lon;
      t.sog = msg.Sog != null && msg.Sog >= 0 && msg.Sog < 102.3 ? msg.Sog : 0;
      t.cog = msg.Cog != null && msg.Cog >= 0 && msg.Cog < 360 ? msg.Cog : (msg.TrueHeading >= 0 && msg.TrueHeading < 360 ? msg.TrueHeading : 0);
      if (msg.TrueHeading >= 0 && msg.TrueHeading < 360) t.hdg = msg.TrueHeading;
      if (msg.NavigationalStatus != null) t.status = msg.NavigationalStatus;
      t.live = true;
    }
    if (m.MessageType === 'ShipStaticData') { const d = msg.Dimension || {}; t.type = aisShipType(msg.Type) || t.type; if (msg.Type) t.typeCode = +msg.Type; if (msg.ImoNumber) t.imo = msg.ImoNumber; if (msg.Eta) t.eta = aisEtaText(msg.Eta) || t.eta; if (d.A != null) { t.len = (d.A || 0) + (d.B || 0); t.beam = (d.C || 0) + (d.D || 0); } if (msg.MaximumStaticDraught) t.draft = msg.MaximumStaticDraught; if (msg.CallSign) t.callsign = msg.CallSign.trim(); if (msg.Destination) t.dest = msg.Destination.trim(); }
    if (m.MessageType === 'StaticDataReport') { const rb = msg.ReportB || {}; if (rb.ShipType) { t.type = aisShipType(rb.ShipType) || t.type; t.typeCode = +rb.ShipType; } if (rb.CallSign) t.callsign = rb.CallSign.trim(); }
    if (t.lat == null) { ais.set(id, Object.assign(t, { seen: prev.seen || 0, hist: prev.hist || [] })); return; }
    if (!t.type) t.type = 'other';
    if (position) { aisUpsert(t); AISS.n++; }
    else ais.set(id, t); // Static details must not refresh an old vessel position.
    if (!AISS.timer) AISS.timer = setTimeout(() => { AISS.timer = null; updateAis(); }, 700);
  };
  ws.onerror = () => { AISS.err = 'Could not connect to the AIS relay. Check the network or feed connection limit.'; };
  ws.onclose = () => { if (AISS.ws !== ws) return; AISS.ws = null; if ((S.settings.aisRelay || '') && AISS.retry < 6) setTimeout(() => aissConnect(true), Math.min(60000, 3000 * 2 ** AISS.retry++)); };
}
function aissClose() { clearTimeout(AISS.timer); AISS.timer = null; const w = AISS.ws; AISS.ws = null; if (w) try { w.close(); } catch (e) { /* closed */ } }
// boats at a mooring report only every few minutes and are often out of range of the receivers, so keep the last place we heard
// each one: moving boats for 15 minutes, boats sitting still for 3 hours. Kept on the phone so they show at once next time.
const AIS_KEEP = (t) => ((t.sog || 0) >= 1 ? 15 : 180) * 60000;
setInterval(() => { const now = Date.now(); let ch = false; ais.forEach((t, id) => { if (t.live && now - (t.seen || 0) > AIS_KEEP(t)) { ais.delete(id); ch = true; } }); if (ch) updateAis(); aisSave(); }, 60000);
function aisSave() { const now = Date.now(), out = []; ais.forEach((t) => { if (t.live && t.lat != null && now - (t.seen || 0) < AIS_KEEP(t)) out.push({ id: t.id, mmsi: t.mmsi, name: t.name, lat: t.lat, lon: t.lon, sog: t.sog, cog: t.cog, hdg: t.hdg, type: t.type, len: t.len, beam: t.beam, status: t.status, seen: t.seen, callsign: t.callsign, typeCode: t.typeCode, imo: t.imo, dest: t.dest, eta: t.eta, draft: t.draft }); }); store.set('aisCache', out.slice(-1500)); }
(() => { const now = Date.now(); (store.get('aisCache', []) || []).forEach((t) => { if (t && t.id && now - (t.seen || 0) < AIS_KEEP(t) && !ais.has(t.id)) ais.set(t.id, Object.assign(t, { live: true, cached: true, hist: [] })); }); setTimeout(() => { try { updateAis(); renderAisBtn(); } catch (e) { /* later */ } }, 1500); })();
// follow the chart: when you look somewhere else, ask the relay for boats there too (up to about 3° across)
function aisBox() { const b = map.getBounds().pad(0.3), f = S.fix; let s2 = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast(); if (f) { s2 = Math.min(s2, f.lat - 0.2); n = Math.max(n, f.lat + 0.2); w = Math.min(w, f.lon - 0.25); e = Math.max(e, f.lon + 0.25); } const c = [(s2 + n) / 2, (w + e) / 2], hl = Math.min(1.45, (n - s2) / 2), hw = Math.min(1.45, (e - w) / 2); return [c[0] - hl, c[1] - hw, c[0] + hl, c[1] + hw].map((v) => +v.toFixed(3)); }
map.on('moveend', () => {
  if (!S.settings.aisRelay || S.settings.aisShow === false) return; clearTimeout(AISS.mt);
  AISS.mt = setTimeout(() => { const bb = aisBox(), cur = AISS.box; if (cur && bb[0] >= cur[0] && bb[1] >= cur[1] && bb[2] <= cur[2] && bb[3] <= cur[3]) return; AISS.box = bb;
    if (AISS.ws && AISS.ws.readyState === 1) { try { AISS.ws.send(JSON.stringify({ bbox: bb })); } catch (e) { /* reconnect below */ } } else aissConnect(true); }, 1500);
});
setTimeout(() => aissConnect(true), 2500);

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
  aisUpsert({ id: 'demo-ship', demo: true, name: 'DEMO CARRIER', type: 'ship', typeCode: 70, status: 0, len: 190, beam: 32, draft: 10.4, callsign: 'DEMO2', dest: 'BALTIMORE', eta: 'Today 16:30', lat: shipStart.lat, lon: shipStart.lon, sog: 11, cog: (cog + 180) % 360 });
  const pStart = destination(destination(f, (cog + 180) % 360, 0.7), (cog + 90) % 360, 0.04);
  aisUpsert({ id: 'demo-power', demo: true, name: 'REEL TIME', type: 'power', status: 0, len: 9, beam: 3, draft: 0.8, lat: pStart.lat, lon: pStart.lon, sog: 17, cog });
  const tStart = destination(destination(f, cog, 1.6), (cog + 270) % 360, 1.1);
  aisUpsert({ id: 'demo-tug', demo: true, name: 'DEMO TUG', type: 'tug', typeCode: 52, status: 0, len: 30, beam: 10, draft: 4.2, callsign: 'DEMO4', dest: 'POPLAR IS', lat: tStart.lat, lon: tStart.lon, sog: 6, cog: (cog + 200) % 360, hdg: (cog + 200) % 360 });
}
function renderModeChip() {
  const c = $('modeChip');
  if (S.settings.boatType !== 'sail') { c.hidden = true; return; }
  c.hidden = false; c.innerHTML = '<span class="fi-ic">' + (S.settings.underSail ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v14H5zM14 6c3 3 4 7 4 11h-4zM3 19h18l-2 2H5z"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15h18l-3 5H6zM8 15V9h6l3 6"/></svg>') + '</span><b>' + (S.settings.underSail ? 'Sail' : 'Motor') + '</b>';
  c.dataset.tip = (S.settings.underSail ? 'Under sail' : 'Motoring') + '. Tap to switch: it changes which Rules apply to you.';
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
function saveFleet() { const cur = S.fleet.boats.find((x) => x.id === S.fleet.active); if (cur) { cur.boat = S.boat; if (S.maint) cur.maint = S.maint; cur.set = {}; BOAT_SET_KEYS.forEach((k) => { cur.set[k] = S.settings[k]; }); } try { store.set('fleet', S.fleet); } catch (e) { toast('Storage is full: try smaller boat photos.'); } }
function switchBoat(id) {
  equipmentEdit = null; rcOpen = false;
  saveFleet();
  const nb = S.fleet.boats.find((x) => x.id === id); if (!nb) return;
  S.fleet.active = id; S.boat = Object.assign({}, BOAT_DEFAULT, nb.boat || {}); Object.assign(S.settings, nb.set || {}); S.maint = Object.assign({ items: [], log: [], receipts: [] }, nb.maint || {}); saveMaint();
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
// setup checklist: tap a row to jump straight to that field
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-sufield]'); if (!r) return;
  const f = r.dataset.sufield;
  if (f === 'home') { openHomePort(); return; }
  if (f === 'bAir') { openAirDraftEditor(); return; }
  boatEditing = true; renderBoat();
  setTimeout(() => { const el = $(f); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus(); el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 1600); } }, 60);
});
function openAirDraftEditor() {
  const input = $('bAir'), value = input ? input.value : S.boat.airDraftFt ? String(Math.round(ftToLen(S.boat.airDraftFt) * 100) / 100) : '';
  const check = $('bAirOk'), verified = check ? check.checked : !!S.boat.airVerified;
  openSheet('<h3>Air draft</h3><p class="sub">Height above the water to the highest point, including antennas and instruments. A model lookup supplies an estimate; confirm it for your actual rig.</p><div class="field"><label for="airDraftEdit">Air draft (' + lenUnit() + ')</label><input id="airDraftEdit" type="text" inputmode="decimal" value="' + esc(value) + '"></div><label class="air-ok"><input type="checkbox" id="airDraftVerified"' + (verified ? ' checked' : '') + '> Verified by measurement or the builder for my actual rig</label><div class="row-btns"><button class="btn primary" data-act="saveairdraft" data-boat="' + S.fleet.active + '">Save air draft</button><button class="btn ghost" data-act="close">Cancel</button></div>');
  setTimeout(() => { const el = $('airDraftEdit'); if (el) el.focus(); }, 60);
}
sheet.addEventListener('input', (e) => { if (e.target.id === 'airDraftEdit' && $('airDraftVerified')) $('airDraftVerified').checked = false; });
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="saveairdraft"]'); if (!b) return;
  if (String(S.fleet.active) !== b.dataset.boat) { toast('Boat changed. Reopen air draft for the correct boat.'); return; }
  const raw = $('airDraftEdit').value.trim().replace(',', '.');
  const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!(value > 0) || !Number.isFinite(value)) { toast('Enter a positive air draft in ' + lenUnit()); $('airDraftEdit').focus(); return; }
  S.boat.airDraftFt = lenToFt(value); S.boat.airVerified = $('airDraftVerified').checked;
  if ($('bAir')) $('bAir').value = String(value);
  if ($('bAirOk')) $('bAirOk').checked = S.boat.airVerified;
  saveBoat(); closeSheet(); if (!boatEditing) renderBoat();
  toast(S.boat.airVerified ? 'Air draft saved and verified.' : 'Air draft saved as an estimate. Verify it for your actual boat.', 5000);
});
function resizePhoto(file, maxPx, q) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const max = maxPx || 480, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', q || 0.78));
    };
    img.onerror = reject; img.src = url;
  });
}
const lenM = () => S.settings.boatLen * 0.3048;
/* a few well-known boats, from the builders' published specs; anything filled in is shown so the owner can check it */
const BOAT_DB = [
  { make: 'Catalina', model: '22', loa: 21.5, lwl: 19.33, beam: 7.67, disp: 2490, type: 'sail' },
  { make: 'Catalina', model: '27', loa: 26.83, lwl: 21.75, beam: 8.83, draft: 4.0, disp: 6850, ballast: 2700, type: 'sail', air: 38, years: '1971–1991',
    src: 'Good Old Boat sail data and Wikipedia', airNote: 'owners report about 38 ft for the standard rig, waterline to masthead; add antennas and the wind instrument',
    variants: { rig: [{ id: 'std', label: 'Standard rig', air: 38, note: 'I 34.5 ft, P 28.7 ft' }, { id: 'tall', label: 'Tall rig (TM)', air: 40, note: 'mast about 1.5–2 ft taller: I 36 ft, P 29.7 ft' }],
      keel: [{ id: 'fin', label: 'Fin keel', draft: 4.0 }, { id: 'shoal', label: 'Shoal or wing keel (SD)', draft: 3.0 }] } },
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
const OUTBOARD_MAKES = ['Yamaha', 'Mercury', 'Honda', 'Suzuki', 'Tohatsu', 'Evinrude', 'Johnson', 'Nissan', 'Force', 'British Seagull', 'Torqeedo', 'ePropulsion'];
function outboardMakeChoice(make) {
  const value = (make || '').trim();
  return OUTBOARD_MAKES.find((name) => name.toLowerCase() === value.toLowerCase()) || (value ? 'other' : '');
}
function updateEngineMakeFields() {
  const kind = $('bEngKind'), make = $('bEngMake'), pick = $('bEngManufacturer');
  if (!kind || !make || !pick) return;
  const outboard = kind.value === 'outboard';
  $('bEngManufacturerField').hidden = !outboard;
  $('bEngMakeField').hidden = outboard && pick.value !== 'other';
  $('bEngMakeLabel').textContent = outboard ? 'Other manufacturer (optional)' : 'Engine make';
  $('bShaftRow').hidden = !outboard;
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
    '<label class="air-ok"><input type="checkbox" id="bAirOk"' + (b.airVerified ? ' checked' : '') + '> Air draft verified (I measured it, or it is from the builder for my rig)</label>' +
    '<div class="grid2">' + sel('bEngKind', 'Engine', b.engineKind, [['outboard', 'Outboard'], ['inboard-diesel', 'Inboard diesel'], ['inboard-gas', 'Inboard gas'], ['sterndrive', 'Sterndrive'], ['pod', 'Pod drive (IPS etc.)'], ['none', 'No engine']]) + f('bHp', 'Horsepower', b.engineHp, 'number') + '</div>' +
    '<div id="bShaftRow" class="grid2"' + (b.engineKind && b.engineKind !== 'outboard' ? ' hidden' : '') + '>' + sel('bShaft', 'Outboard shaft length', b.shaft || '', [['', 'Not sure'], ['short', 'Short (15 in)'], ['long', 'Long (20 in)'], ['xl', 'Extra long (25 in)'], ['ul', 'Ultra long (30 in)']]) + '<p class="hint" style="align-self:end">Measured from the top of the mounting bracket to the anti-ventilation plate. It decides which replacement or spare fits your transom.</p></div>' +
    '<div id="bEngManufacturerField"' + (b.engineKind && b.engineKind !== 'outboard' ? ' hidden' : '') + '>' + sel('bEngManufacturer', 'Outboard manufacturer', outboardMakeChoice(b.engineMake), [['', 'Choose / Not sure'], ...OUTBOARD_MAKES.map((name) => [name, name]), ['other', 'Other — enter a name']]) + '</div>' +
    '<div class="grid2"><div class="field" id="bEngMakeField"' + ((!b.engineKind || b.engineKind === 'outboard') && outboardMakeChoice(b.engineMake) !== 'other' ? ' hidden' : '') + '><label id="bEngMakeLabel" for="bEngMake">' + ((!b.engineKind || b.engineKind === 'outboard') ? 'Other manufacturer (optional)' : 'Engine make') + '</label><input id="bEngMake" type="text" value="' + esc(b.engineMake || '') + '" placeholder="Enter manufacturer"></div>' + f('bEngModel', 'Engine model', b.engineModel) + '</div>' +
    '<div class="grid2">' + f('bEngYear', 'Engine year', b.engineYear, 'number') + f('bEngSerial', 'Engine serial number', b.engineSerial) + '</div>' +
    '<div class="grid2">' + f('bHull', 'Hull ID (HIN)', b.hin) + f('bReg', 'Registration or documentation no.', b.reg) + '</div>' +
    '<div class="grid2">' + f('bHours', 'Engine hours now', b.engineHours, 'number') + sel('bIcon', 'Chart icon', st.iconStyle, [['boat', 'Boat outline'], ['arrow', 'Arrow']]) + '</div>' +
    '<div class="grid2">' + sel('bAnchor', 'Main anchor', b.anchorType, [['', 'Choose…'], ['newgen', 'New-generation (Rocna, Mantus, Spade, Vulcan…)'], ['plow', 'Plow (CQR, Delta)'], ['claw', 'Claw (Bruce)'], ['fluke', 'Fluke (Danforth, Fortress)'], ['grapnel', 'Grapnel'], ['other', 'Other']]) + f('bAnchorLb', 'Anchor weight (lb)', b.anchorLb, 'number') + '</div>' +
    '<div class="grid2">' + f('bChain', 'Chain (' + lenUnit() + ')', L2(b.chainFt), 'number') + f('bRode', 'Total rode incl. chain (' + lenUnit() + ')', L2(b.rodeTotalFt), 'number') + '</div>' +
    '<div class="grid2">' + f('bSafe', 'Safety buffer under keel (' + lenUnit() + ')', L2(b.safetyFt == null ? 2 : b.safetyFt), 'number') + f('bGph', 'Fuel burn at cruise (gal/h)', b.gph, 'number') + '</div>' +
    '<div class="grid2">' + f('bTank', 'Fuel tank (gal)', b.tankGal, 'number') + f('bMmsi', 'MMSI (from your VHF or AIS)', b.mmsi, 'text', 'inputmode="numeric" maxlength="9"') + '</div>' +
    '<p class="hint">Batteries: add each one, its type and purchase date, in the Batteries card on the Boat page.</p>' +
    '<div class="row-btns"><button class="btn primary" data-act="saveboat">Save</button><button class="btn ghost" data-act="cancelboat">Cancel</button></div></div></div>';
}
function saveBoatForm() {
  const v = (id) => ($(id) ? $(id).value.trim() : ''), n = (id) => { const x = parseFloat(v(id)); return isFinite(x) ? x : null; };
  const st = S.settings, b = S.boat;
  st.boatName = v('bName'); st.skipper = v('bSkipper'); st.boatType = v('bType'); st.useMode = v('bUse') || 'cruise'; applyUseMode(); st.iconStyle = v('bIcon');
  if (n('bLen')) st.boatLen = lenToFt(n('bLen'));
  b.year = v('bYear'); b.make = v('bMake'); b.model = v('bModel');
  b.beamFt = n('bBeam') != null ? lenToFt(n('bBeam')) : null; b.draftFt = n('bDraft') != null ? lenToFt(n('bDraft')) : null; b.airDraftFt = n('bAir') != null ? lenToFt(n('bAir')) : null; b.airVerified = !!($('bAirOk') && $('bAirOk').checked);
  b.engineKind = v('bEngKind'); b.shaft = $('bShaft') ? v('bShaft') : b.shaft; b.engineHp = n('bHp'); b.engineMake = v('bEngMake'); b.engineModel = v('bEngModel'); b.engineYear = v('bEngYear'); b.engineSerial = v('bEngSerial'); b.hin = v('bHull'); b.reg = v('bReg'); b.engineHours = n('bHours') || 0;

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
const saveMaint = () => { store.set('maint', S.maint); const cur = S.fleet && S.fleet.boats.find((x) => x.id === S.fleet.active); if (cur) { cur.maint = S.maint; try { store.set('fleet', S.fleet); } catch (e) { /* full */ } } };
if (!S.maint.receipts) S.maint.receipts = [];
(() => { const cur = S.fleet && S.fleet.boats.find((x) => x.id === S.fleet.active); if (cur && !cur.maint) { cur.maint = S.maint; try { store.set('fleet', S.fleet); } catch (e) { /* full */ } } })(); // this boat keeps the maintenance it already had
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
  h += '<div class="set-row"><div class="sr-text"><b>Engine hours</b><span>Update after each trip</span></div><div class="stepper"><button type="button" data-mh="-1" aria-label="One hour less">−</button><input type="text" inputmode="decimal" id="mHours" value="' + (Math.round((S.boat.engineHours || 0) * 10) / 10) + '" aria-label="Engine hours"><button type="button" data-mh="1" aria-label="One hour more">+</button></div></div>' + logList(S.boat.hoursLog, (r) => (Math.round(r.v * 10) / 10) + ' h', () => '', 'hoursdel');
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
// receipts and purchases for this boat: what, where, how much, with a photo of the receipt kept on this device
const RC_CATS = [['parts', 'Parts'], ['service', 'Service / labor'], ['fuel', 'Fuel'], ['gear', 'Gear / safety'], ['slip', 'Slip, mooring, storage'], ['other', 'Other']];
let rcOpen = false;
function receiptsHtml() {
  const R = S.maint.receipts || [], yr = new Date().getFullYear(), tot = R.filter((r) => new Date(r.date).getFullYear() === yr).reduce((a, r) => a + (+r.amount || 0), 0);
  let h = '<div class="card" style="padding:4px 14px 12px"><h4>Receipts and purchases</h4>';
  h += '<p class="hint" style="margin:-2px 0 8px">' + (R.length ? R.length + ' saved for ' + esc(S.settings.boatName || 'this boat') + ' · $' + tot.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' in ' + yr : 'Snap a photo of a receipt, or type it in. Each boat keeps its own.') + '</p>';
  if (rcOpen) {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    h += '<div class="rc-form"><div class="grid2"><div class="field"><label>What</label><input id="rcItem" placeholder="Impeller kit, bottom paint…"></div><div class="field"><label>Where</label><input id="rcVendor" placeholder="West Marine, yard…"></div></div>' +
      '<div class="grid2"><div class="field"><label>Amount ($)</label><input id="rcAmt" inputmode="decimal" placeholder="0.00"></div><div class="field"><label>Date</label><input id="rcDate" type="date" value="' + today + '"></div></div>' +
      '<div class="grid2"><div class="field"><label>Kind</label><select id="rcCat">' + RC_CATS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select></div><div class="field"><label>Receipt photo</label><input id="rcPhoto" type="file" accept="image/*" capture="environment"></div></div>' +
      '<div class="field"><label>Note</label><input id="rcNote" placeholder="Part number, warranty, what it was for"></div>' +
      '<div class="row-btns"><button class="btn primary" data-act="rcsave">Save receipt</button><button class="btn ghost" data-act="rccancel">Cancel</button></div></div>';
  } else h += '<div class="row-btns"><button class="btn" data-act="rcadd">Add a receipt</button>' + (R.length ? '<button class="btn" data-act="rccsv">Export (CSV)</button>' : '') + '</div>';
  h += R.slice().sort((a, b) => b.date - a.date).slice(0, 25).map((r) => '<div class="rc-row"><div class="rc-thumb" data-rcimg="' + r.id + '">' + (r.photo ? '' : '<span>' + (RC_CATS.find((c) => c[0] === r.cat) || ['', '·'])[1].slice(0, 1) + '</span>') + '</div><div class="rc-main"><b>' + esc(r.item || 'Purchase') + '</b><span>' + new Date(r.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + (r.vendor ? ' · ' + esc(r.vendor) : '') + (r.note ? ' · ' + esc(r.note) : '') + '</span></div><b class="tnum">$' + (+r.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</b><button type="button" class="rlog-x" data-act="rcdel" data-id="' + r.id + '" aria-label="Delete receipt">×</button></div>').join('');
  setTimeout(rcThumbs, 0);
  return h + '</div>';
}
async function rcThumbs() {
  const els = [...document.querySelectorAll('[data-rcimg]')]; if (!els.length) return;
  try { const all = await pAll('receipts'); els.forEach((el) => { const p = all.find((x) => x.id === 'rc' + el.dataset.rcimg); if (p) { el.style.backgroundImage = 'url(' + p.src + ')'; el.dataset.full = '1'; } }); } catch (e) { /* storage unavailable */ }
}
document.addEventListener('click', async (e) => {
  const th = e.target.closest('[data-rcimg][data-full]'); if (th) { const all = await pAll('receipts'), p = all.find((x) => x.id === 'rc' + th.dataset.rcimg); if (p) openSheet('<h3>Receipt</h3><img src="' + p.src + '" alt="Receipt" style="width:100%;border-radius:12px"><div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>'); return; }
  const b = e.target.closest('[data-act]'); if (!b || !$('panelBoat').contains(b)) return; const act = b.dataset.act;
  if (act === 'rcadd') { rcOpen = true; renderBoat(); setTimeout(() => { const i = $('rcItem'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }, 50); }
  if (act === 'rccancel') { rcOpen = false; renderBoat(); }
  if (act === 'rcsave') {
    const r = { id: Date.now(), item: $('rcItem').value.trim(), vendor: $('rcVendor').value.trim(), amount: parseFloat(($('rcAmt').value || '').replace(/[$,]/g, '')) || 0, date: (() => { const v = $('rcDate').value; return v ? new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10), 12).getTime() : Date.now(); })(), cat: $('rcCat').value, note: $('rcNote').value.trim(), photo: false };
    if (!r.item && !r.amount) { toast('Add what it was, or the amount'); return; }
    const f = $('rcPhoto').files && $('rcPhoto').files[0];
    if (f) { try { const src = await resizePhoto(f, 1600, 0.72); await pPut({ id: 'rc' + r.id, track: 'receipts', t: r.date, src }); r.photo = true; } catch (err) { toast('Could not save the photo; the receipt is saved without it'); } }
    S.maint.receipts.push(r); saveMaint(); rcOpen = false; renderBoat(); toast('Receipt saved for ' + (S.settings.boatName || 'this boat'));
  }
  if (act === 'rcdel') { if (!armed(b, 'Tap again')) return; S.maint.receipts = S.maint.receipts.filter((x) => String(x.id) !== b.dataset.id); saveMaint(); renderBoat(); }
  if (act === 'rccsv') {
    const rows = [['Date', 'Boat', 'What', 'Where', 'Kind', 'Amount', 'Note']].concat(S.maint.receipts.map((r) => [new Date(r.date).toLocaleDateString(), S.settings.boatName || '', r.item, r.vendor, (RC_CATS.find((c) => c[0] === r.cat) || ['', ''])[1], (+r.amount || 0).toFixed(2), r.note]));
    download('receipts-' + (S.settings.boatName || 'boat').replace(/\W+/g, '-').toLowerCase() + '.csv', rows.map((x) => x.map((v) => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')).join('\n'));
  }
});
// Equipment belongs to the active boat's maintenance record, alongside receipts.
const EQ_KINDS = [['sail', 'Sails'], ['fishing', 'Fishing gear'], ['dive', 'Dive gear'], ['safety', 'Safety equipment'], ['other', 'Other']];
let equipmentEdit = null;
function equipmentHtml() {
  const items = S.maint.equipment || [];
  let h = '<div class="card"><h4>Equipment register</h4><p class="hint">Sails, fishing, dive and other gear for ' + esc(S.settings.boatName || 'this boat') + '. Record dimensions with units, serial numbers and service dates.</p>';
  if (equipmentEdit !== null) {
    const q = items.find((x) => x.id === equipmentEdit) || {};
    const field = (id, label, value, type = 'text', placeholder = '') => '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '" value="' + esc(value || '') + '" placeholder="' + placeholder + '"></div>';
    h += '<div class="field"><label for="eqKind">Category</label><select id="eqKind">' + EQ_KINDS.map(([v,l]) => '<option value="' + v + '"' + (q.kind === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>';
    h += field('eqName', 'Equipment name', q.name, 'text', 'Mainsail, fishing rod, dive regulator…') + '<div class="grid2">' + field('eqMaker', 'Manufacturer', q.maker) + field('eqModel', 'Model / serial number', q.model) + '</div>';
    h += field('eqSpecs', 'Dimensions and specifications (include units)', q.specs, 'text', 'Sail: luff 32 ft, leech 34 ft, foot 11 ft; cloth…') + '<div class="grid2">' + field('eqBought', 'Purchase date', q.bought, 'date') + field('eqNext', 'Next inspection / service due', q.next, 'date') + '</div>' + field('eqNotes', 'Notes / storage location', q.notes);
    h += '<div class="field"><label for="eqReceipt">Related receipt (optional)</label><select id="eqReceipt"><option value="">None</option>' + (S.maint.receipts || []).map((r) => '<option value="' + r.id + '"' + (String(q.receipt || '') === String(r.id) ? ' selected' : '') + '>' + esc(r.item || 'Purchase') + '</option>').join('') + '</select></div><div class="row-btns"><button class="btn primary" data-act="eqsave">Save equipment</button><button class="btn ghost" data-act="eqcancel">Cancel</button></div>';
  } else h += '<button class="btn" data-act="eqadd">Add equipment</button>';
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  h += items.map((q) => '<details style="margin-top:12px"><summary><b>' + esc(q.name) + '</b> · ' + esc((EQ_KINDS.find(([v]) => v === q.kind) || ['', 'Other'])[1]) + (q.next ? ' · ' + (q.next <= today ? 'Service due ' : 'Service ') + esc(q.next) : '') + '</summary><p class="sub">' + [q.maker, q.model, q.specs, q.bought ? 'Purchased ' + q.bought : '', q.notes].filter(Boolean).map(esc).join('<br>') + '</p>' + ((S.maint.receipts || []).some((r) => String(r.id) === String(q.receipt)) ? '<p class="hint">Receipt: ' + esc(S.maint.receipts.find((r) => String(r.id) === String(q.receipt)).item || 'Purchase') + '</p>' : '') + '<div class="row-btns"><button class="btn small" data-act="eqedit" data-id="' + q.id + '">Edit</button><button class="btn small" data-act="eqservice" data-id="' + q.id + '">Log service</button><button class="btn small ghost" data-act="eqdelete" data-id="' + q.id + '">Remove</button></div>' + (q.log || []).slice().reverse().map((l) => '<p class="hint">' + esc(l.date) + ' · ' + esc(l.note) + '</p>').join('') + '</details>').join('');
  return h + '</div>';
}
$('panelBoat').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !b.dataset.act.startsWith('eq')) return;
  const items = S.maint.equipment || (S.maint.equipment = []), q = items.find((x) => String(x.id) === b.dataset.id), act = b.dataset.act;
  if (act === 'eqadd') equipmentEdit = 0;
  if (act === 'eqedit' && q) equipmentEdit = q.id;
  if (act === 'eqcancel') equipmentEdit = null;
  if (act === 'eqsave') {
    const name = $('eqName').value.trim(); if (!name) { toast('Enter an equipment name'); return; }
    const data = { name, kind: $('eqKind').value, maker: $('eqMaker').value.trim(), model: $('eqModel').value.trim(), specs: $('eqSpecs').value.trim(), bought: $('eqBought').value, next: $('eqNext').value, notes: $('eqNotes').value.trim(), receipt: $('eqReceipt').value };
    const old = items.find((x) => x.id === equipmentEdit);
    if (old) Object.assign(old, data); else items.push(Object.assign({ id: Date.now(), log: [] }, data));
    saveMaint(); equipmentEdit = null;
  }
  if (act === 'eqdelete' && q) { if (!armed(b, 'Tap again')) return; S.maint.equipment = items.filter((x) => x !== q); saveMaint(); }
  if (act === 'eqservice' && q) {
    openSheet('<h3>Service: ' + esc(q.name) + '</h3><div class="field"><label for="eqServiceNote">What was done</label><input id="eqServiceNote" placeholder="Inspection, repair, cleaning…"></div><div class="grid2"><div class="field"><label for="eqServiceDate">Service date</label><input type="date" id="eqServiceDate" value="' + new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) + '"></div><div class="field"><label for="eqServiceNext">Next due (optional)</label><input type="date" id="eqServiceNext"></div></div><button class="btn primary" data-act="eqservsave" data-id="' + q.id + '" data-boat="' + S.fleet.active + '">Save service</button>'); return;
  }
  renderBoat();
});
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="eqservsave"]'); if (!b) return;
  if (String(S.fleet.active) !== b.dataset.boat) { toast('Boat changed. Reopen service from the correct boat.'); return; }
  const q = (S.maint.equipment || []).find((x) => String(x.id) === b.dataset.id);
  const note = $('eqServiceNote').value.trim(), date = $('eqServiceDate').value;
  if (!q || !note || !date) { toast('Enter the service and date'); return; }
  (q.log || (q.log = [])).push({ date, note }); q.next = $('eqServiceNext').value;
  saveMaint(); closeSheet(); renderBoat(); toast('Service saved for ' + q.name);
});
// battery bank: any number of batteries, each with its type, purchase date and its own dated voltage log
const BATT_KINDS = [['lead', 'Flooded lead-acid'], ['agm', 'AGM'], ['gel', 'Gel'], ['lifepo4', 'Lithium (LiFePO4)']];
function batteries() {
  const b = S.boat;
  if (!Array.isArray(b.batteries)) { // move the old single house battery into the bank
    b.batteries = [{ id: 'b1', name: 'House', kind: b.batteryKind || 'lead', bought: b.batteryInstalled || '', log: b.battLog || [] }];
    saveBoat();
  }
  return b.batteries;
}
function battLife(kind) { return kind === 'lifepo4' ? [8, 12] : kind === 'agm' ? [4, 7] : kind === 'gel' ? [4, 7] : [3, 6]; }
function batteryReadings(bt) { return (bt.log || []).slice().sort((a, b) => a.t - b.t); }
function batteryReminder(bt, now = Date.now()) {
  const logs = batteryReadings(bt), last = logs[logs.length - 1];
  const months = bt.checkMonths == null ? 6 : +bt.checkMonths;
  if (!months) return { due: false, text: 'Test reminders off' };
  if (!last) return { due: true, text: 'Baseline test due · Save your first reading' };
  const date = new Date(last.t), day = date.getDate();
  date.setDate(1); date.setMonth(date.getMonth() + months);
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return { due: now >= date.getTime(), text: (now >= date.getTime() ? 'Battery check overdue · ' : 'Next battery check · ') + date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) };
}
function batteryTrend(bt) {
  // Compare readings from the same test condition and chemistry, not load against rest.
  const logs = batteryReadings(bt), last = logs[logs.length - 1];
  if (!last) return '';
  if (last.kind && last.kind !== bt.kind) return '';
  const comparable = logs.filter((r) => (r.cond || 'rest') === (last.cond || 'rest') && (!r.kind || r.kind === bt.kind));
  if (comparable.length < 2) return '';
  const first = comparable[0], change = last.v - first.v;
  return first.v.toFixed(2) + ' → ' + last.v.toFixed(2) + ' V · ' + Math.abs(change).toFixed(2) + ' V ' + (change < 0 ? 'lower' : change > 0 ? 'higher' : 'change') + ' since ' + new Date(first.t).toLocaleDateString() + '. Same test condition; charge and temperature can still differ.';
}
function batteryHtml() {
  const list = batteries();
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  let h = '<div class="card" style="padding:4px 14px 12px"><h4>Batteries · ' + list.length + '</h4><p class="hint" style="margin:-2px 0 6px">For nominal 12 V batteries. Test with charging and loads off after the rest period in your manual. Save the date and condition to compare readings. Voltage alone does not prove battery health.</p>';
  list.forEach((bt) => {
    const logs = batteryReadings(bt), last = logs[logs.length - 1], reminder = batteryReminder(bt), trend = batteryTrend(bt);
    const bd = bt.bought ? new Date(+bt.bought.slice(0, 4), +bt.bought.slice(5, 7) - 1, 1) : null, age = bd ? (Date.now() - bd) / (365.25 * 86400000) : null;
    const ageTxt = age != null && isFinite(age) ? 'Bought ' + bd.toLocaleDateString([], { month: 'short', year: 'numeric' }) + ' · ' + Math.max(0, age).toFixed(1) + ' years old' + (age >= 2 ? '<br>Two-year check-in: inspect connections and review test history. Age alone is not a reason to replace.' : '') : 'Add the purchase month to track its age';
    const bad = last && last.v < 11 && (last.cond || 'rest') !== 'load';
    h += '<div class="batt' + (bad ? ' bad' : '') + '">' + (bad ? '<div class="batt-flag">Very low recorded voltage · Check charging, connections and battery condition before relying on it.</div>' : '') +
      '<div class="batt-top"><input class="batt-name" data-bname="' + bt.id + '" value="' + esc(bt.name) + '" aria-label="Battery name"><select data-bkind="' + bt.id + '" aria-label="Battery type">' + BATT_KINDS.map(([v, l]) => '<option value="' + v + '"' + (bt.kind === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>' +
      '<div class="batt-row"><label>Purchased <input type="month" data-bbought="' + bt.id + '" value="' + esc(bt.bought || '') + '"></label><div class="batt-in"><select data-bcond="' + bt.id + '" aria-label="When it was tested"><option value="rest">At rest</option><option value="charged">After charging</option><option value="load">Under load</option></select><input type="text" inputmode="decimal" data-bv="' + bt.id + '" placeholder="' + (bt.kind === 'lifepo4' ? '13.3' : '12.6') + '" aria-label="Voltage for ' + esc(bt.name) + '"><span class="u">V</span><button type="button" class="btn small" data-act="battsave" data-id="' + bt.id + '">Save</button></div></div>' +
      '<div class="grid2"><div class="field"><label>Test date<input type="date" data-bdate="' + bt.id + '" value="' + today + '" max="' + today + '"></label></div><div class="field"><label>Remind me to test<select data-binterval="' + bt.id + '">' + [[1, 'Monthly'], [3, 'Every 3 months'], [6, 'Every 6 months'], [12, 'Yearly'], [0, 'Off']].map(([m, label]) => '<option value="' + m + '"' + ((bt.checkMonths == null ? 6 : +bt.checkMonths) === m ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label></div></div>' +
      '<div class="field"><label>Test note (optional)<input type="text" data-bnote="' + bt.id + '" placeholder="Rested overnight, fully charged, temperature…"></label></div>' +
      '<p class="hint' + (reminder.due ? ' warn-t' : '') + '">' + esc(reminder.text) + '</p>' +
      '<div class="hint batt-out" data-bout="' + bt.id + '">' + ageTxt + (last ? '<br>Last: ' + last.v.toFixed(2) + ' V on ' + new Date(last.t).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + esc(last.note || '') : '') + '</div>' +
      (trend ? '<p class="hint">' + esc(trend) + '</p>' : '') +
      (logs.length ? '<details><summary>Test history · ' + logs.length + ' readings</summary>' + logList(logs, (r) => r.v.toFixed(2) + ' V', (r) => [({ rest: 'At rest', charged: 'After charging', load: 'Under load' }[r.cond || 'rest']), r.note, r.userNote].filter(Boolean).join(' · '), 'battdel" data-id="' + bt.id, true) + '</details>' : '') +
      (list.length > 1 ? '<button type="button" class="link-btn" data-act="battrm" data-id="' + bt.id + '">Remove this battery</button>' : '') + '</div>';
  });
  return h + '<button type="button" class="btn" style="width:100%;margin-top:8px" data-act="battadd">Add a battery</button></div>';
}
// a dated record of readings, newest first, so you can see a battery or engine trend over the season
function logList(arr, val, sub, delAct, showAll = false) {
  if (!arr || !arr.length) return '';
  return '<div class="rlog"><div class="rlog-h">Recorded</div>' + arr.slice().reverse().slice(0, showAll ? arr.length : 12).map((r) => '<div class="rlog-r"><span class="tnum">' + new Date(r.t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + new Date(r.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</span><b class="tnum">' + esc(val(r)) + '</b><em>' + esc(sub(r) || '') + '</em><button type="button" class="rlog-x" data-act="' + delAct + '" data-t="' + r.t + '" aria-label="Delete this reading">×</button></div>').join('') + '</div>';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !$('panelBoat').contains(b)) return;
  const bt = b.dataset.id && batteries().find((x) => x.id === b.dataset.id);
  if (b.dataset.act === 'battsave' && bt) {
    const inp = document.querySelector('[data-bv="' + bt.id + '"]'), v = Number(((inp && inp.value) || '').trim().replace(',', '.'));
    if (!(v > 5 && v < 20)) { toast('Enter the voltage you measured, such as 12.6'); return; }
    const cnd = (document.querySelector('[data-bcond="' + bt.id + '"]') || {}).value || 'rest', vd = batteryVerdict(v, bt.kind, cnd) || '';
    const rawDate = (document.querySelector('[data-bdate="' + bt.id + '"]') || {}).value || '', parts = rawDate.split('-').map(Number), date = new Date(parts[0], parts[1] - 1, parts[2], 12);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || !isFinite(date.getTime()) || date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2] || date.toDateString() !== new Date().toDateString() && date.getTime() > Date.now()) { toast('Choose a valid test date, today or earlier'); return; }
    let t = date.toDateString() === new Date().toDateString() ? Date.now() : date.getTime();
    while ((bt.log || []).some((r) => r.t === t)) t++;
    const userNote = ((document.querySelector('[data-bnote="' + bt.id + '"]') || {}).value || '').trim();
    bt.log = (bt.log || []).concat([{ t, recordedAt: Date.now(), v, cond: cnd, kind: bt.kind, note: vd, userNote }]); saveBoat(); renderBoat(); toast(bt.name + ': ' + v.toFixed(2) + ' V saved');
  }
  if (b.dataset.act === 'battdel' && bt) { if (!armed(b, 'Tap again')) return; bt.log = (bt.log || []).filter((r) => String(r.t) !== b.dataset.t); saveBoat(); renderBoat(); }
  if (b.dataset.act === 'battadd') { const L3 = batteries(), n = L3.length + 1; L3.push({ id: 'b' + Date.now(), name: n === 2 ? 'Starting' : 'Battery ' + n, kind: L3[0] ? L3[0].kind : 'lead', bought: '', log: [] }); saveBoat(); renderBoat(); }
  if (b.dataset.act === 'battrm' && bt) { if (!armed(b, 'Tap again to remove ' + bt.name + ' and its readings')) return; S.boat.batteries = batteries().filter((x) => x !== bt); saveBoat(); renderBoat(); }
  if (b.dataset.act === 'hoursdel') { if (!armed(b, 'Tap again')) return; S.boat.hoursLog = (S.boat.hoursLog || []).filter((r) => String(r.t) !== b.dataset.t); saveBoat(); renderBoat(); }
});
function logHours(v) { // one entry per day: the latest reading that day
  const L2 = S.boat.hoursLog = S.boat.hoursLog || [], last = L2[L2.length - 1];
  if (last && new Date(last.t).toDateString() === new Date().toDateString()) { last.v = v; last.t = Date.now(); } else L2.push({ t: Date.now(), v });
}
function batteryVerdict(v, kind, cond) {
  const k = kind || S.boat.batteryKind;
  if (!(v > 5 && v < 20)) return '';
  if (cond === 'load') return 'Under-load reading: compare only with the same load and test duration. A resting or manufacturer-specified load test is needed to assess condition.';
  if (k === 'lifepo4') {
    return 'Lithium voltage alone cannot reliably show charge or health. Check the BMS or battery monitor and your manufacturer’s guidance.';
  }
  if (v < 11) return 'Very low for a nominal 12 V lead-acid battery. Check the reading, charging and connections; arrange a proper battery test before relying on it. A failed test may mean replacement.';
  if (v < 12.4) return (cond === 'charged' ? 'Low reading after charging. Check the charger and connections, then ' : 'Low resting reading. ') + 'charge and retest after the rest period in your manual. Repeated low readings warrant a capacity or load test.';
  return 'Recorded. Compare with your manufacturer’s resting-voltage table. This reading alone does not confirm capacity or health.';
}

/* ---------- Boat tab ---------- */
function setupChecklist() { // the few facts every safety check depends on
  const b = S.boat, items = [['Make and model', !!(b.make && b.model), 'bMake'], ['Draft', !!b.draftFt, 'bDraft'], [b.airDraftFt ? (b.airVerified ? 'Air draft, verified' : 'Air draft entered · needs verification') : 'Air draft', !!(b.airDraftFt && b.airVerified), 'bAir'], ['Beam', !!b.beamFt, 'bBeam'], ['Home port', !!S.settings.homePort, 'home']];
  const left = items.filter((x) => !x[1]).length; if (!left) return '';
  return '<div class="card setup"><h4>Finish setting up · ' + left + ' left</h4><p class="hint" style="margin:-2px 0 8px">Depth warnings, water routes and bridge checks use these. Pick your make and model below and most fill in for you.</p>' +
    items.map(([l, ok, f]) => '<button type="button" class="su-row' + (ok ? ' ok' : '') + '" data-sufield="' + f + '"><i>' + (ok ? '✓' : '') + '</i><span>' + l + '</span><em>' + (ok ? 'Change' : f === 'bAir' && b.airDraftFt ? 'Verify' : 'Add') + ' ›</em></button>').join('') + '</div>';
}
function renderBoat() {
  setTimeout(() => { if (boatEditing && $('bDbNote') && (($('bMake') || {}).value || ($('bModel') || {}).value)) boatFinderShow(); }, 0);
  const p = $('panelBoat');
  const due = S.maint.items.filter((i) => ['over', 'soon'].includes(dueInfo(i).cls)).length;
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const gearDue = (S.maint.equipment || []).some((q) => q.next && q.next <= today);
  $('maintDot').hidden = !due && !gearDue && !batteries().some((bt) => batteryReminder(bt).due);
  p.innerHTML = '<div class="p-head"><div><div class="eyebrow">Boat</div><h2>' + esc(S.settings.boatName || 'Your boat') + '</h2></div><button class="btn small" data-act="appsettings">App settings</button></div>' + setupChecklist() +
    fleetHtml() + profileHtml() + lightsCoachHtml() +
    '<div class="card" style="padding:12px 14px"><div class="li" style="border:0;padding:0"><div class="li-main"><b>What am I looking at?</b><span>Identify a vessel from its lights or shapes, cross-checked with AIS</span></div><button class="btn small primary" data-act="identify">Identify</button></div></div>' +
    maintHtml() + equipmentHtml() + receiptsHtml() + batteryHtml() +
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
  if (e.target.id === 'bEngKind') {
    $('bEngManufacturer').value = outboardMakeChoice($('bEngMake').value);
    updateEngineMakeFields();
  }
  if (e.target.id === 'bEngManufacturer') {
    const make = $('bEngMake');
    if (e.target.value === 'other') make.value = make.dataset.customMake || (outboardMakeChoice(make.value) === 'other' ? make.value : '');
    else { if (outboardMakeChoice(make.value) === 'other') make.dataset.customMake = make.value; make.value = e.target.value; }
    updateEngineMakeFields();
    if (e.target.value === 'other') make.focus();
  }
  const bk = e.target.closest('[data-bkind]'), bb = e.target.closest('[data-bbought]'), bi = e.target.closest('[data-binterval]');
  if (bk || bb || bi) { const bt = batteries().find((x) => x.id === (bk ? bk.dataset.bkind : bb ? bb.dataset.bbought : bi.dataset.binterval)); if (bt) { if (bk) bt.kind = bk.value; else if (bb) bt.bought = bb.value; else bt.checkMonths = +bi.value; saveBoat(); renderBoat(); } return; }
  if (e.target.id === 'capPhoto' && e.target.files[0]) { try { S.captain.photo = await resizePhoto(e.target.files[0]); store.set('captain', S.captain); renderBoat(); } catch (err) { toast('Could not read that photo'); } }
  if (e.target.id === 'capName' || e.target.id === 'capLic') { S.captain.name = $('capName').value.trim(); S.captain.license = $('capLic').value.trim(); S.settings.skipper = S.captain.name.split(' ')[0] || S.settings.skipper; saveSettings(); store.set('captain', S.captain); }
  if (e.target.id === 'boatPhoto' && e.target.files[0]) {
    try { S.boat.photo = await resizePhoto(e.target.files[0]); saveBoat(); renderBoat(); } catch (err) { toast('Could not read that photo'); }
  }
  if (e.target.id === 'fogBox') { fogMode = e.target.checked; renderBoat(); }
  if (e.target.id === 'mHours') { S.boat.engineHours = Math.max(0, parseFloat(e.target.value) || 0); logHours(S.boat.engineHours); saveBoat(); renderBoat(); }
});
// engine hours stepper: changes the number in place, saves, and refreshes the due list once you stop tapping
let mhT = null;
$('panelBoat').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mh]'); if (!b) return;
  const inp = $('mHours'), v = Math.max(0, Math.round(((parseFloat(inp.value) || 0) + +b.dataset.mh) * 10) / 10);
  inp.value = v; S.boat.engineHours = v; logHours(v); saveBoat();
  clearTimeout(mhT); mhT = setTimeout(() => { if (document.activeElement !== inp) renderBoat(); }, 1500);
});
// boat finder: make + model (a year in either box is fine) → published specs, with the rig and keel choices that boat came with
const BF = { d: null, rig: null, keel: null };
function boatFind() {
  let mk = ($('bMake') && $('bMake').value) || '', md = ($('bModel') && $('bModel').value) || '';
  const yr = (mk + ' ' + md).match(/\b(19[4-9]\d|20[0-3]\d)\b/); mk = mk.replace(/\b(19|20)\d\d\b/, '').trim(); md = md.replace(/\b(19|20)\d\d\b/, '').trim();
  if (!md && /\s/.test(mk)) { const parts = mk.split(/\s+/); md = parts.pop(); mk = parts.join(' '); } // "Catalina 27" typed in one box
  if (yr && $('bYear') && !$('bYear').value) $('bYear').value = yr[1];
  return boatLookup(mk, md);
}
function boatFinderHtml(d) {
  const V = d.variants || {}, rig = (V.rig || []).find((x) => x.id === BF.rig) || (V.rig || [])[0], keel = (V.keel || []).find((x) => x.id === BF.keel) || (V.keel || [])[0];
  const air = rig ? rig.air : d.air, draft = keel ? keel.draft : d.draft, L = (ft) => (Math.round(ftToLen(ft) * 10) / 10) + ' ' + lenUnit();
  const seg = (k, arr, cur) => arr && arr.length > 1 ? '<div class="bf-q">' + (k === 'rig' ? 'Which rig?' : 'Which keel?') + '</div><div class="seg">' + arr.map((x) => '<button type="button" data-bfv="' + k + ':' + x.id + '" class="' + (cur && cur.id === x.id ? 'on' : '') + '">' + esc(x.label) + '</button>').join('') + '</div>' : '';
  const row = (l, v) => v == null ? '' : '<div><span>' + l + '</span><b class="tnum">' + v + '</b></div>';
  return '<div class="bf"><div class="bf-h">Found: ' + esc(d.make + ' ' + d.model) + (d.years ? ' <small>(built ' + d.years + ')</small>' : '') + '</div>' + seg('rig', V.rig, rig) + seg('keel', V.keel, keel) +
    '<div class="bf-grid">' + row('Length', L(d.loa)) + row('Waterline', L(d.lwl)) + row('Beam', L(d.beam)) + row('Draft', draft ? L(draft) : null) + row('Displacement', d.disp ? d.disp.toLocaleString() + ' lb' : null) + row('Ballast', d.ballast ? d.ballast.toLocaleString() + ' lb' : null) + row('Air draft', air ? '≈ ' + L(air) : null) + row('Hull speed', fmtSpeed(1.34 * Math.sqrt(d.lwl)) + ' ' + SPEED_LBL[S.settings.speedUnit]) + '</div>' +
    (rig && rig.note ? '<p class="hint">' + esc(rig.note) + '.</p>' : '') +
    '<p class="hint">These are the published numbers we found (' + esc(d.src || 'builder specs') + '). <b>Please verify them on your boat</b>: rigs, keels and owner changes vary. Air draft is an estimate: measure yours and tick Verified.</p>' +
    '<button type="button" class="btn primary" data-act="bfuse">Use these numbers</button></div>';
}
function boatFinderShow() {
  const d = boatFind(), note = $('bDbNote'); if (!note) return;
  if (!d) { BF.d = null; note.innerHTML = 'No match yet for that make and model. Enter the numbers from your manual or a spec sheet, and tell me the boat so it can be added.'; return; }
  if (BF.d !== d) { BF.d = d; BF.rig = null; BF.keel = null; }
  note.innerHTML = boatFinderHtml(d);
}
function boatFinderUse() {
  const d = BF.d; if (!d) return; const V = d.variants || {};
  const rig = (V.rig || []).find((x) => x.id === BF.rig) || (V.rig || [])[0], keel = (V.keel || []).find((x) => x.id === BF.keel) || (V.keel || [])[0];
  const L3 = (ft) => ft == null ? null : String(Math.round(ftToLen(ft) * 10) / 10), put = (id, v) => { const el = $(id); if (el && v != null) { el.value = v; el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 1400); } };
  put('bLen', L3(d.loa)); put('bLwl', L3(d.lwl)); put('bBeam', L3(d.beam)); put('bDraft', L3(keel ? keel.draft : d.draft)); put('bDisp', d.disp); put('bAir', L3(rig ? rig.air : d.air));
  const v = $('bAirOk'); if (v) v.checked = false;
  const air = $('bAir'); if (air && air.value) air.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast('Numbers filled in. Air draft is an estimate: check it, tick Verified only when confirmed, then tap Save.', 6000);
}
$('panelBoat').addEventListener('change', (e) => { if (e.target.id === 'bMake' || e.target.id === 'bModel') boatFinderShow(); });
$('panelBoat').addEventListener('input', (e) => { if (e.target.id === 'bMake' || e.target.id === 'bModel') { clearTimeout(BF.t); BF.t = setTimeout(boatFinderShow, 500); } });
$('panelBoat').addEventListener('pointerdown', (e) => { // pointerdown, so leaving the make/model box (which redraws this card) can't swallow the choice
  const v = e.target.closest('[data-bfv]'); if (v) { e.preventDefault(); const [k, id] = v.dataset.bfv.split(':'); BF[k] = id; boatFinderShow(); }
  if (e.target.closest('[data-act="bfuse"]')) { e.preventDefault(); boatFinderUse(); }
});
$('panelBoat').addEventListener('click', (e) => {
  if (e.detail === 0 && e.target.closest('[data-act="bfuse"]')) boatFinderUse();
});
$('panelBoat').addEventListener('input', (e) => {
  if (e.target.id === 'bAir' && $('bAirOk')) $('bAirOk').checked = false;
  const bvi = e.target.closest && e.target.closest('[data-bv]');
  if (bvi) { const bt = batteries().find((x) => x.id === bvi.dataset.bv), o = document.querySelector('[data-bout="' + bvi.dataset.bv + '"]'), v = parseFloat(bvi.value.replace(',', '.')); if (o && bt && v > 5) o.textContent = batteryVerdict(v, bt.kind, (document.querySelector('[data-bcond="' + bt.id + '"]') || {}).value) || ''; }
  const bn = e.target.closest && e.target.closest('[data-bname]');
  if (bn) { const bt = batteries().find((x) => x.id === bn.dataset.bname); if (bt) { bt.name = bn.value.slice(0, 30) || 'Battery'; saveBoat(); } }
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
  openSheet(html + '<div class="pm" id="pmBox"></div>'); setTimeout(() => placeMedia(p.lat, p.lon, p.name, $('pmBox')), 30);
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
  searchDebounce = setTimeout(async () => { const seq = ++srchSugSeq; const list = await suggestPlaces(q); if (seq !== srchSugSeq) return; srchSugList = list; box.hidden = false; box.innerHTML = placeSugHtml(list, 'data-ssug') + '<button type="button" class="sug all" data-ssugall="1"><b>Search everything for “' + esc(q) + '”</b><span>Worldwide destinations · nearby marine facilities</span></button>'; }, 250);
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
  const home = homePort() || S.waypoints.find((w) => /home/i.test(w.name)) || { lat: 38.975, lon: -76.47, name: 'Annapolis' };
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
  ['ais', 'AIS boats', () => S.settings.aisShow !== false, (on) => { S.settings.aisShow = on; updateAis(); renderAisBtn(); }],
  ['aisn', 'Ship names', () => S.settings.aisNames === true, (on) => { S.settings.aisNames = on; updateAis(); }],
  ['sail', 'Under sail (off = motoring)', () => !!S.settings.underSail, (on) => { if (!!S.settings.underSail !== on) $('modeChip').click(); }],
  ['towns', 'Town names', () => S.settings.landPlaces !== false, (on) => { S.settings.landPlaces = on; applyChart(); drawPlaceNames(); loadPlaceNames(); }],
  ['roads', 'Main roads', () => !!S.settings.landRoads, (on) => { S.settings.landRoads = on; applyChart(); }],
  ['struct', 'Fish structure', () => !!S.settings.structOn, (on) => { S.settings.structOn = on; drawStruct(); }],
  ['status', 'Status line (GPS, wind, tide)', () => !!S.settings.statusOn, (on) => { S.settings.statusOn = on; applyStatus(); }],
  ['rings', 'Range rings', () => !!S.settings.rings, (on) => { S.settings.rings = on; drawRings(); setTimeout(renderQuick, 0); }],
  ['chips', 'Wind & tide chips', () => !!S.settings.chips, (on) => { S.settings.chips = on; applyCalm(); }],
];
function renderQuick() {
  const q = $('quick'), sz = S.settings.pinSize || 'M';
  q.innerHTML = '<div class="q-head"><b>On the chart</b><button type="button" class="sheet-x" data-qx aria-label="Close">&times;</button></div>' +
    (S.settings.chart !== 'street' ? '<div class="q-h">NOAA chart detail <button type="button" class="q-link" data-qmore>customize…</button></div><div class="seg q-cd">' + [['clean', 'Clean'], ['standard', 'Standard'], ['full', 'Full chart']].map(([v, l]) => '<button type="button" data-qcd="' + v + '" class="' + (S.settings.chartDetail === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' : '') +
    '<div class="q-grid">' +
    QUICK.map(([k, l, get]) => '<button type="button" class="q-t' + (get() ? ' on' : '') + '" data-q="' + k + '" aria-pressed="' + get() + '"><i></i>' + l + '</button>').join('') + '</div>' +
    (S.settings.rings ? '<div class="q-h">Range rings <button type="button" class="q-link" data-qrings>more…</button></div><div class="q-rings">' + ringControlsHtml() + '</div>' : '') +
    '<div class="q-h">Symbol and label size</div><div class="seg">' + [['S', 'Small'], ['M', 'Medium'], ['L', 'Large'], ['XL', 'Extra large']].map(([v, l]) => '<button type="button" data-qsz="' + v + '" class="' + (sz === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
    (RT.line.getLatLngs().length ? '<button type="button" class="btn small q-more" data-qclear>Clear the route line</button>' : '') +
    '<button type="button" class="btn small q-more" data-qarr>Arrange buttons</button><button type="button" class="btn small q-more" data-qmore>More map options</button>';
}
function toggleQuick(show) { const q = $('quick'); const on = show == null ? q.hidden : show; if (on) { closeSheet(); renderQuick(); } q.hidden = !on; $('btnLayers').classList.toggle('on', on); }
$('quick').addEventListener('click', (e) => {
  if (e.target.closest('[data-qx]')) { toggleQuick(false); return; }
  if (e.target.closest('[data-qclear]')) { toggleQuick(false); clearRouteEverywhere(); return; }
  if (e.target.closest('[data-qmore]')) { toggleQuick(false); openLayersSheet(); return; }
  if (e.target.closest('[data-qrings]')) { toggleQuick(false); openRingSheet(); return; }
  if (e.target.closest('[data-qarr]')) { toggleQuick(false); arrangeMode(true); return; }
  const cd = e.target.closest('[data-qcd]'); if (cd) { setChartDetail('preset', cd.dataset.qcd, true); return; }
  const z = e.target.closest('[data-qsz]'); if (z) { S.settings.pinSize = z.dataset.qsz; saveSettings(); applyPinSize(); renderQuick(); return; }
  const t = e.target.closest('[data-q]'); if (!t) return; const it = QUICK.find((x) => x[0] === t.dataset.q); if (!it) return;
  it[3](!it[2]()); saveSettings(); renderQuick();
});
map.on('click', () => { if (!$('quick').hidden) { toggleQuick(false); S.quickClosedAt = Date.now(); } });
function applyPinSize() { const sz = S.settings.pinSize || 'M'; document.documentElement.dataset.pins = sz; if (typeof drawMarinePlaces === 'function') drawMarinePlaces(); if (typeof drawBridges === 'function') drawBridges(); }
$('btnLayers').addEventListener('click', () => toggleQuick());
$('windChip').addEventListener('click', () => { setTab('chart'); setWxL('wind', !wxOn('wind')); renderChips(); });
$('windChip').dataset.tip = 'Wind: tap to show wind across the chart'; $('waveChip').dataset.tip = 'Waves: tap to show waves across the chart'; $('tideChip').dataset.tip = 'Tide: tap for the tide curve'; $('modeChip').dataset.tip = 'Tap to switch between sail and engine';
$('waveChip').addEventListener('click', () => { setTab('chart'); setWxL('waves', !wxOn('waves')); renderChips(); });
$('tideChip').addEventListener('click', () => { S.tideCardOn = !S.tideCardOn; setTab('chart'); renderTideCard(); renderChips(); });
function tideNotesHtml() {
  const out = [], wl = S.wl;
  if (wl && wl.diff != null && Math.abs(wl.diff) >= 0.4) out.push('<b>NOAA measures the water ' + Math.abs(wl.diff).toFixed(1) + ' ft ' + (wl.diff > 0 ? 'above' : 'below') + ' the prediction</b> at ' + esc((wl.name || '').replace(/,.*$/, '')) + ' (' + agoTxt(wl.t) + '). Add or take that off the table.');
  const wn = windTideNote(); if (wn) out.push(esc(wn));
  return out.length ? '<div class="tc-notes">' + out.map((x) => '<p>' + x + '</p>').join('') + '</div>' : '';
}
function renderTideCard() {
  let el = $('tideCard');
  if (!el) { el = document.createElement('div'); el.id = 'tideCard'; el.className = 'tide-card'; $('bottomStack').insertBefore(el, $('wxBar')); }
  const tn = tideNow();
  if (!S.tideCardOn || !S.tide || S.tide.none || !tn) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<div class="tc-head"><b>Tide ' + tideLen(tn.v) + ' ' + (tn.rising == null ? '' : tn.rising ? '↑ rising' : '↓ falling') + '</b><span>' + (tn.next ? (tn.next.type === 'H' ? 'High ' : 'Low ') + fmtClock(tn.next.t) + ' · ' : '') + 'NOAA ' + esc((S.tide.station && S.tide.station.name.replace(/,.*$/, '')) || '') + '</span>' +
    '<button type="button" class="tl-x" data-tcx aria-label="Close tide">&times;</button></div>' + (() => { const ts = tideState(); return ts ? '<div class="tc-state ' + (ts.short || '').toLowerCase() + '">' + esc(ts.state) + (ts.short !== 'SLACK' ? ' · ' + Math.abs(ts.rate).toFixed(2) + ' ft/h' : '') + '</div>' : ''; })() + tideCurve(0) + tideNotesHtml() + '<button type="button" class="tc-more" data-tcmore>Tide table ›</button>';
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-tcx]')) { S.tideCardOn = false; renderTideCard(); renderChips(); }
  if (e.target.closest('[data-tcmore]')) { WX.view = 'tide'; WX.open = true; setTab('weather'); }
});
setInterval(() => { if (S.tideCardOn) renderTideCard(); }, 60000);
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
const spotOnTap = () => S.settings.spotTap === true || S.settings.spotTap === 'true';
if (!S.settings.spotHoldSeeded) { S.settings.spotTap = false; S.settings.spotHoldSeeded = 1; saveSettings(); } // Andy: a plain tap popping a card is annoying; tap and hold is the default
map.on('contextmenu', (e) => { if (RT.edit || S.measure.on) return; if (!spotOnTap()) { closeSheet(); openSpotCard(e.latlng); } else openPointSheet(e.latlng); });
map.on('click', (e) => {
  if (Date.now() - (S.aisTapAt || 0) < 600) return; // that tap was on a ship: its sheet is open, not the spot card
  if (S.measure.on) { measureTap(e.latlng); return; }
  if (RT.edit) { routeAdd(e.latlng); return; }
  if (!sheet.hidden) { closeSheet(); return; }
  if (S.planPick) { const k = S.planPick; S.planPick = null; const o = { name: 'Point ' + ddm(e.latlng.lat, true).replace(/\s/g, '') , lat: e.latlng.lat, lon: e.latlng.lng }; setTab('nav'); planSet(k, o); toast('Set. Tap Route by water when you are ready.', 2500); return; }
  if (Date.now() - (S.quickClosedAt || 0) < 400) return; // that tap just closed the layers panel
  if (document.querySelector('.wx-pop:not([hidden])')) return; // that tap closes the weather buttons
  if (S.settings.view3d) { toast('Switch to the flat 2D view (press and hold the compass) to tap a spot.', 3000); return; }
  if (SPOT.el) { closeSpot(); return; } // a tap elsewhere just closes the spot card
  if (spotOnTap()) openSpotCard(e.latlng); // tap any spot: a small card with wind, waves, current, tide, depth
});


/* ---------- bridges: clearance labels and checks against your boat ---------- */
const BR = { list: new Map(store.get('bridges2', [])), tiles: store.get('bridgeTiles2', {}), busy: false, timer: null, warned: new Map(), layer: L.layerGroup().addTo(map) };
const M2FT = 3.28084;
const num = (v) => { const n = parseFloat(String(v || '').replace(',', '.')); return isFinite(n) ? n : null; };
const isFeet = (v) => /ft|feet|'|"/i.test(String(v || ''));
function toBridge(el) {
  const t = el.tags || {}, lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
  if (lat == null) return null;
  const cat = t['seamark:bridge:category'] || '';
  const movable = /opening|bascule|swing|lifting|draw|retractable|transporter/.test(cat) || !!t['bridge:movable'];
  const us = lat > 17 && lat < 50 && lon < -60 && lon > -170;
  const h = (k) => { const v = num(t[k]); if (v == null) return null; if (isFeet(t[k])) return v; if (/\bm\b|metre|meter/i.test(String(t[k]))) return v * M2FT; return us ? v : v * M2FT; }; // OpenSeaMap asks for metres, but US mappers usually copy the chart's feet
  const closed = h('seamark:bridge:clearance_height_closed') ?? h('seamark:bridge:clearance_height') ?? (num(t.maxheight) != null && t['seamark:type'] === 'bridge' ? num(t.maxheight) * M2FT : null);
  return {
    id: el.type + el.id, lat, lon, name: t.name || t['seamark:name'] || t['bridge:name'] || (movable ? 'Drawbridge' : 'Bridge'),
    closed, open: h('seamark:bridge:clearance_height_open'), width: h('seamark:bridge:clearance_width'), movable, cat,
    vhf: t['seamark:radio_station:channel'] || t.vhf || t['communication:vhf'] || t['vhf:channel'] || '',
    phone: t.phone || t['contact:phone'] || '', hours: t['seamark:bridge:opening_hours'] || t.opening_hours || '', src: 'osm',
  };
}
// Checked by hand against NOAA U.S. Coast Pilot 3, Chapter 13 (30 Aug 2026 edition). These win over every other source.
// Clearances are at mean high water, at the centre of the navigation span.
const CP_BRIDGES = [
  { name: 'Naval Academy Bridge (MD 450)', re: /naval academy|450|severn/i, near: { lat: 38.992, lon: -76.494 }, r: 0.7, closed: 75, movable: false, cp: '2.4 miles above the mouth of the Severn: fixed span, 75 ft' },
  { name: 'US 50/301 Severn River Bridge', re: /50|301|severn|hanson/i, near: { lat: 39.011, lon: -76.508 }, r: 0.8, closed: 80, movable: false, cp: '3.5 miles above the mouth: 80 ft at the center span' },
  { name: 'Weems Creek drawbridge (Ridgely Ave)', re: /weems|ridgely/i, near: { lat: 38.9931, lon: -76.5075 }, r: 0.4, closed: 8, width: 28, movable: true, sched: 'weems', phone: '410-263-3953', cp: 'Weems Creek, 0.5 mile above the entrance: swing span, 28 ft wide, 8 ft closed' },
  { name: 'Weems Creek fixed bridge (Rowe Blvd)', re: /weems|rowe|\b70\b/i, near: { lat: 38.9935, lon: -76.5090 }, r: 0.4, closed: 28, movable: false, cp: 'Weems Creek, about 500 ft above the drawbridge: fixed, 28 ft' },
  { name: 'Spa Creek (Eastport) Bridge', re: /spa creek|compromise|eastport/i, near: { lat: 38.9752, lon: -76.4855 }, r: 0.35, closed: 15, width: 40, movable: true, sched: 'spa', phone: '410-974-3840', cp: 'Spa Creek, 0.4 mile above the entrance: bascule, 40 ft wide, 15 ft closed' },
];
// drawbridge schedules from 33 CFR 117 (checked Oct 2026). Federal and state holidays follow the weekend rules; this does not know holidays.
function bridgeSchedule(br, now) {
  now = now || new Date();
  const hm = (d) => d.getHours() * 60 + d.getMinutes(), at = (d, m) => { const x = new Date(d); x.setHours(Math.floor(m / 60), m % 60, 0, 0); return x; };
  const clock = (d) => fmtClock(d.getTime()), wkend = (d) => d.getDay() === 0 || d.getDay() === 6, mo = now.getMonth() + 1;
  if (br.sched === 'spa') {
    const summer = mo >= 5 && mo <= 10;
    if (!wkend(now) && !summer) { // Nov–Apr weekdays: on signal except the rush hours
      const m = hm(now); if (m > 450 && m < 540) return { txt: 'Closed for the morning rush until ' + clock(at(now, 540)) + ', then opens on signal', rule: '33 CFR 117.571' };
      if (m > 990 && m < 1080) return { txt: 'Closed for the evening rush until ' + clock(at(now, 1080)) + ', then opens on signal', rule: '33 CFR 117.571' };
      return { txt: 'Opens on signal now (call or sound one long, one short)', rule: '33 CFR 117.571' };
    }
    // on the hour and half hour; summer weekdays skip the rush hours except 6:00 and 7:00 PM
    const ok = (d) => { if (wkend(d) || !(d.getMonth() + 1 >= 5 && d.getMonth() + 1 <= 10)) return true; const m = hm(d); if (m > 450 && m < 540) return false; if (m > 990 && m < 1170) return m === 1080 || m === 1140; return true; };
    let t = new Date(now); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() < 30 ? 30 : 60); if (now.getMinutes() === 0 || now.getMinutes() === 30) t = new Date(now.getTime()); t.setSeconds(0, 0);
    for (let i = 0; i < 50 && !ok(t); i++) t = new Date(t.getTime() + 30 * 60000);
    const mins = Math.round((t - now) / 60000);
    return { next: t.getTime(), txt: 'Next opening ' + clock(t) + (mins > 0 ? ' (in ' + mins + ' min)' : ' (now)') + ' · opens on the hour and half hour' + (wkend(now) ? '' : summer ? ', not 7:30–9 AM or 4:30–7:30 PM except 6 and 7 PM' : ''), rule: '33 CFR 117.571' };
  }
  if (br.sched === 'weems') {
    const summer = mo >= 5 && mo <= 9, sr = S.weather && (S.weather.sunrise || []).find((x) => new Date(x).toDateString() === now.toDateString()), ss = S.weather && (S.weather.sunset || []).find((x) => new Date(x).toDateString() === now.toDateString());
    const day = sr && ss ? now >= sr && now <= ss : now.getHours() >= 7 && now.getHours() < 19;
    return { txt: summer && day ? 'Opens on signal now (sunrise to sunset, May–Sept)' : 'Needs at least 5 hours\' notice: call the tender ahead', rule: 'MDOT SHA movable bridge schedule (Aug 2025)' };
  }
  return null;
}
function applyCoastPilot() {
  CP_BRIDGES.forEach((c) => {
    let best = null, bd = c.r;
    BR.list.forEach((o) => {
      const d = distNm(o, c.near); if (d > c.r) return;
      if (c.movable !== !!o.movable && (o.src !== 'osm' || o.movable)) return; // keep the swing bridge and the fixed bridge apart
      const score = d - (c.re.test(o.name || '') ? 0.3 : 0);
      if (score < bd) { bd = score; best = o; }
    });
    if (best) Object.assign(best, { sched: c.sched, phone: c.phone || best.phone, name: c.name, closed: c.closed, open: c.movable ? best.open : null, width: c.width ?? (best.src === 'noaa' ? best.width : null), movable: c.movable, src: 'coastpilot', cp: c.cp });
  });
}
// NOAA ENC bridges: official vertical (VERCLR / VERCCL / VERCOP) and horizontal (HORCLR) clearances, in metres. These replace volunteer values.
async function bridgesFromEnc(bb) {
  const enc = [];
  for (const svc of ['enc_harbour', 'enc_approach']) {
    const ids = await encLayerIds(svc); if (!ids) continue;
    for (const k of ['bridgeL', 'bridgeA']) {
      if (ids[k] == null) continue;
      const u = ids.host + '/arcgis/rest/services/encdirect/' + svc + '/MapServer/' + ids[k] + '/query?where=1%3D1&geometry=' + bb.map((v) => v.toFixed(4)).join('%2C') + '&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0002&f=json';
      const j = await fetchT(u, 20000).then((r) => r.json()); if (j.error) continue;
      (j.features || []).forEach((f) => {
        const a = {}; Object.keys(f.attributes || {}).forEach((x) => { a[x.toUpperCase()] = f.attributes[x]; });
        const pts = (f.geometry.paths || f.geometry.rings || []).flat(); if (!pts.length) return;
        const lat = pts.reduce((s2, p) => s2 + p[1], 0) / pts.length, lon = pts.reduce((s2, p) => s2 + p[0], 0) / pts.length;
        const m = (v) => (v == null || v === '' || +v <= 0 ? null : +v * M2FT);
        const cat = +a.CATBRG || 0, movable = [2, 3, 4, 5, 7, 8].includes(cat);
        const closed = m(a.VERCCL) ?? m(a.VERCLR), open = m(a.VERCOP), width = m(a.HORCLR);
        if (closed == null && open == null && !movable) return;
        enc.push({ lat, lon, name: a.OBJNAM || '', closed, open, width, movable, cat: movable ? 'opening' : 'fixed', scale: svc });
      });
    }
  }
  if (!enc.length) return;
  enc.sort((x, y) => (x.scale === 'enc_harbour' ? -1 : 1) - (y.scale === 'enc_harbour' ? -1 : 1));
  const used = new Set();
  enc.forEach((e) => {
    const key = e.lat.toFixed(3) + e.lon.toFixed(3); if (used.has(key)) return; used.add(key);
    let best = null, bd = 0.25;
    BR.list.forEach((o) => { const d = distNm(o, e); if (d < bd) { bd = d; best = o; } });
    if (best) Object.assign(best, { closed: e.closed ?? best.closed, open: e.open ?? best.open, width: e.width ?? null, movable: best.movable || e.movable, src: 'noaa', name: best.name && !/^(Bridge|Drawbridge)$/.test(best.name) ? best.name : e.name || best.name });
    else BR.list.set('enc' + key, { id: 'enc' + key, lat: e.lat, lon: e.lon, name: e.name || (e.movable ? 'Drawbridge' : 'Bridge'), closed: e.closed, open: e.open, width: e.width, movable: e.movable, cat: e.cat, vhf: '', phone: '', hours: '', src: 'noaa' });
  });
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
  if (!S.boat.airVerified) out.notes.push('Your air draft is not marked verified in Boat. Measure it before trusting this.');
  if (b.src !== 'noaa' && b.src !== 'coastpilot') out.notes.push('This clearance is from volunteers, not NOAA. Check the number printed on the chart.');
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
    const z = map.getZoom(), lbl = z >= 15 || (S.goto && distNm(S.fix || refPos(), br) < 1.5); // the height shows when you are zoomed in close, or nearing it on a route
    const pt = map.latLngToContainerPoint([br.lat, br.lon]); if (taken.some((q) => Math.abs(q.x - pt.x) < (lbl ? 70 : 22) && Math.abs(q.y - pt.y) < 22)) return; taken.push(pt);
    const j = judgeBridge(br), col = BR_COL[j.level];
    const h = br.closed == null ? '?' : Math.round(ftToLen(j.eff != null ? j.eff : br.closed));
    const html = '<div class="br-ic' + (lbl ? ' lbl' : '') + '" style="--c:' + col + '" title="' + esc(br.name) + ': tap for height, VHF and tender"><i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h18M5 9v9M19 9v9M5 14c2-3 5-4 7-4s5 1 7 4"/></svg></i>' + (lbl ? '<b>' + h + (br.src === 'noaa' || br.src === 'coastpilot' ? '' : '?') + ' ' + lenUnit() + (br.movable ? (() => { const sc = bridgeSchedule(br); return sc && sc.next ? ' · opens ' + fmtClock(sc.next) : ' · opens'; })() : '') + '</b>' : '') + '</div>';
    const m = L.marker([br.lat, br.lon], { zIndexOffset: 600, keyboard: false, icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html }) });
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
  const sch = bridgeSchedule(br); if (sch) add('Openings', '<b>' + esc(sch.txt) + '</b><br><small>' + esc(sch.rule) + '. Holidays follow weekend rules.</small>');
  add('VHF', br.vhf ? esc(br.vhf) : br.movable ? 'Not listed. Maryland drawbridge tenders usually answer on channel 13; confirm in the Coast Pilot.' : '');
  if (br.phone) add('Bridge tender', '<span class="tnum">' + esc(br.phone) + '</span> <a href="tel:' + esc(br.phone.replace(/[^+\d]/g, '')) + '">Call</a>');
  if (!sch) add('Openings', br.hours ? esc(br.hours) : br.movable ? 'Schedules and restrictions: Coast Guard drawbridge rules (33 CFR 117)' : '');
  S.sheetPoint = { p: { lat: br.lat, lon: br.lon }, place: { name: br.name } };
  openSheet('<h3>' + esc(br.name) + '</h3><div class="verdict v-' + j.level + '">' + esc(j.text) + (j.notes.length ? '<br>' + j.notes.map(esc).join('<br>') : '') + '</div><div class="facts">' + rows.join('') + '</div>' +
    '<p class="hint"><b>' + (br.src === 'coastpilot' ? 'Source: NOAA U.S. Coast Pilot 3, Ch. 13 (Aug 2026): ' + esc(br.cp) + '.' : br.src === 'noaa' ? 'Source: NOAA chart data (ENC), official clearances.' : 'Source: OpenSeaMap volunteers, not checked against NOAA. Treat as unverified.') + '</b> Clearance is measured at mean high water at the center of the channel span; toward the edges of an arched span it is lower, and high tides, wind tides and storm surge take more off it.<b>' + '</b> The NOAA chart prints the official clearance beside each bridge (zoom in). If they differ, trust the chart. Clearance is measured at average high water. Predicted tide is applied where the station publishes its datums; wind and surge can raise the water further. Verify by eye and with the bridge tender.</p>' +
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
    try { await bridgesFromEnc([w0 * TILE_DEG, s0 * TILE_DEG, e0 * TILE_DEG, n0 * TILE_DEG]); } catch (e) { /* NOAA chart data unavailable: keep OpenSeaMap values, marked unverified */ }
    applyCoastPilot();
    batch.forEach((k) => { BR.tiles[k[2]] = Date.now(); });
    if (BR.list.size > 1500) BR.list = new Map([...BR.list.entries()].slice(-1500));
    store.set('bridges2', [...BR.list.entries()]); store.set('bridgeTiles2', BR.tiles);
  } catch (e) { /* offline: keep what we have */ }
  BR.busy = false; drawBridges(); checkBridgesAhead();
  if (keys.length > 30) { clearTimeout(BR.timer); BR.timer = setTimeout(() => refreshBridges(), 1500); }
}
map.on('moveend', () => { clearTimeout(BR.timer); BR.timer = setTimeout(() => refreshBridges(), 900); });
if (!S.settings.roadsOff1) { S.settings.landRoads = false; S.settings.roadsOff1 = 1; saveSettings(); } // Esri's road layer brings its own outlined, curved street labels: off unless asked for
/* ---------- fishing guide and wildlife: what is in season, baits, structure, and what people actually see here ---------- */
// Typical Chesapeake patterns, not rules: seasons shift with water temperature. Limits and closures change every year: always check Maryland DNR.
const FISH = [
  { n: 'Striped bass (rockfish)', m: [4, 5, 6, 7, 8, 9, 10, 11, 12], peak: [5, 10, 11], bait: 'Live spot or perch, bloodworms, cut menhaden; bucktails, soft plastics, topwater at dawn and dusk', where: 'Points, channel edges, bridge pilings, rock piles, and fish breaking under diving birds', reg: true },
  { n: 'Bluefish', m: [6, 7, 8, 9, 10], peak: [8, 9], bait: 'Cut menhaden in a chum slick; metal spoons and surface plugs', where: 'Open bay, rips and channel edges' },
  { n: 'Spot', m: [6, 7, 8, 9, 10], peak: [8, 9], bait: 'Bloodworms, Fishbites; small hooks on a bottom rig', where: 'Hard bottom 8–20 ft, oyster bars' },
  { n: 'Atlantic croaker (hardhead)', m: [5, 6, 7, 8, 9, 10], peak: [7, 8], bait: 'Bloodworms, squid, peeler crab', where: 'Channel edges and shoals, best in the evening' },
  { n: 'White perch', m: [4, 5, 6, 7, 8, 9, 10, 11], peak: [5, 9, 10], bait: 'Grass shrimp, bloodworms; small spinners and jigs', where: 'Tributaries, docks, oyster bars, riprap' },
  { n: 'Spanish mackerel', m: [7, 8, 9], peak: [8], bait: 'Small gold or silver spoons trolled fast', where: 'Middle and lower bay, around breaking bait' },
  { n: 'Red drum', m: [6, 7, 8, 9, 10], peak: [8, 9], bait: 'Peeler crab, cut menhaden or spot', where: 'Shoals and channel edges; big reds in the lower bay', reg: true },
  { n: 'Cobia', m: [6, 7, 8, 9], peak: [7], bait: 'Live eels, large bucktails; sight casting', where: 'Mostly the lower bay', reg: true },
  { n: 'Summer flounder (fluke)', m: [6, 7, 8, 9], peak: [7, 8], bait: 'Minnows, squid strips, scented soft baits drifted on the bottom', where: 'Sandy edges and drop-offs, mostly lower bay', reg: true },
  { n: 'Yellow perch', m: [2, 3], peak: [3], bait: 'Minnows, small jigs, grass shrimp', where: 'Upper tidal creeks during the late-winter spawning run', reg: true },
  { n: 'Blue catfish (invasive)', m: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], peak: [3, 4, 10, 11], bait: 'Cut menhaden or gizzard shad, chicken liver', where: 'Tidal rivers and deeper holes; keeping them helps the Bay' },
  { n: 'Blue crab (crabbing)', m: [4, 5, 6, 7, 8, 9, 10, 11, 12], peak: [8, 9, 10], bait: 'Chicken necks, razor clams, menhaden on trotlines or pots', where: 'Shallows and creek mouths in summer, deeper water in fall', reg: true },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WILD_GROUPS = [['Cetacea', 'Whales and dolphins'], ['Pinnipedia', 'Seals and sea lions'], ['Elasmobranchii', 'Sharks and rays'], ['Cheloniidae', 'Sea turtles'], ['Actinopterygii', 'Fish'], ['Pandion haliaetus', 'Ospreys'], ['Haliaeetus leucocephalus', 'Bald eagles'], ['Callinectes sapidus', 'Blue crabs']];
const WILD = { layer: L.layerGroup().addTo(map), obs: [], at: 0, key: '' };
function inChesapeake(p) { return p && p.lat > 36.8 && p.lat < 39.7 && p.lon > -77.4 && p.lon < -75.5; }
function openFishWild(tab) {
  const c = S.fix || refPos(), mo = new Date().getMonth() + 1, ches = inChesapeake(c), t = tab || S.fwTab || 'fish'; S.fwTab = t;
  let h = '<h3>Fishing and wildlife</h3><div class="seg fw-tabs">' + [['fish', 'What\'s biting'], ['wild', 'Wildlife here']].map(([v, l]) => '<button type="button" data-fwtab="' + v + '" class="' + (t === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
  if (t === 'fish') {
    if (!ches) h += '<p class="hint">The fishing guide covers the Chesapeake Bay so far. Other waters are coming; your saved spots and catch log work everywhere.</p>';
    const now = FISH.filter((f) => f.m.includes(mo)).sort((a, b) => (b.peak.includes(mo) ? 1 : 0) - (a.peak.includes(mo) ? 1 : 0));
    h += '<div class="sub">' + MONTHS[mo - 1] + ' on the Chesapeake: typical patterns, not guarantees. Water temperature moves everything a few weeks either way.</div>';
    h += now.map((f) => '<div class="fw-fish"><div class="fw-top"><b>' + esc(f.n) + '</b>' + (f.peak.includes(mo) ? '<span class="badge fw-peak">Peak</span>' : '<span class="badge">In season</span>') + '</div>' +
      '<div class="fw-cal">' + MONTHS.map((m, i) => '<i class="' + (f.peak.includes(i + 1) ? 'pk' : f.m.includes(i + 1) ? 'on' : '') + (i + 1 === mo ? ' now' : '') + '" title="' + m + '">' + m[0] + '</i>').join('') + '</div>' +
      '<p><b>Bait:</b> ' + esc(f.bait) + '</p><p><b>Where:</b> ' + esc(f.where) + '</p>' + (f.reg ? '<p class="hint">Size, creel limits and closed seasons apply and change yearly.</p>' : '') + '</div>').join('');
    h += '<div class="row-btns"><a class="btn" href="https://dnr.maryland.gov/fisheries/Pages/regulations/index.aspx" target="_blank" rel="noopener">Maryland fishing rules</a><a class="btn" href="https://news.maryland.gov/dnr/" target="_blank" rel="noopener">DNR fishing news and reports</a></div>';
    const lic = S.settings.fishLic || {};
    h += '<div class="fw-lic"><b>Fishing license</b><div class="grid2"><div class="field"><label>License number</label><input id="flNum" value="' + esc(lic.num || '') + '" placeholder="MD DNR license or registration no."></div><div class="field"><label>Expires</label><input id="flExp" type="date" value="' + esc(lic.exp || '') + '"></div></div>' + (lic.exp && Date.parse(lic.exp) < Date.now() + 30 * 864e5 ? '<p class="hint"><b class="warn-t">' + (Date.parse(lic.exp) < Date.now() ? 'Expired' : 'Expires soon') + '</b>: renew at <a href="https://compass.dnr.maryland.gov" target="_blank" rel="noopener">DNR COMPASS</a>.</p>' : '') + '</div>';
    h += '<div class="fw-tips"><label class="air-ok"><input type="checkbox" id="fishTips"' + (S.settings.fishTips !== false ? ' checked' : '') + '> Fishing tips from the first mate (ask “I\'m fishing for rockfish” or “what crabs can I keep”)</label></div>';
    h += '<div class="row-btns"><button class="btn" data-act="fwstruct">' + (S.settings.structOn ? 'Hide' : 'Show') + ' wrecks and obstructions</button><button class="btn" data-act="fwspots">My spots (' + S.spots.length + ')</button></div>';
    h += '<p class="hint">Wrecks and obstructions come from NOAA chart data: they hold fish, and they snag anchors and gear. Your own spots and catches stay private on this device.</p>';
  } else {
    h += '<p class="hint"><b>Not live.</b> These are past sightings people photographed, good for knowing <i>when</i> an animal tends to show up here. For live dolphin reports on the Chesapeake, use <a href="https://chesapeakedolphinwatch.org" target="_blank" rel="noopener">Chesapeake DolphinWatch</a> (University of Maryland).</p>';
    h += '<div class="sub">What people have photographed within about 15 nm of ' + (S.fix ? 'you' : 'the chart center') + ', from iNaturalist, a free community science project. Tap a species to see which months it shows up.</div>';
    h += '<div class="seg fw-groups">' + WILD_GROUPS.map(([v, l]) => '<button type="button" data-wgrp="' + esc(v) + '" class="' + ((S.settings.wildGrp || 'Cetacea') === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div><div id="wildList"><p class="sub">Looking…</p></div>';
    h += '<div class="row-btns"><button class="btn" data-act="wildmap">' + (S.settings.wildOn ? 'Hide' : 'Show') + ' sightings on the chart</button><a class="btn" href="https://www.inaturalist.org/observations/upload" target="_blank" rel="noopener">Add your sighting</a></div>';
    h += '<p class="hint">Keep your distance: in US waters stay at least 50 yards from dolphins and seals, and 100 yards from whales. Photos belong to their owners, credited on each one.</p>';
    setTimeout(wildSpecies, 30);
  }
  openSheet('<div class="fw">' + h + '<div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div></div>');
}
async function inat(path, params) {
  const u = 'https://api.inaturalist.org/v1/' + path + '?' + new URLSearchParams(params).toString();
  const r = await fetchT(u, 15000); if (!r.ok) throw new Error('iNat ' + r.status); return r.json();
}
async function wildSpecies() {
  const box = $('wildList'); if (!box) return;
  const c = S.fix || refPos(), grp = S.settings.wildGrp || 'Cetacea';
  try {
    const j = await inat('observations/species_counts', { lat: c.lat.toFixed(3), lng: c.lon.toFixed(3), radius: 28, taxon_name: grp, quality_grade: 'research', per_page: 12 });
    const res = j.results || []; if (!$('wildList')) return;
    if (!res.length) { box.innerHTML = '<p class="sub">No confirmed sightings of this group near here yet.</p>'; return; }
    box.innerHTML = res.map((r) => { const tx = r.taxon || {}, ph = tx.default_photo && tx.default_photo.square_url; return '<button type="button" class="fw-sp" data-wsp="' + tx.id + '" data-wname="' + esc(tx.preferred_common_name || tx.name) + '">' + (ph ? '<img src="' + esc(ph) + '" alt="" loading="lazy">' : '<span class="fw-noimg"></span>') + '<span class="fw-sp-main"><b>' + esc(tx.preferred_common_name || tx.name) + '</b><em>' + esc(tx.name) + '</em></span><span class="fw-n">' + r.count + ' seen</span></button><div class="fw-hist" id="wh' + tx.id + '" hidden></div>'; }).join('');
  } catch (e) { box.innerHTML = '<p class="sub">Could not reach iNaturalist just now.</p>'; }
}
async function wildHistogram(id) {
  const el = $('wh' + id); if (!el) return; if (!el.hidden) { el.hidden = true; return; } el.hidden = false; el.innerHTML = '<p class="sub">Counting by month…</p>';
  const c = S.fix || refPos();
  try {
    const j = await inat('observations/histogram', { lat: c.lat.toFixed(3), lng: c.lon.toFixed(3), radius: 28, taxon_id: id, interval: 'month_of_year', quality_grade: 'research' });
    const m = (j.results && j.results.month_of_year) || {}, vals = MONTHS.map((_, i) => m[i + 1] || 0), mx = Math.max(1, ...vals), mo = new Date().getMonth();
    const best = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).filter((x) => x[0] > 0).slice(0, 3).map((x) => MONTHS[x[1]]);
    el.innerHTML = '<div class="fw-bars">' + vals.map((v, i) => '<div class="' + (i === mo ? 'now' : '') + '"><i style="height:' + Math.round(v / mx * 100) + '%"></i><span>' + MONTHS[i][0] + '</span></div>').join('') + '</div><p class="hint">' + (best.length ? 'Most sightings in ' + best.join(', ') + '. ' + (vals[mo] ? vals[mo] + ' recorded in ' + MONTHS[mo] + ' over the years.' : 'None recorded in ' + MONTHS[mo] + ' so far.') : 'Not enough sightings to tell.') + '</p>';
  } catch (e) { el.innerHTML = '<p class="sub">Could not reach iNaturalist just now.</p>'; }
}
async function drawWild(force) {
  WILD.layer.clearLayers(); if (!S.settings.wildOn || map.getZoom() < 9) return;
  const b = map.getBounds(), grp = S.settings.wildGrp || 'Cetacea', key = grp + b.toBBoxString();
  try {
    if (force || key !== WILD.key) {
      const j = await inat('observations', { nelat: b.getNorth().toFixed(3), nelng: b.getEast().toFixed(3), swlat: b.getSouth().toFixed(3), swlng: b.getWest().toFixed(3), taxon_name: grp, photos: 'true', quality_grade: 'research', order_by: 'observed_on', per_page: 60 });
      WILD.obs = (j.results || []).filter((o) => o.geojson && o.photos && o.photos.length); WILD.key = key;
    }
  } catch (e) { return; }
  WILD.layer.clearLayers();
  const taken = [];
  WILD.obs.forEach((o) => {
    const [lon, lat] = o.geojson.coordinates, pt = map.latLngToContainerPoint([lat, lon]); if (taken.some((q) => Math.abs(q.x - pt.x) < 30 && Math.abs(q.y - pt.y) < 30)) return; taken.push(pt);
    const ph = o.photos[0].url;
    const m = L.marker([lat, lon], { keyboard: false, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: '<div class="wild-pin" style="background-image:url(' + esc(ph) + ')"></div>' }) });
    m.on('click', () => { const tx = o.taxon || {}; openSheet('<h3>' + esc(tx.preferred_common_name || tx.name || 'Sighting') + '</h3><div class="sub">' + esc(o.observed_on || '') + (o.place_guess ? ' · ' + esc(o.place_guess) : '') + '</div><img src="' + esc(ph.replace('square', 'medium')) + '" alt="" style="width:100%;border-radius:12px;margin:6px 0"><p class="hint">' + esc(o.photos[0].attribution || ('Photo: ' + ((o.user && o.user.login) || 'iNaturalist observer'))) + ' · via iNaturalist</p><div class="row-btns"><a class="btn" href="https://www.inaturalist.org/observations/' + o.id + '" target="_blank" rel="noopener">See on iNaturalist</a><button class="btn ghost" data-act="close">Close</button></div>'); });
    WILD.layer.addLayer(m);
  });
}
map.on('moveend', () => { if (S.settings.wildOn) { clearTimeout(WILD.t); WILD.t = setTimeout(() => drawWild(false), 1200); } if (S.settings.structOn) { clearTimeout(WILD.st); WILD.st = setTimeout(drawStruct, 900); } });
const STRUCT = { layer: L.layerGroup().addTo(map) };
async function drawStruct() {
  STRUCT.layer.clearLayers(); if (!S.settings.structOn || map.getZoom() < 12) return;
  const b = map.getBounds(), bb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], svc = map.getZoom() >= 14 ? 'enc_harbour' : 'enc_approach';
  try {
    const [w, o] = await Promise.all([encPoints(svc, 'wreck', bb).catch(() => []), encPoints(svc, 'obstr', bb).catch(() => [])]);
    STRUCT.layer.clearLayers();
    w.concat(o).forEach((p) => {
      const isW = p.kind === 'wreck', a = p.a, dep = a.VALSOU != null ? Math.round(+a.VALSOU / 0.3048) + ' ft over it' : '';
      const m = L.marker([p.lat, p.lon], { keyboard: false, icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="st-pin' + (isW ? ' w' : '') + '" title="' + (isW ? 'Wreck' : 'Obstruction') + '"></div>' }) });
      m.on('click', () => openSheet('<h3>' + (isW ? 'Wreck' : 'Obstruction') + '</h3><div class="sub">' + esc(a.OBJNAM || 'Charted by NOAA') + (dep ? ' · ' + dep : '') + '</div><p class="hint">Structure like this often holds fish, and it snags anchors and gear. From NOAA chart data; positions can be approximate.</p><div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>'));
      STRUCT.layer.addLayer(m);
    });
  } catch (e) { /* NOAA data unavailable */ }
}
sheet.addEventListener('change', (e) => {
  if (e.target.id === 'flNum' || e.target.id === 'flExp') { S.settings.fishLic = { num: ($('flNum').value || '').trim(), exp: $('flExp').value }; saveSettings(); toast('License saved on this device'); }
  if (e.target.id === 'fishTips') { S.settings.fishTips = e.target.checked; saveSettings(); }
});
sheet.addEventListener('click', (e) => {
  const t = e.target.closest('[data-fwtab]'); if (t) { openFishWild(t.dataset.fwtab); return; }
  const g = e.target.closest('[data-wgrp]'); if (g) { S.settings.wildGrp = g.dataset.wgrp; saveSettings(); openFishWild('wild'); if (S.settings.wildOn) drawWild(true); return; }
  const sp = e.target.closest('[data-wsp]'); if (sp) { wildHistogram(sp.dataset.wsp); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'wildmap') { S.settings.wildOn = !S.settings.wildOn; saveSettings(); drawWild(true); openFishWild('wild'); }
  if (b.dataset.act === 'fwstruct') { S.settings.structOn = !S.settings.structOn; saveSettings(); drawStruct(); openFishWild('fish'); }
  if (b.dataset.act === 'fwspots') { closeSheet(); setTab('nav'); }
});
setTimeout(() => { if (S.settings.wildOn) drawWild(true); if (S.settings.structOn) drawStruct(); }, 3000);

/* ---------- place names on land: plain, straight text from OpenStreetMap, thinned out as you zoom out ---------- */
const PLB = { tiles: new Map(Object.entries(store.get('plTiles', {}))), layer: L.layerGroup().addTo(map), busy: false, t: null };
const PL_MIN = { city: 8, town: 10, village: 11.5, suburb: 12.5, island: 12, hamlet: 13, neighbourhood: 13.5, locality: 14, cape: 12.5, peninsula: 12.5, bay: 12, point: 12.5 };
async function loadPlaceNames() {
  if (S.settings.landPlaces === false || map.getZoom() < 8 || PLB.busy) return;
  const st = 0.25, b = map.getBounds(), need = [];
  for (let la = Math.floor(b.getSouth() / st) * st; la < b.getNorth(); la += st) for (let lo = Math.floor(b.getWest() / st) * st; lo < b.getEast(); lo += st) { const k = la.toFixed(2) + ',' + lo.toFixed(2); if (!PLB.tiles.has(k)) need.push([la, lo, k]); }
  if (!need.length || need.length > 12) return;
  PLB.busy = true;
  try {
    for (const [la, lo, k] of need) {
      const bb = '(' + la.toFixed(2) + ',' + lo.toFixed(2) + ',' + (la + st).toFixed(2) + ',' + (lo + st).toFixed(2) + ')';
      const q = '[out:json][timeout:25];(node["place"~"^(city|town|village|suburb|hamlet|neighbourhood|island|locality)$"]["name"]' + bb + ';node["natural"~"^(cape|peninsula|bay)$"]["name"]' + bb + ';);out 400;';
      const j = await fetch(OVERPASS + encodeURIComponent(q)).then((r) => r.json());
      PLB.tiles.set(k, (j.elements || []).filter((e) => e.lat != null && e.tags && e.tags.name).map((e) => [e.lat, e.lon, e.tags.name, e.tags.place || e.tags.natural, +e.tags.population || 0]));
    }
    const o = {}; [...PLB.tiles.entries()].slice(-160).forEach(([k, v]) => { o[k] = v; }); store.set('plTiles', o);
  } catch (e) { /* offline: try again later */ }
  PLB.busy = false; drawPlaceNames();
}
function drawPlaceNames() {
  PLB.layer.clearLayers();
  if (S.settings.landPlaces === false) return;
  const z = map.getZoom(), b = map.getBounds(), list = [];
  PLB.tiles.forEach((v) => (v || []).forEach((p) => { if (p && p[0] != null && b.contains([p[0], p[1]]) && z >= (PL_MIN[p[3]] || 13)) list.push(p); }));
  const rank = (p) => ({ city: 0, town: 1, village: 2, island: 2, suburb: 3, cape: 3, peninsula: 3, bay: 3, hamlet: 4, neighbourhood: 5, locality: 6 }[p[3]] ?? 6) - Math.min(1, p[4] / 100000);
  list.sort((a, c) => rank(a) - rank(c));
  const boxes = [];
  list.forEach((p) => {
    const pt = map.latLngToContainerPoint([p[0], p[1]]), w = p[2].length * 6.6 + 8, box = [pt.x - w / 2, pt.y - 9, pt.x + w / 2, pt.y + 9];
    if (boxes.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) return; boxes.push(box);
    const cls = p[3] === 'city' || p[3] === 'town' ? 'big' : ['cape', 'peninsula', 'bay', 'island'].includes(p[3]) ? 'geo' : '';
    PLB.layer.addLayer(L.marker([p[0], p[1]], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="pl-name ' + cls + '">' + esc(p[2]) + '</span>' }) }));
  });
}
map.on('moveend', () => { clearTimeout(PLB.t); PLB.t = setTimeout(() => { drawPlaceNames(); loadPlaceNames(); }, 600); });
setTimeout(() => { drawPlaceNames(); loadPlaceNames(); }, 2000);

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
  const a = e.target.closest('[data-act="editboatair"]'); if (a) { e.preventDefault(); closeSheet(); setTab('boat'); boatEditing = true; renderBoat(); setTimeout(() => { const el = $('bAir'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }, 80); }
});
setInterval(checkBridgesAhead, 5000);


/* ---------- cockpit display: big, glanceable, tap-locked (iPad on deck) ---------- */
let cockTimer = null;
/* ---------- instrument gauges: glass-cockpit style, all text inside SVG so nothing is ever cut off ---------- */
const G = { cx: 100, cy: 100 };
function polar(r, deg) { const a = (deg - 90) * Math.PI / 180; return [G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)]; }
function arcPath(r, a0, a1) { const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1), large = a1 - a0 > 180 ? 1 : 0; return 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1); }
// a real-instrument bezel: polished ring (many-stop gradient reads as chrome, brass or gunmetal by theme), a dark seam, a lit face and a glass glare
const bezelSvg = (id, cx, r) => '<defs><linearGradient id="' + id + 'C" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" class="ch1"/><stop offset="0.18" class="ch2"/><stop offset="0.32" class="ch4"/><stop offset="0.48" class="ch1"/><stop offset="0.62" class="ch3"/><stop offset="0.8" class="ch2"/><stop offset="1" class="ch5"/></linearGradient><linearGradient id="' + id + 'I" x1="0" y1="1" x2="0" y2="0"><stop offset="0" class="ch1"/><stop offset="1" class="ch3"/></linearGradient><radialGradient id="' + id + 'F" cx="0.5" cy="0.32" r="0.78"><stop offset="0" class="fc1"/><stop offset="1" class="fc2"/></radialGradient><linearGradient id="' + id + 'G" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
  '<circle cx="' + cx + '" cy="' + cx + '" r="' + (r * 0.99) + '" fill="url(#' + id + 'C)" class="g-bezel"/><circle cx="' + cx + '" cy="' + cx + '" r="' + (r * 0.945) + '" fill="url(#' + id + 'I)"/><circle cx="' + cx + '" cy="' + cx + '" r="' + (r * 0.925) + '" fill="url(#' + id + 'F)" class="g-seam"/>' +
  bezelDec(cx, r) +
  gaugeArt(id, cx, r) +
  '<path d="M' + (cx - r * 0.8) + ' ' + (cx - r * 0.2) + ' A' + (r * 0.92) + ' ' + (r * 0.92) + ' 0 0 1 ' + (cx + r * 0.8) + ' ' + (cx - r * 0.2) + ' Q' + cx + ' ' + (cx - r * 0.42) + ' ' + (cx - r * 0.8) + ' ' + (cx - r * 0.2) + 'z" fill="url(#' + id + 'G)" class="g-glare"/>';
// decorations on the ring for some looks: a twisted rope, a carved Polynesian band (hidden unless the look turns them on)
function bezelDec(cx, r) {
  const R = r * 0.958, W = r * 0.068; let zz = '';
  for (let k = 0; k <= 60; k++) { const a = k / 60 * Math.PI * 2, rr = R + (k % 2 ? W * 0.34 : -W * 0.34); zz += (k ? ' L' : 'M') + (cx + Math.cos(a) * rr).toFixed(1) + ' ' + (cx + Math.sin(a) * rr).toFixed(1); }
  return '<g class="g-dec g-dec-rope"><circle cx="' + cx + '" cy="' + cx + '" r="' + R.toFixed(1) + '" class="gd-rope1" style="stroke-width:' + W.toFixed(1) + 'px"/><circle cx="' + cx + '" cy="' + cx + '" r="' + R.toFixed(1) + '" class="gd-rope2" style="stroke-width:' + W.toFixed(1) + 'px;stroke-dasharray:' + (W * 0.35).toFixed(1) + ' ' + (W * 0.45).toFixed(1) + '"/></g>' +
    '<g class="g-dec g-dec-carved"><circle cx="' + cx + '" cy="' + cx + '" r="' + R.toFixed(1) + '" class="gd-carve1" style="stroke-width:' + W.toFixed(1) + 'px"/><path d="' + zz + '" class="gd-carve2"/></g>';
}
// artwork inside the face, chosen by the gauge theme: glowing swirls (midnight, glass), topo lines (expedition), a compass rose (heritage), a horizon (bronze), soft swells (arctic)
function gaugeArt(id, cx, r) {
  const R = r * 0.9, P = (a, rr) => [(cx + Math.cos(a) * rr).toFixed(1), (cx + Math.sin(a) * rr).toFixed(1)];
  let sw = ''; for (let k = 0; k < 3; k++) { let d = ''; for (let q = 0; q <= 24; q++) { const f = q / 24, ang = -1.9 + k * 2.09 + f * 3.4, rr = R * (0.88 - f * 0.5) * (1 + 0.06 * Math.sin(f * 9 + k)), [x, y] = P(ang, rr); d += (q ? ' L' : 'M') + x + ' ' + y; } sw += '<path d="' + d + '" class="ga-sw ga-sw' + k + '"/>'; }
  let topo = ''; for (let k = 1; k <= 5; k++) { const rr = R * (0.18 * k), wob = r * 0.04; topo += '<path d="M' + (cx - rr) + ' ' + (cx + wob) + ' Q' + (cx - rr * 0.4) + ' ' + (cx - rr - wob) + ' ' + cx + ' ' + (cx - rr * 0.9) + ' T' + (cx + rr) + ' ' + (cx - wob) + ' Q' + (cx + rr * 0.5) + ' ' + (cx + rr) + ' ' + cx + ' ' + (cx + rr * 0.95) + ' T' + (cx - rr) + ' ' + (cx + wob) + '" class="ga-topo"/>'; }
  const rose = '<path d="M' + cx + ' ' + (cx - R * 0.85) + ' L' + (cx + R * 0.1) + ' ' + cx + ' L' + cx + ' ' + (cx + R * 0.85) + ' L' + (cx - R * 0.1) + ' ' + cx + 'Z M' + (cx - R * 0.85) + ' ' + cx + ' L' + cx + ' ' + (cx - R * 0.1) + ' L' + (cx + R * 0.85) + ' ' + cx + ' L' + cx + ' ' + (cx + R * 0.1) + 'Z" class="ga-rose"/>';
  const hz = '<path d="M' + (cx - R) + ' ' + (cx + R * 0.32) + ' Q' + cx + ' ' + (cx + R * 0.22) + ' ' + (cx + R) + ' ' + (cx + R * 0.32) + '" class="ga-hz"/><circle cx="' + cx + '" cy="' + (cx + R * 0.36) + '" r="' + (R * 0.28) + '" class="ga-sun"/>';
  let sl = ''; for (let k = 0; k < 3; k++) { const y = cx + R * (0.35 + k * 0.17); sl += '<path d="M' + (cx - R) + ' ' + y + ' q' + (R * 0.25) + ' ' + (-r * 0.06) + ' ' + (R * 0.5) + ' 0 t' + (R * 0.5) + ' 0 t' + (R * 0.5) + ' 0 t' + (R * 0.5) + ' 0" class="ga-swell"/>'; }
  let wood = ''; for (let k = -5; k <= 5; k++) { const y = cx + k * R * 0.17; wood += '<path d="M' + (cx - R) + ' ' + y.toFixed(1) + ' C' + (cx - R * 0.4) + ' ' + (y - r * 0.05).toFixed(1) + ' ' + (cx + R * 0.2) + ' ' + (y + r * 0.06).toFixed(1) + ' ' + (cx + R) + ' ' + (y - r * 0.02).toFixed(1) + '" class="ga-grain"/>'; }
  let weave = ''; for (let k = -10; k <= 10; k++) { const o2 = k * R * 0.1; weave += '<path d="M' + (cx - R + o2) + ' ' + (cx - R) + ' l' + (2 * R) + ' ' + (2 * R) + '" class="ga-weave"/><path d="M' + (cx + R + o2) + ' ' + (cx - R) + ' l' + (-2 * R) + ' ' + (2 * R) + '" class="ga-weave"/>'; }
  const wv = (y0, amp) => 'M' + (cx - R) + ' ' + y0 + ' q' + (R * 0.25) + ' ' + (-amp) + ' ' + (R * 0.5) + ' 0 t' + (R * 0.5) + ' 0 t' + (R * 0.5) + ' 0 t' + (R * 0.5) + ' 0 V' + (cx + R) + ' H' + (cx - R) + 'Z';
  const deep = '<path d="' + wv(cx + R * 0.42, r * 0.07) + '" class="ga-deep1"/><path d="' + wv(cx + R * 0.58, r * 0.06) + '" class="ga-deep2"/>';
  return '<defs><filter id="' + id + 'B" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="' + (r * 0.025).toFixed(2) + '"/></filter><clipPath id="' + id + 'K"><circle cx="' + cx + '" cy="' + cx + '" r="' + (r * 0.92) + '"/></clipPath></defs>' +
    '<g class="g-art" clip-path="url(#' + id + 'K)"><g class="ga-woods">' + wood + '</g><g class="ga-carbons">' + weave + '</g><g class="ga-deeps">' + deep + '</g><g class="ga-swirl"><g filter="url(#' + id + 'B)">' + sw + '</g>' + sw + '</g><g class="ga-topos">' + topo + '</g><g class="ga-roses">' + rose + '</g><g class="ga-hzs">' + hz + '</g><g class="ga-swells">' + sl + '</g></g>';
}
let BZN = 0; // each gauge gets its own gradient ids: a gradient inside a hidden panel would otherwise blank every bezel that points at it
function gWrap(label, svg, foot, cls, tip) { return '<div class="gauge' + (cls ? ' ' + cls : '') + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><div class="g-lbl">' + label + '</div><svg viewBox="0 0 200 200" aria-hidden="true">' + bezelSvg('gb' + (++BZN % 100000), 100, 100) + svg + '</svg><div class="g-foot">' + (foot || '&nbsp;') + '</div></div>'; }
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
  const t = S.tide, now = Date.now(), ts = tideState() || {}, h = (t.hourly || []).filter((x) => x.t >= now - 6 * 3600000 && x.t <= now + 6 * 3600000);
  let curve = '', dot = '';
  if (h.length > 3) {
    const lo = Math.min(...h.map((x) => x.v)), hi = Math.max(...h.map((x) => x.v)), X = (x) => 38 + (x - (now - 6 * 3600000)) / (12 * 3600000) * 124, Y = (v) => 150 - (v - lo) / Math.max(0.3, hi - lo) * 34;
    curve = '<path d="' + h.map((x, i) => (i ? 'L' : 'M') + X(x.t).toFixed(1) + ' ' + Y(x.v).toFixed(1)).join('') + '" class="g-tidecurve"/><line x1="100" x2="100" y1="112" y2="156" class="g-tidenow"/>';
    dot = '<circle cx="100" cy="' + Y(tn.v).toFixed(1) + '" r="4.5" class="g-dot"/>';
  }
  const col = ts.short === 'FLOOD' ? 'flood' : ts.short === 'EBB' ? 'ebb' : 'slack';
  const nx = tn.next, mins = nx ? Math.round((nx.t - now) / 60000) : null, cd = mins == null ? '' : (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm');
  return '<text x="100" y="52" class="g-state ' + col + '">' + (ts.short || '') + (ts.short === 'FLOOD' ? ' ▲' : ts.short === 'EBB' ? ' ▼' : '') + '</text>' +
    '<text x="100" y="92" class="g-big sm">' + tideLen(tn.v).split(' ')[0] + '</text><text x="100" y="108" class="g-unit">' + lenUnit() + (nx ? ' · ' + (nx.type === 'H' ? 'high' : 'low') + ' in ' + cd : '') + '</text>' + curve + dot;
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
const CK_OPTS = [['speed', 'Speed'], ['depth', 'Depth'], ['course', 'Course (compass)'], ['wind', 'Wind'], ['tide', 'Tide'], ['dest', 'To destination'], ['anchor', 'Anchor watch'], ['position', 'GPS position'], ['eta', 'Time to go (whole route)'], ['time', 'Time and sun'], ['waves', 'Waves'], ['trip', 'Trip distance and time'], ['temps', 'Air and water temperature'], ['baro', 'Barometer'], ['weather', 'Weather now and next'], ['photo', 'Boat photo'], ['alerts', 'Weather warnings'], ['chart', 'Small chart'], ['off', 'Off']];
if (!S.settings.depthIn) { ['sideSlots', 'ckSlots'].forEach((k) => { const a = S.settings[k]; if (Array.isArray(a) && !a.includes('depth')) a.splice(1, 0, 'depth'); }); S.settings.depthIn = 1; try { saveSettings(); } catch (e) { /* later */ } }
(() => { const a = S.settings.ckSlots; if (Array.isArray(a) && a.filter((x) => x === 'chart').length > 1) { let seen = false; S.settings.ckSlots = a.filter((x) => { if (x !== 'chart') return true; if (seen) return false; seen = true; return true; }); saveSettings(); } })();
function ckSlots() { const sl = S.settings.ckSlots; return Array.isArray(sl) && sl.length ? sl : ['speed', 'depth', 'wind', 'auto']; }
/* charted depth where the boat is (or the chart centre): NOAA ENC depth area, plus the predicted tide. Not a sounder. */
const DEP = { at: 0, pos: null, v: null, busy: false, err: false };
async function maybeDepth() {
  const f = S.fix || refPos(); if (!f || DEP.busy) return;
  if (DEP.pos && distNm(DEP.pos, f) < 0.03 && Date.now() - DEP.at < 600000) return;
  if (Date.now() - DEP.at < 15000 && DEP.pos) return;
  DEP.busy = true; DEP.at = Date.now();
  const e = 0.00015, bb = [f.lon - e, f.lat - e, f.lon + e, f.lat + e];
  let best = null;
  for (const svc of ['enc_harbour', 'enc_approach', 'enc_coastal']) {
    try { const d = await encQuery(svc, 'depth', bb, 0.0001); const hit = d.filter((x) => x.d1 != null); if (hit.length) { best = hit.reduce((m, x) => (x.d1 < m.d1 ? x : m)); best.svc = svc; break; } } catch (err) { DEP.err = true; }
  }
  DEP.v = best; DEP.pos = { lat: f.lat, lon: f.lon }; DEP.busy = false; if (best) DEP.err = false;
  try { renderSide(); if (!$('cockpit').hidden) renderCockpit(); } catch (err) { /* not shown */ }
}
function depthGauge() {
  const d = DEP.v, tn = tideNow(), tide = tn ? tn.v : 0;
  const need = S.boat.draftFt ? S.boat.draftFt + (S.boat.safetyFt == null ? 2 : S.boat.safetyFt) : null;
  if (!d) return gWrap('DEPTH', '<circle cx="100" cy="100" r="84" class="g-ring"/><text x="100" y="96" class="g-unit">' + (DEP.busy || !DEP.pos ? 'Reading the chart…' : DEP.err ? 'NOAA chart not reachable' : 'No charted depth here') + '</text><text x="100" y="120" class="g-unit">no sounder connected</text>', 'Charted depth · NOAA');
  const lo = d.d1 / 0.3048 + tide, hi = d.d2 != null ? d.d2 / 0.3048 + tide : null;
  const top = Math.max(20, (need || 6) * 3), frac = Math.min(1, Math.max(0, lo / top)), A0 = -135, A1 = 135, a = A0 + (A1 - A0) * frac;
  const bad = need && lo < need, warn = need && !bad && lo < need + 3;
  const lim = need ? A0 + (A1 - A0) * Math.min(1, need / top) : null;
  return gWrap('DEPTH', '<path d="' + arcPath(84, A0, A1) + '" class="g-track"/>' + (lim ? '<path d="' + arcPath(84, A0, lim) + '" class="g-danger"/>' : '') + '<path d="' + arcPath(84, A0, a) + '" class="g-fill' + (bad ? ' bad' : warn ? ' warnf' : ' depth') + '"/>' +
    '<text x="100" y="112" class="g-big sm">' + Math.round(ftToLen(lo)) + (hi && hi - lo > 1 ? '<tspan class="g-plus">+</tspan>' : '') + '</text><text x="100" y="134" class="g-unit">' + lenUnit() + ' · charted' + (tn ? ' + tide' : '') + '</text>' +
    (need ? '<text x="100" y="160" class="g-unit">' + (bad ? 'SHALLOW' : 'need ' + Math.round(ftToLen(need))) + '</text>' : ''),
    'NOAA chart ' + Math.round(ftToLen(d.d1 / 0.3048)) + (d.d2 != null ? '–' + Math.round(ftToLen(d.d2 / 0.3048)) : '') + ' ' + lenUnit() + (tn ? ' ' + (tide >= 0 ? '+' : '') + tide.toFixed(1) + ' tide' : '') + ' · not a sounder', bad ? 'g-alarm' : '');
}
/* ---------- weather warnings from the National Weather Service: tornado, special marine, thunderstorm, gale and small craft ---------- */
const ALR = { list: [], at: 0, seen: new Set(store.get('alrSeen', [])), hide: new Set(store.get('alrHidden', [])), read: new Set(store.get('alrRead', [])), busy: false };
const ALR_LOUD = /tornado|special marine|severe thunderstorm|hurricane|tropical storm|storm warning|gale warning|waterspout|tsunami|extreme wind/i;
// Colour by how serious it is, the way weather apps do: red severe, orange watch or moderate, blue minor advisory, green statement
function alrClass(a) {
  const e = a.event || '', sv = a.severity || '';
  if (/tornado|severe thunderstorm|special marine|hurricane|tropical storm|storm warning|gale warning|high wind warning|extreme wind|waterspout|tsunami|flash flood warning/i.test(e) || (/warning/i.test(e) && /extreme|severe/i.test(sv))) return 'warn';
  if (/watch/i.test(e) || /warning/i.test(e) || /small craft|gale|wind advisory|hazardous seas/i.test(e) || /moderate/i.test(sv)) return 'watch';
  if (/advisory/i.test(e) || /minor/i.test(sv)) return 'adv';
  return 'info';
}
const ALR_RANK = { warn: 0, watch: 1, adv: 2, info: 3 }, ALR_WORD = { warn: 'Severe', watch: 'Watch', adv: 'Advisory', info: 'Statement' }, ALR_SHORT = { warn: 'WARNING', watch: 'WATCH', adv: 'NOTICE', info: 'INFO' };
// A changed bulletin is new even when NWS retains the same alert identifier.
function alertKey(a) {
  const text = JSON.stringify([a.id, a.sent, a.event, a.severity, a.urgency, a.certainty, a.headline, a.description, a.instruction, a.ends, a.expires]);
  let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return String(a.id || 'alert') + ':' + (hash >>> 0).toString(16);
}
function saveAlertState() {
  store.set('alrRead', [...ALR.read].slice(-160)); store.set('alrHidden', [...ALR.hide].slice(-160));
}
async function checkAlerts() {
  const c = S.fix || refPos(); if (!c || ALR.busy) return;
  if (!(c.lat > 17 && c.lat < 72 && c.lon < -60 && c.lon > -180)) { ALR.list = []; renderAlertBar(); return; } // NWS covers US waters
  ALR.busy = true;
  try {
    const j = await fetchT('https://api.weather.gov/alerts/active?point=' + c.lat.toFixed(4) + ',' + c.lon.toFixed(4), 15000).then((r) => r.json());
    ALR.list = (j.features || []).map((f) => f.properties).filter((p) => p && p.status === 'Actual' && p.event).sort((a, b) => ALR_RANK[alrClass(a)] - ALR_RANK[alrClass(b)]);
    ALR.at = Date.now();
    ALR.list.forEach((a) => { if (!ALR.seen.has(alertKey(a))) { ALR.seen.add(alertKey(a)); if (ALR_TAKEOVER.test(a.event) || (/warning/i.test(a.event) && /extreme/i.test(a.severity || ''))) severeTakeover(a); else if (ALR_LOUD.test(a.event) && /warning/i.test(a.event)) { beep(3); headsUp('Weather warning. ' + a.event + '.'); toast('⚠ ' + a.event + ': tap the alert for details', 8000); } } });
    store.set('alrSeen', [...ALR.seen].slice(-80));
  } catch (e) { /* offline or outside NWS coverage */ }
  ALR.busy = false; renderAlertBar();
}
// life-threatening warnings take over the screen: red, flashing, with what to do now
const ALR_TAKEOVER = /tornado warning|hurricane warning|extreme wind warning|tsunami warning|storm surge warning|special marine warning|severe thunderstorm warning|flash flood emergency|tropical storm warning/i;
// a picture of what the alert is about; the ring around it shows how serious
const ALR_ICONS = [
  [/tornado|waterspout/i, '<path d="M3 4h18M5 8h14M7.5 12h9M10 16h5M11.5 20h2"/>'],
  [/hurricane|tropical|typhoon/i, '<circle cx="12" cy="12" r="2.4"/><path d="M12 9.6C12 5 15 3 19 3c-2 1.4-3 3.4-3 6M12 14.4c0 4.6-3 6.6-7 6.6 2-1.4 3-3.4 3-6M9.6 12C5 12 3 9 3 5c1.4 2 3.4 3 6 3M14.4 12c4.6 0 6.6 3 6.6 7-1.4-2-3.4-3-6-3"/>'],
  [/thunder|lightning|special marine/i, '<path d="M13.5 2 5 13.5h6L9.5 22 19 9.5h-6.2z" class="ai-fill"/>'],
  [/flood|surge|coastal|tsunami|high water/i, '<path d="M12 3c3 4.2 5 7.2 5 9.6a5 5 0 0 1-10 0C7 10.2 9 7.2 12 3z"/><path d="M2 20c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0"/>'],
  [/fog|smoke|haze|air quality|ash/i, '<path d="M3 8h13M6 12h15M3 16h13M7 20h10"/>'],
  [/snow|winter|blizzard|ice|freez|frost|sleet/i, '<path d="M12 2v20M3.3 7l17.4 10M20.7 7 3.3 17M9 4l3 2 3-2M9 20l3-2 3 2"/>'],
  [/heat/i, '<path d="M12 3v11.5a3 3 0 1 1-2 0V3a1 1 0 0 1 2 0z"/><path d="M15 6h3M15 9h3M15 12h2"/>'],
  [/seas|surf|rip current|beach|swell/i, '<path d="M2 15c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5 0M2 20c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5 0M7 10c0-3 2.5-5.5 5.5-5.5"/>'],
  [/wind|gale|small craft|storm warning|blow/i, '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>']
];
function alrIcon(a) { const hit = ALR_ICONS.find(([re]) => re.test(a.event || '')); return '<svg class="alr-ic" viewBox="0 0 24 24" aria-hidden="true">' + (hit ? hit[1] : '<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17v.5"/>') + '</svg>'; }
function severeTakeover(a) {
  let el = $('severe'); if (!el) { el = document.createElement('div'); el.id = 'severe'; el.className = 'severe'; document.body.appendChild(el); }
  const moving = (S.sog || 0) > 1.5, tornado = /tornado|waterspout|extreme wind/i.test(a.event), marine = /special marine|thunderstorm/i.test(a.event), tropical = /hurricane|tropical|surge/i.test(a.event);
  const act = tornado ? (moving ? 'Get off the water now if you can reach a harbor in minutes. Otherwise: everyone in life jackets, below decks, away from the mast and windows. Drop the sails.' : 'Seek shelter now in a sturdy building, lowest floor, interior room. A boat is not a safe shelter.')
    : marine ? (moving ? 'Head for the nearest safe harbor now. Reduce sail or drop it, everyone in life jackets, clip on, secure loose gear. Expect sudden violent gusts, lightning and hail.' : 'Stay in port. Double your dock lines and fenders. Stay off the boat if lightning is close.')
    : tropical ? 'Follow local evacuation orders. Secure or haul the boat; do not stay aboard. Get to safe shelter inland.' : 'Take action now. Get to a safe harbor or shelter.';
  el.innerHTML = '<div class="sv-in"><div class="sv-ic">' + alrIcon(a) + '</div><div class="sv-ev">' + esc(a.event.toUpperCase()) + '</div><div class="sv-do">' + (tornado ? 'SEEK SHELTER NOW' : marine ? 'GET TO SAFE HARBOR' : 'TAKE ACTION NOW') + '</div><p>' + esc(act) + '</p>' + (a.headline ? '<p class="sv-h">' + esc(a.headline) + '</p>' : '') + (a.ends || a.expires ? '<p class="sv-h">Until ' + fmtClock(Date.parse(a.ends || a.expires)) + '</p>' : '') +
    '<p class="sv-h">Monitor VHF 16 and NOAA Weather Radio. Mayday on VHF 16 if anyone is in danger.</p><div class="sv-btns"><button class="btn" data-sv="read">Read the full warning</button><button class="btn primary" data-sv="ok">I understand</button></div></div>';
  el.hidden = false; try { beep(5); if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 800]); } catch (e) { /* no sound */ }
  headsUp(a.event + '. ' + (tornado ? 'Seek shelter now.' : marine ? 'Get to a safe harbor.' : 'Take action now.'));
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-sv]'); if (!b) return; $('severe').hidden = true; if (b.dataset.sv === 'read') openAlerts(); });
function dismissWeatherAlert(key) {
  ALR.hide.add(key); ALR.read.add(key); saveAlertState(); renderAlertBar();
}
function renderAlertBar() {
  let el = $('alertBar');
  if (!el) {
    el = document.createElement('button'); el.type = 'button'; el.id = 'alertBar'; $('app').appendChild(el);
    el.addEventListener('click', (e) => { const x = e.target.closest('[data-abx]'); if (x) { e.stopPropagation(); dismissWeatherAlert(x.dataset.abx); return; } openAlerts(); });
  }
  const nowT = Date.now(); ALR.list = ALR.list.filter((x) => { const e = Date.parse(x.ends || x.expires || ''); return !e || e > nowT; }); // expired bulletins go, even offline
  const live = ALR.list.filter((x) => !ALR.hide.has(alertKey(x)));
  const unread = live.filter((x) => !ALR.read.has(alertKey(x))), a = unread[0] || live[0];
  if (!a) { el.hidden = true; return; }
  const fresh = unread.length > 0, big = fresh && /warning/i.test(a.event) && ALR_LOUD.test(a.event);
  const want = big ? $('app') : $('fabs'); if (el.parentNode !== want) want.appendChild(el);
  el.hidden = false; el.className = 'alert-bar ' + alrClass(a) + (big ? '' : ' mini') + (fresh ? ' is-new' : '') + (fresh || alrClass(a) === 'warn' ? ' pulse' : '');
  const label = (fresh ? 'New weather alert: ' : 'Weather alert: ') + a.event + '. Tap to read.';
  el.title = label; el.dataset.tip = label; el.setAttribute('aria-label', label);
  el.innerHTML = big ? '<b>' + alrIcon(a) + ' ' + esc(a.event) + '</b><span>' + (a.ends || a.expires ? 'until ' + fmtClock(Date.parse(a.ends || a.expires)) : '') + '</span><i class="ab-x" data-abx="' + esc(alertKey(a)) + '" title="Dismiss this bulletin">×</i>' : '<b aria-hidden="true">' + alrIcon(a) + '</b><small>' + 'WX' + '</small>';
}
function openAlerts() {
  ALR.list.forEach((a) => ALR.read.add(alertKey(a))); saveAlertState(); renderAlertBar();
  openSheet('<h3>Weather alerts here</h3><div class="sub">National Weather Service · checked ' + (ALR.at ? agoTxt(ALR.at) : 'not yet') + '</div>' + (ALR.list.length ? ALR.list.map((a) => {
    const key = alertKey(a), hidden = ALR.hide.has(key);
    return '<div class="alr ' + alrClass(a) + '"><span class="alr-tag">' + ALR_WORD[alrClass(a)] + '</span><b>' + alrIcon(a) + ' ' + esc(a.event) + '</b><div class="sub">' + esc(a.headline || '') + '</div>' + (a.instruction ? '<p><b>What to do:</b> ' + esc(a.instruction) + '</p>' : '') + '<details><summary>Full text</summary><p style="white-space:pre-wrap">' + esc(a.description || '') + '</p></details><div class="row-btns"><button class="btn small primary" data-weather-dismiss="' + esc(key) + '"' + (hidden ? ' disabled' : '') + '>' + (hidden ? 'Cleared from chart' : 'Clear alert') + '</button>' + (hidden ? '' : '<button class="btn small" data-act="close">Keep it on the chart, stop flashing</button>') + '</div><p class="hint">A new or changed bulletin will appear again.</p></div>';
  }).join('') : '<p class="sub">No active alerts received for this location.</p>') + '<p class="hint">Dismissed bulletins remain here while active. Also monitor NOAA Weather Radio on VHF WX channels.</p><div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>');
}
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-weather-dismiss]'); if (d) { dismissWeatherAlert(d.dataset.weatherDismiss); openAlerts(); return; }
  if (e.target.closest('[data-weather-alerts]')) openAlerts();
});
setTimeout(checkAlerts, 3500); setInterval(checkAlerts, 5 * 60000);
const WMO = { 0: ['Clear', '☀'], 1: ['Mostly clear', '🌤'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁'], 45: ['Fog', '🌫'], 48: ['Freezing fog', '🌫'], 51: ['Light drizzle', '🌦'], 53: ['Drizzle', '🌦'], 55: ['Heavy drizzle', '🌧'], 61: ['Light rain', '🌦'], 63: ['Rain', '🌧'], 65: ['Heavy rain', '🌧'], 71: ['Light snow', '🌨'], 73: ['Snow', '🌨'], 75: ['Heavy snow', '❄'], 80: ['Showers', '🌦'], 81: ['Showers', '🌧'], 82: ['Violent showers', '⛈'], 95: ['Thunderstorms', '⛈'], 96: ['Thunderstorms, hail', '⛈'], 99: ['Severe thunderstorms', '⛈'] };
const wmo = (c) => WMO[c] || WMO[Math.floor((c || 0) / 10) * 10] || ['', ''];
// barometer: pressure now and its 3-hour trend. A fall of 3 hPa or more in 3 hours means wind and weather are on the way.
function baroTrend() {
  const w = S.weather; if (!w || !w.press || !w.press.length) return null;
  const now = Date.now(), at = (t) => { let b = null; w.press.forEach((x) => { if (x.p != null && (!b || Math.abs(x.t - t) < Math.abs(b.t - t))) b = x; }); return b && Math.abs(b.t - t) < 2 * 3600000 ? b.p : null; };
  const p = w.cur && w.cur.p != null ? w.cur.p : at(now), p3 = at(now - 3 * 3600000), n3 = at(now + 3 * 3600000);
  if (p == null) return null;
  const d = p3 != null ? p - p3 : null, f = n3 != null ? n3 - p : null;
  const word = d == null ? '' : d <= -3 ? 'falling fast' : d <= -1 ? 'falling' : d >= 3 ? 'rising fast' : d >= 1 ? 'rising' : 'steady';
  return { p, d, f, word, warn: (d != null && d <= -3) || (f != null && f <= -3) };
}
function baroMeaning(b) {
  if (!b || b.d == null) return { short: '', long: 'Barometric pressure. Watch the trend: falling pressure brings wind and weather, rising pressure brings clearing.' };
  const low = b.p < 1000 ? ' Pressure is low: a storm system is close.' : b.p > 1025 ? ' Pressure is high: settled weather.' : '';
  if (b.d <= -3) return { short: 'Storm likely within hours', long: 'Falling fast (3 hPa or more in 3 hours): strong wind, squalls or storms likely within hours. Reef early, secure the boat, head in if exposed.' + low };
  if (b.d <= -1) return { short: 'Worsening: more wind coming', long: 'Falling: weather is worsening. Expect more wind, clouds and possibly rain in the next 6 to 24 hours.' + low };
  if (b.d >= 3) return { short: 'Clearing, gusty winds', long: 'Rising fast: clearing behind a front, but a burst of strong, gusty wind often comes with it.' + low };
  if (b.d >= 1) return { short: 'Improving, clearing', long: 'Rising: weather improving and clearing.' + low };
  return { short: 'Little change expected', long: 'Steady: little change in the weather expected for now.' + low };
}
const inHg = () => S.settings.speedUnit === 'kn' || S.settings.speedUnit === 'mph';
// a real aneroid barometer face: Stormy · Rain · Change · Fair · Very dry, a black hand for now and a brass set hand for 3 hours ago
function aneroidGauge(b) {
  const lo = 960, hi = 1050, A0 = -135, A1 = 135, ang = (p) => A0 + (A1 - A0) * Math.max(0, Math.min(1, (p - lo) / (hi - lo)));
  let t = '';
  for (let p = lo; p <= hi; p += 2) { const big = p % 10 === 0, [x0, y0] = polar(big ? 74 : 79, ang(p)), [x1, y1] = polar(86, ang(p)); t += '<line x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y2="' + y1.toFixed(1) + '" class="g-tick' + (big ? ' big' : '') + '"/>'; if (big && p % 20 === 0) { const [tx, ty] = polar(63, ang(p)); t += '<text x="' + tx.toFixed(1) + '" y="' + (ty + 4).toFixed(1) + '" class="g-num">' + (inHg() ? (p * 0.02953).toFixed(1) : p) + '</text>'; } }
  const words = [['STORMY', 976, 34, -10], ['RAIN', 990, 44], ['CHANGE', 1006, 46], ['FAIR', 1022, 44], ['VERY DRY', 1034, 34, 10]].map(([w, p, r, rot]) => { const [x, y] = polar(r, ang(p)); return '<text x="' + x.toFixed(1) + '" y="' + (y + 3).toFixed(1) + '" class="g-baro-w" transform="rotate(' + (rot != null ? rot : ang(p) * 0.55).toFixed(0) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')">' + w + '</text>'; }).join('');
  const hand = (p, cls, len) => { const [x, y] = polar(len, ang(p)), [bx, by] = polar(-14, ang(p)); return '<line x1="' + bx.toFixed(1) + '" y1="' + by.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="' + cls + '"/>'; };
  const before = b.d != null ? b.p - b.d : null, val = inHg() ? (b.p * 0.02953).toFixed(2) : Math.round(b.p);
  return t + words + (before != null ? hand(before, 'g-baro-set', 70) : '') + hand(b.p, 'g-baro-hand' + (b.warn ? ' bad' : ''), 78) + '<circle cx="100" cy="100" r="7" class="g-hub"/>' +
    '<text x="100" y="158" class="g-unit g-baro-v">' + val + ' ' + (inHg() ? 'inHg' : 'hPa') + '</text>' + (b.word ? '<text x="100" y="172" class="g-unit g-baro-v sm">' + esc(b.word) + '</text>' : '');
}
function baroGauge(b) {
  if ((S.settings.gStyle || 'hybrid') !== 'digital') return aneroidGauge(b);
  const lo = 980, hi = 1040, A0 = -135, A1 = 135, a = A0 + (A1 - A0) * Math.max(0, Math.min(1, (b.p - lo) / (hi - lo)));
  const [px, py] = polar(84, a), val = inHg() ? (b.p * 0.02953).toFixed(2) : Math.round(b.p), unit = inHg() ? 'inHg' : 'hPa';
  const arrow = b.d == null ? '' : b.d <= -1 ? '▼' : b.d >= 1 ? '▲' : '▶';
  return '<path d="' + arcPath(84, A0, A1) + '" class="g-track"/><path d="' + arcPath(84, A0, a) + '" class="g-fill' + (b.warn ? ' bad' : '') + '"/><circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="6" class="g-dot"/>' +
    '<text x="100" y="108" class="g-big sm">' + val + '</text><text x="100" y="132" class="g-unit">' + unit + ' · ' + arrow + ' ' + esc(b.word || '') + '</text>' + (b.d != null ? '<text x="100" y="156" class="g-unit">' + (b.d > 0 ? '+' : '') + b.d.toFixed(1) + ' hPa in 3 h</text>' : '');
}
const CK_FALL = new Set();
function ckGauge(id) {
  const w = S.weather, tn = tideNow(), ob = nearestObs(), moving = (S.sog || 0) > 0.6;
  if (id === 'auto') id = S.goto && S.fix ? 'dest' : 'tide';
  if ((id === 'dest' || id === 'eta') && !(S.goto && S.fix)) { // not navigating: these slots show the basics instead of sitting empty
    const shown = ckSlots().concat(S.settings.sideSlots || []), alt = (S.settings.ckIdle ? [S.settings.ckIdle] : []).concat(['tide', 'wind', 'baro', 'weather', 'depth', 'time', 'waves']).find((x) => !shown.includes(x) && !CK_FALL.has(x)) || 'time'; CK_FALL.add(alt);
    return ckGauge(alt).replace('<div class="g-lbl">', '<div class="g-lbl"><i class="g-idle" title="Shows your destination when you navigate">◇</i> ');
  }
  if (id === 'eta') {
    const r = S.goto.route, pts = r ? r.pts.slice(r.i) : [S.goto], spd = (S.sog || 0) > 0.6 ? S.sog : navSpeed();
    let d = distNm(S.fix, pts[0]); for (let i = 1; i < pts.length; i++) d += distNm(pts[i - 1], pts[i]);
    const hrs = d / spd, stops = r ? pts.filter((p) => !p.turn).length : 1, [dv, du] = distParts(d), legs = r ? r.pts.length : 1;
    return gWrap('TIME TO GO', '<path d="' + arcPath(84, -135, 135) + '" class="g-track"/><path d="' + arcPath(84, -135, -135 + 270 * (r ? Math.min(1, r.i / Math.max(1, legs - 1)) : 0)) + '" class="g-fill"/><text x="100" y="104" class="g-big sm">' + fmtDur(hrs).replace(' min', 'm') + '</text><text x="100" y="128" class="g-unit">' + dv + ' ' + du + ' · ' + stops + ' stop' + (stops === 1 ? '' : 's') + ' left</text><text x="100" y="150" class="g-unit">arrive ' + fmtClock(Date.now() + hrs * 3600000) + '</text>', 'At ' + fmtSpeed(spd) + ' ' + SPEED_LBL[S.settings.speedUnit] + ((S.sog || 0) > 0.6 ? ' (your speed now)' : ' (your usual speed)'));
  }
  if (id === 'speed') { const hs = hullSpeed(); const top = S.settings.boatType === 'power' ? (S.trip && S.trip.max > 30 ? 50 : 40) : hs ? Math.max(8, Math.ceil(hs.kn * 1.4 / 2) * 2) : 10; return gWrap('SPEED', speedGauge(S.fix ? S.sog || 0 : null, S.trip && S.trip.max, top), S.trip && S.trip.max ? 'Max ' + fmtSpeed(S.trip.max) + ' · GPS' : 'Speed over ground · GPS'); }
  if (id === 'depth') { maybeDepth(); return depthGauge(); }
  if (id === 'baro') { const b = baroTrend(), bm = baroMeaning(b); return b ? gWrap('BAROMETER', baroGauge(b), '<b class="' + (b.warn ? 'warn-t' : '') + '">' + esc(bm.short || 'Sea-level pressure') + '</b> · model, Open-Meteo', b.warn ? 'g-alarm' : '', bm.long) : gWrap('BAROMETER', '<text x="100" y="108" class="g-unit">Waiting for pressure data</text>', ''); }
  if (id === 'weather') {
    const c = w && w.cur; if (!c) return gWrap('WEATHER', '<text x="100" y="108" class="g-unit">Waiting for the forecast</text>', '');
    const [txt, ic] = wmo(c.code), now = Date.now(), hrs = (w.press || []).filter((x) => x.t > now - 1800000).slice(0, 12);
    // a weather clock: the next 12 hours around the dial, coloured by sky, rain and storms
    const segCol = (code) => code >= 95 ? '#B04CE0' : code >= 61 || (code >= 51 && code < 60) || code >= 80 ? '#3C8FE0' : code >= 45 && code < 50 ? '#9AA6B0' : code >= 3 ? '#7C8A96' : code >= 2 ? '#B8C4CC' : '#F2C14E';
    const segs = hrs.map((x, i) => '<path d="' + arcPath(84, i * 30 + 2, i * 30 + 28) + '" style="stroke:' + segCol(x.code) + '" class="g-wxseg"/>').join('');
    const lbl = hrs.map((x, i) => [x, i]).filter(([, i]) => i === 0 || i === 3 || i === 9).map(([x, i]) => { const [px, py] = polar(66, i * 30 + 15); return '<text x="' + px.toFixed(0) + '" y="' + (py + 4).toFixed(0) + '" class="g-num">' + (i === 0 ? 'now' : new Date(x.t).toLocaleTimeString([], { hour: 'numeric' }).replace(/\s?(AM|PM)/i, (m) => m.trim()[0].toLowerCase())) + '</text>'; }).join('');
    const b = baroTrend();
    return gWrap('WEATHER', segs + lbl + '<text x="100" y="84" class="g-wxic">' + ic + '</text><text x="100" y="114" class="g-big xs">' + tempTxt(c.temp) + '</text><text x="100" y="131" class="g-unit">air' + (() => { const wt = S.waterObs && Date.now() - S.waterObs.t < 3 * 3600000 ? S.waterObs.f : w.sst; return wt != null ? ' · water ' + tempTxt(wt) : ''; })() + '</text><text x="100" y="148" class="g-unit">' + esc(txt) + '</text>' + (b ? '<text x="100" y="165" class="g-unit">' + (inHg() ? (b.p * 0.02953).toFixed(2) + ' inHg' : Math.round(b.p) + ' hPa') + ' ' + (b.d == null ? '' : b.d <= -1 ? '▼' : b.d >= 1 ? '▲' : '▶') + '</text>' : ''),
      ALR.list.length ? '<b class="warn-t">⚠ ' + esc(ALR.list[0].event) + '</b>' : 'Next 12 hours around the dial · Open-Meteo', ALR.list.some((a2) => /warning/i.test(a2.event)) ? 'g-alarm' : '');
  }
  if (id === 'alerts') { const L2 = ALR.list; return '<div class="gauge wx-tile"><div class="g-lbl">WEATHER WARNINGS</div>' + (L2.length ? L2.slice(0, 3).map((a) => '<div class="wxt-al ' + alrClass(a) + '"><b>' + esc(a.event) + '</b><span>until ' + (a.ends ? fmtClock(Date.parse(a.ends)) : '—') + '</span></div>').join('') : '<div class="wxt-ok">No active warnings here</div>') + '<div class="g-foot">National Weather Service · checked ' + (ALR.at ? agoTxt(ALR.at) : '—') + '</div></div>'; }
  if (id === 'photo') { const P = PHT.list, ph = P.length ? P[PHT.i % P.length].src : null; return '<label class="gauge ph-tile"' + (ph ? ' style="background-image:url(' + ph + ')"' : '') + ' title="Choose one photo or many for a slideshow"><input type="file" accept="image/*" multiple data-tilephoto hidden>' + (ph ? '<span class="ph-change">' + (P.length > 1 ? P.length + ' photos · ' : '') + 'Add or change</span>' : '<div class="g-lbl">PHOTOS</div><p class="g-unit" style="margin:auto;text-align:center">Tap to choose photos. Pick several for a slideshow.</p>') + '</label>'; }
  if (id === 'waves') { const wv = w && w.wave; return gWrap('WAVES', '<circle cx="100" cy="100" r="84" class="g-ring"/><text x="100" y="108" class="g-big sm">' + (wv && wv.h != null ? waveLen(wv.h).replace(/\s*(ft|m)$/, '') : '–') + '</text><text x="100" y="132" class="g-unit">' + lenUnit() + (wv && wv.per ? ' · every ' + Math.round(wv.per) + ' s' : '') + '</text>' + (wv && wv.dir != null ? '<text x="100" y="156" class="g-unit">from ' + compass16(wv.dir) + '</text>' : ''), 'Model forecast · Open-Meteo'); }
  if (id === 'trip') { const t = S.trip || { dist: 0, moving: 0 }, [dv, du] = distParts(t.dist || 0); return gWrap('TRIP', '<circle cx="100" cy="100" r="84" class="g-ring"/><text x="100" y="104" class="g-big sm">' + dv + '</text><text x="100" y="128" class="g-unit">' + du + '</text><text x="100" y="156" class="g-unit">' + fmtDur((t.moving || 0) / 3600) + ' underway</text>', t.moving > 60 ? 'Average ' + fmtSpeed(t.dist / (t.moving / 3600)) + ' ' + SPEED_LBL[S.settings.speedUnit] : 'Since trip reset'); }
  if (id === 'temps') { const air = w && w.cur && w.cur.temp, water = S.waterObs && Date.now() - S.waterObs.t < 3 * 3600000 ? S.waterObs.f : w && w.sst; return gWrap('AIR · WATER', '<text x="100" y="66" class="g-unit">AIR</text><text x="100" y="112" class="g-big sm">' + tempTxt(air) + '</text><text x="100" y="146" class="g-unit">WATER ' + tempTxt(water) + '</text>', S.waterObs ? 'Water measured · NOAA' : 'Forecast'); }
  if (id === 'course') return gWrap('COURSE', compassGauge(moving ? S.cog : null), 'Course over ground');
  if (id === 'wind') { const wd = ob ? { dir: ob.dir, spd: ob.spd, gust: ob.gust, cap: 'Measured · ' + agoTxt(ob.t) } : w && w.cur ? { dir: w.cur.dir, spd: w.cur.spd, gust: w.cur.gust, cap: 'Forecast · ' + agoTxt(w.at) } : null; return gWrap('WIND ' + (wd ? compass16(wd.dir) : ''), windGauge(wd && wd.dir, wd && wd.spd, wd && wd.gust, moving ? S.cog : 0), wd ? wd.cap + (moving ? ' · arrow relative to bow' : ' · arrow: north up') : 'No wind data yet'); }
  if (id === 'tide') return tn ? gWrap('TIDE', tideGauge(tn), (S.wl && S.wl.diff != null && Math.abs(S.wl.diff) >= 0.4 ? '<b class="' + (Math.abs(S.wl.diff) >= 1 ? 'warn-t' : '') + '">Measured ' + Math.abs(S.wl.diff).toFixed(1) + ' ft ' + (S.wl.diff > 0 ? 'above' : 'below') + ' prediction</b> · ' : '') + (tn.next ? (tn.next.type === 'H' ? 'High ' : 'Low ') + fmtClock(tn.next.t) : '') + ' · NOAA ' + esc(((S.tide.station || {}).name || '').replace(/,.*$/, ''))) : gWrap('TIDE', '<text x="100" y="108" class="g-unit">No tide station yet</text>', '');
  if (id === 'dest') { if (!(S.goto && S.fix)) return gWrap('DESTINATION', '<text x="100" y="100" class="g-unit">Not navigating</text><text x="100" y="122" class="g-unit">Start one in Navigate</text>', ''); const li = legInfo(S.fix, S.goto); const gr = S.goto.route, onTurn = gr && gr.pts[gr.i] && gr.pts[gr.i].turn; return gWrap(onTurn ? 'NEXT TURN' : gr ? 'NEXT MARK · ' + esc((S.goto.name.split(' · ')[0] || '').toUpperCase()) : 'TO ' + esc(S.goto.name.toUpperCase()), steerGauge(li.b, moving ? S.cog : null, li.d), isFinite(li.hrs) ? 'Time to mark ' + fmtDur(li.hrs) + ' · ETA ' + fmtClock(Date.now() + li.hrs * 3600000) : 'Steer to the arrow'); }
  if (id === 'anchor') return S.anchor ? gWrap('ANCHOR', anchorGauge(S.anchor.lastFt, S.anchor.radiusFt), S.alarmOn ? 'ALARM' : 'Distance from anchor', S.alarmOn ? 'g-alarm' : '') : gWrap('ANCHOR', '<text x="100" y="108" class="g-unit">Watch is off</text>', '');
  if (id === 'position') { const f = S.fix; return gWrap('GPS POSITION', '<text x="100" y="84" class="g-big pos">' + (f ? ddm(f.lat, true) : '–') + '</text><text x="100" y="124" class="g-big pos">' + (f ? ddm(f.lon, false) : '') + '</text><text x="100" y="156" class="g-unit">' + (f && f.acc ? '±' + Math.round(ftToLen(f.acc * 3.28084)) + ' ' + lenUnit() + ' accuracy' : 'No fix') + '</text>', S.lastFixAt ? 'Last fix ' + Math.max(0, Math.round((Date.now() - S.lastFixAt) / 1000)) + ' s ago' : ''); }
  if (id === 'time') { const now = Date.now(), ss = w && (w.sunset || []).find((t) => t > now), sr = w && (w.sunrise || []).find((t) => t > now); return gWrap('TIME', '<text x="100" y="108" class="g-big">' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, '') + '</text>' + (ss ? '<text x="100" y="142" class="g-unit">Sunset ' + fmtClock(ss) + '</text>' : '') + (sr ? '<text x="100" y="' + (ss ? 164 : 142) + '" class="g-unit">Sunrise ' + fmtClock(sr) + '</text>' : ''), (() => { const c = S.fix || refPos(), mt = AST.moonTimes(new Date(), c.lat, c.lon), ph = AST.phase(new Date()); return moonName(ph) + (mt.rise ? ' · rise ' + fmtClock(mt.rise.getTime()) : '') + (mt.set ? ' · set ' + fmtClock(mt.set.getTime()) : ''); })()); }
  return '';
}
let ckMap = null, ckMark = null, ckEdit = false;
// the cockpit's chart is the real chart: the map and its buttons move into the chart tile, and back when the cockpit closes
const CKH = { on: false, moved: [] };
function ckHost(box) {
  ckUnhost();
  const ids = ['map', 'fabs', 'fabsR', 'btnMOB'];
  CKH.moved = ids.map((id) => { const el = $(id); return el ? { el, parent: el.parentNode, next: el.nextSibling } : null; }).filter(Boolean);
  CKH.moved.forEach((m) => box.appendChild(m.el));
  CKH.on = true; $('app').classList.add('ck-host');
  setTimeout(() => map.invalidateSize(), 50); setTimeout(() => map.invalidateSize(), 400);
}
function ckUnhost() {
  if (!CKH.on) return;
  CKH.moved.slice().reverse().forEach((m) => m.parent.insertBefore(m.el, m.next && m.next.parentNode === m.parent ? m.next : null));
  CKH.moved = []; CKH.on = false; $('app').classList.remove('ck-host');
  setTimeout(() => map.invalidateSize(), 50);
}
function buildCockpit() {
  const grid = $('cockpit').querySelector('.ck-grid'), sl = ckSlots().filter((x) => x !== 'off');
  ckUnhost(); if (ckMap) { ckMap.remove(); ckMap = null; }
  grid.dataset.n = sl.length + (ckEdit && sl.length < 9 ? 1 : 0);
  grid.innerHTML = sl.map((id, i) => '<div class="ck-slot' + (id === 'chart' ? ' chart' : '') + '" data-slot="' + i + '">' + (id === 'chart' ? '<div class="gauge"><div class="g-lbl">CHART</div><div class="ck-map" id="ckMap"></div></div>' : '') + '</div>').join('') +
    (ckEdit && sl.length < 9 ? '<div class="ck-slot add"><button type="button" class="ck-add" data-ckadd>+ Add a gauge</button></div>' : '');
  if (sl.includes('chart')) ckHost($('ckMap')); else ckUnhost();
  if (false) {
    ckMap = L.map('ckMap', { zoomControl: false, attributionControl: false, dragging: true, zoomSnap: 0 });
    const base = LAYERS[S.settings.chart === 'street' ? 'street' : S.settings.chart === 'satellite' ? 'satellite' : 'noaa'];
    if (window.TL_DEMO) L.imageOverlay(window.TL_DEMO.chart, window.TL_DEMO.bounds).addTo(ckMap); else L.tileLayer(base._url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', base.options).addTo(ckMap);
    if (!window.TL_DEMO && S.settings.chart === 'noaa') { ckMap.eachLayer((l) => ckMap.removeLayer(l)); new NoaaLayer('', { className: 'noaa-chart-tile', maxZoom: 19, maxNativeZoom: 18 }).addTo(ckMap); }
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
  // fill any empty cells so the grid stays even: weather, barometer, warnings, then your boat photo
  if (!ckEdit) setTimeout(() => {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1, chart = sl.includes('chart'), wide = window.innerWidth >= 900;
    let free = 0;
    if (chart && wide && (lay === 'half' || lay === 'big')) { const rows = Math.max(1, Math.ceil((sl.length - 1) / 2)); free = rows * (cols - 1) - (sl.length - 1); } else free = (cols - (sl.length % cols)) % cols;
    const pool = (S.settings.ckFillers || ['weather', 'baro', 'alerts', 'photo', 'time']).filter((x) => !sl.includes(x));
    for (let i = 0; i < free && i < pool.length; i++) grid.insertAdjacentHTML('beforeend', '<div class="ck-slot filler" data-filler="' + pool[i] + '"></div>');
    renderCockpit();
  }, 0);
  grid.querySelectorAll('.ck-slot[data-slot]').forEach((el) => { el.draggable = ckEdit; });
  renderCockpit();
}
// Customize: drag a tile onto another to swap them (arrows do the same on touch screens)
(() => {
  const g = () => $('cockpit').querySelector('.ck-grid'); let from = null;
  document.addEventListener('dragstart', (e) => { const t = e.target.closest && e.target.closest('#cockpit .ck-slot[data-slot]'); if (!t || !ckEdit) return; from = +t.dataset.slot; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(from)); } catch (err) { /* old browsers */ } t.classList.add('dragging'); });
  document.addEventListener('dragover', (e) => { const t = e.target.closest && e.target.closest('#cockpit .ck-slot[data-slot]'); if (t && from != null) { e.preventDefault(); g().querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); t.classList.add('drop'); } });
  document.addEventListener('dragend', () => { from = null; document.querySelectorAll('#cockpit .dragging, #cockpit .drop').forEach((x) => x.classList.remove('dragging', 'drop')); });
  document.addEventListener('drop', (e) => { const t = e.target.closest && e.target.closest('#cockpit .ck-slot[data-slot]'); if (!t || from == null) return; e.preventDefault(); ckSwap(from, +t.dataset.slot); from = null; });
  document.addEventListener('click', (e) => { const m = e.target.closest('[data-ckmove]'); if (!m) return; const [i, d] = m.dataset.ckmove.split(':').map(Number); ckSwap(i, i + d); });
})();
// photos of your choosing for the photo tile, kept on this device; several become a slideshow
const PHT = { list: [], i: 0 };
pAll('tile').then((a) => { PHT.list = a.filter((x) => /^tilephoto/.test(x.id)).sort((x, y) => x.t - y.t); try { renderCockpit(); } catch (e) { /* closed */ } }).catch(() => {});
setInterval(() => { if (PHT.list.length > 1 && !$('cockpit').hidden) { PHT.i++; document.querySelectorAll('.ph-tile').forEach((el) => { el.style.backgroundImage = 'url(' + PHT.list[PHT.i % PHT.list.length].src + ')'; }); } }, 9000);
document.addEventListener('change', async (e) => {
  if (!e.target.matches || !e.target.matches('[data-tilephoto]')) return; const files = [...(e.target.files || [])].slice(0, 30); if (!files.length) return;
  const replace = !PHT.list.length || confirm('Add these to your slideshow? Press Cancel to replace the photos you have.');
  try {
    if (!replace) { const db = await pdb(); await Promise.all(PHT.list.map((p) => new Promise((res) => { const tx = db.transaction('p', 'readwrite'); tx.objectStore('p').delete(p.id); tx.oncomplete = res; tx.onerror = res; }))); PHT.list = []; }
    for (const f of files) { const src = await resizePhoto(f, 1600, 0.8), o = { id: 'tilephoto' + Date.now() + Math.random().toString(36).slice(2, 6), track: 'tile', t: Date.now(), src }; await pPut(o); PHT.list.push(o); }
    PHT.i = PHT.list.length - files.length;
    document.querySelectorAll('#cockpit .ck-slot').forEach((b2) => { b2.dataset.drawn = ''; }); renderCockpit(); toast(files.length > 1 ? files.length + ' photos added: they change every few seconds' : 'Photo added');
  } catch (err) { toast('Could not use those photos'); }
});
function ckSwap(a, b) {
  const sl = ckSlots().filter((x) => x !== 'off').slice(); if (a === b || a < 0 || b < 0 || a >= sl.length || b >= sl.length) return;
  [sl[a], sl[b]] = [sl[b], sl[a]]; S.settings.ckSlots = sl; saveSettings(); buildCockpit();
}
function renderCockpit() {
  const el = $('cockpit'); if (!el || el.hidden) return;
  const sl = ckSlots().filter((x) => x !== 'off');
  CK_FALL.clear();
  el.querySelectorAll('.ck-slot.filler').forEach((box) => { box.innerHTML = ckGauge(box.dataset.filler); });
  el.querySelectorAll('.ck-slot[data-slot]').forEach((box) => {
    const i = +box.dataset.slot, id = sl[i];
    const mv = ckEdit ? '<div class="ck-mv"><button type="button" data-ckmove="' + i + ':-1" aria-label="Move earlier">◀</button><span>drag to move</span><button type="button" data-ckmove="' + i + ':1" aria-label="Move later">▶</button></div>' : '';
    const pick = ckEdit ? mv + '<select class="ck-pick" data-ckpick="' + i + '" aria-label="Choose gauge">' + CK_OPTS.concat([['auto', 'Tide, or destination when navigating']]).map(([v, l]) => '<option value="' + v + '"' + (v === id ? ' selected' : '') + '>' + (v === 'off' ? 'Remove this gauge' : l) + '</option>').join('') + '</select>' : '';
    if (id === 'chart') { // add or remove the picker only when Customize changes, so an open menu or a drag is never cut off
      const has = !!box.querySelector('.ck-pick');
      if (ckEdit && !has) box.insertAdjacentHTML('afterbegin', pick);
      if (!ckEdit && has) box.querySelectorAll('.ck-pick, .ck-mv').forEach((x) => x.remove());
      return; }
    if (box.querySelector('select:focus') || (ckEdit && box.dataset.drawn)) return; // while customizing, keep tiles still so taps land
    box.dataset.drawn = ckEdit ? '1' : '';
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
  const sl = ckSlots().filter((x) => x !== 'off').slice(), i = +sel.dataset.ckpick, prev = sl[i];
  if (sel.value === 'chart') { const j = sl.indexOf('chart'); if (j >= 0 && j !== i) sl[j] = prev; } // only one chart: picking it again swaps places
  sl[i] = sel.value;
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
  const el = $('cockpit'); el.hidden = !on; $('app').classList.toggle('ck-on', on); const bi = $('btnInst'); if (bi) { bi.classList.toggle('on', on); bi.dataset.tip = on ? 'Back to the chart' : 'Instruments: full-screen gauges'; }
  clearInterval(cockTimer);
  if (on) { closeSheet(); ckEdit = false; buildCockpit(); cockTimer = setInterval(renderCockpit, 1000); wake(); } else ckUnhost();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-act="ckclose"]')) setCockpit(false); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-act="cockpit"]')) setCockpit(true); });
$('btnInst').addEventListener('click', () => setCockpit(!S.settings.cockpit || $('cockpit').hidden));

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
// always-on speed and course dial at the top right of the chart
function renderMini() {
  const el = $('miniInst'); if (!el) return;
  const f = S.fix, moving = (S.sog || 0) > 0.6, cog = moving ? S.cog : null, mr = mapRot();
  // compass card: ticks every 10°, longer every 30°, N E S W letters; it turns with the chart in course-up
  let ticks = ''; for (let d = 0; d < 360; d += 10) { const major = d % 30 === 0, a = (d - 90) * Math.PI / 180, r0 = major ? 38.5 : 41.5; ticks += '<line x1="' + (50 + r0 * Math.cos(a)).toFixed(1) + '" y1="' + (50 + r0 * Math.sin(a)).toFixed(1) + '" x2="' + (50 + 44.5 * Math.cos(a)).toFixed(1) + '" y2="' + (50 + 44.5 * Math.sin(a)).toFixed(1) + '"' + (major ? ' class="mj"' : '') + '/>'; }
  const card = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, d]) => { const a = (d - 90) * Math.PI / 180, x = 50 + 34 * Math.cos(a), y = 50 + 34 * Math.sin(a); return '<text x="' + x.toFixed(1) + '" y="' + (y + 3.5).toFixed(1) + '" class="mi-c' + (t === 'N' ? ' n' : '') + '" transform="rotate(' + (-mr).toFixed(1) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')">' + t + '</text>'; }).join('');
  const gs = S.settings.gStyle || 'hybrid';
  let svg = '<svg viewBox="0 0 100 100" aria-hidden="true" class="mi-' + gs + '">' + bezelSvg('mb', 50, 50) + (gs === 'digital' ? '' : '<g transform="rotate(' + mr.toFixed(1) + ' 50 50)"><g class="mi-ticks">' + ticks + '</g>' + card + '</g>') +
    (cog != null ? '<g transform="rotate(' + (cog + mr).toFixed(0) + ' 50 50)"><path d="M50 1.5 L56 13 L50 10 L44 13 Z" class="mi-arrow"/></g>' : '') +
    '<text x="50" y="31" class="mi-cog">' + (cog != null ? fmtBrg(cog) + '° ' + compass16(cog) : 'COURSE –') + '</text>' +
    '<text x="50" y="54" class="mi-spd">' + (f ? fmtSpeed(S.sog || 0) : '–') + '</text><text x="50" y="61" class="mi-u">' + SPEED_LBL[S.settings.speedUnit] + '</text>';
  maybeDepth();
  const d = DEP.v, validDepth = f && d && DEP.pos && distNm(DEP.pos, f) < 0.03 && Date.now() - DEP.at < 600000;
  const need = S.boat.draftFt ? S.boat.draftFt + (S.boat.safetyFt == null ? 2 : S.boat.safetyFt) : null, dft = validDepth ? d.d1 / 0.3048 : null, shallow = need && dft != null && dft < need;
  const depthText = validDepth ? Math.round(ftToLen(dft)) + '<tspan class="mi-du"> ' + lenUnit() + '</tspan>' : '–<tspan class="mi-du"> ' + lenUnit() + '</tspan>';
  el.innerHTML = svg + '<line x1="38" x2="62" y1="64.5" y2="64.5" class="mi-div"/><text x="50" y="75" class="mi-dep' + (shallow ? ' shallow' : '') + '">' + depthText + '</text></svg>';
  el.setAttribute('aria-label', 'Speed, course and charted depth. Tap for full instruments.');
  el.dataset.tip = f ? 'Speed ' + fmtSpeed(S.sog || 0) + ' ' + SPEED_LBL[S.settings.speedUnit] + (cog != null ? ' · course ' + fmtBrg(cog) + '° true (' + compass16(cog) + ')' : ' · course shows once moving') + (validDepth ? ' · charted depth ' + Math.round(ftToLen(dft)) + ' ' + lenUnit() + (shallow ? ' (shallow for your boat)' : '') : ' · charted depth when NOAA chart data loads') + '. Tap for the full gauges.' : 'Speed, course and charted depth: waiting for GPS';
}
$('miniInst').addEventListener('click', () => setCockpit(true));
setInterval(renderMini, 1000); renderMini();
/* ---------- account and sync (Supabase): sign in with your email, and your boats, routes and logs follow you to any browser or phone ---------- */
const TL_ACCOUNTS = null; // { url: 'https://xxxx.supabase.co', key: 'anon public key' }: once set here, everyone just signs in with their email
const SB = { cfg: store.get('syncCfg', null) || TL_ACCOUNTS, client: null, user: null, busy: false, t: null, last: store.get('syncAt', 0) };
function syncData() { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('tl.') && !SYNC_SKIP.test(k.slice(3)) && k !== 'tl.syncCfg' && k !== 'tl.syncAt') o[k] = localStorage.getItem(k); } return o; }
function sbLoad() { return new Promise((res, rej) => { if (window.supabase) return res(); const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); }
async function sbInit() {
  if (!SB.cfg || SB.client) return SB.client;
  try { await sbLoad(); SB.client = window.supabase.createClient(SB.cfg.url, SB.cfg.key, { auth: { persistSession: true, detectSessionInUrl: true } }); } catch (e) { return null; }
  const { data } = await SB.client.auth.getSession(); SB.user = data.session && data.session.user; window.__sbEmail = SB.user && SB.user.email;
  SB.client.auth.onAuthStateChange((ev, sess) => { const was = SB.user; SB.user = sess && sess.user; window.__sbEmail = SB.user && SB.user.email; if (SB.user && !was) { toast('Signed in as ' + SB.user.email + '. Syncing…'); syncPull(true); } renderAccount(); });
  if (SB.user) syncPull(false);
  return SB.client;
}
async function syncPull(first) {
  if (!SB.client || !SB.user || SB.busy) return; SB.busy = true;
  try {
    const { data, error } = await SB.client.from('tideline_data').select('data, updated_at').eq('user_id', SB.user.id).maybeSingle();
    if (error) throw error;
    const remoteAt = data ? Date.parse(data.updated_at) : 0, localHas = Object.keys(syncData()).length > 3;
    if (data && data.data && remoteAt > SB.last && (!localHas || first ? confirm('Load the boats, routes and settings saved in your account (' + new Date(remoteAt).toLocaleString() + ')? This replaces what is in this browser.') : true)) {
      Object.entries(data.data).forEach(([k, v]) => localStorage.setItem(k, v)); SB.last = remoteAt; store.set('syncAt', remoteAt); SB.busy = false; toast('Your data is loaded. Reloading…'); setTimeout(() => location.reload(), 700); return;
    }
    SB.busy = false; if (!data || remoteAt <= SB.last || localHas) await syncPush();
  } catch (e) { SB.err = (e && e.message) || 'Sync failed'; }
  SB.busy = false; renderAccount();
}
async function syncPush() {
  if (!SB.client || !SB.user) return;
  try {
    const now = new Date().toISOString();
    const { error } = await SB.client.from('tideline_data').upsert({ user_id: SB.user.id, data: syncData(), updated_at: now });
    if (error) throw error; SB.last = Date.parse(now); localStorage.setItem('tl.syncAt', String(SB.last)); SB.err = '';
  } catch (e) { SB.err = (e && e.message) || 'Sync failed'; }
  renderAccount();
}
window.__tlSync = () => { if (!SB.user) return; clearTimeout(SB.t); SB.t = setTimeout(syncPush, 4000); };
window.addEventListener('online', () => { if (SB.user) syncPush(); });
function renderAccount() { if (!sheet.hidden && $('acctBox')) openAccount(true); }
function openAccount(refresh) {
  let h = '<h3>Account and sync</h3>';
  if (!SB.cfg) {
    h += '<div class="sub">Connect Tideline to your free Supabase project once. After that you sign in with your email on any browser or phone, and everything follows you.</div>' +
      '<div class="field"><label>Project URL</label><input id="sbUrl" placeholder="https://xxxx.supabase.co"></div><div class="field"><label>Anon public key</label><input id="sbKey" placeholder="eyJhbGciOi…"></div>' +
      '<div class="row-btns"><button class="btn primary" data-act="sbcfg">Connect</button></div><p class="hint">Setup steps are in the Tideline repo: tools/supabase/README.md. The anon key is meant to be public; your data is protected by sign-in.</p>';
  } else if (!SB.user) {
    h += '<div class="sub">Sign in with your email. We send you a link; tap it on this device and you are in. No password.</div><div class="field"><label>Email</label><input id="sbEmail" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
      '<div class="row-btns"><button class="btn primary" data-act="sbsend">Email me a sign-in code</button></div>' + (SB.sent ? '<p class="hint"><b>Check your email</b> (and spam). Type the code here, or open the link in this browser.</p><div class="field"><label>Code from the email</label><input id="sbCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></div><div class="row-btns"><button class="btn primary" data-act="sbcode">Sign in</button></div>' : '');
  } else {
    h += '<div class="sub">Signed in as <b>' + esc(SB.user.email) + '</b></div><p class="hint">' + (SB.err ? '<b class="warn-t">' + esc(SB.err) + '</b>' : 'Boats, routes, tracks, spots, logs, receipts and settings sync automatically.' + (SB.last ? ' Last saved ' + agoTxt(SB.last) + '.' : '')) + ' Photos stay on the device they were taken on.</p>' +
      '<div class="row-btns"><button class="btn" data-act="sbpush">Sync now</button><button class="btn ghost" data-act="sbout">Sign out</button></div>';
  }
  h = '<div id="acctBox">' + h + '<div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div></div>';
  if (refresh && $('acctBox')) $('acctBox').outerHTML = h; else openSheet(h);
}
sheet.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !$('acctBox')) return; const a = b.dataset.act;
  if (a === 'sbcfg') { const url = ($('sbUrl').value || '').trim().replace(/\/$/, ''), key = ($('sbKey').value || '').trim(); if (!/^https:\/\/.+\.supabase\.co$/.test(url) || key.length < 40) { toast('Paste the Project URL and the anon public key from Supabase → Project settings → API'); return; } SB.cfg = { url, key }; store.set('syncCfg', SB.cfg); await sbInit(); openAccount(true); }
  if (a === 'sbsend') { const em = ($('sbEmail').value || '').trim(); if (!/.+@.+\..+/.test(em)) { toast('Enter your email'); return; } await sbInit(); const { error } = await SB.client.auth.signInWithOtp({ email: em, options: { emailRedirectTo: location.origin + location.pathname } }); if (error) toast(error.message); else { SB.sent = true; openAccount(true); } }
  if (a === 'sbpush') { await syncPush(); toast(SB.err ? SB.err : 'Synced'); }
  if (a === 'sbout') { await SB.client.auth.signOut(); SB.user = null; openAccount(true); }
});
setTimeout(sbInit, 1500);
/* ---------- natural-language first mate: typed or tap-to-talk, authenticated backend ---------- */
const FM = { view: 0, busy: false, recognition: null, history: [], destinations: [] };
const firstMateSpots = L.layerGroup().addTo(map);
function firstMateMessage(text) { const el = $('firstMateReply'); if (el) el.textContent = text; }
function openFirstMate() {
  FM.view++; if (FM.recognition) FM.recognition.stop();
  openSheet('<h3>First mate</h3><p class="sub">Try: “Set a course from Severn Sailing Association to Baltimore Harbor”, “Take me to St. Michaels”, “Show the currents”, “Show me the waves”, “Should I reef?”, “When should I leave?”, “Night mode”.</p><div class="field"><label for="firstMateRequest">What would you like to do?</label><input id="firstMateRequest" type="text" maxlength="1000" placeholder="Ask by voice or type…" autocomplete="off"></div><div class="row-btns"><button class="btn" data-fm="listen">🎙 Talk</button><button class="btn primary" data-fm="send">Send</button></div><p id="firstMateReply" class="sub" role="status" aria-live="polite">' + 'Ready. Tap Talk and speak, or type and tap Send.' + '</p><div id="firstMateResults"></div>' + wakeBoxHtml() + '<details><summary>Connection setup</summary><div class="field"><label for="firstMateEndpoint">Assistant backend URL</label><input id="firstMateEndpoint" type="url" value="' + esc(S.settings.assistantUrl || '') + '" placeholder="https://tideline-first-mate.…workers.dev"></div><button class="btn small" data-fm="setup">Save connection</button><p class="hint">Sign in through Account. This requires a deployed assistant backend; never paste an AI API key here.</p></details><p class="hint">Sending shares your words and limited active-boat context with the AI service. Speech processing depends on your browser. This assistant operates app controls, not vessel controls.</p><button class="btn ghost" data-act="close">Close</button>');
}
function firstMateListen() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { firstMateMessage('Use the microphone on your keyboard to dictate into the request box, then tap Send.'); $('firstMateRequest').focus(); return; }
  if (FM.recognition) { FM.recognition.stop(); return; }
  const r = new Recognition(); FM.recognition = r; r.lang = navigator.language || 'en-US'; r.interimResults = false; r.continuous = false;
  firstMateMessage('Listening… Tap Talk again to stop. Review the words before Send.');
  r.onresult = e => { const input = $('firstMateRequest'); if (input) input.value = e.results[0][0].transcript; firstMateMessage('Heard: “' + e.results[0][0].transcript + '”'); setTimeout(askFirstMate, 250); };
  r.onerror = () => firstMateMessage('Could not hear you. Try keyboard dictation or type your request.');
  r.onend = () => { FM.recognition = null; };
  try { r.start(); } catch (e) { FM.recognition = null; firstMateMessage('Microphone unavailable. Type or use keyboard dictation.'); }
}
function firstMateAheadTargets() {
  if (!S.fix || (S.sog || 0) < 0.6 || !Number.isFinite(S.cog) || Date.now() - S.lastFixAt > 30000) return null;
  return [...ais.values()].filter(t => Date.now() - (t.seen || 0) < 180000 && Math.abs(((bearing(S.fix, t) - S.cog + 540) % 360) - 180) <= 35).sort((a,b) => (b.len || 0) - (a.len || 0) || distNm(S.fix, a) - distNm(S.fix, b));
}
function firstMateSpotDistance(p, a, b) {
  const scale = Math.cos((a.lat + b.lat) * Math.PI / 360), x = (b.lon-a.lon)*scale, y = b.lat-a.lat, px = (p.lon-a.lon)*scale, py = p.lat-a.lat;
  const t = x*x+y*y ? Math.max(0, Math.min(1, (px*x+py*y)/(x*x+y*y))) : 0;
  return Math.hypot(px-t*x, py-t*y)*60;
}
async function firstMateExecute(a) {
  const boatAtStart = S.fleet.active, viewAtStart = FM.view;
  if (!a || !['weather','navigate','ais','fishing','clarify'].includes(a.action)) throw new Error('Unsupported request. No action taken.');
  if (a.action === 'clarify') { firstMateMessage(String(a.message || 'Could you say what you want to display?').slice(0,1200)); return; }
  if (a.action === 'weather') {
    if (!['rain','wind','waves','tide'].includes(a.layer) || typeof a.visible !== 'boolean') throw new Error('Which weather layer would you like?');
    if (a.layer === 'tide') { if (a.visible) { WX.view = 'tide'; WX.open = true; setTab('weather'); } else { WX.view = 'wind'; WX.open = false; renderWxBar(); } }
    else { setTab('chart'); setWxL(a.layer, a.visible); }
    toast((a.visible ? 'Showing ' : 'Hiding ') + (a.layer === 'rain' ? 'rain radar' : a.layer) + '.'); return;
  }
  if (a.action === 'navigate') {
    if (typeof a.destination !== 'string' || !a.destination.trim() || a.destination.length > 200) throw new Error('Where would you like to go?');
    FM.destinations = await suggestPlaces(a.destination.trim(), searchCenter());
    if (boatAtStart !== S.fleet.active || viewAtStart !== FM.view || !$('firstMateResults')) return;
    firstMateMessage(FM.destinations.length ? 'Choose the destination. Navigate opens for review; guidance has not started.' : 'No matching destination found. Try a marina name or town.');
    $('firstMateResults').innerHTML = FM.destinations.map((d,i) => '<button class="sug" type="button" data-fm-dest="' + i + '"><b>' + esc(d.name) + '</b><span>' + esc(d.sub || '') + '</span><em>' + fmtDist(d.d) + '</em></button>').join(''); return;
  }
  if (a.action === 'ais') {
    if (a.scope !== 'ahead') { openAisList(); return; }
    const targets = firstMateAheadTargets();
    if (targets === null) { firstMateMessage('I need a fresh GPS course while moving to narrow “ahead”. You can open the full AIS list instead.'); $('firstMateResults').innerHTML = '<button class="btn" data-act="aislist">Open AIS list</button>'; return; }
    firstMateMessage(targets.length ? 'Candidates ahead of your course, larger vessels first. Course is not where the phone is pointing; select the vessel you mean.' : 'No fresh AIS targets received ahead of your course. That does not mean the water is clear.');
    $('firstMateResults').innerHTML = targets.slice(0,8).map(t => '<div class="li"><div class="li-main"><b>' + esc(t.name || 'Unnamed vessel') + '</b><span>' + (t.demo ? 'SIMULATED · ' : '') + fmtDist(distNm(S.fix,t)) + (t.len ? ' · ' + Math.round(t.len) + ' m' : ' · length unknown') + '</span></div><button class="btn small" data-aisid="' + esc(t.id) + '">Details</button></div>').join(''); return;
  }
  if (a.action === 'fishing') {
    let spots = S.spots || [];
    if (a.scope === 'along_route') {
      const pts = S.goto && S.goto.route ? S.goto.route.pts.slice(Math.max(0,S.goto.route.i-1)) : S.goto && S.fix ? [S.fix,S.goto] : RT.pts;
      if (!pts || pts.length < 2) { firstMateMessage('Plan or select a route first so I can find your saved spots along it.'); return; }
      spots = spots.filter(p => pts.some((b,i) => i && firstMateSpotDistance(p,pts[i-1],b) <= 1));
    }
    firstMateSpots.clearLayers();
    if (!spots.length) { firstMateMessage('No saved fishing spots match. This version has your personal spots, not a public fishing-location feed.'); return; }
    spots.forEach(p => { const m = L.marker([p.lat,p.lon]).bindTooltip(esc(p.species || 'Saved fishing spot')); m.on('click',()=>openSpot(p)); firstMateSpots.addLayer(m); });
    setTab('chart'); closeSheet(); map.fitBounds(L.latLngBounds(spots.map(p=>[p.lat,p.lon])).pad(.2), { maxZoom: 15 });
    toast('Showing ' + spots.length + ' saved fishing spots' + (a.scope === 'along_route' ? ' within 1 nm of your route.' : '.')); return;
  }
}
// Built-in understanding of everyday requests, so the first mate works with no AI service, no sign-in and no cost.
// Anything it can't place falls through to the AI backend when one is set up.
const FM_PLACE_FIX = [[/\bssa\b|severn sailing( association)?/i, 'Severn Sailing Association'], [/\bbaltimore harbou?r\b|inner harbou?r/i, 'Baltimore Inner Harbor'], [/\bnaval academy\b/i, 'Naval Academy Annapolis']];
// well-known Chesapeake spots, so the first mate finds them instantly, even with a weak signal (each point is in the water off the place)
const FM_KNOWN = [
  [/severn sailing|\bssa\b/, 'Severn Sailing Association', 38.97542, -76.48041], [/city dock|ego alley|downtown annapolis|^annapolis( harbou?r)?$/, 'Annapolis City Dock', 38.9774, -76.4853],
  [/spa creek|eastport/, 'Spa Creek, Annapolis', 38.9740, -76.4830], [/naval academy|usna/, 'Naval Academy, Annapolis', 38.9800, -76.4775], [/annapolis yacht club|\bayc\b/, 'Annapolis Yacht Club', 38.9763, -76.4838],
  [/baltimore|inner harbou?r|fells point/, 'Baltimore Inner Harbor', 39.2850, -76.6085], [/st\.? michaels|saint michaels/, 'St. Michaels', 38.7870, -76.2210],
  [/^oxford/, 'Oxford', 38.6915, -76.1700], [/rock hall/, 'Rock Hall', 39.1350, -76.2440], [/solomons/, 'Solomons', 38.3270, -76.4560],
  [/thomas point/, 'Thomas Point Shoal Light', 38.8990, -76.4360], [/bay bridge/, 'Chesapeake Bay Bridge', 38.9930, -76.3780],
  [/gibson island/, 'Gibson Island', 39.0750, -76.4300], [/magothy/, 'Magothy River', 39.0700, -76.4600], [/kent narrows/, 'Kent Narrows', 38.9720, -76.2460],
  [/galesville|west river/, 'Galesville, West River', 38.8420, -76.5370], [/rhode river/, 'Rhode River', 38.8800, -76.5200], [/south river/, 'South River', 38.9300, -76.5400],
  [/chestertown/, 'Chestertown', 39.2050, -76.0640], [/cambridge/, 'Cambridge', 38.5750, -76.0760], [/havre de grace/, 'Havre de Grace', 39.5450, -76.0900]
];
async function fmPlace(q, near) {
  q = q.replace(/^(the|a)\s+/i, '').replace(/[.?!]+$/, '').trim();
  if (/^(here|me|my boat|my location|where i am|current location)$/i.test(q)) return S.fix ? { name: boatLabel(), lat: S.fix.lat, lon: S.fix.lon } : null;
  if (/^(home|home port|my (home )?port|my dock|my slip)$/i.test(q) && homePort()) return Object.assign({}, homePort());
  const hp = homePort(); if (hp && q.toLowerCase() === hp.name.toLowerCase()) return Object.assign({}, hp);
  const kn = FM_KNOWN.find(([re]) => re.test(q.toLowerCase().replace(/^seven sailing/, 'severn sailing')));
  if (kn) return { name: kn[1], lat: kn[2], lon: kn[3] };
  FM_PLACE_FIX.forEach(([re, v]) => { if (re.test(q)) q = v; });
  let list = []; try { list = await suggestPlaces(q, near || searchCenter()); } catch (e) { list = []; }
  const o = list[0]; return o ? { name: o.name.replace(/\s*\(sample spot\)/, ''), lat: o.lat, lon: o.lon, sub: o.sub } : null;
}
const FM_LAYER = { wind: 'wind', winds: 'wind', waves: 'waves', wave: 'waves', seas: 'waves', swell: 'waves', rain: 'rain', radar: 'rain', storms: 'rain', tide: 'tide', tides: 'tide', current: 'cur', currents: 'cur' };
const CRAB_TIPS = '<div class="fm-card"><b>Blue crabs: telling them apart</b><p><b>Male (jimmy):</b> the apron on the belly is long and narrow, shaped like the Washington Monument or a T. Claw tips are blue.</p><p><b>Mature female (sook):</b> the apron is wide and rounded, like the Capitol dome. Claw tips are red, “painted fingernails”.</p><p><b>Young female (sally):</b> apron is a triangle. <b>Sponge crab:</b> a female carrying an orange or brown egg mass under the apron.</p><p><b>What you can keep:</b> Maryland sets the minimum size (measured point to point across the shell), the bushel limit and whether females may be kept, and it changes by season and year. Sponge crabs must always go back.</p><p><a href="https://dnr.maryland.gov/fisheries/Pages/regulations/crab.aspx" target="_blank" rel="noopener">Current Maryland crabbing rules ›</a></p></div>';
function fishAdvice(c) {
  if (/crab|jimmy|sook|sally/.test(c)) return CRAB_TIPS;
  const mo = new Date().getMonth() + 1, aliases = { rockfish: 'striped', striper: 'striped', stripers: 'striped', bass: 'striped', blues: 'blue', perch: 'white perch', hardhead: 'croaker', fluke: 'flounder', reds: 'red drum', redfish: 'red drum', catfish: 'catfish', mackerel: 'mackerel' };
  let key = null; Object.keys(aliases).forEach((k) => { if (new RegExp('\\b' + k + '\\b').test(c)) key = key || aliases[k]; });
  const f = key ? FISH.find((x) => x.n.toLowerCase().includes(key)) : FISH.find((x) => c.includes(x.n.split(' ')[0].toLowerCase()));
  if (!f) { const now = FISH.filter((x) => x.m.includes(mo)).map((x) => x.n); return '<div class="fm-card"><b>In season on the Chesapeake in ' + MONTHS[mo - 1] + '</b><p>' + esc(now.join(', ')) + '.</p><p>Tell me what you are after, for example “I\'m fishing for rockfish”.</p></div>'; }
  const inS = f.m.includes(mo), peak = f.peak.includes(mo);
  const lic = S.settings.fishLic || {}, licNote = lic.num ? (lic.exp && Date.parse(lic.exp) < Date.now() ? '<p><b class="warn-t">Your saved fishing license has expired.</b></p>' : '<p>License on file: ' + esc(lic.num) + (lic.exp ? ', valid to ' + new Date(lic.exp + 'T12:00').toLocaleDateString() : '') + '.</p>') : '<p>Tip: save your fishing license in Fishing and wildlife so it is always with you.</p>';
  return '<div class="fm-card"><b>' + esc(f.n) + (peak ? ' · peak season now' : inS ? ' · in season' : ' · out of season (' + f.m.map((m) => MONTHS[m - 1]).filter((_, i, a) => i === 0 || i === a.length - 1).join('–') + ')') + '</b>' +
    '<p><b>What they are biting:</b> ' + esc(f.bait) + '.</p><p><b>Where to look:</b> ' + esc(f.where) + '.</p>' +
    (f.reg ? '<p><b>Keeping fish:</b> minimum size, daily limit and open dates are set by Maryland DNR and change during the year, so check before you keep one.</p><p><a href="https://dnr.maryland.gov/fisheries/Pages/regulations/index.aspx" target="_blank" rel="noopener">Current Maryland limits ›</a></p>' : '') + licNote + '</div>';
}
async function fmLocal(text) {
  const t = text.trim().replace(/\s+/g, ' '), parts = t.split(/\s*(?:,|\band then\b|\bthen\b|\band\b(?=\s+(?:show|hide|turn|switch|zoom|open|set|plot|take|navigate|go|find)))\s*/i).filter(Boolean), done = [];
  for (const raw of parts) {
    const c = raw.toLowerCase().replace(/^(hey|ok|okay|please|can you|could you|would you|i want to|i'd like to|let's)\s+/g, '').replace(/^(please|can you|could you)\s+/, '');
    // routes: "set a course from A to B", "plot a route to B", "take me to B", "navigate to B"
    let m = c.match(/(?:set|plot|plan|make|chart|lay)(?: me)? (?:a |the )?(?:course|route|trip|passage)(?: from (.+?))? to (.+)/) || c.match(/(?:take me|navigate|go|head|get me|bring me|sail|motor|steer)(?: from (.+?))? to (.+)/) || c.match(/^route(?: from (.+?))? to (.+)/) || c.match(/^course(?: from (.+?))? to (.+)/);
    if (m) {
      const fromQ = (m[1] || '').trim(), toQ = m[2].trim();
      firstMateMessage('Finding ' + toQ + (fromQ ? ' and ' + fromQ : '') + '…');
      const from = fromQ ? await fmPlace(fromQ) : (S.fix ? { name: boatLabel(), lat: S.fix.lat, lon: S.fix.lon } : homePort());
      if (!from) { firstMateMessage('I could not find “' + fromQ + '”. Try the marina or town name.'); return true; }
      const to = await fmPlace(toQ, from); if (!to) { firstMateMessage('I could not find “' + toQ + '”. Try a marina, harbor or town name.'); return true; }
      if (distNm(from, to) > 400) { firstMateMessage(to.name + ' is ' + fmtDist(distNm(from, to)) + ' away. That is beyond what Tideline can route by water today; pick a nearer stop or plan it leg by leg.'); return true; }
      closeSheet(); setTab('chart');
      const pts = await routeByWater([{ lat: from.lat, lon: from.lon, name: from.name }, { lat: to.lat, lon: to.lon, name: to.name }]);
      RT.pts = pts; store.set('routeDraft', RT.pts); routeMode(true); map.fitBounds(L.latLngBounds(pts.map((q) => [q.lat, q.lon])).pad(0.15));
      const bad = pts.some((q) => q.unchecked), sail = pts.reduce((sum, q, i) => i ? sum + distNm(pts[i - 1], q) : 0, 0);
      headsUp(bad ? 'I could not check that course against the chart, so it is drawn dashed. Do not follow it blindly.' : 'Course plotted by water from ' + from.name + ' to ' + to.name + ': ' + fmtDist(sail) + '. Review it, then tap Start.');
      return true;
    }
    if (/\b(trim|reef|reefing|sail plan|sailing coach|coach|tack|tacking|gybe|jibe|point of sail|telltales?|upwind|downwind|beat|which sails?)\b/.test(c)) { firstMateMessage(''); $('firstMateResults').innerHTML = '<div class="fm-card">' + await sailCoachHtml() + '</div>'; return true; }
    // sailing coach: trim, reefing, when to leave
    if (/\b(more|all|every|detailed|racing) currents?\b|currents? (detail|everywhere)/.test(c)) { S.settings.curLevel = 10; setCurrents(true); firstMateMessage('Showing every current station. Zoom in on a channel to see how it runs.'); return true; }
    if (/\b(fewer|less|simpler) currents?\b/.test(c)) { S.settings.curLevel = 2; setCurrents(true); firstMateMessage('Showing just a few current arrows.'); return true; }
    if (/\b(best time|when should (i|we)|what time should (i|we))\b.*\b(leave|go|sail|depart|head out)\b/.test(c)) {
      const dm = c.match(/\b(?:for|to)\s+(.+?)[?.!]*$/), dq = dm ? dm[1].replace(/^(the)\s+/, '').trim() : '';
      if (dq && !/^(go|sail|leave)$/.test(dq)) {
        const from = S.fix ? { name: boatLabel(), lat: S.fix.lat, lon: S.fix.lon } : homePort(), to = await fmPlace(dq, from);
        if (from && to) { firstMateMessage('Plotting a course to ' + to.name + '…'); RT.pts = await routeByWater([{ lat: from.lat, lon: from.lon, name: from.name }, { lat: to.lat, lon: to.lon, name: to.name }]); store.set('routeDraft', RT.pts); drawRoute(); }
      }
      closeSheet(); openSailCoach('plan'); return true;
    }
    if (/\bgreat loop|\blooper|\bthe loop\b/.test(c)) { closeSheet(); openLoop(/limit|fit|air draft|bridge|my boat/.test(c) ? 'boat' : /lock|notice|closed|status/.test(c) ? 'live' : /report/.test(c) ? 'reports' : 'plan'); return true; }
    { const rm = c.match(/\brange rings?\b(?:.*?\b(\d+(?:\.\d+)?|half|quarter)\s*(?:nm|nautical|mile|miles)?)?/); if (rm) { const off = /\b(off|hide|remove)\b/.test(c); if (off) { S.settings.rings = false; } else { S.settings.rings = true; if (rm[1]) S.settings.ringStep = rm[1] === 'half' ? '0.5' : rm[1] === 'quarter' ? '0.25' : rm[1]; } saveSettings(); drawRings(); firstMateMessage(off ? 'Range rings off.' : 'Range rings on' + (rm[1] ? ', every ' + fmtDist(+S.settings.ringStep) : '') + '. Tap a ring label to change them.'); return true; } }
    if (/\blightning\b/.test(c)) { closeSheet(); openLightning(); return true; }
    if (/\b(arrange|move|rearrange) (the )?(buttons|icons)\b/.test(c)) { closeSheet(); setTab('chart'); setTimeout(() => arrangeMode(true), 150); return true; }
    if (/\b(what'?s (happening|going on|coming up)|this month|events?|tournaments?|regattas?|boat show)\b/.test(c)) { closeSheet(); openThisMonth(); return true; }
    if (/\b(stop listening|quit listening)\b/.test(c)) { wakeStop(); firstMateMessage('Stopped listening.'); return true; }
    // fishing assistant: "I'm fishing for rockfish", "what are the croaker biting on", crab sexing and keeping
    if (S.settings.fishTips !== false && /\b(fish|fishing|biting|bait|lure|catch|keep|limit|crab|crabs|crabbing|jimmy|sook)\b/.test(c)) { const r = fishAdvice(c); if (r) { firstMateMessage(''); $('firstMateResults').innerHTML = r; return true; } }
    // layers: "show (me) the waves", "hide wind", "turn on rain", "weather"
    m = c.match(/^(show|display|bring up|turn on|switch on|open|hide|remove|turn off|switch off|clear)(?: me)?(?: the)? (.+)/);
    const verbOn = m ? !/hide|remove|off|clear/.test(m[1]) : true, what = (m ? m[2] : c).replace(/[.?!]/g, '').trim();
    const words = what.split(/[\s,&]+/), layers = [...new Set(words.map((w) => FM_LAYER[w]).filter(Boolean))];
    if (layers.length) { layers.forEach((l) => { if (l === 'tide') { S.tideCardOn = verbOn; renderTideCard(); } else if (l === 'cur') setCurrents(verbOn); else setWxL(l, verbOn); }); setTab('chart'); done.push((verbOn ? 'Showing ' : 'Hiding ') + layers.map((l) => l === 'cur' ? 'currents' : l).join(' and ')); continue; }
    if (/^(the )?(weather|forecast)\b/.test(what)) { if (verbOn) { WX.view = 'wind'; WX.open = true; setTab('weather'); done.push('Here is the forecast'); } else { setWxL('wind', false); setWxL('waves', false); setWxL('rain', false); done.push('Weather hidden'); } continue; }
    if (/\bais\b|ships|boats|traffic|vessels/.test(what)) { S.settings.aisShow = verbOn; saveSettings(); updateAis(); renderAisBtn(); done.push(verbOn ? 'AIS ships on' : 'AIS ships off'); continue; }
    if (/satellite|aerial/.test(what)) { S.settings.satOver = verbOn; saveSettings(); applyChart(); done.push(verbOn ? 'Satellite on' : 'Satellite off'); continue; }
    if (/instrument|gauge|dashboard/.test(what)) { closeSheet(); setCockpit(verbOn); done.push(verbOn ? 'Instruments' : 'Back to the chart'); continue; }
    if (/(night|dusk|day)( mode| colou?rs| theme)?$/.test(what) || /^(night|dusk|day) mode/.test(c)) { const th = (what.match(/night|dusk|day/) || c.match(/night|dusk|day/))[0]; S.settings.theme = th; saveSettings(); applyNight(); renderThemeBtn(); done.push(th[0].toUpperCase() + th.slice(1) + ' colors'); continue; }
    if (/^zoom (in|out)/.test(c)) { if (/in/.test(c)) map.zoomIn(); else map.zoomOut(); done.push('Zoomed'); continue; }
    if (/^(find me|where am i|center (on )?(me|the boat|my boat))/.test(c)) { $('btnFollow').click(); done.push('Centered on you'); continue; }
    if (/^(stop|end|cancel)( the)? (navigation|navigating|route|course)/.test(c)) { endGoto(); done.push('Navigation ended'); continue; }
    m = c.match(/^how far (?:is it |to )?(?:to )?(.+)/);
    if (m) { const to = await fmPlace(m[1]); const from = S.fix || homePort() || refPos(); if (to && from) { firstMateMessage(to.name + ' is ' + fmtDist(distNm(from, to)) + ' away, bearing ' + fmtBrg(bearing(from, to)) + '°T, as the crow flies' + (S.fix ? '' : ' from ' + (homePort() ? homePort().name : 'the chart center')) + '.'); return true; } }
    return done.length ? (firstMateMessage(done.join(' · ') + '. Could not follow “' + raw + '”.'), true) : false;
  }
  if (done.length) { firstMateMessage(done.join(' · ') + '.'); toast(done.join(' · ')); return true; }
  return false;
}
async function askFirstMate() {
  if (FM.busy) return;
  const request = ($('firstMateRequest').value || '').trim(); if (!request) return;
  FM.busy = true; let handled = false;
  try { handled = await fmLocal(request); } catch (e) { firstMateMessage('Something went wrong: ' + (e.message || e)); handled = true; } finally { FM.busy = false; }
  if (handled) return;
  if (!S.settings.assistantUrl) { firstMateMessage('I did not catch “' + request + '”. Try: “Take me to St. Michaels”, “Set a course from SSA to Baltimore Harbor”, “Show the currents”, “Hide wind”, “Should I reef?”, “How far to Rock Hall”.'); return; }
  FM.busy = true; const boat = S.fleet.active, view = FM.view; firstMateMessage('Thinking…');
  const send = sheet.querySelector('[data-fm="send"]'); if (send) send.disabled = true;
  try {
    await sbInit(); if (!SB.client) throw new Error('Set up Account and sign in first.');
    const { data } = await SB.client.auth.getSession(); if (!data.session) throw new Error('Sign in through Menu → Account first.');
    const response = await fetch(S.settings.assistantUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token }, signal: AbortSignal.timeout(35000), body: JSON.stringify({ request, context: { boatName: S.settings.boatName, boatType: S.settings.boatType, hasGps: !!S.fix, destination: S.goto && S.goto.name || null, previousRequests: FM.history.slice(-3) } }) });
    const action = await response.json(); if (!response.ok) throw new Error(action.error || 'Assistant connection failed.');
    if (boat !== S.fleet.active || view !== FM.view || !$('firstMateReply')) return;
    FM.history.push(request); FM.history = FM.history.slice(-3);
    await firstMateExecute(action);
  } catch (e) { firstMateMessage(e.message || 'Assistant unavailable. No action taken.'); }
  finally { FM.busy = false; if (send && send.isConnected) send.disabled = false; }
}
sheet.addEventListener('click', e => {
  const d = e.target.closest('[data-fm-dest]'); if (d) { const dest = FM.destinations[+d.dataset.fmDest]; if (dest) { S.navDest = dest; closeSheet(); setTab('nav'); } return; }
  const b = e.target.closest('[data-fm]'); if (!b) return;
  if (b.dataset.fm === 'listen') firstMateListen();
  if (b.dataset.fm === 'send') askFirstMate();
  if (b.dataset.fm === 'setup') { try { const url = new URL($('firstMateEndpoint').value.trim()); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); S.settings.assistantUrl = url.href; saveSettings(); firstMateMessage('Connection saved. Sign in and try a request.'); } catch (e) { firstMateMessage('Enter the HTTPS backend URL, not an API key.'); } }
});
sheet.addEventListener('keydown', e => { if (e.target.id === 'firstMateRequest' && e.key === 'Enter') { e.preventDefault(); askFirstMate(); } });
document.addEventListener('click', e => { if (e.target.closest('[data-first-mate]')) openFirstMate(); if (e.target.closest('[data-act="close"], [data-sheetx]') && FM.recognition) FM.recognition.stop(); });
// the AI sparkle, with a small anchor at its heart
const AI_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" class="ai-ic"><path class="ai-star" d="M11.6 2.2c.7 5.3 3.9 8.5 9.2 9.2-5.3.7-8.5 3.9-9.2 9.2-.7-5.3-3.9-8.5-9.2-9.2 5.3-.7 8.5-3.9 9.2-9.2z"/><path class="ai-star" d="M19.6 1.6c.25 1.6 1.1 2.45 2.7 2.7-1.6.25-2.45 1.1-2.7 2.7-.25-1.6-1.1-2.45-2.7-2.7 1.6-.25 2.45-1.1 2.7-2.7z"/><g class="ai-anc"><circle cx="11.6" cy="8.7" r=".95"/><path d="M11.6 9.65v5.6M10.1 10.9h3M9.1 13.3a2.5 2.5 0 0 0 5 0"/></g></svg>';
(() => { const b = document.createElement('button'); b.type = 'button'; b.className = 'fab ai'; b.id = 'btnFM'; b.dataset.firstMate = 'true'; b.title = 'First mate: your AI assistant'; b.dataset.tip = 'First mate: ask by voice or type'; b.setAttribute('aria-label','First mate, your AI assistant'); b.innerHTML = AI_ICON; $('fabs').appendChild(b); })();

function applyTint() { document.documentElement.dataset.tint = S.settings.chartTint || 'blue'; }
document.documentElement.classList.toggle('lightmenus', S.settings.menuTone === 'light');
/* gauge looks, as data: one table drives the live gauges, the speed circle, the previews in the picker and (optionally) the buttons,
   so a preview always shows exactly what you will get. bz = bezel ring stops (5), fc = face (2), ink/muted/acc/n = numbers,
   scale, accent and needle, art = artwork in the face, light = a light face (panel text stays light around it) */
const GT = [
  // classic (the first six are the original looks, unchanged; their live colours come from app.css)
  { id: 'navybrass', l: 'Navy and brass', g: 'Classic', legacy: 1, bz: ['#FFF0C2', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#1B2E52', '#0A1428'], ink: '#F3E3B5' },
  { id: 'heritage', l: 'Heritage brass', g: 'Classic', legacy: 1, bz: ['#FFF1C9', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#FBF5E6', '#E6D8BA'], ink: '#1E2A3A' },
  { id: 'brass', l: 'Brass and ivory', g: 'Classic', legacy: 1, bz: ['#FFF0C2', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#FFFDF6', '#EFE6D2'], ink: '#1B1B1B' },
  { id: 'bronze', l: 'Bronze horizon', g: 'Classic', legacy: 1, bz: ['#FCE7BE', '#C08A45', '#6B4518', '#F0C987', '#8A5A22'], fc: ['#2E251B', '#0E0A06'], ink: '#F6E7CC' },
  { id: 'classic', l: 'Classic black', g: 'Classic', legacy: 1, bz: ['#F7FAFC', '#A7B2BC', '#4E5963', '#E2E8ED', '#6D7882'], fc: ['#1C1F23', '#050607'], ink: '#F4F6F8' },
  { id: 'whiteface', l: 'Classic white', g: 'Classic', legacy: 1, bz: ['#F7FAFC', '#A7B2BC', '#4E5963', '#E2E8ED', '#6D7882'], fc: ['#FFFFFF', '#E9EDF0'], ink: '#111417' },
  // classic, added
  { id: 'yachtchrono', l: 'Yacht chronometer', g: 'Classic', bz: ['#FFFFFF', '#B8C0C8', '#5E6872', '#E6EBEF', '#7C8792'], fc: ['#FBF8F0', '#E9E2D0'], ink: '#14213D', muted: '#5A6475', acc: '#1F4E9A', n: '#1F4E9A', art: 'none', light: 1 },
  { id: 'compass', l: 'Captain\'s compass', g: 'Classic', bz: ['#FFF0C2', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#1A2D4F', '#0B1630'], ink: '#F3E3B5', muted: '#BFA36A', acc: '#E8C36A', n: '#E8C36A', art: 'rose' },
  { id: 'teak', l: 'Teak and ivory', g: 'Classic', bz: ['#E9B98A', '#9A5A2E', '#4A2511', '#C68350', '#6B3A1C'], fc: ['#FCF6E8', '#EADFC6'], ink: '#1D2B44', muted: '#6A5A44', acc: '#2B5A9B', n: '#1D3F78', art: 'none', light: 1 },
  { id: 'regatta', l: 'Regatta bronze', g: 'Classic', bz: ['#F3C892', '#A86A32', '#4E2C0F', '#D9A066', '#7A4A1E'], fc: ['#1D1E22', '#060607'], ink: '#F2F2F2', muted: '#A4A4A4', acc: '#E53935', n: '#E53935', art: 'none' },
  { id: 'chart', l: 'Nautical chart', g: 'Classic', bz: ['#F6DFA4', '#B88A3E', '#5C410F', '#DDBB72', '#7E5B1D'], fc: ['#F3E7C9', '#E2D0A6'], ink: '#2A2A33', muted: '#6F5E3E', acc: '#2C5C8F', n: '#8B2A1E', art: 'topo', light: 1 },
  { id: 'admiralty', l: 'Admiralty', g: 'Classic', bz: ['#FFF0C2', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#17181A', '#050505'], ink: '#FFFFFF', muted: '#B9B2A2', acc: '#E8C36A', n: '#D32F2F', art: 'none' },
  { id: 'racinggreen', l: 'Racing green', g: 'Classic', bz: ['#FFF0C2', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#1F4A35', '#0B2117'], ink: '#F3E8C8', muted: '#B9AD84', acc: '#E8C36A', n: '#F3E8C8', art: 'none' },
  { id: 'burgundy', l: 'Burgundy and brass', g: 'Classic', bz: ['#FFF0C2', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#5A1A24', '#240509'], ink: '#F6E7CC', muted: '#C9A877', acc: '#F2C94C', n: '#F2C94C', art: 'none' },
  { id: 'mahogany', l: 'Mahogany and gold', g: 'Classic', bz: ['#D99A6C', '#8A3F1E', '#3E140A', '#B8673C', '#5E2412'], fc: ['#1B2E52', '#0A1428'], ink: '#F3E3B5', muted: '#BFA36A', acc: '#F2C94C', n: '#F2C94C', art: 'none' },
  { id: 'pewter', l: 'Pewter and slate', g: 'Classic', bz: ['#E4E6E8', '#9AA1A6', '#4F565B', '#C4C9CD', '#6E757A'], fc: ['#3A434B', '#1C2126'], ink: '#EEF1F3', muted: '#A7B0B7', acc: '#D7DDE2', n: '#E8B84A', art: 'none' },
  // from Andy's second set of boards: wood, rope, island and coastal
  { id: 'teakbrass', l: 'Teak and brass', g: 'Wood and rope', bz: ['#FFF0C2', '#C9A04E', '#6E4F12', '#EBCF86', '#8E6A1F'], fc: ['#7A4424', '#3B1E0E'], ink: '#F6E7CC', muted: '#D9B98C', acc: '#F2C94C', n: '#F6E7CC', art: 'wood' },
  { id: 'woodmin', l: 'Walnut', g: 'Wood and rope', bz: ['#B87A4E', '#6E3F1F', '#2E160A', '#9A5E36', '#4A2512'], fc: ['#5A3420', '#26140A'], ink: '#FFFFFF', muted: '#D2B598', acc: '#FFFFFF', n: '#FFFFFF', art: 'wood' },
  { id: 'islandteak', l: 'Island teak', g: 'Wood and rope', bz: ['#E9B98A', '#A8642E', '#4E2810', '#CF8E55', '#7A4218'], fc: ['#A8683A', '#5C3216'], ink: '#FFF4E2', muted: '#F0D2A8', acc: '#FFE0A8', n: '#FFF4E2', art: 'wood' },
  { id: 'rope', l: 'Rope', g: 'Wood and rope', bz: ['#E8CF9E', '#B8955E', '#6E5428', '#D6B77E', '#8A6A36'], fc: ['#1D2F4F', '#0B1630'], ink: '#F3E3B5', muted: '#BFA36A', acc: '#E8C36A', n: '#E53935', art: 'none', dec: 'rope', decC: ['#D7B47A', '#8C6A36'] },
  { id: 'polynesian', l: 'Polynesian', g: 'Wood and rope', bz: ['#C88A55', '#7E4420', '#3A1C0A', '#A8683A', '#5C2E12'], fc: ['#1B2A44', '#0A1222'], ink: '#F6E7CC', muted: '#C9A877', acc: '#F2B25C', n: '#F2B25C', art: 'none', dec: 'carved', decC: ['#8A4E26', '#3E1C08'] },
  { id: 'vintage', l: 'Vintage navigator', g: 'Wood and rope', bz: ['#F6DFA4', '#B88A3E', '#5C410F', '#DDBB72', '#7E5B1D'], fc: ['#F2E4C2', '#DCC79A'], ink: '#2A2418', muted: '#6F5E3E', acc: '#2A2418', n: '#2A2418', art: 'rose', light: 1 },
  { id: 'surf', l: 'Surf coastal', g: 'Wood and rope', bz: ['#F3E2C0', '#C9A877', '#7E6440', '#E6CFA2', '#9A7E54'], fc: ['#8FE0DC', '#2C9FAE'], ink: '#0B3440', muted: '#2F6670', acc: '#FFFFFF', n: '#0B3440', art: 'swell', light: 1 },
  { id: 'horizon', l: 'Ocean horizon', g: 'Wood and rope', bz: ['#FFFFFF', '#B8C0C8', '#5E6872', '#E6EBEF', '#7C8792'], fc: ['#9BC8E8', '#0F3E6E'], ink: '#FFFFFF', muted: '#D6E8F5', acc: '#FFFFFF', n: '#FFFFFF', art: 'deep' },
  { id: 'compassrose', l: 'Compass rose', g: 'Wood and rope', bz: ['#E4E8EE', '#1E3A6A', '#0C1E3E', '#5A78A8', '#18305A'], fc: ['#FBF5E6', '#E9DDC0'], ink: '#14284A', muted: '#5A6475', acc: '#1E3A6A', n: '#14284A', art: 'rose', light: 1 },
  // refined modern, from the third board
  { id: 'modernclassic', l: 'Modern classic', g: 'Refined', bz: ['#FFFFFF', '#B8C0C8', '#5E6872', '#E6EBEF', '#7C8792'], fc: ['#13284A', '#04080F'], ink: '#FFFFFF', muted: '#9FB0C4', acc: '#FFFFFF', n: '#FFFFFF', art: 'none' },
  { id: 'goldaccent', l: 'Gold accent', g: 'Refined', bz: ['#FFF0C2', '#D4AF5A', '#7A5A16', '#F0D48C', '#9A7424'], fc: ['#1E1E20', '#050505'], ink: '#F3D88E', muted: '#B89A5A', acc: '#E8C36A', n: '#F3D88E', art: 'none' },
  { id: 'carbonrefined', l: 'Carbon refined', g: 'Refined', bz: ['#FFFFFF', '#B8C0C8', '#5E6872', '#E6EBEF', '#7C8792'], fc: ['#2A2C2F', '#0C0D0E'], ink: '#FFFFFF', muted: '#A6ABB0', acc: '#FFFFFF', n: '#FFFFFF', art: 'carbon' },
  { id: 'smoked', l: 'Smoked titanium', g: 'Refined', bz: ['#C9CED2', '#6E767C', '#2A2F33', '#9AA2A8', '#454C51'], fc: ['#1C2228', '#07090B'], ink: '#FFFFFF', muted: '#9AA6B0', acc: '#3FA9F5', n: '#3FA9F5', art: 'deep' },
  { id: 'ceramic', l: 'Midnight ceramic', g: 'Refined', bz: ['#5A6A86', '#1C2A44', '#070D1A', '#34466A', '#101A2E'], fc: ['#0E1A33', '#03060D'], ink: '#FFFFFF', muted: '#8EA2C2', acc: '#4FB3FF', n: '#4FB3FF', art: 'deep' },
  // modern (the original looks, unchanged)
  { id: 'midnight', l: 'Midnight chrome', g: 'Modern', legacy: 1, bz: ['#F7FAFC', '#A7B2BC', '#4E5963', '#E2E8ED', '#6D7882'], fc: ['#1C3A52', '#07111A'], ink: '#EAF4F8' },
  { id: 'arctic', l: 'Arctic white', g: 'Modern', legacy: 1, bz: ['#F7FAFC', '#A7B2BC', '#4E5963', '#E2E8ED', '#6D7882'], fc: ['#FFFFFF', '#D9E2EA'], ink: '#12283A' },
  { id: 'glass', l: 'Glass ocean', g: 'Modern', legacy: 1, bz: ['#F2FBFF', '#8FD3F5', '#2C6E99', '#CDEFFF', '#4C93BF'], fc: ['#11507E', '#041628'], ink: '#E8F7FF' },
  { id: 'expedition', l: 'Expedition tech', g: 'Modern', legacy: 1, bz: ['#A8AEB4', '#4A4F55', '#16191C', '#7A8087', '#2B2F34'], fc: ['#23272B', '#0A0B0D'], ink: '#F2F2F2' },
  { id: 'carbon', l: 'Carbon', g: 'Modern', legacy: 1, bz: ['#5A5A5A', '#2A2A2A', '#111111', '#3C3C3C', '#1E1E1E'], fc: ['#1A1A1A', '#0B0B0B'], ink: '#EDEDED' },
  { id: 'simple', l: 'Simple digital', g: 'Modern', legacy: 1, bz: ['#3A4A5A', '#3A4A5A', '#3A4A5A', '#3A4A5A', '#3A4A5A'], fc: ['#15212D', '#15212D'], ink: '#FFFFFF' },
];
const MT = { navybrass: ['#14243F', '#C9A04E'], heritage: ['#1E2A3A', '#C9A04E'], brass: ['#23201A', '#C9A04E'], bronze: ['#221B13', '#C08A45'], classic: ['#17191C', '#A7B2BC'], whiteface: ['#1B2026', '#A7B2BC'],
  yachtchrono: ['#14213D', '#8FA6C9'], compass: ['#13233F', '#C9A04E'], teak: ['#2A1A10', '#C68350'], regatta: ['#18191C', '#D9A066'], chart: ['#2B241A', '#B88A3E'], admiralty: ['#121314', '#C9A04E'],
  racinggreen: ['#12291E', '#C9A04E'], burgundy: ['#2A0E13', '#C9A04E'], mahogany: ['#14243F', '#B8673C'], pewter: ['#262C32', '#9AA1A6'],
  teakbrass: ['#2A1A10', '#C9A04E'], woodmin: ['#24150C', '#C9A07A'], islandteak: ['#2E1C10', '#E0A060'], rope: ['#13233F', '#D7B47A'], polynesian: ['#1B140E', '#C88A55'], vintage: ['#2B241A', '#B88A3E'], surf: ['#0E2E36', '#5FD3CF'], horizon: ['#0E2A44', '#9BC8E8'], compassrose: ['#14284A', '#C9D3E2'],
  modernclassic: ['#101C30', '#C9D3E2'], goldaccent: ['#141414', '#D4AF5A'], carbonrefined: ['#18191B', '#C9CED2'], smoked: ['#161B20', '#3FA9F5'], ceramic: ['#0B1428', '#4FB3FF'],
  midnight: ['#16283A', '#5AE3FF'], arctic: ['#16283A', '#7CC0FF'], glass: ['#0E2A44', '#5EE6FF'], expedition: ['#1A1D20', '#FF7A1A'], carbon: ['#151515', '#30D158'], simple: ['#15212D', '#5AC8FA'] };
const mtOn = (hex) => { const n = parseInt(hex.slice(1), 16), l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.55 ? '#14161A' : '#FFFFFF'; };
const GTHEMES = GT.map((t) => [t.id, t.l, 'radial-gradient(circle,' + t.fc[0] + ' 55%,' + t.bz[1] + ' 58%)']);
const gtOf = (id) => GT.find((t) => t.id === id) || GT.find((t) => t.id === 'midnight');
const GA_CLASS = { swirl: 'ga-swirl', topo: 'ga-topos', rose: 'ga-roses', hz: 'ga-hzs', swell: 'ga-swells', wood: 'ga-woods', carbon: 'ga-carbons', deep: 'ga-deeps' };
(function gtCss() { // one stylesheet for every look: live (on <html>) and each preview tile
  const rules = (P0, t, live) => {
    const P = live ? P0 + ' :not(i.gl-prev)>svg' : P0; // live colours never leak into the preview tiles
    let c = P0 + '{--gi-ink:' + t.ink + ';--gi-muted:' + t.muted + ';--gi-acc:' + t.acc + ';--gi-n:' + t.n + ';--bt-f1:' + t.fc[0] + ';--bt-f2:' + t.fc[1] + ';--bt-ink:' + t.ink + ';' + t.bz.map((v, i) => '--bt-c' + (i + 1) + ':' + v).join(';') + '}';
    t.bz.forEach((v, i) => { c += P + ' .ch' + (i + 1) + '{stop-color:' + v + '!important}'; }); c += P + ' .fc1{stop-color:' + t.fc[0] + '!important}' + P + ' .fc2{stop-color:' + t.fc[1] + '!important}';
    c += P + ' .g-art>g{display:none!important}'; if (GA_CLASS[t.art]) c += P + ' .' + GA_CLASS[t.art] + '{display:inline!important}';
    c += P + ' .g-glare,' + P + ' .g-seam{opacity:' + (t.flat ? 0 : 1) + '!important}';
    if (t.dec) c += P + ' .g-dec-' + t.dec + '{display:inline!important}' + P0 + '{--dec1:' + (t.decC || ['#C9A26B', '#7A5A2E'])[0] + ';--dec2:' + (t.decC || ['#C9A26B', '#7A5A2E'])[1] + '}';
    if (t.light && live) c += P0 + ' :is(.cockpit,#panelSide){--g-ink:#EAF4F8!important;--g-muted:#A9BCCD!important;--g-acc:#2CD3C5!important;--g-line:#3A5670!important}' +
      P0 + ' :is(.cockpit,#panelSide) .gauge svg{--g-ink:var(--gi-ink)!important;--g-muted:var(--gi-muted)!important;--g-acc:var(--gi-acc)!important;--g-acc2:var(--gi-acc)!important;--g-face:color-mix(in srgb,var(--gi-ink) 9%,transparent)!important;--g-bg:transparent!important;--g-line:color-mix(in srgb,var(--gi-ink) 35%,transparent)!important}';
    return c;
  };
  let css0 = GT.map((t) => { const m = MT[t.id] || MT.midnight; return 'html:root[data-gtheme="' + t.id + '"]{--mt-bg:' + m[0] + ';--mt-acc:' + m[1] + ';--mt-on:' + mtOn(m[1]) + '}'; }).join(''), css = css0 + '.gl-prev{--g-ink:var(--gi-ink);--g-muted:var(--gi-muted);--g-acc:var(--gi-acc);--g-acc2:var(--gi-acc);--g-line:color-mix(in srgb,var(--gi-muted) 45%,transparent);--g-face:transparent;--g-bg:transparent}';
  GT.forEach((t) => {
    if (t.legacy) { css += 'html:root[data-gtheme="' + t.id + '"]{--bt-f1:' + t.fc[0] + ';--bt-f2:' + t.fc[1] + ';--bt-ink:' + t.ink + ';' + t.bz.map((v, i) => '--bt-c' + (i + 1) + ':' + v).join(';') + '}'; return; } // the original looks keep their own app.css styling
    css += rules('html:root[data-gtheme="' + t.id + '"]:not([data-night])', t, true) + rules('i.gl-prev.gl-prev[data-gt="' + t.id + '"]', t, false); });
  const el = document.createElement('style'); el.id = 'gtStyle'; el.textContent = css; document.head.appendChild(el);
})();
// a preview that is the real thing: the theme's bezel and face with a speed dial on it
function glPrev(id) { return '<i class="gl-prev" data-gt="' + id + '"><svg viewBox="0 0 200 200">' + bezelSvg('gp' + id + (++BZN % 1000), 100, 100) + speedGauge(6.4, 8.2, 10) + '</svg></i>'; }
function glPicker(cur) {
  return ['Classic', 'Wood and rope', 'Modern', 'Refined'].map((g) => '<div class="mo-h">' + g + '</div><div class="btheme-row gl-row">' + GT.filter((t) => t.g === g).map((t) => '<button type="button" data-gtheme="' + t.id + '" class="' + (cur === t.id ? 'on' : '') + '">' + glPrev(t.id) + t.l + '</button>').join('') + '</div>').join('');
}
function applyGTheme() { document.documentElement.dataset.gtheme = S.settings.gTheme || 'midnight'; try { renderMini(); } catch (e) { /* early */ } }
function applyMiSize() { document.documentElement.dataset.mi = S.settings.miSize || 'l'; }
applyMiSize();
applyGTheme(); document.documentElement.dataset.gstyle = S.settings.gStyle || 'hybrid';
sheet.addEventListener('click', (e) => { const b = e.target.closest('button[data-gtheme]'); if (!b) return; S.settings.gTheme = b.dataset.gtheme; saveSettings(); applyGTheme(); document.querySelectorAll('button[data-gtheme]').forEach((x) => x.classList.toggle('on', x === b)); try { if (!$('cockpit').hidden) renderCockpit(); renderSide(); } catch (err) { /* not shown */ } });
const BTHEMES = [['blue', 'Blue', 'rgba(46,112,190,.75)'], ['green', 'Green', 'rgba(34,139,96,.8)'], ['teal', 'Teal', 'rgba(16,140,150,.8)'], ['navy', 'Navy', 'rgb(18,42,78)'], ['white', 'White (classic)', '#FFFFFF'], ['july4', 'Fourth of July', 'linear-gradient(135deg,#1A2E6E 50%,#C81E2D 50%)'], ['xmas', 'Christmas', 'linear-gradient(135deg,#14643C 50%,#C41E28 50%)'], ['gold', 'Gold and blue', 'linear-gradient(135deg,#123A6B 50%,#D4A62A 50%)'], ['sunset', 'Sunset', 'linear-gradient(135deg,#E0703A 50%,#7A3C78 50%)']];
function applyBTheme() { document.documentElement.dataset.btheme = S.settings.btheme || 'blue'; }
applyBTheme();
sheet.addEventListener('click', (e) => { const b = e.target.closest('button[data-btheme]'); if (!b) return; S.settings.btheme = b.dataset.btheme; saveSettings(); applyBTheme(); b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); });
applyTint();
// iPhone Safari ignores "no zoom" in the page header, so stop the page itself from being pinched or double-tapped bigger; the chart still zooms
(() => {
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  // (double-tap zoom is already off through touch-action: manipulation; quick repeated taps on buttons keep working)
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 && !e.target.closest('#map')) e.preventDefault(); }, { passive: false });
  const vm = document.querySelector('meta[name=viewport]'); if (vm && window.visualViewport && visualViewport.scale > 1.01) { const c = vm.content; vm.content = c + ', minimum-scale=1'; setTimeout(() => { vm.content = c; }, 300); } // snap back if a page zoom stuck
  // If the page still ends up magnified, pin the whole app to the visible area at normal size, so every button and the tab bar stay on screen
  const vv = window.visualViewport, app = document.getElementById('app');
  if (vv && app) {
    let was = false;
    const fit = () => {
      const s = vv.scale || 1, off = Math.abs(s - 1) > 0.01 || vv.offsetLeft > 1 || vv.offsetTop > 1;
      if (off) {
        Object.assign(app.style, { inset: 'auto', left: vv.offsetLeft + 'px', top: vv.offsetTop + 'px', width: (vv.width * s) + 'px', height: (vv.height * s) + 'px', transform: `scale(${1 / s})`, transformOrigin: '0 0' });
      } else if (was) {
        ['inset', 'left', 'top', 'width', 'height', 'transform', 'transformOrigin'].forEach((k) => { app.style[k] = ''; });
      }
      if (off !== was || off) setTimeout(() => map.invalidateSize(), 50);
      was = off;
    };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); window.addEventListener('orientationchange', () => setTimeout(fit, 300));
    fit();
  }
})();
/* ---------- tidal currents: NOAA current prediction stations, drawn as arrows where the water actually runs (e.g. the channel off Thomas Point) ---------- */
const CUR = { st: null, loading: null, pred: new Map(), busy: new Set(), layer: L.layerGroup().addTo(map), err: false };
const curOn = () => !!S.settings.curOn;
async function curStations() {
  if (CUR.st) return CUR.st;
  const cached = store.get('curSt2', null);
  if (cached && Date.now() - cached.at < 30 * 86400000) { CUR.st = cached.list; return CUR.st; }
  if (!CUR.loading) CUR.loading = (async () => {
    const j = await fetchT('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions&units=english', 25000).then((r) => r.json());
    const seen = new Map();
    (j.stations || []).forEach((x) => { if (x.lat == null || x.lng == null) return; const o = { id: x.id, n: x.name, lat: +x.lat, lon: +x.lng, b: x.currbin != null ? x.currbin : null, d: x.depth != null ? +x.depth : null }; const p = seen.get(x.id); if (!p || (o.d != null && p.d != null && o.d < p.d)) seen.set(x.id, o); });
    CUR.st = [...seen.values()]; store.set('curSt2', { at: Date.now(), list: CUR.st }); return CUR.st;
  })().catch((e) => { CUR.err = true; CUR.loading = null; return []; });
  return CUR.loading;
}
const ymdUTC = (t) => { const d = new Date(t); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); };
async function curPred(st) {
  const day = ymdUTC(Date.now() - 86400000), key = st.id + ':' + day;
  if (CUR.pred.has(key)) return CUR.pred.get(key);
  if (CUR.busy.has(key)) return null; CUR.busy.add(key);
  try {
    const u = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=Tideline&station=' + encodeURIComponent(st.id) + (st.b != null ? '&bin=' + st.b : '') + '&begin_date=' + day + '&range=' + (24 * 9) + '&interval=MAX_SLACK&units=english&time_zone=gmt&format=json';
    const j = await fetchT(u, 20000).then((r) => r.json());
    const cp = (j.current_predictions && j.current_predictions.cp) || [];
    const ev = cp.map((c) => ({ t: Date.parse(c.Time.replace(' ', 'T') + ':00Z'), v: +(c.Velocity_Major != null ? c.Velocity_Major : c.Speed), type: String(c.Type || '').toLowerCase(), fd: c.meanFloodDir != null ? +c.meanFloodDir : null, ed: c.meanEbbDir != null ? +c.meanEbbDir : null })).filter((e) => isFinite(e.t) && isFinite(e.v));
    const out = { ev, fd: (ev.find((e) => e.fd != null) || {}).fd, ed: (ev.find((e) => e.ed != null) || {}).ed };
    if (out.fd == null && out.ed != null) out.fd = (out.ed + 180) % 360; if (out.ed == null && out.fd != null) out.ed = (out.fd + 180) % 360;
    CUR.pred.set(key, ev.length ? out : { ev: [] }); return CUR.pred.get(key);
  } catch (e) { return null; } finally { CUR.busy.delete(key); }
}
// speed and set at a moment, smoothly between NOAA's predicted slacks and maximums (positive = flood)
function curAt(p, t) {
  if (!p || !p.ev || p.ev.length < 2) return null;
  const ev = p.ev; let i = ev.findIndex((e) => e.t > t); if (i <= 0) return null;
  const a = ev[i - 1], b = ev[i], f = (t - a.t) / (b.t - a.t), v = a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2;
  const dir = v >= 0 ? p.fd : p.ed;
  const nextSlack = ev.slice(i).find((e) => e.type === 'slack' || Math.abs(e.v) < 0.15), nextMax = ev.slice(i).find((e) => e.type === 'flood' || e.type === 'ebb' || Math.abs(e.v) >= 0.15);
  return { v, kn: Math.abs(v), dir, flood: v >= 0, nextSlack, nextMax };
}
const curTime = () => Date.now() + (WX.hour || 0) * 3600000;
function curColor(kn) { return kn < 0.4 ? '#7C8B99' : kn < 1 ? '#2E86DE' : kn < 1.6 ? '#0FA3A3' : kn < 2.3 ? '#E08A00' : '#D32F2F'; }
async function drawCurrents() {
  CUR.layer.clearLayers(); if (!curOn() || S.tab === 'weather' && false) return;
  const z = map.getZoom(); if (z < 11) { renderCurChip(); return; } // zoom in to see the current spot by spot
  const list = await curStations(); if (!curOn()) return;
  const b = map.getBounds().pad(0.15), c = map.getCenter();
  // how much to show: Few (cruising under power), Normal, or Every station (racing: see exactly how the current runs)
  const lev = curLevel(), dens = lev <= 3 ? 'few' : lev >= 9 ? 'all' : 'normal', cap = Math.round(4 + lev * lev * 4), gap = Math.round(132 - lev * 12);
  const placed = [], vis = list.filter((x) => b.contains([x.lat, x.lon])).sort((p, q) => map.distance(c, [p.lat, p.lon]) - map.distance(c, [q.lat, q.lon])).filter((x) => {
    if (placed.length >= cap) return false; const pt = map.latLngToContainerPoint([x.lat, x.lon]);
    if (placed.some((q) => q.distanceTo(pt) < gap)) return false; placed.push(pt); return true;
  });
  const t = curTime();
  const paint = () => {
    CUR.layer.clearLayers(); if (!curOn()) return;
    vis.forEach((st) => {
      const p = CUR.pred.get(st.id + ':' + ymdUTC(Date.now() - 86400000)), now = curAt(p, t); if (!now) return;
      const col = curColor(now.kn), len = Math.round(16 + Math.min(3, now.kn) * 5), slack = now.kn < 0.4, lbl = S.settings.curLbl || 'all';
      if (slack && dens === 'few') return;
      const showN = lbl === 'all' || (lbl === 'strong' && now.kn >= 1);
      const html = '<div class="cur-a' + (slack ? ' slack' : '') + '" style="--c:' + col + '">' + (slack ? '<i class="cur-dot"></i>' : '<svg width="' + len + '" height="' + len + '" viewBox="0 0 24 24" style="transform:rotate(' + Math.round((now.dir || 0) + mapRot()) + 'deg)"><path d="M12 2l6 10h-4v10h-4V12H6z"/></svg>') + (showN ? '<b>' + (slack ? 'slack' : now.kn.toFixed(1) + ' kn') + '</b>' : '') + '</div>';
      const m = L.marker([st.lat, st.lon], { keyboard: false, zIndexOffset: 300, icon: L.divIcon({ className: '', iconSize: [40, 40], iconAnchor: [20, 20], html }) }).addTo(CUR.layer);
      m.on('click', (e) => { L.DomEvent.stop(e); openCurrent(st); });
      m.bindTooltip(esc(st.n) + ': ' + (slack ? 'slack' : now.kn.toFixed(1) + ' kn ' + (now.flood ? 'flood' : 'ebb') + ' toward ' + compass16(now.dir || 0)), { direction: 'top' });
    });
    renderCurChip(); CUR.vis = vis; cfField();
  };
  paint();
  const need = vis.filter((st) => !CUR.pred.has(st.id + ':' + ymdUTC(Date.now() - 86400000)));
  for (let k = 0; k < need.length; k += 6) { await Promise.all(need.slice(k, k + 6).map(curPred)); if (!curOn()) return; paint(); }
}
async function nearestCurrent(pt) {
  const list = await curStations(); if (!list.length || !pt) return null;
  let best = null, bd = Infinity; list.forEach((x) => { const d = distNm(pt, x); if (d < bd) { bd = d; best = x; } });
  return best && bd < 15 ? Object.assign({ dNm: bd }, best) : null;
}
async function renderCurChip() {
  const c = $('curChip'); if (!c) return;
  const pt = S.fix || refPos(); const st = CUR.chipSt && distNm(CUR.chipSt, pt || CUR.chipSt) < 3 ? CUR.chipSt : await nearestCurrent(pt);
  CUR.chipSt = st; const p = st ? CUR.pred.get(st.id + ':' + ymdUTC(Date.now() - 86400000)) || await curPred(st) : null, now = curAt(p, curTime());
  c.classList.toggle('on', curOn());
  c.innerHTML = '<span class="fi-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h13l-3-3M3 8h13l-3 3"/><path d="M21 16H8l3-3M21 16H8l3 3"/></svg></span><b>' + (now ? (now.kn < 0.4 ? 'slack' : now.kn.toFixed(1)) : 'Curr') + '</b>';
  c.dataset.tip = 'Current' + (now ? ': ' + (now.kn < 0.4 ? 'slack' : now.kn.toFixed(1) + ' kn ' + (now.flood ? 'flood' : 'ebb')) + ' at ' + st.n : '') + '. Tap to show current arrows on the chart; tap an arrow for that spot.';
}
function curSpark(p, t0) {
  const W = 300, H = 70, pts = []; let mx = 0.5;
  for (let h = 0; h <= 24; h += 0.25) { const n = curAt(p, t0 + h * 3600000); if (n) { pts.push([h, n.v]); mx = Math.max(mx, Math.abs(n.v)); } }
  if (!pts.length) return '';
  const X = (h) => (h / 24 * W).toFixed(1), Y = (v) => (H / 2 - v / mx * (H / 2 - 6)).toFixed(1);
  return '<svg class="cur-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><line x1="0" x2="' + W + '" y1="' + H / 2 + '" y2="' + H / 2 + '" class="cs-0"/><path d="M' + pts.map(([h, v]) => X(h) + ' ' + Y(v)).join(' L') + '" class="cs-l"/><line x1="0" x2="0" y1="0" y2="' + H + '" class="cs-now"/><text x="4" y="12" class="cs-t">flood</text><text x="4" y="' + (H - 4) + '" class="cs-t">ebb</text><text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end" class="cs-t">+24 h</text></svg>';
}
async function openCurrent(st) {
  openSheet('<h3>' + esc(st.n) + '</h3><div class="sub">Tidal current · reading NOAA predictions…</div>');
  const p = await curPred(st) || CUR.pred.get(st.id + ':' + ymdUTC(Date.now() - 86400000)), t = curTime(), now = curAt(p, t);
  if (!now) { openSheet('<h3>' + esc(st.n) + '</h3><p class="sub">No current prediction available right now.</p><div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>'); return; }
  const up = p.ev.filter((e) => e.t > t).slice(0, 8);
  const word = now.kn < 0.4 ? 'Slack water' : (now.flood ? 'Flood' : 'Ebb') + ' ' + now.kn.toFixed(1) + ' kn toward ' + compass16(now.dir || 0) + ' (' + Math.round(now.dir || 0) + '°T)';
  const set = S.settings.underSail && S.weather && S.weather.cur ? '' : '';
  openSheet('<h3>' + esc(st.n) + '</h3><div class="sub">Tidal current ' + (WX.hour ? 'at ' + scrubLabel(WX.hour) : 'now') + ' · NOAA station ' + esc(st.id) + '</div>' +
    '<div class="cur-now" style="--c:' + curColor(now.kn) + '"><b>' + esc(word) + '</b>' + (now.nextSlack ? '<span>Next slack ' + fmtClock(now.nextSlack.t) + '</span>' : '') + '</div>' + curSpark(p, t) +
    '<div class="mo-h">Coming up</div>' + up.map((e) => '<div class="cur-ev"><span class="tnum">' + new Date(e.t).toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtClock(e.t) + '</span><b>' + (e.type === 'slack' || Math.abs(e.v) < 0.15 ? 'Slack' : (e.v > 0 ? 'Max flood ' : 'Max ebb ') + Math.abs(e.v).toFixed(1) + ' kn') + '</b></div>').join('') +
    '<p class="hint">Flood runs up the Bay (toward ' + compass16(p.fd || 0) + '), ebb runs down it. These are predictions: a strong wind or a big rain can make the current run harder, start early or late. Plan to pass narrow, fast spots near slack, and with the current behind you.</p>' +
    curSettingsHtml() + '<div class="row-btns"><a class="btn" href="https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=' + encodeURIComponent(st.id) + '" target="_blank" rel="noopener">NOAA page</a><button class="btn ghost" data-act="close">Close</button></div>');
}
function curSettingsHtml() {
  const d = S.settings.curDensity || 'normal', l = S.settings.curLbl || 'all', seg = (k, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, t]) => '<button type="button" data-cur' + k + '="' + v + '" class="' + (cur === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
  return '<div class="mo-h">How much current to show</div><div class="field"><label for="curLev">Arrows: <b id="curLevV">' + curLevelWord(curLevel()) + '</b></label><input type="range" id="curLev" min="1" max="10" step="1" value="' + curLevel() + '"><div class="cur-lev-ends"><span>A few</span><span>Every station</span></div><small class="hint">Slide left for a calm chart when cruising under power; slide right to see how the current runs through each channel, for racing.</small></div>' +
    '<div class="field"><label>Moving current lines</label>' + seg('anim', S.settings.curAnim === true ? 'on' : 'off', [['off', 'Off'], ['on', 'On: water flows like the wind lines']]) + '<small class="hint">Lines drift the way the water runs, faster where the current is strong. They are drawn only near NOAA stations, and between stations they are an estimate.</small></div>' +
    '<div class="field"><label>Speed numbers</label>' + seg('lbl', l, [['all', 'On every arrow'], ['strong', 'Only 1 kn and up'], ['none', 'Off']]) + '</div>';
}
sheet.addEventListener('click', (e) => {
  const d = e.target.closest('[data-curanim]'), l = e.target.closest('[data-curlbl]'); if (!d && !l) return;
  if (d) S.settings.curAnim = d.dataset.curanim === 'on'; if (l) S.settings.curLbl = l.dataset.curlbl; saveSettings();
  (d || l).parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === (d || l))); drawCurrents(); cfField();
});
function openCurSettings() { openSheet('<h3>Tidal currents</h3><div class="sub">Arrows show where the water is running and how fast, from NOAA predictions. Tap an arrow for that spot.</div>' + curSettingsHtml() + '<div class="row-btns"><button class="btn" data-curtoggle>' + (curOn() ? 'Hide currents' : 'Show currents') + '</button><button class="btn ghost" data-act="close">Close</button></div>'); }
document.addEventListener('click', async (e) => { if (!e.target.closest('[data-cur-near]')) return; const st = await nearestCurrent(S.fix || homePort() || refPos()); if (st) openCurrent(st); else openCurSettings(); });
sheet.addEventListener('click', (e) => { if (e.target.closest('[data-curtoggle]')) { setCurrents(!curOn()); openCurSettings(); } });
sheet.addEventListener('input', (e) => { if (e.target.id !== 'curLev') return; S.settings.curLevel = +e.target.value; delete S.settings.curDensity; const v = $('curLevV'); if (v) v.textContent = curLevelWord(S.settings.curLevel); clearTimeout(CUR.lt); CUR.lt = setTimeout(() => { saveSettings(); drawCurrents(); }, 150); });
function curLevel() { if (S.settings.curLevel) return S.settings.curLevel; const d = S.settings.curDensity; return d === 'few' ? 2 : d === 'all' ? 10 : 4; }
function curLevelWord(l) { return l <= 2 ? 'a few' : l <= 4 ? 'some' : l <= 6 ? 'normal' : l <= 8 ? 'lots' : 'every station'; }
/* moving current lines: particles drift with the current, estimated between nearby NOAA stations and drawn only close to them */
const CF = { cv: null, ctx: null, parts: [], grid: null, raf: 0, moving: false };
function cfOn() { return curOn() && S.settings.curAnim === true && map.getZoom() >= 11; }
function cfCanvas() {
  if (CF.cv) return; CF.cv = document.createElement('canvas'); CF.cv.className = 'cur-flow'; map.getContainer().appendChild(CF.cv); CF.ctx = CF.cv.getContext('2d');
  const size = () => { const s2 = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1); CF.cv.width = s2.x * dpr; CF.cv.height = s2.y * dpr; CF.cv.style.width = s2.x + 'px'; CF.cv.style.height = s2.y + 'px'; CF.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); map.on('resize', () => { size(); cfField(); });
  map.on('movestart zoomstart', () => { CF.moving = true; CF.land = null; CF.landKey = ''; CF.ctx.clearRect(0, 0, CF.cv.width, CF.cv.height); });
  map.on('moveend zoomend', () => { CF.moving = false; cfField(); });
}
function cfField() {
  cfCanvas(); if (!cfOn() || !CUR.vis || !CUR.vis.length) { CF.grid = null; CF.ctx.clearRect(0, 0, CF.cv.width, CF.cv.height); return; }
  const t = curTime(), key = ymdUTC(Date.now() - 86400000), mr = mapRot() * Math.PI / 180;
  const st = CUR.vis.map((x) => { const n = curAt(CUR.pred.get(x.id + ':' + key), t); if (!n) return null; const pt = map.latLngToContainerPoint([x.lat, x.lon]), a = (n.dir || 0) * Math.PI / 180 + mr; return { x: pt.x, y: pt.y, u: Math.sin(a) * n.kn, v: -Math.cos(a) * n.kn, kn: n.kn }; }).filter(Boolean);
  if (!st.length) { CF.grid = null; return; }
  const sz = map.getSize(), G = 22, W = Math.ceil(sz.x / G) + 1, H = Math.ceil(sz.y / G) + 1, u = new Float32Array(W * H), v = new Float32Array(W * H), ok = new Uint8Array(W * H);
  const nmPx = (() => { const c = map.getCenter(), a = map.latLngToContainerPoint(c), b = map.latLngToContainerPoint([c.lat + 1 / 60, c.lng]); return Math.hypot(a.x - b.x, a.y - b.y); })();
  const R = Math.max(40, nmPx * 1.2); // draw only within about 1.2 nm of a station
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = i * G, y = j * G; let wu = 0, wv = 0, ws = 0, near = Infinity;
    st.forEach((q) => { const d = Math.hypot(q.x - x, q.y - y); near = Math.min(near, d); if (d < R * 2.5) { const w = 1 / Math.max(64, d * d); wu += q.u * w; wv += q.v * w; ws += w; } });
    const k = j * W + i; if (near < R && ws) { u[k] = wu / ws; v[k] = wv / ws; ok[k] = 1; }
  }
  CF.grid = { W, H, G, u, v, ok };
  cfLand(); // keep the lines off land, using the NOAA chart's land areas for this view
  if (!CF.parts.length || CF.parts.length !== cfCount()) CF.parts = Array.from({ length: cfCount() }, () => cfSpawn());
  if (!CF.raf) CF.raf = requestAnimationFrame(cfStep);
}
async function cfLand() {
  const b = map.getBounds().pad(0.05), key = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(3)).join(','); if (CF.landKey === key) return; CF.landKey = key;
  const z = map.getZoom(), svc = z >= 13 ? 'enc_harbour' : 'enc_approach', bb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  let land = []; try { land = await encQuery(svc, 'land', bb, (0.00002 * Math.pow(2, 16 - z)).toFixed(6)); if (!land.length && svc === 'enc_harbour') land = await encQuery('enc_approach', 'land', bb, 0.0001); } catch (e) { return; }
  if (CF.landKey !== key) return;
  const sz = map.getSize(), m = document.createElement('canvas'); m.width = sz.x; m.height = sz.y; const c = m.getContext('2d'); c.fillStyle = '#000';
  land.forEach((f) => { if (!f.rings) return; c.beginPath(); f.rings.forEach((r) => r.forEach(([lon, lat], i) => { const p = map.latLngToContainerPoint([lat, lon]); if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); })); c.fill('evenodd'); });
  CF.land = { d: c.getImageData(0, 0, sz.x, sz.y).data, w: sz.x, h: sz.y };
}
function cfCount() { return Math.round(150 + curLevel() * 90); }
function cfSpawn() { const sz = map.getSize(); return { x: Math.random() * sz.x, y: Math.random() * sz.y, age: Math.random() * 60 | 0 }; }
function cfAt(x, y) { const g = CF.grid; if (!g) return null; const Ld = CF.land; if (Ld && x >= 0 && y >= 0 && x < Ld.w && y < Ld.h && Ld.d[((y | 0) * Ld.w + (x | 0)) * 4 + 3] > 100) return null; const i = Math.round(x / g.G), j = Math.round(y / g.G); if (i < 0 || j < 0 || i >= g.W || j >= g.H) return null; const k = j * g.W + i; return g.ok[k] ? [g.u[k], g.v[k]] : null; }
function cfStep() {
  CF.raf = 0; if (!cfOn() || !CF.grid || document.hidden) { if (CF.ctx) CF.ctx.clearRect(0, 0, CF.cv.width, CF.cv.height); return; }
  CF.raf = requestAnimationFrame(cfStep); if (CF.moving) return;
  const c = CF.ctx, sz = map.getSize(), night = document.documentElement.hasAttribute('data-night');
  c.globalCompositeOperation = 'destination-out'; c.fillStyle = 'rgba(0,0,0,0.10)'; c.fillRect(0, 0, sz.x, sz.y); c.globalCompositeOperation = 'source-over';
  c.lineWidth = 1.6; c.lineCap = 'round';
  CF.parts.forEach((p) => {
    const f = cfAt(p.x, p.y); if (!f || ++p.age > 90) { Object.assign(p, cfSpawn(), { age: 0 }); return; }
    const kn = Math.hypot(f[0], f[1]); if (kn < 0.15) { p.age += 3; return; }
    const sp = 0.45 + kn * 0.9, nx = p.x + f[0] / kn * sp, ny = p.y + f[1] / kn * sp;
    c.strokeStyle = night ? 'rgba(220,120,100,.75)' : kn < 0.6 ? 'rgba(40,110,200,.55)' : kn < 1.2 ? 'rgba(10,140,150,.7)' : kn < 2 ? 'rgba(220,130,0,.8)' : 'rgba(210,40,40,.85)';
    c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(nx, ny); c.stroke(); p.x = nx; p.y = ny;
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && cfOn()) cfField(); });
map.on('rotate', () => { clearTimeout(CF.rt); CF.rt = setTimeout(cfField, 150); });
function setCurrents(on) { S.settings.curOn = on; saveSettings(); drawCurrents(); renderCurChip(); cfField(); try { renderWxBtn(); } catch (e) { /* early */ } }
(() => { // the current button sits with wind, waves, rain and tide in the weather pop-out
  const grp = document.querySelector('.wx-pop'); if (!grp) return;
  const b = document.createElement('button'); b.id = 'curChip'; b.type = 'button'; b.className = 'fab info'; b.setAttribute('aria-label', 'Tidal currents on the chart');
  const tc = $('tideChip'); grp.insertBefore(b, tc ? tc.nextSibling : null);
  let lp = null, held = false;
  b.addEventListener('pointerdown', () => { held = false; lp = setTimeout(() => { held = true; openCurSettings(); }, 550); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => clearTimeout(lp)));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', () => { if (held) { held = false; return; } setTab('chart'); setCurrents(!curOn()); toast(curOn() ? 'Current arrows on. Tap an arrow for a spot; press and hold this button to show more or fewer.' : 'Current arrows off', 4500); });
  renderCurChip();
})();
map.on('moveend', () => { if (curOn()) { clearTimeout(CUR.mt); CUR.mt = setTimeout(drawCurrents, 300); } });
setInterval(() => { if (curOn()) drawCurrents(); else renderCurChip(); }, 5 * 60000);
setTimeout(() => { if (curOn()) drawCurrents(); }, 2500);
QUICK.splice(QUICK.findIndex((q) => q[0] === 'rain') + 1, 0, ['cur', 'Tidal currents (long-press the current button for detail)', () => curOn(), (on) => setCurrents(on)]);
FM_LAYER.current = 'cur'; FM_LAYER.currents = 'cur';
/* ---------- sailing coach: sail plan, trim and how to sail the course, from the wind, your heading, the current and the forecast ---------- */
function pointOfSail(twa) {
  return twa < 35 ? ['In irons', 'too close to the wind to sail'] : twa < 60 ? ['Close-hauled', 'beating to windward'] : twa < 80 ? ['Close reach', ''] : twa < 110 ? ['Beam reach', 'usually the fastest point of sail'] : twa < 150 ? ['Broad reach', ''] : ['Running', 'wind from behind'];
}
const TRIM = {
  'In irons': ['Bear away until the sails fill: back the jib to the side you want the bow to go if it will not come round.', 'Pick a tack and sail close-hauled; you cannot sail straight at the wind.'],
  'Close-hauled': ['Jib sheeted in hard, about a hand off the spreader. Steer by the telltales: both streaming, inside one just lifting.', 'Main: traveler near the middle, sheet in until the top batten is parallel to the boom. Outhaul and backstay on as the wind builds to flatten the sails.', 'Heeling past about 20° is slower, not faster: ease the traveler down in the puffs, then reef.'],
  'Close reach': ['Ease the jib and main a few inches from close-hauled; move the jib lead slightly forward.', 'Keep the telltales streaming and the boat flat: drop the traveler in gusts.'],
  'Beam reach': ['Ease both sails out until they just start to luff, then pull them back in a touch.', 'Ease the outhaul for a fuller, more powerful main; a bit of vang keeps the boom from lifting.', 'Move the jib lead forward or outboard so the whole sail breaks evenly.'],
  'Broad reach': ['Sails well out; ease until the luff just curls, then trim back.', 'Vang on to stop the main twisting off; ease the backstay.', 'Watch the wind angle: below about 150° the jib collapses behind the main.'],
  'Running': ['Main out to the shrouds and rig a preventer so an accidental gybe cannot swing the boom.', 'Try wing-on-wing (jib on the opposite side) or head up 10–20° to a broad reach and gybe: it is often faster and steadier.', 'Keep your head below the boom line and gybe with the main sheeted to the middle first.']
};
function sailPlan(kn, gust) {
  const g = Math.max(kn || 0, gust || 0);
  if (g >= 30) return { lvl: 'bad', t: 'Stay in or get in: gusts ' + Math.round(g) + ' kn are beyond comfortable sailing for most cruising boats. If you are out, deep reefs and a small jib, or motor to shelter.' };
  if (g >= 24 || kn >= 20) return { lvl: 'warn', t: 'Second reef in the main and a well-rolled jib (about half). Reef at the dock before you go out.' };
  if (g >= 18 || kn >= 14) return { lvl: 'warn', t: 'First reef in the main; roll a few turns into the jib if you are overpowered. Rule of thumb: the time to reef is the first time you think about it.' };
  if (kn >= 10) return { lvl: 'ok', t: 'Full sail. Flatten the sails (outhaul, backstay, cunningham) and ease the traveler in the puffs.' };
  if (kn >= 5) return { lvl: 'ok', t: 'Full sail, fuller shape: ease the outhaul and backstay, and sit to leeward to help the sails hang.' };
  return { lvl: 'info', t: 'Very light wind. Keep the sails full and soft, move smoothly, and be ready to motor if you have a schedule.' };
}
async function sailCoachHtml() {
  const w = S.weather, t = curTime();
  if (!w || !w.cur) return '<p class="sub">Waiting for the wind forecast here. Try again in a moment.</p>';
  const sa = (k) => { const v = WX.hour ? seriesAt(w.hours, t, k) : null; return v != null ? v : w.cur[k]; }, kn = sa('spd'), gust = sa('gust'), from = sa('dir');
  const moving = S.fix && (S.sog || 0) > 1.2 && isFinite(S.cog);
  let dest = null; if (S.goto) dest = S.goto; else if (RT.pts.length > 1) dest = RT.pts[1];
  const here = S.fix || homePort() || refPos();
  const hdg = moving ? S.cog : dest && here ? bearing(here, dest) : null;
  const plan = sailPlan(kn, gust), out = [];
  out.push('<div class="sc-wind"><b>Wind ' + Math.round(speedOut(kn)) + (gust ? ' gusting ' + Math.round(speedOut(gust)) : '') + ' ' + SPEED_LBL[S.settings.speedUnit] + ' from the ' + compass16(from) + '</b><span>' + (WX.hour ? 'forecast for ' + scrubLabel(WX.hour) : 'now') + '</span></div>');
  out.push('<div class="sc-card ' + plan.lvl + '"><h4>Sail plan</h4><p>' + esc(plan.t) + '</p></div>');
  if (hdg != null) {
    const twa = angDiff(hdg, from), [pos, note] = pointOfSail(twa), side = (((from - hdg + 360) % 360) < 180) ? 'starboard' : 'port';
    out.push('<div class="sc-card"><h4>' + (moving ? 'You are ' : 'Heading ' + (S.goto ? 'to ' + esc(S.goto.name) + ' is ' : 'to your first waypoint is ')) + esc(pos.toLowerCase()) + (twa >= 35 ? ' on ' + side + ' tack' : '') + '</h4><p class="sub">' + Math.round(twa) + '° off the wind' + (note ? ' · ' + esc(note) : '') + '</p><ul>' + TRIM[pos].map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>');
    if (dest && here) {
      const brg = bearing(here, dest), dwa = angDiff(brg, from), d = distNm(here, dest), spd = S.settings.sailSpeed || 5;
      if (dwa < 42) {
        const portH = (from + 45) % 360, stbdH = (from - 45 + 360) % 360, favor = angDiff(portH, brg) < angDiff(stbdH, brg) ? ['port', portH] : ['starboard', stbdH];
        const sailed = d / Math.cos((45 - dwa) * Math.PI / 180) * 1.05, hrs = sailed / (spd * 0.85);
        const later = w.hours ? seriesAt(w.hours, t + 3 * 3600000, 'dir') : null, shift = later != null ? ((later - from + 540) % 360) - 180 : 0;
        out.push('<div class="sc-card"><h4>Getting there: it is upwind</h4><p>' + esc(dest.name || 'Your destination') + ' is ' + fmtDist(d) + ' at ' + fmtBrg(brg) + '°T, only ' + Math.round(dwa) + '° off the wind, so you will tack. Headings about <b>' + fmtBrg(portH) + '°</b> on port and <b>' + fmtBrg(stbdH) + '°</b> on starboard.</p><p>Start on <b>' + favor[0] + ' tack (' + fmtBrg(favor[1]) + '°)</b>: it points closer to the mark. Expect roughly ' + fmtDist(sailed) + ' through the water, about ' + fmtDur(hrs) + '.</p>' + (Math.abs(shift) >= 15 ? '<p>The wind is forecast to ' + (shift > 0 ? 'veer (shift right) ' : 'back (shift left) ') + Math.abs(Math.round(shift)) + '° in the next 3 hours: sail toward the new wind first, the ' + (shift > 0 ? 'right' : 'left') + ' side of the course looking upwind.</p>' : '') + '<p class="hint">Stay inside the laylines and do not overstand. Tack in the lulls, not the puffs.</p></div>');
      } else if (dwa > 160) {
        out.push('<div class="sc-card"><h4>Getting there: dead downwind</h4><p>Rather than running straight at ' + fmtBrg(brg) + '°, broad reach at about ' + fmtBrg((from + 180 + 30) % 360) + '° and ' + fmtBrg((from + 180 - 30 + 360) % 360) + '° and gybe once or twice: steadier, safer, often as quick.</p></div>');
      } else out.push('<div class="sc-card"><h4>Getting there: one tack</h4><p>' + esc(dest.name || 'Your destination') + ' is ' + fmtDist(d) + ' at ' + fmtBrg(brg) + '°T: a ' + esc(pointOfSail(dwa)[0].toLowerCase()) + ' all the way. About ' + fmtDur(d / spd) + ' at ' + fmtSpeed(spd) + ' ' + SPEED_LBL[S.settings.speedUnit] + '.</p></div>');
    }
  } else out.push('<div class="sc-card"><h4>Trim</h4><p>Start moving, or set a destination, and I will tell you your point of sail, how to trim and which tack to start on.</p></div>');
  try {
    const st = await nearestCurrent(here), p = st ? await curPred(st) : null, c = curAt(p, t);
    if (c && c.kn >= 0.5) {
      const against = angDiff(c.dir || 0, (from + 180) % 360) > 120; // current running into the wind
      out.push('<div class="sc-card' + (against && kn >= 12 && c.kn >= 1 ? ' warn' : '') + '"><h4>Current ' + c.kn.toFixed(1) + ' kn ' + (c.flood ? 'flood' : 'ebb') + ' toward ' + compass16(c.dir || 0) + '</h4><p>' + (against ? 'It runs against the wind: expect a short, steep chop' + (kn >= 12 ? ', especially in the channels' : '') + '.' : 'It runs with the wind: flatter water.') + (c.nextSlack ? ' Next slack ' + fmtClock(c.nextSlack.t) + '.' : '') + '</p><p class="hint">' + esc(st.n) + '. Ride a fair current, and cross strong, narrow spots near slack.</p></div>');
    }
  } catch (e) { /* current not available */ }
  const bt = baroTrend(); if (bt && bt.warn) out.push('<div class="sc-card warn"><h4>Barometer ' + esc(bt.word) + '</h4><p>Falling pressure means more wind is on the way. Reef early and keep a way home.</p></div>');
  return out.join('');
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-sailcoach]')) openSailCoach(); });
/* ---------- sailing coach: sail plan and trim for the wind now, and the best time to leave for a route given wind and current ---------- */
function scHull() { const h = hullSpeed(); return h ? h.kn : 6.3; }
// a rough cruising-boat polar: speed as a share of hull speed, by true wind speed and angle
function scSpeed(tws, twa) {
  if (twa < 35 || tws < 1.5) return 0;
  const f = Math.min(1, Math.pow(Math.max(0, tws - 1) / 13, 0.65)), A = [[35, 0.55], [45, 0.78], [60, 0.9], [90, 1], [120, 0.97], [150, 0.82], [180, 0.7]];
  let af = A[A.length - 1][1]; for (let i = 1; i < A.length; i++) if (twa <= A[i][0]) { const [a0, v0] = A[i - 1], [a1, v1] = A[i]; af = v0 + (v1 - v0) * (twa - a0) / (a1 - a0); break; }
  return scHull() * 0.92 * f * af * (tws > 22 ? 0.9 : 1);
}
async function scCurrentNear(pt, t) { try { const st = await nearestCurrent(pt); if (!st || st.dNm > 4) return null; const p = await curPred(st); const n = curAt(p, t); return n ? Object.assign({ st }, n) : null; } catch (e) { return null; } }
function scLegs() { // the legs of the route you are planning or navigating, else the line to your destination
  const pts = RT.pts && RT.pts.length > 1 ? RT.pts : S.goto && S.goto.route ? S.goto.route.pts : S.goto ? [S.fix || refPos(), S.goto] : null;
  if (!pts) return null; const legs = [];
  for (let i = 1; i < pts.length; i++) { const d = distNm(pts[i - 1], pts[i]); if (d > 0.02) legs.push({ a: pts[i - 1], b: pts[i], d, brg: bearing(pts[i - 1], pts[i]) }); }
  return legs.length ? legs : null;
}
// how long a route takes leaving at time t: wind from the forecast each hour, tacking or gybing as needed, current at the nearest NOAA station
async function scPassage(legs, t0) {
  const w = S.weather; if (!w || !w.hours) return null;
  let t = t0, tack = 0, foulNm = 0, fairNm = 0, chop = false, maxG = 0, minW = 99, motor = 0, pos = [];
  for (const L0 of legs) {
    const tws = seriesAt(w.hours, t, 'spd'), dir = seriesAt(w.hours, t, 'dir'), gust = seriesAt(w.hours, t, 'gust'); if (tws == null || dir == null) return null;
    maxG = Math.max(maxG, gust || tws); minW = Math.min(minW, tws);
    const twa = angDiff(dir, L0.brg);
    let made; // speed made good along the leg
    if (twa < 45) { made = scSpeed(tws, 45) * Math.cos(45 * Math.PI / 180) / Math.cos(twa * Math.PI / 180); tack++; }
    else if (twa > 160) { made = scSpeed(tws, 150) * Math.cos(30 * Math.PI / 180) / Math.cos((180 - twa) * Math.PI / 180); }
    else made = scSpeed(tws, twa);
    const mid = { lat: (L0.a.lat + L0.b.lat) / 2, lon: (L0.a.lon + L0.b.lon) / 2 }, cur = await scCurrentNear(mid, t);
    if (cur && cur.dir != null) { const along = cur.kn * Math.cos(angDiff(cur.dir, L0.brg) * Math.PI / 180); made += along; if (along < -0.3) foulNm += L0.d; if (along > 0.3) fairNm += L0.d; if (cur.kn > 0.9 && tws > 10 && angDiff(cur.dir, (dir + 180) % 360) > 135) chop = true; }
    if (made < 1.2) { motor += L0.d; made = Math.max(made, S.settings.cruise || 5); }
    t += L0.d / made * 3600000; pos.push(pointOfSail(Math.max(twa, 35))[0].toLowerCase());
  }
  return { t0, t1: t, hrs: (t - t0) / 3600000, tack, foulNm, fairNm, chop, maxG, minW, motor, pos: [...new Set(pos)] };
}
async function scBestTimes(legs) {
  const w = S.weather; if (!w || !w.hours) return [];
  const start = Math.ceil(Date.now() / 3600000) * 3600000, out = [];
  for (let h = 0; h < 36; h++) {
    const t = start + h * 3600000, here = legs[0].a, end = legs[legs.length - 1].b;
    if (sunElev(here.lat, here.lon, t) < 2) continue; // leave in daylight
    const r = await scPassage(legs, t); if (!r) continue;
    r.dark = sunElev(end.lat, end.lon, r.t1) < -4; // arrives after dark
    let score = r.hrs; score += r.motor * 0.6; score += r.maxG > 25 ? 6 : r.maxG > 20 ? 2 : 0; score += r.chop ? 1.5 : 0; score += r.tack ? 0.4 : 0; score += r.dark ? 4 : 0;
    const ss = typeof sunTimes === 'function' ? null : null; // daylight handled by the hour filter
    out.push(Object.assign({ score }, r));
  }
  return out.sort((a, b) => a.score - b.score);
}
async function openSailCoach(tab) {
  tab = tab || 'now'; SC.tab = tab;
  const w = S.weather, tws = w && w.cur ? w.cur.spd : null, gust = w && w.cur ? w.cur.gust : null, dir = w && w.cur ? w.cur.dir : null;
  const tabs = '<div class="seg fw-tabs">' + [['now', 'Sail now'], ['plan', 'Best time to go'], ['basics', 'Basics']].map(([v, l]) => '<button type="button" data-sctab="' + v + '" class="' + (tab === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
  let h = '<h3>Sailing coach</h3>' + tabs;
  if (tab === 'now') {
    openSheet(h + '<p class="sub">Reading the wind…</p>');
    const body = await sailCoachHtml(); if (SC.tab !== 'now') return;
    h += body + '<label class="air-ok"><input type="checkbox" id="scTips"' + (S.settings.sailTips !== false ? ' checked' : '') + '> Coach me while sailing (a short tip when it is time to reef or shake one out)</label>';
  } else if (tab === 'plan') {
    const legs = scLegs();
    if (!legs) h += '<p class="sub">Plan a route first (Navigate → Route, or ask the first mate “set a course to St. Michaels”). Then I will find the best time to leave, using the hour-by-hour wind forecast and NOAA tidal currents along the way.</p><div class="row-btns"><button class="btn primary" data-scact="route">Plan a route</button></div>';
    else {
      openSheet(h + '<p class="sub">Working through the next 36 hours of wind and current…</p>');
      const best = await scBestTimes(legs); if (SC.tab !== 'plan') return;
      const total = legs.reduce((s, l) => s + l.d, 0);
      if (!best.length) h += '<p class="sub">No forecast yet. Try again in a moment.</p>';
      else {
        h += '<div class="sub">' + fmtDist(total) + ' route · daylight departures in the next 36 hours, best first (arriving before dark counts)</div>';
        h += best.slice(0, 5).map((r, i) => '<div class="sc-win' + (i ? '' : ' best') + '"><div><b>' + new Date(r.t0).toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtClock(r.t0) + '</b><span>arrive ' + fmtClock(r.t1) + ' · ' + fmtDur(r.hrs) + '</span></div><ul>' +
          '<li>Wind ' + Math.round(speedOut(r.minW)) + (r.maxG > r.minW + 2 ? '–' + Math.round(speedOut(r.maxG)) : '') + ' ' + SPEED_LBL[S.settings.speedUnit] + ' · ' + esc(r.pos.join(', ')) + '</li>' +
          (r.tack ? '<li>Upwind on ' + r.tack + ' leg' + (r.tack > 1 ? 's' : '') + ': expect to tack</li>' : '') +
          (r.fairNm > 0.5 ? '<li class="good">Current with you for ' + fmtDist(r.fairNm) + '</li>' : '') + (r.foulNm > 0.5 ? '<li class="bad">Current against you for ' + fmtDist(r.foulNm) + '</li>' : '') +
          (r.chop ? '<li class="bad">Wind against current somewhere on the way: steep chop</li>' : '') + (r.motor > 0.5 ? '<li>Too light to sail for about ' + fmtDist(r.motor) + ' (motoring)</li>' : '') + (r.maxG > 22 ? '<li class="bad">Gusts over 22: reef before you leave</li>' : '') + (r.dark ? '<li class="bad">Arrives after dark</li>' : '') + '</ul></div>').join('');
        h += '<p class="hint">From the hourly wind forecast, a rough polar for your boat (hull speed ' + fmtSpeed(scHull()) + ') and NOAA current predictions at the station nearest each leg. It is a guide; check the forecast and the sky before you go.</p>';
      }
    }
  } else {
    h += '<div class="fm-card"><b>Points of sail</b><ul><li><b>Close-hauled</b> (about 45° off the wind): sails in tight, steer by the jib telltales.</li><li><b>Reaching</b> (60–150°): ease the sails until they just luff, then trim back a touch.</li><li><b>Running</b> (wind behind): main way out, preventer on, watch for an accidental gybe.</li></ul></div>' +
      '<div class="fm-card"><b>Reading telltales</b><ul><li>Both streaming back: trimmed right.</li><li>Windward (inside) one lifting: head down or sheet in.</li><li>Leeward (outside) one lifting: head up or ease out.</li><li>Main: the top leech telltale should stream most of the time; if it hides behind the sail, ease the sheet or vang a little.</li></ul></div>' +
      '<div class="fm-card"><b>Reefing the main (slab reef)</b><ul><li>Head up to about 50° off the wind, ease the mainsheet and vang.</li><li>Lower the halyard to the reef mark; hook the tack ring on the horn.</li><li>Re-tension the halyard, then pull in the reef line at the clew.</li><li>Tie the reef points loosely around the bunched sail only, never around the boom.</li></ul></div>' +
      '<div class="fm-card"><b>Heaving to</b><ul><li>Tack without releasing the jib, so it is backed.</li><li>Ease the main a little and lash the tiller to leeward (wheel to windward).</li><li>The boat sits quietly, drifting slowly: a good way to reef, rest or eat.</li></ul></div>' +
      '<div class="fm-card"><b>Chesapeake notes</b><ul><li>Afternoon thunderstorms in summer: watch the west, and reef when the sky darkens.</li><li>A southerly sea-breeze often fills in by early afternoon.</li><li>Wind against current off Thomas Point, the Bay Bridge and river mouths makes steep, short chop.</li></ul></div>';
  }
  h += '<div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>';
  openSheet(h);
}
const SC = { tab: 'now', last: null };
sheet.addEventListener('click', (e) => { const t = e.target.closest('[data-sctab]'); if (t) { openSailCoach(t.dataset.sctab); return; } const a = e.target.closest('[data-scact]'); if (a && a.dataset.scact === 'route') { closeSheet(); routeMode(true); } if (a && a.dataset.scact === 'plan2') openSailCoach('plan'); });
sheet.addEventListener('change', (e) => { if (e.target.id === 'scTips') { S.settings.sailTips = e.target.checked; saveSettings(); } });
setInterval(() => { // a quiet nudge when the wind crosses a reefing step, only while under sail
  if (!S.settings.underSail || S.settings.sailTips === false || !S.weather || !S.weather.cur) return;
  const p = sailPlan(S.weather.cur.spd, S.weather.cur.gust); if (SC.last != null && p.lvl !== SC.last) toast('Sailing coach: ' + p.t, 9000); SC.last = p.lvl;
}, 5 * 60000);
/* ---------- Great Loop advisor: the route leg by leg, what limits your boat, when to be where, live notices, and reports from other loopers ---------- */
const LOOP = {
  legs: [
    { id: 'ches', n: 'Chesapeake Bay to Cape May', when: 'April–May', c: [38.6, -76.2], why: 'C&D Canal and Delaware Bay. Time the C&D with the current (2–3 kn) and pick a calm day for Delaware Bay: wind against the ebb gets ugly.' },
    { id: 'nj', n: 'New Jersey coast', when: 'May', c: [39.9, -74.1], why: 'Outside on the Atlantic (Cape May to Manasquan, about 100 nm) on a good weather window, or the inside NJ ICW: shallow (4 ft or less is happier) with several 35 ft fixed bridges.' },
    { id: 'nyc', n: 'New York Harbor and the Hudson', when: 'Late May–June', c: [41.5, -73.95], why: 'Past the Statue of Liberty and up the Hudson. Sailboats unstep the mast before the canals (Catskill and Castleton are the usual yards).' },
    { id: 'erie', n: 'Erie Canal / Oswego Canal (or Champlain)', when: 'June', c: [43.1, -75.6], why: 'Most loopers take the Erie from Waterford to Three Rivers, then the Oswego Canal (21 ft clearance) to Lake Ontario. The western Erie needs 15 ft 6 in. The canal opens for the season in spring: check NY Canal notices.' },
    { id: 'trent', n: 'Trent–Severn Waterway', when: 'July', c: [44.4, -78.4], why: '240 miles across Ontario with the Peterborough and Kirkfield lift locks and the Big Chute marine railway. Fully loaded draft 5 ft or less, beam 23 ft or less. Parks Canada sets the season and hours.' },
    { id: 'gbay', n: 'Georgian Bay and the North Channel', when: 'July–August', c: [45.6, -81.3], why: 'Thirty thousand islands and granite: beautiful and unforgiving. Stay in the marked small-craft route and trust the chart over the plotter shortcut.' },
    { id: 'mich', n: 'Lake Michigan to Chicago', when: 'August', c: [43.5, -87.0], why: 'Down the east or west shore. Lake seas build quickly and steeply: wait for a window; many legs have few harbors of refuge.' },
    { id: 'chi', n: 'Chicago and the Illinois River', when: 'Early September', c: [41.3, -88.6], why: 'The fixed bridge at mile 300.6 of the Chicago Sanitary and Ship Canal is 19 ft 6 in: the limit for every looper. Downtown Chicago needs 17 ft (or take the Calumet route). Pass the electric fish barrier without stopping. Share the river with big tows: call them on VHF 13/16.' },
    { id: 'rivers', n: 'Mississippi, Ohio and Cumberland or Tennessee', when: 'September–October', c: [37.3, -89.0], why: 'Down the Mississippi from Grafton, then up the Ohio to the Cumberland or Tennessee (Green Turtle Bay, Kentucky Lake). Fuel is scarce on the upper Mississippi: plan about 200 miles of range. Lock waits for commercial tows can be hours.' },
    { id: 'tenntom', n: 'Tenn–Tom Waterway to Mobile', when: 'October–November', c: [33.0, -88.3], why: 'Twelve locks down to Demopolis and Mobile Bay. Masts can go back up around Mobile.' },
    { id: 'gulf', n: 'The Gulf crossing (Big Bend)', when: 'November (after hurricane season)', c: [29.5, -84.0], why: 'Carrabelle to Tarpon Springs or Steinhatchee, about 170 nm, often overnight. The single biggest weather decision of the Loop: wait for the window, travel with others. Many insurers want you south of the Gulf coast only after November 1.' },
    { id: 'fla', n: 'Florida: Keys or the Okeechobee', when: 'December–February', c: [26.6, -81.6], why: 'Down the west coast to the Keys, or across on the Okeechobee Waterway (Port Mayaca railroad bridge 49 ft). Winter here; many hop to the Bahamas.' },
    { id: 'icw', n: 'Atlantic ICW home', when: 'March–May', c: [32.5, -80.8], why: 'North on the ICW through Georgia (watch shoaling and plan by tide) and the Carolinas (65 ft fixed bridges) to Norfolk, Mile 0, and back up the Bay: cross your wake.' }
  ],
  links: [
    ['Corps of Engineers lock status and queues', 'https://corpslocks.usace.army.mil/'], ['New York State canals: notices to mariners', 'https://www.canals.ny.gov/'],
    ['Parks Canada: Trent–Severn Waterway', 'https://parks.canada.ca/lhn-nhs/on/trentsevern'], ['Parks Canada: Rideau Canal', 'https://parks.canada.ca/lhn-nhs/on/rideau'],
    ['Coast Guard Local Notice to Mariners', 'https://www.navcen.uscg.gov/msi'], ['NOAA Great Lakes forecasts', 'https://www.weather.gov/greatlakes/'],
    ['America’s Great Loop Cruisers’ Association', 'https://www.greatloop.org/'], ['Waterway Guide navigation alerts', 'https://www.waterwayguide.com/']
  ],
  rep: store.get('loopReps', []), shared: [], layer: L.layerGroup().addTo(map), fr: store.get('loopFR', []), frAt: store.get('loopFRAt', 0)
};
const LOOP_KIND = { lock: ['Lock', '#2E86DE'], shoal: ['Shoaling', '#E08A00'], bridge: ['Bridge', '#7B5EA7'], marina: ['Marina', '#1B7A45'], fuel: ['Fuel price', '#0FA3A3'], anchor: ['Anchorage', '#14506E'], hazard: ['Hazard', '#D32F2F'], tip: ['Tip', '#5D6D7E'] };
function loopLimits() {
  const b = S.boat, out = [], sail = S.settings.boatType === 'sail', air = b.airDraftFt, dr = b.draftFt, beam = b.beamFt, len = S.settings.boatLen;
  const row = (lvl, t) => out.push('<li class="' + lvl + '">' + t + '</li>');
  if (air == null) row('warn', 'Set your air draft in Boat: it decides whether you can do the Loop as you are.');
  else if (sail && air > 19.5) row('warn', 'Air draft ' + fmtLen(air) + ': the mast comes down. Every looper must pass under 19 ft 6 in at Chicago, and the canals need less. Sailboats usually unstep at Catskill or Castleton on the Hudson and restep around Mobile.');
  else if (air > 19.5) row('bad', 'Air draft ' + fmtLen(air) + ' is more than the 19 ft 6 in fixed bridge at Chicago (mile 300.6). You would need to lower arch, radar and antennas to fit.');
  else if (air > 17) row('ok', 'Air draft ' + fmtLen(air) + ': fits Chicago (19 ft 6 in) by the Calumet route; downtown Chicago needs 17 ft. Western Erie Canal needs 15 ft 6 in, so take the Oswego Canal (21 ft).');
  else if (air > 15.5) row('ok', 'Air draft ' + fmtLen(air) + ': fits Chicago, including downtown. The western Erie (15 ft 6 in) is too low: go via Oswego.');
  else row('good', 'Air draft ' + fmtLen(air) + ': fits every fixed bridge on the Loop, including the full Erie Canal.');
  if (dr == null) row('warn', 'Set your draft in Boat.');
  else if (dr > 6) row('bad', 'Draft ' + fmtLen(dr) + ': too deep for the Trent–Severn and much of the ICW. Most loopers draw 5 ft or less.');
  else if (dr > 5) row('warn', 'Draft ' + fmtLen(dr) + ': possible but stressful. The Canadian canals want 5 ft or less fully loaded, and you may be asked to sign a waiver or wait for water.');
  else if (dr > 4) row('ok', 'Draft ' + fmtLen(dr) + ': fine for the Loop; 4 ft or less is easier on the NJ ICW and Georgia.');
  else row('good', 'Draft ' + fmtLen(dr) + ': ideal for the Loop.');
  if (beam != null) row(beam > 23 ? 'bad' : beam > 16 ? 'warn' : 'good', 'Beam ' + fmtLen(beam) + (beam > 23 ? ': wider than the 23 ft the Trent–Severn takes.' : beam > 16 ? ': fits, but many marinas charge more over 16 ft.' : ': fits the canals and most slips.'));
  if (len) row(len > 90 ? 'bad' : len > 42 ? 'warn' : 'good', 'Length ' + Math.round(len) + ' ft' + (len > 90 ? ': over the 90 ft Canadian canals take.' : len > 42 ? ': fits, but slips get scarce and costs climb over about 42 ft.' : ': an easy size for slips and locks.'));
  row('ok', 'Fuel range: plan on about 200 miles for the upper Mississippi stretch.');
  return '<ul class="loop-lim">' + out.join('') + '</ul>';
}
function loopNowLeg() { const p = S.fix || homePort() || refPos(); let best = 0, bd = Infinity; LOOP.legs.forEach((l, i) => { const d = distNm(p, { lat: l.c[0], lon: l.c[1] }); if (d < bd) { bd = d; best = i; } }); return bd < 400 ? best : -1; }
async function loopShared() {
  try { await sbInit(); if (!SB.client || !SB.user) return null; const since = new Date(Date.now() - 365 * 86400000).toISOString();
    const { data, error } = await SB.client.from('loop_reports').select('id,user_id,boat,kind,lat,lon,body,created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(500);
    if (error) return null; LOOP.shared = (data || []).map((r) => ({ id: 's' + r.id, kind: r.kind, lat: r.lat, lon: r.lon, body: r.body, boat: r.boat, at: Date.parse(r.created_at), mine: r.user_id === SB.user.id })); return LOOP.shared;
  } catch (e) { return null; }
}
async function loopFedReg(force) {
  if (!force && Date.now() - LOOP.frAt < 6 * 3600000) return LOOP.fr;
  const term = '("Atlantic Intracoastal" | "Gulf Intracoastal" | "Illinois Waterway" | "Illinois River" | "Chicago Sanitary" | "Tennessee-Tombigbee" | "Tennessee River" | "Cumberland River" | "Hudson River" | "Okeechobee" | "Delaware River" | "Chesapeake and Delaware") (drawbridge | "safety zone" | "regulated navigation area" | "special local")';
  try {
    const j = await fetchT('https://www.federalregister.gov/api/v1/documents.json?per_page=30&order=newest&conditions[agencies][]=coast-guard&conditions[type][]=RULE&conditions[term]=' + encodeURIComponent(term) + '&fields[]=title&fields[]=html_url&fields[]=publication_date&fields[]=dates', 15000).then((r) => r.json());
    LOOP.fr = (j.results || []).map((d) => ({ t: d.title, u: d.html_url, p: d.publication_date, d: d.dates || '' })); LOOP.frAt = Date.now(); store.set('loopFR', LOOP.fr); store.set('loopFRAt', LOOP.frAt);
  } catch (e) { /* offline */ }
  return LOOP.fr;
}
function loopAllReps() { const cut = Date.now() - 365 * 86400000; const seen = new Set(); return LOOP.rep.concat(LOOP.shared).filter((r) => r.at > cut && !seen.has(r.id) && seen.add(r.id)); }
function drawLoopReps() {
  LOOP.layer.clearLayers(); if (!S.settings.loopRepsOn) return;
  loopAllReps().forEach((r) => { const [lbl, col] = LOOP_KIND[r.kind] || LOOP_KIND.tip; L.circleMarker([r.lat, r.lon], { radius: 7, color: '#fff', weight: 2, fillColor: col, fillOpacity: 0.95 }).addTo(LOOP.layer).bindPopup('<b>' + esc(lbl) + '</b> · ' + new Date(r.at).toLocaleDateString() + (r.boat ? ' · ' + esc(r.boat) : '') + '<br>' + esc(r.body)); });
}
async function openLoop(tab) {
  tab = tab || LOOP.tab || 'plan'; LOOP.tab = tab;
  const tabs = '<div class="seg fw-tabs">' + [['plan', 'Route'], ['boat', 'My boat'], ['live', 'Live notices'], ['reports', 'Looper reports']].map(([v, l]) => '<button type="button" data-looptab="' + v + '" class="' + (tab === v ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
  let h = '<h3>Great Loop advisor</h3>' + tabs;
  const done = S.settings.loopDone || {};
  if (tab === 'plan') {
    const now = loopNowLeg();
    h += '<div class="sub">About 6,000 miles counter-clockwise from the Chesapeake. Most loopers take about a year, following the seasons. Tick legs as you finish them.</div>';
    h += LOOP.legs.map((l, i) => '<div class="loop-leg' + (i === now ? ' here' : '') + (done[l.id] ? ' done' : '') + '"><label><input type="checkbox" data-loopdone="' + l.id + '"' + (done[l.id] ? ' checked' : '') + '><b>' + (i + 1) + '. ' + esc(l.n) + '</b></label><span class="loop-when">' + esc(l.when) + (i === now ? ' · you are near here' : '') + (done[l.id] ? ' · done ' + new Date(done[l.id]).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '') + '</span><p>' + esc(l.why) + '</p><button type="button" class="btn small" data-loopshow="' + i + '">Show on chart</button></div>').join('');
    h += '<p class="hint">The months are the usual rhythm: north in late spring, the Canadian canals and Great Lakes in summer, Chicago by early September, the rivers in the fall, the Gulf after hurricane season, Florida for the winter. Season dates for locks and canals change every year: check Live notices.</p>';
  } else if (tab === 'boat') {
    h += '<div class="sub">' + esc(S.settings.boatName || 'Your boat') + ' against the Loop’s hard limits</div>' + loopLimits() + '<div class="row-btns"><button class="btn" data-loopboat>Edit boat details</button></div><p class="hint">Limits from Great Loop route guides: 19 ft 6 in fixed bridge in Chicago, 15 ft 6 in on the western Erie Canal, 21 ft on the Oswego Canal, 5 ft draft for the Canadian heritage canals, 23 ft beam on the Trent–Severn.</p>';
  } else if (tab === 'live') {
    openSheet(h + '<p class="sub">Checking the Coast Guard…</p>');
    const fr = await loopFedReg(true); if (LOOP.tab !== 'live') return;
    h += '<div class="mo-h">Official status pages</div>' + LOOP.links.map(([t, u]) => '<a class="li" href="' + u + '" target="_blank" rel="noopener"><div class="li-main"><b>' + esc(t) + '</b></div></a>').join('');
    h += '<div class="mo-h">Latest Coast Guard rules on the Loop route</div>' + (fr.length ? fr.slice(0, 15).map((d) => '<a class="li" href="' + esc(d.u) + '" target="_blank" rel="noopener"><div class="li-main"><b>' + esc(d.t) + '</b><span>' + esc((d.d || '').slice(0, 150) || 'Published ' + d.p) + '</span></div></a>').join('') : '<p class="sub">Could not reach the Federal Register just now.</p>');
    h += '<p class="hint">Drawbridge schedule changes, safety zones and closures from the Federal Register. Lock queues and canal openings are on the official pages above.</p>';
  } else {
    openSheet(h + '<p class="sub">Loading reports…</p>');
    const sh = await loopShared(); if (LOOP.tab !== 'reports') return;
    const p = S.fix || refPos(), reps = loopAllReps().map((r) => Object.assign({ d: distNm(p, r) }, r)).sort((a, b) => a.d - b.d).slice(0, 40);
    h += '<div class="sub">' + (sh ? 'Shared with everyone using Tideline who signs in' : 'Saved on this phone. Sign in (Menu → Account) to share with other loopers and see theirs.') + '</div>';
    h += '<div class="field"><label for="loopKind">Report something here (where you are, or the chart center)</label><select id="loopKind">' + Object.entries(LOOP_KIND).map(([k, [l]]) => '<option value="' + k + '">' + l + '</option>').join('') + '</select><textarea id="loopBody" rows="3" maxlength="600" placeholder="e.g. Lock 17 closed for repairs until Friday; 4.5 ft at low tide off the green 23; diesel $4.89"></textarea></div><div class="row-btns"><button class="btn primary" data-loopsave>Post report</button><button class="btn" data-looptoggle>' + (S.settings.loopRepsOn ? 'Hide reports on chart' : 'Show reports on chart') + '</button></div>';
    h += reps.length ? reps.map((r) => '<div class="li"><div class="li-main"><b style="color:' + (LOOP_KIND[r.kind] || LOOP_KIND.tip)[1] + '">' + esc((LOOP_KIND[r.kind] || LOOP_KIND.tip)[0]) + '</b><span>' + esc(r.body) + '</span><span class="sub">' + fmtDist(r.d) + ' away · ' + agoTxt(r.at) + (r.boat ? ' · ' + esc(r.boat) : '') + '</span></div>' + (r.mine || !String(r.id).startsWith('s') ? '<button class="btn small" data-loopdel="' + esc(String(r.id)) + '">Delete</button>' : '') + '</div>').join('') : '<p class="sub">No reports near here yet.</p>';
    h += '<p class="hint">Facebook groups and the AGLCA forums are members-only, so Tideline can’t read them. Reports here come from Tideline users; treat them like dock talk and check official notices.</p>';
  }
  h += '<div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>';
  openSheet(h);
}
sheet.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-looptab]'); if (t) { openLoop(t.dataset.looptab); return; }
  const sh = e.target.closest('[data-loopshow]'); if (sh) { const l = LOOP.legs[+sh.dataset.loopshow]; closeSheet(); setTab('chart'); map.setView(l.c, 7); return; }
  if (e.target.closest('[data-loopboat]')) { closeSheet(); setTab('boat'); return; }
  if (e.target.closest('[data-looptoggle]')) { S.settings.loopRepsOn = !S.settings.loopRepsOn; saveSettings(); drawLoopReps(); openLoop('reports'); return; }
  const dl = e.target.closest('[data-loopdel]'); if (dl) { const id = dl.dataset.loopdel; if (id.startsWith('s')) { try { await SB.client.from('loop_reports').delete().eq('id', +id.slice(1)); } catch (err) { /* offline */ } LOOP.shared = LOOP.shared.filter((r) => r.id !== id); } else { LOOP.rep = LOOP.rep.filter((r) => String(r.id) !== id); store.set('loopReps', LOOP.rep); } drawLoopReps(); openLoop('reports'); return; }
  if (e.target.closest('[data-loopsave]')) {
    const body = ($('loopBody').value || '').trim(), kind = $('loopKind').value; if (body.length < 3) { toast('Write a few words first'); return; }
    const p = S.fix || refPos(), r = { id: Date.now(), kind, lat: p.lat, lon: p.lon, body, boat: S.settings.boatName || '', at: Date.now() };
    let shared = false; try { await sbInit(); if (SB.client && SB.user) { const { error } = await SB.client.from('loop_reports').insert({ kind, lat: p.lat, lon: p.lon, body, boat: r.boat }); shared = !error; } } catch (err) { /* keep it local */ }
    if (!shared) { LOOP.rep.push(r); store.set('loopReps', LOOP.rep); }
    S.settings.loopRepsOn = true; saveSettings(); await loopShared(); drawLoopReps(); toast(shared ? 'Posted for other loopers' : 'Saved on this phone'); openLoop('reports');
  }
});
sheet.addEventListener('change', (e) => { const c = e.target.closest('[data-loopdone]'); if (!c) return; S.settings.loopDone = Object.assign({}, S.settings.loopDone); if (c.checked) S.settings.loopDone[c.dataset.loopdone] = Date.now(); else delete S.settings.loopDone[c.dataset.loopdone]; saveSettings(); openLoop('plan'); });
setTimeout(drawLoopReps, 3000);
/* ---------- activity themes: one tap sets colors and the layers that matter for what you are doing today ---------- */
const ACTIVITY = [
  ['sail', 'Sailing', 'navy', 'Wind lines, current arrows, the sailing coach and reef tips', () => { S.settings.underSail = true; setWxL('wind', true); S.settings.curLevel = 6; S.settings.curOn = true; S.settings.sailTips = true; }],
  ['race', 'Racing', 'july4', 'Every current station with speeds, wind lines, sailing coach', () => { S.settings.underSail = true; setWxL('wind', true); S.settings.curLevel = 10; S.settings.curLbl = 'all'; S.settings.curAnim = true; S.settings.curOn = true; S.settings.sailTips = true; }],
  ['cruise', 'Cruising', 'blue', 'A clean chart: a few current arrows, motoring speeds', () => { S.settings.underSail = false; setWxL('wind', false); S.settings.curLevel = 2; S.settings.curLbl = 'strong'; }],
  ['fish', 'Fishing', 'green', 'Fish structure, fishing tips, current arrows (fish feed on moving water)', () => { S.settings.structOn = true; S.settings.fishTips = true; S.settings.curOn = true; S.settings.curLevel = 5; }],
  ['loop', 'Great Loop', 'gold', 'Looper reports on the chart, the Loop advisor, a clean chart', () => { S.settings.loopRepsOn = true; S.settings.curLevel = 2; }]
];
function setActivity(id) {
  const a = ACTIVITY.find((x) => x[0] === id); if (!a) return; S.settings.activity = id; S.settings.btheme = a[2]; a[4](); saveSettings();
  applyBTheme(); try { drawCurrents(); renderCurChip(); drawStruct(); drawLoopReps(); renderWxBtn(); } catch (e) { /* not ready */ }
  toast(a[1] + ': ' + a[3] + '.', 5000); if (id === 'loop') setTimeout(() => openLoop('plan'), 400);
}
sheet.addEventListener('click', (e) => { const b = e.target.closest('[data-activity]'); if (b) { setActivity(b.dataset.activity); b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); } });
/* ---------- welcome: sign in so boats, routes, themes and trips follow you to every phone, iPad and computer; then a short tour ---------- */
async function sbSendCode(email) {
  await sbInit(); if (!SB.client) throw new Error('Accounts are not switched on yet.');
  const { error } = await SB.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
  if (error) throw error;
}
async function sbVerifyCode(email, token) {
  const { error } = await SB.client.auth.verifyOtp({ email, token, type: 'email' }); if (error) throw error;
  const { data } = await SB.client.auth.getSession(); SB.user = data.session && data.session.user; window.__sbEmail = SB.user && SB.user.email; await syncPull(true);
}
function showWelcome(force) {
  if (!force && (store.get('welcomed', false) || (SB.user))) return false;
  let el = $('welcome'); if (!el) { el = document.createElement('div'); el.id = 'welcome'; el.className = 'welcome'; document.body.appendChild(el); }
  const acc = !!SB.cfg;
  el.innerHTML = '<div class="wl-card"><div class="wl-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16c3-2.5 6-2.5 9 0s6 2.5 9 0M3 20.5c3-2.5 6-2.5 9 0s6 2.5 9 0"/><path d="M12 3v9M8 8l4-5 4 5"/></svg></div><h2>Welcome to Tideline</h2>' +
    '<p>Charts, depth, wind, tides and currents for the water you love.</p>' +
    (acc ? '<div class="wl-step" id="wlA"><label for="wlEmail">Sign in so your boats, routes, trips and themes follow you to every phone, iPad and computer.</label><input id="wlEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"><button class="btn primary wl-go" data-wl="send">Email me a sign-in code</button></div>' +
      '<div class="wl-step" id="wlB" hidden><label for="wlCode">We emailed you a code (check spam too). Type it here, or tap the link in the email.</label><input id="wlCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"><button class="btn primary wl-go" data-wl="verify">Sign in</button><button class="btn ghost small" data-wl="back">Use a different email</button></div>'
      : '<p class="hint">Sign-in for syncing between devices is being switched on. Until then everything is saved on this device; use Menu → Back up to move it.</p>') +
    '<p id="wlMsg" class="wl-msg" role="status"></p><button class="btn ghost" data-wl="skip">' + (acc ? 'Continue without signing in' : 'Get started') + '</button></div>';
  el.hidden = false; return true;
}
function closeWelcome(tour) { if (tour && !(S.settings.uses && S.settings.uses.length)) { openUses(true); return; } const el = $('welcome'); if (el) el.hidden = true; store.set('welcomed', true); if (tour && !store.get('toured', false)) setTimeout(() => startTour(), 400); }
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-wl]'); if (!b) return; const a = b.dataset.wl, msg = (t) => { const m = $('wlMsg'); if (m) m.textContent = t; };
  if (a === 'skip') { closeWelcome(true); return; }
  if (a === 'back') { $('wlB').hidden = true; $('wlA').hidden = false; msg(''); return; }
  if (a === 'send') { const em = ($('wlEmail').value || '').trim(); if (!/.+@.+\..+/.test(em)) { msg('Type your email address.'); return; } b.disabled = true; msg('Sending…'); try { await sbSendCode(em); SB.pendingEmail = em; $('wlA').hidden = true; $('wlB').hidden = false; msg(''); setTimeout(() => $('wlCode') && $('wlCode').focus(), 50); } catch (err) { msg(err.message || 'Could not send. Check your signal.'); } b.disabled = false; return; }
  if (a === 'verify') { const code = ($('wlCode').value || '').replace(/\s/g, ''); if (code.length < 6) { msg('Type the code from the email.'); return; } b.disabled = true; msg('Signing in…'); try { await sbVerifyCode(SB.pendingEmail, code); msg(''); toast('Signed in. Your boats and settings are syncing.'); closeWelcome(true); } catch (err) { msg(err.message || 'That code did not work. Try again.'); } b.disabled = false; }
});
// the account sheet also takes the code, for people who signed in from the menu
document.addEventListener('click', async (e) => { const b = e.target.closest('[data-act="sbcode"]'); if (!b) return; const code = ($('sbCode').value || '').replace(/\s/g, ''), em = ($('sbEmail').value || '').trim(); try { await sbVerifyCode(em, code); toast('Signed in'); openAccount(true); } catch (err) { toast(err.message || 'That code did not work'); } });

/* a short, plain tour: one thing at a time, pointing at the real button */
const TOUR = [
  { el: null, t: 'This is your chart', d: 'NOAA chart depths over satellite. Drag to move, pinch to zoom. Your boat is the arrow once GPS finds you.' },
  { el: '#fabs', t: 'Buttons on the left', d: 'Top to bottom: chart or satellite, layers, day or night colors, measure, plan a route, weather (wind, waves, rain, tide, current), AIS ships and the first mate.' },
  { el: '#btnWx', t: 'Weather and current', d: 'Tap for wind, waves, rain, tide and current buttons. Turn on Current to see arrows showing which way the water runs and how fast.' },
  { el: '#fabsR', t: 'Buttons on the right', d: 'Your speed and compass, charted depth under you, zoom, Find me, and the instruments.' },
  { el: '#map', t: 'Tap any spot', d: 'Tap the water anywhere for its wind, waves, current, tide, depth and water temperature. Press and hold to drop a pin or navigate there.' },
  { el: '#btnRoute', t: 'Plan a trip', d: 'Tap here, then tap or type your stops. Every leg follows water deep enough for your boat, under bridges you fit and around closed areas.' },
  { el: '[data-first-mate]', t: 'Your first mate (AI)', d: 'The sparkle with the anchor. Tap it and say “Take me to St. Michaels”, “Show the currents” or “Should I reef?”.' },
  { el: '#btnMOB', t: 'Man overboard', d: 'Press and hold the red MOB button to mark the spot and steer back to it.' },
  { el: '.tab[data-tab="menu"]', t: 'Menu', d: 'Set up your boat (draft and air draft make routes safe), the sailing coach, the Great Loop advisor, fishing, themes and your account.' }
];
function startTour(i) {
  i = i || 0; const st = TOUR[i]; let ov = $('tour'); setTab('chart'); closeSheet();
  if (!ov) { ov = document.createElement('div'); ov.id = 'tour'; ov.className = 'tour'; document.body.appendChild(ov); }
  const el = st.el ? document.querySelector(st.el) : null, r = el && el.getBoundingClientRect(), vis = r && r.width > 0 && r.height > 0;
  const pad = 6, box = vis ? { l: Math.max(4, r.left - pad), t: Math.max(4, r.top - pad), w: Math.min(innerWidth - 8, r.width + pad * 2), h: Math.min(innerHeight - 8, r.height + pad * 2) } : null;
  const big = box && box.w * box.h > innerWidth * innerHeight * 0.5, spB = box ? innerHeight - (box.t + box.h) : 0, spA = box ? box.t : 0;
  const below = box && !big && spB >= 230 && spB >= spA, aboveOk = box && !big && spA >= 230;
  ov.innerHTML = (box && !big ? '<div class="tour-hole" style="left:' + box.l + 'px;top:' + box.t + 'px;width:' + box.w + 'px;height:' + box.h + 'px"></div>' : '<div class="tour-dim"></div>') +
    '<div class="tour-card' + (box && !big ? '' : ' mid') + '" style="' + (box && !big ? (below ? 'top:' + (box.t + box.h + 12) + 'px' : aboveOk ? 'bottom:' + (innerHeight - box.t + 12) + 'px' : 'bottom:' + (S.tab ? 84 : 84) + 'px;left:' + Math.min(innerWidth - 16 - 260, box.l + box.w + 10) + 'px;max-width:' + Math.max(220, innerWidth - (box.l + box.w + 26)) + 'px') : '') + '"><div class="tour-n">' + (i + 1) + ' of ' + TOUR.length + '</div><b>' + esc(st.t) + '</b><p>' + esc(st.d) + '</p><div class="tour-btns"><button class="btn ghost small" data-tour="end">Skip tour</button>' + (i ? '<button class="btn small" data-tour="' + (i - 1) + '">Back</button>' : '') + '<button class="btn primary small" data-tour="' + (i + 1 < TOUR.length ? i + 1 : 'end') + '">' + (i + 1 < TOUR.length ? 'Next' : 'Done') + '</button></div></div>';
  ov.hidden = false;
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-tour]'); if (!b) return; e.stopPropagation(); const v = b.dataset.tour; if (v === 'end') { $('tour').hidden = true; store.set('toured', true); toast('You can take the tour again from Menu → Help.', 3500); } else startTour(+v); }, true);
setTimeout(() => { if (!showWelcome() && !store.get('toured', false) && !store.get('welcomed', false)) { /* signed in already */ } }, 600);
/* ---------- chart orientation: north up or course up (bow forward), and a flat 2D or tilted 3D view ---------- */
const ORI = { last: 0, t: null };
function roseSvg() { return '<svg viewBox="0 0 24 24" aria-hidden="true" class="rose"><g transform="rotate(' + mapRot().toFixed(1) + ' 12 12)"><path class="rose-n" d="M12 2.2 14 12h-4z"/><path class="rose-s" d="M12 21.8 10 12h4z"/><path class="rose-ew" d="M2.2 12 12 10v4zM21.8 12 12 14v-4z"/><circle cx="12" cy="12" r="1.6" class="rose-c"/></g></svg>'; }
function renderOrientBtn() {
  const b = $('btnOrient'); if (!b) return; const o = S.settings.orient || 'north', d3 = !!S.settings.view3d;
  b.innerHTML = roseSvg() + '<span class="or-lbl">' + (o === 'course' ? 'BOW' : 'N') + (d3 ? '·3D' : '') + '</span>';
  b.classList.toggle('on', o === 'course' || d3);
  const tip = (o === 'course' ? 'Course up: the chart turns so your bow points up' : 'North up') + (d3 ? ', tilted 3D view' : '') + '. Tap to switch north up / course up; press and hold for 2D or 3D.';
  b.dataset.tip = tip; b.setAttribute('aria-label', tip);
}
function applyOrient(force) {
  if (!map.setBearing) return;
  const o = S.settings.orient || 'north';
  if (o === 'north') { if (Math.abs(mapRot()) > 0.5) map.setBearing(0); }
  else if (S.cog != null && (S.sog || 0) > 1) { const want = (360 - S.cog) % 360, cur = (mapRot() + 360) % 360, diff = Math.abs(((want - cur + 540) % 360) - 180); if (force || diff > 3) map.setBearing(want); }
  document.documentElement.classList.toggle('tilt3d', !!S.settings.view3d);
  renderOrientBtn();
}
function setOrient(o, d3) {
  if (o) S.settings.orient = o; if (d3 != null) S.settings.view3d = d3; saveSettings();
  if (S.settings.orient === 'course' && !((S.sog || 0) > 1)) toast('Course up turns the chart once you are moving. North up until then.', 4000);
  if (S.settings.view3d) setFollow && S.fix && setFollow(true);
  applyOrient(true); setTimeout(() => map.invalidateSize(), 60);
}
(() => {
  const col = $('fabsR'), zi = $('btnZoomIn'); if (!col) return;
  const b = document.createElement('button'); b.id = 'btnOrient'; b.type = 'button'; b.className = 'fab orient'; col.insertBefore(b, zi);
  let lp = null, held = false;
  b.addEventListener('pointerdown', () => { held = false; lp = setTimeout(() => { held = true; openOrientSheet(); }, 550); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => clearTimeout(lp)));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', () => { if (held) { held = false; return; } const o = (S.settings.orient || 'north') === 'north' ? 'course' : 'north'; setOrient(o); toast(o === 'course' ? 'Course up: bow forward' : 'North up', 1800); });
  renderOrientBtn();
})();
function openOrientSheet() {
  const o = S.settings.orient || 'north', d3 = !!S.settings.view3d, seg = (k, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, t]) => '<button type="button" data-ori' + k + '="' + v + '" class="' + (String(cur) === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
  openSheet('<h3>Chart view</h3><div class="field"><label>Which way is up</label>' + seg('o', o, [['north', 'North up'], ['course', 'Course up (bow forward)']]) + '</div><div class="field"><label>View</label>' + seg('d', String(d3), [['false', 'Flat 2D'], ['true', 'Tilted 3D']]) + '<small class="hint">3D tilts the chart so you see farther ahead, like car navigation. Taps on the chart work in 2D.</small></div><div class="row-btns"><button class="btn ghost" data-act="close">Done</button></div>');
}
sheet.addEventListener('click', (e) => {
  const a = e.target.closest('[data-orio]'), d = e.target.closest('[data-orid]'); if (!a && !d) return;
  setOrient(a ? a.dataset.orio : null, d ? d.dataset.orid === 'true' : null); (a || d).parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === (a || d)));
});
map.on('rotate', () => { renderOrientBtn(); clearTimeout(ORI.t); ORI.t = setTimeout(() => { try { updateBoat(); updateAis(); renderMini(); if (curOn()) drawCurrents(); drawGrid(); } catch (e) { /* not ready */ } }, 120); });
setInterval(() => { if ((S.settings.orient || 'north') === 'course') applyOrient(); }, 1500);
setTimeout(() => applyOrient(true), 800);

/* ---------- phone help: press and hold any button to see what it does (like hovering on a computer) ---------- */
(() => {
  let t = null, tipEl = null, holdBtn = null, shown = false;
  const hide = () => { clearTimeout(t); if (tipEl) tipEl.remove(); tipEl = null; };
  const label = (b) => b.dataset.tip || b.getAttribute('aria-label') || b.title || '';
  const show = (b) => {
    const txt = label(b); if (!txt) return; hide(); shown = true;
    tipEl = document.createElement('div'); tipEl.className = 'touch-tip'; tipEl.textContent = txt.split(/[.:·(]/)[0].replace(/\s*Tap.*$/, '').trim().slice(0, 34); document.body.appendChild(tipEl);
    const r = b.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight, left = r.left + r.width / 2 < innerWidth / 2;
    let x = left ? r.right + 10 : r.left - w - 10; x = Math.max(8, Math.min(innerWidth - w - 8, x));
    let y = r.top + r.height / 2 - h / 2; y = Math.max(8, Math.min(innerHeight - h - 8, y));
    if (b.closest('.tabbar')) { x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)); y = r.top - h - 10; }
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  };
  const learning = () => S.settings.learnTips === true; // off unless chosen in Map options: a flashing label on every tap got in the way
  if (!store.get('firstRun', 0)) store.set('firstRun', Date.now());
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.fab, .tab, #btnMOB, .alert-bar, .mini-inst'); if (!b || e.pointerType === 'mouse' || ARR.on) return;
    holdBtn = b; shown = false; clearTimeout(t);
    if (b.id === 'btnMOB' || b.id === 'curChip' || b.id === 'btnOrient') return; // these use press and hold for their own job
    t = setTimeout(() => { show(b); t = setTimeout(() => { if (holdBtn === b && b.closest('#fabs, #fabsR, .fab-free')) { hide(); shown = true; arrangeMode(true); toast('Arrange mode: drag buttons anywhere. Tap Done when finished.', 3500); } }, 800); }, 450);
  }, true);
  document.addEventListener('pointerup', () => { clearTimeout(t); if (shown) setTimeout(hide, 1100); }, true);
  document.addEventListener('pointercancel', () => { clearTimeout(t); hide(); }, true);
  // a held button shows its name and does nothing else; while you are new, a quick tap also flashes the name
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.fab, .tab, .alert-bar, .mini-inst'); if (!b) return;
    if (shown && holdBtn === b) { e.stopPropagation(); e.preventDefault(); shown = false; return; }
    if (learning() && !e.target.closest('.sheet')) { show(b); shown = false; setTimeout(hide, 1300); }
  }, true);
})();
/* ---------- lightning: strikes on the chart, how close the nearest one is, and a warning when it is coming your way ---------- */
const LX = { strikes: [], at: 0, layer: L.layerGroup().addTo(map), hist: [], warned: 0, err: '' };
const lxOn = () => S.settings.lxOn !== false;
async function lxFetch() {
  const c = S.fix || refPos(); if (!lxOn() || !c) return;
  const src = S.settings.lxRelay || '';
  if (src) {
    try { const j = await fetchT(src + (src.includes('?') ? '&' : '?') + 'lat=' + c.lat.toFixed(3) + '&lon=' + c.lon.toFixed(3) + '&r=60', 15000).then((r) => r.json()); LX.strikes = (j.strikes || []).filter((x) => x && isFinite(x.lat) && isFinite(x.lon) && isFinite(x.t)); LX.at = Date.now(); LX.err = ''; }
    catch (e) { LX.err = 'Lightning feed not reachable'; }
  }
  if (S.settings.sim && !src) lxDemo(c);
  lxDraw(); lxCheck();
}
function lxDemo(c) { // simulator only: a storm cell drifting toward you
  const now = Date.now(); if (!LX.demo) LX.demo = { lat: c.lat + 0.15, lon: c.lon - 0.2, t0: now };
  const k = (now - LX.demo.t0) / 60000, cell = { lat: LX.demo.lat - k * 0.004, lon: LX.demo.lon + k * 0.005 };
  LX.strikes = LX.strikes.filter((x) => now - x.t < 30 * 60000); for (let i = 0; i < 4; i++) LX.strikes.push({ lat: cell.lat + (Math.random() - 0.5) * 0.04, lon: cell.lon + (Math.random() - 0.5) * 0.05, t: now - Math.random() * 50000, demo: true });
}
function lxNearest() {
  const c = S.fix || refPos(), now = Date.now(); let best = null;
  LX.strikes.forEach((x) => { if (now - x.t > 30 * 60000) return; const d = distNm(c, x); if (!best || d < best.d) best = { d, x, brg: bearing(c, x), age: now - x.t }; });
  return best;
}
function lxDraw() {
  LX.layer.clearLayers(); if (!lxOn()) { lxChip(null); return; }
  const now = Date.now();
  LX.strikes.forEach((x) => { const age = (now - x.t) / 60000; if (age > 30) return; const cls = age < 5 ? 'new' : age < 15 ? 'mid' : 'old';
    L.marker([x.lat, x.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<i class="lx-strike ' + cls + '"></i>' }) }).addTo(LX.layer); });
  lxChip(lxNearest());
}
function lxChip(n) {
  let el = $('lxChip'); if (!el) { el = document.createElement('button'); el.id = 'lxChip'; el.type = 'button'; el.className = 'lx-chip'; $('app').appendChild(el); el.addEventListener('click', openLightning); }
  if (!n || n.d > 40) { el.hidden = true; return; }
  const close = n.d < (S.settings.lxNear || 10), app = LX.approach;
  el.hidden = false; el.className = 'lx-chip' + (close ? ' close' : '') + (app ? ' coming' : '');
  el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 5 13.5h6L9.5 22 19 9.5h-6.2z"/></svg><b>' + fmtDist(n.d) + ' ' + compass16(n.brg) + '</b><span>' + (app ? 'coming closer' : Math.max(1, Math.round(n.age / 60000)) + ' min ago') + '</span>';
  el.dataset.tip = 'Nearest lightning strike ' + fmtDist(n.d) + ' to the ' + compass16(n.brg) + (app ? ', getting closer' : '') + '. Tap for details and alert settings.';
}
function lxCheck() {
  const n = lxNearest(), now = Date.now(); if (!n) { LX.approach = false; return; }
  LX.hist.push({ t: now, d: n.d }); LX.hist = LX.hist.filter((h) => now - h.t < 20 * 60000);
  const old = LX.hist.find((h) => now - h.t > 8 * 60000); LX.approach = !!(old && old.d - n.d > 1);
  const near = S.settings.lxNear || 10;
  if ((n.d < near || (LX.approach && n.d < near * 1.5)) && now - LX.warned > 10 * 60000) {
    LX.warned = now;
    if (S.settings.lxSound !== false) beep(3);
    headsUp('Lightning ' + fmtDist(n.d) + ' to the ' + compass16(n.brg) + (LX.approach ? ', and getting closer.' : '.'));
    toast('⚡ Lightning ' + fmtDist(n.d) + ' ' + compass16(n.brg) + (LX.approach ? ', coming closer' : '') + '. Head for shelter; stay off the water until 30 minutes after the last strike.', 9000);
  }
  lxChip(n);
}
function openLightning() {
  const n = lxNearest(), st = S.settings, seg = (k, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, t]) => '<button type="button" data-lx' + k + '="' + v + '" class="' + (String(cur) === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
  const fc = (() => { const w = S.weather; if (!w || !w.hours) return null; const h = w.hours.find((x) => x.t > Date.now() && x.t < Date.now() + 12 * 3600000 && x.code >= 95); return h || null; })();
  openSheet('<h3>Lightning</h3>' + (n ? '<div class="lx-big' + (LX.approach ? ' coming' : '') + '"><b>' + fmtDist(n.d) + '</b><span>to the ' + compass16(n.brg) + ' · ' + Math.max(1, Math.round(n.age / 60000)) + ' min ago' + (LX.approach ? ' · <b>getting closer</b>' : '') + '</span></div>' : '<p class="sub">' + (st.lxRelay && LX.err ? '<b class="warn-t">The lightning feed is not answering' + (LX.at ? ' (last good update ' + agoTxt(LX.at) + ')' : '') + '. Tideline cannot see strikes right now: watch the sky and the radar.</b>' : st.lxRelay || st.sim ? 'No strikes within 40 nm in the last 30 minutes.' : 'Live lightning needs a lightning feed (below). Until then Tideline warns you from the forecast and NWS alerts.') + '</p>') +
    (fc ? '<p class="sub">Thunderstorms are in the forecast here around ' + fmtClock(fc.t) + '.</p>' : '') +
    '<div class="fm-card"><b>If you can hear thunder, you are close enough to be struck.</b><p>Head for shelter. On the water: get to a harbor, stay low in the cockpit, away from the mast, shrouds and metal. Stay put until 30 minutes after the last thunder.</p></div>' +
    '<div class="field"><label>Lightning on the chart</label>' + seg('on', String(lxOn()), [['true', 'Show'], ['false', 'Hide']]) + '</div>' +
    '<div class="field"><label>Warn me when a strike is within</label>' + seg('near', String(st.lxNear || 10), [['5', '5 nm'], ['10', '10 nm'], ['15', '15 nm'], ['25', '25 nm']]) + '</div>' +
    '<div class="field"><label>Alarm sound</label>' + seg('snd', String(st.lxSound !== false), [['true', 'Sound on'], ['false', 'Muted (show only)']]) + '</div>' +
    '<details><summary>Lightning feed</summary><div class="field"><label for="lxRelay">Feed URL</label><input id="lxRelay" type="url" value="' + esc(st.lxRelay || '') + '" placeholder="https://tideline-lightning.…workers.dev"></div><button class="btn small" data-lxsave>Save</button><p class="hint">Live strike data comes from a commercial lightning network (for example Xweather/Vaisala) through a small relay; see tools/lightning-relay in the Tideline repo. Never paste a provider key here.</p></details>' +
    '<div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lxon],[data-lxnear],[data-lxsnd]'); if (b) { const d = b.dataset; if (d.lxon) S.settings.lxOn = d.lxon === 'true'; if (d.lxnear) S.settings.lxNear = +d.lxnear; if (d.lxsnd) S.settings.lxSound = d.lxsnd === 'true'; saveSettings(); lxDraw(); b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); return; }
  if (e.target.closest('[data-lxsave]')) { const v = ($('lxRelay').value || '').trim(); if (v && !/^https:\/\//.test(v)) { toast('Use the https:// address of your relay'); return; } S.settings.lxRelay = v; saveSettings(); toast(v ? 'Lightning feed saved' : 'Lightning feed removed'); lxFetch(); }
});
document.addEventListener('click', (e) => { if (e.target.closest('[data-lx-open]')) openLightning(); });
setInterval(lxFetch, 60000); setTimeout(lxFetch, 4000); setInterval(lxDraw, 60000);
QUICK.splice(QUICK.findIndex((q) => q[0] === 'rain') + 1, 0, ['lx', 'Lightning', () => lxOn(), (on) => { S.settings.lxOn = on; lxDraw(); }]);

/* ---------- first mate listening: say the wake words ("first mate", or your own) and then the request ---------- */
const WAKE = { rec: null, on: false, armedUntil: 0 };
const wakeWord = () => (S.settings.wakeWord || 'first mate').toLowerCase().trim();
function wakeIndicator() { document.querySelectorAll('[data-first-mate]').forEach((b) => b.classList.toggle('listening', WAKE.on)); }
function wakeStart() {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition; if (!R) { toast('This browser cannot listen continuously. Tap the first mate button and use the keyboard microphone instead.', 6000); S.settings.wakeOn = false; saveSettings(); return; }
  if (WAKE.rec) return; const r = new R(); WAKE.rec = r; WAKE.on = true; r.lang = navigator.language || 'en-US'; r.continuous = true; r.interimResults = false;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue; const said = e.results[i][0].transcript.toLowerCase().trim(), w = wakeWord(), k = said.indexOf(w);
      let cmd = null; if (k >= 0) { cmd = said.slice(k + w.length).replace(/^[\s,.!?]+/, ''); if (!cmd) { WAKE.armedUntil = Date.now() + 7000; chime(); continue; } } else if (Date.now() < WAKE.armedUntil) cmd = said;
      if (cmd) { WAKE.armedUntil = 0; wakeRun(cmd); }
    }
  };
  r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { toast('Microphone permission is off for this site.', 5000); wakeStop(); } };
  r.onend = () => { WAKE.rec = null; if (WAKE.on && S.settings.wakeOn) setTimeout(() => { if (S.settings.wakeOn && !WAKE.rec) wakeStart(); }, 400); };
  try { r.start(); } catch (e) { WAKE.rec = null; }
  wakeIndicator();
}
function wakeStop() { WAKE.on = false; S.settings.wakeOn = false; saveSettings(); try { WAKE.rec && WAKE.rec.stop(); } catch (e) { /* stopped */ } WAKE.rec = null; wakeIndicator(); }
async function wakeRun(cmd) {
  openFirstMate(); const inp = $('firstMateRequest'); if (inp) inp.value = cmd; await askFirstMate();
  const r = $('firstMateReply'), txt = r && r.textContent.trim(); if (txt && S.settings.voice) speak(txt.slice(0, 220));
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-wake]'); if (!b) return;
  if (b.dataset.wake === 'on') { const w = ($('wakeWordIn') && $('wakeWordIn').value.trim()) || 'first mate'; S.settings.wakeWord = w; S.settings.wakeOn = true; saveSettings(); wakeStart(); toast('Listening. Say “' + w + '” and then your request.', 5000); }
  else wakeStop();
  if ($('wakeBox')) $('wakeBox').outerHTML = wakeBoxHtml();
});
function wakeBoxHtml() { return '<div id="wakeBox" class="field wake-box"><label for="wakeWordIn">Hands-free: listen for</label><input id="wakeWordIn" value="' + esc(S.settings.wakeWord || 'first mate') + '" maxlength="30"><div class="row-btns">' + (WAKE.on ? '<button class="btn" data-wake="off">Stop listening</button>' : '<button class="btn" data-wake="on">Start listening</button>') + '</div><small class="hint">Say the words, then your request: “' + esc(S.settings.wakeWord || 'first mate') + ', show the currents”. The screen must stay on; Tideline keeps it awake while navigating. Speech is processed by your phone’s browser.</small></div>'; }
if (S.settings.wakeOn) setTimeout(wakeStart, 1500);
/* ---------- spot card: tap the chart and a small card opens right at that spot with its conditions; tap anywhere else and it goes away ---------- */
const SPOT = { el: null, pin: null, p: null, seq: 0 };
const SPOT_IC = {
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
  wave: '<path d="M2 12c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5 0M2 18c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5 0"/>',
  cur: '<path d="M3 8h13l-3-3M3 8h13l-3 3M21 16H8l3-3M21 16H8l3 3"/>',
  tide: '<path d="M12 3v8M8.5 6.5 12 3l3.5 3.5"/><path d="M3 16c3-2.5 6-2.5 9 0s6 2.5 9 0M3 20.5c3-2.5 6-2.5 9 0s6 2.5 9 0"/>',
  depth: '<path d="M12 3v15M7 13l5 5 5-5"/><path d="M4 21h16"/>',
  temp: '<path d="M12 3v11.5a3 3 0 1 1-2 0V3a1 1 0 0 1 2 0z"/>',
  sky: '<path d="M7 17a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 0 7.5z"/>'
};
const spIc = (k, rot) => '<svg viewBox="0 0 24 24" aria-hidden="true"' + (rot != null ? ' style="transform:rotate(' + Math.round(rot) + 'deg)"' : '') + '>' + SPOT_IC[k] + '</svg>';
const spArrow = (deg) => '<svg viewBox="0 0 24 24" class="sp-arr" aria-hidden="true" style="transform:rotate(' + Math.round(deg) + 'deg)"><path d="M12 3l5 9h-3.2v9h-3.6v-9H7z"/></svg>';
function closeSpot() { if (SPOT.el) SPOT.el.remove(); SPOT.el = null; if (SPOT.pin) { SPOT.pin.remove(); SPOT.pin = null; } SPOT.p = null; }
function placeSpot() {
  if (!SPOT.el || !SPOT.p) return; const pt = map.latLngToContainerPoint([SPOT.p.lat, SPOT.p.lon]), r = map.getContainer().getBoundingClientRect(), w = SPOT.el.offsetWidth, h = SPOT.el.offsetHeight;
  let x = r.left + pt.x - w / 2, y = r.top + pt.y - h - 26, below = false; x = Math.max(8, Math.min(innerWidth - w - 8, x));
  if (y < 60) { y = r.top + pt.y + 22; below = true; } y = Math.min(y, innerHeight - h - 70);
  SPOT.el.style.left = x + 'px'; SPOT.el.style.top = y + 'px'; SPOT.el.classList.toggle('below', below);
  SPOT.el.style.setProperty('--tip', Math.max(16, Math.min(w - 16, r.left + pt.x - x)) + 'px');
}
function openSpotCard(latlng) {
  closeSpot(); const p = { lat: latlng.lat, lon: ((latlng.lng + 540) % 360) - 180 }, seq = ++SPOT.seq; SPOT.p = p; S.sheetPoint = { p, wp: null };
  SPOT.pin = L.marker([p.lat, p.lon], { interactive: false, keyboard: false, zIndexOffset: 2000, icon: L.divIcon({ className: '', iconSize: [22, 30], iconAnchor: [11, 29], html: '<div class="sp-pin"></div>' }) }).addTo(map);
  const from = S.fix || homePort(), d = from ? distNm(from, p) : null;
  const el = document.createElement('div'); el.className = 'spot-card'; el.innerHTML =
    '<div class="sp-head"><div><b>' + (d != null ? fmtDist(d) + ' · ' + fmtBrg(bearing(from, p)) + '°' + (S.fix && (S.sog || 0) > 1 ? ' · ' + fmtDur(d / S.sog) : '') : 'This spot') + '</b><span>' + ddm(p.lat, true) + '  ' + ddm(p.lon, false) + (d != null && !S.fix ? ' · from ' + esc(from.name) : '') + '</span></div><button type="button" class="sp-x" data-spx aria-label="Close">×</button></div>' +
    '<div class="sp-grid" id="spGrid"><div class="sp-load">Reading this spot…</div></div>' +
    '<div class="sp-acts"><button type="button" class="sp-btn pri" data-spact="goto"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 18-7-4-7 4z"/></svg>Navigate</button>' + (S.settings.boatType === 'sail' ? '<button type="button" class="sp-btn" data-spact="ptsail"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v15M12 4c3.5 3 5.5 7 6 12h-6M11 6c-2.5 3-4 6-4.5 10H11M4 19h16l-2 2H6z"/></svg>Sail</button>' : '') + '<button type="button" class="sp-btn ic" data-spact="more" aria-label="More details" title="More details"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button></div>';
  document.body.appendChild(el); SPOT.el = el; placeSpot();
  spotFill(p, seq);
}
async function spotFill(p, seq) {
  const ll = '?latitude=' + p.lat.toFixed(3) + '&longitude=' + p.lon.toFixed(3), cells = {}, draw = () => {
    if (seq !== SPOT.seq || !$('spGrid')) return; const order = ['wind', 'wave', 'cur', 'tide', 'depth', 'water', 'air'];
    const html = order.filter((k) => cells[k]).map((k) => cells[k]).join(''); $('spGrid').innerHTML = html || '<div class="sp-load">Reading this spot…</div>'; placeSpot();
  };
  const cell = (ic, v, u, sub, cls) => '<div class="sp-c' + (cls ? ' ' + cls : '') + '">' + ic + '<b>' + v + '<small>' + u + '</small></b><span>' + sub + '</span></div>';
  fetchT('https://api.open-meteo.com/v1/forecast' + ll + wxM() + '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code&wind_speed_unit=kn&temperature_unit=fahrenheit', 12000).then((r) => r.json()).then((w) => {
    const c = w.current; if (!c) return;
    cells.wind = cell(spArrow((c.wind_direction_10m + 180) % 360 + mapRot()), Math.round(speedOut(c.wind_speed_10m)), ' ' + SPEED_LBL[S.settings.speedUnit], compass16(c.wind_direction_10m) + ' · g' + Math.round(speedOut(c.wind_gusts_10m)), 'wind');
    cells.air = cell(spIc('sky'), Math.round(c.temperature_2m) + '°', '', (wmo(c.weather_code)[0] || 'air').toLowerCase(), 'air'); draw();
  }).catch(() => {});
  fetchT('https://marine-api.open-meteo.com/v1/marine' + ll + '&current=wave_height,wave_period,sea_surface_temperature&length_unit=imperial', 12000).then((r) => r.json()).then((m) => {
    const c = m.current; if (!c) return;
    if (c.wave_height != null) cells.wave = cell(spIc('wave'), c.wave_height.toFixed(1), ' ft', (c.wave_period ? 'every ' + Math.round(c.wave_period) + ' s' : 'waves'), 'wave');
    if (c.sea_surface_temperature != null) cells.water = cell(spIc('temp'), Math.round(c.sea_surface_temperature * 9 / 5 + 32) + '°', '', 'water', 'water'); draw();
  }).catch(() => {});
  (async () => { try { const st = await nearestCurrent(p); if (!st || st.dNm > 5) return; const n = curAt(await curPred(st), curTime()); if (!n) return;
    cells.cur = cell(n.kn < 0.4 ? spIc('cur') : spArrow((n.dir || 0) + mapRot()), n.kn < 0.4 ? 'slack' : n.kn.toFixed(1), n.kn < 0.4 ? '' : ' kn', n.kn < 0.4 ? (n.nextSlack ? 'turning' : '') : (n.flood ? 'flood' : 'ebb') + ' → ' + compass16(n.dir || 0), 'cur' + (n.kn >= 1.5 ? ' strong' : '')); draw(); } catch (e) { /* none */ } })();
  (async () => { try { const tt = (S.tide && !S.tide.none && S.tide.pos && distNm(S.tide.pos, p) < 3) ? S.tide : await tideFor(p); if (!tt || tt.none) return; const ts = tideState(tt); if (!ts) return;
    cells.tide = cell(spIc('tide', ts.rising === false ? 180 : 0), tideLen(ts.v).replace(/\s*(ft|m)$/, ''), ' ' + lenUnit(), (ts.next ? (ts.next.type === 'H' ? 'high ' : 'low ') + fmtClock(ts.next.t) : ts.state.toLowerCase()), 'tide'); draw(); } catch (e) { /* none */ } })();
  (async () => { const e = 0.00015, bb = [p.lon - e, p.lat - e, p.lon + e, p.lat + e]; for (const svc of ['enc_harbour', 'enc_approach', 'enc_coastal']) { try { const d = await encQuery(svc, 'depth', bb, 0.0001); const hit = d.filter((x) => x.d1 != null); if (hit.length) { const m = hit.reduce((a, x) => (x.d1 < a.d1 ? x : a)), ft = m.d1 / 0.3048, need = S.boat.draftFt ? S.boat.draftFt + (S.boat.safetyFt == null ? 2 : S.boat.safetyFt) : null;
    cells.depth = cell(spIc('depth'), m.d1 < 0 ? 'dries' : Math.round(ftToLen(ft)), m.d1 < 0 ? '' : ' ' + lenUnit(), 'charted' + (need && ft < need ? ' · shallow' : ''), 'depth' + (need && ft < need ? ' warn' : '')); draw(); return; } } catch (err) { /* next */ } } })();
  setTimeout(draw, 50);
}
document.addEventListener('click', (e) => {
  if (!SPOT.el) return;
  if (e.target.closest('[data-spx]')) { closeSpot(); return; }
  const a = e.target.closest('[data-spact]'); if (a) { const p = SPOT.p; closeSpot(); if (a.dataset.spact === 'more') { openPointSheet(L.latLng(p.lat, p.lon), null, true); return; } S.sheetPoint = { p, wp: null }; const fake = document.createElement('button'); fake.dataset.act = a.dataset.spact; fake.hidden = true; sheet.appendChild(fake); fake.click(); fake.remove(); return; }
});
map.on('movestart zoomstart', () => { if (SPOT.el && !SPOT.keep) closeSpot(); });
map.on('rotate', placeSpot);
function openWxModels() {
  const cur = S.settings.wxModel || 'best_match';
  openSheet('<h3>Weather model</h3><div class="sub">Which forecast drives the wind lines, the hourly forecast and the sailing coach. Waves always come from the marine model.</div>' +
    WX_MODELS.map(([v, l, d]) => '<button type="button" class="li wx-mod' + (cur === v ? ' on' : '') + '" data-wxm="' + v + '"><div class="li-main"><b>' + esc(l) + (cur === v ? ' ✓' : '') + '</b><span>' + esc(d) + '</span></div></button>').join('') +
    '<p class="hint">Models disagree most on timing of fronts and sea breezes. If two models agree, trust it more. (Side-by-side comparison is on the to-do list.)</p><div class="row-btns"><button class="btn ghost" data-act="close">Done</button></div>');
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-wxmodel]')) { openWxModels(); return; }
  const b = e.target.closest('[data-wxm]'); if (!b) return;
  S.settings.wxModel = b.dataset.wxm; saveSettings(); WX.grids = {}; maybeWeather(true); loadGrids(true); openWxModels(); renderWxBar();
  toast('Forecast now from ' + (WX_MODELS.find((m) => m[0] === S.settings.wxModel) || WX_MODELS[0])[1], 2500);
});
/* ---------- what you use Tideline for, and "This month": events, seasons and get-ready nudges for your kind of boating ---------- */
const USES = [['fish', 'Fishing'], ['sail', 'Sailing'], ['race', 'Racing'], ['cruise', 'Cruising / power'], ['loop', 'Great Loop'], ['paddle', 'Kayak / paddle'], ['pro', 'Work on the water']];
// Dated events are checked against their organizers' sites; "every year" items give the usual month only: always check the dates.
const EVENTS = [
  { n: 'White Marlin Open', where: 'Ocean City, MD (Harbour Island Marina)', from: '2026-08-03', to: '2026-08-08', uses: ['fish'], url: 'https://whitemarlinopen.com/', stay: 'Ocean City, Maryland' },
  { n: 'Annapolis Powerboat Show', where: 'City Dock, Annapolis', from: '2026-10-08', to: '2026-10-11', uses: ['cruise', 'fish', 'pro'], url: 'https://www.annapolisboatshows.com/', stay: 'Annapolis, Maryland' },
  { n: 'United States Sailboat Show', where: 'City Dock, Annapolis', from: '2026-10-15', to: '2026-10-18', uses: ['sail', 'race', 'cruise', 'loop'], url: 'https://www.annapolisboatshows.com/', stay: 'Annapolis, Maryland' },
  { n: 'Annapolis Fourth of July fireworks', where: 'Annapolis Harbor (safety zone in force that evening)', month: 7, day: 4, uses: ['sail', 'cruise', 'fish', 'paddle'], url: 'https://www.navcen.uscg.gov/msi' },
  { n: 'Eastport Yacht Club Lights Parade', where: 'Annapolis Harbor and Spa Creek', month: 12, note: 'usually a Saturday in early December', uses: ['sail', 'cruise'], url: 'https://www.eastportyc.org/' }
];
const SEASON = {
  fish: { 4: 'Rockfish season rules change through spring: check Maryland DNR before you keep one.', 5: 'Rockfish trophy fish on the main Bay; check DNR dates and size limits.', 6: 'Croaker and spot arrive; crabbing picks up.', 7: 'Spanish mackerel and bluefish on the main Bay; crabs are running.', 8: 'White Marlin Open in Ocean City; Spanish mackerel and cobia lower Bay.', 9: 'Fall run starts: bluefish and rockfish busting on bait at dawn and dusk.', 10: 'Big fall jimmies; rockfish schooling on bait; watch for birds working.', 11: 'Late-fall rockfish on deeper channel edges; water cooling fast.', 12: 'Winter rockfish rules apply: check DNR; dress for cold water.' },
  sail: { 4: 'Commissioning: check standing rigging and the bottom before launch.', 5: 'Wednesday-night race series start around Annapolis.', 7: 'Light mornings, sea-breeze afternoons; watch for thunderstorms after 3 PM.', 9: 'Best sailing of the year: steady northerlies and cooler air.', 10: 'Sailboat Show in Annapolis; fall breezes are strong, reef early.', 11: 'Frostbite season begins for small boats; plan your haul-out.', 12: 'Winterize: engine, water tanks, head; remove sails.' },
  race: { 5: 'Spring series start: get your rating certificate and crew list in.', 10: 'Fall championships and season-closers; the Sailboat Show is the week after the Powerboat Show.', 11: 'Frostbite racing: check your club’s notice of race.' },
  cruise: { 4: 'Spring commissioning; service the engine and check the bilge pump.', 6: 'Hurricane season runs June to November: have a storm plan.', 9: 'Peak hurricane weeks: watch the tropics before long trips.', 10: 'Powerboat Show in Annapolis; fall cruising is quiet and beautiful.', 11: 'Haul-out and winterizing season.' },
  loop: { 4: 'Northbound loopers pass the Chesapeake heading for New York and the canals.', 6: 'Canal season: Erie and Trent–Severn are open.', 9: 'Be through Chicago by early September for the rivers.', 10: 'On the rivers and Tenn–Tom; plan the Gulf crossing after November 1.', 11: 'Gulf crossing season: wait for the weather window.' },
  paddle: { 5: 'Water is still cold: dress for the water, not the air.', 7: 'Go early before the afternoon wind and storms.', 10: 'Calm fall mornings, cold water again soon: bring a dry layer.' }
};
const AFF = { stay: '' }; // fill with an affiliate ID when you sign up (e.g. a hotel booking partner); links work without it
function evDates(e, y) { if (e.from) return [Date.parse(e.from + 'T08:00'), Date.parse(e.to + 'T20:00')]; const a = new Date(y, e.month - 1, e.day || 1, 8), b = new Date(y, e.month - 1, e.day || 28, 22); return [+a, +b]; }
function myUses() { return S.settings.uses && S.settings.uses.length ? S.settings.uses : [S.settings.boatType === 'sail' ? 'sail' : 'cruise']; }
function upcoming(days) {
  const now = Date.now(), y = new Date().getFullYear(), u = myUses(), out = [];
  EVENTS.forEach((e) => { if (!e.uses.some((x) => u.includes(x))) return; for (const yy of [y, y + 1]) { const [a, b] = evDates(e, yy); if (b > now && a - now < days * 86400000) { out.push(Object.assign({ a, b }, e)); break; } if (e.from) break; } });
  return out.sort((p, q) => p.a - q.a);
}
function openThisMonth() {
  const m = new Date().getMonth() + 1, u = myUses(), mn = new Date().toLocaleString([], { month: 'long' }), ev = upcoming(120);
  const tips = u.map((k) => SEASON[k] && SEASON[k][m] ? '<li><b>' + esc((USES.find((x) => x[0] === k) || [k, k])[1]) + ':</b> ' + esc(SEASON[k][m]) + '</li>' : '').join('');
  openSheet('<h3>' + mn + ' on the water</h3><div class="sub">For ' + esc(u.map((k) => (USES.find((x) => x[0] === k) || [k, k])[1].toLowerCase()).join(', ')) + ' · <a href="#" data-usesedit>change</a></div>' +
    (tips ? '<div class="fm-card"><b>This month</b><ul>' + tips + '</ul></div>' : '') +
    '<div class="mo-h">Coming up</div>' + (ev.length ? ev.map((e) => { const days = Math.ceil((e.a - Date.now()) / 86400000), on = e.a <= Date.now();
      return '<div class="ev"><div class="ev-d"><b>' + new Date(e.a).toLocaleDateString([], { month: 'short' }) + '</b><span>' + new Date(e.a).getDate() + (e.from && e.to !== e.from ? '–' + new Date(e.b).getDate() : '') + '</span></div><div class="ev-m"><b>' + esc(e.n) + '</b><span>' + esc(e.where) + (e.note ? ' · ' + esc(e.note) : '') + ' · ' + (on ? 'on now' : days <= 1 ? 'tomorrow' : 'in ' + days + ' days') + (e.from ? '' : ' · usual date, check') + '</span><div class="ev-a"><a href="' + e.url + '" target="_blank" rel="noopener">Details</a>' + (e.stay ? '<a href="https://www.booking.com/searchresults.html?ss=' + encodeURIComponent(e.stay) + '&checkin=' + new Date(e.a).toISOString().slice(0, 10) + '&checkout=' + new Date(e.b).toISOString().slice(0, 10) + (AFF.stay ? '&aid=' + AFF.stay : '') + '" target="_blank" rel="noopener">Places to stay</a>' : '') + '</div></div></div>'; }).join('') : '<p class="sub">Nothing on the list for the next four months.</p>') +
    '<p class="hint">Event dates come from the organizers; always check before you go. Want your club’s regattas or tournaments here? That list is growing.</p><div class="row-btns"><button class="btn ghost" data-act="close">Close</button></div>');
}
function openUses(afterWelcome) {
  const u = new Set(S.settings.uses || []);
  const html = '<h3>What do you use Tideline for?</h3><div class="sub">Pick all that fit. Tideline tailors tips, events and coaching to them.</div><div class="uses">' + USES.map(([v, l]) => '<button type="button" data-use="' + v + '" class="' + (u.has(v) ? 'on' : '') + '">' + esc(l) + '</button>').join('') + '</div><div class="row-btns"><button class="btn primary" data-usesdone="' + (afterWelcome ? '1' : '') + '">Done</button></div>';
  if (afterWelcome) { const el = $('welcome'); if (el) { el.querySelector('.wl-card').innerHTML = html; el.hidden = false; return; } } openSheet(html);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-use]'); if (b) { const u = new Set(S.settings.uses || []); u.has(b.dataset.use) ? u.delete(b.dataset.use) : u.add(b.dataset.use); S.settings.uses = [...u]; saveSettings(); b.classList.toggle('on'); return; }
  const d = e.target.closest('[data-usesdone]'); if (d) { if (d.dataset.usesdone) { const el = $('welcome'); if (el) el.hidden = true; store.set('welcomed', true); if (!store.get('toured', false)) setTimeout(() => startTour(), 400); } else openThisMonth(); return; }
  if (e.target.closest('[data-usesedit]')) { e.preventDefault(); openUses(false); }
});
// a gentle get-ready nudge, at most once per event, a week out
setTimeout(() => { const seen = store.get('evSeen', {}); const e = upcoming(8).find((x) => !seen[x.n + x.a] && x.a > Date.now()); if (!e) return; seen[e.n + e.a] = 1; store.set('evSeen', seen); toast('Coming up: ' + e.n + ' (' + new Date(e.a).toLocaleDateString([], { month: 'short', day: 'numeric' }) + '). Menu → This month for details.', 7000); }, 9000);
/* ---------- arrange the buttons: drag them up and down a column or across to the other side; they snap into line ---------- */
const ARR = { on: false, drag: null };
const ARR_SKIP = new Set(['alertBar']);
function fabItems(col) { return [...col.children].filter((x) => x.id && !ARR_SKIP.has(x.id)); }
function applyFabLayout() {
  const lay = S.settings.fabLayout; if (!lay) return; const L0 = $('fabs'), R0 = $('fabsR'); if (!L0 || !R0) return;
  [['left', L0], ['right', R0]].forEach(([k, col]) => (lay[k] || []).forEach((id) => { const el = $(id); if (el) { el.classList.remove('fab-free'); el.style.left = el.style.top = ''; col.appendChild(el); } }));
  Object.entries(lay.free || {}).forEach(([id, q]) => { const el = $(id); if (!el) return; $('app').appendChild(el); el.classList.add('fab-free'); el.style.left = (q.x * 100).toFixed(2) + '%'; el.style.top = (q.y * 100).toFixed(2) + '%'; });
  const al = $('alertBar'); if (al && al.parentNode === L0) L0.appendChild(al);
}
function saveFabLayout() { const free = {}; document.querySelectorAll('#app > .fab-free[id]').forEach((el) => { const r = el.getBoundingClientRect(); free[el.id] = { x: +(r.left / innerWidth).toFixed(4), y: +(r.top / innerHeight).toFixed(4) }; }); S.settings.fabLayout = { left: fabItems($('fabs')).map((x) => x.id), right: fabItems($('fabsR')).map((x) => x.id), free }; saveSettings(); }
function arrangeMode(on) {
  ARR.on = on; document.documentElement.classList.toggle('arrange', on); closeSheet(); closeSpot && closeSpot();
  let bar = $('arrBar'); if (!bar) { bar = document.createElement('div'); bar.id = 'arrBar'; bar.className = 'arr-bar'; document.body.appendChild(bar); }
  bar.innerHTML = '<span>Drag a button, or ⠿ to move a whole row</span><button type="button" class="btn small" data-arr="bottom">Bottom row</button><button type="button" class="btn small" data-arr="tidy">Tidy up</button><button type="button" class="btn small" data-arr="reset">Reset</button><button type="button" class="btn small primary" data-arr="done">Done</button>';
  setTimeout(arrGrips, 60); bar.hidden = !on; if (on) bar.style.removeProperty('display'); else bar.style.setProperty('display', 'none', 'important'); if (!on) { arrPreview(null); saveFabLayout(); toast('Buttons arranged. Menu → Arrange buttons to change again.', 3000); }
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-arr]'); if (a) { if (a.dataset.arr === 'done') arrangeMode(false); else if (a.dataset.arr === 'tidy') arrTidy(); else if (a.dataset.arr === 'bottom') fabPreset('bottom'); else { delete S.settings.fabLayout; saveSettings(); location.reload(); } return; }
  if (ARR.on && e.target.closest('#fabs, #fabsR, .fab-free')) { e.stopPropagation(); e.preventDefault(); } // buttons do not act while arranging
}, true);
document.addEventListener('pointerdown', (e) => {
  if (!ARR.on) return; const el = e.target.closest('#fabs > [id], #fabsR > [id], #app > .fab-free[id]'); if (!el || ARR_SKIP.has(el.id)) return;
  e.preventDefault(); e.stopPropagation(); const r = el.getBoundingClientRect();
  const ph = document.createElement('div'); ph.className = 'arr-ph'; ph.style.height = r.height + 'px'; ph.style.width = r.width + 'px'; el.parentNode.insertBefore(ph, el);
  el.classList.add('arr-drag'); Object.assign(el.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', zIndex: 3000, pointerEvents: 'none' });
  ARR.drag = { el, ph, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, r0: r, moved: false }; document.documentElement.classList.add('arr-dragging');
}, true);
document.addEventListener('pointermove', (e) => {
  const d = ARR.drag; if (!d) return; e.preventDefault(); if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 8) d.moved = true; if (!d.moved) return;
  d.el.style.left = (e.clientX - d.dx) + 'px'; d.el.style.top = (e.clientY - d.dy) + 'px';
  const L0 = $('fabs').getBoundingClientRect(), R0 = $('fabsR').getBoundingClientRect(), inCol = (R, x, y) => x > R.left - 24 && x < R.right + 24 && y > R.top - 30 && y < R.bottom + 30;
  const nearL = inCol(L0, e.clientX, e.clientY), nearR = inCol(R0, e.clientX, e.clientY);
  d.free = !nearL && !nearR; arrPreview(d.free ? d : null); if (d.free) { d.ph.remove(); return; } // out on the chart: it will stay where you let go
  const col = nearL ? $('fabs') : $('fabsR'), items = [...col.children].filter((x) => x !== d.el && x !== d.ph && !ARR_SKIP.has(x.id));
  let before = null; for (const it of items) { const rr = it.getBoundingClientRect(); if (e.clientY < rr.top + rr.height / 2) { before = it; break; } }
  if (before) col.insertBefore(d.ph, before); else { const al = $('alertBar'); if (al && al.parentNode === col) col.insertBefore(d.ph, al); else col.appendChild(d.ph); }
}, { capture: true, passive: false });
const arrDrop = () => { const d = ARR.drag; if (!d) return; ARR.drag = null; arrPreview(null); d.el.classList.remove('arr-drag'); document.documentElement.classList.remove('arr-dragging');
  if (!d.moved) { // a tap, not a drag: put it back and offer this button its own look
    if (d.el.classList.contains('fab-free') || !d.ph.parentNode) { ['position', 'width', 'zIndex', 'pointerEvents'].forEach((k) => { d.el.style[k] = ''; }); d.el.style.left = d.r0.left + 'px'; d.el.style.top = d.r0.top + 'px'; d.ph.remove(); }
    else { d.ph.parentNode.insertBefore(d.el, d.ph); d.ph.remove(); ['position', 'left', 'top', 'width', 'zIndex', 'pointerEvents'].forEach((k) => { d.el.style[k] = ''; }); }
    openFabLookFor(d.el); return; }
  if (d.free || !d.ph.parentNode) { const r = d.el.getBoundingClientRect(), tb = ($('tabbar') || document.querySelector('.tabbar')).getBoundingClientRect().top;
    const sn = arrSnap(parseFloat(d.el.style.left) || r.left, parseFloat(d.el.style.top) || r.top, d.el.offsetWidth || r.width, d.el.offsetHeight || r.height, d.el, tb), x = sn.x, y = sn.y; // grid, edges and neighbours (see arrSnap)
    $('app').appendChild(d.el); d.el.classList.add('fab-free'); ['position', 'width', 'zIndex', 'pointerEvents'].forEach((k) => { d.el.style[k] = ''; }); d.el.style.left = x + 'px'; d.el.style.top = y + 'px'; d.ph.remove(); arrEven(d.el); }
  else { d.ph.parentNode.insertBefore(d.el, d.ph); d.ph.remove(); d.el.classList.remove('fab-free'); ['position', 'left', 'top', 'width', 'zIndex', 'pointerEvents'].forEach((k) => { d.el.style[k] = ''; }); }
  saveFabLayout(); arrGrips(); };
document.addEventListener('pointerup', arrDrop, true); document.addEventListener('pointercancel', arrDrop, true);
setTimeout(applyFabLayout, 300);
/* ---------- instruments: press and hold a gauge, drag it onto another, and they swap (works with a finger, no Customize needed) ---------- */
(() => {
  let hold = null, drag = null;
  const tileAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest('#cockpit .ck-slot[data-slot], #panelSide .sg'); };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('#cockpit .ck-slot[data-slot]'); if (!t || e.target.closest('select, button, input, .leaflet-container')) return;
    const x0 = e.clientX, y0 = e.clientY; clearTimeout(hold);
    hold = setTimeout(() => {
      const r = t.getBoundingClientRect(), ghost = t.cloneNode(true); ghost.className = 'ck-ghost'; Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      document.body.appendChild(ghost); t.classList.add('dragging'); drag = { t, ghost, dx: x0 - r.left, dy: y0 - r.top, over: null }; if (navigator.vibrate) navigator.vibrate(15);
    }, 380);
    const cancel = (ev) => { if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) clearTimeout(hold); };
    document.addEventListener('pointermove', cancel, { once: false }); setTimeout(() => document.removeEventListener('pointermove', cancel), 400);
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!drag) return; e.preventDefault(); drag.ghost.style.left = (e.clientX - drag.dx) + 'px'; drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
    drag.ghost.style.visibility = 'hidden'; const o = tileAt(e.clientX, e.clientY); drag.ghost.style.visibility = '';
    document.querySelectorAll('#cockpit .drop').forEach((x) => x.classList.remove('drop')); if (o && o !== drag.t && o.dataset.slot != null) { o.classList.add('drop'); drag.over = o; } else drag.over = null;
  }, { capture: true, passive: false });
  const end = () => { clearTimeout(hold); if (!drag) return; const d = drag; drag = null; d.ghost.remove(); document.querySelectorAll('#cockpit .dragging, #cockpit .drop').forEach((x) => x.classList.remove('dragging', 'drop'));
    if (d.over) { ckSwap(+d.t.dataset.slot, +d.over.dataset.slot); toast('Swapped', 1200); } };
  document.addEventListener('pointerup', end, true); document.addEventListener('pointercancel', end, true);
})();
function openGaugeLook() {
  const st = S.settings, seg = (k, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, t]) => '<button type="button" data-opt="' + k + '" data-val="' + v + '" class="' + (String(cur) === v ? 'on' : '') + '">' + t + '</button>').join('') + '</div>';
  openSheet('<h3>Gauge look</h3><div class="sub">For the speed circle, the instruments and, if you like, the buttons</div>' + glPicker(st.gTheme || 'midnight') +
    '<div class="field"><label>Style</label>' + seg('gStyle', st.gStyle || 'hybrid', [['analog', 'Analog'], ['hybrid', 'Analog + digital'], ['digital', 'Digital']]) + '</div><div class="field"><label>Artwork in the face</label>' + seg('gArt', st.gArt || 'on', [['on', 'On'], ['off', 'Plain']]) + '</div>' +
    '<div class="field"><label>Theme the rest of the app with it</label>' + seg('fabLook', st.fabLook || 'theme', [['app', 'Everything'], ['gauge', 'Buttons and tab bar'], ['theme', 'Nothing else']]) + '</div>' +
    '<p class="hint" style="margin:-4px 0 8px">Everything = buttons, tab bar, menus and sheets. To give one button its own look: Menu → Arrange buttons, then tap the button.</p>' +
    '<div class="field"><label>Where the buttons sit</label><div class="seg" role="group"><button type="button" data-fabpre="sides">Down the sides</button><button type="button" data-fabpre="bottom">Left ones along the bottom</button><button type="button" data-fabpre="bottom2">All along the bottom</button></div></div>' +
    '<div class="row-btns"><button class="btn primary" data-act="close">Done</button></div>');
}document.addEventListener('click', (e) => { if (e.target.closest('[data-gauge-look]')) { e.stopPropagation(); openGaugeLook(); } });
function applyGArt() { document.documentElement.dataset.gart = S.settings.gArt || 'on'; }
applyGArt();
/* ---------- first mate, one assistant: the sparkle button and Menu → First mate open the same thing. It has a name you choose
   ("Gilligan"), listens for it hands-free, understands everyday wording (not a fixed list of commands), answers out loud
   when you spoke to it, and hands anything it cannot place to the AI relay once one is set up.
   The functions below with the same names as earlier ones replace them (the last function declaration wins). ---------- */
ICON.mate = '<path d="M11.6 3c.6 4.4 3.2 7 7.6 7.6-4.4.6-7 3.2-7.6 7.6-.6-4.4-3.2-7-7.6-7.6 4.4-.6 7-3.2 7.6-7.6z"/>';
if (!S.settings.mateName && S.settings.wakeWord && !/^first mate$/i.test(S.settings.wakeWord)) { S.settings.mateName = S.settings.wakeWord.replace(/\b\w/g, (c) => c.toUpperCase()); saveSettings(); }
const mateName = () => String(S.settings.mateName || '').trim() || 'First mate';
const mateCall = () => (S.settings.mateName ? String(S.settings.mateName).trim() : 'First mate');
// Menu tiles open sheets, but on a phone or an upright iPad the Menu panel (z-index 850) sits over the sheet (800), so the
// sheet opened unseen and the tile looked dead. If a tile leaves a sheet covered by a panel, go to the chart so it shows.
function sheetCovered() {
  if (sheet.hidden) return false; const r = sheet.getBoundingClientRect(); if (r.height < 4) return false;
  const st = document.elementsFromPoint(r.left + r.width / 2, Math.min(innerHeight - 4, r.top + Math.min(60, r.height / 2)));
  const ip = st.findIndex((x) => x.closest('.panel')), is = st.findIndex((x) => x.closest('#sheet'));
  return ip >= 0 && (is < 0 || ip < is);
}
$('panelMenu').addEventListener('click', (e) => {
  if (!e.target.closest('[data-mact]')) return; const t0 = S.tab;
  [0, 350, 1200].forEach((ms) => setTimeout(() => { if (S.tab === t0 && sheetCovered()) setTab('chart'); }, ms));
});
/* the words: small typo- and mishearing-tolerant matching */
function fmLev(a, b) {
  if (a === b) return 0; const m = a.length, n = b.length; if (!m || !n) return m || n; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const fmSim = (a, b) => 1 - fmLev(a, b) / Math.max(a.length, b.length, 1);
const FM_VOCAB = ('show hide display radar rain raining showers storms weather forecast wind windy breeze gusts waves seas swell current currents tide tides tidal ' +
  'zoom closer north course heading night dark daylight mode record recording tracking track waypoint overboard navigate navigation route home harbor ' +
  'depth deep shallow ships vessels traffic satellite instruments gauges where leave depart start stop mark position location anchor').split(' ');
function fmFix(c) { // "rader" → radar, "wether" → weather, "currant" → current, "overbored" → overboard
  return c.split(' ').map((w) => { if (w.length < 5 || FM_VOCAB.includes(w)) return w; let best = null, bd = 9;
    FM_VOCAB.forEach((v) => { if (Math.abs(v.length - w.length) > 2) return; const d = fmLev(w, v); if (d < bd) { bd = d; best = v; } });
    return best && bd <= (w.length >= 7 ? 2 : 1) ? best : w; }).join(' ');
}
// "Gilligan, take me home" / "hey Gilligan show me the rain" / "first mate, where am I": returns what follows the name, or null
function fmWakeSplit(said) {
  const words = String(said).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const names = [...new Set([mateName().toLowerCase(), 'first mate'])].map((n) => n.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)).filter((n) => n.length);
  for (let i = 0; i < words.length; i++) for (const nw of names) {
    if (i + nw.length > words.length) continue; const seg = words.slice(i, i + nw.length).join(' ').replace(/'s$/, ''), target = nw.join(' ');
    if (seg === target || (target.length >= 4 && fmSim(seg, target) >= 0.75)) return words.slice(i + nw.length).join(' ').replace(/^(please|can you|could you)\s+/, '');
  }
  return null;
}
/* the answers */
function fmWindSay() {
  const w = S.weather && S.weather.cur; if (!w || w.spd == null) return 'I do not have the wind yet. Check your signal; it updates every few minutes.';
  const u = SPEED_LBL[S.settings.speedUnit] || 'knots', hrs = (S.weather.hours || []).filter((h) => h.t > Date.now() && h.t < Date.now() + 6 * 3600000), mx = hrs.length ? Math.max(...hrs.map((h) => h.gust || h.spd || 0)) : null;
  return 'Wind ' + Math.round(speedOut(w.spd)) + ' ' + u + ' from the ' + compass16(w.dir) + (w.gust ? ', gusting ' + Math.round(speedOut(w.gust)) : '') + '.' + (mx != null && mx > (w.gust || w.spd) + 4 ? ' Gusts to ' + Math.round(speedOut(mx)) + ' in the next six hours.' : '');
}
function fmWeatherSay() {
  const W = S.weather; if (!W || !W.cur) return 'Here is the forecast.';
  const hrs = (W.hours || []).filter((h) => h.t > Date.now() && h.t < Date.now() + 12 * 3600000), wet = hrs.find((h) => (h.rain || 0) > 0.2);
  return fmWindSay() + (W.cur.temp != null ? ' ' + Math.round(S.settings.tempUnit === 'C' ? W.cur.temp : W.cur.temp * 9 / 5 + 32) + ' degrees.' : '') + (hrs.length ? (wet ? ' Rain likely around ' + fmtClock(wet.t) + '.' : ' No rain in the next twelve hours.') : '');
}
function fmTideSay(c) {
  const t = S.tide; if (!t || t.none || !t.hilo) return 'I do not have tide predictions yet. Open Weather, then Tide.';
  const want = /\blow\b/.test(c) ? 'L' : /\bhigh\b/.test(c) ? 'H' : null, nx = t.hilo.find((p) => p.t > Date.now() && (!want || p.type === want)), tn = tideNow();
  if (!nx) return 'No more tide turns in the predictions I have.';
  const mins = Math.round((nx.t - Date.now()) / 60000), inT = mins < 90 ? mins + ' minutes' : (mins / 60).toFixed(mins < 600 ? 1 : 0) + ' hours';
  return (nx.type === 'H' ? 'High' : 'Low') + ' tide at ' + fmtClock(nx.t) + ', in ' + inT + (nx.v != null ? ', ' + tideLen(nx.v) : '') + '.' + (tn && tn.rising != null ? ' The tide is ' + (tn.rising ? 'rising' : 'falling') + ' now.' : '') + (t.station ? ' ' + t.station.name.replace(/,.*$/, '') + '.' : '');
}
function fmDepthSay() {
  const d = DEP.v; if (!d) return DEP.busy ? 'Reading the chart depth here. Ask again in a moment.' : 'No charted depth here. Tideline reads the NOAA chart; no depth sounder is connected.';
  const tn = tideNow(), ft = d.d1 / 0.3048 + (tn ? tn.v : 0), need = S.boat && S.boat.draftFt ? S.boat.draftFt + (S.boat.safetyFt == null ? 2 : S.boat.safetyFt) : null;
  return 'Charted depth about ' + Math.round(ftToLen(ft)) + ' ' + (lenUnit() === 'm' ? 'meters' : 'feet') + (tn ? ' with the tide' : '') + '.' + (need && ft < need ? ' That is shallow for your boat.' : '') + ' From the chart, not a sounder.';
}
function fmWhereSay() {
  const p = S.fix; if (!p) return 'No GPS position yet.';
  let best = null; FM_KNOWN.forEach(([, n, la, lo]) => { const d = distNm(p, { lat: la, lon: lo }); if (!best || d < best.d) best = { n, d, b: bearing({ lat: la, lon: lo }, p) }; });
  const ll = Math.abs(p.lat).toFixed(3) + (p.lat >= 0 ? ' north, ' : ' south, ') + Math.abs(p.lon).toFixed(3) + (p.lon <= 0 ? ' west' : ' east');
  return (best && best.d < 15 ? (best.d < 0.3 ? 'At ' + best.n + '. ' : fmtDist(best.d) + ' ' + compass16(best.b) + ' of ' + best.n + '. ') : '') + ll + '.';
}
function fmRouteGo() { // "start" / "let's go" after a course is plotted
  if (!(RT.pts && RT.pts.length > 1)) return null;
  if (!sheet.querySelector('[data-act="rtstart"]')) routeMode(true);
  const b = sheet.querySelector('[data-act="rtstart"]'); if (!b) return null; b.click(); return 'Under way. I will call out the turns.';
}
// Everyday wording → action. Returns { say, close } when it handled the request, or null so the older parser and the AI can try.
async function fmUnderstand(text) {
  const raw = String(text || '').trim(); if (!raw) return null;
  let c = raw.toLowerCase().replace(/[“”"!?.]+/g, ' ').replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  const w = fmWakeSplit(c); if (w != null && w) c = w;
  for (let k = 0; k < 3; k++) c = c.replace(/^(hey|hi|ok|okay|um|uh|so|please|can you|could you|would you|will you|i want to|i'd like to|i would like to|i wanna|let's|lets|go ahead and|just)\s+/, '');
  c = c.replace(/\s+(please|now|for me|right now|thanks|thank you)$/g, '').trim();
  const f = fmFix(c), has = (re) => re.test(f);
  const off = has(/\b(hide|remove|turn off|switch off|clear|get rid of|no more|stop showing|take away|close|kill|lose)\b/);
  if (has(/\b(man|person|crew|someone|somebody|child|kid|dog|guy|woman|girl|boy) (is |went |fell )?overboard\b|^mob$|\bman overboard\b/)) { closeSheet(); triggerMob(); return { say: S.mob ? 'Man overboard marked. Steering back to the spot. Keep pointing at them and call the Coast Guard on channel 16.' : 'No GPS position, so I could not mark the spot. Keep pointing at them.' }; }
  if (has(/\b(stop|quit|pause) listening\b|\bgo to sleep\b/)) { wakeStop(); return { say: 'Stopped listening.' }; }
  if (has(/^(start|go|let'?s go|start (the )?(route|navigation|navigating|guidance|course)|begin( navigation)?|start navigating|follow (the|this) (route|course))$/)) { const r = fmRouteGo(); if (r) return { say: r, close: true }; }
  if (has(/^(stop|end|cancel)( the)? (navigation|navigating|route|course|guidance)$/)) { endGoto(); return { say: 'Navigation ended.' }; }
  // questions with a spoken answer
  if (has(/\b(when|what time)\b.*\b(high|low)\b|\b(next|high|low) tide\b|\btide (times?|tables?|turn)\b|\bis the tide (rising|falling|coming|going|in|out)\b|\bwhen.*\btide\b/)) return { say: fmTideSay(f) };
  if (has(/\b(how deep|how much water|how shallow|what'?s the depth|what is the depth|depth here|water depth)\b|^depth$/)) return { say: fmDepthSay() };
  if (has(/\bwhere (am i|are we|is the boat|is my boat|are we at)\b|\b(my|our) (position|location)\b|\bfind me\b|\bcenter (on )?(me|us|the boat)\b/)) { closeSheet(); setTab('chart'); if (S.fix) setFollow(true); return { say: fmWhereSay(), close: true }; }
  if (has(/\b(best|good|right) time to (leave|go|sail|depart|head out|cast off)\b|\bwhen (should|do|can|could) (i|we) (leave|go|sail|depart|head out|cast off)\b|\bwhat time should (i|we)\b/)) {
    const dm = f.match(/\b(?:for|to)\s+(?!leave|go|sail|depart)(.+)$/); return (await fmLocal('when should i leave' + (dm ? ' for ' + dm[1] : ''))) ? { say: 'Here is the best time to leave.', close: true } : null; }
  if (has(/\b(what'?s|what is|whats|how'?s|how is|how much|how strong|how hard|is it) (the )?(wind|windy|breeze|blowing|gusting)\b|\bhow windy\b|\bwind (speed|now|report)\b|^(the )?wind$/)) { setTab('chart'); setWxL('wind', true); return { say: fmWindSay() }; }
  if (!off && has(/\b(what'?s|what is|whats|how'?s|how is) (the )?(weather|forecast)\b|\bweather (report|today|like|forecast)\b|^(the )?(weather|forecast)$|\b(show|give|bring up|open|get|check)( me| us)?( the)? (weather|forecast)\b|\bis it going to rain\b|\bwill it rain\b/)) {
    if (has(/\brain\b/)) { setTab('chart'); setWxL('rain', true); } else { WX.view = 'wind'; WX.open = true; closeSheet(); setTab('weather'); }
    return { say: fmWeatherSay(), close: true };
  }
  // going places: take me home / go to / navigate to / route to / head for …
  if (has(/^(go |head |sail |motor |get |bring us |take us |take me |let'?s go |return |navigate |steer )?(back )?home$|\b(take|bring|get|head|go|navigate|route|steer|sail|motor|return|guide|lead)( me| us)?( back)? (to )?(home|my (slip|dock|marina|home port|mooring)|home port|the (dock|slip|marina|mooring))$/)) {
    if (!homePort()) return { say: 'Set your home port first: Navigate, then Home port.' };
    await fmLocal('take me to home'); return { say: RT.pts && RT.pts.length > 1 ? 'Course home plotted. Say “start” or tap Start to go.' : null, close: true };
  }
  let m = c.match(/\bfrom (.+?) to (.+)$/);
  if (m && has(/\b(course|route|trip|passage|navigate|take|go|plot|plan|get|sail)\b/)) { await fmLocal('set a course from ' + m[1] + ' to ' + m[2]); return { say: RT.pts && RT.pts.length > 1 ? 'Course plotted. Review it, then say “start”.' : null, close: true }; }
  m = c.match(/\b(?:take|bring|get|lead|guide|drive|run) (?:me|us)(?: (?:over|out|down|up|back))? (?:to|towards?) (.+)$/) || c.match(/\b(?:navigate|route|go|head|sail|motor|steer|cruise|directions|heading|going|run|make for)(?: me| us)?(?: (?:over|out|down|up|back))? (?:to|towards?|for) (.+)$/) ||
    c.match(/\bhow (?:do|can|would) (?:i|we) get to (.+)$/) || c.match(/\b(?:set|plot|plan|make|lay|chart)(?: me| us)? (?:a |the )?(?:course|route|trip|passage|heading) (?:to|for) (.+)$/);
  if (m && !/^(sleep|bed)$/.test(m[1])) {
    const q = m[1].replace(/\b(please|now|for me)$/g, '').trim(); await fmLocal('take me to ' + q);
    return { say: RT.pts && RT.pts.length > 1 ? 'Course plotted. Review it, then say “start”.' : null, close: true };
  }
  if (has(/\bnorth up\b/)) { setOrient('north'); return { say: 'North up.' }; }
  if (has(/\b(course|heading|track|bow|head) up\b/)) { setOrient('course'); return { say: 'Course up.' }; }
  if (has(/\b(night|dark|red) (mode|colou?rs?|screen|theme)\b|\bit'?s (getting )?dark\b|^night$|\bdim the screen\b/)) { S.settings.theme = 'night'; saveSettings(); applyNight(); renderThemeBtn(); return { say: 'Night colors.' }; }
  if (has(/\bdusk (mode|colou?rs?)\b|^dusk$/)) { S.settings.theme = 'dusk'; saveSettings(); applyNight(); renderThemeBtn(); return { say: 'Dusk colors.' }; }
  if (has(/\b(day|light|bright|daylight|daytime) (mode|colou?rs?|screen|theme)\b|\bbrighter\b|^day$/)) { S.settings.theme = 'day'; saveSettings(); applyNight(); renderThemeBtn(); return { say: 'Day colors.' }; }
  if (has(/\bzoom (way |all the way )?out\b|\b(further|farther|way) out\b|\bwider\b|\bpull back\b|\bshow more\b|\bsee more\b|\bzoom back\b/)) { closeSheet(); setTab('chart'); map.setZoom(map.getZoom() - (/\b(way|lot|more|all)\b/.test(f) ? 2 : 1)); return { say: 'Zoomed out.', close: true }; }
  if (has(/\bzoom( way)?( in)?\b|\bcloser\b|\bmagnify\b|\benhance\b/)) { closeSheet(); setTab('chart'); map.setZoom(map.getZoom() + (/\b(way|lot|more|all)\b/.test(f) ? 2 : 1)); return { say: 'Zoomed in.', close: true }; }
  if (has(/\b(start|begin|turn on|switch on)\b.*\b(record|recording|track|tracking|logging|log)\b|^record( (my|the|our) (track|trip|path))?$|^(track|log) (my|the|our) (trip|path)$/)) {
    if (S.rec.on) return { say: 'Already recording your track.' };
    S.rec = { on: true, pts: [], start: Date.now() }; trackLine.setLatLngs([]); if (S.fix) recordPoint(S.fix, true); store.set('rec', S.rec); $('recDot').hidden = false; return { say: 'Recording your track.' };
  }
  if (has(/\b(stop|end|finish|turn off|save)\b.*\b(record|recording|track|tracking|logging)\b/)) {
    if (!S.rec.on) return { say: 'Not recording right now.' };
    const pts = S.rec.pts, ok = pts.length > 1; if (ok) { S.tracks.push({ id: Date.now(), name: new Date(S.rec.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + fmtClock(S.rec.start), start: S.rec.start, end: Date.now(), dist: trackDist(pts), pts }); store.set('tracks', S.tracks); }
    S.rec = { on: false, pts: [], start: null }; store.set('rec', S.rec); trackLine.setLatLngs([]); $('recDot').hidden = true; return { say: ok ? 'Track saved.' : 'Stopped. The track was too short to save.' };
  }
  if (has(/\b(mark|save|drop|remember|pin|flag|tag|add)\b.*\b(spot|place|location|position|here|this|waypoint|pin|it)\b|\bwaypoint\b|\bdrop a pin\b|^mark( it)?$/)) {
    const p = refPos(), n = S.waypoints.length + 1, fish = /\b(fish|fishing|bite|biting|crab)\b/.test(f);
    const wp = { id: Date.now(), name: (fish ? 'Fishing spot ' : 'Waypoint ') + n, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }; S.waypoints.push(wp); store.set('waypoints', S.waypoints); renderWaypoints();
    return { say: 'Saved ' + wp.name + (S.fix ? ' at the boat.' : ' at the middle of the chart; there is no GPS position yet.') };
  }
  // layers by name, in any wording: "show me the rain", "rain radar", "get rid of the wind", "where are the ships"
  const LW = { rain: 'rain', raining: 'rain', radar: 'rain', showers: 'rain', storms: 'rain', storm: 'rain', thunderstorms: 'rain', precipitation: 'rain', precip: 'rain',
    wind: 'wind', winds: 'wind', breeze: 'wind', gusts: 'wind', waves: 'waves', wave: 'waves', seas: 'waves', swell: 'waves', chop: 'waves',
    current: 'cur', currents: 'cur', tide: 'tide', tides: 'tide', tidal: 'tide', ais: 'ais', ships: 'ais', ship: 'ais', boats: 'ais', traffic: 'ais', vessels: 'ais', freighters: 'ais', tankers: 'ais', barges: 'ais',
    satellite: 'sat', aerial: 'sat', imagery: 'sat' };
  const ls = [...new Set(f.split(/[\s,&]+/).map((x) => LW[x]).filter(Boolean))];
  if (ls.length && !has(/\b(fish|fishing|crab|crabs|crabbing)\b/)) {
    const on = !off, said = [];
    ls.forEach((l) => {
      if (l === 'tide') { S.tideCardOn = on; renderTideCard(); said.push('the tide'); }
      else if (l === 'cur') { setCurrents(on); said.push('currents'); }
      else if (l === 'ais') { S.settings.aisShow = on; saveSettings(); updateAis(); renderAisBtn(); said.push('AIS ships'); }
      else if (l === 'sat') { S.settings.satOver = on; saveSettings(); applyChart(); said.push('satellite'); }
      else { setWxL(l, on); said.push(l === 'rain' ? 'rain radar' : l); }
    });
    closeSheet(); setTab('chart');
    return { say: (on ? 'Showing ' : 'Hiding ') + said.join(' and ') + '.', close: true };
  }
  return null;
}
/* the conversation */
function firstMateMessage(text) { FM.last = String(text || ''); const el = $('firstMateReply'); if (el) el.textContent = text; else if (text) toast(text, 5000); }
function fmSay(text) {
  if (!text || S.settings.mateVoice === false || !('speechSynthesis' in window)) return;
  const CW = { N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest' };
  text = String(text).replace(/[“”]/g, '').replace(/\b(\d+(?:\.\d+)?) kn\b/g, '$1 knots').replace(/\b(\d+(?:\.\d+)?) nm\b/g, '$1 nautical miles').replace(/\b(\d+(?:\.\d+)?) ft\b/g, '$1 feet').replace(/\b(\d+(?:\.\d+)?) m\b/g, '$1 meters').replace(/°T\b/g, ' degrees true').replace(/\b([NSEW]{1,3})\b/g, (k) => CW[k] || k);
  try { const u = new SpeechSynthesisUtterance(text.slice(0, 300)); u.rate = 0.97; u.lang = 'en-US'; const v = bestVoice(); if (v) { u.voice = v; u.lang = v.lang; } speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* no speech */ }
}
function fmReply(r) { if (!r || !r.say) return; firstMateMessage(r.say); if (!$('firstMateReply')) return; if (r.close) setTimeout(() => { if ($('firstMateReply')) closeSheet(); toast(r.say, 4500); }, 900); }
async function fmRelay(request) {
  const boat = S.fleet.active, view = FM.view; firstMateMessage('Thinking…');
  const send = sheet.querySelector('[data-fm="send"]'); if (send) send.disabled = true;
  try {
    await sbInit(); if (!SB.client) throw new Error('Set up Account and sign in first, so I can use the AI for that.');
    const { data } = await SB.client.auth.getSession(); if (!data.session) throw new Error('Sign in through Menu → Account so I can ask the AI about that.');
    const response = await fetch(S.settings.assistantUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token }, signal: AbortSignal.timeout(35000), body: JSON.stringify({ request, context: { assistantName: mateName(), boatName: S.settings.boatName, boatType: S.settings.boatType, hasGps: !!S.fix, destination: S.goto && S.goto.name || null, previousRequests: FM.history.slice(-3) } }) });
    const action = await response.json(); if (!response.ok) throw new Error(action.error || 'Assistant connection failed.');
    if (boat !== S.fleet.active || view !== FM.view || !$('firstMateReply')) return;
    FM.history.push(request); FM.history = FM.history.slice(-3);
    await firstMateExecute(action);
  } catch (e) { firstMateMessage(e.message || 'Assistant unavailable. No action taken.'); }
  finally { if (send && send.isConnected) send.disabled = false; }
}
async function askFirstMate(voice) {
  if (FM.busy) return; const inp = $('firstMateRequest'), request = ((inp && inp.value) || '').trim(); if (!request) return;
  FM.voiceTurn = voice === true || (!!FM.heard && FM.heard === request); FM.heard = null; FM.last = '';
  FM.busy = true; let handled = false;
  try { const r = await fmUnderstand(request); if (r) { if (r.say) fmReply(r); handled = true; } else handled = await fmLocal(request); }
  catch (e) { firstMateMessage('Something went wrong: ' + (e.message || e)); handled = true; } finally { FM.busy = false; }
  if (!handled && S.settings.assistantUrl) { FM.busy = true; try { await fmRelay(request); } finally { FM.busy = false; } handled = true; }
  if (!handled) firstMateMessage('I did not understand “' + request + '” yet. Try “take me home”, “show me the rain”, “what’s the wind”, “when is high tide”, “mark this spot”. Once the AI is connected I can take anything.');
  if (FM.voiceTurn && FM.last && !(window.speechSynthesis && speechSynthesis.speaking)) fmSay(FM.last);
}
function openFirstMate() {
  FM.view++; if (FM.recognition) FM.recognition.stop();
  if (!isWide() && S.tab !== 'chart') setTab('chart');
  const nm = mateName(), call = mateCall(), live = WAKE.on, R = window.SpeechRecognition || window.webkitSpeechRecognition;
  openSheet('<h3 class="fm-title"><i class="fm-badge">' + AI_ICON + '</i>' + esc(nm) + '</h3><p class="sub">Ask anything, the way you would ask crew: “' + esc(call) + ', take me home”, “show me the rain”, “what’s the wind”, “when is high tide”, “mark this spot”, “zoom out”.</p>' +
    '<div class="field"><label for="firstMateRequest">What do you need?</label><input id="firstMateRequest" type="text" maxlength="1000" placeholder="Ask by voice or type…" autocomplete="off" enterkeyhint="send"></div><div class="row-btns"><button class="btn" data-fm="listen">🎙 Talk</button><button class="btn primary" data-fm="send">Send</button></div>' +
    '<p id="firstMateReply" class="sub" role="status" aria-live="polite">' + (live ? 'Listening for “' + esc(call) + '”.' : 'Ready. Tap Talk and speak, or type and tap Send.') + '</p><div id="firstMateResults"></div>' +
    '<details class="fm-set"' + (S.settings.mateName ? '' : ' open') + '><summary>Name and hands-free</summary>' +
    '<div class="field"><label for="fmName">Your first mate’s name</label><div class="fm-namerow"><input id="fmName" type="text" maxlength="24" autocomplete="off" placeholder="First mate (for example Gilligan)" value="' + esc(S.settings.mateName || '') + '"><button class="btn small" data-mate="name">Save</button></div><small class="hint">This is the wake word. “Hey ' + esc(call) + '” and “First mate” work too.</small></div>' +
    '<div class="row-btns">' + (R ? '<button class="btn' + (live ? '' : ' primary') + '" data-mate="wake">' + (live ? 'Stop listening' : 'Start listening for “' + esc(call) + '”') + '</button>' : '') + '</div>' +
    '<label class="air-ok"><input type="checkbox" id="fmVoice"' + (S.settings.mateVoice !== false ? ' checked' : '') + '> Answer out loud when I talk to it</label>' +
    '<p class="hint fm-honest">' + (R ? 'Hands-free listening works only while Tideline is open on the screen and the screen stays on (Tideline keeps it awake while navigating). It stops if you switch apps or lock the screen. On iPhone and iPad, Safari needs one tap to turn the microphone on each time the app opens: tap Start listening or the sparkle button. Your browser turns speech into text; Apple or Google may process it.' : 'This browser cannot listen hands-free. Use Talk, or the microphone on your keyboard. On iPhone and iPad, open Tideline in Safari for hands-free listening.') + '</p></details>' +
    '<details><summary>AI connection</summary><div class="field"><label for="firstMateEndpoint">Assistant backend URL</label><input id="firstMateEndpoint" type="url" value="' + esc(S.settings.assistantUrl || '') + '" placeholder="https://tideline-first-mate.…workers.dev"></div><button class="btn small" data-fm="setup">Save connection</button><p class="hint">' + (S.settings.assistantUrl ? 'Connected: anything ' + esc(nm) + ' does not understand on its own goes to the AI. Sign in through Account.' : 'Not connected yet: ' + esc(nm) + ' understands everyday boating requests on the phone, with no signal needed. Once the AI backend is deployed, anything else goes to it. Never paste an AI API key here.') + '</p></details>' +
    '<p class="hint">Sending to the AI shares your words and limited boat context. This assistant works the app, not the boat.</p><button class="btn ghost" data-act="close">Close</button>');
}
function firstMateListen() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { firstMateMessage('Use the microphone on your keyboard to dictate into the box, then tap Send.'); $('firstMateRequest').focus(); return; }
  if (FM.recognition) { FM.recognition.stop(); return; }
  if (WAKE.rec) { WAKE.pause = true; try { WAKE.rec.stop(); } catch (e) { /* stopped */ } }
  const r = new Recognition(); FM.recognition = r; r.lang = navigator.language || 'en-US'; r.interimResults = false; r.continuous = false;
  firstMateMessage('Listening… Tap Talk again to stop.');
  r.onresult = (e) => { const said = e.results[0][0].transcript, cmd = fmWakeSplit(said) || said, input = $('firstMateRequest'); if (input) input.value = cmd; FM.heard = cmd; firstMateMessage('Heard: “' + said + '”'); setTimeout(() => askFirstMate(true), 250); };
  r.onerror = () => firstMateMessage('Could not hear you. Try again, or type your request.');
  r.onend = () => { FM.recognition = null; if (WAKE.pause) { WAKE.pause = false; WAKE.rec = null; if (S.settings.wakeOn) setTimeout(wakeStart, 300); } };
  try { r.start(); } catch (e) { FM.recognition = null; firstMateMessage('Microphone unavailable. Type, or use keyboard dictation.'); }
}
function wakeStart() {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition; if (!R) { toast('This browser cannot listen hands-free. Tap the sparkle and use Talk or the keyboard microphone.', 6000); S.settings.wakeOn = false; saveSettings(); return; }
  if (WAKE.rec || FM.recognition) return; const r = new R(); WAKE.rec = r; WAKE.on = true; r.lang = navigator.language || 'en-US'; r.continuous = true; r.interimResults = false;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue; const said = e.results[i][0].transcript.trim(), after = fmWakeSplit(said);
      let cmd = null; if (after != null) { if (!after) { WAKE.armedUntil = Date.now() + 8000; chime(); toast('Yes? Listening…', 2500); continue; } cmd = after; } else if (Date.now() < WAKE.armedUntil) cmd = said;
      if (cmd) { WAKE.armedUntil = 0; wakeRun(cmd); }
    }
  };
  r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { WAKE.on = false; wakeIndicator(); toast('The microphone is off. Tap the sparkle, then Start listening (Safari asks once each time Tideline opens).', 6000); fmWakeOnTap(); } };
  r.onend = () => { WAKE.rec = null; if (WAKE.pause) return; if (WAKE.on && S.settings.wakeOn) setTimeout(() => { if (S.settings.wakeOn && WAKE.on && !WAKE.rec && !FM.recognition) wakeStart(); }, 400); else wakeIndicator(); };
  try { r.start(); } catch (e) { WAKE.rec = null; WAKE.on = false; fmWakeOnTap(); }
  wakeIndicator();
}
// iOS Safari only starts the microphone from a tap: if hands-free is on but could not start, the next tap anywhere starts it
function fmWakeOnTap() {
  if (FM.tapArmed || !S.settings.wakeOn) return; FM.tapArmed = true;
  document.addEventListener('pointerup', () => { FM.tapArmed = false; if (S.settings.wakeOn && !WAKE.rec) wakeStart(); }, { once: true, capture: true });
}
async function wakeRun(cmd) {
  FM.heard = cmd; let r = null;
  try { r = await fmUnderstand(cmd); } catch (e) { r = null; }
  if (r) { FM.heard = null; if (r.say) { if ($('firstMateReply')) fmReply(r); else toast(r.say, 5000); if (!(window.speechSynthesis && speechSynthesis.speaking)) fmSay(r.say); } return; }
  if (!$('firstMateRequest')) openFirstMate(); const inp = $('firstMateRequest'); if (inp) inp.value = cmd; await askFirstMate(true);
}
function closeWelcome(tour) {
  if (tour && !(S.settings.uses && S.settings.uses.length)) { openUses(true); return; }
  if (tour && !S.settings.mateAsked && fmAskName()) return;
  const el = $('welcome'); if (el) el.hidden = true; store.set('welcomed', true); if (tour && !store.get('toured', false)) setTimeout(() => startTour(), 400);
}
function fmAskName() { // one simple, skippable onboarding question
  const el = $('welcome'), card = el && el.querySelector('.wl-card'); if (!card) return false;
  card.innerHTML = '<div class="wl-logo fm-badge">' + AI_ICON + '</div><h2>What’s your first mate’s name?</h2><p>Your first mate is the assistant behind the sparkle button. Give it a name, for example Gilligan, then just say “Gilligan, take me home” or “Gilligan, show me the rain”.</p>' +
    '<div class="wl-step"><label for="wlMate">Name</label><input id="wlMate" type="text" maxlength="24" autocomplete="off" placeholder="Gilligan"><button class="btn primary wl-go" data-wlmate="save">Save</button></div><button class="btn ghost" data-wlmate="skip">Skip, call it First mate</button>';
  el.hidden = false; setTimeout(() => { const i = $('wlMate'); if (i) i.focus(); }, 60); return true;
}
const fmCleanName = (v) => String(v || '').replace(/[^\p{L}\p{N}' .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-usesdone="1"]'); // after "What do you use Tideline for?", ask the name once
  if (d && !S.settings.mateAsked && fmAskName()) { e.stopImmediatePropagation(); e.preventDefault(); }
}, true);
document.addEventListener('click', (e) => {
  const w = e.target.closest('[data-wlmate]');
  if (w) { const v = w.dataset.wlmate === 'save' ? fmCleanName($('wlMate') && $('wlMate').value) : ''; if (v && !/^first mate$/i.test(v)) S.settings.mateName = v; S.settings.mateAsked = 1; saveSettings(); const el = $('welcome'); if (el) el.hidden = true; store.set('welcomed', true); if (!store.get('toured', false)) setTimeout(() => startTour(), 400); if (v) toast('Say “' + v + ', show me the weather”. Tap the sparkle to start.', 5000); return; }
  const b = e.target.closest('[data-mate]'); if (!b) return;
  if (b.dataset.mate === 'name') { const v = fmCleanName($('fmName').value); S.settings.mateName = /^first mate$/i.test(v) ? '' : v; S.settings.mateAsked = 1; saveSettings(); toast(v ? 'Your first mate is ' + v + '.' : 'Your first mate is called First mate.'); openFirstMate(); }
  if (b.dataset.mate === 'wake') { if (WAKE.on) { wakeStop(); toast('Stopped listening.'); } else { S.settings.wakeOn = true; saveSettings(); wakeStart(); if (WAKE.on) toast('Listening. Say “' + mateCall() + '” and then what you need.', 5000); } openFirstMate(); }
});
sheet.addEventListener('change', (e) => { if (e.target.id === 'fmVoice') { S.settings.mateVoice = e.target.checked; saveSettings(); } });
sheet.addEventListener('keydown', (e) => { if (e.target.id === 'fmName' && e.key === 'Enter') { e.preventDefault(); const b = sheet.querySelector('[data-mate="name"]'); if (b) b.click(); } });
(() => { const b = $('btnFM'); if (b) { b.title = 'First mate: ask anything'; b.dataset.tip = mateName() + ': ask anything, by voice or typing'; } })();

/* ---------- arrange buttons, tidy: a grid the size of a button plus the column gap, magnets to the other buttons' lines,
   and even spacing along a row or column, so nothing needs lining up by hand ---------- */
// where a button really is, ignoring the arrange-mode wiggle (a rotation that makes getBoundingClientRect a pixel or two off)
function arrBox(el) {
  let x = 0, y = 0, o = el; while (o) { x += o.offsetLeft; y += o.offsetTop; o = o.offsetParent; }
  const w = el.offsetWidth, h = el.offsetHeight; return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
}
function arrGrid() {
  const col = $('fabs'), first = col && fabItems(col).find((x) => x.offsetWidth), cr = col && arrBox(col);
  const sz = first ? first.offsetWidth : 40, gap = (col && parseFloat(getComputedStyle(col).rowGap)) || 6;
  const tb = ($('tabbar') || document.querySelector('.tabbar')).getBoundingClientRect().top;
  return { sz, gap, p: sz + gap, x0: cr && cr.width ? cr.left : 12, y0: cr && cr.height ? cr.top : 56, xr: innerWidth - 12, yb: tb - 12, tb };
}
const arrFree = () => [...document.querySelectorAll('#app > .fab-free[id]')].filter((x) => !ARR_SKIP.has(x.id) && x.offsetWidth);
function arrSnap(x, y, w, h, self, tb) {
  const G = arrGrid(); tb = tb || G.tb;
  x = Math.max(6, Math.min(innerWidth - w - 6, x)); y = Math.max(6, Math.min(tb - h - 6, y));
  // columns count in from the left button column; right by the right edge they count from the right column instead, so a
  // button can sit in line with either; rows count down from the top of the columns
  const gx = x + w < G.xr - G.p * 1.5 ? G.x0 + Math.round((x - G.x0) / G.p) * G.p : G.xr - w - Math.round((G.xr - w - x) / G.p) * G.p;
  let nx = gx, ny = G.y0 + Math.round((y - G.y0) / G.p) * G.p, bx = 14, by = 14;
  // a neighbour's centre or edge line nearby wins over the grid, so odd-sized things (the speed circle) still line up
  document.querySelectorAll('#fabs > [id], #fabsR > [id], #app > .fab-free[id]').forEach((o) => {
    if (o === self || ARR_SKIP.has(o.id) || !o.offsetWidth || o.classList.contains('arr-drag')) return; const q = arrBox(o);
    [q.left + q.width / 2 - w / 2, q.left, q.right - w].forEach((v) => { const dd = Math.abs(v - x); if (dd < bx) { bx = dd; nx = v; } });
    [q.top + q.height / 2 - h / 2, q.top, q.bottom - h].forEach((v) => { const dd = Math.abs(v - y); if (dd < by) { by = dd; ny = v; } });
  });
  nx = Math.max(6, Math.min(innerWidth - w - 6, nx)); ny = Math.max(6, Math.min(tb - h - 6, ny));
  return { x: Math.round(nx), y: Math.round(ny) };
}
function arrPreview(d) {
  let g = $('arrSnap'), grid = $('arrGrid');
  if (!d) { if (g) g.hidden = true; if (grid) grid.hidden = true; return; }
  if (!g) { g = document.createElement('div'); g.id = 'arrSnap'; g.className = 'arr-snap'; document.body.appendChild(g); }
  if (!grid) { grid = document.createElement('div'); grid.id = 'arrGrid'; grid.className = 'arr-grid'; document.body.appendChild(grid); }
  const r = { left: parseFloat(d.el.style.left) || 0, top: parseFloat(d.el.style.top) || 0, width: d.el.offsetWidth, height: d.el.offsetHeight }, s = arrSnap(r.left, r.top, r.width, r.height, d.el), G = arrGrid();
  Object.assign(g.style, { left: s.x + 'px', top: s.y + 'px', width: r.width + 'px', height: r.height + 'px' }); g.hidden = false;
  grid.style.setProperty('--p', G.p + 'px'); grid.style.bottom = Math.max(0, innerHeight - G.tb) + 'px'; grid.style.backgroundPosition = (G.x0 + (G.sz - G.p) / 2) + 'px ' + (G.y0 + (G.sz - G.p) / 2) + 'px'; grid.hidden = false;
}
// lay a line of buttons out with the same gap between each; the button nearest the screen edge (not the one just dropped) stays put
function arrPack(items, axis, keep) {
  if (items.length < 2) return; const G = arrGrid(), horiz = axis === 'x', lim = horiz ? innerWidth - 6 : G.tb - 6;
  const R = items.map((el) => ({ el, r: arrBox(el) })).sort((a, b) => horiz ? a.r.left - b.r.left : a.r.top - b.r.top);
  const size = (q) => horiz ? q.r.width : q.r.height, start = (q) => horiz ? q.r.left : q.r.top;
  const idx = R.map((q, i) => i).filter((i) => R[i].el !== keep), f = idx[0], l = idx[idx.length - 1];
  const a = start(R[f]) <= lim - (start(R[l]) + size(R[l])) ? f : l, pos = [];
  pos[a] = start(R[a]); for (let i = a + 1; i < R.length; i++) pos[i] = pos[i - 1] + size(R[i - 1]) + G.gap; for (let i = a - 1; i >= 0; i--) pos[i] = pos[i + 1] - G.gap - size(R[i]);
  const lo = Math.min(...pos), hi = Math.max(...pos.map((v, i) => v + size(R[i]))), shift = lo < 6 ? 6 - lo : hi > lim ? lim - hi : 0;
  R.forEach((q, i) => { q.el.style[horiz ? 'left' : 'top'] = Math.round(pos[i] + shift) + 'px'; });
}
// the buttons that share a line with el (centres within 4 px) and sit close together (no more than one empty space between)
function arrLine(el, axis, all) {
  const horiz = axis === 'x', c = (q) => horiz ? q.top + q.height / 2 : q.left + q.width / 2, s = (q) => horiz ? q.left : q.top, e = (q) => horiz ? q.right : q.bottom;
  const r0 = arrBox(el), G = arrGrid(), line = all.map((o) => ({ o, q: arrBox(o) })).filter((x) => Math.abs(c(x.q) - c(r0)) < 4).sort((a, b) => s(a.q) - s(b.q));
  const i0 = line.findIndex((x) => x.o === el); if (i0 < 0) return [el]; let a = i0, b = i0;
  while (a > 0 && s(line[a].q) - e(line[a - 1].q) <= G.p + G.gap + 2) a--;
  while (b < line.length - 1 && s(line[b + 1].q) - e(line[b].q) <= G.p + G.gap + 2) b++;
  return line.slice(a, b + 1).map((x) => x.o);
}
function arrEven(el) {
  const all = arrFree(); if (!el || !all.includes(el)) return;
  const row = arrLine(el, 'x', all), col = arrLine(el, 'y', all);
  if (row.length > 1) arrPack(row, 'x', el); if (col.length > 1) arrPack(col, 'y', el);
}
function arrTidy() { // every free button onto the grid, nothing stacked, even gaps along each row and column
  const G = arrGrid(), all = arrFree(), taken = [];
  const hit = (x, y, w, h) => taken.some((t) => x < t.x + t.w - 2 && x + w > t.x + 2 && y < t.y + t.h - 2 && y + h > t.y + 2);
  document.querySelectorAll('#fabs > [id], #fabsR > [id]').forEach((o) => { if (!o.offsetWidth || ARR_SKIP.has(o.id)) return; const q = arrBox(o); taken.push({ x: q.left, y: q.top, w: q.width, h: q.height }); });
  all.sort((a, b) => arrBox(a).top - arrBox(b).top || arrBox(a).left - arrBox(b).left).forEach((el) => {
    const q = arrBox(el); let { x, y } = arrSnap(q.left, q.top, q.width, q.height, el); let k = 0;
    while (hit(x, y, q.width, q.height) && k++ < 40) { x += (x + q.width / 2 > innerWidth / 2 ? -1 : 1) * G.p; if (x < 6 || x + q.width > innerWidth - 6) { x = Math.max(6, Math.min(innerWidth - q.width - 6, q.left)); y += G.p; } }
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(Math.min(y, G.tb - q.height - 6)) + 'px'; taken.push({ x, y, w: q.width, h: q.height });
  });
  const done = new Set(); all.forEach((el) => { if (done.has(el)) return; const row = arrLine(el, 'x', all); row.forEach((x) => done.add(x)); if (row.length > 1) arrPack(row, 'x'); });
  done.clear(); all.forEach((el) => { if (done.has(el)) return; const col = arrLine(el, 'y', all); col.forEach((x) => done.add(x)); if (col.length > 1) arrPack(col, 'y'); });
  saveFabLayout(); toast(all.length ? 'Tidied: on the grid, evenly spaced.' : 'Everything is already in its column.', 2200);
}
/* ---------- AIS ship markers and the ship detail sheet ---------- */
// Category by AIS ship type code (or our coarse type), coloured roughly like MarineTraffic: cargo green, tanker red, passenger blue,
// tug and special craft cyan, fishing salmon, pleasure and sail magenta, unknown grey.
const SHIP_CAT = {
  cargo: ['#3FA35A', 'Cargo ship'], tanker: ['#D2504A', 'Tanker'], passenger: ['#3F7FD9', 'Passenger vessel'], tug: ['#1FB5C4', 'Tug or special craft'],
  fishing: ['#E8836B', 'Fishing vessel'], pleasure: ['#C04FC6', 'Pleasure craft'], unknown: ['#8A97A3', 'Vessel'],
};
function shipCat(t) {
  const c = +t.typeCode || 0;
  if (c >= 70 && c < 80) return 'cargo'; if (c >= 80 && c < 90) return 'tanker'; if ((c >= 60 && c < 70) || (c >= 40 && c < 50)) return 'passenger';
  if (c === 30) return 'fishing'; if (c === 36 || c === 37) return 'pleasure'; if ((c >= 31 && c <= 35) || (c >= 50 && c < 60)) return 'tug';
  return { ship: 'cargo', tug: 'tug', passenger: 'passenger', fishing: 'fishing', sail: 'pleasure', power: 'pleasure' }[t.type] || 'unknown';
}
function shipTypeText(t) {
  const c = +t.typeCode || 0, d = c % 10, haz = d >= 1 && d <= 4 ? ' (hazardous cargo, category ' + 'ABCD'[d - 1] + ')' : '';
  const fixed = { 30: 'Fishing vessel', 31: 'Towing vessel', 32: 'Towing vessel (long or wide tow)', 33: 'Dredging or underwater work', 34: 'Diving operations', 35: 'Military operations', 36: 'Sailing vessel', 37: 'Pleasure craft', 50: 'Pilot boat', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution vessel', 55: 'Law enforcement', 58: 'Medical transport', 59: 'Non-combatant ship' };
  if (fixed[c]) return fixed[c];
  if (c >= 20 && c < 30) return 'Wing-in-ground craft'; if (c >= 40 && c < 50) return 'High-speed craft' + haz;
  if (c >= 60 && c < 70) return 'Passenger vessel' + haz; if (c >= 70 && c < 80) return 'Cargo ship' + haz; if (c >= 80 && c < 90) return 'Tanker' + haz;
  if (c >= 90 && c < 100) return 'Other type' + haz;
  return { ship: 'Ship', tug: 'Tug', passenger: 'Passenger vessel', fishing: 'Fishing vessel', sail: 'Sailing vessel', power: 'Power vessel' }[t.type] || 'Vessel (type not broadcast)';
}
const SHIP_STATUS = { 0: 'Under way using engine', 1: 'At anchor', 2: 'Not under command', 3: 'Restricted in ability to maneuver', 4: 'Constrained by its draft', 5: 'Moored', 6: 'Aground', 7: 'Engaged in fishing', 8: 'Under way sailing', 14: 'AIS-SART (emergency)' };
// Flag from the MMSI's first three digits (MID, ITU list), compact: digits + ISO country code
const MID = {};
('201AL202AD203AT204PT205BE206BY207BG208VA209CY210CY211DE212CY213GE214MD215MT216AM218DE219DK220DK224ES225ES226FR227FR228FR229MT230FI231FO232GB233GB234GB235GB236GI237GR238HR239GR240GR241GR242MA243HU244NL245NL246NL247IT248MT249MT250IE251IS252LI253LU254MC255PT256MT257NO258NO259NO261PL262ME263PT264RO265SE266SE267SK268SM269CH270CZ271TR272UA273RU274MK275LV276EE277LT278SI279RS' +
 '301AI303US304AG305AG306CW307AW308BS309BS310BM311BS312BZ314BB316CA319KY321CR323CU325DM327DO329GP330GD331GL332GT334HN336HT338US339JM341KN343LC345MX347MQ348MS350NI351PA352PA353PA354PA355PA356PA357PA358PR359SV361PM362TT364TC366US367US368US369US370PA371PA372PA373PA374PA375VC376VC377VC378VG379VI' +
 '401AF403SA405BD408BH410BT412CN413CN414CN416TW417LK419IN422IR423AZ425IQ428IL431JP432JP434TM436KZ437UZ438JO440KR441KR443PS445KP447KW450LB451KG453MO455MV457MN459NP461OM463PK466QA468SY470AE471AE472TJ473YE475YE477HK478BA' +
 '503AU506MM508BN510FM511PW512NZ514KH515KH516CX518CK520FJ523CC525ID529KI531LA533MY536MP538MH540NC542NU544NR546PF548PH553PG555PN557SB559AS561WS563SG564SG565SG566SG567TH570TO572TV574VN576VU577VU578WF' +
 '601ZA603AO605DZ609BI610BJ611BW612CF613CM615CG616KM617CV619CI620KM621DJ622EG624ET625ER626GA627GH629GM630GW631GQ632GN633BF634KE636LR637LR638SS642LY644LS645MU647MG649ML650MZ654MR655MW656NE657NG659NA660RE661RW662SD663SN664SC665SH666SO667SL668ST669SZ670TD671TG672TN674TZ675UG676CD677TZ678ZM679ZW' +
 '701AR710BR720BO725CL730CO735EC740FK745GF750GY755PY760PE765SR770UY775VE').replace(/(\d{3})([A-Z]{2})/g, (m, n, c) => { MID[n] = c; return ''; });
let regionNames = null; try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { /* older browser: show the code */ }
function shipFlag(mmsi) {
  let m = String(mmsi || ''); if (!/^\d{9}$/.test(m)) return null;
  if (/^00/.test(m)) return { note: 'Coast station' }; if (/^111/.test(m)) return { note: 'Search and rescue aircraft' }; if (/^97/.test(m)) return { note: 'Emergency beacon (SART, MOB or EPIRB)' };
  if (/^9[89]/.test(m)) m = m.slice(2); else if (/^8/.test(m)) m = m.slice(1); else if (/^0/.test(m)) m = m.slice(1);
  const cc = MID[m.slice(0, 3)]; if (!cc) return null;
  let name = cc; try { name = regionNames ? regionNames.of(cc) : cc; } catch (e) { /* keep code */ }
  return { cc, name, emoji: String.fromCodePoint(...[...cc].map((ch) => 127397 + ch.charCodeAt(0))) };
}
function aisEtaText(e) {
  if (!e || !e.Month || !e.Day || e.Month > 12 || e.Day > 31) return '';
  const mon = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[e.Month - 1], hm = e.Hour != null && e.Hour < 24 ? ' ' + String(e.Hour).padStart(2, '0') + ':' + String(e.Minute != null && e.Minute < 60 ? e.Minute : 0).padStart(2, '0') + ' UTC' : '';
  return mon + ' ' + e.Day + hm;
}
const shipHeading = (t) => (t.hdg != null && t.hdg >= 0 && t.hdg < 360 ? t.hdg : (t.sog || 0) >= 0.5 && t.cog != null ? t.cog : null);
// Size by length (small craft small, 200 m freighters big), growing with zoom; once the true size on the chart is bigger, draw to scale.
function aisShipIcon(t, level) {
  const cat = shipCat(t), fill = SHIP_CAT[cat][0], z = map.getZoom(), hdg = shipHeading(t), alert = level === 'danger' || level === 'caution';
  const age = Date.now() - (t.seen || Date.now()), op = age > 30 * 60000 ? 0.45 : age > 10 * 60000 ? 0.7 : 1;
  const ring = level === 'danger' ? '#D64545' : level === 'caution' ? '#E8952B' : null, sel = S.aisFollow === t.id;
  const still = t.status === 1 || t.status === 5 || hdg == null;
  if (false) { // (old: anchored ships as circles; Andy wants every ship drawn as a ship, bow and stern visible)
    const d = Math.round((t.len || 0) >= 100 ? 13 : (t.len || 0) >= 30 ? 11 : 9), box = 44;
    return L.divIcon({ className: 'ais-icon ais-ship', iconSize: [box, box], iconAnchor: [box / 2, box / 2], labelDx: Math.round(d / 2 + 5), html: '<svg width="' + box + '" height="' + box + '" viewBox="0 0 ' + box + ' ' + box + '" style="opacity:' + op + '"><circle cx="22" cy="22" r="' + (d / 2) + '" fill="' + fill + '" class="ais-hull"' + (sel ? ' stroke="#fff" stroke-width="2.5"' : '') + '/></svg>' });
  }
  const len = t.len || (cat === 'cargo' || cat === 'tanker' ? 150 : cat === 'passenger' ? 60 : cat === 'tug' ? 30 : 12);
  let px = len < 15 ? 15 : len < 40 ? 18 : len < 90 ? 22 : len < 180 ? 27 : len < 260 ? 32 : 36;
  px *= z <= 9 ? 0.7 : z <= 11 ? 0.82 : z <= 13 ? 1 : 1.12;
  const mpp = 156543.03 * Math.cos((t.lat || 0) * Math.PI / 180) / Math.pow(2, z), real = len / mpp;
  px = Math.min(180, Math.max(px, real));
  const ratio = t.beam && t.len ? Math.min(0.45, Math.max(0.24, t.beam / t.len)) : cat === 'pleasure' ? 0.4 : 0.3;
  const w = Math.max(7, px * ratio * (px < 30 ? 1.25 : 1)), h = px / 2, hw = w / 2, box = Math.ceil(Math.max(44, px + 10));
  // pointed bow up, square stern: rotated to the heading (true), plus how far the chart is turned in course-up
  const path = 'M0 ' + (-h).toFixed(1) + ' C' + (hw * 0.7).toFixed(1) + ' ' + (-h * 0.62).toFixed(1) + ' ' + hw.toFixed(1) + ' ' + (-h * 0.3).toFixed(1) + ' ' + hw.toFixed(1) + ' ' + (-h * 0.05).toFixed(1) +
    ' L' + hw.toFixed(1) + ' ' + h.toFixed(1) + ' L' + (-hw).toFixed(1) + ' ' + h.toFixed(1) + ' L' + (-hw).toFixed(1) + ' ' + (-h * 0.05).toFixed(1) + ' C' + (-hw).toFixed(1) + ' ' + (-h * 0.3).toFixed(1) + ' ' + (-hw * 0.7).toFixed(1) + ' ' + (-h * 0.62).toFixed(1) + ' 0 ' + (-h).toFixed(1) + 'Z';
  const rot = ((hdg == null ? (t.cog != null && t.cog < 360 ? t.cog : 0) : hdg) + mapRot()) % 360, c = box / 2;
  const vec = (t.sog || 0) >= 2 && z >= 13 ? '<line x1="0" y1="' + (-h - 2).toFixed(1) + '" x2="0" y2="' + (-h - 2 - Math.min(10, 2 + t.sog * 0.5)).toFixed(1) + '" class="ais-vec"/>' : ''; // short speed leader off the bow
  const rr = rot * Math.PI / 180, dx = Math.abs(h * Math.sin(rr)) + Math.abs(hw * Math.cos(rr)); // how far the hull reaches to the right, so the name sits beside it
  return L.divIcon({ className: 'ais-icon ais-ship', iconSize: [box, box], iconAnchor: [c, c], labelDx: Math.round(dx + 5), html: '<svg width="' + box + '" height="' + box + '" viewBox="0 0 ' + box + ' ' + box + '" style="opacity:' + op + '"><g transform="translate(' + c + ' ' + c + ') rotate(' + rot.toFixed(1) + ')">' + vec +
    (ring || sel ? '<path d="' + path + '" fill="none" stroke="' + (ring || '#fff') + '" stroke-width="5" stroke-linejoin="round" opacity=".9"/>' : '') + '<path d="' + path + '" fill="' + fill + '" class="ais-hull"/></g></svg>' });
}
function shipAgo(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; }
function shipSheetTop(t) {
  const cat = shipCat(t), fl = shipFlag(t.mmsi), mmsi = t.mmsi && /^\d{9}$/.test(String(t.mmsi)) ? String(t.mmsi) : null, hdg = shipHeading(t);
  const ft = (m) => Math.round(m * 3.281);
  const status = SHIP_STATUS[t.status] || '';
  let h = '<div class="ship-hd"><span class="ship-sw" style="--c:' + SHIP_CAT[cat][0] + '"></span><div><h3>' + esc(t.name || 'AIS target') + '</h3><div class="sub">' + esc(shipTypeText(t)) +
    (fl ? ' · ' + (fl.emoji ? fl.emoji + ' ' : '') + esc(fl.name || fl.note) : '') + (t.demo ? ' · demo target' : '') + '</div></div></div>';
  h += '<div class="ship-wiki" id="shipWiki" data-id="' + esc(t.id) + '" hidden></div>';
  const go = t.dest ? '<div class="ship-dest"><span class="lbl">BOUND FOR</span><b>' + esc(t.dest) + '</b>' + (t.eta ? '<span>ETA ' + esc(t.eta) + '</span>' : '') + '</div>' : '';
  h += go;
  const facts = [
    ['Speed', t.sog != null ? fmtSpeed(t.sog) + ' ' + (SPEED_LBL[S.settings.speedUnit] || 'kn') : ''],
    ['Course', t.cog != null && (t.sog || 0) >= 0.5 ? fmtBrg(t.cog) + '°T' : ''], ['Heading', hdg != null && t.hdg != null ? fmtBrg(t.hdg) + '°T' : ''],
    ['Status', status], ['Size', t.len ? Math.round(t.len) + ' × ' + (t.beam ? Math.round(t.beam) : '?') + ' m (' + ft(t.len) + ' × ' + (t.beam ? ft(t.beam) : '?') + ' ft)' : ''],
    ['Draft', t.draft ? t.draft + ' m (' + ft(t.draft) + ' ft)' : ''],
    ['Distance', S.fix && Number.isFinite(t.lat) ? fmtDist(distNm(S.fix, t)) + ' at ' + fmtBrg(bearing(S.fix, t)) + '°T' : ''],
    ['Call sign', t.callsign], ['IMO', t.imo ? String(t.imo) : ''], ['MMSI', mmsi || t.mmsi],
    ['Last seen', t.seen ? shipAgo(Date.now() - t.seen) + (t.cached ? ' (saved)' : '') : ''],
  ].filter((x) => x[1]);
  h += '<div class="facts ship-facts">' + facts.map((f) => '<span>' + esc(f[0]) + '</span><span>' + esc(f[1]) + '</span>').join('') + '</div>';
  h += '<div class="row-btns ship-btns"><button class="btn small primary" data-act="aisfollow" data-id="' + esc(t.id) + '">' + (S.aisFollow === t.id ? 'Stop following' : 'Follow on chart') + '</button>' +
    (mmsi ? '<a class="btn small" href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:' + mmsi + '" target="_blank" rel="noopener">MarineTraffic</a><a class="btn small" href="https://www.vesselfinder.com/vessels/details/' + mmsi + '" target="_blank" rel="noopener">VesselFinder</a>' : '') + '</div>';
  h += '<p class="hint ship-note">AIS carries name, type, size, draft and destination as the crew entered them. Owner, tonnage, cargo details and photos are not broadcast' + (mmsi ? '; MarineTraffic and VesselFinder list them' : '') + '.</p>';
  return h;
}
// Wikipedia: only when a page title matches the ship's name and the page clearly describes a vessel
const WIKI = { mem: store.get('aisCacheWiki', {}) || {} }; // the aisCache prefix keeps it out of sync
const WIKI_SHIP = /\b(ship|vessel|tug(boat)?|ferry|tanker|freighter|cargo|carrier|bulker|schooner|steamboat|steamship|yacht|ketch|skipjack|dredger?|barge|icebreaker|liner|cutter|frigate|destroyer|trawler|lightship|research vessel|container)\b/i;
const wikiNorm = (s) => String(s || '').toUpperCase().replace(/\(.*?\)/g, '').replace(/^(MV|M\/V|MS|M\/S|SS|S\/S|USNS|USS|USCGC|RV|R\/V|NOAAS|MT|M\/T|TS|HMS|SV)\s+/, '').replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
async function shipWiki(t) {
  const name = wikiNorm(t.name); if (!name || name.length < 3 || /^MMSI/.test(name) || t.demo) return;
  let hit = WIKI.mem[name];
  if (hit === undefined) {
    hit = null;
    try {
      const q = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=5&srsearch=' + encodeURIComponent('"' + t.name.trim() + '" ship');
      const sr = await (await fetch(q)).json(), cands = ((sr.query || {}).search || []).filter((x) => wikiNorm(x.title) === name).slice(0, 3);
      for (const c of cands) {
        const sm = await (await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(c.title.replace(/ /g, '_')))).json();
        if (sm && sm.type !== 'disambiguation' && WIKI_SHIP.test((sm.description || '') + ' ' + (sm.extract || '').slice(0, 240))) {
          hit = { title: sm.title, desc: sm.description || '', text: (sm.extract || '').slice(0, 420), img: (sm.thumbnail || {}).source || '', url: ((sm.content_urls || {}).mobile || (sm.content_urls || {}).desktop || {}).page || '' }; break;
        }
      }
      WIKI.mem[name] = hit; const keys = Object.keys(WIKI.mem); if (keys.length > 300) delete WIKI.mem[keys[0]]; store.set('aisCacheWiki', WIKI.mem);
    } catch (e) { return; } // offline: try again next time
  }
  const el = $('shipWiki'); if (!hit || !el || el.dataset.id !== t.id) return;
  el.innerHTML = (hit.img ? '<img src="' + esc(hit.img) + '" alt="" loading="lazy">' : '') + '<div><b>' + esc(hit.title) + '</b>' + (hit.desc ? '<small>' + esc(hit.desc) + '</small>' : '') + '<p>' + esc(hit.text) + '</p>' +
    (hit.url ? '<a href="' + esc(hit.url) + '" target="_blank" rel="noopener">Wikipedia</a> <small>· matched by name; check it is this ship</small>' : '') + '</div>';
  el.hidden = false;
}
function aisFollowTick() {
  const t = ais.get(S.aisFollow); if (!t || !Number.isFinite(t.lat)) { S.aisFollow = null; return; }
  const p = map.latLngToContainerPoint([t.lat, t.lon]), sz = map.getSize();
  if (Math.abs(p.x - sz.x / 2) > sz.x * 0.2 || Math.abs(p.y - sz.y / 2) > sz.y * 0.2) map.panTo([t.lat, t.lon], { animate: true, duration: 0.5 });
}
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="aisfollow"]'); if (!b) return;
  const t = ais.get(b.dataset.id); if (!t) return;
  if (S.aisFollow === t.id) { S.aisFollow = null; updateAis(); toast('Stopped following ' + (t.name || 'the ship')); closeSheet(); return; }
  S.aisFollow = t.id; setFollow(false); closeSheet(); map.setView([t.lat, t.lon], Math.max(map.getZoom(), 13)); updateAis();
  toast('Following ' + (t.name || 'the ship') + '. Drag the chart to stop.', 3500);
});
map.on('dragstart', () => { if (S.aisFollow) { S.aisFollow = null; try { updateAis(); } catch (e) { /* later */ } } });

/* ---------- buttons in the gauge look: all of them (Gauge look → Buttons: Match this look) or one at a time (arrange, tap a button) ---------- */
function applyFabLook() {
  document.documentElement.dataset.fablook = S.settings.fabLook || 'theme';
  const each = S.settings.fabEach || {};
  document.querySelectorAll('.fab[id], .mini-depth[id]').forEach((el) => {
    const id = each[el.id]; if (!id) { delete el.dataset.gl; ['--bt-f1', '--bt-f2', '--bt-ink', '--bt-c1', '--bt-c2', '--bt-c3', '--bt-c4', '--bt-c5'].forEach((k) => el.style.removeProperty(k)); return; }
    const t = gtOf(id); el.dataset.gl = t.id; el.style.setProperty('--bt-f1', t.fc[0]); el.style.setProperty('--bt-f2', t.fc[1]); el.style.setProperty('--bt-ink', t.ink); t.bz.forEach((v, i) => el.style.setProperty('--bt-c' + (i + 1), v));
  });
}
function openFabLookFor(el) {
  const each = S.settings.fabEach || {}, cur = each[el.id] || '', name = el.getAttribute('aria-label') || el.dataset.tip || 'This button';
  openSheet('<h3>Look for this button</h3><div class="sub">' + esc(name.replace(/[:,].*$/, '')) + '</div><div class="btheme-row gl-row"><button type="button" data-fabone="" class="' + (cur ? '' : 'on') + '"><i class="gl-prev gl-same">=</i>Same as the others</button>' +
    GT.map((t) => '<button type="button" data-fabone="' + t.id + '" class="' + (cur === t.id ? 'on' : '') + '">' + glPrev(t.id) + t.l + '</button>').join('') + '</div>' +
    '<div class="row-btns"><button class="btn" data-faball="' + (cur || '') + '">Use it for every button</button><button class="btn primary" data-act="close">Done</button></div>');
  S.fabFor = el.id;
}
sheet.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fabone]'); if (b && S.fabFor) { const each = S.settings.fabEach || (S.settings.fabEach = {}); if (b.dataset.fabone) each[S.fabFor] = b.dataset.fabone; else delete each[S.fabFor]; saveSettings(); applyFabLook(); sheet.querySelectorAll('button[data-fabone]').forEach((x) => x.classList.toggle('on', x === b)); const all = sheet.querySelector('[data-faball]'); if (all) all.dataset.faball = b.dataset.fabone; return; }
  const a = e.target.closest('button[data-faball]'); if (a) { const id = a.dataset.faball; S.settings.fabEach = {}; if (id) { S.settings.gTheme = id; applyGTheme(); S.settings.fabLook = 'gauge'; } else S.settings.fabLook = 'theme'; saveSettings(); applyFabLook(); closeSheet(); toast(id ? 'Every button and the gauges now use ' + gtOf(id).l + '.' : 'Buttons back to their own colors.'); }
});
if (S.settings.fabLookSeeded === 1 && S.settings.fabLook === 'gauge') { S.settings.fabLook = 'app'; S.settings.fabLookSeeded = 2; saveSettings(); } // Andy: the look themes the whole app
if (!S.settings.fabLookSeeded) { S.settings.fabLook = S.settings.fabLook || 'app'; if (!S.settings.fabLook) S.settings.fabLook = 'gauge'; S.settings.fabLookSeeded = 1; saveSettings(); } // Andy: buttons and gauges in one look by default
setTimeout(applyFabLook, 350);
/* ---------- move a whole row or column of buttons at once: grab its ⠿ handle; tap the handle to turn a column into a row and back ---------- */
function arrGroupsNow() {
  const vis = (col) => col ? fabItems(col).filter((x) => x.offsetWidth) : [], out = [];
  [['L', $('fabs')], ['R', $('fabsR')]].forEach(([k, col]) => { const it = vis(col); if (it.length > 1) out.push({ key: k, els: it, axis: 'y' }); });
  const free = arrFree(), seen = new Set();
  free.forEach((el) => { if (seen.has(el)) return; for (const ax of ['x', 'y']) { const line = arrLine(el, ax, free); if (line.length > 1 && !line.some((x) => seen.has(x))) { line.forEach((x) => seen.add(x)); out.push({ key: 'f' + out.length, els: line, axis: ax }); break; } } });
  return out;
}
function arrGrips() {
  document.querySelectorAll('.arr-grip').forEach((g) => g.remove()); if (!ARR.on) return;
  ARR.groups = arrGroupsNow();
  ARR.groups.forEach((G, i) => {
    const r = G.els.map(arrBox), top = Math.min(...r.map((q) => q.top)), left = Math.min(...r.map((q) => q.left)), right = Math.max(...r.map((q) => q.right));
    const g = document.createElement('button'); g.type = 'button'; g.className = 'arr-grip'; g.dataset.g = i; g.textContent = '⠿'; g.setAttribute('aria-label', 'Move this whole ' + (G.axis === 'y' ? 'column' : 'row'));
    const bottom = Math.max(...r.map((q) => q.bottom)), w = 30, x = G.axis === 'y' ? (left + right) / 2 - w / 2 : (left - w - 6 < 4 ? right + 6 : left - w - 6), y = G.axis === 'y' ? bottom + 8 : top + (r[0].height - w) / 2;
    Object.assign(g.style, { left: Math.max(2, Math.min(innerWidth - w - 2, x)) + 'px', top: Math.max(2, y) + 'px' }); document.body.appendChild(g);
  });
}
(() => {
  let gd = null;
  document.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.arr-grip'); if (!g || !ARR.on) return; e.preventDefault(); e.stopPropagation();
    const G = ARR.groups[+g.dataset.g]; if (!G) return;
    gd = { G, g, x0: e.clientX, y0: e.clientY, moved: false, start: G.els.map((el) => { const q = arrBox(el); return { el, x: q.left, y: q.top }; }) };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!gd) return; e.preventDefault(); const dx = e.clientX - gd.x0, dy = e.clientY - gd.y0;
    if (!gd.moved && Math.hypot(dx, dy) < 8) return;
    if (!gd.moved) { gd.moved = true; gd.start.forEach((o) => { $('app').appendChild(o.el); o.el.classList.add('fab-free'); o.el.style.left = o.x + 'px'; o.el.style.top = o.y + 'px'; }); document.documentElement.classList.add('arr-dragging'); }
    gd.start.forEach((o) => { o.el.style.left = (o.x + dx) + 'px'; o.el.style.top = (o.y + dy) + 'px'; });
    gd.g.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }, { capture: true, passive: false });
  const up = () => {
    if (!gd) return; const d = gd; gd = null; document.documentElement.classList.remove('arr-dragging');
    if (!d.moved) { // tap: a column becomes a row (along the top, from where it starts) and a row becomes a column
      const first = d.start.reduce((a, o) => (d.G.axis === 'y' ? o.y < a.y : o.x < a.x) ? o : a), Gd = arrGrid(), horiz = d.G.axis === 'y';
      d.start.slice().sort((a, b) => horiz ? a.y - b.y : a.x - b.x).forEach((o, k) => { $('app').appendChild(o.el); o.el.classList.add('fab-free');
        let x = horiz ? first.x + k * Gd.p : first.x, y = horiz ? first.y : first.y + k * Gd.p;
        if (horiz && x + o.el.offsetWidth > innerWidth - 6) x = innerWidth - 6 - o.el.offsetWidth - (d.start.length - 1 - k) * Gd.p; o.el.style.left = Math.max(6, x) + 'px'; o.el.style.top = Math.max(6, Math.min(Gd.tb - o.el.offsetHeight - 6, y)) + 'px'; });
    } else { // snap the group as one: the first button snaps, the rest keep their spacing
      const f = d.start[0], q = arrBox(f.el), sn = arrSnap(q.left, q.top, q.width, q.height, f.el), sx = sn.x - q.left, sy = sn.y - q.top, Gd = arrGrid();
      d.start.forEach((o) => { const r = arrBox(o.el); o.el.style.left = Math.round(Math.max(6, Math.min(innerWidth - r.width - 6, r.left + sx))) + 'px'; o.el.style.top = Math.round(Math.max(6, Math.min(Gd.tb - r.height - 6, r.top + sy))) + 'px'; });
      if (d.start.length > 1) arrPack(d.start.map((o) => o.el), d.G.axis === 'y' ? 'y' : 'x');
    }
    saveFabLayout(); arrGrips();
  };
  document.addEventListener('pointerup', up, true); document.addEventListener('pointercancel', up, true);
  addEventListener('resize', () => { if (ARR.on) arrGrips(); });
})();
/* ---------- button layouts in one tap: down the sides (as shipped), the left column along the bottom, or everything along the bottom ---------- */
function fabPreset(kind) {
  if (kind === 'sides') { delete S.settings.fabLayout; saveSettings(); location.reload(); return; }
  if (S.tab !== 'chart') setTab('chart');
  const G = arrGrid(), mob = $('btnMOB'), mr = mob && mob.offsetWidth ? mob.getBoundingClientRect() : null;
  const rowOf = (els, y, x0) => { let x = x0, yy = y; els.forEach((el) => { const w = el.offsetWidth || G.sz; if (x + w > innerWidth - 8) { x = x0; yy -= G.p; } $('app').appendChild(el); el.classList.add('fab-free'); el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(yy - (el.offsetHeight || G.sz) + G.sz) + 'px'; x += w + G.gap; }); return yy; };
  const left = fabItems($('fabs')).filter((x) => x.offsetWidth), right = fabItems($('fabsR')).filter((x) => x.offsetWidth);
  const y1 = G.tb - G.sz - 10, x1 = mr ? mr.right + G.gap + 4 : 12;
  const yEnd = rowOf(left, y1, x1);
  if (kind === 'bottom2') rowOf(right.filter((el) => el.id !== 'btnInst' || true), yEnd - G.p, 12);
  saveFabLayout(); if (ARR.on) arrGrips();
  toast(kind === 'bottom2' ? 'All the buttons are along the bottom. Hold any button to fine-tune.' : 'The left buttons are along the bottom. Hold any button to fine-tune.', 3500);
}
sheet.addEventListener('click', (e) => { const b = e.target.closest('button[data-fabpre]'); if (!b) return; closeSheet(); setTimeout(() => fabPreset(b.dataset.fabpre), 80); });
window.Tideline = { S, map, ais, setTab, resetDemoAis: () => { ais.clear(); demoAisAt = 0; spoken.clear(); }, openAis: (id) => { const t = ais.get(id); if (t) openAisSheet(t); }, closeSheet, WS, AST, skyNotes, bridgeSchedule, routeByWater, waterLeg, waterGrid, WR, encLayerIds, encQuery, wrWhy, routeMode, drawRoute, hiloToHourly, routeLeg, RT, L }; // debugging and demo recording
})();
// MOB sits small in the bottom-left corner; on phones it rides just above the instrument card
(() => { const st = document.getElementById('bottomStack'); if (!st || !window.ResizeObserver) return; new ResizeObserver(() => { const h = st.getBoundingClientRect().height; document.documentElement.style.setProperty('--stackH', Math.round(h) + 'px'); }).observe(st); })();
