const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app.js', 'utf8');
const block = source.slice(source.indexOf('function aisUpsert(t)'), source.indexOf('/* demo AIS traffic:'));
let renders = 0, pending = [];
class Socket { constructor() { this.readyState = 1; } close() {} }
const context = {
  S: { settings: { aisRelay: 'wss://example.com', aisShow: true }, fix: null },
  ais: new Map(), WebSocket: Socket, refPos: () => ({ lat: 39, lon: -76 }),
  distNm: () => 0, map: { on() {} },
  setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout() {}, setInterval() {},
  updateAis: () => renders++
};
vm.createContext(context);
vm.runInContext(block + '\naissConnect(true); globalThis.feed = AISS;', context);
async function send(type, payload, metadata = {}) {
  await context.feed.ws.onmessage({ data: JSON.stringify({ MessageType: type, MetaData: { MMSI: 123456789, ShipName: 'TEST', ...metadata }, Message: { [type]: payload } }) });
}
(async () => {
  await send('PositionReport', { Latitude: 39, Longitude: -76, Sog: 4, Cog: 90 });
  assert.equal(context.ais.get('ais-123456789').lat, 39);
  context.ais.get('ais-123456789').seen = 100;
  await send('ShipStaticData', { CallSign: 'ABC' });
  assert.equal(context.ais.get('ais-123456789').seen, 100, 'static messages preserve position age');
  await send('PositionReport', { Latitude: 91, Longitude: 181 });
  assert.equal(context.ais.get('ais-123456789').lat, 39, 'invalid coordinates rejected');
  await send('StandardClassBPositionReport', { Sog: 3, Cog: 45 }, { Latitude: 38, Longitude: -75 });
  assert.equal(context.ais.get('ais-123456789').lat, 38, 'provider metadata supported');
  assert.equal(pending.length, 2, 'one startup timer and one render timer despite burst');
  pending[1](); assert.equal(renders, 1);
  await send('PositionReport', { Latitude: 39, Longitude: -76 });
  assert.equal(pending.length, 3, 'later report schedules another render');
  console.log('PASS: AIS coordinates, invalid positions, static freshness and continuous-stream rendering.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
