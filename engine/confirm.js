// Lumière confirmation gate: classifier, language detection and the texts the
// SERVER sends while a cancellation / reschedule waits for the customer's yes.
// SOURCE OF TRUTH. The builders copy createConfirm() verbatim into the engine
// Decide nodes and into the main workflows' confirmation nodes, so it must stay
// self-contained (no require, no globals besides Date/Math/JSON/String).
//
// classify(message) looks at the customer's ACTUAL message, never at the AI:
//   'yes'     - a clear yes (EN/FR/ES/AR), e.g. "yes", "oui je confirme", "sí", "نعم"
//   'no'      - a clear no, e.g. "no", "non merci", "no, mantener", "لا"
//   'unclear' - hesitation or a mixed answer ("maybe", "yes no", "hmm", "👍")
//   'other'   - anything else (a new request, a different time, a question)
function createConfirm() {
  'use strict';
  const words = (s) => s.split(' ').filter(Boolean);
  // Vocabularies go through the same normalization as the messages (so "أؤكد" == "اوكد").
  const set = (s) => new Set(words(base(s)));

  // Single-word vocabularies (written naturally; normalized by set()).
  const YES = set('yes y yeah yea yep yup sure ok okay k confirm confirmed confirming affirmative correct right absolutely definitely oui ouais confirme confirmez confirmer si claro vale confirmo confirmado correcto exacto perfecto' +
    ' نعم ايوه ايوا اي اكيد موافق موافقه اوكي اؤكد تاكيد اكد مؤكد');
  const NO = set('no nope nah not dont never keep non pas garder garde gardez gardons conserver conserve maintenir jamais mantener mantenla mantenlo dejala dejalo nunca' +
    ' لا كلا ابق ابقي اتركه اتركيه لاتلغي لاتغير ابقيه');
  // Words that may appear next to a yes/no without changing its meaning.
  const NEUTRAL = set('please pls plz thanks thank you thx it its that this the my appointment one booking reservation go ahead do please_do and so yes_please' +
    ' cancel cancelling cancellation move change reschedule it\'s' +
    ' merci svp stp sil vous plait te plait je le la mon ma rendez vous rdv rendezvous annuler annulez annule annulation deplacer deplacez deplace changer changez allez y vas' +
    ' gracias por favor la lo mi cita cancelar cancelala cancelalo cambiar cambiala cambialo mover muevela muevelo adelante' +
    ' من فضلك لو سمحت شكرا شكرًا الموعد موعدي الغ الغي الغاء الإلغاء الغيه انقل انقله غير غيره نقل تغيير النقل');
  const UNSURE = set('maybe perhaps hmm hm hmmm mmm idk unsure possibly dunno peutetre bof hesite hesiter quizas quiza talvez acaso ربما يمكن مدري');
  const PHRASES = [
    // multi-word expressions, mapped to a single token before matching
    [/\b(go ahead|of course|that s right|thats right|sounds good|yes please|do it|please do)\b/g, ' yes '],
    [/\b(d accord|c est bon|cest bon|bien sur|allez y|vas y|tout a fait)\b/g, ' oui '],
    [/\b(de acuerdo|por supuesto|desde luego|esta bien|adelante|claro que si)\b/g, ' si '],
    [/\b(no thanks|no thank you|not now|dont do it|do not|don t|no need)\b/g, ' no '],
    [/\b(non merci|pas maintenant|ne pas|n annulez pas|ne l annulez pas|laissez le|laisse le|laissez la)\b/g, ' non '],
    [/\b(no gracias|mejor no|ahora no|no lo hagas|dejala como esta)\b/g, ' no '],
    [/\b(not sure|i don ?t know|i dont know|no idea|let me think|je ne sais pas|je sais pas|pas sur|no se|no estoy seguro|no estoy segura|deja que lo piense)\b/g, ' maybe '],
    // Arabic (normalized spelling; longest alternatives first - \b does not work for Arabic)
    [/(لا اعرف|مش متاكد|لست متاكدا|لست متاكده|ما ادري|لا ادري)/g, ' ربما '],
    [/(لا تلغيه|لا تلغي|لا تغيره|لا تغير|لا تنقله|لا تنقل)/g, ' لا '],
  ];

  function normalize(s) {
    let t = base(s);
    for (const [re, to] of PHRASES) t = t.replace(re, to);
    return t.replace(/\s+/g, ' ').trim();
  }
  function base(s) {
    let t = String(s == null ? '' : s).toLowerCase();
    t = t.normalize ? t.normalize('NFD').replace(/[̀-ͯ]/g, '') : t; // strip Latin accents
    t = t.replace(/[،؛؟٪-٭۔]/g, ' ') // Arabic punctuation (، ؛ ؟ ٪ ۔)
      .replace(/[ً-ٰٕـ]/g, '') // Arabic tashkeel, hamza marks (split off by NFD) + tatweel
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'ؤ');
    t = t.replace(/✅|✔️?|☑️?/g, ' yes ').replace(/❌|✖️?/g, ' no ');
    return t.replace(/['’`]/g, ' ').replace(/[^a-z0-9؀-ۿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function classify(message) {
    const raw = String(message == null ? '' : message);
    if (/\d/.test(raw)) return raw.trim().length ? 'other' : 'unclear'; // a time/date = a different request
    const t = normalize(raw);
    if (!t) return 'unclear'; // only emoji / punctuation, e.g. "👍" or "?"
    const tok = words(t);
    if (tok.length > 8) return 'other';
    let y = 0, n = 0, u = 0, other = 0;
    for (const w of tok) {
      if (YES.has(w)) y++;
      else if (NO.has(w)) n++;
      else if (UNSURE.has(w)) u++;
      else if (!NEUTRAL.has(w)) other++;
    }
    if (other) return (y || n || u) && other <= 1 && tok.length <= 3 ? 'unclear' : 'other';
    if (u || (y && n)) return 'unclear';
    if (y) return 'yes';
    if (n) return 'no';
    return 'unclear'; // only neutral words, e.g. "cancel", "please"
  }

  const FR = set('oui non je vous votre merci bonjour annuler annulez rendez rdv deplacer garder confirme svp stp est pas mon ma');
  const ES = set('si gracias vale quiero cita cancelar cambiar mover claro por favor mi hola confirmo dejala mantener');
  const EN = set('yes please thanks cancel keep move my appointment the confirm hello hi sure okay');
  function detectLang(message) {
    const raw = String(message == null ? '' : message);
    if (/[؀-ۿ]/.test(raw)) return 'ar';
    if (/[¿¡ñ]/i.test(raw)) return 'es';
    const tok = words(normalize(raw));
    let f = 0, e = 0, g = 0;
    for (const w of tok) { if (FR.has(w)) f++; if (ES.has(w)) e++; if (EN.has(w)) g++; }
    if (/\b(sí)\b/i.test(raw)) e += 2;
    const best = Math.max(f, e, g);
    if (!best) return '';
    if (f === best && f > e && f > g) return 'fr';
    if (e === best && e > f && e > g) return 'es';
    if (g === best && g > f && g > e) return 'en';
    return '';
  }

  // ---------------------------------------------------------------- texts
  const DAYS = {
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
    ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  };
  const MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  };
  const L = (lang) => (DAYS[lang] ? lang : 'en');
  function when(ms, lang, offsetMin) {
    const d = new Date(Number(ms) + Number(offsetMin || 0) * 60000);
    const l = L(lang); const p = (n) => String(n).padStart(2, '0');
    const day = DAYS[l][d.getUTCDay()], date = d.getUTCDate(), mon = MONTHS[l][d.getUTCMonth()], t = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
    if (l === 'en') return day + ' ' + date + ' ' + mon + ' at ' + t;
    if (l === 'fr') return day + ' ' + date + ' ' + mon + ' à ' + t;
    if (l === 'es') return day + ' ' + date + ' de ' + mon + ' a las ' + t;
    return day + ' ' + date + ' ' + mon + ' الساعة ' + t;
  }
  // "“Maria - Women's haircut”" - the customer's own appointment title (service if known).
  function what(rec) {
    const name = String((rec && (rec.svc || rec.sum)) || '').replace(/[{}"<>]/g, '').trim();
    return name ? '“' + name + '”' : '';
  }
  const T = {
    en: {
      askCancel: (w, a) => 'Just to confirm: do you want to cancel your appointment ' + w + ' on ' + a + '? Please reply Yes or No.',
      askMove: (w, a, b) => 'Just to confirm: do you want to move your appointment ' + w + ' from ' + a + ' to ' + b + '? Please reply Yes or No.',
      unclear: 'Sorry, I need a clear answer before I change anything.',
      voiceOnly: 'For your security, a voice message cannot confirm this change. Please type Yes or No.',
      doneCancel: (w, a) => 'Done: your appointment ' + w + ' on ' + a + ' has been cancelled. Would you like to book another time?',
      doneMove: (w, a, b) => 'Done: your appointment ' + w + ' is now on ' + b + ' (instead of ' + a + '). See you then!',
      kept: (w, a) => 'No problem, nothing was changed: your appointment ' + w + ' on ' + a + ' stays as it is. Can I help with anything else?',
      expired: (act) => 'That confirmation request has expired, so nothing was changed. If you still want to ' + (act === 'cancel' ? 'cancel' : 'move') + ' your appointment, just tell me again.',
      invalid: (why) => 'I could not complete that change, so nothing was changed (' + why + '). Please tell me again what you would like to do.',
      unknown: 'Sorry, I could not confirm the result of that change. Please ask me "When is my appointment?" in a moment, or contact the salon.',
      why: { appointment_changed: 'the appointment changed in the meantime', conflict: 'that new time is no longer free', default: 'the confirmation is no longer valid' },
      chips: { cancel: ['Yes, cancel it', 'No, keep it'], reschedule: ['Yes, move it', 'No, keep it'], afterCancel: ['Book a new appointment', 'Do you have any availability this Saturday?'], after: ['When is my appointment?', 'That\'s all, thank you'] },
    },
    fr: {
      askCancel: (w, a) => 'Pour confirmer : voulez-vous annuler votre rendez-vous ' + w + ' du ' + a + ' ? Répondez Oui ou Non.',
      askMove: (w, a, b) => 'Pour confirmer : voulez-vous déplacer votre rendez-vous ' + w + ' du ' + a + ' au ' + b + ' ? Répondez Oui ou Non.',
      unclear: 'Désolée, j\'ai besoin d\'une réponse claire avant de changer quoi que ce soit.',
      voiceOnly: 'Pour votre sécurité, un message vocal ne peut pas confirmer ce changement. Écrivez Oui ou Non.',
      doneCancel: (w, a) => 'C\'est fait : votre rendez-vous ' + w + ' du ' + a + ' est annulé. Souhaitez-vous prendre un autre rendez-vous ?',
      doneMove: (w, a, b) => 'C\'est fait : votre rendez-vous ' + w + ' est maintenant le ' + b + ' (au lieu du ' + a + '). À bientôt !',
      kept: (w, a) => 'Très bien, rien n\'a changé : votre rendez-vous ' + w + ' du ' + a + ' est maintenu. Puis-je vous aider pour autre chose ?',
      expired: (act) => 'Cette demande de confirmation a expiré, rien n\'a changé. Si vous souhaitez toujours ' + (act === 'cancel' ? 'annuler' : 'déplacer') + ' votre rendez-vous, redites-le-moi.',
      invalid: (why) => 'Je n\'ai pas pu effectuer ce changement, rien n\'a changé (' + why + '). Redites-moi ce que vous souhaitez faire.',
      unknown: 'Désolée, je n\'ai pas pu vérifier le résultat de ce changement. Demandez-moi « Quand est mon rendez-vous ? » dans un instant, ou contactez le salon.',
      why: { appointment_changed: 'le rendez-vous a changé entre-temps', conflict: 'ce nouvel horaire n\'est plus libre', default: 'la confirmation n\'est plus valable' },
      chips: { cancel: ['Oui, annuler', 'Non, garder'], reschedule: ['Oui, déplacer', 'Non, garder'], afterCancel: ['Prendre un nouveau rendez-vous', 'Avez-vous des disponibilités samedi ?'], after: ['Quand est mon rendez-vous ?', 'C\'est tout, merci'] },
    },
    es: {
      askCancel: (w, a) => 'Para confirmar: ¿quieres cancelar tu cita ' + w + ' del ' + a + '? Responde Sí o No.',
      askMove: (w, a, b) => 'Para confirmar: ¿quieres mover tu cita ' + w + ' del ' + a + ' al ' + b + '? Responde Sí o No.',
      unclear: 'Perdona, necesito una respuesta clara antes de tocar nada.',
      voiceOnly: 'Por tu seguridad, una nota de voz no puede confirmar este cambio. Escribe Sí o No.',
      doneCancel: (w, a) => 'Hecho: tu cita ' + w + ' del ' + a + ' ha sido cancelada. ¿Quieres reservar otra hora?',
      doneMove: (w, a, b) => 'Hecho: tu cita ' + w + ' es ahora el ' + b + ' (en lugar del ' + a + '). ¡Hasta pronto!',
      kept: (w, a) => 'Sin problema, no se ha tocado nada: tu cita ' + w + ' del ' + a + ' se mantiene. ¿Te ayudo con algo más?',
      expired: (act) => 'Esta solicitud de confirmación ha caducado, así que no se ha tocado nada. Si aún quieres ' + (act === 'cancel' ? 'cancelar' : 'mover') + ' tu cita, dímelo de nuevo.',
      invalid: (why) => 'No he podido hacer ese cambio, así que no se ha tocado nada (' + why + '). Dime de nuevo qué quieres hacer.',
      unknown: 'Perdona, no he podido comprobar el resultado de ese cambio. Pregúntame «¿Cuándo es mi cita?» en un momento, o contacta con el salón.',
      why: { appointment_changed: 'la cita ha cambiado entretanto', conflict: 'esa nueva hora ya no está libre', default: 'la confirmación ya no es válida' },
      chips: { cancel: ['Sí, cancelar', 'No, mantener'], reschedule: ['Sí, mover', 'No, mantener'], afterCancel: ['Reservar una nueva cita', '¿Tenéis disponibilidad este sábado?'], after: ['¿Cuándo es mi cita?', 'Eso es todo, gracias'] },
    },
    ar: {
      askCancel: (w, a) => 'للتأكيد: هل تريد إلغاء موعدك ' + w + ' يوم ' + a + '؟ يرجى الرد بنعم أو لا.',
      askMove: (w, a, b) => 'للتأكيد: هل تريد نقل موعدك ' + w + ' من ' + a + ' إلى ' + b + '؟ يرجى الرد بنعم أو لا.',
      unclear: 'عذرًا، أحتاج إلى إجابة واضحة قبل أي تغيير.',
      voiceOnly: 'لأمانك، لا يمكن لرسالة صوتية تأكيد هذا التغيير. يرجى كتابة نعم أو لا.',
      doneCancel: (w, a) => 'أُلغي موعدك ' + w + ' يوم ' + a + '. هل تريد حجز موعد آخر؟',
      doneMove: (w, a, b) => 'أصبح موعدك ' + w + ' يوم ' + b + ' (بدلًا من ' + a + '). نراك قريبًا!',
      kept: (w, a) => 'حسنًا، لم يتغير شيء: موعدك ' + w + ' يوم ' + a + ' باقٍ كما هو. هل يمكنني مساعدتك في شيء آخر؟',
      expired: (act) => 'انتهت صلاحية طلب التأكيد، لذلك لم يتغير شيء. إذا كنت لا تزال تريد ' + (act === 'cancel' ? 'إلغاء' : 'نقل') + ' موعدك، أخبرني مرة أخرى.',
      invalid: (why) => 'لم أتمكن من إجراء هذا التغيير، لذلك لم يتغير شيء (' + why + '). أخبرني مرة أخرى بما تريد.',
      unknown: 'عذرًا، لم أتمكن من التحقق من نتيجة هذا التغيير. اسألني «متى موعدي؟» بعد قليل، أو تواصل مع الصالون.',
      why: { appointment_changed: 'تغيّر الموعد في هذه الأثناء', conflict: 'الوقت الجديد لم يعد متاحًا', default: 'التأكيد لم يعد صالحًا' },
      chips: { cancel: ['نعم، ألغِ الموعد', 'لا، أبقِ الموعد'], reschedule: ['نعم، انقل الموعد', 'لا، أبقِ الموعد'], afterCancel: ['حجز موعد جديد', 'هل لديكم مواعيد متاحة يوم السبت؟'], after: ['متى موعدي؟', 'هذا كل شيء، شكرًا'] },
    },
  };
  const texts = (lang) => T[L(lang)];
  function ask(rec, lang, off) {
    const t = texts(lang);
    return rec.act === 'cancel' ? t.askCancel(what(rec), when(rec.os, lang, off)) : t.askMove(what(rec), when(rec.os, lang, off), when(rec.ns, lang, off));
  }
  // Marker the tools append to CONFIRMATION_REQUIRED results so the main workflow can show
  // the exact pending request without another calendar read (no braces: survives any wrapping).
  const MARK = /\[\[CONFIRM:([A-Za-z0-9%._~!*'()-]+)\]\]/g;
  const mark = (pub) => '[[CONFIRM:' + encodeURIComponent(JSON.stringify(pub)) + ']]';
  function unmark(text) {
    let last = null;
    for (const m of String(text == null ? '' : text).matchAll(MARK)) { try { last = JSON.parse(decodeURIComponent(m[1])); } catch (e) { /* ignore */ } }
    return last;
  }
  // The part of a pending record that may leave the lock object (no identity key).
  const pub = (rec) => (rec ? { id: rec.id, act: rec.act, ev: rec.ev, os: rec.os, oe: rec.oe, ns: rec.ns || null, ne: rec.ne || null, sum: rec.sum || '', svc: rec.svc || '', at: rec.at, exp: rec.exp } : null);
  return { classify, normalize, detectLang, when, what, texts, ask, mark, unmark, pub };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createConfirm };
