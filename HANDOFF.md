# Tideline handoff notes

Last updated: build 110 (11 Oct 2026). Live at https://olbucky1.github.io/Tideline/ · repo Olbucky1/Tideline.

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
