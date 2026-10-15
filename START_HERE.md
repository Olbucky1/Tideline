# Tideline: start here (read this first in every new session)

Live app: https://olbucky1.github.io/Tideline/ · repo: github.com/Olbucky1/Tideline (branch main).
Owner: Andy Brickman (andy.brickman@gmail.com), Annapolis. Sails a 1976 Catalina 27. Tests mostly on a MacBook in Safari, also on an iPad Pro and an iPhone. Most users will be on iPhones.
Current build: 185 (15 Oct 2026). History, file layout and data sources are in HANDOFF.md. Read only the sections you need; it is long.

## Working rules (standing orders from Andy)
1. **Queue, don't build.** When Andy gives feedback while testing, add it to the queue below and reply briefly. Change no code until he says **"now execute the changes"**. "Go" alone is not the trigger.
   - Suggest a batch when the queue is about a dozen items, or when something is safety-critical. Andy decides.
   - Before building, review the whole queue for conflicts or unclear items and settle them with Andy first.
   - Remind Andy to switch models: up to the top model before a build if he forgot, down to a cheaper one when he's only logging notes. Warn him early (around 75%) when he's nearing his usage limit.
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

## Queue (not started; build only on "now execute the changes")

### Settled answers (15 Oct, Batch B)
- **Order:** safety build first (185, done), then routing overhaul + route undo + test set (186), then time zones, Race Coach, route waits, destination search, events (187).
- **New router ships behind a "new router (testing)" switch;** the old router stays default until it passes Andy's test runs on the Mac against live charts (the sandbox has no internet). Ask Andy for GPX tracks of the test trips.
- **Boat autofill data:** hand-built list of about 100 common sail and power models from builders' published specs, each marked "check these"; free typing for anything else. No scraped databases (sailboatdata.com etc. don't license reuse).
- **Distress:** honest version only (built in 185).

### Settled answers (13 Oct)
- **Top slot default:** the combined compass/speed/depth gauge. Plain compass and "nothing" are options.
- **Undo/redo:** multi-level, for nearly everything, including moving a route line by accident. Small curved arrows that appear only while editing (layout, looks, route plotting), never on the chart while navigating. ⌘Z / ⇧⌘Z on a computer.
- **Paid satellite layers:** ship the free ones; send Andy a list of any paid ones with their cost. Add no paid layer.
- **Route-editing undo:** built with the routing overhaul in Batch B, not Batch A.
- **Tidy up:** no preference from Andy, so: Tidy snaps the current layout in place and evens out sizes; a separate "Next layout" button cycles layouts.
- **Radar gauge:** a rain radar tile in Batch A; the wind/everything weather window stays in the backlog.

### Batch A leftovers
- **Built in build 184:** undo/redo arrows, alert pulse, six bridge/battleship/yacht console looks, workboats label, icon sweep. Waiting on Andy's test on the iPhone, iPad and Mac.
- **Notes 3 (Andy, 13 Oct 22:12), Batch A unless noted. Needs clarification before building:**
  - **Guided tour, weather icon (Andy clarified 13 Oct):** when the walk-through tour highlights the weather icon it must then animate and show how the icons expand, revealing all the options (radar, rain, current, and so on) during the introduction tour.
  - **Compass as a measuring tool:** use the compass for measurement (bearing and distance?). Confirm.
  - **Highlights / guided tips:** the callout box should be smaller and able to sit closer to the highlighted item; "Plan a trip" and similar tips should show a small thumbnail picture of what they do (e.g. a route).
  - (Andy: skip the cut-off note "I tried to plan a trip from Edge".)
- **Batch B, from Notes 3:**
  - ~~Distress button~~ built in 185 (hold SOS 2 s; honest version).
  - **Boat name/model autofill (186/187):** typing a maker and model (e.g. Sabre power) suggests known makes and models and fills draft, air draft, length and so on. Today BOAT_DB has 4 boats and no typeahead. Data: hand-built list (see settled answers).
  - ~~Propulsion options and IPS cautions~~ built in 185 (type first, then makers for every type; pod cautions). Pod cautions only work where the shallow-tint depth tiles are loaded; later read depth along the route too.
- **Parked (Andy: "don't worry about the others", 13 Oct):** full-screen chart switcher; settings sheets other than Gauge look covering the chart; customize gauge face; rope/Polynesian/Chrome frames and surf designs (need artwork); paid satellite list; settings-link QR; Tidy up keeping one larger gauge larger.

### Stabilization pass (independent audit by ChatGPT, build 184, Andy 15 Oct). Reproduce each finding first, keep changes small, keep the round gauges.
Confirmed by reading the code (not yet run): #1 header says "GPS live" even in demo (`.ck-gps`, ~line 6364 ignores `S.settings.sim`); #5 closures list is only sliced, never filtered by region or date (~line 773); #6 the fishing debrief reuses the race debrief text (`rcDebriefHtml`, ~line 9286).
**Small fixes, Sonnet, one session (safety-critical, suggest building soon):**
1. ~~**Demo labeling**~~ (built 185): persistent DEMO label wherever simulated position, speed or depth shows; the emergency VHF script and float plan must never contain simulated coordinates (show "Position unavailable (demo)"); keep simulated voyage records separate.
2. ~~**AIS "NaN nm at NaN°"**~~ (built 185): validate own-ship and target positions before range/bearing; show "Position unavailable" otherwise (Boat > Identify > A single white light).
3. **Depth meaning:** label live sounder vs charted vs tide-adjusted vs preview-location depth, with datum, place and time; never a bare "DEPTH" for chart-derived values.
5. **Closures:** filter by area (no Michigan or Boston under Chesapeake) and by effective dates; separate current, upcoming and archived; say which notices routing does not use.
6. **Fishing debrief:** remove race wording; give a fishing-specific debrief or an honest "not available yet".
11. **Version label:** Menu and Settings must read one build source.
**Later (Opus / Batch B, they touch routing and coaches):**
4. Route assumptions and time zones: power vs sail, speed and polar assumptions, currents shown the same on every screen; label the voyage timezone on departure, arrival, daylight and tide times.
7. Race Coach: competing trim advice, J/105 and J/24 advice shown for a Catalina 27.
8. Route generation waits: progress, cancel, retry, stale-result protection; a route warning appeared after leaving the planner.
9. Destination search: rank nearby navigable marine places first, separate general place matches.
10. Events: remove duplicates, show confirmed vs estimated dates, unambiguous date format.
**Design direction from the audit (keep as backlog):** chart-first default screen, one primary panel open at a time, separate Planning / Underway / Demo states, coach advice shown as action + reason + assumptions + source + exceptions, weather model + time + place + freshness together, tour stories subordinate to warnings.
**First Mate:** missing AI connection is planned work, not a defect. When connected: constrained app actions, validated parameters, route-change preview before applying, deterministic navigation math; the model explains, never invents clearance, depth or collision conclusions.
**Still needs real-world validation:** real GPS and sensors, Safari and Android, locked-screen alarms, offline, voice, multi-device sync, backup/restore, GPX, photos, route-edit regression, accessibility, performance, on-water accuracy.

### Batch B: routing and safety (new session, top model)
18. **Routing overhaul (top priority):**
    - Follow the chart's own channels: dredged areas, fairways, recommended tracks.
    - Score routes, not just distance: depth margin, distance from shore, staying in channels, offshore exposure.
    - Coarse grid for open water, fine grid in canals.
    - Offer alternatives with trade-offs, e.g. Cape May inside through the canal (fixed bridges about 55 ft; verify) versus outside around the point.
    - Fix the weak spots around Cape May and the run offshore.
19. **Boat profile:** power or sail, draft, air draft, cruising speed. Power boats route point to point at steady speed.
20. **Narrow-channel safety:** C&D brief and canal ship-meeting alert built in 185. Still to do with the overhaul: the same meeting alert for any narrow channel read from the chart (dredged areas, fairways), and briefs for other cuts.
    - C&D Canal brief: ship traffic and wake, passing port to port, bank effect and ship suction, hand-steer instead of autopilot, current, canal rules (33 CFR 162.40; verify).
    - AIS alert when a large ship or tug and barge will meet you in a canal or narrow channel.
21. **Route undo/redo:** multi-level undo for route edits (e.g. a line moved by accident snaps back), small curved arrows shown only while plotting.
22. **Known-good route test set** of about 30 trips, run before every ship (Annapolis–St. Michaels, the C&D, both Cape May options, Sandy Hook–Liberty Landing, the East River, San Diego Harbor). Ask Andy for GPX tracks. Show route confidence and "not yet tested in this area".
23. **San Diego check:** Navy security zones, power-boat routing, graceful fallbacks outside the Chesapeake–NY corridor.
24. **Boater types:** Great Looper, delivery captain, working and towing.
25. **Board-sports track recording.**

### Backlog
- Account sign-in, crew sharing.
- More bridge/battleship/yacht looks: 12 bezels on the three design-refs sheets are still uncut (same method as build 183). The square bezels (Navsuite, Integrated Bridge Module, Armored Console) would need square skins.
- Undo/redo arrows in the console's Customize bar (today only ⌘Z there, no redo).
- Hints for the Solid / Soft / Blending / Ghost looks.
- A combined weather window (wind, rain, everything at once) and a meteogram-style graph like the point forecast Andy likes. The app links to it for now.

## Known open items (from the build 181 sweep)
- On a narrow chart, the forecast bar covers the map credit; the tour card overlaps the forecast bar.
- The page is busy for several seconds after a theme or chart change: renderSide and renderStrip force a layout on every GPS tick.
- The triple "Chesapeake and Delaware Canal" label comes from NOAA's tiles and can't be fixed here.
- The Settings sheet isn't two-column on wide screens yet.
- Backlog ideas: one "Underway" screen; plan → preview → "Start this trip" turn-by-turn; merge Looks, Map options and Quick settings into one sheet; a layout per device; a passage plan with watch schedule and best departure for the tides; an in-app feedback button with a screenshot; regional looks; yacht/crew management; deploy the Claude relay.
