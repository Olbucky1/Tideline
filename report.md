# Live route check

Run 2026-10-11T20:50:18.860Z

## NOAA services
```
{
 "enc_coastal": {
  "layers": 177,
  "maxRecordCount": 1000,
  "depth": 166,
  "pagination": true,
  "fields": [
   "DRVAL1",
   "DRVAL2"
  ]
 },
 "enc_approach": {
  "layers": 245,
  "maxRecordCount": 1000,
  "depth": 232,
  "pagination": true,
  "fields": [
   "DRVAL1",
   "DRVAL2"
  ]
 },
 "enc_harbour": {
  "layers": 240,
  "maxRecordCount": 1000,
  "depth": 227,
  "pagination": true,
  "fields": [
   "DRVAL1",
   "DRVAL2"
  ]
 }
}
```

## Routes

- **SSA to St. Michaels**: ok, 31 turn points, 24.8 nm (straight 16.6 nm), 10 s, land polygons checked 139, **crosses land: YES at [{"leg":32,"lat":38.78755,"lon":-76.21894,"svc":"enc_coastal"}]**
- **SSA to Rock Hall**: ok, 13 turn points, 17.1 nm (straight 14.7 nm), 4 s, land polygons checked 114, **crosses land: YES at [{"leg":14,"lat":39.13316,"lon":-76.24191,"svc":"enc_harbour"}]**
- **Annapolis harbor to Thomas Point**: ok, 8 turn points, 6 nm (straight 5.2 nm), 2 s, land polygons checked 57, **crosses land: no**
- **SSA to Back Creek**: ok, 5 turn points, 1.3 nm (straight 0.6 nm), 1 s, land polygons checked 19, **crosses land: no**
- **SSA to Oxford**: ok, 26 turn points, 32.8 nm (straight 22.3 nm), 5 s, land polygons checked 159, **crosses land: YES at [{"leg":27,"lat":38.69342,"lon":-76.17297,"svc":"enc_coastal"}]**
- **SSA to Baltimore Inner Harbor**: ok, 28 turn points, 27.5 nm (straight 19.4 nm), 5 s, land polygons checked 223, **crosses land: no**

## Network failures

## Console errors
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.815,-76.588,39.135,-76.352' failed: Error during WebSocket handshake: Unexpected response code: 403
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.815,-76.588,39.135,-76.352' failed: Error during WebSocket handshake: Unexpected response code: 403
- Failed to load resource: the server responded with a status of 504 (Gateway Timeout)
- Failed to load resource: the server responded with a status of 504 (Gateway Timeout)
- Failed to load resource: the server responded with a status of 504 (Gateway Timeout)
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.815,-76.588,39.135,-76.352' failed: Error during WebSocket handshake: Unexpected response code: 403
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.493,-76.629,39.271,-76.056' failed: Error during WebSocket handshake: Unexpected response code: 403
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.493,-76.629,39.271,-76.056' failed: Error during WebSocket handshake: Unexpected response code: 403
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.71,-76.61,39.388,-76.11' failed: Error during WebSocket handshake: Unexpected response code: 403
- Failed to load resource: the server responded with a status of 504 (Gateway Timeout)
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.856,-76.518,39.021,-76.397' failed: Error during WebSocket handshake: Unexpected response code: 403
- Failed to load resource: the server responded with a status of 504 (Gateway Timeout)
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.373,-76.647,39.245,-76.005' failed: Error during WebSocket handshake: Unexpected response code: 403
- Failed to load resource: the server responded with a status of 400 ()
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.373,-76.647,39.245,-76.005' failed: Error during WebSocket handshake: Unexpected response code: 403
- Failed to load resource: the server responded with a status of 504 (Gateway Timeout)
- WebSocket connection to 'wss://tideline-ais.andy-brickman.workers.dev/?bbox=38.791,-76.74,39.455,-76.249' failed: Error during WebSocket handshake: Unexpected response code: 403