# CLAUDE.md — Lumière Salon AI Receptionist

Yasmine is an n8n + Google Calendar AI receptionist for a fictional salon. She works on WhatsApp, Messenger, Instagram and the website chat, in EN/FR/ES/AR. `README.md` gives the overview, `SETUP.md` covers setup and import, `CHANGELOG.md` records what changed and why.

## Source of truth and generated files

- **Hand-edited sources:**
  - `Lumiere WhatsApp AI Agent (Cohere Transcribe).json` is the source of the prompt and logic.
  - The 5 `… - Deterministic (Lumiere).json` tool workflows.
  - `engine/engine.js` (booking + concurrency).
  - `engine/confirm.js` (yes/no classifier, language detector).
  - `engine/config.js`, `salon-info.js`, `lumiere.config.js` (IDs, credentials, webhook paths).
- **Generated, never hand-edited:**
  - Messenger (`tools/build-messenger.js`, from WhatsApp).
  - Instagram (`tools/build-instagram.js`, from the Messenger build; the voice path lives here).
  - The 6 `website-demo/*.json` files (`website-demo/build-web-demo.js`).
  - `salon-info-sheet.csv`.
- The builds copy `engine/*.js` into Code nodes. After **any** change to the engine, the classifier or the prompt, rebuild **every** workflow that embeds it and commit the regenerated JSON with the source change.
- The builds contain safety asserts and fail on purpose, for example if the voice confirmation gate or `confirm_via` stop referencing `Merge Voice Text`, or if a prompt describes cancel + re-book. Fix the cause; never remove the assert.

## Commands (PowerShell, from the repo root)

```powershell
node tools/build-workflows.js; node tools/build-messenger.js; node tools/build-instagram.js; node website-demo/build-web-demo.js; node tools/build-salon-sheet.js
```

- The four workflow builders accept `--check` (`build-salon-sheet.js` does not), which verifies the committed JSON is up to date without writing anything.
- `cd tests; npm test; cd ..` runs all suites (currently 16 suites, 291 tests). The tests run the real workflow JSON in an n8n emulator (`tests/lib/runner.js`) with a fake calendar and a scripted AI.
- `node website-demo/tests/web-demo.test.js` runs the website demo checks.
- `node tools/preflight.js` is the offline pre-import check. It must say "Offline checks passed".
- `node tests/integration/instagram-voice-real.js` is not part of `npm test`.
  - Part A: real audio, provider mocked.
  - Part B: the real OpenRouter call. It needs a key in `.env.openrouter-test` (git-ignored; never print it).
  - The emulator runs on a simulated clock, so a real network call cannot be awaited inside it. Capture the request, send it outside, then replay the response.

When the test count changes, update it in `README.md` and `SETUP.md` (checklist line). Every change gets a dated `CHANGELOG.md` entry: what, why, what was rebuilt, what was **not** deployed, and the test count.

## Safety rules (do not weaken)

- **Isolation from other bots.** The same n8n instance runs another client's bots.
  - Never touch their workflows, published state, credentials, calendars or webhooks.
  - `tests/isolation.test.js` and preflight scan their folders next to this repo read-only.
  - Their identifiers, folder names and name patterns live only in the git-ignored `tests/lib/clinic-fingerprints.local.json`. Never commit them or copy them into a tracked file. The repo is public.
  - Salon resources use the `lum…` / `lumWebDemo…` IDs, `LUMIERE - …` credentials and `LUMIERE_*` env vars.
  - WhatsApp, Messenger and Instagram credentials can never be shared.
- **Customer keys** are channel-aware: `wa:<number>`, `fb:<page>:<psid>`, `ig:<account>:<igsid>`. Locks, pending confirmations, memory and ownership are keyed by them.
- **Confirmations.**
  - Only a server-issued Yes/No, answered by typed text, confirms a booking, cancel or change.
  - A voice message never confirms: `viaVoice = $('Merge Voice Text').isExecuted`, and the engine refuses `confirm_via != 'text'` (`not_typed`).
  - The classifier must keep reading messages with extra words or a time ("C'est d'accord pour 15h ?") as `other`, never a yes.
  - Check classifier changes against a broad phrase set in all four languages.
- **Instagram voice.**
  - Download only from Meta CDN hosts (`fbsbx.com|fbcdn.net|cdninstagram.com`), with no token.
  - Check the real format from the magic bytes, 1 KB–10 MB.
  - Transcribe with OpenRouter `openai/whisper-large-v3`, with no `language` field (auto-detect).
  - Every failure gets the 4-language "try again or type" reply through the 24 h window guard.
- All workflows are exported **inactive**.

## Working agreements

- Work locally. **Do not import, activate, publish or deploy** workflows to the live n8n, and do not modify the live website or its domain, unless the user explicitly asks for that specific step. Committing does not mean deploying: the live website demo only changes when it is redeployed.
- **Live environment** (only when asked):
  - n8n 2.34.4 in Docker Desktop (container `n8n-setup-n8n-1`, compose `C:\n8n-setup\docker-compose.yml`, port bound to 127.0.0.1).
  - Exposed through ngrok with a deny-by-default path allowlist (`C:\n8n-setup\ngrok-policy.yml`).
  - The **user** restarts Docker or ngrok and signs in to n8n. Never enter passwords; never print secrets or tokens.
- Don't spend money on providers (OpenRouter credits, etc.) without the user's go-ahead.
- Keep throwaway test tooling (Python venvs, Whisper models, generated audio) outside the repo, in the session scratchpad.
- **Commits:** imperative summary that names the area ("Instagram: …", "Confirmation classifier: …", "C2: …"), plus a body explaining why, what was rebuilt and the test count. `brag-output/` is generated media and is ignored.
- Doc style: short sentences, lists over long paragraphs, honest "Known limits".
