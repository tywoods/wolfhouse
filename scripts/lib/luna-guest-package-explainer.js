'use strict';

/**
 * Stage 27test-c — Guest-friendly Wolf-House package explainer (dry-run copy only).
 * Exact package facts; no availability, payment, or confirmation claims.
 */

const TRANSFER_CAVEAT = {
  en: 'Santander shuttle is included with weekly packages (Malibu, Uluwatu, Waimea).',
  it: 'Il transfer aeroporto Santander è incluso con i pacchetti settimanali (Malibu, Uluwatu, Waimea).',
  es: 'El traslado al aeropuerto de Santander está incluido con los paquetes semanales (Malibu, Uluwatu, Waimea).',
  de: 'Santander-Flughafen-Transfer ist bei Wochenpaketen inklusive (Malibu, Uluwatu, Waimea).',
  fr: 'Le transfert aéroport Santander est inclus avec les forfaits hebdomadaires (Malibu, Uluwatu, Waimea).',
};

const CHOICE_FOLLOWUP = {
  en: 'Are you thinking more stay only, gear included, or lessons included?',
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

  if (/\b(?:what are the packages|what packages|which package should|package options|package guide|quali sono i pacchetti|che pacchetti|qué paquetes|que paquetes|cuales son los paquetes|was sind die pakete|welche pakete|quels sont les forfaits|quels forfaits)\b/i.test(t)
    || /\bwas\s+gibt\s+es\b/i.test(t) && /\bpaket/i.test(t)) {
    return 'overview';
  }

  if (/\b(?:was|welche).{0,40}(?:paket|package|pacchetti|paquetes|forfaits).{0,40}(?:enthalten|inclus|incluye|included|drin|beinhaltet)\b/i.test(t)
    || /\b(?:was ist|was sind).{0,30}(?:in den paketen|in den packages|im paket)\b/i.test(t)) {
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

function formatStayContextPhrase(fields) {
  const f = fields || {};
  const checkIn = f.check_in;
  const checkOut = f.check_out;
  const count = f.guest_count;
  if (!checkIn || !checkOut) return '';
  const inParts = String(checkIn).split('-');
  const outParts = String(checkOut).split('-');
  if (inParts.length !== 3 || outParts.length !== 3) return '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const mIn = months[Number(inParts[1]) - 1];
  const mOut = months[Number(outParts[1]) - 1];
  const dIn = Number(inParts[2]);
  const dOut = Number(outParts[2]);
  const range = mIn === mOut
    ? `${mIn} ${dIn} to ${dOut}`
    : `${mIn} ${dIn} to ${mOut} ${dOut}`;
  if (count != null && count >= 1) {
    const guestLabel = count === 1 ? '1 guest' : `${count} guests`;
    return `${range} for ${guestLabel}`;
  }
  return range;
}

function buildWhatsAppPackageLines(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return [
      '🏡 Malibu — soggiorno base con T-shirt Wolf-House e transfer aeroporto inclusi, da €249.',
      '🏄 Uluwatu — soggiorno + noleggio tavola e muta, da €349.',
      '🌊 Waimea — soggiorno + lezioni + attrezzatura, da €499.',
    ];
  }
  if (L === 'es') {
    return [
      '🏡 Malibu — estancia simple con camiseta Wolf-House y traslado al aeropuerto incluidos, desde €249.',
      '🏄 Uluwatu — estancia + alquiler de tabla y neopreno, desde €349.',
      '🌊 Waimea — estancia + clases + material, desde €499.',
    ];
  }
  if (L === 'de') {
    return [
      '🏡 Malibu — einfacher Aufenthalt mit Wolf-House T-Shirt und Flughafen-Shuttle inklusive, ab €249.',
      '🏄 Uluwatu — Aufenthalt + Brett- und Neopren-Verleih, ab €349.',
      '🌊 Waimea — Aufenthalt + Kurse + Equipment, ab €499.',
    ];
  }
  if (L === 'fr') {
    return [
      '🏡 Malibu — séjour simple avec T-shirt Wolf-House et navette aéroport inclus, à partir de 249 €.',
      '🏄 Uluwatu — séjour + location planche et combinaison, à partir de 349 €.',
      '🌊 Waimea — séjour + cours + matériel, à partir de 499 €.',
    ];
  }
  return [
    '☀️ Malibu — 7 nights + Wolf-House T-shirt + free Santander airport shuttle.',
    '🌊 Uluwatu — everything in Malibu + surfboard and wetsuit rental for 6 days.',
    '🏄 Waimea — everything in Uluwatu + 6 surf lessons.',
  ];
}

/** After airport is known — casually ask for arrival/departure times (non-blocking). */
function buildTransferTimesQuestion(lang, fields) {
  const L = normalizeLang(lang);
  const ctx = formatStayContextPhrase(fields);
  const maps = {
    en: ctx
      ? `Perfect — ${ctx} is noted with airport transfer 🙂 Please send over your arrival and departure times when you have them and we'll log them in our system. If you're ready to pay now, just say deposit and we'll use sensible default pickup times until then.`
      : 'Please send over your arrival and departure times when you have them and we\'ll log them in our system. If you\'re ready to pay now, just say deposit and we\'ll use sensible default pickup times until then.',
    de: ctx
      ? `Perfekt — ${ctx} ist mit Transfer notiert 🙂 Schick uns eure Ankunfts- und Abflugzeiten, sobald ihr sie habt. Wenn ihr jetzt zahlen wollt, sagt einfach Anzahlung — bis dahin nutzen wir sinnvolle Standardzeiten.`
      : 'Schick uns eure Ankunfts- und Abflugzeiten, sobald ihr sie habt. Für die Zahlung jetzt einfach Anzahlung sagen.',
    es: ctx
      ? `Perfecto — ${ctx} queda con transfer 🙂 Envíanos las horas de llegada y salida cuando las tengas y las registramos. Si quieres pagar ahora, di depósito y usamos horarios por defecto hasta entonces.`
      : 'Envíanos las horas de llegada y salida cuando las tengas. Para pagar ahora, di depósito.',
    it: ctx
      ? `Perfetto — ${ctx} con transfer annotato 🙂 Mandaci orari di arrivo e partenza quando li hai e li registriamo. Se vuoi pagare ora, di\' deposito e usiamo orari predefiniti fino ad allora.`
      : 'Mandaci orari di arrivo e partenza quando li hai. Per pagare ora, di\' deposito.',
    fr: ctx
      ? `Parfait — ${ctx} avec transfert noté 🙂 Envoyez vos heures d\'arrivée et de départ quand vous les avez et on les enregistre. Pour payer maintenant, dites acompte — horaires par défaut en attendant.`
      : 'Envoyez vos heures d\'arrivée et de départ quand vous les avez. Pour payer, dites acompte.',
  };
  return maps[L] || maps.en;
}

/** Ask whether the guest needs airport transfer after a package is chosen. */
function buildTransferIntakeQuestion(lang, fields) {
  const L = normalizeLang(lang);
  const ctx = formatStayContextPhrase(fields);
  const maps = {
    en: ctx
      ? `For ${ctx}, your package includes Santander airport transfer — do you need a pickup from Santander? If yes, send your flight details (arrival time). If not, just say no transfer.`
      : 'your package includes Santander airport transfer — do you need a pickup from Santander? If yes, send your flight details. If not, just say no transfer.',
    it: ctx
      ? `Per ${ctx}, il pacchetto include il transfer da Santander — ti serve il pickup da Santander? Se sì, mandami orario di arrivo. Altrimenti scrivi "no transfer".`
      : 'il pacchetto include il transfer da Santander — ti serve il pickup da Santander?',
    es: ctx
      ? `Para ${ctx}, el paquete incluye traslado desde Santander — ¿necesitas pickup desde Santander? Si sí, envía hora de llegada. Si no, di "no transfer".`
      : 'el paquete incluye traslado desde Santander — ¿necesitas pickup desde Santander?',
    de: ctx
      ? `Für ${ctx}: Santander-Transfer ist im Paket inklusive — braucht ihr einen Pickup ab Santander? Wenn ja, schickt die Ankunftszeit. Sonst einfach "no transfer".`
      : 'Santander-Transfer ist im Paket inklusive — braucht ihr einen Pickup ab Santander?',
    fr: ctx
      ? `Pour ${ctx}, le forfait inclut le transfert depuis Santander — avez-vous besoin d'un pickup depuis Santander ? Si oui, envoyez l'heure d'arrivée. Sinon dites "no transfer".`
      : 'Le forfait inclut le transfert depuis Santander — besoin d\'un pickup depuis Santander ?',
  };
  return maps[L] || maps.en;
}

function buildPackageChoiceQuestionTail(lang, fields, opts) {
  const L = normalizeLang(lang);
  const o = opts || {};
  const ctx = formatStayContextPhrase(fields);
  if (o.beginnerSignal) {
    if (L === 'en') {
      return ctx
        ? `For ${ctx}, Waimea is probably the easiest if you want lessons. Want me to check Waimea?`
        : 'Waimea is probably the easiest if you want lessons. Want me to check Waimea?';
    }
    return ctx
      ? `${ctx} — Waimea di solito è la scelta più semplice per i principianti. Vuoi che controlli Waimea?`
      : 'Waimea di solito è la scelta più semplice per i principianti.';
  }
  if (L === 'en') {
    return ctx
      ? `For ${ctx}, are you thinking more stay only, gear included, or lessons included?`
      : 'Are you thinking more stay only, gear included, or lessons included?';
  }
  if (L === 'it') {
    return ctx
      ? `Per ${ctx}, preferisci solo soggiorno, con attrezzatura, o con lezioni incluse?`
      : 'Preferisci solo soggiorno, con attrezzatura, o con lezioni incluse?';
  }
  if (L === 'es') {
    return ctx
      ? `Para ${ctx}, ¿prefieres solo estancia, con material, o con clases incluidas?`
      : '¿Prefieres solo estancia, con material, o con clases incluidas?';
  }
  if (L === 'de') {
    return ctx
      ? `Für ${ctx}: nur Aufenthalt, mit Equipment, oder mit Kursen?`
      : 'Nur Aufenthalt, mit Equipment, oder mit Kursen?';
  }
  return ctx
    ? `Pour ${ctx}, plutôt séjour seul, avec matériel, ou avec cours ?`
    : 'Plutôt séjour seul, avec matériel, ou avec cours ?';
}

/**
 * Front-desk package choice prompt after dates + guest count are known.
 * Explains all packages before asking — guests do not know the names.
 */
function buildPackageChoiceIntakeReply(lang, fields, opts) {
  const L = normalizeLang(lang);
  const lines = buildWhatsAppPackageLines(L);
  const introMap = {
    en: 'Lovely 😊 We have a few options depending on how much surf you want:',
    it: 'Perfetto 😊 Abbiamo alcune opzioni a seconda di quanto surf vuoi fare:',
    es: 'Genial 😊 Tenemos varias opciones según cuánto surf quieras:',
    de: 'Super 😊 Wir haben ein paar Optionen — je nachdem, wie viel Surfen ihr wollt:',
    fr: 'Super 😊 On a quelques options selon le surf que vous voulez :',
  };
  const body = [introMap[L] || introMap.en, ...lines].join('\n\n');
  const tail = buildPackageChoiceQuestionTail(L, fields, opts);
  return `${body}\n\n${tail}`;
}

function buildOverviewReply(lang, opts) {
  const L = normalizeLang(lang);
  const o = opts || {};
  const lines = buildWhatsAppPackageLines(L);
  const beginnerNote = L === 'en'
    ? 'Waimea is best if you want lessons included. Uluwatu if you already surf and need gear. Malibu if you just want the stay.'
    : L === 'it'
      ? 'Waimea se vuoi lezioni incluse. Uluwatu se già surfi e ti serve il gear. Malibu se vuoi solo il soggiorno.'
      : L === 'es'
        ? 'Waimea si quieres clases incluidas. Uluwatu si ya surfeas y necesitas material. Malibu si solo quieres la estancia.'
        : L === 'de'
          ? 'Waimea mit Kursen. Uluwatu wenn ihr schon surft und Equipment braucht. Malibu nur für den Aufenthalt.'
          : 'Waimea avec cours. Uluwatu si vous surfez déjà. Malibu pour le séjour seul.';
  return [intro(L), ...lines, ...(o.bookingInProgress ? [] : [beginnerNote])].join('\n\n');
}

function buildMalibuReply(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return `${intro(L)}\n\nMalibu: da €249, 7 notti, cucina condivisa, T-shirt Wolf-House e transfer aeroporto secondo le regole Wolf-House.`;
  }
  if (L === 'es') {
    return `${intro(L)}\n\nMalibu: desde €249, 7 noches, cocina compartida, camiseta Wolf-House y traslado aeropuerto según las reglas Wolf-House.`;
  }
  if (L === 'de') {
    return `${intro(L)}\n\nMalibu: ab €249, 7 Nächte, Gemeinschaftsküche, Wolf-House T-Shirt und Flughafen-Shuttle gemäß Wolf-House-Transferregeln.`;
  }
  if (L === 'fr') {
    return `${intro(L)}\n\nMalibu : à partir de 249 €, 7 nuits, cuisine partagée, T-shirt Wolf-House et navette aéroport selon les règles Wolf-House.`;
  }
  return `${intro(L)}\n\nMalibu: 7 nights + Wolf-House T-shirt + free Santander airport shuttle. The classic Wolf-House week. From €249.`;
}

function buildUluwatuReply(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return `${intro(L)}\n\nUluwatu: da €349, 7 notti — tutto Malibu più 6 giorni completi di noleggio tavola e muta. ${TRANSFER_CAVEAT.it}`;
  }
  if (L === 'es') {
    return `${intro(L)}\n\nUluwatu: desde €349, 7 noches — todo Malibu más 6 días completos de alquiler de tabla y neopreno. ${TRANSFER_CAVEAT.es}`;
  }
  if (L === 'de') {
    return `${intro(L)}\n\nUluwatu: ab €349, 7 Nächte — alles aus Malibu plus 6 volle Tage Surfbrett- und Neopren-Verleih. ${TRANSFER_CAVEAT.de}`;
  }
  if (L === 'fr') {
    return `${intro(L)}\n\nUluwatu : à partir de 349 €, 7 nuits — tout Malibu plus 6 jours complets de location planche et combinaison. ${TRANSFER_CAVEAT.fr}`;
  }
  return `${intro(L)}\n\nUluwatu: 7 nights — everything in Malibu plus surfboard and wetsuit rental for 6 days. Best if you already surf or want gear included. From €349.`;
}

function buildWaimeaReply(lang) {
  const L = normalizeLang(lang);
  if (L === 'it') {
    return `${intro(L)}\n\nWaimea: da €499, 7 notti — tutto Malibu più 6 lezioni scuola surf al mattino (circa 12 ore a settimana) e noleggio tavola + muta tutta la settimana.`;
  }
  if (L === 'es') {
    return `${intro(L)}\n\nWaimea: desde €499, 7 noches — todo Malibu más 6 clases de surf por la mañana (unas 12 horas semanales) y alquiler tabla + neopreno toda la semana.`;
  }
  if (L === 'de') {
    return `${intro(L)}\n\nWaimea: ab €499, 7 Nächte — alles aus Malibu plus 6 morgendliche Surfschulkurse (ca. 12 Stunden pro Woche) und Brett + Neopren die ganze Woche.`;
  }
  if (L === 'fr') {
    return `${intro(L)}\n\nWaimea : à partir de 499 €, 7 nuits — tout Malibu plus 6 cours d’école de surf le matin (environ 12 h par semaine) et location planche + combinaison toute la semaine.`;
  }
  return `${intro(L)}\n\nWaimea: 7 nights — everything in Uluwatu plus 6 surf lessons. The full surf school experience. Best for beginners or anyone wanting guided surfing. From €499.`;
}

function buildChoiceBeginnerReply(lang, opts) {
  const L = normalizeLang(lang);
  const lines = buildWhatsAppPackageLines(L);
  const body = [intro(L), ...lines].join('\n\n');
  const fields = (opts && opts.fields) || {};
  const tail = buildPackageChoiceQuestionTail(L, fields, { beginnerSignal: true });
  return `${body}\n\n${tail}`;
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
  buildPackageChoiceIntakeReply,
  buildTransferIntakeQuestion,
  buildTransferTimesQuestion,
  buildWhatsAppPackageLines,
  formatStayContextPhrase,
  isBookingExplainerContext,
  TRANSFER_CAVEAT,
  CHOICE_FOLLOWUP,
};
