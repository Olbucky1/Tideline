TIDELINE — prototype 0.6
A simple marine GPS for anyone on the water.

PUT IT ON YOUR PHONE (about 2 minutes, free)
Phones only allow GPS on a secure web address, so the app needs to be hosted.
1. On a computer, unzip tideline.zip. You get a folder called "tideline".
2. Go to https://app.netlify.com/drop and make a free account.
3. Drag the "tideline" folder onto the page. Netlify gives you an address
   like https://something-random.netlify.app (you can rename it in Site settings).
4. On your iPhone, open that address in Safari. Allow location when asked.
5. Tap Share, then "Add to Home Screen". Tideline now opens like an app.
   Same steps on the iPad. A Wi-Fi-only iPad needs a Bluetooth GPS made for
   iPad (Bad Elf, Garmin GLO 2 or similar); pair it and Tideline uses it.
   Same steps on the iPad. A Wi-Fi-only iPad needs a Bluetooth GPS made for
   iPad (Bad Elf, Garmin GLO 2 or similar); pair it and Tideline uses it.
6. Open it once while you have signal, then reload it, so it can work offline.

TO UPDATE LATER
Drag a new "tideline" folder onto the same site in Netlify (Deploys tab).

NEW IN 0.6 (calm first screen, after the design round)
- First screen is just the chart, your boat, a thin status line (GPS accuracy, wind, age) and two big numbers: speed and course. Swipe the numbers for more.
- Search, wind/wave/tide chips and the route button are off the chart. Search is in Menu and Navigate; chips can be turned back on in Map options.
- Rules of the Road coach is off by default (Settings > Captain's coach). Its card, and the bridge card, now have a close button.
- The bridge card only appears while you are navigating somewhere and a bridge ahead may be too low. Otherwise bridges are quiet pins showing clearance.
- Satellite: Standard (Esri) or HD (USGS aerial imagery, US waters) in Map options. Falls back to the chart alone if imagery won't load.
- iPad: a light side column with next destination, speed, course and wind, each with its source and age.
- Anchor watch: you can leave the screen freely; disarming takes a press and hold. Status says "Inside circle", never "Holding".
- Instruments (Menu > Instruments, or More instruments on iPad): glass-cockpit gauges for speed, course, wind relative to the bow, tide, distance and steering arrow to your destination, and anchor distance. The bottom bar always stays visible; close with the X or any tab.
- Weather: turn wind, waves and rain on in any mix (Weather tab pills, or Map options). Air and water temperature at your boat (water from the nearest NOAA station when one is within 15 nm, otherwise the model, labelled). Tide tab adds a high/low table and a link to the full NOAA tables.
- Menu > Captain's resources: NWS forecast for your spot, marine forecasts, NOAA tide station, U.S. Coast Pilot, Local Notices to Mariners, drawbridge rules, Navigation Rules. Linked, so always current.
- New colors from the design round: warm ivory, pale water, navy text, teal controls.

NEW IN 0.5
- Bottom bar is now Chart | Navigate | Weather | Anchor | Menu.
- Navigate: From / To, Engine or Sail speed, Go direct, Plan a route, saved trips, track recording. Route sheet shows a fuel estimate when the boat profile has fuel burn.
- Weather tab: timeline with Wind / Waves / Rain / Tide. On a phone it stays one row until you tap the arrow, then shows 48 hours to scrub. Tide shows the NOAA curve.
- Globe button: satellite under the chart in one tap, saved as your preference. If imagery won't load, it falls back to the chart alone.
- Long-press anywhere: Navigate to, Weather here (3-hourly forecast for that spot), Measure from here, Save.
- Swipe the instrument strip: page 2 is wind, waves, tide and GPS accuracy; page 3 is position, time and sunset.
- Boat profile: safety buffer under keel, fuel burn, tank size, MMSI.
- Menu, plus a short Safety section: mayday script with your boat and position, VHF channels, a float plan you can copy into a text, the vessel safety checklist, night boating.
- While anchor watch is on, leaving the Anchor screen takes a press and hold. The watch keeps running either way.

NEW IN 0.4
- Measure like savvy navvy: tap the ruler, then drag the crosshairs. Distance and
  bearing follow the line, a dashed ring shows the same distance all around,
  and dragging to the edge zooms the chart out.
- Route planner (the waypoint button): start from your boat, tap to add
  waypoints, drag to adjust. Shows each leg's distance, bearing, time and wind,
  your arrival time for any departure, and flags bridges you can't clear.
  Save routes, then Start to navigate leg by leg.
- Map options (layers button): chart type, satellite imagery under the chart
  with a fade slider, range rings, bridges, buoys, weather, color mode and
  Easy view (bigger icons and text).
- Captain's coach: Off, Chime (a gentle ding-ding) or Spoken, like turn-by-turn
  directions. Settings has a "Test the sound" button.
- Sound on iPhone: alarms and the coach now play even with the ringer switch
  off, after your first tap.

NEW IN 0.3
- Measured wind: live readings from NOAA weather stations near you, shown on
  the chart and under the wind forecast ("Measured Annapolis SW 12 · 5 min ago").
- Every reading says where it came from and how old it is: forecast age,
  tide station name and distance, GPS accuracy and source, AIS report age.
- Rules coach is more careful: "likely give-way / likely stand-on", the AIS
  report age, and advice pauses when a boat's AIS is more than 3 minutes old.
  When two sailboats meet, the tack is only an estimate, so the coach asks you
  to check its sails instead of assigning right of way.
- Dock test (Anchor tab): a 40 ft circle where you stand. Walk away and the
  alarm should sound after about 15 seconds. Do it before the trip.
- Smarter GPS filter: sudden position jumps are ignored until three fixes agree,
  without capping real speed.
- Day, dusk and red night themes switch on their own at civil twilight
  (Settings > Display > Light to choose one yourself). Night is much dimmer.
- Calmer look: warm light panels, readouts with their source underneath,
  chart buttons on the left on phones, a quiet ripple when anchor watch arms
  and a heartbeat dot each time a GPS fix arrives.

NEW IN 0.2
- Weather on the chart (layers button): live rain and storm radar, a wind
  forecast and a wave forecast with a 48-hour time slider. Tap the wind or
  waves chip at the top right to switch them on and off.
- Wave height now shows next to the wind, always on the chart.
- Bridges: clearance labels on the chart, checked against your boat's air
  draft and beam, adjusted for today's tide. Green fits, amber is tight or
  needs an opening, red can't pass. A card pops up when you're heading at a
  bridge you need to watch, with the VHF channel and a call button when known.
  Add your air draft (masthead and antennas) in Boat > Edit. Safety margin in
  Settings. Bridge data comes from OpenSeaMap and is patchy; check the chart.
- Cockpit display (layers button or Settings): huge numbers for an iPad or
  spare phone on deck. Taps are locked; press and hold to exit.
- Anchor watch: "Test the alarm sound" button.
- Saved charts are protected from being cleared where the browser allows it.
  Only the NOAA chart is saved for offline use.
- Better layout on iPad in portrait.

NEW IN 0.4
- Measure like savvy navvy: tap the ruler, then drag the crosshairs. Distance and
  bearing follow the line, a dashed ring shows the same distance all around,
  and dragging to the edge zooms the chart out.
- Route planner (the waypoint button): start from your boat, tap to add
  waypoints, drag to adjust. Shows each leg's distance, bearing, time and wind,
  your arrival time for any departure, and flags bridges you can't clear.
  Save routes, then Start to navigate leg by leg.
- Map options (layers button): chart type, satellite imagery under the chart
  with a fade slider, range rings, bridges, buoys, weather, color mode and
  Easy view (bigger icons and text).
- Captain's coach: Off, Chime (a gentle ding-ding) or Spoken, like turn-by-turn
  directions. Settings has a "Test the sound" button.
- Sound on iPhone: alarms and the coach now play even with the ringer switch
  off, after your first tap.

NEW IN 0.3
- Measured wind: live readings from NOAA weather stations near you, shown on
  the chart and under the wind forecast ("Measured Annapolis SW 12 · 5 min ago").
- Every reading says where it came from and how old it is: forecast age,
  tide station name and distance, GPS accuracy and source, AIS report age.
- Rules coach is more careful: "likely give-way / likely stand-on", the AIS
  report age, and advice pauses when a boat's AIS is more than 3 minutes old.
  When two sailboats meet, the tack is only an estimate, so the coach asks you
  to check its sails instead of assigning right of way.
- Dock test (Anchor tab): a 40 ft circle where you stand. Walk away and the
  alarm should sound after about 15 seconds. Do it before the trip.
- Smarter GPS filter: sudden position jumps are ignored until three fixes agree,
  without capping real speed.
- Day, dusk and red night themes switch on their own at civil twilight
  (Settings > Display > Light to choose one yourself). Night is much dimmer.
- Calmer look: warm light panels, readouts with their source underneath,
  chart buttons on the left on phones, a quiet ripple when anchor watch arms
  and a heartbeat dot each time a GPS fix arrives.

NEW IN 0.2
- Weather on the chart (layers button): live rain and storm radar, a wind
  forecast and a wave forecast with a 48-hour time slider. The bar turns
  amber when you're looking at a future hour. Tap the wind or waves chip at
  the top right to switch them on and off.
- Wave height now shows next to the wind, always on the chart.
- Bridges: estimated clearance labels on the chart, checked against your
  boat's air draft and beam and adjusted for today's tide, with an allowance
  for tide uncertainty. Green has room, amber is inside your safety margin
  or needs an opening, red can't pass. A card pops up when you're heading at
  a bridge to watch, with the VHF channel and a call button when known.
  Add your air draft (masthead and antennas) in Boat > Edit; safety margin is
  in Settings. Bridge data comes from OpenSeaMap and is patchy: always check
  the chart and verify clearance yourself.
- Cockpit display (layers button or Settings): huge numbers for an iPad or
  spare phone on deck. Taps are locked; press and hold to exit.
- Anchor watch: "Test the alarm sound" button.
- Saved charts: Tideline asks the browser to keep them permanently (the
  browser may still refuse; Settings shows which). Only the NOAA chart is
  saved for offline use.
- Better layout on iPad in portrait.

WHAT IT DOES
- Search: tap the bar at the top. Marinas, fuel, pump-out, ramps, anchorages,
  lighthouses, markers and bridges, or type any name or town. Nearest first.
  Place details (VHF, phone, hours, fuel) come from OpenStreetMap.
- Rules coach (AIS): when a boat is on a collision course it tells you whether you
  give way or stand on, why (Rules 7, 9, 12-18), what to do, and a radio script.
  Try it in Demo mode, which adds simulated AIS boats. Live AIS needs the
  app-store version.
- Rules of the Road: search "Rules of the Road" or any word (anchor light,
  overtaking, fog). Plain-language summaries plus a link to the official text.
- Anchor lights: anchor watch tells you whether you need an anchor light tonight.
- Anchoring advice: before you drop, it recommends how much rode to put out
  (depth at high tide + bow height, scope from forecast gusts and rode type)
  and rates the spot: depth under your keel at low tide, wind, wind shifts,
  whether you carry enough rode and chain, and how your anchor type suits
  the bottom (add your anchor in Boat > Edit; pick the bottom when anchoring).
- Voice coach: a calm spoken alert once per boat, again only if it gets closer.
  Settings > Spoken coaching to turn off. Add your first name in Boat > Edit.
- Tap any AIS boat: name, type, size, draft, destination, status, range,
  closest approach, speed, and links to photos (MarineTraffic, VesselFinder).
- Boat tab: your boat's profile and photo, boat-shaped chart icon, the lights,
  shapes and fog signals YOU should be showing right now, "What am I looking
  at?" (identify a vessel by its lights or shapes, cross-checked with AIS),
  maintenance schedule and log with how-to video links, and a battery check.
- Chart: NOAA charts, satellite + chart, satellite, or street map (layers button)
- Live GPS: speed, course, trip, and a 10-minute course line ahead of the boat
- Long-press anywhere: distance, bearing and time to that spot; Go to; Save waypoint
- Go to: distance, bearing, ETA, and how far you are off the straight line
- Ruler button: measure between any two points
- MOB: press and hold one second to mark a person overboard and steer back
- Dash: course dial, speed, trip, position, wind forecast, tide at nearest NOAA station
- Anchor watch: circle sized from depth and rode, bow-corrected, 15-second
  delay so GPS jumps don't trigger it, learned swing, wind-shift warning, siren
- Log: record tracks, save waypoints, export GPX
- Night mode, keep-screen-on, units (knots/mph/km/h, nm/miles/km)
- Save charts for offline use (Settings)
- Demo mode (Settings): a simulated trip from Annapolis to the Magothy

LIMITS OF THIS PROTOTYPE
- Keep the app open with the screen on. Phones pause web apps when locked, so
  the anchor alarm only works with the screen on (plug the phone in). The
  ringer must be on to hear the alarm.
- No AIS yet: browsers can't read a boat's AIS receiver or a live AIS feed
  directly. AIS comes with the native app version.
- No depth sounder or boat instruments yet (same reason).
- NOAA charts cover US waters. Elsewhere use Satellite or Street map.
- A navigation aid, not a replacement for official charts, a lookout,
  or good seamanship.

BEFORE YOUR OVERNIGHT TRIP
1. Put it online (steps at the top) and add it to your home screen.
2. Boat tab > Edit: name, your first name, length, beam, draft, air draft, engine,
   anchor type and weight, chain and total rode.
3. With signal, zoom the chart to your route and tap Settings > Save charts for
   this area. Repeat for your anchorage, zoomed in closer.
4. Turn on Demo mode once to hear the voice coach and see the anchor alarm,
   then turn Demo mode off. Tap "Test the alarm sound" with the volume up. Tap "Test the alarm sound" with the volume up.
5. At anchor: plug the phone in, ringer on, screen stays on (Keep screen on),
   and keep Tideline open. Phones pause web apps when locked.
6. Carry your usual backup: paper chart or your current nav app.
