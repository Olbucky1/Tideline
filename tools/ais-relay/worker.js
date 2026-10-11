// Tideline AIS relay: a Cloudflare Worker that holds your aisstream.io key and passes live AIS to the Tideline web app.
// aisstream.io does not accept connections straight from a browser, so the app connects here instead.
// Secret needed: AISSTREAM_KEY (your aisstream.io API key). Optional: ALLOWED_ORIGIN (default https://olbucky1.github.io).
const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const box = (b) => [[[b[0], b[1]], [b[2], b[3]]]]; // [[south, west], [north, east]]
export default {
  async fetch(req, env) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Tideline AIS relay is running.', { status: 200 });
    const origin = req.headers.get('Origin') || '', allowed = env.ALLOWED_ORIGIN || 'https://olbucky1.github.io';
    if (origin && !allowed.split(',').some((o) => origin.startsWith(o.trim()))) return new Response('Not allowed', { status: 403 });
    const bb = (new URL(req.url).searchParams.get('bbox') || '').split(',').map(Number);
    if (bb.length !== 4 || bb.some((v) => !isFinite(v)) || Math.abs(bb[2] - bb[0]) > 3 || Math.abs(bb[3] - bb[1]) > 3) return new Response('Bad area', { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const up = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
    const ws = up.webSocket;
    if (!ws) { server.close(1011, 'aisstream unavailable'); return new Response(null, { status: 101, webSocket: client }); }
    ws.accept();
    ws.send(JSON.stringify({ APIKey: env.AISSTREAM_KEY, BoundingBoxes: box(bb), FilterMessageTypes: TYPES }));
    ws.addEventListener('message', (e) => { try { server.send(e.data); } catch (err) { /* app went away */ } });
    ws.addEventListener('close', () => { try { server.close(); } catch (err) { /* closed */ } });
    server.addEventListener('close', () => { try { ws.close(); } catch (err) { /* closed */ } });
    server.addEventListener('message', (e) => { // the app can send {"bbox":[s,w,n,e]} to follow the chart
      try { const m = JSON.parse(e.data); if (Array.isArray(m.bbox) && m.bbox.length === 4) ws.send(JSON.stringify({ APIKey: env.AISSTREAM_KEY, BoundingBoxes: box(m.bbox), FilterMessageTypes: TYPES })); } catch (err) { /* ignore */ }
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
