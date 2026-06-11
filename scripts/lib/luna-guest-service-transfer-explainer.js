'use strict';

/**
 * Stage 27test-g — Guest-friendly service/transfer side-question replies (dry-run copy only).
 * Used during active booking/quote flows; no service or transfer records created.
 */

function normalizeLang(lang) {
  const l = String(lang || 'en').trim().toLowerCase().slice(0, 2);
  return ['en', 'it', 'es', 'de', 'fr'].includes(l) ? l : 'en';
}

function detectServiceSideQuestionIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return null;

  if (/\b(?:surf\s+lesson|surf\s+lessons|surf\s+school|lezione(?:\s+di\s+surf)?|lezioni(?:\s+di\s+surf)?|clase(?:s)?\s+de\s+surf|cours\s+de\s+surf|surfschule|surfunterricht)\b/i.test(t)) {
    return 'surf_lessons';
  }
  if (/\b(?:meal|meals|dinner|dinners|breakfast|lunch|food|cena|comida|repas)\b/i.test(t)) return 'meals';
  if (/\b(?:yoga)\b/i.test(t)) return 'yoga';
  if (/\b(?:wetsuit|muta|neopren|combinaison)\b/i.test(t)) return 'wetsuit';
  if (/\b(?:soft\s+top|softtop|foam\s+board)\b/i.test(t)) return 'soft_top';
  if (/\b(?:hard\s+board|shortboard|fiberglass\s+board)\b/i.test(t)) return 'hard_board';
  if (/\b(?:do you|can i|can we|can you|do we)\b.*\b(?:rent|hire|offer)\b.*\bboards?\b/i.test(t)) {
    return 'board_rental';
  }
  if (/\b(?:surfboard|surf\s+board|surfbrett|tabla(?:\s+de\s+surf)?|planche|boards?)\b/i.test(t)) return 'board_rental';
  if (/\b(?:add|rent|book|extra|addon|add-on|service|services|equipment|gear|noleggi|alquiler|location|mieten)\b/i.test(t)
    && /\b(?:wetsuit|surfboard|lesson|yoga|board|muta|tabla|lezione|clase|cours)\b/i.test(t)) {
    return 'services_general';
  }
  if (/\b(?:what(?:'s| is| are)|how much).*\b(?:service|services|add-on|add on|extras|rentals|lessons)\b/i.test(t)) {
    return 'services_general';
  }
  return null;
}

function isPaymentMethodTransferQuestion(text) {
  const t = String(text || '');
  return /\b(?:puedo|podemos|se\s+puede|pagar|pago|pay(?:ment)?|pagare|payer|bezahlen|zahlen)\b/i.test(t)
    && /\b(?:transferencia|bank\s+transfer|überweisung|bonifico|virement)\b/i.test(t);
}

function detectTransferSideQuestionIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (isPaymentMethodTransferQuestion(t)) return null;

  if (/\b(?:airport\s+transfer|transfer\s+from|pick.?up\s+from|transfer\s+included|include\s+transfer|shuttle|aeropuerto|aeroporto|flughafen|transfert)\b/i.test(t)) {
    return 'transfer_general';
  }
  if (/\b(?:Santander|Bilbao|SDR|BIO)\b/i.test(t) && /\b(?:transfer|airport|pickup|shuttle|aeropuerto|aeroporto|flughafen)\b/i.test(t)) {
    return 'transfer_general';
  }
  if (/\b(?:Santander|Bilbao|SDR|BIO)\b/i.test(t) && /\b(?:flight|fly|arrive|arrival|land)\b/i.test(t)) {
    return 'transfer_general';
  }
  if (/\b(?:bus\s+station|estaci[oó]n\s+de\s+autobuses|stazione\s+(?:dei|degli?\s+)?autobus)\b/i.test(t)) {
    return 'transfer_general';
  }
  if (/\b(?:flight\s+(?:is\s+)?(?:delayed|late)|delayed\s+flight|late\s+arrival|arriv(?:e|ing)\s+(?:late|around|after))\b/i.test(t)) {
    return 'transfer_general';
  }
  return null;
}

function isPackageBooking(packageInterest) {
  const pkg = String(packageInterest || '').trim().toLowerCase();
  return pkg && pkg !== 'no_package' && pkg !== 'accommodation_only';
}

function buildSurfLessonsReply(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: 'Yes — we can add surf lessons to your stay 😊 One lesson is €35, or €30 each if you book more than one. I am not adding services to your booking yet.',
    it: 'Sì — possiamo aggiungere lezioni di surf 😊 Una lezione €35, o €30 ciascuna se ne prenoti più di una. Non sto ancora aggiungendo servizi alla prenotazione.',
    es: 'Sí — podemos añadir clases de surf 😊 Una clase €35, o €30 cada una si reservas más de una. Aún no añado servicios a tu reserva.',
    de: 'Ja — wir können Surfkurse hinzufügen 😊 Ein Kurs €35, oder €30 pro Stück bei mehr als einem. Ich buche noch keine Services in deine Buchung ein.',
    fr: 'Oui — on peut ajouter des cours de surf 😊 Un cours €35, ou €30 chacun si vous en réservez plusieurs. Je n’ajoute pas encore de services à la réservation.',
  };
  return map[L] || map.en;
}

function buildYogaReply(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: 'Yoga is €15 per class and is usually booked on site, unless it is part of a special retreat or camp. I am not adding it to your booking yet.',
    it: 'Lo yoga costa €15 a lezione e di solito si prenota in loco, salvo retreat o camp speciali. Non lo aggiungo ancora alla prenotazione.',
    es: 'Yoga cuesta €15 por clase y normalmente se reserva en el sitio, salvo retiros o camps especiales. Aún no lo añado a tu reserva.',
    de: 'Yoga kostet €15 pro Klasse und wird meist vor Ort gebucht, außer bei Special-Retreats oder Camps. Ich buche es noch nicht in deine Buchung ein.',
    fr: 'Le yoga est à 15 € par cours, en général réservé sur place sauf retraite ou camp spécial. Je ne l’ajoute pas encore à la réservation.',
  };
  return map[L] || map.en;
}

function buildBoardRentalReply(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: 'Yes — we can help with board rental. Soft tops from €15/day and hard boards from €20/day.',
    it: 'Sì — possiamo aiutarti con il noleggio tavola. Soft top da €15/giorno e hard board da €20/giorno.',
    es: 'Sí — podemos ayudarte con el alquiler de tabla. Soft top desde €15/día y hard board desde €20/día.',
    de: 'Ja — wir können beim Board-Verleih helfen. Softtops ab €15/Tag und Hardboards ab €20/Tag.',
    fr: 'Oui — on peut vous aider pour la location de planche. Soft top à partir de 15 €/jour et hard board à partir de 20 €/jour.',
  };
  return map[L] || map.en;
}

function buildWetsuitReply(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: 'Wetsuit rental is €5 per day. Wetsuit + soft top promo is €15/day, or wetsuit + hard board promo €20/day. I am not adding rentals to your booking yet.',
    it: 'Noleggio muta €5 al giorno. Promo muta + soft top €15/giorno, o muta + hard board €20/giorno. Non aggiungo ancora noleggi alla prenotazione.',
    es: 'Neopreno €5 por día. Promo neopreno + soft top €15/día, o neopreno + hard board €20/día. Aún no añado alquileres a tu reserva.',
    de: 'Neopren-Verleih €5 pro Tag. Promo Neopren + Softtop €15/Tag oder Neopren + Hardboard €20/Tag. Ich buche noch keine Leihe in deine Buchung ein.',
    fr: 'Location combinaison 5 €/jour. Promo combinaison + soft top 15 €/jour, ou combinaison + hard board 20 €/jour. Je n’ajoute pas encore de location à la réservation.',
  };
  return map[L] || map.en;
}

function buildServicesGeneralReply(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: 'We can add extras like surf lessons (€35 one / €30 each for more), wetsuit €5/day, boards from €15–20/day, and yoga €15/class on site. I am not adding anything to your booking yet.',
    it: 'Possiamo aggiungere extra come lezioni surf (€35 una / €30 cad.), muta €5/giorno, tavole da €15–20/giorno e yoga €15/lezione in loco. Non aggiungo ancora nulla alla prenotazione.',
    es: 'Podemos añadir extras como clases de surf (€35 una / €30 c/u), neopreno €5/día, tablas €15–20/día y yoga €15/clase en el sitio. Aún no añado nada a tu reserva.',
    de: 'Extras wie Surfkurse (€35 einzeln / €30 pro Stück), Neopren €5/Tag, Boards €15–20/Tag und Yoga €15/Klasse vor Ort sind möglich. Ich buche noch nichts in deine Buchung ein.',
    fr: 'On peut ajouter des extras : cours de surf (35 € / 30 € chacun), combinaison 5 €/jour, planches 15–20 €/jour, yoga 15 €/cours sur place. Je n’ajoute rien à la réservation pour l’instant.',
  };
  return map[L] || map.en;
}

function buildServiceSideQuestionReply(lang, intent, messageText) {
  const kind = intent || detectServiceSideQuestionIntent(messageText) || 'services_general';
  switch (kind) {
    case 'surf_lessons':
      return buildSurfLessonsReply(lang);
    case 'yoga':
      return buildYogaReply(lang);
    case 'meals':
      return buildServicesGeneralReply(lang);
    case 'board_rental':
      return buildBoardRentalReply(lang);
    case 'wetsuit':
    case 'soft_top':
    case 'hard_board':
    case 'board_rental':
      return buildWetsuitReply(lang);
    default:
      return buildServicesGeneralReply(lang);
  }
}

function buildTransferSideQuestionReply(lang, messageText, options) {
  const L = normalizeLang(lang);
  const opts = options || {};
  const pkg = opts.packageInterest;
  const guests = Number(opts.guestCount) || 0;
  const hasPackage = isPackageBooking(pkg);
  const t = String(messageText || '');

  if (/\b(?:bus\s+station|estaci[oó]n\s+de\s+autobuses|stazione\s+(?:dei|degli?\s+)?autobus)\b/i.test(t)) {
    const map = {
      en: 'We usually don\'t do bus-station transfers — but we can pick everyone up together from the airport instead 😊 Share your flight details?',
      it: 'Di solito non facciamo transfer dalla stazione degli autobus — ma possiamo venire a prendervi tutti insieme in aeroporto 😊 Mandami i dettagli del volo?',
      es: 'Normalmente no hacemos transfers desde la estación de autobuses — pero podemos recogeros juntos en el aeropuerto 😊 ¿Me pasas los detalles del vuelo?',
      de: 'Vom Busbahnhof holen wir normalerweise nicht ab — aber wir können euch gemeinsam am Flughafen abholen 😊 Schick mir deine Flugdetails?',
      fr: 'On ne fait en général pas de transfert depuis la gare routière — mais on peut vous récupérer ensemble à l’aéroport 😊 Partagez vos infos de vol ?',
    };
    return map[L] || map.en;
  }

  if (/\b(?:flight\s+(?:is\s+)?(?:delayed|late)|delayed\s+flight|late\s+arrival|arriv(?:e|ing)\s+(?:late|around|after))\b/i.test(t)
    && !/\b(?:Bilbao|BIO)\b/i.test(t)) {
    const map = {
      en: 'No stress if your flight shifts or you arrive late — send your updated arrival time and we\'ll sort pickup 👍',
      it: 'Nessun stress se il volo cambia o arrivi tardi — mandami l\'orario aggiornato e organizziamo il pickup 👍',
      es: 'Sin estrés si el vuelo cambia o llegas tarde — mándame la hora actualizada y organizamos la recogida 👍',
      de: 'Kein Stress bei Flugverspätung oder später Ankunft — schick mir die aktuelle Ankunftszeit und wir klären den Pickup 👍',
      fr: 'Pas de stress si votre vol change ou si vous arrivez tard — envoyez l’heure mise à jour et on organise le pickup 👍',
    };
    return map[L] || map.en;
  }

  const mentionsBilbao = /\bbilbao\b|\bBIO\b/i.test(t);
  const mentionsSantander = /\bsantander\b|\bSDR\b/i.test(t);

  if (mentionsBilbao) {
    if (!hasPackage) {
      const map = {
        en: 'Bilbao airport transfer is not offered without a package — we recommend the bus from Bilbao. Santander transfer is €25 without a package, or included with Malibu, Uluwatu, or Waimea.',
        it: 'Il transfer aeroporto Bilbao non è offerto senza pacchetto — consigliamo il bus da Bilbao. Santander €25 senza pacchetto, o incluso con Malibu, Uluwatu o Waimea.',
        es: 'El transfer del aeropuerto de Bilbao no se ofrece sin paquete — recomendamos el autobús desde Bilbao. Santander €25 sin paquete, o incluido con Malibu, Uluwatu o Waimea.',
        de: 'Bilbao-Flughafen-Transfer ohne Paket bieten wir nicht an — wir empfehlen den Bus ab Bilbao. Santander €25 ohne Paket, oder inklusive mit Malibu, Uluwatu oder Waimea.',
        fr: 'Le transfert aéroport Bilbao n’est pas proposé sans forfait — nous recommandons le bus depuis Bilbao. Santander 25 € sans forfait, ou inclus avec Malibu, Uluwatu ou Waimea.',
      };
      return map[L] || map.en;
    }
    if (guests > 0 && guests < 4) {
      const map = {
        en: 'Bilbao airport transfer is normally only for package groups of 4+, at an extra €15 per person when we can arrange it. Santander transfer is included with your package booking.',
        it: 'Il transfer Bilbao di solito è solo per gruppi pacchetto da 4+, extra €15 a persona quando possibile. Il transfer Santander è incluso con il tuo pacchetto.',
        es: 'El transfer de Bilbao suele ser solo para grupos de paquete de 4+, extra €15 por persona cuando podamos. El transfer de Santander está incluido con tu paquete.',
        de: 'Bilbao-Transfer ist normalerweise nur für Paketgruppen ab 4, extra €15 pro Person wenn möglich. Santander-Transfer ist bei deiner Paketbuchung inklusive.',
        fr: 'Le transfert Bilbao est en général pour les groupes forfait de 4+, supplément 15 €/personne quand c’est possible. Le transfert Santander est inclus avec votre forfait.',
      };
      return map[L] || map.en;
    }
    const map = {
      en: 'Bilbao airport transfer can be arranged for package bookings at an extra €15 per person (normally for groups of 4+). Santander transfer is included with package bookings.',
      it: 'Il transfer Bilbao si può organizzare per i pacchetti con extra €15 a persona (di solito gruppi da 4+). Il transfer Santander è incluso con i pacchetti.',
      es: 'El transfer de Bilbao se puede organizar en reservas con paquete por €15 extra por persona (normalmente grupos de 4+). El transfer de Santander está incluido con paquetes.',
      de: 'Bilbao-Transfer ist bei Paketbuchungen mit extra €15 pro Person möglich (normalerweise Gruppen ab 4). Santander-Transfer ist bei Paketbuchungen inklusive.',
      fr: 'Le transfert Bilbao peut être organisé pour les forfaits avec 15 €/personne en supplément (souvent groupes de 4+). Le transfert Santander est inclus avec les forfaits.',
    };
    return map[L] || map.en;
  }

  if (hasPackage || mentionsSantander) {
    const map = {
      en: 'Yes 😊 Santander airport transfer is included with package bookings like yours. I am not arranging pickup yet.',
      it: 'Sì 😊 Il transfer aeroporto Santander è incluso con i pacchetti come il tuo. Non sto ancora organizzando il pickup.',
      es: 'Sí 😊 El transfer del aeropuerto de Santander está incluido con paquetes como el tuyo. Aún no organizo la recogida.',
      de: 'Ja 😊 Santander-Flughafen-Transfer ist bei Paketbuchungen wie deiner inklusive. Ich organisiere noch keinen Pickup.',
      fr: 'Oui 😊 Le transfert aéroport Santander est inclus avec les forfaits comme le vôtre. Je n’organise pas encore le pickup.',
    };
    return map[L] || map.en;
  }

  const map = {
    en: 'Santander airport transfer is €25 without a package, or included with Malibu, Uluwatu, or Waimea. Bilbao transfer is only for package groups of 4+ at €15 per person extra — without a package we recommend the bus from Bilbao.',
    it: 'Transfer Santander €25 senza pacchetto, o incluso con Malibu, Uluwatu o Waimea. Bilbao solo per gruppi pacchetto da 4+ a €15 extra a persona — senza pacchetto consigliamo il bus da Bilbao.',
    es: 'Transfer Santander €25 sin paquete, o incluido con Malibu, Uluwatu o Waimea. Bilbao solo para grupos de paquete de 4+ a €15 extra por persona — sin paquete recomendamos el bus desde Bilbao.',
    de: 'Santander-Transfer €25 ohne Paket, oder inklusive mit Malibu, Uluwatu oder Waimea. Bilbao nur für Paketgruppen ab 4 zu €15 extra pro Person — ohne Paket empfehlen wir den Bus ab Bilbao.',
    fr: 'Transfert Santander 25 € sans forfait, ou inclus avec Malibu, Uluwatu ou Waimea. Bilbao seulement pour groupes forfait de 4+ à 15 €/personne en plus — sans forfait nous recommandons le bus depuis Bilbao.',
  };
  return map[L] || map.en;
}

module.exports = {
  detectServiceSideQuestionIntent,
  detectTransferSideQuestionIntent,
  isPaymentMethodTransferQuestion,
  buildServiceSideQuestionReply,
  buildTransferSideQuestionReply,
  isPackageBooking,
};
