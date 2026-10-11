// Tideline AIS relay, with memory. Same as worker.js, plus a Durable Object that remembers the last position of every boat
// heard in the last 3 hours, so when someone opens the app they see moored and slow boats straight away instead of waiting
// for each one's next report (moored Class B boats only report every 3 minutes, and many are only heard now and then).
// Needs: secret AISSTREAM_KEY, and a Durable Object binding AIS_MEMORY -> class AisMemory (see wrangler.toml below).
//
// wrangler.toml:
//   name = "tideline-ais"
//   main = "worker-with-memory.js"
//   compatibility_date = "2025-09-01"
//   [[durable_objects.bindings]]
//   name = "AIS_MEMORY"
//   class_name = "AisMemory"
//   [[migrations]]
//   tag = "v1"
//   new_sqlite_classes = ["AisMemory"]
const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const box = (b) => [[[b[0], b[1]], [b[2], b[3]]]];
const KEEP_MS = 3 * 3600 * 1000;

export class AisMemory {
  constructor(state) { this.state = state; this.boats = null; }
  async load() { if (!this.boats) this.boats = (await this.state.storage.get('boats')) || {}; }
  async fetch(req) {
    await this.load(); const u = new URL(req.url), now = Date.now();
    if (req.method === 'POST') { // a batch of the latest messages from one connection
      const list = await req.json().catch(() => []);
      for (const m of list) { const k = String(m.MetaData && m.MetaData.MMSI); if (!k || k === 'undefined') continue; const prev = this.boats[k] || {}; prev[m.MessageType] = m; prev.t = now; this.boats[k] = prev; }
      for (const k of Object.keys(this.boats)) if (now - this.boats[k].t > KEEP_MS) delete this.boats[k];
      await this.state.storage.put('boats', this.boats); return new Response('ok');
    }
    const bb = (u.searchParams.get('bbox') || '').split(',').map(Number), out = [];
    for (const b of Object.values(this.boats)) {
      const pos = Object.keys(b).find((k) => /Position/.test(k)); if (!pos) continue; const md = b[pos].MetaData || {};
      const lat = md.latitude ?? md.Latitude, lon = md.longitude ?? md.Longitude;
      if (bb.length === 4 && !(lat >= bb[0] && lat <= bb[2] && lon >= bb[1] && lon <= bb[3])) continue;
      for (const k of Object.keys(b)) if (k !== 't') out.push(b[k]);
    }
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  }
}

export default {
  async fetch(req, env) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Tideline AIS relay is running.', { status: 200 });
    const origin = req.headers.get('Origin') || '', allowed = env.ALLOWED_ORIGIN || 'https://olbucky1.github.io';
    if (!allowed.split(',').some((o) => origin === o.trim())) return new Response('Not allowed', { status: 403 });
    if (!env.AISSTREAM_KEY) return new Response('AIS key not configured', { status: 503 });
    const bb = (new URL(req.url).searchParams.get('bbox') || '').split(',').map(Number);
    if (bb.length !== 4 || bb.some((v) => !Number.isFinite(v)) || bb[2] <= bb[0] || bb[3] <= bb[1] || Math.abs(bb[2] - bb[0]) > 3 || Math.abs(bb[3] - bb[1]) > 3) return new Response('Bad area', { status: 400 });
    const mem = env.AIS_MEMORY ? env.AIS_MEMORY.get(env.AIS_MEMORY.idFromName('chesapeake')) : null;
    const [client, server] = Object.values(new WebSocketPair()); server.accept();
    // 1) send what we remember for this area right away
    if (mem) { try { const old = await (await mem.fetch('https://mem/?bbox=' + bb.join(','))).json(); for (const m of old) server.send(JSON.stringify(m)); } catch (e) { /* memory not ready */ } }
    // 2) then stream live, and remember what we hear (in batches, every 20 s)
    const up = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } }); const ws = up.webSocket;
    if (!ws) { server.close(1011, 'aisstream unavailable'); return new Response(null, { status: 101, webSocket: client }); }
    ws.accept(); ws.send(JSON.stringify({ APIKey: env.AISSTREAM_KEY, BoundingBoxes: box(bb), FilterMessageTypes: TYPES }));
    let batch = []; const flush = () => { if (!mem || !batch.length) return; const b = batch; batch = []; mem.fetch('https://mem/', { method: 'POST', body: JSON.stringify(b) }).catch(() => {}); };
    const timer = setInterval(flush, 20000);
    ws.addEventListener('message', (e) => { try { server.send(e.data); } catch (err) { /* app went away */ } try { const m = JSON.parse(typeof e.data === 'string' ? e.data : ''); if (m && m.MetaData) batch.push(m); if (batch.length > 400) flush(); } catch (err) { /* binary */ } });
    const done = () => { clearInterval(timer); flush(); try { ws.close(); } catch (e) { /* closed */ } try { server.close(); } catch (e) { /* closed */ } };
    ws.addEventListener('close', done); server.addEventListener('close', done);
    server.addEventListener('message', async (e) => {
      try { const m = JSON.parse(e.data); if (Array.isArray(m.bbox) && m.bbox.length === 4) { ws.send(JSON.stringify({ APIKey: env.AISSTREAM_KEY, BoundingBoxes: box(m.bbox), FilterMessageTypes: TYPES }));
        if (mem) { const old = await (await mem.fetch('https://mem/?bbox=' + m.bbox.join(','))).json(); for (const x of old) server.send(JSON.stringify(x)); } } } catch (err) { /* ignore */ }
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
