# Tideline First Mate: AI relay (Claude)

Makes the First Mate conversational. The phone sends what you said plus a small amount of context (position rounded to about 100 m, speed and heading, destination, nearby place names, wind, tide, upcoming events, the last few exchanges). This Worker adds the Anthropic API key and asks Claude, then returns a spoken reply plus up to three app actions (show wind, plan a route, find islands nearby, and so on). The app does the actions; Claude never controls the boat.

## Set up (about 10 minutes)
1. Anthropic API key: console.anthropic.com → API keys → Create key. Set a monthly spend limit (e.g. $20) under Billing.
2. In this folder: `npx wrangler login`, then `npx wrangler deploy`.
3. Secrets: `npx wrangler secret put ANTHROPIC_API_KEY` (paste the key), `npx wrangler secret put BETA_KEYS` (one or more passcodes, comma separated, e.g. `andy-boat-7731,tester-2`).
4. In Tideline: First Mate → ⌨ → AI connection: paste the Worker URL (https://tideline-first-mate.<you>.workers.dev) and your passcode. Save.

The key never goes in app.js or GitHub. Change a passcode any time with `wrangler secret put BETA_KEYS`.

## A real voice (optional, recommended)
The phone's built-in voice sounds robotic. Add one of these to the same Worker and the First Mate speaks with a natural voice:
- ElevenLabs: `npx wrangler secret put ELEVENLABS_API_KEY`, then set `ELEVEN_VOICE_ID` (any voice from their library, or a cloned voice — only with the speaker's written consent).
- or OpenAI: `npx wrangler secret put OPENAI_API_KEY` (optionally `OPENAI_VOICE`, e.g. ash, onyx, sage).
If neither is set, the app keeps using the phone's voice.

## Cost
Each question is one short Claude call: roughly 1,500 tokens in and 150 out. With Haiku that is a fraction of a cent per question; a busy day on the water (100 questions) is well under a dollar. Sonnet costs a few times more and answers history questions more richly. Check current prices at https://www.anthropic.com/pricing.

## Optional
Rate limit: add a Workers rate-limit binding named LIMITER (10 per minute per passcode).
