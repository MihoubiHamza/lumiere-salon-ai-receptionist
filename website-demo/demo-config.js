'use strict';
// Fictional salon used by the public website demo (Lumière Hair & Beauty Studio).
// This object is written into the "DEMO CONFIG" node of the main demo
// workflow. That node is the ONLY place the demo reads salon data from at
// runtime: the AI prompt, the engine rules (hours, closed day) and the
// 5 tool sub-workflows all receive it from there. To change a value later,
// edit the DEMO CONFIG node in n8n (or salon-info.js / this file + rebuild).
// Nothing here is real: address, phone, e-mail, prices and policies are invented.
const SALON = require('../salon-info.js');
const HOURS = require('../engine/config.js');
const ENV = require('../lumiere.config.js').websiteDemo;

module.exports = {
  salon: {
    name: SALON.name,
    name_ar: SALON.name_ar,
    description: SALON.description,
    address: SALON.address,
    phone: SALON.phone,
    email: SALON.email,
    currency: SALON.currency,
    currencySymbol: SALON.currencySymbol,
    services: SALON.services,
    policies: SALON.policies,
  },

  // Rules enforced by the engine (Book / Reschedule / Cancel) and by
  // Check_Availability. 0 = Sunday ... 6 = Saturday (JavaScript getUTCDay).
  // Same opening hours as the WhatsApp / Messenger version (engine/config.js).
  tool: {
    // The separate Lumière website-demo calendar, set in ../lumiere.config.js
    // (websiteDemo.CALENDAR_ID). The demo refuses to run while it starts with PASTE_.
    CALENDAR_ID: ENV.CALENDAR_ID,
    LOCK_CALENDAR_ID: ENV.CALENDAR_ID,
    CALENDAR_NAME: ENV.CALENDAR_NAME,
    TIMEZONE: HOURS.TIMEZONE,
    TZ_OFFSET_MIN: HOURS.TZ_OFFSET_MIN, // fixed offset, no DST
    WORK_START: HOURS.WORK_START,
    WORK_END: HOURS.WORK_END, // every appointment must END by this time
    LUNCH_START: '', // optional break, e.g. '13:00' / '14:00' - empty = no break
    LUNCH_END: '',
    CLOSED_WEEKDAY: HOURS.CLOSED_WEEKDAY,
    APPT_DEFAULT_MIN: HOURS.APPT_DEFAULT_MIN,
    MAX_BOOKINGS_PER_SESSION: 2,
  },

  limits: {
    ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS, // from ../lumiere.config.js; also written into the Website Webhook node (CORS option)
    MAX_MESSAGE_CHARS: 500,
    MAX_BODY_CHARS: 4096,
    SESSION_MSGS_PER_HOUR: 30,
    IP_MSGS_PER_HOUR: 60,
    // Overall budget across ALL visitors (each AI reply costs one or more model calls).
    // Beyond it, visitors get a polite "busy" notice and no AI call is made.
    GLOBAL_MSGS_PER_HOUR: 120,
    GLOBAL_MSGS_PER_DAY: 600,
    // Only set true when n8n sits behind Cloudflare (which overwrites cf-connecting-ip).
    // Otherwise the client IP is the LAST X-Forwarded-For entry, the one the proxy
    // in front of n8n (e.g. ngrok) appends; every other IP header can be faked.
    TRUST_CF_CONNECTING_IP: false,
    DELETE_DEMO_EVENTS_AFTER_HOURS: 24,
  },

  // Salt for the one-way hashes of IP addresses and session ids (rate limits).
  // Random value set at deployment (2026-11-24). Changing it resets the rate-limit counters.
  hashSalt: '03f9d72f5abeda765361618a69d4c5f745d63c1fb0675816',

  texts: {
    en: {
      languageName: 'English',
      firstNotice: 'ℹ️ Demo with a fictional salon: use a fake name and do not share any real personal details.',
      nameNotice: '(A fake name is fine - this is a demo.)',
      medical: "I can't give medical or skin-health advice: this is a demo with a fictional salon. In a real salon, Yasmine would pass your question on to the team. If you have an allergic reaction or any urgent health problem, please contact a doctor or your local emergency number.",
      human: "This is a demo: there is no team behind this fictional salon. In a real salon, Yasmine would hand the conversation over to the salon team.",
      fallback: 'Sorry, a small technical hiccup in the demo. Please try again in a moment 🙏',
      rateLimited: "You've reached this demo's message limit for this hour. To see Yasmine with your own salon's details, message us on WhatsApp.",
      busy: 'The demo is very busy right now, so Yasmine is taking a short break. Please try again a little later.',
      confirm: ['Confirm', 'Cancel'],
      afterBooking: ['When is my appointment?', "I'd like to reschedule my appointment"],
      starters: ["Hi! I'd like to book a haircut for tomorrow.", 'How much does balayage cost?', 'Do you have any availability this Saturday?', 'Can you tell me about your hair treatments?'],
    },
    fr: {
      languageName: 'French',
      firstNotice: "ℹ️ Démo avec un salon fictif : utilisez un faux nom et n'écrivez aucune information personnelle réelle.",
      nameNotice: "(Un faux nom suffit, c'est une démo.)",
      medical: "Je ne peux donner aucun avis médical ou dermatologique : ceci est une démo avec un salon fictif. Dans un vrai salon, Yasmine transmettrait votre question à l'équipe. En cas de réaction allergique ou de problème de santé urgent, contactez un médecin ou le numéro d'urgence local.",
      human: "C'est une démo : il n'y a pas d'équipe derrière ce salon fictif. Dans un vrai salon, Yasmine transmettrait la conversation à l'équipe du salon.",
      fallback: 'Désolée, petit souci technique dans la démo. Réessayez dans un instant 🙏',
      rateLimited: "Vous avez atteint la limite de messages de la démo pour cette heure. Pour voir Yasmine avec les informations de votre salon, écrivez-nous sur WhatsApp.",
      busy: 'La démo est très sollicitée en ce moment, Yasmine fait une courte pause. Réessayez un peu plus tard.',
      confirm: ['Confirmer', 'Annuler'],
      afterBooking: ['Quand est mon rendez-vous ?', 'Je voudrais déplacer mon rendez-vous'],
      starters: ['Bonjour, je voudrais prendre rendez-vous pour une coloration.', 'Quels sont vos horaires ?', 'Combien coûte un balayage ?'],
    },
    es: {
      languageName: 'Spanish',
      firstNotice: 'ℹ️ Demo con un salón ficticio: usa un nombre inventado y no compartas datos personales reales.',
      nameNotice: '(Un nombre inventado está bien, es una demo.)',
      medical: 'No puedo dar consejos médicos ni sobre la salud de la piel: esto es una demo con un salón ficticio. En un salón real, Yasmine pasaría tu pregunta al equipo. Si tienes una reacción alérgica o cualquier problema de salud urgente, contacta con un médico o con el número de emergencias.',
      human: 'Esto es una demo: no hay ningún equipo detrás de este salón ficticio. En un salón real, Yasmine pasaría la conversación al equipo del salón.',
      fallback: 'Lo siento, ha habido un pequeño problema técnico en la demo. Inténtalo de nuevo en un momento 🙏',
      rateLimited: 'Has llegado al límite de mensajes de la demo para esta hora. Para ver a Yasmine con los datos de tu salón, escríbenos por WhatsApp.',
      busy: 'La demo tiene mucha actividad ahora mismo, así que Yasmine hace una breve pausa. Inténtalo de nuevo un poco más tarde.',
      confirm: ['Confirmar', 'Cancelar'],
      afterBooking: ['¿Cuándo es mi cita?', 'Quiero cambiar mi cita'],
      starters: ['Hola, ¿tenéis disponibilidad para un corte de pelo mañana?', '¿Cuánto cuesta un balayage?', '¿Qué horario tenéis?'],
    },
    ar: {
      languageName: 'Modern Standard Arabic',
      firstNotice: 'ℹ️ عرض تجريبي بصالون وهمي: استعمل اسماً وهمياً ولا تكتب أي معلومات شخصية حقيقية.',
      nameNotice: '(يكفي اسم وهمي، هذا عرض تجريبي.)',
      medical: 'لا يمكنني تقديم أي نصيحة طبية أو تتعلق بصحة البشرة: هذا عرض تجريبي بصالون وهمي. في صالون حقيقي، ترسل ياسمين سؤالك إلى الفريق. في حالة حساسية أو أي مشكلة صحية مستعجلة، اتصل بطبيب أو برقم الطوارئ المحلي.',
      human: 'هذا عرض تجريبي: لا يوجد فريق وراء هذا الصالون الوهمي. في صالون حقيقي، تحوّل ياسمين المحادثة إلى فريق الصالون.',
      fallback: 'عذراً، حدث خلل تقني بسيط في العرض التجريبي. أعد المحاولة بعد قليل 🙏',
      rateLimited: 'وصلت إلى حد الرسائل في العرض التجريبي لهذه الساعة. لرؤية ياسمين بمعلومات صالونك، راسلنا على واتساب.',
      busy: 'العرض التجريبي مزدحم جداً الآن، لذلك تأخذ ياسمين استراحة قصيرة. يرجى المحاولة بعد قليل.',
      confirm: ['تأكيد', 'إلغاء'],
      afterBooking: ['متى موعدي؟', 'أريد تغيير موعدي'],
      starters: ['أريد حجز موعد لقص الشعر', 'ما هي أوقات العمل؟', 'كم سعر البالياج؟'],
    },
  },
};
