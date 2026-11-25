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
    { key: 'womens_cut', category: 'Hair', name: "Women's haircut & styling", name_fr: 'Coupe femme & coiffage', name_es: 'Corte de mujer y peinado', name_ar: 'قص وتصفيف شعر للنساء', duration: 60, price: 45, fromPrice: true },
    { key: 'mens_cut', category: 'Hair', name: "Men's haircut", name_fr: 'Coupe homme', name_es: 'Corte de caballero', name_ar: 'قص شعر للرجال', duration: 30, price: 25 },
    { key: 'blow_dry', category: 'Hair', name: 'Blow-dry & styling', name_fr: 'Brushing', name_es: 'Secado y peinado (brushing)', name_ar: 'تجفيف وتصفيف (براشينغ)', duration: 30, price: 30, fromPrice: true },
    { key: 'treatment', category: 'Hair treatments', name: 'Nourishing hair treatment (mask + blow-dry)', name_fr: 'Soin nourrissant (masque + brushing)', name_es: 'Tratamiento nutritivo (mascarilla + secado)', name_ar: 'علاج مغذٍّ للشعر (ماسك + تجفيف)', duration: 45, price: 40 },
    { key: 'keratin', category: 'Hair treatments', name: 'Keratin smoothing treatment', name_fr: 'Lissage à la kératine', name_es: 'Alisado de keratina', name_ar: 'علاج تنعيم بالكيراتين', duration: 150, price: 120, fromPrice: true },
    { key: 'root_colour', category: 'Colour', name: 'Root colour touch-up', name_fr: 'Coloration racines', name_es: 'Tinte de raíces', name_ar: 'صبغة الجذور', duration: 90, price: 50 },
    { key: 'full_colour', category: 'Colour', name: 'Full hair colour', name_fr: 'Coloration complète', name_es: 'Tinte completo', name_ar: 'صبغة كاملة للشعر', duration: 120, price: 70, fromPrice: true },
    { key: 'balayage', category: 'Colour', name: 'Balayage', name_fr: 'Balayage', name_es: 'Balayage', name_ar: 'بالياج', duration: 180, price: 140, fromPrice: true },
    { key: 'manicure', category: 'Nails', name: 'Manicure', name_fr: 'Manucure', name_es: 'Manicura', name_ar: 'مانيكير', duration: 45, price: 25 },
    { key: 'gel_manicure', category: 'Nails', name: 'Gel manicure', name_fr: 'Manucure semi-permanente', name_es: 'Manicura semipermanente', name_ar: 'مانيكير جل', duration: 60, price: 35 },
    { key: 'pedicure', category: 'Nails', name: 'Pedicure', name_fr: 'Pédicure', name_es: 'Pedicura', name_ar: 'باديكير', duration: 60, price: 35 },
    { key: 'facial', category: 'Facial & beauty', name: 'Classic facial', name_fr: 'Soin du visage classique', name_es: 'Limpieza facial clásica', name_ar: 'عناية كلاسيكية بالوجه', duration: 60, price: 55 },
    { key: 'brows', category: 'Facial & beauty', name: 'Eyebrow shaping', name_fr: 'Restructuration des sourcils', name_es: 'Diseño de cejas', name_ar: 'تشكيل الحواجب', duration: 30, price: 15 },
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
