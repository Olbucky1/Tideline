# Tideline AIS relay (free, about 10 minutes)

aisstream.io gives free live AIS, but it does not allow web browsers to connect to it directly. This tiny relay runs on Cloudflare's free tier, keeps your aisstream key private, and passes ships to Tideline.

1. Get a free key: sign in at https://aisstream.io with GitHub, open API Keys, create one.
2. Make a free Cloudflare account at https://dash.cloudflare.com/sign-up.
3. In Cloudflare: Workers & Pages → Create → Create Worker → name it `tideline-ais` → Deploy.
4. Click Edit code, delete what is there, paste everything from `worker.js` in this folder, click Deploy.
5. Settings → Variables and Secrets → Add → type **Secret**, name `AISSTREAM_KEY`, value = your aisstream key → Save and deploy.
6. Copy the worker address (like `https://tideline-ais.yourname.workers.dev`).
7. In Tideline: Map options → AIS boats → paste the address → Save.

Ships that broadcast AIS within about 20 nm appear within a minute or two. Small boats without AIS will not show.

## Optional: relay with memory (shows moored boats straight away)
`worker-with-memory.js` adds a Durable Object that remembers every boat heard in the last 3 hours and sends them to the app the moment it connects, then keeps streaming live. Deploy it in place of `worker.js` with the `wrangler.toml` shown at the top of the file (Durable Objects with SQLite storage are on Cloudflare's free plan).

Why fewer boats than MarineTraffic: MarineTraffic has thousands of its own receivers plus satellite AIS, and shows last-known positions going back hours or days. aisstream.io is a free feed from volunteer receivers, so coverage in creeks and harbors is thinner, and a moored boat only appears once one of its reports is heard. Putting a small AIS receiver on a dock (and sharing it with aisstream) is the cheapest way to fill in your own area.
