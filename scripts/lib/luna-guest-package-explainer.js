'use strict';

/**
 * Stage 27test-c — Guest-friendly Wolfhouse package explainer (dry-run copy only).
 * Exact package facts; no availability, payment, or confirmation claims.
 */

const TRANSFER_CAVEAT = {
  en: 'Airport shuttle is included under Wolfhouse transfer rules (Santander for package bookings; Bilbao only for package groups of 4+).',
  it: 'Il transfer aeroporto è incluso secondo le regole Wolfhouse (Santander per i pacchetti; Bilbao solo per gruppi pacchetto da 4+).',
  es: 'El traslado al aeropuerto está incluido según las reglas Wolfhouse (Santander en reservas con paquete; Bilbao solo para grupos de paquete de 4+).',
  de: 'Der Flughafen-Shuttle ist inklusive gemäß Wolfhouse-Transferregeln (Santander bei Paketbuchungen; Bilbao nur für Paketgruppen ab 4).',
  fr: 'La navette aéroport est incluse selon les règles Wolfhouse (Santander pour les forfaits ; Bilbao seulement pour les groupes forfait de 4+).',
};

const CHOICE_FOLLOWUP = {
  en: 'Which one sounds closest: Malibu, Uluwatu, Waimea, or accommodation only?',
  it: 'Quale ti sembra più adatto: Malibu, Uluwatu, Waimea o solo pernottamento?',
  es: '¿Cuál te encaja más: Malibu, Uluwatu, Waimea o solo alojamiento?',
  de: 'Was passt am ehesten: Malibu, Uluwatu, Waimea oder nur Unterkunft?',
  fr: 'Lequel vous semble le plus adapté : Malibu, Uluwatu, Waimea ou hébergement seul ?',
};

function normalizeLang(lang) {
  const l = String(lang || 'en').trim().toLowerCase().slice(0, 2);
  return ['en', 'it', 'es', 'de', 'fr'].includes(l) ? l : 'en';
}

function detectPackageExplainerIntent(text) {
  const t = String(text || '');
  const tl = t.toLowerCase();

  if (/\bexplain(?:\s+the)?\s+packages?\b/i.test(tl)) {
    return 'overview';
  }

  if (/\b(?:explain|tell me about|tell me more about|describe|more about|info on|information about|what about|talk me through|walk me through|run me through)\b[^.?!]*\bpackages?\b/i.test(t)) {
    return 'overview';
  }
  if (/\bpackages?\b[^.?!]*\b(?:explain|options|guide|overview|details|info)\b/i.test(t)) {
    return 'overview';
  }

  const hasPkgName = /\b(?:malibu|uluwatu|waimea)\b/i.test(t);
  const pkgNameCount = (tl.match(/\b(?:malibu|uluwatu|waimea)\b/g) || []).length;

  if (/\b(?:what should i bring|what to bring|what do i need to bring|cosa devo portare|cosa portare|qué debo llevar|qué llevar|que debo llevar|was soll ich mitbringen|was mitbringen|quoi apporter|que dois-je apporter)\b/i.test(t)) {
    return 'what_to_bring';
  }

  if (/\b(?:experienced|gear[\s-]?only|just (?:need |want )?gear|solo gear|solo equipment|nur equipment|nur ausr[uü]stung|solo el material|solo material)\b/i.test(t)
    || (/\b(?:i am|i'm|soy|sono|je suis|ich bin)\b/i.test(t) && /\b(?:experienced|experimentad[oa]|espert[oa]|exp[eé]riment[eé]|erfahren)\b/i.test(t))) {
    return 'choice_experienced';
  }

  if (/\b(?:already know how to surf|already surf|experienced surfer|so già surfare|so gia surfare|ya sé surfear|ya se surfear|je sais déjà surfer|je sais deja surfer|kann schon surfen|ich kann schon surfen)\b/i.test(t)
    && /\b(?:lesson|lessons|lezioni|clases|cours|unterricht|need|gear|equipment)\b/i.test(t)) {
    return 'choice_experienced';
  }

  if (/\b(?:beginner|beginners|principiante|principianti|débutant|debutant|anfänger|anfanger|never surfed|new to surf|nunca he surfeado|non ho mai surfato|für anfänger|fuer anfanger|pour débutant|pour debutant)\b/i.test(t)
    && /\b(?:package|pacchetto|paquete|paket|forfait|malibu|uluwatu|waimea|which|quale|cuál|cual|welche|quel|choose|scegliere|elegir|wählen|choisir)\b/i.test(t)) {
    return 'choice_beginner';
  }

  const hasCompareSignal = /\b(?:vs\.?|versus)\b/i.test(t)
    || /\b(?:difference between|differenza tra|diferencia entre|unterschied zwischen|diff[eé]rence entre)\b/i.test(t)
    || /\b(?:what(?:'s| is) the )?difference(?:s)?(?: between)?\b/i.test(t)
    || /\b(?:explain|compare)\b/i.test(t);
  if (hasCompareSignal && (hasPkgName || /\bpackages?\b/i.test(t))
    && (pkgNameCount >= 2 || /\b(?:vs\.?|versus|difference|explain|compare|packages?)\b/i.test(t))) {
    return 'compare';
  }

  if (/\b(?:what(?:'s| is) included|what is included|what's included|what(?:'s| is) in (?:the )?packages?)\b/i.test(t)
    && !hasPkgName) {
    return 'overview';
  }

  if (/\b(?:which package (?:do you )?recommend|what package (?:do you )?recommend|quale pacchetto consigli|qu[eé] paquete recomiendas|welches paket empfiehl|quel forfait (?:tu )?recommandes)\b/i.test(t)) {
    return 'recommend';
  }

  if (hasPkgName && /\b(?:what (?:does|is) (?:included|include)|what(?:'s| is) included(?: in)?|included in|qu[eé] incluye|cosa include|was ist in|was ist enthalten|qu['']est[- ]ce qui est inclus|quest-ce qui est inclus)\b/i.test(t)) {
    if (/\bwaimea\b/i.test(t)) return 'waimea';
    if (/\buluwatu\b/i.test(t)) return 'uluwatu';
    if (/\bmalibu\b/i.test(t)) return 'malibu';
  }

  if (hasPkgName && /\b(?:package details|pacchetto dettagli|detalles del paquete|paketdetails|d[eé]tails (?:du )?forfait)\b/i.test(t)) {
    if (/\bwaimea\b/i.test(t)) return 'waimea';
    if (/\buluwatu\b/i.test(t)) return 'uluwatu';
    return 'malibu';
  }

  if (/\bwaimea\b/i.test(t) && /\b(?:what is|what's|what’s|included|include|cos'è|cos e|qué es|que es|was ist|qu'est-ce|quest-ce)\b/i.test(t)) {
    return 'waimea';
  }
  if (/\buluwatu\b/i.test(t) && /\b(?:what is|what's|what’s|included|include|cos'è|cos e|qué es|que es|was ist|qu'est-ce|quest-ce)\b/i.test(t)) {
    return 'uluwatu';
  }
  if (/\bmalibu\b/i.test(t) && /\b(?:what is|what's|what’s|included|include|cos'è|cos e|qué es|que es|was ist|qu'est-ce|quest-ce)\b/i.test(t)) {
    return 'malibu';
  }

  if (/\b(?:what are the packages|what packages|which package should|package options|package guide|quali sono i pacchetti|che pacchetti|qué paquetes|que paquetes|cuales son los paquetes|was sind die pakete|welche pakete|quels sont les forfaits|quels forfaits)\b/i.test(t)) {
    return 'overview';
  }

  if (/\b(?:what is|what's|what’s)\s+(?:the\s+)?(?:malibu|uluwatu|waimea)\b/i.test(t)) {
    if (/\bwaimea\b/i.test(t)) return 'waimea';
    if (/\buluwatu\b/i.test(t)) return 'uluwatu';
    if (/\bmalibu\b/i.test(t)) return 'malibu';
  }

  if (/\b(?:cos'è|cos e|qué es|que es|was ist|qu'est-ce|quest-ce)\s+(?:il |el |das |le )?(?:pacchetto |paquete |paket |forfait )?(?:malibu|uluwatu|waimea)\b/i.test(t)) {
    if (/\bwaimea\b/i.test(t)) return 'waimea';
    if (/\buluwatu\b/i.test(t)) return 'uluwatu';
    if (/\bmalibu\b/i.test(t)) return 'malibu';
  }

  return null;
}

/**
 * Package-info intent from message text, with optional brain side-question fallback.
 */
function resolvePackageExplainerIntent(text, brainDecision) {
  const explicit = detectPackageExplainerIntent(text);
  if (explicit) return explicit;
  const brain = brainDecision || {};
  if (brain.side_question_answer_needed && brain.side_question_type) {
    return brain.side_question_type;
  }
  return null;
}

function intro(lang) {
  const L = normalizeLang(lang);
  const map = {
    en: "Sure 😊 Quick guide:",
    it: 'Certo 😊 Guida rapida:',
    es: 'Claro 😊 Guía rápida:',
    de: 'Klar 😊 Kurzer Überblick:',
    fr: 'Bien sûr 😊 Petit guide :',
  };
  return map[L] || map.en;
}

function buildOverviewReply(lang, opts) {
  const L = normalizeLang(lang);
  const parts = [intro(L)];

  if (L === 'en') {
    parts.push('Malibu is the simple stay package: from €249, 7 nights, shared kitchen, Wolfhouse T-shirt, and airport shuttle under our transfer rules.');
    parts.push('Uluwatu is for guests who want gear included: from €349, 7 nights — everything in Malibu, plus 6 full days of surfboard and wetsuit rental from local partners.');
    parts.push('Waimea is best if you want lessons: from €499, 7 nights — everything in Malibu, plus 6 morning surf school lessons (about 12 hours weekly) and surfboard + wetsuit rental all week from local partners.');
    parts.push('If you\'re a beginner, Waimea is usually the easiest choice because lessons are included. If you already surf and just need gear, Uluwatu usually makes more sense.');
  } else if (L === 'it') {
    parts.push('Malibu è il pacchetto soggiorno base: da €249, 7 notti, cucina condivisa, T-shirt Wolfhouse e transfer aeroporto secondo le nostre regole.');
    parts.push('Uluwatu include tutto Malibu più 6 giorni completi di noleggio tavola e muta da partner locali.');
    parts.push('Waimea è ideale con lezioni: tutto Malibu più 6 lezioni scuola surf al mattino (circa 12 ore a settimana) e noleggio tavola + muta tutta la settimana.');
    parts.push('Se sei principiante, Waimea di solito è la scelta più semplice. Se già surfi e ti serve solo il gear, Uluwatu ha più senso.');
  } else if (L === 'es') {
    parts.push('Malibu es el paquete de estancia simple: desde €249, 7 noches, cocina compartida, camiseta Wolfhouse y traslado aeropuerto según nuestras reglas.');
    parts.push('Uluwatu incluye todo Malibu más 6 días completos de alquiler de tabla y neopreno con socios locales.');
    parts.push('Waimea es ideal con clases: todo Malibu más 6 clases de surf por la mañana (unas 12 horas semanales) y alquiler tabla + neopreno toda la semana.');
    parts.push('Si eres principiante, Waimea suele ser la opción más fácil. Si ya surfeas y solo necesitas material, Uluwatu encaja mejor.');
  } else if (L === 'de') {
    parts.push('Malibu ist das einfache Aufenthaltspaket: ab €249, 7 Nächte, Gemeinschaftsküche, Wolfhouse T-Shirt und Flughafen-Shuttle gemäß unseren Transferregeln.');
    parts.push('Uluwatu enthält alles aus Malibu plus 6 volle Tage Surfbrett- und Neopren-Verleih von lokalen Partnern.');
    parts.push('Waimea ist ideal mit Kursen: alles aus Malibu plus 6 morgendliche Surfschulkurse (ca. 12 Stunden pro Woche) und Brett + Neopren die ganze Woche.');
    parts.push('Als Anfänger ist Waimea meist am einfachsten. Wenn du schon surfst und nur Equipment brauchst, passt Uluwatu oft besser.');
  } else {
    parts.push('Malibu est le forfait séjour simple : à partir de 249 €, 7 nuits, cuisine partagée, T-shirt Wolfhouse et navette aéroport selon nos règles.');
    parts.push('Uluwatu inclut tout Malibu plus 6 jours complets de location planche et combinaison via des partenaires locaux.');
    parts.push('Waimea est idéal avec cours : tout Malibu plus 6 cours d’école de surf le matin (environ 12 h par semaine) et location planche + combinaison toute la semaine.');
    parts.push('Débutant : Waimea est souvent le plus simple. Si vous surfez déjà et voulez surtout le matériel, Uluwatu convient mieux.');
  }

  if (opts && opts.bookingInProgress) {
    parts.push(CHOICE_FOLLOWUP[L] || CHOICE_FOLLOWUP.en);
  }
  return parts.join('\n\n');
}

function buildMalibuReply(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return `${intro(L)}\n\nMalibu: da €249, 7 notti, cucina condivisa, T-shirt Wolfhouse e transfer aeroporto secondo le regole Wolfhouse.`;
  }
  if (L === 'es') {
    return `${intro(L)}\n\nMalibu: desde €249, 7 noches, cocina compartida, camiseta Wolfhouse y traslado aeropuerto según las reglas Wolfhouse.`;
  }
  if (L === 'de') {
    return `${intro(L)}\n\nMalibu: ab €249, 7 Nächte, Gemeinschaftsküche, Wolfhouse T-Shirt und Flughafen-Shuttle gemäß Wolfhouse-Transferregeln.`;
  }
  if (L === 'fr') {
    return `${intro(L)}\n\nMalibu : à partir de 249 €, 7 nuits, cuisine partagée, T-shirt Wolfhouse et navette aéroport selon les règles Wolfhouse.`;
  }
  return `${intro(L)}\n\nMalibu is the simple stay package: from €249, 7 nights, shared kitchen, Wolfhouse T-shirt, and airport shuttle under Wolfhouse transfer rules.`;
}

function buildUluwatuReply(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return `${intro(L)}\n\nUluwatu: da €349, 7 notti — tutto Malibu più 6 giorni completi di noleggio tavola e muta da partner locali. ${TRANSFER_CAVEAT.it}`;
  }
  if (L === 'es') {
    return `${intro(L)}\n\nUluwatu: desde €349, 7 noches — todo Malibu más 6 días completos de alquiler de tabla y neopreno con socios locales. ${TRANSFER_CAVEAT.es}`;
  }
  if (L === 'de') {
    return `${intro(L)}\n\nUluwatu: ab €349, 7 Nächte — alles aus Malibu plus 6 volle Tage Surfbrett- und Neopren-Verleih von lokalen Partnern. ${TRANSFER_CAVEAT.de}`;
  }
  if (L === 'fr') {
    return `${intro(L)}\n\nUluwatu : à partir de 349 €, 7 nuits — tout Malibu plus 6 jours complets de location planche et combinaison via partenaires locaux. ${TRANSFER_CAVEAT.fr}`;
  }
  return `${intro(L)}\n\nUluwatu is for guests who want gear included: from €349, 7 nights — everything in Malibu, plus 6 full days of surfboard and wetsuit rental from local partners. ${TRANSFER_CAVEAT.en}`;
}

function buildWaimeaReply(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return `${intro(L)}\n\nWaimea: da €499, 7 notti — tutto Malibu più 6 lezioni scuola surf al mattino (circa 12 ore a settimana) e noleggio tavola + muta tutta la settimana da partner locali.`;
  }
  if (L === 'es') {
    return `${intro(L)}\n\nWaimea: desde €499, 7 noches — todo Malibu más 6 clases de surf por la mañana (unas 12 horas semanales) y alquiler tabla + neopreno toda la semana con socios locales.`;
  }
  if (L === 'de') {
    return `${intro(L)}\n\nWaimea: ab €499, 7 Nächte — alles aus Malibu plus 6 morgendliche Surfschulkurse (ca. 12 Stunden pro Woche) und Brett + Neopren die ganze Woche von lokalen Partnern.`;
  }
  if (L === 'fr') {
    return `${intro(L)}\n\nWaimea : à partir de 499 €, 7 nuits — tout Malibu plus 6 cours d’école de surf le matin (environ 12 h par semaine) et location planche + combinaison toute la semaine via partenaires locaux.`;
  }
  return `${intro(L)}\n\nWaimea is best if you want lessons: from €499, 7 nights — everything in Malibu, plus 6 morning surf school lessons (about 12 hours weekly) and surfboard + wetsuit rental all week from local partners.`;
}

function buildChoiceBeginnerReply(lang, opts) {
  const L = normalizeLang(lang);
  const base = buildOverviewReply(L, { bookingInProgress: false });
  const tail = L === 'it'
    ? 'Per un principiante, Waimea di solito è la scelta più semplice perché include le lezioni.'
    : L === 'es'
      ? 'Si eres principiante, Waimea suele ser la opción más fácil porque incluye clases.'
      : L === 'de'
        ? 'Als Anfänger ist Waimea meist am einfachsten, weil Kurse enthalten sind.'
        : L === 'fr'
          ? 'En débutant, Waimea est souvent le plus simple car les cours sont inclus.'
          : 'If you\'re a beginner, Waimea is usually the easiest choice because lessons are included.';
  const follow = (opts && opts.bookingInProgress) ? `\n\n${CHOICE_FOLLOWUP[L] || CHOICE_FOLLOWUP.en}` : '';
  return `${base}\n\n${tail}${follow}`;
}

function buildChoiceExperiencedReply(lang, opts) {
  const L = normalizeLang(lang);
  const tail = L === 'it'
    ? 'Se già sai surfare, di solito non servono le lezioni: Uluwatu include 6 giorni di noleggio tavola e muta, oppure Malibu se porti il tuo equipment.'
    : L === 'es'
      ? 'Si ya sabes surfear, normalmente no necesitas clases: Uluwatu incluye 6 días de alquiler de tabla y neopreno, o Malibu si traes tu equipo.'
      : L === 'de'
        ? 'Wenn du schon surfen kannst, brauchst du meist keine Kurse: Uluwatu enthält 6 Tage Brett- und Neopren-Verleih, oder Malibu wenn du dein eigenes Equipment mitbringst.'
        : L === 'fr'
          ? 'Si vous savez déjà surfer, les cours ne sont en général pas nécessaires : Uluwatu inclut 6 jours de location planche et combinaison, ou Malibu si vous apportez votre matériel.'
          : 'If you already know how to surf, you usually don\'t need lessons — Uluwatu includes 6 full days of board and wetsuit rental, or Malibu if you bring your own gear.';
  const follow = (opts && opts.bookingInProgress) ? `\n\n${CHOICE_FOLLOWUP[L] || CHOICE_FOLLOWUP.en}` : '';
  return `${intro(L)}\n\n${tail}${follow}`;
}

function buildWhatToBringReply(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return `${intro(L)}\n\nPorta: costume, asciugamano, crema solare, abiti comodi, infradito, un layer caldo per la sera. Muta/tavola propria opzionale — con Uluwatu o Waimea il noleggio è incluso.`;
  }
  if (L === 'es') {
    return `${intro(L)}\n\nLleva: bañador, toalla, protector solar, ropa cómoda, chanclas, capa abrigada para la noche. Traje/tabla propios opcionales — con Uluwatu o Waimea el alquiler está incluido.`;
  }
  if (L === 'de') {
    return `${intro(L)}\n\nMitbringen: Badekleidung, Handtuch, Sonnencreme, bequeme Kleidung, Flip-Flops, warme Schicht für den Abend. Eigenes Neopren/Brett optional — bei Uluwatu oder Waimea ist Verleih inklusive.`;
  }
  if (L === 'fr') {
    return `${intro(L)}\n\nApportez : maillot, serviette, crème solaire, vêtements confortables, tongs, couche chaude le soir. Combinaison/planche perso optionnelles — avec Uluwatu ou Waimea, la location est incluse.`;
  }
  return `${intro(L)}\n\nBring: swimwear, towel, sunscreen, comfortable clothes, beach flip-flops/sandals, and a warmer layer for evenings. Your own wetsuit/board is optional — Uluwatu and Waimea include rental.`;
}

function buildPackageExplainerReply(lang, intent, opts) {
  const options = opts || {};
  switch (intent) {
    case 'overview':
      return buildOverviewReply(lang, options);
    case 'malibu':
      return buildMalibuReply(lang);
    case 'uluwatu':
      return buildUluwatuReply(lang);
    case 'waimea':
      return buildWaimeaReply(lang);
    case 'choice_beginner':
      return buildChoiceBeginnerReply(lang, options);
    case 'choice_experienced':
      return buildChoiceExperiencedReply(lang, options);
    case 'what_to_bring':
      return buildWhatToBringReply(lang);
    case 'compare':
    case 'recommend':
      return buildOverviewReply(lang, options);
    default:
      return buildOverviewReply(lang, options);
  }
}

function isBookingExplainerContext(guestContext) {
  const ctx = guestContext || {};
  return ctx.message_lane === 'new_booking_inquiry'
    || ctx.booking_intake_ready === false
    || (ctx.result && ctx.result.message_lane === 'new_booking_inquiry');
}

module.exports = {
  detectPackageExplainerIntent,
  resolvePackageExplainerIntent,
  buildPackageExplainerReply,
  isBookingExplainerContext,
  TRANSFER_CAVEAT,
  CHOICE_FOLLOWUP,
};
