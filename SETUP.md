# Lumière salon — isolated setup guide

This guide sets up the salon bots with **their own** Google Calendar, Google Sheet, WhatsApp number, credentials and environment variables, so they can run on the same n8n instance as other bots without touching them.

Nothing in this project contacts Google, Meta or n8n. You do every step below yourself, in this order. `node tools/preflight.js` checks everything that can be checked offline.

## What is isolated

| Resource | Other bots | Lumière | Where it is set |
|---|---|---|---|
| Google Calendar | their calendars | `google.CALENDAR_ID` (salon) + `websiteDemo.CALENDAR_ID` (public demo) | `lumiere.config.js` |
| Google Sheet | their sheet | `google.SHEET_ID`, tabs by name | `lumiere.config.js` |
| n8n credentials | their credentials | own `LUMIERE - …` WhatsApp/Messenger credentials; Google, OpenRouter and Cohere shared on purpose (`SHARED_CREDENTIALS`) | `lumiere.config.js` |
| WhatsApp number, token, staff number | `CLINIC_*` env vars | `LUMIERE_*` env vars | n8n environment (`lumiere.env.example`) |
| Workflow IDs | clinic IDs, `othWebDemo…` | `lum…`, `lumWebDemo…` | `lumiere.config.js` |
| Webhook paths | `other-bot-messenger`, `other-website-demo` | `lumiere-messenger`, `lumiere-instagram`, `lumiere-website-demo` | `lumiere.config.js` |
| Calendar lock objects | `otherbotlock…`, `othdemolock…` | `lumierelock…`, `lumdemolock…` | engine config (generated) |
| Timezone | — | `TIMEZONE` (fixed offset only; the build refuses DST zones) | `lumiere.config.js` |

`tests/isolation.test.js` (10 tests) and `tools/preflight.js` fail if any Lumière file contains another bot's ID, calendar, sheet, credential (except the account-level ones listed in `SHARED_CREDENTIALS`), webhook, lock ID, `CLINIC_*` variable or notification number. They read the other bots' folders next to this project **read-only**. Those bots' identifiers and folder names come from the git-ignored `tests/lib/clinic-fingerprints.local.json`; without it, the checks run on the generic rules and the salon's own resources.

---

## Step 1 — Google Calendars (two new calendars)

1. Open Google Calendar with the Google account that n8n will use for the salon.
2. **Settings → Add calendar → Create new calendar**. Name it `Lumière Salon`. Time zone: **(GMT+01:00) Algeria** (or the zone you set in `TIMEZONE`; it only affects how Google displays events, because the bot always writes explicit times). Click **Create calendar**.
3. Open the calendar's settings → **Integrate calendar** → copy the **Calendar ID** (`…@group.calendar.google.com`).
4. Repeat for the public website demo: a second calendar named `Lumière Demo`. Ideally create it in a separate Google account used only for the demo. Visitors can write to it, and every event is deleted after 24 hours.
5. Do **not** reuse another bot's calendar. The two Lumière calendars must also differ from each other.

## Step 2 — Google Sheet (one new spreadsheet)

1. In Google Drive (same account as the `LUMIERE - Google Sheets` credential), create a new spreadsheet, e.g. `Lumière Salon - Bot data`.
2. Create three tabs with **exactly** these names and header rows (row 1):

| Tab | A1 | B1 | C1 | D1 |
|---|---|---|---|---|
| `Active_Handoffs` | `Patient_ID` | `Status` | `Timestamp` | |
| `ConversationLog` | `Timestamp` | `Phone` | `PatientMessage` | `BotReply` |
| `Salon_Info` | `Field` | `Value` | | |

   The column names are the ones the workflows write. `Patient_ID` holds the customer's number or `fb:<id>`.
3. Select column A of `Active_Handoffs` → **Format → Number → Plain text**, so long numbers are not rounded.
4. Fill `Salon_Info`: run `node tools/build-salon-sheet.js`, open `salon-info-sheet.csv`, and paste its rows from A1 (or **File → Import → Upload → Replace current sheet** while the `Salon_Info` tab is open). Then check the **Phone** row: Sheets reads a value starting with `+` as a formula and shows `#ERROR!`. Retype it with a leading apostrophe (`'+00 000 …`).
5. Copy the spreadsheet ID from its URL: `https://docs.google.com/spreadsheets/d/<THIS PART>/edit`.

## Step 3 — `lumiere.config.js`

Replace the three placeholders and check the other values:

```js
google: { CALENDAR_ID: '<salon calendar ID>', SHEET_ID: '<sheet ID>', ... },
websiteDemo: {
  CALENDAR_ID: '<demo calendar ID>',
  PUBLIC_WEBHOOK_URL: 'https://<your n8n public URL>/webhook/lumiere-website-demo',
  ALLOWED_ORIGINS: ['https://<where the website is served>'],
  ...
}
```

`TIMEZONE`/`TZ_OFFSET_MIN` must be a zone **without daylight saving time** (the engine uses a fixed offset; the build refuses DST zones such as `Europe/Madrid`). Leave the credential names and workflow IDs as they are unless you have a reason to change them.

Then rebuild and check:

```powershell
node tools/build-workflows.js; node tools/build-messenger.js; node tools/build-instagram.js; node website-demo/build-web-demo.js; node tools/build-salon-sheet.js
```

```powershell
node tools/preflight.js
```

## Step 4 — WhatsApp Business (the salon's own number and Meta app)

Use a **separate Meta app** for the salon. The WhatsApp Trigger registers the app's webhook when the workflow is activated, so sharing another bot's Meta app would redirect its messages to the salon bot.

1. [developers.facebook.com](https://developers.facebook.com) → **Create app** → type **Business** → add the **WhatsApp** product, linked to the salon's WhatsApp Business Account.
2. **WhatsApp → API Setup → Add phone number**: a number that is **not** used by another bot and not active in the WhatsApp/WhatsApp Business app. Verify it.
3. Note the **Phone number ID** and the **WhatsApp Business Account ID**.
4. **Business Settings → System users → Add** (admin) → assign the app and the WhatsApp account → **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`. This is the permanent access token.
5. **App settings → Basic**: note the **App ID** and **App secret** (for the trigger credential).

Messenger (optional): add the **Messenger** product to the salon app and connect the salon's Facebook Page (see `MESSENGER-SETUP.md`). Callback URL: `https://<your n8n>/webhook/lumiere-messenger`.

Instagram Direct (optional): in the same salon app (verify first that it is not another bot's app), add Instagram messaging for the salon's Instagram professional account linked to the salon Page (see `INSTAGRAM-SETUP.md`). It has its **own** webhook: `https://<your n8n>/webhook/lumiere-instagram`. The Messenger webhook stays as it is.

## Step 5 — n8n credentials

**Current setup (2026-11-24): account-level credentials are shared.** The older bot bot is being retired, so the salon reuses the existing Google, OpenRouter and Cohere credentials (`SHARED_CREDENTIALS` in `lumiere.config.js`). This is safe because the salon still has its own calendars, sheet, workflow IDs and lock objects. WhatsApp and Messenger can **never** be shared: the build, tests and preflight refuse it.

| Credential (exact id + name in `lumiere.config.js`) | n8n type | What to enter | Used by |
|---|---|---|---|
| `Google Calendar account` (shared) | Google Calendar OAuth2 API | nothing - already connected; its Google account must own or have edit access to the salon calendar | Engine Calendar API nodes, Find/Check calendar nodes |
| `Google Sheets account` (shared) | Google Sheets OAuth2 API | nothing - its account must have edit access to the salon sheet | handoff, log and Get Clinic Info nodes |
| `OpenRouter account` (shared) | OpenRouter API | nothing | OpenRouter Chat Model |
| `Header Auth account` (shared, Cohere) | Header Auth | nothing | Cohere Transcribe |
| `DEMO - Google Calendar` (shared) | Google Calendar OAuth2 API | nothing - its account must have edit access to the demo calendar | website demo |
| `DEMO - OpenRouter` (shared) | OpenRouter API | nothing | website demo |
| `LUMIERE - WhatsApp Trigger (OAuth)` | WhatsApp OAuth API | salon app's App ID (Client ID) + App secret (Client Secret) | WhatsApp Trigger |
| `LUMIERE - WhatsApp API` | WhatsApp API | permanent token (step 4.4) + WhatsApp Business Account ID | all WhatsApp send nodes, error workflow |
| `LUMIERE - Facebook Page Token` | Header Auth | Name `Authorization` (pre-filled), Value `Bearer <salon Page token>` | Messenger send/profile nodes |
| `LUMIERE - Instagram Page Token` (id `lumIgPageToken01`) | Header Auth | Name `Authorization`, Value `Bearer <salon Page token with instagram_manage_messages>` | Instagram send/profile nodes |

The first three `LUMIERE - …` credentials were created empty in n8n with these exact ids, so every node is already linked: open each one under **Credentials** and fill it in. **`LUMIERE - Instagram Page Token` does not exist in n8n yet**: create it with exactly this name and id before importing the Instagram workflow (`INSTAGRAM-SETUP.md` step 2).

To go back to fully separate credentials: create new `LUMIERE - …` credentials, put their ids and names in `lumiere.config.js`, empty both `SHARED_CREDENTIALS` lists, rebuild and re-import.

## Step 6 — n8n environment variables

Add the variables from `lumiere.env.example` to the n8n instance environment (docker-compose `environment:`, the systemd/PM2 env, or n8n's `.env`), with the **salon's** values, then **restart n8n**:

| Variable | Value |
|---|---|
| `LUMIERE_WHATSAPP_PHONE_NUMBER_ID` | salon Phone number ID (step 4.3) |
| `LUMIERE_WHATSAPP_ACCESS_TOKEN` | salon permanent token (step 4.4) |
| `LUMIERE_STAFF_CHAT_ID` | salon staff WhatsApp number for alerts, digits with country code, no `+` |
| `LUMIERE_MESSENGER_VERIFY_TOKEN` | any long random string (Messenger only) |
| `LUMIERE_MESSENGER_APP_SECRET` | salon app's App secret (Messenger only) |
| `LUMIERE_MESSENGER_PAGE_ID` | salon Page ID (optional) |
| `LUMIERE_INSTAGRAM_VERIFY_TOKEN` | another long random string, not the Messenger one (Instagram only) |
| `LUMIERE_INSTAGRAM_APP_SECRET` | salon app's App secret (Instagram only, required) |
| `LUMIERE_INSTAGRAM_ACCOUNT_ID` | salon Instagram professional account ID (Instagram only, required) |

Other bots' `CLINIC_*` variables stay as they are; the Lumière workflows never read them. `N8N_BLOCK_ENV_ACCESS_IN_NODE` must be `false` (as for the other bots). Unset Lumière variables fail closed: sends fail and staff are not messaged, rather than falling back to another bot's number.

## Step 7 — Voice notes (choose the one supported language)

Cohere Transcribe needs the audio language in every request and has no automatic detection. So **voice notes are supported only in `VOICE_LANGUAGE`** (`engine/config.js`, default `es`):

- `cohere-transcribe-03-2026` with `es`, `en`, `fr` or `ar`; or `cohere-transcribe-arabic-07-2026` with `ar`. The build refuses any other combination.
- The AI is told the voice language on every voice message. For a voice note in another language, it asks the customer to type instead of guessing.
- No voice language has been verified with live audio in this project yet. Test the one you choose (checklist below) before telling customers voice notes work.
- WhatsApp voice notes are OGG/Opus (Cohere accepts `.ogg`). Messenger clips are MP4/AAC, which Cohere's documentation does not list, so treat Messenger voice notes as unsupported until tested.

## Step 8 — Import into n8n (all inactive)

1. Start from the **Workflows list** → **Add workflow → Import from file** (or the list's import action). **Never** use "Import from file" from inside another open workflow: that replaces the open workflow's content.
2. Import in this order: `Salon Error Alert (Lumiere).json` → the 5 tool workflows → `Lumiere WhatsApp AI Agent (Cohere Transcribe).json` → `Lumiere Messenger AI Agent.json` (optional) → `Lumiere Instagram AI Agent.json` (optional) → the 6 files in `website-demo/` (optional).
   **After the customer-key update (2026-11-25):** the 5 tool workflows, WhatsApp and Messenger changed too. Re-import all of them together (the tools need the new `customer_key` input, and their caller list includes `lumInstagramMain`), then re-publish the 5 tools.
3. Every file arrives **inactive**, with its `lum…` ID, so the import creates new workflows and never overwrites another bot's workflow.
4. Credentials are linked by id (step 5); only a node whose credential is missing shows a warning. Alternative to steps 1-3 that keeps the IDs for certain (Docker): `docker exec <container> n8n import:workflow --separate --input=<folder>` (done this way on 2026-11-24).
5. Check the WhatsApp, Messenger and Instagram main workflows: **Settings → Error workflow** = `Salon Error Alert (Lumière)` (pre-filled with ID `lumErrorAlert001`).

## Step 9 — Go live (when you decide)

1. Publish the 5 tool workflows (tools must be active to be called; they have no trigger).
2. Activate `Lumière WhatsApp AI Agent` (registers the salon app's WhatsApp webhook).
3. Run the live test plan in `README.md` from a test phone. Check the salon calendar and sheet, and that **no** other bot's calendar, sheet or staff number received anything.
4. Website demo: publish the 6 demo workflows, deploy `website-demo/site/index.html`, and run the test script in `website-demo/README.md`.

---

## Final pre-import checklist

Run `node tools/preflight.js` first: it ticks the offline items and exits with an error while one is missing.

**Configuration (offline, checked by preflight)**
- [ ] `google.CALENDAR_ID` = the new `Lumière Salon` calendar (no `PASTE_`)
- [ ] `google.SHEET_ID` = the new salon spreadsheet (no `PASTE_`)
- [ ] `websiteDemo.CALENDAR_ID` = the new `Lumière Demo` calendar, different from the salon calendar
- [ ] `websiteDemo.PUBLIC_WEBHOOK_URL` = `https://<n8n>/webhook/lumiere-website-demo`; `ALLOWED_ORIGINS` = the website's origin
- [ ] Builds re-run after editing; `node tools/preflight.js` says "Offline checks passed"
- [ ] `cd tests; npm test` → ALL SUITES PASSED (228 tests)

**Google (manual)**
- [ ] Both calendars exist, and the n8n Google accounts can **make changes to events** on them
- [ ] Sheet has tabs `Active_Handoffs`, `ConversationLog`, `Salon_Info` with the exact headers; `Active_Handoffs` column A is plain text; `Salon_Info` filled from `salon-info-sheet.csv`

**Meta / WhatsApp (manual)**
- [ ] Salon WhatsApp number on a **separate Meta app** (not another bot's app or number)
- [ ] Permanent system-user token, Phone number ID and WhatsApp Business Account ID noted
- [ ] (Messenger) salon Page connected, callback `…/webhook/lumiere-messenger`
- [ ] (Instagram) salon Meta app confirmed separate from every other bot's app; Instagram professional account linked to the salon Page; "Allow access to messages" on; Instagram webhook `…/webhook/lumiere-instagram` with field `messages`; Advanced Access (App Review + Business Verification) before real customers - see `INSTAGRAM-SETUP.md`

**n8n (manual)**
- [ ] The `LUMIERE - …` credentials (WhatsApp Trigger, WhatsApp API, Facebook Page Token, and - for Instagram - the new Instagram Page Token) created / filled in; the only other credentials on Lumière nodes are the shared ones in `SHARED_CREDENTIALS`
- [ ] `LUMIERE_*` environment variables set with salon values; n8n restarted
- [ ] Imports done from the Workflows list (never into another open workflow); everything still **inactive**
- [ ] The other bots' workflows are untouched: same IDs, still active, same credentials, same `CLINIC_*` variables
- [ ] Voice language chosen (`VOICE_LANGUAGE`) and scheduled for a live voice-note test before announcing voice support
