// Tideline lightning relay (Cloudflare Worker). Keeps the provider key off the phone.
// GET /?lat=38.97&lon=-76.48&r=60  ->  { strikes: [{ lat, lon, t }] }  (t = epoch ms, last 30 minutes)
// Uses the Xweather (Vaisala) lightning API. Set secrets: XW_ID and XW_SECRET (wrangler secret put XW_ID).
export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'max-age=30' };
    const u = new URL(req.url), lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon'), r = Math.min(100, +u.searchParams.get('r') || 60);
    if (!isFinite(lat) || !isFinite(lon)) return new Response(JSON.stringify({ error: 'lat and lon needed' }), { status: 400, headers: cors });
    const api = 'https://data.api.xweather.com/lightning/closest?p=' + lat.toFixed(3) + ',' + lon.toFixed(3) + '&radius=' + Math.round(r * 1.15) + 'mi&limit=500&from=-30minutes&client_id=' + env.XW_ID + '&client_secret=' + env.XW_SECRET;
    try {
      const j = await (await fetch(api)).json();
      const strikes = (j.response || []).map((x) => ({ lat: x.loc && x.loc.lat, lon: x.loc && x.loc.long, t: (x.ob && x.ob.timestamp || 0) * 1000 })).filter((x) => isFinite(x.lat) && isFinite(x.lon) && x.t);
      return new Response(JSON.stringify({ strikes, src: 'Xweather/Vaisala' }), { headers: cors });
    } catch (e) { return new Response(JSON.stringify({ error: 'provider unreachable' }), { status: 502, headers: cors }); }
  }
};
