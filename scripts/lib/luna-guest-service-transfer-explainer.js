'use strict';

/**
 * Stage 27test-g — Guest-friendly service/transfer side-question replies (dry-run copy only).
 * Used during active booking/quote flows; no service or transfer records created.
 */

function normalizeLang(lang) {
  const l = String(lang || 'en').trim().toLowerCase().slice(0, 2);
  return ['en', 'it', 'es', 'de', 'fr'].includes(l) ? l : 'en';
}

/**
 * Private vs group lesson qualifier. Private → System B catalog "Private Lesson" card;
 * group (or no qualifier once split) → System A group add-on. Bare "lesson" is handled by
 * the caller (ask private-or-group). See docs/LUNA-GUEST-BEHAVIOR-SPEC.md §7.
 */
const LESSON_PRIVATE_RE = /\b(?:private|privad[ao]|priv[ée]e?|privat[ao]?|1[\s-]?on[\s-]?1|one[\s-]?on[\s-]?one|1\s*:\s*1|individual)(?![a-z])/i;
const LESSON_GROUP_RE = /\b(?:group|grupo|gruppo|groupe|gruppe)(?![a-z])/i;

/** @returns {'private'|'group'|null} */
function detectLessonQualifier(text) {
  const t = String(text || '');
  if (LESSON_PRIVATE_RE.test(t)) return 'private';
  if (LESSON_GROUP_RE.test(t)) return 'group';
  return null;
}

/** Any lesson word — surf lesson, bare "lesson", private/group lesson, multilingual. */
function isLessonInquiry(text) {
  const t = String(text || '');
  return /\b(?:surf\s+lesson|surf\s+lessons|surf\s+school|lesson|lessons|lezione|lezioni|clase(?:s)?(?:\s+[\wàáéíóúñ]+)?\s+de\s+surf|clase(?:s)?\b|cours(?:\s+[\wàâéèêëïîôûüç]+)?\s+de\s+surf|surfschule|surfstunde|surfunterricht|surfkurs(?:e|en)?)\b/i.test(t);
}

function detectServiceSideQuestionIntent(text) {
  const t = String(text || '');
  if (!t.trim()) return null;

  if (isLessonInquiry(t)) {
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
  if (/\b(?:bus|autob[uú]s|autobus)\b/i.test(t) && /\b(?:bilbao|BIO)\b/i.test(t)) {
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
    en: 'Yes — we can add group lessons to your stay 😊 One group lesson is €35, or €30 each if you book more than one. I am not adding services to your booking yet.',
    it: 'Sì — possiamo aggiungere lezioni di gruppo 😊 Una lezione di gruppo €35, o €30 ciascuna se ne prenoti più di una. Non sto ancora aggiungendo servizi alla prenotazione.',
    es: 'Sí — podemos añadir clases de grupo 😊 Una clase de grupo €35, o €30 cada una si reservas más de una. Aún no añado servicios a tu reserva.',
    de: 'Ja — wir können Gruppenkurse hinzufügen 😊 Ein Gruppenkurs €35, oder €30 pro Stück bei mehr als einem. Ich buche noch keine Services in deine Buchung ein.',
    fr: 'Oui — on peut ajouter des cours en groupe 😊 Un cours en groupe €35, ou €30 chacun si vous en réservez plusieurs. Je n’ajoute pas encore de services à la réservation.',
  };
  return map[L] || map.en;
}

/**
 * Bare "lesson" (no private/group qualifier) — ask which one, add nothing yet.
 * One clear question per WhatsApp message (spec §1.4).
 */
function buildLessonClarifyReply(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: 'Love that you want to get in the water 🌊 Would you like a private lesson (just you/your group with an instructor) or a group lesson? I am not adding anything to your booking yet.',
    it: 'Che bello che tu voglia entrare in acqua 🌊 Preferisci una lezione privata (solo tu/il tuo gruppo con un istruttore) o una lezione di gruppo? Non aggiungo ancora nulla alla prenotazione.',
    es: 'Me encanta que quieras meterte al agua 🌊 ¿Prefieres una clase privada (solo tú/tu grupo con un instructor) o una clase de grupo? Aún no añado nada a tu reserva.',
    de: 'Schön, dass du ins Wasser willst 🌊 Möchtest du lieber einen Privatkurs (nur du/deine Gruppe mit einem Lehrer) oder einen Gruppenkurs? Ich buche noch nichts in deine Buchung ein.',
    fr: 'Super que tu veuilles aller à l’eau 🌊 Tu préfères un cours privé (juste toi/ton groupe avec un moniteur) ou un cours en groupe ? Je n’ajoute rien à la réservation pour l’instant.',
  };
  return map[L] || map.en;
}

/**
 * Private lesson request → System B catalog "Private Lesson" card path. The live pipeline
 * resolves the card's name/price/slots from the DB (handleBotCatalogServiceLookup). This copy
 * never quotes the €35 group add-on; it hands off to the catalog card.
 */
function buildPrivateLessonReply(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: 'Yes — we offer private lessons, just you (or your group) with your own instructor. Let me pull up the private lesson details for you. I am not adding anything to your booking yet.',
    it: 'Sì — offriamo lezioni private, solo tu (o il tuo gruppo) con il tuo istruttore. Ti recupero i dettagli della lezione privata. Non aggiungo ancora nulla alla prenotazione.',
    es: 'Sí — ofrecemos clases privadas, solo tú (o tu grupo) con tu propio instructor. Te busco los detalles de la clase privada. Aún no añado nada a tu reserva.',
    de: 'Ja — wir bieten Privatkurse an, nur du (oder deine Gruppe) mit deinem eigenen Lehrer. Ich hole dir die Details zum Privatkurs. Ich buche noch nichts in deine Buchung ein.',
    fr: 'Oui — on propose des cours privés, juste toi (ou ton groupe) avec ton propre moniteur. Je te récupère les détails du cours privé. Je n’ajoute rien à la réservation pour l’instant.',
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
    en: 'We can add extras like group lessons (€35 one / €30 each for more), wetsuit €5/day, boards from €15–20/day, and yoga €15/class on site. I am not adding anything to your booking yet.',
    it: 'Possiamo aggiungere extra come lezioni di gruppo (€35 una / €30 cad.), muta €5/giorno, tavole da €15–20/giorno e yoga €15/lezione in loco. Non aggiungo ancora nulla alla prenotazione.',
    es: 'Podemos añadir extras como clases de grupo (€35 una / €30 c/u), neopreno €5/día, tablas €15–20/día y yoga €15/clase en el sitio. Aún no añado nada a tu reserva.',
    de: 'Extras wie Gruppenkurse (€35 einzeln / €30 pro Stück), Neopren €5/Tag, Boards €15–20/Tag und Yoga €15/Klasse vor Ort sind möglich. Ich buche noch nichts in deine Buchung ein.',
    fr: 'On peut ajouter des extras : cours en groupe (35 € / 30 € chacun), combinaison 5 €/jour, planches 15–20 €/jour, yoga 15 €/cours sur place. Je n’ajoute rien à la réservation pour l’instant.',
  };
  return map[L] || map.en;
}

function buildServiceSideQuestionReply(lang, intent, messageText) {
  const kind = intent || detectServiceSideQuestionIntent(messageText) || 'services_general';
  switch (kind) {
    case 'surf_lessons': {
      const qualifier = detectLessonQualifier(messageText);
      if (qualifier === 'private') return buildPrivateLessonReply(lang);
      if (qualifier === 'group') return buildSurfLessonsReply(lang);
      // Bare "lesson" with no qualifier → ask private-or-group, add nothing.
      return buildLessonClarifyReply(lang);
    }
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
  const asksAboutBus = /\b(?:bus|autob[uú]s|autobus)\b/i.test(t);

  if (mentionsBilbao && asksAboutBus) {
    const map = {
      en: 'Many guests take the bus from Bilbao airport — it\'s a straightforward option. We can also arrange Santander airport transfer for €25 without a package, or it\'s included with Malibu, Uluwatu, or Waimea.',
      it: 'Molti ospiti usano il bus da Bilbao — è un\'opzione semplice. Possiamo anche organizzare il transfer Santander a €25 senza pacchetto, o incluso con Malibu, Uluwatu o Waimea.',
      es: 'Muchos huéspedes usan el autobús desde Bilbao — es una opción sencilla. También podemos organizar transfer Santander por €25 sin paquete, o incluido con Malibu, Uluwatu o Waimea.',
      de: 'Viele Gäste nehmen den Bus ab Bilbao — eine einfache Option. Wir können auch Santander-Transfer für €25 ohne Paket organisieren, oder inklusive mit Malibu, Uluwatu oder Waimea.',
      fr: 'Beaucoup de clients prennent le bus depuis Bilbao — c’est une option simple. On peut aussi organiser le transfert Santander à 25 € sans forfait, ou inclus avec Malibu, Uluwatu ou Waimea.',
    };
    return map[L] || map.en;
  }

  if (mentionsBilbao) {
    const bilbaoRule = {
      en: 'We only arrange Bilbao airport transfers for groups of 4 or more, at €15 per person.',
      it: 'Organizziamo transfer da Bilbao solo per gruppi da 4 o più, a €15 a persona.',
      es: 'Solo organizamos transfers desde Bilbao para grupos de 4 o más, a €15 por persona.',
      de: 'Bilbao-Transfers organisieren wir nur für Gruppen ab 4 Personen, €15 pro Person.',
      fr: 'Nous organisons les transferts Bilbao seulement pour les groupes de 4 ou plus, à 15 € par personne.',
    };
    const bilbaoRuleText = bilbaoRule[L] || bilbaoRule.en;
    if (!hasPackage) {
      const map = {
        en: `${bilbaoRuleText} Without a package, we can arrange Santander airport transfer for €25, or it\'s included with Malibu, Uluwatu, or Waimea.`,
        it: `${bilbaoRuleText} Senza pacchetto, il transfer Santander costa €25, o è incluso con Malibu, Uluwatu o Waimea.`,
        es: `${bilbaoRuleText} Sin paquete, el transfer Santander cuesta €25, o está incluido con Malibu, Uluwatu o Waimea.`,
        de: `${bilbaoRuleText} Ohne Paket organisieren wir Santander-Transfer für €25, oder inklusive mit Malibu, Uluwatu oder Waimea.`,
        fr: `${bilbaoRuleText} Sans forfait, le transfert Santander est à 25 €, ou inclus avec Malibu, Uluwatu ou Waimea.`,
      };
      return map[L] || map.en;
    }
    if (guests > 0 && guests < 4) {
      const map = {
        en: `${bilbaoRuleText} Santander airport transfer is included with your package booking.`,
        it: `${bilbaoRuleText} Il transfer Santander è incluso con il tuo pacchetto.`,
        es: `${bilbaoRuleText} El transfer de Santander está incluido con tu paquete.`,
        de: `${bilbaoRuleText} Santander-Transfer ist bei deiner Paketbuchung inklusive.`,
        fr: `${bilbaoRuleText} Le transfert Santander est inclus avec votre forfait.`,
      };
      return map[L] || map.en;
    }
    const map = {
      en: `${bilbaoRuleText} Santander airport transfer is included with your package booking.`,
      it: `${bilbaoRuleText} Il transfer Santander è incluso con il tuo pacchetto.`,
      es: `${bilbaoRuleText} El transfer de Santander está incluido con tu paquete.`,
      de: `${bilbaoRuleText} Santander-Transfer ist bei deiner Paketbuchung inklusive.`,
      fr: `${bilbaoRuleText} Le transfert Santander est inclus avec votre forfait.`,
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
    en: 'Santander airport transfer is €25 without a package, or included with Malibu, Uluwatu, or Waimea.',
    it: 'Transfer Santander €25 senza pacchetto, o incluso con Malibu, Uluwatu o Waimea.',
    es: 'Transfer Santander €25 sin paquete, o incluido con Malibu, Uluwatu o Waimea.',
    de: 'Santander-Transfer €25 ohne Paket, oder inklusive mit Malibu, Uluwatu oder Waimea.',
    fr: 'Transfert Santander 25 € sans forfait, ou inclus avec Malibu, Uluwatu ou Waimea.',
  };
  return map[L] || map.en;
}

module.exports = {
  detectServiceSideQuestionIntent,
  detectLessonQualifier,
  isLessonInquiry,
  detectTransferSideQuestionIntent,
  isPaymentMethodTransferQuestion,
  buildServiceSideQuestionReply,
  buildSurfLessonsReply,
  buildPrivateLessonReply,
  buildLessonClarifyReply,
  buildTransferSideQuestionReply,
  isPackageBooking,
};
