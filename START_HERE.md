# Tideline: start here (read this first in every new session)

Live app: https://olbucky1.github.io/Tideline/ · repo: github.com/Olbucky1/Tideline (branch main).
Owner: Andy Brickman (andy.brickman@gmail.com), Annapolis. Sails a 1976 Catalina 27. Tests mostly on a MacBook in Safari, also on an iPad Pro and an iPhone. Most users will be on iPhones.
Current build: 181 (13 Oct 2026). History, file layout and data sources are in HANDOFF.md. Read only the sections you need; it is long.

## Working rules (standing orders from Andy)
1. **Queue, don't build.** When Andy gives feedback while testing, add it to the queue below and reply briefly. Change no code until he says "go".
   - Suggest a batch when the queue is about a dozen items, or when something is safety-critical. Andy decides.
2. **One batch, one pass.** Build all the queued items together, test them, ship one build, and update this file. Then tell Andy it's a good time to start a fresh session.
3. **Be his voice of reason.** Say plainly what's good and what isn't. Don't just agree, and don't disagree by reflex.
4. **Safety first.** Routing and navigation must never mislead; one bad route loses a user for good.
   - Routes are advisory. Show confidence, and dash anything not checked against the chart.
5. **Cost.** Use the top model only for hard design work, like routing. Use helper agents on cheaper models (sonnet or haiku) for test sweeps, screenshots and simple edits.
   - Usually one agent per batch. Say which model was used.
6. **Other AIs.** When Andy wants to run an idea past another model (ChatGPT etc.), write him a self-contained prompt to paste in.
7. **No money features in the beta:** no prices, trials or paywalls. **No API keys** in app.js or GitHub; keys live only in Cloudflare Worker secrets.

## How to ship
- **Get the code:** `git clone https://github.com/Olbucky1/Tideline tideline`.
- **Bump three version numbers by one:**
  - `?v=N` in index.html
  - `tl-app-vN` in sw.js
  - `build N.` in app.js
- **Check:** run `node --check app.js` and test with Playwright. The sandbox has no internet, so NOAA, tiles and Overpass are unavailable; abort non-localhost requests and seed localStorage `tl.settings`.
- **Commit and push:**
  - Commit as Andy Brickman <andy.brickman@gmail.com>. End the message with the Co-Authored-By and Claude-Session lines the harness provides.
  - `git push` to main; GitHub Pages deploys it.
- **Record it:** add one line for the build in HANDOFF.md, and update the queue here.

## Code map (the essentials)
- **app.js:** one big closure.
  - New code goes before `window.Tideline = {` near the end; that object exposes helpers for testing.
  - Key globals: S (state; S.settings, saved with saveSettings()), map (Leaflet), $ (getElementById).
- **Routing:**
  - waterLeg(a,b): A* on a NOAA chart water/land grid.
  - passageLeg plus the PN/PE passage network (Chesapeake → C&D → Delaware Bay → Cape May → NJ → NY) for legs over 35 nm.
  - routeByWater(stops) puts them together.
- **Briefing and fly-by:** openBriefing, legSay, brLegHtml, PN_NOTE / PN_STOP, the FLY camera (flyStart / flyFrame / flySight).
- **Tour guide:** TG, kb/tour.json (52 stops) and Wikipedia ranked by pageviews (tgWorth).
- **First Mate:** fmUnderstand handles phrases offline. The Claude relay in tools/claude-relay is not deployed yet; it needs Andy's keys.

## Queue (not started; build when Andy says "go")
1. **Fly-by controls:** speed ½× / 1× / 2× / 4×, a timeline you can drag, and pause anywhere.
2. **Routing overhaul (top priority):**
   - Follow the chart's own channels: dredged areas, fairways and recommended tracks.
   - Score routes, not just distance: depth margin, distance from shore, staying in channels, offshore exposure.
   - Use a coarse grid for open water and a fine one in canals.
   - Offer alternatives with trade-offs, e.g. Cape May: inside through the Cape May Canal (fixed bridges about 55 ft; verify) versus outside around the point.
   - Fix the remaining weak spots: around Cape May and the run offshore.
3. **Boat profile:** power or sail, draft, mast height (air draft), cruising speed. Power boats route point to point at a steady speed.
4. **Narrow-channel safety:**
   - A C&D Canal brief covering ship traffic and wake, passing port to port, bank effect and ship suction, hand-steering instead of autopilot, current, and the canal rules (33 CFR 162.40; verify).
   - An AIS alert when a large ship or tug and barge will meet you in a canal or narrow channel: "hand-steer, keep right, expect to be pulled toward the bank as it passes".
5. **Known-good route test set** of about 30 trips, checked against every build before it ships:
   - Annapolis–St. Michaels, through the C&D, both Cape May options, Sandy Hook–Liberty Landing, the East River, San Diego Harbor.
   - Ask Andy for GPX tracks from his past trips.
   - Show route confidence, and "not yet tested in this area" outside proven regions.
6. **San Diego check** for a beta tester who runs power charters there: Navy security zones (restricted areas), power-boat routing, and graceful fallbacks outside the Chesapeake–NY corridor (passages, notes, tour).

## Known open items (from the build 181 sweep)
- On a narrow chart, the forecast bar covers the map credit; the tour card overlaps the forecast bar.
- The page is busy for several seconds after a theme or chart change: renderSide and renderStrip force a layout on every GPS tick.
- The triple "Chesapeake and Delaware Canal" label comes from NOAA's tiles and can't be fixed here.
- The Settings sheet isn't two-column on wide screens yet.
- Backlog ideas: one "Underway" screen; plan → preview → "Start this trip" turn-by-turn; merge Looks, Map options and Quick settings into one sheet; a layout per device; a passage plan with watch schedule and best departure for the tides; an in-app feedback button with a screenshot; regional looks; yacht/crew management; deploy the Claude relay.
