# Tideline lightning relay

Live lightning strikes come from a commercial lightning network. This relay keeps the provider's key secret and hands Tideline a simple list of strikes.

1. Get an Xweather (Vaisala) account with the Lightning endpoint (they have a free developer trial): https://www.xweather.com/
2. `npm create cloudflare@latest tideline-lightning` → replace `src/index.js` with `worker.js`.
3. `npx wrangler secret put XW_ID` and `npx wrangler secret put XW_SECRET` with your Xweather client ID and secret.
4. `npx wrangler deploy` → copy the `https://tideline-lightning.<you>.workers.dev` address.
5. In Tideline: tap the lightning chip (or Layers → Lightning, then Menu → … ) → Lightning feed → paste the address → Save.

Blitzortung.org data is community-run and not licensed for apps without their permission, so it is not used here.
