# Tideline: start here (read this first in every new session)

Live app: https://olbucky1.github.io/Tideline/ · repo: github.com/Olbucky1/Tideline (branch main).
Owner: Andy Brickman (andy.brickman@gmail.com), Annapolis. Sails a 1976 Catalina 27. Tests mostly on a MacBook in Safari, also on an iPad Pro and an iPhone. Most users will be on iPhones.
Current build: 181 (13 Oct 2026). History, file layout and data sources are in HANDOFF.md. Read only the sections you need; it is long.

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

### Settled answers (13 Oct)
- **Top slot default:** the combined compass/speed/depth gauge. Plain compass and "nothing" are options.
- **Undo/redo:** multi-level, for nearly everything, including moving a route line by accident. Small curved arrows that appear only while editing (layout, looks, route plotting), never on the chart while navigating. ⌘Z / ⇧⌘Z on a computer.
- **Paid satellite layers:** OPEN, see questions below.

### Batch A: appearance and usability (cheaper model)
1. **Fly-by controls:** ½× / 1× / 2× / 4×, a draggable timeline, pause anywhere.
2. **Top slot:** choose combined gauge (default), plain compass, or nothing. It stays set; names are clear.
3. **Full-screen chart:** keep a small layout switcher. Check iPhone and iPad.
4. **Copy my settings:** a link or QR that carries settings to a new window or device (stopgap until account sign-in).
5. **Gauge look screen:** tabs in order Favorites, Modern, Displays, Classic, Artwork, Compass; one continuous scroll, tabs jump to sections.
6. **More satellite and chart layers,** license-checked first (see open question).
7. **Settings never cover what they change,** plus undo/redo as settled above (appearance and console layout here; route-editing undo per open question).
8. **Customize the gauge face** from the theme picker.
9. **Simpler chart frames:** plain rope edge, no ship's-wheel spokes, quieter Polynesian and Chrome & Waves.
10. **Surf-style gauge designs.**
11. **Label and capitalization sweep** (Waterman, Waterwork).
12. **Center the First Mate anchor** in every theme.
13. **Help search:** typing and pressing Enter does nothing and no results appear. Enter (and typing) should show matching answers; no button needed. The box that opens is too large.
14. **Console Tidy up:** it rearranges oddly. It should snap tiles edge to edge and make near-equal tiles exactly equal (a tile that's clearly meant to be bigger stays bigger). The corner handles and top bar make it hard to see whether things line up.
15. **Console button row** ("Helm screen · Gauges only · Choose gauges · Plain numbers") wraps to two lines and wastes space. Make it one compact row or a menu; give the space to the gauges.
16. **Plain-numbers cards:**
    - Labels are clipped at the top ("SPEED (SOG)", "COURSE (COG)", "WIND") and the small lines under the numbers are clipped at the bottom ("GPS · 0s ago", "Shown once moving", "Gust 12…"). Seen on iPad (screenshot 13 Oct), in the half-and-half view with the draggable divider, and in the numbers-only gauge.
    - Redesign them to look polished and professional, Argo-clean rather than plain boxes.
17. **Weather/radar gauge:** a console tile showing live radar (a small weather map), resizable like any window, e.g. chart top-left, radar top-right, four gauges below. Scope per open question.

### Batch B: routing and safety (new session, top model)
18. **Routing overhaul (top priority):**
    - Follow the chart's own channels: dredged areas, fairways, recommended tracks.
    - Score routes, not just distance: depth margin, distance from shore, staying in channels, offshore exposure.
    - Coarse grid for open water, fine grid in canals.
    - Offer alternatives with trade-offs, e.g. Cape May inside through the canal (fixed bridges about 55 ft; verify) versus outside around the point.
    - Fix the weak spots around Cape May and the run offshore.
19. **Boat profile:** power or sail, draft, air draft, cruising speed. Power boats route point to point at steady speed.
20. **Narrow-channel safety:**
    - C&D Canal brief: ship traffic and wake, passing port to port, bank effect and ship suction, hand-steer instead of autopilot, current, canal rules (33 CFR 162.40; verify).
    - AIS alert when a large ship or tug and barge will meet you in a canal or narrow channel.
21. **Known-good route test set** of about 30 trips, run before every ship (Annapolis–St. Michaels, the C&D, both Cape May options, Sandy Hook–Liberty Landing, the East River, San Diego Harbor). Ask Andy for GPX tracks. Show route confidence and "not yet tested in this area".
22. **San Diego check:** Navy security zones, power-boat routing, graceful fallbacks outside the Chesapeake–NY corridor.
23. **Boater types:** Great Looper, delivery captain, working and towing.
24. **Board-sports track recording.**

### Backlog
- Account sign-in, crew sharing.
- Hints for the Solid / Soft / Blending / Ghost looks.
- A combined weather window (wind, rain, everything at once) and a meteogram-style graph like the point forecast Andy likes. The app links to it for now.

## Known open items (from the build 181 sweep)
- On a narrow chart, the forecast bar covers the map credit; the tour card overlaps the forecast bar.
- The page is busy for several seconds after a theme or chart change: renderSide and renderStrip force a layout on every GPS tick.
- The triple "Chesapeake and Delaware Canal" label comes from NOAA's tiles and can't be fixed here.
- The Settings sheet isn't two-column on wide screens yet.
- Backlog ideas: one "Underway" screen; plan → preview → "Start this trip" turn-by-turn; merge Looks, Map options and Quick settings into one sheet; a layout per device; a passage plan with watch schedule and best departure for the tides; an in-app feedback button with a screenshot; regional looks; yacht/crew management; deploy the Claude relay.
