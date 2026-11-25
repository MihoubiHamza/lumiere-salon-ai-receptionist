'use strict';
// ============================================================================
// Lumière Hair & Beauty Studio - DEMO salon profile.
//
// EVERYTHING HERE IS FICTIONAL DEMO DATA (address, phone, e-mail, prices,
// durations, policies). Edit this file to customize the salon, then run:
//   node tools/build-workflows.js && node tools/build-messenger.js && node website-demo/build-web-demo.js
//
// Where it is used:
//   - WhatsApp + Messenger: rendered into the "SALON INFO" and
//     "SERVICES & PRICES" sections of the AI prompt (tools/build-workflows.js).
//   - Website demo: copied into the DEMO CONFIG node (website-demo/demo-config.js).
// Opening hours, closed day and timezone are NOT here: they live in
// engine/config.js, because the booking engine enforces them.
// ============================================================================
module.exports = {
  name: 'Lumière Hair & Beauty Studio',
  name_ar: 'استوديو لوميير للشعر والتجميل',
  assistantName: 'Yasmine',
  description: 'a modern, welcoming hair and beauty salon',
  address: '12 Avenue de la Lumière, Demo City (fictional demo address)',
  phone: '+00 000 000 000 (fictional demo number)',
  email: 'hello@lumiere-salon.example (fictional demo address)',
  currency: 'EUR',
  currencySymbol: '€',

  // duration = minutes the appointment blocks on the calendar.
  // price = demo price; fromPrice: true means "from" (final price depends on
  // hair length / products and is confirmed at the salon).
  services: [
    { key: 'womens_cut', category: 'Hair', name: "Women's haircut & styling", name_fr: 'Coupe femme & coiffage', name_es: 'Corte de mujer y peinado', name_ar: 'قص وتصفيف شعر للنساء', duration: 60, price: 45, fromPrice: true, includes: ['blow_dry'],
      aliases: ['women\'s haircut','womens haircut','ladies haircut','ladies cut','cut and blow-dry','cut and blow dry','cut & blow-dry','cut and style','haircut','cut','coupe femme','coupe brushing','coupe et brushing','coupe','corte de mujer','corte y peinado','corte y secado','corte','قص شعر نسائي','قص وتصفيف','قص شعر','قص'] },
    { key: 'mens_cut', category: 'Hair', name: "Men's haircut", name_fr: 'Coupe homme', name_es: 'Corte de caballero', name_ar: 'قص شعر للرجال', duration: 30, price: 25, includes: [],
      aliases: ['men\'s haircut','mens haircut','gents cut','barber cut','haircut','cut','coupe homme','coupe','corte de hombre','corte de caballero','corte','قص شعر رجالي','قص شعر','قص'] },
    { key: 'blow_dry', category: 'Hair', name: 'Blow-dry & styling', name_fr: 'Brushing', name_es: 'Secado y peinado (brushing)', name_ar: 'تجفيف وتصفيف (براشينغ)', duration: 30, price: 30, fromPrice: true, includes: [],
      aliases: ['blow-dry','blow dry','blowdry','styling','blow-out','brushing','mise en plis','secado','peinado','سشوار','براشينغ','تصفيف'] },
    { key: 'treatment', category: 'Hair treatments', name: 'Nourishing hair treatment (mask + blow-dry)', name_fr: 'Soin nourrissant (masque + brushing)', name_es: 'Tratamiento nutritivo (mascarilla + secado)', name_ar: 'علاج مغذٍّ للشعر (ماسك + تجفيف)', duration: 45, price: 40, includes: ['blow_dry'],
      aliases: ['hair treatment','nourishing treatment','hair mask','mask','soin','soin cheveux','masque','tratamiento','mascarilla','علاج الشعر','ماسك'] },
    { key: 'keratin', category: 'Hair treatments', name: 'Keratin smoothing treatment', name_fr: 'Lissage à la kératine', name_es: 'Alisado de keratina', name_ar: 'علاج تنعيم بالكيراتين', duration: 150, price: 120, fromPrice: true, includes: [],
      aliases: ['keratin','keratin treatment','smoothing','lissage','kératine','keratine','alisado','keratina','كيراتين','تنعيم'] },
    { key: 'root_colour', category: 'Colour', name: 'Root colour touch-up', name_fr: 'Coloration racines', name_es: 'Tinte de raíces', name_ar: 'صبغة الجذور', duration: 90, price: 50, includes: [],
      aliases: ['roots','root colour','root color','root touch-up','colour','color','racines','couleur racines','coloration','couleur','raíces','raices','tinte','صبغة الجذور','الجذور','صبغة'] },
    { key: 'full_colour', category: 'Colour', name: 'Full hair colour', name_fr: 'Coloration complète', name_es: 'Tinte completo', name_ar: 'صبغة كاملة للشعر', duration: 120, price: 70, fromPrice: true, includes: ['root_colour'],
      aliases: ['full colour','full color','all-over colour','colour','color','coloration complète','coloration complete','coloration','couleur','tinte completo','tinte','color completo','صبغة كاملة','صبغة'] },
    { key: 'balayage', category: 'Colour', name: 'Balayage', name_fr: 'Balayage', name_es: 'Balayage', name_ar: 'بالياج', duration: 180, price: 140, fromPrice: true, includes: [],
      aliases: ['balayage','highlights','mèches','meches','mechas','reflejos','بالياج','هايلايت'] },
    { key: 'manicure', category: 'Nails', name: 'Manicure', name_fr: 'Manucure', name_es: 'Manicura', name_ar: 'مانيكير', duration: 45, price: 25, includes: [],
      aliases: ['manicure','nails','manucure','ongles','manicura','uñas','unas','مانيكير','أظافر','اظافر'] },
    { key: 'gel_manicure', category: 'Nails', name: 'Gel manicure', name_fr: 'Manucure semi-permanente', name_es: 'Manicura semipermanente', name_ar: 'مانيكير جل', duration: 60, price: 35, includes: ['manicure'],
      aliases: ['gel manicure','gel nails','gel polish','shellac','nails','semi-permanent','semi-permanente','vernis semi-permanent','manucure gel','ongles','manicura semipermanente','manicura de gel','uñas de gel','uñas','unas','مانيكير جل','جل','أظافر','اظافر'] },
    { key: 'pedicure', category: 'Nails', name: 'Pedicure', name_fr: 'Pédicure', name_es: 'Pedicura', name_ar: 'باديكير', duration: 60, price: 35, includes: [],
      aliases: ['pedicure','feet','pédicure','pedicura','باديكير','بديكير'] },
    { key: 'facial', category: 'Facial & beauty', name: 'Classic facial', name_fr: 'Soin du visage classique', name_es: 'Limpieza facial clásica', name_ar: 'عناية كلاسيكية بالوجه', duration: 60, price: 55, includes: [],
      aliases: ['facial','face treatment','skin care','soin du visage','soin visage','limpieza facial','tratamiento facial','عناية بالوجه','تنظيف البشرة'] },
    { key: 'brows', category: 'Facial & beauty', name: 'Eyebrow shaping', name_fr: 'Restructuration des sourcils', name_es: 'Diseño de cejas', name_ar: 'تشكيل الحواجب', duration: 30, price: 15, includes: [],
      aliases: ['eyebrows','brows','eyebrow shaping','sourcils','épilation sourcils','cejas','diseño de cejas','حواجب','تشكيل الحواجب'] },
  ],

  // Demo policies (fictional). The assistant only states what is written here.
  policies: [
    'Booking: appointments are recommended. Walk-ins are welcome only when a slot is free.',
    'Changes and cancellations: please let the salon know at least 24 hours in advance, so the time can be offered to another customer. No cancellation fee is mentioned in this demo - never invent one.',
    'Late arrival: if a customer arrives more than 15 minutes late, the service may need to be shortened or moved to another time.',
    'Colour services: for a first colour with the salon, a quick skin (patch) test at least 48 hours before is recommended - the customer can mention it and the team will arrange it at the salon.',
    'Prices marked "from" depend on hair length and products; the final price is confirmed at the salon before the service starts.',
    'Payment: card or cash at the salon. No online payment.',
    'Several services in one visit (e.g. cut + colour) are booked as one appointment whose length is the sum of the service durations (maximum 4 hours).',
  ],
};
