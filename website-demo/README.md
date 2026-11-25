# Lumière Salon - Website Demo

A public demo of Yasmine for the chat at the top of the website (`site/index.html`), with a **fictional salon**: Lumière Hair & Beauty Studio.
It is generated from the Lumière WhatsApp workflows in the project root. It has its own workflows, calendar, credentials and lock IDs.

| File | What it is |
|---|---|
| `Lumiere Salon - Website Demo.json` | Main workflow: website webhook, validation and rate limits, safety gate, DEMO CONFIG, chat lock, AI agent, reply, daily cleanup |
| `Lumiere Salon - Website Demo - Book Appointment.json` (+ Cancel, Reschedule, Find, Check) | The 5 tool sub-workflows, on the demo calendar |
| `demo-config.js` | Demo settings and reply texts (EN/FR/ES/AR). Salon data comes from `../salon-info.js`, hours from `../engine/config.js` |
| `build-web-demo.js` | Generates the 6 files from the Lumière WhatsApp files (it only **reads** them) |
| `tests/web-demo.test.js` | 24 executable tests (`node website-demo/tests/web-demo.test.js`, also run by `cd tests; npm test`) |
| `site/index.html` | The website: the Lumière demo salon with Yasmine as its reception desk (English, French, Spanish, Arabic). `deploy/index.html` is the same file. The services menu, prices, durations, hours and contact are generated from `salon-info.js` + `engine/config.js` by the build (`site-data.js`), never edited by hand |
| `site-backup/index.v1-sales-page.html` | The previous sales-page version, kept for reference |
| `PHOTO-CREDITS.md` | The five Unsplash photos used on the site, with photographers and licence check |
| `tests/site.test.js` | Website tests: menu = salon-info.js, webhook, no fake claims, photo credits, four languages complete |

All 6 workflows import **inactive**, with their own fixed IDs (`lumWebDemo…`), webhook path (`lumiere-website-demo`), calendar, credentials and lock objects, all set in `../lumiere.config.js` (`websiteDemo`). Importing them creates **new** workflows: the other website demo (`othWebDemo…`, `other-website-demo`) is never replaced and both can run side by side. The tool links already point to the right workflows.

## Setup

1. **Google Calendar.** Create a new `Lumière Demo` calendar (SETUP.md step 1; never another bot's demo calendar) and put its ID in `lumiere.config.js` → `websiteDemo.CALENDAR_ID`. Until you do, every request gets a 503 and the website shows its "resting" message.
2. **n8n credentials**: create `LUMIERE DEMO - Google Calendar` and `LUMIERE DEMO - OpenRouter` (SETUP.md step 5; never the WhatsApp ones or another bot's). Keep a low credit limit on the OpenRouter key.
3. **Import** the 6 JSON files (*Workflows → Import from file*). On every node n8n marks, select the matching `LUMIERE DEMO - …` credential: the Engine Calendar API nodes, Count Session Bookings, List/Delete Demo Event, the two Google Calendar nodes in Find and Check, and OpenRouter Chat Model.
4. **DEMO CONFIG node** (main workflow):
   - `tool.CALENDAR_ID` comes from `lumiere.config.js` (rebuild after changing it).
   - Change `hashSalt` to a long random string.
5. **Do not** select an Error workflow (the salon error workflow alerts staff on WhatsApp).
6. **Test** with the webhook's test URL (click *Listen for test event*), for example:

   ```bash
   curl -X POST "https://<your-n8n>/webhook-test/lumiere-website-demo" -H "Content-Type: application/json" -H "Origin: https://hamzamihoubi.com" -d "{\"sessionId\":\"test-session-0001\",\"message\":\"Hi! I'd like to book a haircut for tomorrow.\",\"lang\":\"en\",\"channel\":\"web\"}"
   ```

   The `Origin` header is required. A request without it is rejected with 403. `lang` must be `en`, `fr`, `es` or `ar`.
7. **Publish the 5 tool workflows.** On n8n 2.x, a workflow called as a tool must be published (active), even when the main workflow runs in test mode. They have no webhook or schedule, so publishing them exposes nothing.
8. **Go live.** Publish `Lumière Salon - Website Demo`. `CHAT_WEBHOOK_URL` and the menu line (`SALON_DATA`) in `site/index.html` are written by the build from `websiteDemo.PUBLIC_WEBHOOK_URL` (`…/webhook/lumiere-website-demo`); deploy `site/index.html` to the website.

**Debugging:** the workflows save **no** execution data (the "no logging" rule), so failed runs don't appear in *Executions*. To investigate, temporarily switch *Settings → Save failed production executions* on, then off again. Those executions contain message text.

## What changed compared with the WhatsApp workflows

- **Removed:** WhatsApp trigger and every WhatsApp send, staff alerts and `!unmute`, pause/handoff (Sheets), voice (Cohere), Escalate to Staff, conversation log (Sheets), Get Clinic Info, error workflow.
- **Added:** Website Webhook (POST, CORS limited to `https://hamzamihoubi.com`), DEMO CONFIG, Validate & Rate Limit, Safety Gate, Build Web Reply, the Respond nodes, and the daily cleanup.
- **Book:** Demo Input Guard (title forced to `DEMO - <name>`, notes = service only), and a limit of 2 bookings per session.
- **Kept as is:** chat lock + calendar write lock engine, Sanitize AI Output checks, the prompt rules (calendar cheat-sheet, strict day calculation, grounding, no fake confirmations…), memory window, tool logic, service durations and the closing-time rule.
- **Additions inside the copies only:** an optional break (`LUNCH_START`/`LUNCH_END`, empty = no break), and a `FREE_SLOTS:` list in Check_Availability results for the requested service length (used for the time-slot chips).
- **Identity:** a 15-digit pseudo-ID hashed from the `sessionId` takes the place of the phone number (memory key, chat lock, appointment owner).
- **Prompt:** a "WEBSITE DEMO" section at the top: reply language, short replies, fake name, no health advice, no staff, no phone numbers. The salon facts (services, prices, durations, policies) come from DEMO CONFIG.
- **Language:** each message's language (English, French, Spanish, Arabic) is detected and passed to the AI; the quick-reply chips and notices follow it.

## Test script

Run each conversation from the website. Use the chat's language buttons before the first message, and **one browser tab per conversation**, since each tab is a new session.
Days below are relative: "Tuesday" means the next Tuesday. Sunday is the closed day. Hours are 09:00–19:00 and every appointment must end by 19:00.

### 1. Book an appointment
| | Visitor types / taps | Yasmine should |
|---|---|---|
| EN | `Hi! I'd like to book a haircut for tomorrow.` → `Emma Demo` → tap a time → tap `Confirm` | Ask for a name (with "A fake name is fine"), offer free times as chips, then confirm |
| ES | `Hola, ¿tenéis disponibilidad para un corte de pelo mañana?` → `Lucía Demo` → tap a time | Same, in natural Spanish (no regional slang) |
| FR | `Bonjour, je voudrais prendre rendez-vous pour une coloration.` → `Claire Demo` → `mardi` → tap a time | Same, in French; a full colour blocks 120 min |
| AR | `أريد حجز موعد لقص الشعر` → `سامي ديمو` → `الثلاثاء` → tap a time | Same, in Modern Standard Arabic |

**Calendar after:** `DEMO - <name>` events whose length matches the service (e.g. 60 min for a women's haircut, 120 min for a full colour). Each description reads `Phone: 9…(15 digits). Notes: Website demo | Service: …`, with no other text.

### 2. Prices, services and hours
| | Visitor types | Yasmine should |
|---|---|---|
| EN | `How much does balayage cost?` | "from €140", about 3 hours; demo price |
| EN | `Can you tell me about your hair treatments?` | Nourishing treatment (45 min, €40) and keratin (150 min, from €120) |
| ES | `¿Qué horario tenéis?` | Monday to Saturday 09:00–19:00, closed Sunday |

### 3. Availability and long services
| | Visitor types | Yasmine should |
|---|---|---|
| EN | `Do you have any availability this Saturday?` | Offer real free times (chips) |
| EN | `Can I book a balayage at 5pm on Friday?` | Explain it would end after closing (19:00) and offer 16:00 or earlier |
| ES | `¿Puedo ir el domingo?` | Say the salon is closed on Sundays and ask for another day |

### 4. Reschedule and cancel (in the same tab as a booking from test 1)
| | Visitor types / taps | Yasmine should |
|---|---|---|
| EN | `I'd like to reschedule my appointment.` → new day/time → `Confirm` | Read back the appointment, confirm the new time, move it (same length) |
| FR | `Je veux annuler mon rendez-vous` → tap `Confirmer` | Read back the appointment, ask to confirm, then cancel |

**Calendar after:** the event moves (same duration) or disappears. A **new tab** asking to cancel must find nothing, because a session only sees its own bookings.

### 5. Health question / human
| | Visitor types | Yasmine should |
|---|---|---|
| EN | `I had an allergic reaction after my colour, what should I take?` | The scripted "no medical advice" text, immediately |
| ES | `Quiero hablar con una persona` | The scripted "this is a demo, no team" text |

### Extra checks
- **Booking limit:** in one tab, book 2 appointments, then ask for a third. Yasmine should say the demo allows 2 and offer to cancel or move one.
- **Rate limit:** after 30 messages in one hour from one tab, you get the limit notice. The website itself also stops at 20 messages.
- **Cleanup:** the next day after 03:00, every `DEMO - …` event created more than 24 h earlier is gone.

## Not verified live

The tests run the real JSON in the project's n8n emulator, with a fake Google Calendar and a **scripted** AI. These points still need a real check:

- **How the real model behaves** with the salon prompt: language choice, natural Spanish, service durations, short replies, fake-name reminder. That is what the test script above checks.
- **CORS:** the Webhook node's `allowedOrigins` option and the browser's preflight request on your n8n version.
- **The per-IP limit** depends on your proxy sending `CF-Connecting-IP` or `X-Forwarded-For`.
- **Test-URL runs don't remember anything between messages**: the static data (notice, rate limits) is only saved for active (production) executions.

## Maintenance

After changing `salon-info.js`, `engine/config.js`, `demo-config.js` or the Lumière WhatsApp workflows:

```bash
node website-demo/build-web-demo.js
```

```bash
node website-demo/tests/web-demo.test.js
```

**Publish from the n8n editor, not the CLI.** `n8n publish:workflow` only updates the database: a running n8n does not register the webhook until it restarts. After a re-import, open the workflow in the editor and click **Publish** (if it already shows "Published", unpublish it and publish it again).

The build refuses to write if another client's data appears in the output (names, address, phone numbers, IDs, the other website demo's IDs/webhook/calendar/credentials, WhatsApp nodes, Darija rules), or if it reuses an ID from another bot's or the Lumière WhatsApp/Messenger workflows. The other client's names and IDs come from the git-ignored `tests/lib/clinic-fingerprints.local.json`. If you edit DEMO CONFIG directly in n8n, copy the change into `demo-config.js` / `salon-info.js` too, or the next re-import will undo it.
