# Lumière on Instagram Direct — setup guide

The Instagram version is a **separate workflow**:
[Lumiere Instagram AI Agent.json](Lumiere%20Instagram%20AI%20Agent.json) (ID `lumInstagramMain`).
It is **generated** by `tools/build-instagram.js` from the Messenger build, which is generated from the WhatsApp workflow. It does not replace or change the WhatsApp or Messenger workflows. All three run side by side.

**Nothing in this project contacts Meta, Google or n8n.** Every step below is yours. The workflow is exported **inactive**.

It uses **Instagram messaging through the Messenger Platform** ("Instagram API with Facebook Login"):
- an Instagram **professional** account (Business or Creator), linked to the salon's Facebook Page;
- a **Page access token** that has `instagram_manage_messages`;
- the Send API `POST https://graph.facebook.com/v25.0/me/messages`;
- webhooks of object `instagram`.

"Instagram API with Instagram Login" is **not** supported (not implemented).

## What is shared and what is different

| | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| AI prompt, tools, confirmation gate, chat lock, safety checks | original | same rules | same rules, Instagram wording |
| Calendar tools (Book / Cancel / Reschedule / Find / Check) | the 5 sub-workflows | same 5 | **same 5** (they now also accept `lumInstagramMain` as a caller) |
| Double-booking protection | calendar write lock | same lock | **same lock** |
| Customer identity (customer key) | `wa:<number>` | `fb:<page_id>:<psid>` | `ig:<instagram_account_id>:<igsid>` |
| Customer's phone number | automatic | Yasmine asks for it | Yasmine asks for it (`Instagram - Tel: …` in the notes) |
| Message types | text + voice (one configured language) | text + voice (one configured language) | **text + voice in English, French, Spanish and Arabic** (language detected automatically); replies are always text; photos, videos, stickers, reels and shared posts get a friendly "text or voice" reply |
| Reply length | WhatsApp | split at 2000 characters | split into parts of **at most 990 UTF-8 bytes** (fewer than 1,000 characters) |
| 24-hour window | — | — | **enforced before every send** |
| Automated-assistant disclosure | — | — | first reply of each conversation window, and on every fixed reply |
| Staff alerts | WhatsApp | WhatsApp `[Messenger]` | WhatsApp `[Instagram]` |
| Pause after escalation | row = number | row = `fb:<page_id>:<psid>` | row = `ig:<account_id>:<igsid>` |

In Google Calendar, an Instagram booking looks like this:
`Customer: ig:17841400000000001:5512345678901234. Notes: Instagram - Tel: +34 600 000 000 | Lina Haddad`.
The `Customer:` field links the appointment to this Instagram conversation only. **The salon should call the number after `Tel:`.**

## Customer isolation (why the key matters)

Every customer is identified by a **channel-aware key**, never by bare digits (`engine/engine.js`, `customerOf`). Each of these is keyed by it:
- the chat lock;
- the pending cancel / reschedule confirmation;
- the AI memory session;
- the pause row;
- the appointment owner.

So an Instagram customer **never** shares any of these with a WhatsApp number, a Messenger user (even with identical digits), another Instagram account, or a website-demo session. `tests/instagram.test.js` (I11–I14), `tests/unit.engine.test.js` (U10–U12) and `tests/confirmation.test.js` (K12) check this.

## Meta requirements (checked against Meta's documentation on 2026-11-25)

Sources: [Instagram messaging – get started](https://developers.facebook.com/docs/messenger-platform/instagram/get-started), [Send API](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message), [Webhooks](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook), [Messenger Platform overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview), [instagram_manage_messages](https://developers.facebook.com/docs/permissions/reference/instagram_manage_messages), [Platform policy](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview), [User profile](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/user-profile).

**Accounts**
- The salon Instagram account is a **professional** account (Business or Creator).
- It is **connected to the salon Facebook Page**.
- The person setting it up can perform **MODERATE** tasks on that Page.
- In the Instagram app: **Settings → Messages and story replies → Message controls → Connected tools → "Allow access to messages" = on**.

**Permissions** (on the Page token):
- `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`;
- for the profile lookup (customer name in staff alerts), also `pages_read_engagement` and `pages_show_list`.

Meta lists `business_management` as a dependency of `instagram_manage_messages`.

**Access levels**
- **Standard Access** (default) only works with people who have a **role on the app or Page**: admins, developers, testers. Meta: "Apps with Standard Access can only send messages to people that have a role on the app."
- To answer real customers you need:
  - **Advanced Access** through **App Review** (use-case description and screencast);
  - **Business Verification**, which Meta requires for every app requesting Advanced Access.
- The app must be **published** (Live) to receive webhooks, regardless of App Review status.

**Webhooks**
- Object `instagram`. Subscribe at least the field **`messages`**.
- `messaging_postbacks` is optional: Ice Breakers and button taps are read as text.
- Do not subscribe `messaging_seen`, `message_reactions` or `standby`. The workflow ignores them anyway.

**Messaging rules**
- Standard messaging window: **24 hours** after the customer's last message (up to 7 days after a click-to-Direct ad). The workflow refuses to send outside 24 h, minus a 5-minute margin.
- Text limit: Meta's Send API page states both "less than 1,000 characters" and "1,000 bytes or less". The workflow enforces both, with a margin.
- Disclosure: Meta's policy requires automated chat experiences to disclose that a person is talking to an automated service "when required by applicable law". Meta also recommends it in all other cases. Yasmine does both (see Disclosure below).
- Meta's policy asks automated bots to respond within **30 seconds**. A normal turn is well under that. A turn that waits for the per-customer lock or retries the AI can take longer. If you submit the experience as automated, check this in a live test, or set the Page's response mode to hybrid (Page Settings → Advanced Messaging).

**Not verified in Meta's documentation (check before going live)**
- Whether the `HUMAN_AGENT` tag (7-day human reply window) works for Instagram, and which permission it needs. The workflow never uses message tags, so **staff must reply within 24 h** of the customer's last message.
- Whether a Page subscription (`/{page-id}/subscribed_apps`) is also needed. The setup steps below include it, as for Messenger.
- That Graph API `v25.0` (used by Messenger and Instagram here) is still served. Meta's newest sample uses v27.0.
- Send API rate limits (the documentation page was not reachable).

## One-time setup

### 1. Meta app — reuse the salon's Messenger app, never another bot's app
1. Confirm that the Meta app you use is the **Lumière salon app**: its App ID must not appear in any other project or another bot's n8n credential. This project does not store the salon's App ID, so this check is manual.
2. In that app, add the **Instagram** messaging use case (Messenger Platform / "Instagram API with Facebook Login"). Connect the salon Facebook Page that is linked to the salon Instagram account.
3. **Do not change the Messenger webhook or its Page subscriptions.** Instagram gets its own webhook (step 4).
4. Generate a **Page access token** for the salon Page with the permissions above. For production, use a long-lived System User token.

### 2. n8n credential (new, empty until you fill it)
**Credentials → Add credential → Header Auth**, with **exactly** this name and id (`lumiere.config.js`):
- Name: `LUMIERE - Instagram Page Token`, id `lumIgPageToken01`
- Header Name: `Authorization`
- Value: `Bearer <salon Page token with instagram_manage_messages>`

This is a separate credential from `LUMIERE - Facebook Page Token`, so either can be rotated or revoked on its own. It may hold the same Page token. The build, tests and preflight refuse to share it with the other bots.

### 2b. Voice messages: speech-to-text credential (new)
Instagram voice messages are transcribed by **OpenRouter speech-to-text** (`openai/whisper-large-v3`), which detects the spoken language automatically (English, French, Spanish, Arabic). Cohere, used on WhatsApp and Messenger, needs one fixed language and is not used here.
1. In OpenRouter, create a **salon-only API key** with a **spending limit** (for example a few euros per month). Never reuse another bot's key.
2. **Credentials → Add credential → Header Auth**, with exactly this name and id:
   - Name: `LUMIERE - OpenRouter Transcription`, id `lumOrTranscribe1`
   - Header Name: `Authorization`
   - Value: `Bearer <the salon OpenRouter key>`

How a voice message is handled:
- The audio link in Meta's webhook is a pre-signed link on Meta's media CDN. It is downloaded **only** if it is HTTPS on `fbsbx.com`, `fbcdn.net` or `cdninstagram.com`, and **no token is ever sent to it**.
- The real audio format is read from the file's first bytes (M4A/MP4, AAC, Ogg, WebM, WAV, MP3, FLAC). Files under 1 KB or over 10 MB, and anything that is not audio, get the friendly reply.
- The transcript reaches Yasmine as the customer's message, marked as a voice note with the detected language. She replies in text in that language; if the audio language and the transcript disagree, she follows the transcript's language or asks the customer to type.
- Empty or unintelligible audio, a language other than the four, a failed download or a failed transcription: the customer gets "Sorry, I couldn't understand this voice message. Please try again or type your message." in four languages. Nothing technical is ever shown.
- **A voice message never confirms** a booking, cancellation or reschedule: a spoken "yes" gets "For your security, a voice message cannot confirm this change. Please type Yes or No."
- Cost: about $0.00045 per minute of audio (OpenRouter list price, 2026-11-26) plus the normal AI reply.

### 3. n8n environment variables (then restart n8n)
| Variable | Value |
|---|---|
| `LUMIERE_INSTAGRAM_VERIFY_TOKEN` | a long random string, **different** from the Messenger verify token |
| `LUMIERE_INSTAGRAM_APP_SECRET` | the salon app's App Secret. **Required**: without it every request is rejected |
| `LUMIERE_INSTAGRAM_ACCOUNT_ID` | the salon Instagram professional account ID. **Required**: only events for this account are processed |

Staff alerts reuse `LUMIERE_WHATSAPP_PHONE_NUMBER_ID`, `LUMIERE_WHATSAPP_ACCESS_TOKEN` and `LUMIERE_STAFF_CHAT_ID`.

### 4. Import, then connect the webhook
1. Import the Instagram workflow **from the Workflows list** (never into an open workflow). Then **re-import and re-publish the 5 tool workflows**: their caller list now includes `lumInstagramMain`.
2. Check **Workflow settings → Error workflow** = `Salon Error Alert (Lumière)`.
3. Activate the workflow only when you are ready to test.
4. In the Meta app, Webhooks, object **Instagram**:
   - Callback URL: `https://<your-n8n-domain>/webhook/lumiere-instagram`
   - Verify token: the `LUMIERE_INSTAGRAM_VERIFY_TOKEN` value
   - **Verify and save**, then subscribe the field `messages` (optionally `messaging_postbacks`).

## Test checklist (from an Instagram account that has a role on the app)
1. Send "Hello". Yasmine answers in English. The first reply starts with the automated-assistant disclosure.
2. Send a voice message in each language (English, French, Spanish, Arabic): Yasmine answers in text, in that language. Send a photo: you get the "text or voice" reply. **Before going live, this real-device test is required**: Meta does not document the audio format of received Instagram voice messages, so check in n8n **Executions** that `Check Voice File` recognised it and `Transcribe Voice` succeeded.
3. Book an appointment. Yasmine asks for your mobile number. The calendar event starts with `Customer: ig:…` and the notes with `Instagram - Tel: …`.
4. Ask "when is my appointment?" It is found. From Messenger or WhatsApp it is **not** found automatically.
5. Ask to cancel. The **server** asks Yes/No. Answer with a **voice** "yes": nothing is cancelled and you are asked to type. Then type "yes": it is cancelled.
6. Ask for a person. Staff get a WhatsApp alert marked `[Instagram]`, and the bot stays silent. Then set the `ig:…` row in `Active_Handoffs` to `unmuted`.
7. In n8n **Executions**: a run ending at `Rejected - Bad Signature` means `LUMIERE_INSTAGRAM_APP_SECRET` or `LUMIERE_INSTAGRAM_ACCOUNT_ID` is wrong or missing.

## How staff work with Instagram customers
- **Appointments booked elsewhere** (WhatsApp, Messenger, phone, another Instagram account, someone else) are never found or changed from Instagram. Typing a phone number or a name proves nothing, so Yasmine never asks for one. She escalates to staff: verify who the customer is, then help them by hand, or ask them to write from the number or conversation the appointment was booked with.
- Alerts arrive on **WhatsApp**, marked `[Instagram]`, with the customer's Instagram name and the customer key.
- Staff reply from the **Instagram inbox (Meta Business Suite)**, **within 24 hours** of the customer's last message. The bot ignores staff replies (echoes).
- To give the conversation back to Yasmine: in `Active_Handoffs`, set the row `ig:<account_id>:<igsid>` to `unmuted`, or delete it.
- To silence Yasmine for one customer without an escalation: add a row with that key and `Status = paused`. The key is in the `Phone` column of `ConversationLog`.

## Disclosure
- The first reply of every conversation window (no message from that customer in the last 24 h) starts with a short line in the customer's language. It says this is Yasmine, the salon's **automated AI assistant**, and that the customer can ask for a person at any time.
- The fixed replies (text only, technical problem) start with `🤖 Lumière Hair & Beauty Studio - automated assistant`.
- The prompt forbids the AI to claim it is human, and tells it to escalate whenever the customer asks for a person.

## Maintenance
```powershell
node tools/build-workflows.js; node tools/build-messenger.js; node tools/build-instagram.js
```
Then run `cd tests; npm test` and re-import the changed workflows. Do not edit the Instagram workflow by hand in n8n: the next build overwrites the changes. Test `IG1` fails while the file is out of date.
