# Tap-to-talk first mate: setup and beta boundaries

This patch adds the first-mate interface and an authenticated AI command interpreter. It is **not connected or deployed**. It requires a separate paid API account; a ChatGPT subscription does not provide the app's API usage.

1. Reuse the app's Supabase account setup under `tools/supabase`. Sign in on Tideline.
2. Deploy this folder as a Cloudflare Worker with Wrangler, using the included rate-limit binding. Assign its namespace ID for your account.
3. Add Worker secrets: `OPENAI_API_KEY`, `SUPABASE_ANON_KEY`. Add variables: `SUPABASE_URL`, `ALLOWED_USER_IDS` (comma-separated Supabase user UUIDs allowed into this beta), `ALLOWED_ORIGIN` (exact origin, initially `https://olbucky1.github.io`), and `OPENAI_MODEL` (a model available to your API project that supports Responses function calling). API keys never go in app.js or GitHub.
4. Set an API project spending limit and alerts. The Worker permits 10 requests per user per minute; start with Andy's account only.
5. In Tideline, open First mate → Connection setup. Save the HTTPS Worker URL.
6. Test signed-out and unauthorized accounts, expired sessions, offline state, denied microphone, ambiguous destinations, no AIS, stationary boat, stale targets, and requests involving alarms or emergency actions. Real API, iPhone microphone and on-water tests remain required.

Supported examples: “Show me the rain coming in”, “Hide wind”, “Take me to Baltimore”, “Bring up the big ship in front of me”, “Show my fishing spots along the way”. Requests use AI interpretation rather than a keyword command list. Multi-action requests ask for clarification in this initial version.

- Weather changes the existing display controls.
- Destination search returns actual geocoder results. Selecting one opens Navigate for review; it does not start guidance automatically.
- AIS “ahead” uses fresh reports and own course over ground, not phone pointing. It presents candidates to select, never identifies a visible vessel with certainty. Requires an AIS feed or demo mode.
- Fishing shows saved spots only, within a 1-nautical-mile route corridor when requested. No public fishing-location feed is supplied.
- Voice input uses browser speech recognition where available. Otherwise use keyboard dictation. Transcription is shown for review before Send. The browser/OS may process speech remotely. No always-listening mode.
- Only request text, current/previous request context, active boat type/name, active destination, and whether GPS is present are sent to the AI. Private logs/photos and other vessels' profiles are omitted. `store:false` is set on API requests; this does not replace the provider's data terms.
- AI cannot disable alarms, trigger MOB, change boat specifications, issue collision instructions, assess depth/bridge clearance, or control vessel equipment.

Implementation follows OpenAI's official function-calling documentation: https://developers.openai.com/api/docs/guides/function-calling
