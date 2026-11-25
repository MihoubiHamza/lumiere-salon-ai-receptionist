# Lumière on Facebook Messenger — setup guide

The Messenger version is a **separate workflow**:
[Lumiere Messenger AI Agent.json](Lumiere%20Messenger%20AI%20Agent.json).
It does not replace or modify the WhatsApp workflow. Both run side by side.

## What is shared and what is different

| | WhatsApp | Messenger |
|---|---|---|
| AI prompt, tools, safety checks (Sanitize, escalation, chat lock) | original | same rules, Messenger wording |
| Calendar tools (Book / Cancel / Reschedule / Find / Check) | the 5 sub-workflows | **the same 5 sub-workflows** (unchanged) |
| Double-booking protection | calendar write lock | **the same lock**: a WhatsApp and a Messenger customer can never get the same slot |
| Customer identity | WhatsApp number (verified by Meta) | Messenger sender ID (PSID, verified by Meta's signature) |
| Customer's phone number | automatic | Yasmine **asks for it** and saves it in the booking notes (`Messenger - Tel: …`) |
| Replies to the customer | WhatsApp | Messenger (long replies over 2000 characters are sent as 2 messages) |
| Staff alerts | WhatsApp to staff | **WhatsApp to staff** (same number, same credential) |
| Pause after escalation | `Active_Handoffs` row = phone | `Active_Handoffs` row = `fb:<PSID>` |
| Re-enable the bot | staff send `!unmute <number>` on WhatsApp | staff set that row's **Status** to `unmuted` (or delete the row) |

In Google Calendar, a Messenger booking looks like this:
`Phone: 24906340422315839. Notes: Messenger - Tel: +34 600 000 000 | Lucía Fernández`.
The long "Phone" value is the Messenger ID and is used by the bot to find the appointment again. **The salon should call the number after `Tel:`.**

## One-time setup

### 1. Meta (Facebook) app
You can use the Meta app that already runs WhatsApp, or create a new one (type "Business").
1. Add the **Messenger** product to the app, and connect the salon's Facebook Page.
2. **Messenger → Messenger API Settings → Access tokens**: generate a **Page access token** for the salon Page. For production, use a long-lived token (for example a System User token from Meta Business Settings with the `pages_messaging` permission) so it does not expire.
3. **App settings → Basic → App secret**: copy it. You will need it in step 2.

### 2. n8n environment variables
Add these salon variables (see `lumiere.env.example` and SETUP.md step 6), then restart n8n:

| Variable | Value |
|---|---|
| `LUMIERE_MESSENGER_VERIFY_TOKEN` | any long random string you choose (used once, when Meta verifies the webhook) |
| `LUMIERE_MESSENGER_APP_SECRET` | the App secret from step 1.3. **Required**: without it, every message is rejected |
| `LUMIERE_MESSENGER_PAGE_ID` | optional: the Page ID. If set, events from any other Page are ignored |

Staff alerts use the salon's `LUMIERE_WHATSAPP_PHONE_NUMBER_ID`, `LUMIERE_WHATSAPP_ACCESS_TOKEN` and `LUMIERE_STAFF_CHAT_ID` (never other bots' `CLINIC_*` variables).

### 3. n8n credential for the Page token
**Credentials → Add credential → Header Auth**:
- Credential name: `LUMIERE - Facebook Page Token` (exact name from `lumiere.config.js`; select it on each node after import)
- Name: `Authorization`
- Value: `Bearer <Page access token>`

### 4. Import and configure the workflow
1. **Workflows → Import from file** → `Lumiere Messenger AI Agent.json`. It imports **inactive**, with its own ID (`lumMessengerMain`), so it cannot overwrite the WhatsApp workflow or another bot's Messenger workflow.
2. Open these nodes and check that each one has a credential selected (pick it if n8n shows a warning):
   - `LUMIERE - Facebook Page Token`: Send Messenger Reply, Send Messenger Reply (part 2), Send Fallback Reply, Send Unsupported Reply, Send Voice Failed Reply, Get Messenger Profile
   - The same `LUMIERE - …` credentials as the WhatsApp workflow: Google Sheets, Google Calendar (the Engine nodes), OpenRouter, Cohere, WhatsApp API (Alert Staff nodes)
3. The five tool nodes (Book_Appointment, etc.) point to the Lumière sub-workflows by ID. Open one to confirm that it shows the correct workflow.
4. **Workflow settings → Error workflow** → `Salon Error Alert (Lumière)`.
5. **Activate** the workflow.

### 5. Connect the webhook in Meta
1. **Messenger → Messenger API Settings → Configure webhooks**:
   - Callback URL: `https://<your-n8n-domain>/webhook/lumiere-messenger`
   - Verify token: the same value as `LUMIERE_MESSENGER_VERIFY_TOKEN`
   - Click **Verify and save**. The `Messenger Webhook (verify)` node answers Meta's check.
2. Subscribe the **Page** to the webhook fields `messages` and `messaging_postbacks`.
3. **Going public:** while the Meta app is in *Development* mode, only people who have a role on the app (admins, developers, testers) can talk to the bot. For real customers, the app needs **App Review approval for `pages_messaging`** and must be switched to **Live**.

### 6. Optional: Get Started button
On the first contact, Messenger can show a "Get Started" button. Yasmine treats a tap on it as a greeting. You can enable it with Meta's Messenger Profile API (`get_started` payload), but it is not required.

## Test checklist (after activation)
1. Message the Page from an account that has a role on the app: "Hola". Yasmine should answer on Messenger, in Spanish.
2. Send a voice note. It should be transcribed and answered. *Voice notes are supported only in the configured `VOICE_LANGUAGE`, and Messenger clips are MP4/AAC, which Cohere's documentation does not list (flac, mp3, mpeg, mpga, ogg, wav). Treat Messenger voice notes as unsupported until this test passes; if Cohere rejects them, the customer gets the "couldn't understand the voice note" reply.*
3. Book a test appointment. Yasmine should ask for your mobile number. The event should show `Notes: Messenger - Tel: …`.
4. Ask "when is my appointment?" from the same account. The booking should be found.
5. Say you want to talk to a human. Staff should get a WhatsApp alert marked `[Messenger]` with the customer's name. After that the bot stays silent. Then set the `fb:…` row in `Active_Handoffs` to `unmuted`, and the bot should answer again.
6. In n8n **Executions**, every message appears twice: first the webhook run (receive and verify), then the message's own run (starting at `Messenger Event`). A run that ends at `Rejected - Bad Signature` means `LUMIERE_MESSENGER_APP_SECRET` is wrong or missing.

## How staff work with Messenger customers
- Staff alerts arrive on **WhatsApp**, marked `[Messenger]`, with the customer's Facebook name and last message.
- Staff reply to the customer from the **Facebook Page inbox** (Meta Business Suite).
- To give the conversation back to Yasmine, open the `Active_Handoffs` sheet, find the row `fb:<id>` named in the alert, and set **Status** to `unmuted` (or delete the row).
  The WhatsApp `!unmute` command cannot be used for Messenger customers: a Messenger ID has 16–17 digits, and Google Sheets would round it as a number. That is why Messenger rows use the `fb:` prefix.
- To make Yasmine stop answering a Messenger customer without an escalation, add a row `Patient_ID = fb:<id>`, `Status = paused`. (`Patient_ID` is the existing column name in the sheet; it holds the customer ID.) The ID and the customer's name appear in the `Phone` column of `ConversationLog`.

## Things that behave differently from WhatsApp
- A booking made on Messenger is managed from that Messenger conversation. A booking made on WhatsApp or by phone is not found automatically on Messenger: Yasmine asks for the number it was booked with (the existing "booked from a different number" procedure).
- A Messenger booking cannot be managed from WhatsApp (the WhatsApp bot looks up the WhatsApp number). Staff can always handle it manually.
- If you later add appointment reminders that message the `Phone:` of each event, skip events whose notes start with `Messenger -` (their `Phone:` is a Messenger ID, not a phone number).

## Maintenance
The Messenger workflow is **generated** from the WhatsApp workflow by `tools/build-messenger.js`, so prompt and logic changes stay in sync. After any change to the WhatsApp workflow, `salon-info.js` or `engine/config.js`:
```
node tools/build-workflows.js
node tools/build-messenger.js
cd tests && npm test
```
Then re-import the Messenger workflow. Do not edit the Messenger workflow by hand in n8n: the next build overwrites the changes. The test `MG1` fails while the Messenger file is out of date.

## Not verified live (no Meta/n8n environment was available)
All logic is covered by executable tests (`tests/messenger.test.js`, 25 tests), but these points need a real check:
- n8n's Webhook node **Raw Body** option on your n8n version. If the raw body is not exposed, the signature is verified from Meta's escaped JSON format. Both paths are tested, but check that a real message is not rejected.
- The self-call (`Process Each Message` → `Messenger Event` via `$workflow.id`, "don't wait for sub-workflow").
- Cohere transcription of Messenger's MP4/AAC voice clips.
- The Page token's permission to read first/last name (`Get Messenger Profile`). If this fails, everything still works, but alerts show no name.
