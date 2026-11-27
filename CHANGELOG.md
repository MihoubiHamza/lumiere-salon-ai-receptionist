# CHANGELOG — Lumière Hair & Beauty Studio AI Receptionist

## Confirmation classifier: French answers with "c'est" (2026-11-27)

Found by a local, offline voice test: the shared confirmation classifier read "Oui, c'est d'accord." as `other` (a new request), because the elision splits into the unknown words "c" and "est". The pending confirmation was then dropped, so a French customer had to ask again. It was safe (nothing was changed), but awkward. This affected every channel, typed or spoken.

- **Fix** (`engine/confirm.js`): whole French expressions are matched before the existing `d accord` rule.
  - **Yes:** "c'est d'accord", "c'est ça", "c'est parfait", "c'est bon", "c'est correct", "ça marche", "ça me va"…
  - **No:** "ce n'est pas la peine", "c'est non", "pas question", "surtout pas".
  - **Unchanged:** messages with extra words or a time ("C'est d'accord pour 15h ?", "c'est combien ?") stay `other`. They are never read as a yes.
- **Regression check:** on a 66-phrase set in four languages, only the 4 intended French phrases changed. The language detector changed for "ça marche" only, which is now French instead of unknown.
- **Voice:** a spoken "Oui, c'est d'accord." is now recognised as a yes and refused as spoken ("Écrivez Oui ou Non"), keeping the pending confirmation, so a typed "oui" then confirms.
- **Rebuilt:** all workflows that embed the classifier (WhatsApp + tools, Messenger, Instagram, website demo). Nothing is deployed.
- **Tests:** `tests/confirmation.test.js` K3b. `npm test`: 16 suites, 291 tests.

## Instagram: multilingual voice messages (2026-11-26)

Instagram moves from text-only to text **and voice** input in English, French, Spanish and Arabic, with the language detected automatically. Replies stay text-only. Nothing was imported or published; the Instagram workflow stays inactive.

- **Provider:** OpenRouter speech-to-text (`POST /api/v1/audio/transcriptions`, model `openai/whisper-large-v3`, `response_format=verbose_json`, no `language` sent, so it is auto-detected and returned).
  - Cohere (WhatsApp/Messenger) was not reused: its docs say `language` is required and it "does not feature explicit, automatic language detection". It also doesn't list m4a/mp4/aac.
  - New salon-only credential `LUMIERE - OpenRouter Transcription` (`lumOrTranscribe1`). It is never shared with other bots, and WhatsApp/Messenger don't use it.
- **Voice path** (`tools/build-instagram.js`): Message Type Router → `Download Voice Binary` → `Check Voice File` → `Transcribe Voice` → `Read Transcript` → `Voice Usable?` → `Merge Voice Text` → Confirmation Gate.
  - **Download:** only HTTPS links on Meta's media CDN (`fbsbx.com`, `fbcdn.net`, `cdninstagram.com`); no token is sent; 20 s timeout.
  - **Format:** the real format is read from the first bytes (M4A/MP4, AAC, Ogg, WebM, WAV, MP3, FLAC), not from the URL or content type. Files of 1 KB–10 MB only.
  - **Language:** Whisper's language is cross-checked with the text detector in `confirm.js`. If they disagree, the language is marked UNCERTAIN, and Yasmine follows the transcript's language or asks the customer to type.
  - **Refused:** empty audio, the stock phrases Whisper invents for silence, and languages other than the four.
  - **Failure reply:** every failure (download, format, size, provider, unusable transcript) gets a 4-language "please try again or type" reply through the 24-hour-window guard. Nothing technical is shown.
- **Safety unchanged:** the node name `Merge Voice Text` keeps the existing gate check (`viaVoice`) and `confirm_via`. A spoken "yes" never confirms (the customer is asked to type), and the engine refuses `confirm_via=voice` (`not_typed`). The overrides that forced "text only" on Instagram are removed, and the build now fails if either check disappears.
- **Prompt and texts:** the Instagram rules say voice messages are read and replies are always text. The per-message marker gives the detected language instead of the WhatsApp "only Spanish" wording. The unsupported-attachment reply now says text and voice are read.
- **Emulator:** Code nodes get `this.helpers.getBinaryDataBuffer`; HTTP nodes record multipart form fields and file parts.
- **Tests:**
  - `tests/instagram.test.js` IV1–IV11, **mocked provider**:
    - four languages, including Arabic script;
    - language detection and uncertainty, and the language of the server's replies;
    - download failure and non-Meta links;
    - six audio formats, plus non-audio, too-small and too-large files;
    - empty or unintelligible transcripts and provider failure;
    - duplicate delivery and cross-customer isolation;
    - a spoken yes refused (English, Spanish, Arabic) and a typed yes still confirming, plus the engine's own refusal.
  - `tests/integration/instagram-voice-real.js` (not in `npm test`):
    - **part A:** real WAV and real AAC/MP4 audio (Windows voice, re-encoded by Windows Media Foundation) through the real workflow, with the provider mocked;
    - **part B:** the real OpenRouter text-to-speech and speech-to-text, run only with a test key in `.env.openrouter-test` (git-ignored).
  - `npm test`: 16 suites, 290 tests.

## Prompt: read back services, total length and price; only checked alternatives (2026-11-25)

Nothing was imported or published.

- **New prompt section "SERVICES, TOTAL LENGTH AND PRICE - READ BACK BEFORE YOU BOOK OR CHANGE"** (WhatsApp, Messenger, Instagram and website). Yasmine:
  - builds the complete selection for one person and never adds a service that another chosen one already includes (she says it is already part of it);
  - reads back the complete selection with the total length and starting price exactly as the tool result states them, never her own sum ("from" prices are starting prices);
  - calls Check_Availability again whenever the selection changes;
  - proposes only times or days that a Check_Availability result showed free for the whole selection;
  - explains the limits honestly: one person and at most 4 hours per appointment (offer separate appointments), only the listed services, durations and prices (no invented shorter version), one shared agenda, and what was NOT done when the system refuses or fails.
- **"CHANGING THE SERVICES OF AN APPOINTMENT"** points to Find_Patient_Appointments for the current services.
- **Find_Patient_Appointments** now shows, for the customer's OWN appointments only, the end time and the current services with their keys and length, e.g. `… at 10:00 (until 14:00; services: Balayage + Women's haircut & styling [keys: balayage,womens_cut,blow_dry; 240 min])`. Appointments without a service line show their end time.
- **Tests:** SV12 (the rules are present on all four channels; no cancel + re-book anywhere) and SV13 (Find output, privacy). `npm test`: 16 suites, 279 tests.

## C2: safe service changes in one confirmed update (2026-11-25)

Changing the services of an existing appointment (e.g. adding a balayage to a blow-dry) no longer means "cancel, then book again". Nothing was imported or published.

- **Reschedule_Appointment** takes `new_service_keys` (the complete new selection). The engine:
  - finds the customer's own appointment and resolves the new services from the catalogue (unknown, ambiguous and too-long selections are refused before anything is proposed);
  - recalculates the length and checks the **whole new window** (the appointment itself does not block its own extension; closing time, closed days and other appointments do);
  - records the exact change in the customer's pending confirmation. The record holds the new services in four languages, the backend length and end time, and the current services.
- **Confirmation:** the server asks, for example: *"do you want to change your appointment “Blow-dry & styling” on Tuesday 6 October at 10:00 to: Balayage + Women's haircut & styling - 240 minutes in total, on Tuesday 6 October at 10:00 (until 14:00)?"*
  - The question, the result and the late "already done" texts exist in English, French, Spanish and Arabic.
  - The website shows "Yes, change it / No, keep it" chips.
- **Execution:** one conditional PUT (`If-Match`) of the same calendar event, with the owner field first, the new service line and the notes kept. There is never a DELETE or a second booking. All existing protections apply:
  - one-time confirmation id, used up before the write;
  - the appointment must be unchanged since the proposal (staff edits and newer proposals invalidate the yes);
  - the new window is re-checked at the moment of writing;
  - verification after the write, with rollback to the original if another booking appears.
- **Ambiguous PUT result:** when a change keeps the same times (another service of the same length), it is judged by the content too. It is never reported as "nothing changed" or "done" on the times alone.
- **Check_Availability:** optional `exclude_appointment_time` leaves out the caller's OWN appointment being changed. Ownership is verified with the server-set phone number or customer key (the same rule as Find); another customer's appointment is never left out.
- **Prompt:**
  - the "SERVICE CHANGE WITH A DIFFERENT DURATION" section, which told the AI to cancel and re-book, is replaced by "CHANGING THE SERVICES OF AN APPOINTMENT";
  - the build refuses a prompt that still describes cancel + re-book.
- **Tests:** new `tests/service-change.test.js` (CH1–CH11), covering:
  - one update of the same event;
  - full-window and closing-time checks;
  - refused services;
  - a window taken before the yes;
  - duplicate and stale confirmations;
  - failed and lost-response writes;
  - own-appointment exclusion;
  - WhatsApp end to end in all four languages, including declines.

  Website demo C7b (Spanish, chips, DEMO title kept). `npm test`: 16 suites, 277 tests.

## C1: the backend calculates appointment length from the service catalogue (2026-11-25)

The AI is no longer authoritative for appointment length. Nothing was imported or published.

- **Catalogue** (`salon-info.js`): every service has a stable canonical `key`, `aliases` (common names in English, French, Spanish and Arabic) and `includes`:
  - the women's haircut & styling includes the blow-dry;
  - the hair treatment includes the blow-dry;
  - the full colour includes the root colour;
  - the gel manicure includes the manicure.

  An alias shared by several services ("haircut", "colour", "nails", "coupe", "قص", …) is ambiguous on purpose. No new service was added (there is no 45-minute cut & blow-dry).
- **Engine** (`resolveServices`): resolves `service_keys`. These can be keys, official names or aliases, as a comma-separated list or a JSON array.
  - Matching is exact after normalisation (case, accents, Arabic diacritics and hamza forms, punctuation), never fuzzy.
  - Unknown → `SERVICE_UNKNOWN`; ambiguous → `SERVICE_AMBIGUOUS` (lists the candidates); missing → `SERVICE_REQUIRED`. The backend never picks a default service.
  - A selected service already included in another selected service is not counted twice. Balayage (180) + women's haircut & styling (60, blow-dry included) = **240 minutes**, not 270.
  - A total over 240 minutes is refused with `TOO_LONG`.
  - The result states every service, the total and the starting price.
- **Book_Appointment:**
  - takes `service_keys` instead of `end_datetime`;
  - the end time is start + catalogue total, and an end time or duration sent by a caller is ignored;
  - the event description now carries the service line written by the engine, right after the unchanged owner field: `Phone: … / Customer: …. Service: <names> | Keys: <keys> | Duration: <min> min. Notes: …`.
- **Check_Availability:**
  - takes `service_keys` instead of `duration_minutes`;
  - FREE / BUSY / OUTSIDE_HOURS are computed for the whole catalogue total;
  - a specific time without any service now returns `SERVICE_REQUIRED` (no silent 30-minute default). Times outside opening hours are still reported first;
  - a date-only check without services lists the day's busy periods but no start-time list.
- **Website demo:**
  - the Demo Input Guard no longer turns an unknown service into the first service of the menu;
  - the separate `service` field is gone (the shared `service_keys` field is used);
  - DEMO CONFIG carries the catalogue for the engine (the engine fails closed without it);
  - the live website page (`site/`, `deploy/`) is unchanged.
- **Prompt:**
  - SERVICES & PRICES shows each service's `[key]` and what it already includes;
  - the rules tell the AI to pass the keys and read back the system's total;
  - the build refuses a prompt that still asks for `duration_minutes` or `end_datetime`.
- **Unchanged:** WhatsApp, Messenger and Instagram owner fields and confirmation safeguards. The three channels are rebuilt, not deployed.
- **Tests:** new `tests/services.test.js` (SV1–SV11); website demo C12; existing tests now pass `service_keys`. `npm test`: 15 suites, 265 tests.

## Fixes from the website production test: false fallback after a confirmed change, atomic rate limits (2026-11-25)

Both defects were reproduced by new tests on the previous code before they were fixed. Nothing was imported or published.

**1. False fallback after a successful cancel / move.**
- **Root cause:** after the server cancelled or moved an appointment on the customer's typed yes, it told the AI in the next turn ("[System log] … the system CANCELLED …"). The AI truthfully repeated it, but `Sanitize AI Output` only accepts a success claim backed by a tool call of the same turn, so it replaced the reply with the technical fallback.
- **Seen live:** on a duplicate "Yes" and on a late "Yes".
- **Fix:**
  - **Structured record.** On a SUCCESS result, Confirmation Output passes a structured record to the chat-lock release. The record holds the confirmation id, action, appointment id, old and new start, service and `res: 'SUCCESS'`.
  - **Where it is stored.** The engine stores it as `la` in that customer's own lock object. Only the lock holder writes it, stamped with the server time.
  - **Late or duplicate yes.** When a yes arrives with nothing pending and such a record exists from the last 2 h (`CONFIRM_DONE_MS`, the same window as the [System log]), the Confirmation Gate answers with the server's "That is already done…" text, in four languages. Nothing is executed; the used confirmation id can never run again.
  - **Server text is not checked as an AI claim.** Text written by the server in the current execution (question, result, "already done") is marked `serverText` and no longer checked as an AI claim.
  - **AI recaps.** An AI reply that claims a cancel / move the current execution did not do is never passed through. If the record shows that change really happened for this customer, the server's own text is sent instead of the technical error. Without such a record the reply is still rejected exactly as before.
  - **Failed or declined changes** are never recorded.
- Shared code: WhatsApp, Messenger and Instagram are rebuilt with the same fix (not deployed).

**2. Rate-limit counters under-counted overlapping requests.**
- **Root cause:** the counters were in n8n workflow static data. Every execution loads it at its start and writes it back at its end, so overlapping executions overwrote each other's increments.
- **Reproduced:**
  - 8 simultaneous requests of one session with limit 3: all 8 allowed;
  - 9 from one IP with limit 5: all 9 allowed;
  - 10 visitors with an hourly cap of 6: all 10 allowed;
  - the daily cap was ignored.
- **Storage:** Google Calendar lock objects on the Lumière Demo calendar, updated with conditional writes (ETag `If-Match`), the same compare-and-swap the chat lock and the calendar mutex already use. The deployment has no Postgres or Redis, its SQLite database is not reachable from workflows, and static data / Data Tables have no atomic increment.
- **New engine operation `rateHit`:**
  - one counter object per session, per IP (salted one-way hashes) and one for the overall hour + day;
  - each request reads, computes and writes with `If-Match`; a refused write (412) is re-read and recomputed, so no increment is ever lost;
  - a request is judged on the count it actually committed;
  - the overall budget is used only by requests within the per-visitor limits;
  - a store failure or too much contention refuses the request ("busy" notice, no AI call).
- **Website intake:** validation → `Count Request?` → `Rate Limit: Count` → engine → `Rate Limit Decision` → Safety Gate. Rejected requests are never counted. The first-message notice stays in static data (pseudo-ids only).
- **Tests:**
  - website demo: F1-F6 (issue 1) and RL1-RL8 (issue 2, simultaneous independent executions at the limit boundaries, with checks that writes really collided);
  - engine: U13-U15;
  - WhatsApp: M1b.

  `npm test`: 14 suites, 253 tests.

## Website demo: availability questions without a time (2026-11-25)

Found in the production test after the website-demo redeploy:
- "Do you have any availability this Saturday?" got the fallback reply.
- The AI called Check_Availability with a date but no time.
- In n8n, a `$fromAI()` field without a default value is required in the tool schema, so n8n rejected the whole tool call ("Received tool input did not match expected schema - Required at requested_time"), and the AI Agent failed.

This was not caused by the redeploy: the version live before it had the same field.

- **Fix (website demo only):** the main workflow's Check_Availability tool now declares `requested_time` optional (default `''`).
  - The Check Availability sub-workflow already reads the real Lumière Demo calendar for the whole day when no time is given: `EMPTY_DAY` / `HAS_EVENTS` plus `FREE_SLOTS` for the service length.
  - With a time, the FREE / BUSY / OUTSIDE_HOURS verdicts are unchanged. Date and duration validation are unchanged.
- **Unchanged:** the five website-demo sub-workflows; WhatsApp, Messenger and Instagram. Those three still declare `requested_time` required, a known open item for their own deployment.
- **Test emulator:** it now enforces n8n's rule. A `$fromAI` field without a default is required, and a tool call missing it is rejected the way n8n rejects it. Before, it silently filled `''`, which is why the tests did not catch this.
- **New tests** in `website-demo/tests/web-demo.test.js`:
  - A1: tool schema;
  - A2: date only, with the time left out, empty or blank;
  - A3: date + time;
  - A4: service duration;
  - A5: invalid date or time;
  - A6: fully booked day;
  - A7: the old build reproduces the fallback.

  `npm test`: 14 suites, 235 tests.

## Appointment authorization: a typed phone number is never proof of ownership (2026-11-25)

Found in the final audit: on every channel, a customer could type another person's phone number. The AI passed it as `booked_phone_number`, and the tools then found, cancelled or moved that person's WhatsApp or phone bookings. Nothing was imported, published or activated.

- **Engine (`identity`)**:
  - The only identity is the verified sender of the conversation: `wa:` / `fb:` / `ig:` key, or the legacy `phone_number` set by the server.
  - Any non-empty `booked_phone_number` is refused before any calendar read with the new result **`NEED_STAFF`**. Nothing is searched, shown, proposed or changed, and the reply never says whether such an appointment exists.
  - `NEED_BOOKED_PHONE` is gone. "Nothing found" is now a plain `NOT_FOUND` that tells the AI to escalate, never to ask for another number.
- **Tools**:
  - `booked_phone_number` stays in the sub-workflow contract, so a request carrying it fails closed. It is **fixed empty** on every AI tool node of WhatsApp, Messenger, Instagram and the website: the AI can no longer set it.
  - Tool descriptions say that a typed number or name is never proof of ownership, and to call Escalate_to_Staff.
- **Prompts (all channels)**:
  - The "booked from a DIFFERENT phone number" procedure (ask for the number, search with it) is replaced by: never ask for the number, never search, never confirm or deny, tell the customer what can be managed from here, and call Escalate_to_Staff so a team member verifies and helps.
  - The build refuses a prompt that still mentions `booked_phone_number`.
- **Unchanged**:
  - WhatsApp customers are still identified by their verified incoming number. Old `Phone:` events and staff-made events that contain the customer's own number still work.
  - All confirmation safeguards are unchanged.
  - Phone numbers typed for a NEW Messenger / Instagram booking are still saved as contact information (`Tel:` in the notes).
- **Tests**:
  - New `tests/authorization.test.js` (9). Scenarios:
    - an Instagram or Messenger customer typing someone else's number;
    - a WhatsApp customer, including a fully hostile AI through the real WhatsApp workflow;
    - two Instagram accounts;
    - cross-channel access;
    - legitimate own access;
    - cancel / reschedule / confirmation authorization;
    - contact numbers.
  - Six existing tests that asserted the old access (U3, R7, R8, F1, X1, M17) now assert the refusal.
  - `npm test`: 14 suites, 228 tests.

## Instagram Direct + channel-aware customer keys (2026-11-25)

Nothing was imported, published or activated. No Meta, Google or n8n resource was created, changed or contacted. A Git baseline (commit `bbf407d`) was made before any edit; `.gitignore` excludes `.env` files, keys and `node_modules`.

- **Customer keys instead of bare digits (shared engine, `engine/engine.js`):**
  - every customer is now `wa:<number>`, `fb:<page_id>:<psid>` or `ig:<instagram_account_id>:<igsid>`;
  - the key, not the digits, now identifies the chat lock, the pending confirmation record, the AI memory session, the pause row and the appointment owner;
  - the key is separate from the customer's real mobile number;
  - a present but malformed key fails closed (no fallback to digits).
- **Migration:**
  - WhatsApp keeps the exact previous derivations: same lock object, same identity hash, `Phone: <digits>` owner field. In-flight WhatsApp state stays valid (tests U10, K13).
  - Messenger and Instagram appointments are written as `Customer: <key>. Notes: …`. The owner field is only read at the very start, so text in the notes can never claim an owner (U11).
  - Pre-key Messenger bookings (`Phone: <PSID>`, test data only) belong to nobody and are handled by staff.
  - Pre-key Messenger pause rows (`fb:<PSID>`) still pause (M11b).
  - WhatsApp ignores `fb:` / `ig:` pause rows.
  - Found in the final audit: `wa:` keys first required 9 digits, while the legacy chat lock accepted 6. A 6-8 digit WhatsApp sender (e.g. +290 / +683 numbers) would have got the fallback reply. The key now accepts 6-15 digits, so these senders get the same lock and the same tool results as before (U10).
- **New tool input `customer_key`** (Book, Find, Cancel, Reschedule). It is always set by the server from the verified sender, never by the AI. The 5 tools now accept `lumInstagramMain` as a caller.
- **Instagram Direct workflow** (`Lumiere Instagram AI Agent.json`, ID `lumInstagramMain`, inactive), generated by the new `tools/build-instagram.js` from the Messenger build. It uses the Messenger Platform: an Instagram professional account linked to the salon Page, and a Page token.
  - Own webhook `lumiere-instagram`, verify token, App Secret and account-ID variables, and its own credential `LUMIERE - Instagram Page Token`. The Messenger webhook is untouched.
  - Signature check (same HMAC code as Messenger). Only events for `LUMIERE_INSTAGRAM_ACCOUNT_ID` are processed.
  - Ignored: echoes (including staff replies from the inbox), read receipts, reactions, deleted messages, story mentions and malformed payloads. Duplicate and stale deliveries are dropped.
  - **Text only:** voice messages and every attachment get a friendly "please type" reply. There is no voice pipeline and no voice promise.
  - **24-hour window:** a guard before every message to the customer.
  - **Text limit:** replies are split into parts of at most 990 UTF-8 bytes (fewer than 1,000 characters).
  - **Disclosure:** the first reply of each conversation window says this is Yasmine, the automated AI assistant, and that a person can be asked for. Fixed replies carry an "automated assistant" tag. The prompt forbids claiming to be human.
  - **Human handoff:** escalation writes an `ig:` pause row, sends a staff WhatsApp alert `[Instagram]` (reply from the Instagram inbox within 24 h), and the bot stays silent until staff unmute.
  - The confirmation gate is unchanged; only typed text reaches it.
- **Messenger:** customer key `fb:<page_id>:<psid>`. Same-PSID-on-another-Page is a different customer (M18). Events without a Page ID are dropped (M19).
- **Website demo:** unchanged behavior. It keeps its own session pseudo-ID; `customer_key` is forced empty.
- **Meta requirements** (permissions, App Review / Advanced Access, Business Verification, webhook fields, text limit, 24 h window, disclosure) were checked against Meta's documentation on 2026-11-25 and are written down in the new `INSTAGRAM-SETUP.md`. Not verified there: HUMAN_AGENT on Instagram, rate limits, whether Graph v25.0 is still served.
- **Tests:**
  - new `tests/instagram.test.js` (24);
  - new engine tests U10–U12;
  - confirmation K12, K13;
  - Messenger M11b, M18, M19;
  - isolation and preflight cover the Instagram file, credential, variables and webhook.

  `npm test`: 13 suites, 219 tests.

## Website: from salon site to live AI receptionist demo (2026-11-24)

The page is now a product demo with a short sales section. The old salon page
is kept as `website-demo/site-backup/index.v2-salon-page.html`.

- **Hero = the live chat.** The headline is "Meet your salon's new AI
  receptionist." The working chat (same n8n webhook, same request
  `{ sessionId, message, lang, channel: "web" }`) sits beside it on desktop,
  under it on tablets and phones. Its message box is on the first screen from
  320×640 to 1440×900 in all four languages.
- **Six things to try:** price, free times, booking, moving, cancelling (with
  confirmation) and writing in another language. Each button sends a real
  message through the normal send path; there are no canned answers. The
  messages follow the chat language, and step 6 is written in a different one.
- **Removed:** the Visit section, the address and contact strip, the
  opening-hours table and the salon marketing copy. The salon data stays in
  the bot. A short "What Yasmine knows" menu keeps the prices and a one-line
  hours summary.
- **Clear disclosure:** in the hero and the footer, Lumière is a fictional
  demo salon, its data is demo data, demo bookings are deleted after 24 h, and
  visitors should use a fake name.
- **WhatsApp/Messenger:** shown as recorded examples, set up on the salon's
  own number and page, never as something to test here.
- **For salon owners:** six capabilities and one call to action, "Get an AI
  receptionist for your salon". Voice messages are promised only in the
  salon's main language.
- **Photos:** 3 remain (credits updated); no broken images or console errors.
- **Demo safety (workflow, not yet imported into n8n):**
  - The per-IP limit now uses the last X-Forwarded-For entry. Before, a
    spoofed header bypassed it.
  - New global caps: 120 messages/hour and 600/day across all visitors, with a
    polite "busy" notice and no AI call.
  - New tests:
    - V6 (IP spoofing);
    - V7 (global caps);
    - V8 (a "Yes" in one session never confirms another session's pending cancel);
    - V9 (responses contain no internal ids, calendar, prompt markers or session data);
    - W8 (hero chat and the six steps).
- **Deployed 2026-11-24:** the hash salt is set to a random value; lumWebDemoMain01 is imported and
  published (CLI + n8n restart). The previous version is backed up in
  D:
8n-backups6-11-24-before-web-demo-deploy. Live smoke test passed: a price question,
  a booking, a second visitor's "Confirm" ignored, the cancel confirmed by the visitor,
  the demo calendar left empty, replies containing only {reply, quickReplies}, and other origins
  rejected (403).
- **Website live 2026-11-24:** website-demo/deploy/index.html is the homepage of hamzamihoubi.com
  (Cloudflare Pages project hamzamihoubi-site; the previous page stays available as an earlier
  deployment). A live chat
  test from the domain worked. The same file was also uploaded to the old Netlify project, which
  no longer serves the domain.
- **www (2026-11-25):** www.hamzamihoubi.com had no DNS record. Added a proxied CNAME to the Pages
  project and a 301 redirect rule from www to https://hamzamihoubi.com (path and query kept), so
  the chat works there too: its webhook accepts only that origin.

## Website polish: all languages and screen sizes (2026-11-24)

Audited at 320, 360, 390, 768, 1024, 1064, 1100, 1200, 1280 and 1440 px in
English, French, Spanish and Arabic (RTL). Each check covered horizontal scroll,
off-screen elements, text spilling out of buttons/boxes and wrapped header links;
screenshots were checked for every section. Colours, fonts, borders and square
buttons are unchanged.

- **Header:** French/Spanish links wrapped onto two lines between 1061 and about 1130 px.
  The "Hair & Beauty Studio" subtitle is now hidden below 1180 px and links never wrap.
- **Phones ≤380 px:** the page scrolled 4 px sideways (full-bleed photos pulled
  out by 20 px while the margin was 16 px). One `--gutter` value now drives the
  page margin, the photo bleeds and the scrolling tab row.
- **Buttons:**
  - fixed line height, so the Arabic buttons are no longer taller;
  - labels may wrap, balanced, except in the header;
  - on phones the services and owners buttons are full width, so French and
    Spanish pairs line up.
- **Type:** balanced headings, no one-word last lines in paragraphs. The same
  22 px (16 px on phones) between every section label and heading; inline
  styles removed.
- **Chat:** long placeholders end with "…"; the status dot stays on the first
  line when the status wraps; the suggestion row fades at its trailing edge
  (mirrored in Arabic).
- **Demo phone:** older messages fade out under the WhatsApp header instead of
  being cut through. The phone's direction now follows the client's
  conversation language, not the website's: an English chat stays
  left-to-right on the Arabic page, and the Arabic chat flips.
- **Tabs on phones:** fade at the trailing edge (mirrored in Arabic) to show
  they scroll.

## Voice rule, salon tools published, WhatsApp + Messenger tested in n8n (2026-11-24)

- **Voice notes never confirm:** a transcribed "yes / sí / oui / نعم" no longer
  authorizes a cancellation or reschedule. The gate answers "please type Yes or
  No" and keeps the request pending. The execution workflow also refuses any
  confirmation whose `confirm_via` is not `text`. Each "Run Confirmed" node
  computes that from the real message path. Tests V1, V2.
  Interactive buttons are not used: the website chips and replies are typed text.
- **Salon tools:** Book / Cancel / Reschedule / Find / Check accept calls only
  from `lumWhatsAppMain1` and `lumMessengerMain` (test P2), and are now
  published (owner-approved). Each has only the "When Executed by Another
  Workflow" trigger.
- **Fixed (pre-existing, found live):** "Check Handoff Status" has *Always Output
  Data* and an error output. When the Sheets read fails, n8n runs both branches:
  - the error branch sends the fallback reply, alerts staff and releases the lock;
  - the normal branch also runs on an empty item, so the AI answers as well.

  The pause check now stops in that case (WhatsApp + Messenger). The test
  emulator now behaves like n8n here. Graph test G19 checks the guard.
- **Prompt:** the old "ask the customer to confirm before calling Cancel /
  Reschedule" rules now say to call the tool; the system asks. In live runs the
  AI otherwise only announced the change.
- **Live n8n test (intercepted copies, then restored):** both channels covered
  - booking;
  - cancel and reschedule questions;
  - ambiguous, negative, voice-yes and typed-yes answers;
  - replay protection (same message id stopped as a duplicate).

  Messenger also rejected an invalid signature and accepted a valid one. All
  outbound messages were captured, none sent. The TEST calendar and TEST sheet
  were cleaned back to their pre-test state. All 14 Lumière workflows match the
  project files and the 38 earlier workflows are unchanged.
- `npm test`: 13 suites, 182 tests.

## Server-side confirmation gate for cancellations and reschedules (2026-11-24)

Found in live testing: the AI cancelled and moved appointments without asking,
despite its prompt. Confirmation is now enforced by the server, on WhatsApp,
Messenger and the website demo.

- **Propose, don't change:** Cancel_Appointment / Reschedule_Appointment (the AI's
  tools) verify the appointment (and that the new slot is free) and store ONE
  pending record in the customer's own chat-lock object: one-time id, action,
  exact event id + its times and content fingerprint, exact new start/end,
  creation time, 10-minute expiry. They return CONFIRMATION_REQUIRED and never
  touch the calendar.
- **The customer decides, not the AI:** the new **Confirmation Gate** node
  classifies the customer's raw next message (EN/FR/ES/AR) before the AI runs:
  clear yes -> **Run Confirmed Cancel / Reschedule** (execute mode); clear no ->
  "nothing changed"; unclear -> asks again; anything else -> the request is
  dropped and the AI handles the message.
- **The execution workflow re-checks everything itself:** same customer/session,
  same id, action, appointment (unchanged), new time, not expired, not used, a
  later message, and the raw message is a yes. The record is used up (CAS)
  BEFORE the calendar write, so it can never be replayed. A new proposal
  replaces the old one. The AI cannot reach execute mode (those inputs are fixed
  to empty in its tool nodes).
- **Server-written replies and buttons:** the confirmation question, results and
  "kept / expired / not applied" messages are written by the server in the
  customer's language. Website buttons follow the state (Yes/No while waiting,
  next steps afterwards); the AI's own cancellation questions no longer get the
  booking Confirm / Cancel buttons. A "[System log]" line tells the AI what
  really happened. New prompt section: the system does the confirmation.
- **Fixed (pre-existing, found live):** n8n resolves `$('Node').first()` through
  the output that leads to the current node; for nodes with an error output that
  was the empty error branch, so the chat-lock release never saw "Chat Lock
  Acquired" (processed messages were never recorded live). Such lookups are now
  pinned to output 0 (`pinOutputs`), with graph test G18.
- **Tests:** new `tests/confirmation.test.js` (15 tests: no confirmation, explicit
  yes in 4 languages, no/ambiguous, expired, wrong appointment, wrong
  customer/session, replay, changed time/action, slot taken meanwhile, success,
  WhatsApp conversations, prompts). Each protection was mutation-checked.
  Existing tests now go through propose + confirm; R1, R2, C2 expectations
  updated (the losing request is refused by the gate). `npm test`: 13 suites,
  178 tests.
- **Live test (website demo, test-webhook mode):** cancel question with Sí/No
  buttons, "maybe" asked again, "no" kept it, reschedule question showed both
  times, "yes" moved it (same length), replayed "yes" changed nothing, Spanish
  "Sí" cancelled without the AI. Test appointments deleted; Lumière Demo
  calendar empty.

## Google resources, shared credentials and n8n import (2026-11-24)

- **Google:** created the test calendars "Lumière Salon (TEST)" and "Lumière Demo"
  (Africa/Algiers) and the sheet "Lumière Salon - Bot data (TEST)". Their IDs
  are in `lumiere.config.js`; no placeholder is left.
- **Shared credentials (owner's decision; the older bot is being retired):**
  the salon uses the existing `Google Calendar account`, `Google Sheets account`,
  `OpenRouter account`, `Header Auth account` (Cohere), `DEMO - Google Calendar`
  and `DEMO - OpenRouter`. They are listed in the new `SHARED_CREDENTIALS`.
  Only these account-level types may be shared. WhatsApp, the WhatsApp trigger
  and the Facebook Page token stay `LUMIERE - …`; the tests, preflight and the
  website-demo build refuse to share them. `tests/isolation.test.js` I2 checks
  this (mutation-checked).
- **Imported into n8n** (Docker CLI, IDs kept): 14 workflows, all inactive, plus
  9 empty `LUMIERE …` credentials with the ids the nodes referenced. After the
  switch to shared credentials only 3 are used (WhatsApp Trigger, WhatsApp API,
  Facebook Page Token). The other 6 empty ones (`LUMIERE - Google Calendar`,
  `- Google Sheets`, `- OpenRouter`, `- Cohere (Header Auth)`, `LUMIERE DEMO - …`)
  are unused and can be deleted in n8n. Before the import, all 38
  existing workflows were backed up to `D:\n8n-backups\2026-11-24-before-lumiere-import`.
  After it, they were unchanged and the same 25 were active.
- **Website-demo tools published (owner-approved, these 5 only):** n8n 2.x only
  lets a workflow call published sub-workflows. The 5 demo tools now accept
  calls only from the demo parent (`callerPolicy: workflowsFromAList`,
  `callerIds: lumWebDemoMain01`, set by the build and tested). Each has only the
  "When Executed by Another Workflow" trigger. The main demo workflow,
  WhatsApp, Messenger and the salon tools stay unpublished.
- **Live test** (main demo in n8n test-webhook mode, AI model and Google
  Calendar both live): availability, booking (60-minute "DEMO - TEST Claude"
  event, Africa/Algiers), lookup (Find tool), reschedule (same event moved,
  same length) and cancellation all worked. The Lumière Demo calendar is empty
  afterwards. **Found:** the AI cancelled and rescheduled without first asking
  the visitor to confirm, although the prompt requires it for cancellation; after the
  cancellation the reply still offered Confirm/Cancel chips. The reply also
  swapped the name order ("Claude TEST"). Not fixed yet.

## Website redesign: salon-first page (2026-11-24)

`website-demo/site/index.html` (and `deploy/index.html`) rebuilt as the website of
the demo salon, with Yasmine as its reception desk. The previous sales page is
kept as `website-demo/site-backup/index.v1-sales-page.html`. Workflows unchanged;
the chat posts to the same webhook URL, with the same request format.

- **Six sections instead of eleven:** hero with the chat built in; services and
  prices; "Try the receptionist" (the six demo tabs and the "At the salon"
  panel); visit, hours and policies; a short "For salon owners" band; footer with
  business details, photo credits and the privacy policy (collapsible). Removed:
  problem grid, feature grid, savings calculator, setup steps, pricing card, FAQ,
  closing band.
- **Menu sync:** services, prices, durations, opening hours and contact are
  generated from `salon-info.js` + `engine/config.js` into one `SALON_DATA` line
  by `build-web-demo.js` (`site-data.js`), so the site always matches what
  Yasmine quotes. `--check` fails if the line is out of date.
- **Look:** Cormorant Garamond headlines (one italic word), Instrument Sans body,
  DM Mono details; Noto Naskh Arabic + IBM Plex Sans Arabic in Arabic. Bone,
  linen, sand, espresso and one clay-rose accent; square buttons, thin lines,
  numbered lists, no gradients, glow or emoji. Five credited Unsplash photos.
- **Chat:** restyled as the salon's concierge panel ("Yasmine · Lumière
  reception"). The WhatsApp look stays only inside the demo phone. On phones
  the message box is on the first screen.
- **Mobile:** full-screen menu below 1060 px; the floating WhatsApp button is
  replaced by an "Ask Yasmine" bar that opens the chat and never covers text.
- **Arabic:** the Latin salon name is isolated so it no longer breaks apart in
  right-to-left sentences; Arabic words never use the Latin mono font.
- **Honest content:** no ratings, reviews, client counts, founding year, offers
  or stylist names; the page says plainly that Lumière is a demo salon. The
  developer's number appears only in the salon-owner band and the chat's
  "demo resting" note, never as the salon's number.
- **New `website-demo/tests/site.test.js`** (7 tests). `npm test` now runs 12
  suites (162 tests).

## Isolated salon environment (2026-11-23)

No external resource was created, changed or contacted; nothing was imported into n8n.

- **New `lumiere.config.js`**: the single place for the salon's Google Calendar
  ID, Google Sheet ID and tab names, n8n credential names/placeholder IDs,
  `LUMIERE_*` environment variable names (WhatsApp phone number ID, access
  token, staff notification number, Messenger secrets), workflow IDs, webhook
  paths, timezone and all website-demo resources. Calendar and sheet IDs are
  `PASTE_…` placeholders until you create them (SETUP.md); the workflows fail
  closed meanwhile. `engine/config.js` and `website-demo/demo-config.js` read it.
- **No resources of the original bots left:** their calendars, sheet, 9 credential IDs,
  `CLINIC_*` env vars, node/webhook IDs and lock IDs were replaced. All three
  builders now apply the environment on every build. Sheets nodes reference
  tabs **by name** (tab IDs differ between spreadsheets).
- **Website demo no longer replaces the other website demo:** own workflow IDs
  (`lumWebDemo…`), webhook path `lumiere-website-demo`, calendar, credentials
  and lock IDs (`lumdemolock…`). The build keeps `CHAT_WEBHOOK_URL` in
  `site/index.html` and `deploy/index.html` in sync and refuses the other
  demo's identifiers.
- **All workflows exported inactive** (the WhatsApp and tool files still had
  `active: true` from the original export). The error workflow has ID
  `lumErrorAlert001` and is pre-selected as the WhatsApp/Messenger error workflow.
- **Timezone** is injected from config everywhere; the build refuses a timezone
  with daylight saving time or a mismatched offset (fixed-offset engine).
- **Voice notes restricted to one language:** Cohere has no language detection,
  so voice is supported only in `VOICE_LANGUAGE`. The AI is told so on every voice
  message and asks customers in other languages to type. The build refuses an
  unsupported model/language combination.
- **New `tests/isolation.test.js`** (10 tests) and **`tools/preflight.js`**
  (offline pre-import check). `npm test` now runs all 11 suites (155 tests),
  including the website demo.
- **New `SETUP.md`** (step-by-step guide + final pre-import checklist) and
  `lumiere.env.example`.

## Conversion to Lumière Hair & Beauty Studio (2026-11-23)

This project started from my earlier AI receptionist build (WhatsApp + Messenger +
website demo) and was converted into a salon demo. The original folders were
**not modified**. The old backup folders were not copied; the full technical
history of the engine (concurrency cycles, crash safety net, Messenger build)
stays in the original project's CHANGELOG.

### Kept unchanged (technical behaviour)
- Booking, cancellation and rescheduling workflows, with the same concurrency
  engine (calendar write lock, per-chat lock, conditional writes, idempotency,
  post-write verification, crash safety net).
- Google Calendar integration, the Google Sheets pause/handoff and conversation
  log, staff alerts and `!unmute`, error workflow.
- WhatsApp intake, Messenger intake (generated from WhatsApp), website intake
  (generated from WhatsApp), voice-note pipeline, Sanitize AI Output checks.
- All credentials, environment-variable names, the Google Sheet ID, the
  calendar IDs and the website webhook URL/path.

### Changed
- **Brand and wording:** every prompt, reply, staff alert, tool description and
  tool result now speaks about a salon and customers (Lumière Hair & Beauty
  Studio). The AI receptionist is still called Yasmine.
- **Salon data in one place:** `salon-info.js` holds the fictional demo profile
  (services, prices, durations, policies). It is rendered into the prompt's
  SALON INFO section by `tools/build-workflows.js`, copied into the website
  demo's DEMO CONFIG, and exported to `salon-info-sheet.csv` by
  `tools/build-salon-sheet.js`.
- **Demo opening hours** (`engine/config.js`): Monday–Saturday 09:00–19:00,
  closed Sunday.
- **Service durations:** Check_Availability takes an optional
  `duration_minutes` and checks the whole service. The engine (Book and
  Reschedule) now refuses an appointment that would **end after closing time**
  (new `endRule`). The prompt computes the end time from the service duration.
- **Languages:** Darija rules and examples were removed. The assistant speaks
  English, French, Spanish (natural, standard Spanish, no regional slang) and
  Modern Standard Arabic, detected from each message. The website demo detects
  English/French/Spanish/Arabic per message and its quick replies follow it.
- **Voice notes:** the Cohere model and language are set from
  `engine/config.js` (`VOICE_MODEL` = `cohere-transcribe-03-2026`,
  `VOICE_LANGUAGE` = `es`). The original build used the Arabic-only model with `ar`.
- **New workflow IDs and names** for the WhatsApp, Messenger and tool workflows
  (`lum…`), so importing them never overwrites the original bots' live workflows.
  New Messenger webhook path `lumiere-messenger`. New lock IDs
  (`lumierelockcal01` / `lumierelockchat`) and lock-key salt. Fresh memory key.
- **Website** (`website-demo/site/index.html`): rebuilt from the 22 Nov site
  file as a salon AI receptionist demo for Lumière, in English (default),
  French, Spanish and Arabic, with salon scenarios and the suggested demo
  questions. Same chat client and webhook URL. Cloudflare's injected e-mail
  obfuscation and analytics scripts were removed from the source (Cloudflare
  re-injects them when serving).
- **Tests** updated for the salon hours, closing-time rule, service lengths,
  four languages and new file names; new tests for long services (balayage),
  the optional break, Sunday closing and Spanish booking.

### Kept on purpose (internal identifiers)
Renaming these would break n8n links, the Google Sheet or sub-workflow input
contracts. They are never shown to customers:
`Find_Patient_Appointments` (tool name), `Get Clinic Info` / `Get_Clinic_Info`
(tool name), the `patient_name` input, the `Patient_ID` and `PatientMessage`
sheet columns, and the `CLINIC_*` environment variables.
