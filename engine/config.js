// Opening hours, voice language and concurrency tuning for the booking engine.
// Calendar IDs, credential and timezone come from ../lumiere.config.js (the
// salon environment file). tools/build-workflows.js injects these values into
// every workflow; after editing, run the builds (README.md) and re-import.
const ENV = require('../lumiere.config.js');
const SALON = require('../salon-info.js');
module.exports = {
  // Calendar that holds the salon's appointments, and the one that holds the
  // system lock events (dated 2000-01-01, transparent, invisible in normal use).
  CALENDAR_ID: ENV.google.CALENDAR_ID,
  CALENDAR_NAME: ENV.google.CALENDAR_NAME,
  LOCK_CALENDAR_ID: ENV.google.LOCK_CALENDAR_ID || ENV.google.CALENDAR_ID,
  GOOGLE_CALENDAR_CREDENTIAL: ENV.credentials.googleCalendar,

  // The engine uses a FIXED UTC offset (no daylight saving time); the build
  // checks that TIMEZONE really has no DST and matches TZ_OFFSET_MIN.
  TIMEZONE: ENV.TIMEZONE,
  TZ_OFFSET_MIN: ENV.TZ_OFFSET_MIN,

  // DEMO opening hours (fictional - change them for a real salon). An
  // appointment must START at or after WORK_START and END by WORK_END.
  WORK_START: '09:00',
  WORK_END: '19:00',
  CLOSED_WEEKDAY: 0, // 0 = Sunday ... 6 = Saturday (JS getUTCDay()); -1 = open every day
  APPT_DEFAULT_MIN: 30, // slot step / length of calendar events that have no end time
  APPT_MAX_MIN: 240, // longest single appointment (balayage is 180 min in the demo menu)
  // The service catalogue (keys, durations, inclusions, aliases) from salon-info.js:
  // the ONLY source of an appointment's length (tools send service keys, never a duration).
  SERVICE_CATALOG: SALON.services.map((s) => ({ key: s.key, name: s.name, name_fr: s.name_fr, name_es: s.name_es, name_ar: s.name_ar, duration: s.duration, price: s.price, fromPrice: !!s.fromPrice, includes: s.includes || [], aliases: s.aliases || [] })),
  CURRENCY_SYMBOL: SALON.currencySymbol,

  // Voice notes (Cohere Transcribe). Cohere has NO automatic language
  // detection, so voice notes are SUPPORTED ONLY IN VOICE_LANGUAGE. The AI is
  // told so, and asks customers who speak another language to type instead.
  //   cohere-transcribe-03-2026        : en, fr, es, ar (and others) - one per request
  //   cohere-transcribe-arabic-07-2026 : Arabic (+ English code-switching) only
  // The build refuses any other model, or a language this project does not support.
  VOICE_MODEL: 'cohere-transcribe-03-2026',
  VOICE_LANGUAGE: 'es', // ISO-639-1: 'es', 'en', 'fr' or 'ar'

  // Calendar write mutex (serializes Book/Reschedule/Cancel critical sections)
  CAL_LOCK_ID: 'lumierelockcal01', // base32hex only (0-9, a-v)
  CAL_LOCK_TTL_MS: 45000,
  CAL_LOCK_MAX_WAIT_MS: 50000, // > TTL so one call survives a crashed holder
  LEASE_MARGIN_MS: 20000, // never start a calendar write with less lease left than this

  // Per-customer (chat) serialization
  CHAT_LOCK_PREFIX: 'lumierelockchat',
  CHAT_LOCK_TTL_MS: 240000,
  CHAT_MAX_WAIT_MS: 270000, // must exceed the TTL: a waiter behind a crashed holder outlives the dead lease
  CHAT_SETTLE_MS: 1500, // lets near-simultaneous deliveries register before ordering
  CHAT_WAITER_TTL_MS: 300000,
  CHAT_DEAD_WAITER_MS: 15000, // free + untouched lock this long => the waiter ahead is dead (stopped/crashed execution)
  CHAT_MAX_WAITERS: 30,
  PROCESSED_MAX: 60,
  // Confirmation gate (cancel / reschedule wait for the customer's explicit yes)
  CONFIRM_TTL_MS: 600000, // a pending confirmation expires after 10 minutes
  CONFIRM_USED_MAX: 20, // used/cleared confirmation ids remembered per customer (replay protection)
  CONFIRM_NOTES_MAX: 4, // recent system notes shown to the AI
  // A change the server completed stays recognisable for as long as the AI is told about
  // it (the [System log] window): a late yes / a truthful recap is answered from it.
  CONFIRM_DONE_MS: 7200000,

  // Website demo rate-limit counters (atomic conditional writes on lock objects)
  RATE_MAX_MS: 20000, // give up (and refuse the request) after this long
  RATE_CAS_MAX: 40, // max conditional-write retries under contention, then refuse

  JOURNAL_KEEP_MS: 600000,
  JOURNAL_MAX: 40,
  LOCK_STATE_MAX_CHARS: 6000,

  HTTP_TIMEOUT_MS: 10000,
  HTTP_MAX_RETRIES: 5,
  BACKOFF_BASE_MS: 400,
  BACKOFF_CAP_MS: 4000,
  POLL_MIN_MS: 400,
  POLL_MAX_MS: 2000,
  MIN_SLEEP_MS: 150,
  OP_DEADLINE_MS: 100000,
  MAX_STEPS: 600,

  MAIN_EXECUTION_TIMEOUT_S: 600,
  TOOL_EXECUTION_TIMEOUT_S: 150,
};
