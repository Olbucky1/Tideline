# Tideline handoff notes

Last updated: build 123 (11 Oct 2026). Live at https://olbucky1.github.io/Tideline/ · repo Olbucky1/Tideline.

## What it is
A phone-first marine chart app (PWA) for the Chesapeake, built to work anywhere NOAA has data. Owner: Andy Brickman. Design rules from Andy: clean, calm first screen; symmetry; everything toggleable; an X on every popup; press-and-hold names on phone (hover on desktop); nothing cluttered.

## How the code is laid out
- `index.html`: shell, tab bar, button columns. Assets are loaded with `?v=NN` (bump it with every release).
- `app.js`: one large closure. **New code that needs `$`, `S`, `map` etc. must go before `window.Tideline = {` near the end** (code after the closing `})();` fails).
- `app.css`: later rules override earlier ones; many `!important` overrides. Theme colours live in CSS variables (`--fab-bg`, `--fab-on`, …) set by `html[data-btheme]`.
- `sw.js`: service worker, network-first for app files. Bump `APP = 'tl-app-vNN'` with each release.
- `vendor/leaflet`, `vendor/leaflet-rotate` (GPL-3.0, used for course-up rotation; replace before a closed-source App Store release).
- `tools/`: `ais-relay` (Cloudflare worker, live), `assistant-relay` (needs OpenAI key + Supabase), `lightning-relay` (needs Xweather keys), `supabase/setup.sql` (accounts + Great Loop reports table).
- Release checklist: bump `build NN` in app.js, `?v=NN` in index.html, `tl-app-vNN` in sw.js; run `node --check app.js` and `tests/*.cjs`.

## Data sources (all fetched by the phone)
NOAA ENC Direct (depths, land, restricted areas, bridges, buoys) · NOAA MCS chart tiles · NOAA CO-OPS tides and **current predictions** (mdapi station list + `currents_predictions`) · Open-Meteo forecast and marine · NWS alerts · Federal Register API (Coast Guard rules) · iNaturalist, Wikipedia/Commons · Overpass/Photon · aisstream via relay.

## Recently built (this round)
- Routing follows water automatically for every leg (tap, typed, first mate, Navigate here): ENC depth areas + land from the same chart scale, no-entry restricted areas, bridges lower than air draft + 2 ft, Coast Guard fireworks safety zones (33 CFR 165.506) on their dates, user avoid areas; widens the search box around peninsulas; failed legs drawn dashed orange with the reason.
- Tidal currents: arrows at NOAA stations (zoom ≥ 11), detail slider, optional moving flow lines (off by default, kept off land), Weather-tab Current view with hourly arrows, station sheet with 24 h curve.
- Spot card: tap the chart → small glass card at the spot (wind, waves, current, tide, charted depth, water, air) with Navigate / Sail here / More. Tap elsewhere closes it.
- Sailing coach (sail plan, trim, tack, best time to leave using wind + current), Great Loop advisor (legs, boat limits, live notices, looper reports), activity themes and button themes.
- Weather alerts: severity ring (red/yellow/blue/green) with a picture of the hazard; full-screen red takeover for tornado, hurricane, severe marine warnings.
- Lightning: strikes, nearest-strike chip, approach warning with sound or mute; needs a feed (see below).
- Chart view: compass rose button (north up / course up), tilted 3D; bigger speed dial with compass card, course, speed and depth.
- Welcome sign-in screen (email code) and a 9-step tour; press-and-hold button names; range rings settings.
- First mate: offline command understanding, ~20 known Chesapeake places, hands-free wake phrase ("first mate").

## Waiting on Andy
1. **Supabase**: create a free project, run `tools/supabase/setup.sql`, send the Project URL and anon public key → set `TL_ACCOUNTS` in app.js. Enables sign-in, sync across devices and shared looper reports.
2. **Lightning feed**: Xweather (Vaisala) account → deploy `tools/lightning-relay`.
3. App name / wake word.

## Known gaps and next steps
- **Channel-scale currents** (e.g. the channel between 1AH and Thomas Point): needs NOAA's CBOFS model. nowCOAST moved from ArcGIS to GeoServer WMS in 2023; the surface-current layer name was not confirmed (the server blocks our fetch tool). Plan: discover it at runtime from the phone and add "Model currents (NOAA)".
- Routing and currents were tested against simulated NOAA data only (the build workspace cannot reach NOAA). Real-device testing on Andy's iPhone is the check.
- Weather-tab layout on small phones, and 3D taps (disabled in 3D for now).
- Photos stay on the device (IndexedDB) and do not sync.

## Testing notes
Serve the folder (`python3 -m http.server 8765`) and use Playwright with the iPhone 14 Pro profile, `service_workers='block'` so request stubs work, and set `tl.welcomed`/`tl.toured` in localStorage to skip the welcome screen. Viewport is 393×660 CSS px.

## Andy's idea list (so nothing gets lost) — 11 Oct 2026
Market and business
- Broad market, not sailing-only: fishing (Florida Keys, Bahamas), cruising, Great Loop, liveaboards, kayakers, pros (bay pilots, tugs, commercial watermen, crabbers, lobstermen). Worldwide, priced by country.
- Name: likes Tideline (tideline.com is taken; check tideline.ai / .app / getTideline / Tideline Marine with a trademark search). Rhumb Line felt too sailing-only.
- Monetize without a stripped-down free tier: full trial, then a still-complete free app; paid tier for things that cost money or that pros want. Affiliates (marinas, insurance, surveys, parts), club/school/fleet licenses, a pro tier. No ads for now.
- A "cause" theme (reefs, manatees, clean water) with a share of revenue to a non-political ocean charity (e.g. via 1% for the Planet).
- Owner-reported issues by make/model (the Vessel Book idea).
Product
- Hardware by partnering, not manufacturing: read the boat's instruments (depth, wind, heading, AIS) through Signal K or a NMEA 2000 Wi-Fi gateway; later radar/sounder partners.
- Coaches: sailing (done, keep it suggestions not orders; savvy navvy's rigid leg-by-leg instructions did not hold up), racing (respect Rule 41 / sailing instructions), fishing (respect tournament rules, e.g. NPFL forward-facing sonar ban), kayak pacing, pros.
- Racing: AIS-based "ahead/behind" vs. other boats, night races.
- Weather: side-by-side model comparison, weather routing, CBOFS model currents.
- Cameras: bow / stern / masthead cameras shown as a tile in the instruments (docking, crab pots). Browsers can't show most boat cameras (local http/RTSP streams), so this needs the native app or a camera that offers HTTPS/WebRTC. Partner idea: a cheap solar Wi-Fi bow camera.
- Gauge looks: six themes now (Midnight chrome, Arctic white, Bronze, Glass ocean, Expedition, Heritage brass) plus Analog / Analog + digital / Digital. ChatGPT's concept images are the visual reference; new themes = new colour sets in app.css (search "gauge themes").
- Icon themes that match the gauge theme (subtle, chart stays the hero).

## Since build 110
Spot card (dark glass), arrange buttons, weather model picker, AIS memory (3 h for moored boats, follows the chart), "What do you use Tideline for" + monthly events page, gauge themes (6) with chrome/brass bezels and analog/digital/both, deep-navy daytime menus, smooth forecast slider (5-minute steps) with the last 50 minutes of real radar, wind lines blend between forecast hours.

## For a reviewer (another AI or a person)
Live app: https://olbucky1.github.io/Tideline/ (phone first; Safari on iPhone is the main target). Code: https://github.com/Olbucky1/Tideline (app.js, app.css, index.html).
Please review as a demanding boater (fishing, cruising, sailing) and as a front-end engineer:
1. Top 10 problems on a phone, ranked: confusing, ugly, broken, slow, cluttered.
2. Safety: anything that could mislead someone navigating (depth, routes, bridges, currents, weather).
3. Missing basics that Navionics, Argo, PredictWind or savvy navvy users would expect.
4. Code risks: bugs, performance, things that will break at scale, data-licensing problems (Open-Meteo is free for non-commercial use only; NOAA data is public).
Give concrete fixes. Keep the design rules: calm chart first, symmetry, everything toggleable, an X on every popup.

## Build 119–121 (after an independent safety review)
- Routing safety: cells count as water only when fully covered (thin land/jetties can't be blended away); shoal "maybe" areas blocked unless the boat profile allows; start/end snapping limited to ~160 m; any chart scale that fails or is cut short marks the leg unchecked; every straight piece is re-checked on a fine grid; piers/jetties (shoreline construction) and wrecks/obstructions shallower than the draft are blocked; dashed overlay covers the whole unchecked leg.
- Tides fetched in GMT (correct for phones in other time zones); expired NWS alerts drop locally; lightning sheet says when the feed is down; saved routes keep turn points and unchecked flags.
- Fixed: tapping a saved fishing spot crashed (two functions named openSpot).
- UX: drag buttons anywhere with magnets; slim arrange bar that fades while dragging; small light button-name labels (tap-flash off by default); "WX" alert button with a pulsing ring; Gauge look picker with face artwork (swirl, topo, rose, horizon, swells); white classic buttons.
Still open from the review: service-worker caching of data (stale offline data shown as fresh; ENC host cached forever), WR.cache growth, ENC bridge matching, tide gauge FLOOD/EBB wording, lightning re-warn by distance band.

## Build 123 — routing fixed against REAL NOAA data
- The workspace can't reach NOAA, so `.github/workflows/route-check.yml` runs on GitHub: `tests/enc-snapshot.mjs` downloads the Annapolis-area ENC layers and `tests/live-route.mjs` runs real routes; results go to the `diag` branch (`report.md`, `enc/`). To replay offline: put `diag:enc` in the scratchpad and stub `encdirect` requests from it (see encstub.py pattern: filter features by envelope, honour resultOffset).
- Root causes found on real data: (1) pins at clubs/marinas sit on land or in water shallower than draft, so start/end snapping (160 m) failed → straight line; (2) seams between adjacent depth polygons were anti-aliased and read as land; (3) coastal-scale charts only give depth ranges (0–18 ft) for most of the Bay, which were blocked; (4) ~30 parallel requests per grid → NOAA 429/504; (5) Start dropped the "unchecked" flag.
- Fixes: tiled + cached ENC fetching (4 at a time, retry/backoff, OBJECTID dedupe); per-scale canvases merged coarse→fine, areas outlined in their own colour; depth-range areas allowed at higher cost with a plain "watch the depth" note; snap 500 m, then nearest connected water within 3 km for inland pins; finer grid (≤1400 cells, ≥30 m); corner-cut pieces re-solved on a 30 m grid and spliced; unchecked routes drawn dashed orange, Start needs a second tap, navigation banner warns.
- Replay results: SSA→St. Michaels (via Eastern Bay and Miles River), Rock Hall, Thomas Point, Back Creek, Oxford, Baltimore all route in water.
- Also in 123: water-only destination search (+ "include places on land"), planner departure time with a trip weather verdict and a better-window suggestion, contrast/overlap fixes across themes, ship-shaped AIS markers with a ship sheet (names off by default), Clean/Standard/Full chart detail (NOAA display_params; needs a live check), first mate name + wake word + forgiving commands, arrange snap grid + Tidy up.

## More of Andy's ideas (11 Oct, later)
- Destination guide: things to do at St. Michaels (bike rental, maritime museum, restaurants with reviews), best marinas for showers; marinas/fuel near me with ETA, hours, phone, VHF. (Google reviews need the paid Google Places API through a relay; OSM is free but thin.) Big monetization lever (affiliate bookings).
- Real AI voice for the first mate (OpenAI or ElevenLabs TTS via relay; ElevenLabs can clone the owner's voice). Browser voices sound robotic.
- Grounding warnings: the first mate warns when your course leads into water shallower than your draft.
- Icons that can take the gauge themes (e.g. Navy and brass everywhere), optional.
- Zoom +/− and locate buttons default to bottom right.
- A simple vector "clean chart" (savvy navvy style) drawn from ENC data instead of the printed chart.
- Fun boat icons (Titanic, carrier, dolphin, Pride of Baltimore) and boat photo as the boat icon.
