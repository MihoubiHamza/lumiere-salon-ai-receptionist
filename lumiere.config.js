'use strict';
// ============================================================================
// LUMIÈRE ENVIRONMENT CONFIG - every external resource the salon bots use.
//
// This is the ONLY file to edit when connecting the salon to its own Google
// Calendar, Google Sheet, WhatsApp/Messenger and n8n credentials. Nothing here
// may point at another bot's resource: tests/isolation.test.js and
// `node tools/preflight.js` fail if one does.
//
// After editing:  node tools/build-workflows.js && node tools/build-messenger.js && node website-demo/build-web-demo.js
// Before import:  node tools/preflight.js        (see SETUP.md)
//
// Values starting with PASTE_ are placeholders you must replace (SETUP.md).
// The workflows refuse to touch a calendar whose ID still starts with PASTE_
// (the requests fail and the customer gets the fallback reply).
// ============================================================================
module.exports = {
  // ---- Google Calendar (SETUP.md step 1)
  google: {
    CALENDAR_ID: 'e2c998039ff558f4b73cdd495ad30de47a7761333f453741571e780917ee29c7@group.calendar.google.com', // "Lumière Salon (TEST)" (created 2026-11-24)
    LOCK_CALENDAR_ID: '', // empty = same calendar as CALENDAR_ID (recommended)
    CALENDAR_NAME: 'Lumière Salon',

    // ---- Google Sheet (SETUP.md step 2). Tabs are referenced BY NAME.
    SHEET_ID: '1RmNw9NsH7FpzQFvma-7IWkx5pNlG-GrAL9MwhtU-D5A', // "Lumière Salon - Bot data (TEST)" (created 2026-11-24)
    SHEET_TABS: {
      handoffs: 'Active_Handoffs', // columns: Patient_ID | Status | Timestamp  (Patient_ID holds the customer ID)
      log: 'ConversationLog', // columns: Timestamp | Phone | PatientMessage | BotReply
      salonInfo: 'Salon_Info', // paste salon-info-sheet.csv here (read by the Get Clinic Info tool)
    },
  },

  // ---- Salon timezone. The booking engine uses a FIXED offset: the build
  // refuses a timezone with daylight saving time or a different offset.
  TIMEZONE: 'Africa/Algiers',
  TZ_OFFSET_MIN: 60,

  // ---- n8n credentials (SETUP.md step 5). The `LUMIERE - ...` ones are the
  // salon's own: they exist in n8n with exactly these ids and names.
  credentials: {
    googleCalendar: { id: 'rZX0lgyJh37EPtO6', name: 'Google Calendar account' }, // shared, see SHARED_CREDENTIALS
    googleSheets: { id: '8cDyURx4XMYQvDrW', name: 'Google Sheets account' }, // shared
    whatsAppTrigger: { id: 'lumWaTrigger0001', name: 'LUMIERE - WhatsApp Trigger (OAuth)' },
    whatsApp: { id: 'lumWaApi00000001', name: 'LUMIERE - WhatsApp API' },
    openRouter: { id: '3JRN7dwrwfWdcPVS', name: 'OpenRouter account' }, // shared
    cohere: { id: '2KXHYFXQUgXkYyRh', name: 'Header Auth account' }, // shared (Cohere key)
    facebookPage: { id: 'lumFbPageToken01', name: 'LUMIERE - Facebook Page Token' },
    // Instagram Direct via the Messenger Platform: a Page access token (of the salon Page
    // linked to the salon's Instagram professional account) with instagram_manage_messages.
    // Its own credential so it can be rotated / revoked without touching Messenger.
    instagram: { id: 'lumIgPageToken01', name: 'LUMIERE - Instagram Page Token' },
  },
  // Account-level credentials deliberately SHARED with the older bots on the instance
  // (decided 2026-11-24: the older bot bot is being retired). Sharing them is safe
  // because the salon still uses its own calendars, sheet, IDs and lock objects.
  // Only googleCalendar, googleSheets, openRouter and cohere may be listed here:
  // WhatsApp, the WhatsApp trigger, the Facebook Page token and the Instagram token
  // always stay the salon's own (sharing them would answer on another bot's number,
  // page or account).
  // To go back to fully separate credentials, empty this list and use LUMIERE ids.
  SHARED_CREDENTIALS: ['googleCalendar', 'googleSheets', 'openRouter', 'cohere'],

  // ---- n8n environment variables (SETUP.md step 6). The workflows read
  // these names; their VALUES are set on the n8n instance, never in a file.
  // An unset variable fails closed (WhatsApp sends fail, Messenger rejects).
  env: {
    WHATSAPP_PHONE_NUMBER_ID: 'LUMIERE_WHATSAPP_PHONE_NUMBER_ID', // the salon's WhatsApp Business phone number ID
    WHATSAPP_ACCESS_TOKEN: 'LUMIERE_WHATSAPP_ACCESS_TOKEN', // permanent token for that number
    STAFF_CHAT_ID: 'LUMIERE_STAFF_CHAT_ID', // salon staff number for alerts, digits with country code
    MESSENGER_VERIFY_TOKEN: 'LUMIERE_MESSENGER_VERIFY_TOKEN',
    MESSENGER_APP_SECRET: 'LUMIERE_MESSENGER_APP_SECRET',
    MESSENGER_PAGE_ID: 'LUMIERE_MESSENGER_PAGE_ID', // optional
    INSTAGRAM_VERIFY_TOKEN: 'LUMIERE_INSTAGRAM_VERIFY_TOKEN', // Instagram webhook verification (its own value)
    INSTAGRAM_APP_SECRET: 'LUMIERE_INSTAGRAM_APP_SECRET', // App Secret of the salon Meta app (signature check)
    INSTAGRAM_ACCOUNT_ID: 'LUMIERE_INSTAGRAM_ACCOUNT_ID', // REQUIRED: the salon's Instagram professional account ID
  },

  // ---- n8n workflow IDs (fixed so the tool links work after import; none of
  // them exists in the other projects, so an import never overwrites another bot's workflow).
  workflows: {
    main: 'lumWhatsAppMain1',
    book: 'lumBookAppoint01',
    cancel: 'lumCancelAppt001',
    reschedule: 'lumReschedAppt01',
    find: 'lumFindAppts0001',
    check: 'lumCheckAvail001',
    error: 'lumErrorAlert001',
    messenger: 'lumMessengerMain',
    instagram: 'lumInstagramMain',
  },
  MESSENGER_WEBHOOK_PATH: 'lumiere-messenger',
  INSTAGRAM_WEBHOOK_PATH: 'lumiere-instagram', // its own webhook: the Messenger webhook is never touched

  // ---- Website demo (website-demo/README.md). Separate calendar, credentials,
  // workflow IDs and webhook path: importing it never replaces the other website demo.
  websiteDemo: {
    WEBHOOK_PATH: 'lumiere-website-demo',
    // Public URL the website chat posts to = <your n8n public URL>/webhook/<WEBHOOK_PATH>
    PUBLIC_WEBHOOK_URL: 'https://hundredth-silliness-crispy.ngrok-free.dev/webhook/lumiere-website-demo',
    ALLOWED_ORIGINS: ['https://hamzamihoubi.com'], // where the website is served (CORS)
    CALENDAR_ID: '8cafb313049727f666d5df77469b771b2d45a0c144e5823ba45e95a425f2af7b@group.calendar.google.com', // "Lumière Demo" (created 2026-11-24)
    CALENDAR_NAME: 'Lumière Demo',
    credentials: {
      googleCalendar: { id: 'hDz7EcZEdPypZGV4', name: 'DEMO - Google Calendar' }, // shared with the older website demo
      openRouter: { id: '1LzpxYC9KJuRY5cL', name: 'DEMO - OpenRouter' }, // shared with the older website demo
    },
    SHARED_CREDENTIALS: ['googleCalendar', 'openRouter'], // same rules as the top-level list
    workflows: {
      main: 'lumWebDemoMain01',
      book: 'lumWebDemoBook01',
      cancel: 'lumWebDemoCanc01',
      reschedule: 'lumWebDemoResc01',
      find: 'lumWebDemoFind01',
      check: 'lumWebDemoChck01',
    },
  },
};
