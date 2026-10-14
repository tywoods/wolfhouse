'use strict';

/**
 * Guest transfer refusals.
 *
 * Staff-typed "shown to guests" boxes are ignored. Copy is built only from
 * Package required, Included with a package, min/max group size, charged-per,
 * and amount. Saved unavailable_* text is never read.
 */

function trim(v) {
  return v == null ? '' : String(v).trim();
}

function langOf(lang) {
  const code = trim(lang).toLowerCase().slice(0, 2);
  return ['en', 'it', 'es', 'de', 'fr'].includes(code) ? code : 'en';
}

function wholeOrCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  const euros = n / 100;
  return Number.isInteger(euros) ? String(euros) : euros.toFixed(2);
}

function money(cents, currency) {
  const amount = wholeOrCents(cents);
  if (amount == null) return null;
  const cur = trim(currency) || 'EUR';
  return cur === 'EUR' ? `€${amount}` : `${cur} ${amount}`;
}

function integerOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function ruleFacts(rule, airportLabel) {
  const src = rule && typeof rule === 'object' ? rule : {};
  const price = src.price && typeof src.price === 'object' ? src.price : {};
  let unit = price.unit || null;
  let cents = price.amount_cents;
  if (cents == null && src.per_person_extra_cents != null) {
    unit = 'per_person';
    cents = src.per_person_extra_cents;
  } else if (cents == null && src.flat_price_cents != null) {
    unit = 'flat';
    cents = src.flat_price_cents;
  }
  if (unit !== 'per_person' && unit !== 'flat') unit = null;
  return {
    label: trim(airportLabel) || trim(src.label) || trim(src.airport_code) || 'Airport',
    requiresPackage: src.requires_package === true,
    included: src.included_when_package === true,
    min: integerOrNull(src.min_guest_count),
    max: integerOrNull(src.max_guest_count),
    unit,
    amount: money(cents, price.currency || src.currency),
  };
}

function chargePhrase(facts, lang) {
  if (!facts.amount || !facts.unit) return '';
  const perPerson = facts.unit === 'per_person';
  const map = {
    en: perPerson ? `${facts.amount} per person` : `${facts.amount} for the group`,
    it: perPerson ? `${facts.amount} a persona` : `${facts.amount} per il gruppo`,
    es: perPerson ? `${facts.amount} por persona` : `${facts.amount} por el grupo`,
    de: perPerson ? `${facts.amount} pro Person` : `${facts.amount} für die Gruppe`,
    fr: perPerson ? `${facts.amount} par personne` : `${facts.amount} pour le groupe`,
  };
  return map[lang];
}

function sizePhrase(facts, lang) {
  if (facts.min != null && facts.max != null) {
    return {
      en: `groups of ${facts.min} to ${facts.max}`,
      it: `gruppi da ${facts.min} a ${facts.max}`,
      es: `grupos de ${facts.min} a ${facts.max}`,
      de: `Gruppen von ${facts.min} bis ${facts.max}`,
      fr: `groupes de ${facts.min} à ${facts.max}`,
    }[lang];
  }
  if (facts.min != null) {
    return {
      en: `groups of ${facts.min} or more`,
      it: `gruppi da ${facts.min} o più`,
      es: `grupos de ${facts.min} o más`,
      de: `Gruppen ab ${facts.min}`,
      fr: `groupes de ${facts.min} ou plus`,
    }[lang];
  }
  if (facts.max != null) {
    return {
      en: `groups of up to ${facts.max}`,
      it: `gruppi fino a ${facts.max}`,
      es: `grupos de hasta ${facts.max}`,
      de: `Gruppen bis ${facts.max}`,
      fr: `groupes jusqu'à ${facts.max}`,
    }[lang];
  }
  return '';
}

function joinSentences(parts) {
  return parts.filter(Boolean).join(' ');
}

function composeTransferGuestFacts(rule, lang, airportLabel) {
  const facts = ruleFacts(rule, airportLabel);
  const L = langOf(lang);
  const charge = chargePhrase(facts, L);
  const size = sizePhrase(facts, L);
  const detail = [charge, size ? {
    en: `for ${size}`,
    it: `per ${size}`,
    es: `para ${size}`,
    de: `für ${size}`,
    fr: `pour les ${size}`,
  }[L] : ''].filter(Boolean).join(', ');

  if (facts.included && facts.requiresPackage) {
    const bounds = size ? {
      en: `, for ${size}`,
      it: `, per ${size}`,
      es: `, para ${size}`,
      de: `, für ${size}`,
      fr: `, pour les ${size}`,
    }[L] : '';
    return {
      en: `${facts.label} airport transfer is included with a package${bounds}.`,
      it: `Il transfer dall'aeroporto di ${facts.label} è incluso con un pacchetto${bounds}.`,
      es: `El transfer del aeropuerto de ${facts.label} está incluido con un paquete${bounds}.`,
      de: `Der Flughafentransfer ${facts.label} ist mit einem Paket inklusive${bounds}.`,
      fr: `Le transfert aéroport ${facts.label} est inclus avec un forfait${bounds}.`,
    }[L];
  }
  if (facts.included) {
    const without = charge ? {
      en: ` Without a package it is ${charge}${size ? `, for ${size}` : ''}.`,
      it: ` Senza pacchetto costa ${charge}${size ? `, per ${size}` : ''}.`,
      es: ` Sin paquete cuesta ${charge}${size ? `, para ${size}` : ''}.`,
      de: ` Ohne Paket kostet er ${charge}${size ? `, für ${size}` : ''}.`,
      fr: ` Sans forfait, c'est ${charge}${size ? `, pour les ${size}` : ''}.`,
    }[L] : '';
    return {
      en: `${facts.label} airport transfer is included with a package.${without}`,
      it: `Il transfer dall'aeroporto di ${facts.label} è incluso con un pacchetto.${without}`,
      es: `El transfer del aeropuerto de ${facts.label} está incluido con un paquete.${without}`,
      de: `Der Flughafentransfer ${facts.label} ist mit einem Paket inklusive.${without}`,
      fr: `Le transfert aéroport ${facts.label} est inclus avec un forfait.${without}`,
    }[L];
  }
  if (facts.requiresPackage) {
    return {
      en: `${facts.label} airport transfer is ${detail || 'available'} and needs a package.`,
      it: `Il transfer dall'aeroporto di ${facts.label} è ${detail || 'disponibile'} e serve un pacchetto.`,
      es: `El transfer del aeropuerto de ${facts.label} es ${detail || 'disponible'} y necesita un paquete.`,
      de: `Der Flughafentransfer ${facts.label} ist ${detail || 'verfügbar'} und braucht ein Paket.`,
      fr: `Le transfert aéroport ${facts.label} est ${detail || 'disponible'} et demande un forfait.`,
    }[L];
  }
  if (!detail) {
    return {
      en: `${facts.label} airport transfer is available.`,
      it: `Il transfer dall'aeroporto di ${facts.label} è disponibile.`,
      es: `El transfer del aeropuerto de ${facts.label} está disponible.`,
      de: `Der Flughafentransfer ${facts.label} ist verfügbar.`,
      fr: `Le transfert aéroport ${facts.label} est disponible.`,
    }[L];
  }
  return {
    en: `${facts.label} airport transfer is ${detail}.`,
    it: `Il transfer dall'aeroporto di ${facts.label} è ${detail}.`,
    es: `El transfer del aeropuerto de ${facts.label} es ${detail}.`,
    de: `Der Flughafentransfer ${facts.label} ist ${detail}.`,
    fr: `Le transfert aéroport ${facts.label} est ${detail}.`,
  }[L];
}

function composeTransferGuestRefusal(rule, reason, lang, airportLabel) {
  const facts = ruleFacts(rule, airportLabel);
  const L = langOf(lang);
  const charge = chargePhrase(facts, L);
  const size = sizePhrase(facts, L);

  if (reason === 'no_package') {
    const lead = {
      en: `${facts.label} airport transfer is only available with a package.`,
      it: `Il transfer dall'aeroporto di ${facts.label} è disponibile solo con un pacchetto.`,
      es: `El transfer del aeropuerto de ${facts.label} solo está disponible con un paquete.`,
      de: `Der Flughafentransfer ${facts.label} ist nur mit einem Paket möglich.`,
      fr: `Le transfert aéroport ${facts.label} n'est disponible qu'avec un forfait.`,
    }[L];
    const price = facts.included ? {
      en: 'It is included with a package.',
      it: 'È incluso con un pacchetto.',
      es: 'Está incluido con un paquete.',
      de: 'Mit einem Paket ist er inklusive.',
      fr: 'Il est inclus avec un forfait.',
    }[L] : (charge ? {
      en: `With a package it is ${charge}.`,
      it: `Con un pacchetto costa ${charge}.`,
      es: `Con un paquete cuesta ${charge}.`,
      de: `Mit einem Paket kostet er ${charge}.`,
      fr: `Avec un forfait, c'est ${charge}.`,
    }[L] : '');
    const bounds = size ? {
      en: `It is for ${size}.`,
      it: `È per ${size}.`,
      es: `Es para ${size}.`,
      de: `Er ist für ${size}.`,
      fr: `C'est pour les ${size}.`,
    }[L] : '';
    return joinSentences([lead, price, bounds]);
  }

  if (reason === 'below_min') {
    const n = facts.min == null ? '' : String(facts.min);
    const lead = {
      en: `${facts.label} airport transfer needs at least ${n} guests.`,
      it: `Il transfer dall'aeroporto di ${facts.label} è per almeno ${n} ospiti.`,
      es: `El transfer del aeropuerto de ${facts.label} necesita al menos ${n} huéspedes.`,
      de: `Der Flughafentransfer ${facts.label} braucht mindestens ${n} Gäste.`,
      fr: `Le transfert aéroport ${facts.label} est pour au moins ${n} personnes.`,
    }[L];
    const bounds = facts.max != null ? {
      en: `It is for groups of ${facts.min} to ${facts.max}.`,
      it: `È per gruppi da ${facts.min} a ${facts.max}.`,
      es: `Es para grupos de ${facts.min} a ${facts.max}.`,
      de: `Er ist für Gruppen von ${facts.min} bis ${facts.max}.`,
      fr: `C'est pour les groupes de ${facts.min} à ${facts.max}.`,
    }[L] : '';
    const price = facts.included ? {
      en: 'With a package it is included.',
      it: 'Con un pacchetto è incluso.',
      es: 'Con un paquete está incluido.',
      de: 'Mit einem Paket ist er inklusive.',
      fr: 'Avec un forfait, il est inclus.',
    }[L] : (charge ? {
      en: `It is ${charge}.`,
      it: `Costa ${charge}.`,
      es: `Cuesta ${charge}.`,
      de: `Er kostet ${charge}.`,
      fr: `C'est ${charge}.`,
    }[L] : '');
    const packageLine = facts.requiresPackage ? {
      en: 'It also needs a package.',
      it: 'Serve anche un pacchetto.',
      es: 'También hace falta un paquete.',
      de: 'Dazu braucht es ein Paket.',
      fr: 'Il faut aussi un forfait.',
    }[L] : '';
    return joinSentences([lead, bounds, price, packageLine]);
  }

  return composeTransferGuestFacts(rule, lang, airportLabel);
}

function composeTransferStaffMinGroupBlock(rule, airportLabel) {
  const facts = ruleFacts(rule, airportLabel);
  const n = facts.min == null ? '' : String(facts.min);
  return `${facts.label} transfer needs at least ${n} guests. Use Exception Override to save a manual exception.`;
}

module.exports = {
  composeTransferGuestFacts,
  composeTransferGuestRefusal,
  composeTransferStaffMinGroupBlock,
};
