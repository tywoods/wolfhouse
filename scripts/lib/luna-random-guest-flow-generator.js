'use strict';

/**
 * Stage 40a — Deterministic randomized multilingual guest conversation generator.
 *
 * Produces conversation-style fixtures compatible with runConversationFixture().
 */

const SCENARIO_TYPES = Object.freeze([
  'short_stay_accommodation',
  'package_booking',
  'package_surf_addons',
  'short_stay_surf_addons',
  'lesson_addon',
  'yoga_request',
  'dinner_meals_request',
  'transfer_side_question',
  'cash_payment_side_question',
  'correction_flow',
  'reset_flow',
  'out_of_order_all_in_one',
]);

const BASE_LANGUAGES = Object.freeze(['it', 'en', 'es', 'de']);
const LANGUAGE_FILTERS = Object.freeze(['it', 'en', 'es', 'de', 'mixed', 'all']);
const STYLE_OPTIONS = Object.freeze(['plain', 'typo', 'emoji', 'typo_emoji']);
const PACKAGES = Object.freeze(['malibu', 'uluwatu', 'waimea']);
const REFERENCE_DATE = '2026-06-10';

const CONTACT_NAMES = {
  it: ['Giulia', 'Marco', 'Sara', 'Luca', 'Chiara'],
  en: ['Alex', 'Emma', 'James', 'Sophie'],
  es: ['Carlos', 'Maria', 'Ana', 'Pablo'],
  de: ['Anna', 'Thomas', 'Lena', 'Felix'],
  mixed: ['Giulia', 'Alex', 'Maria'],
};

/** Mulberry32 seeded PRNG */
function createSeededRng(seed) {
  let s = Number(seed) >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function pickInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildStay(rng, kind) {
  if (kind === 'short') {
    const starts = [1, 3, 8, 15];
    const start = pick(rng, starts);
    const nights = pickInt(rng, 3, 5);
    const end = start + nights;
    return {
      check_in: isoDate(2026, 7, start),
      check_out: isoDate(2026, 7, end),
      label_it: `${start}-${end} luglio`,
      label_en: `July ${start}-${end}`,
      label_es: `del ${start} al ${end} de julio`,
      label_de: `vom ${start}. bis ${end}. Juli`,
      label_mixed: `July ${start} to ${end}`,
    };
  }
  const start = pick(rng, [3, 10, 17]);
  const end = start + 7;
  return {
    check_in: isoDate(2026, 7, start),
    check_out: isoDate(2026, 7, end),
    label_it: `${start}-${end} luglio`,
    label_en: `July ${start}-${end}`,
    label_es: `del ${start} al ${end} de julio`,
    label_de: `vom ${start}. bis ${end}. Juli`,
    label_mixed: `July ${start}-${end}`,
  };
}

function applyTypos(text, rng) {
  let out = String(text);
  if (rng() < 0.35) out = out.replace(/\bsiamo\b/i, 'siamoo');
  if (rng() < 0.3) out = out.replace(/luglio/gi, 'luglo');
  if (rng() < 0.25) out = out.replace(/\bjuly\b/gi, 'julyy');
  if (rng() < 0.2) out = out.replace(/\bciao\b/i, 'ciaoo');
  return out;
}

function applyEmojis(text, rng) {
  const emojis = ['🌊', '🏄', '😍', '✨', '🙏'];
  if (rng() < 0.5) return `${pick(rng, emojis)} ${text}`;
  if (rng() < 0.5) return `${text} ${pick(rng, emojis)}`;
  return text;
}

function applyStyle(text, style, rng) {
  let out = text;
  if (style.includes('typo')) out = applyTypos(out, rng);
  if (style.includes('emoji')) out = applyEmojis(out, rng);
  return out;
}

function resolveLanguage(rng, filter) {
  if (filter && filter !== 'all' && filter !== 'mixed') return filter;
  if (filter === 'mixed') return 'mixed';
  return pick(rng, BASE_LANGUAGES);
}

function resolveStyle(rng) {
  return pick(rng, STYLE_OPTIONS);
}

function guestsPhrase(lang, n, rng) {
  const map = {
    it: [`siamo ${n}`, `siamo in ${n}`, `per ${n}`],
    en: [`we're ${n}`, `we are ${n} friends`, `${n} of us`],
    es: [`somos ${n}`, `para ${n}`],
    de: [`wir sind ${n} Personen`, `wir wären ${n} Personen`, `${n} Personen`],
    mixed: [`we are ${n} girls`, `siamo ${n}, we're looking`, `Ciao! ${n} friends`],
  };
  return pick(rng, map[lang] || map.en);
}

function packagePhrase(lang, pkg, rng) {
  const cap = pkg.charAt(0).toUpperCase() + pkg.slice(1);
  const map = {
    it: [`${cap}`, `pacchetto ${cap}`, `per ${cap}`],
    en: [`${cap} package`, `${cap}`, `interested in ${cap}`],
    es: [`${cap}`, `paquete ${cap}`],
    de: [`${cap} Paket`, `${cap}`],
    mixed: [`maybe ${cap}?`, `${cap} package pls`],
  };
  return pick(rng, map[lang] || map.en);
}

function accommodationPhrase(lang, rng) {
  const map = {
    it: ['solo alloggio', 'solo il soggiorno', 'no pack solo stay'],
    en: ['accommodation only', 'just the stay', 'no package just stay'],
    es: ['solo alojamiento', 'solo estadía'],
    de: ['nur Unterkunft', 'nur Übernachtung'],
    mixed: ['just accommodation', 'solo stay no package'],
  };
  return pick(rng, map[lang] || map.en);
}

function addonPhrase(lang, rng) {
  const map = {
    it: ['muta e tavola', 'uno vuole muta e tavola', 'serve muta + tavola'],
    en: ['wetsuit and board please', 'need wetsuit + surfboard'],
    es: ['traje y tabla', 'muta y tabla pls'],
    de: ['Neopren und Board', 'Wetsuit und Surfboard'],
    mixed: ['wetsuit + board pls', 'muta e board'],
  };
  return pick(rng, map[lang] || map.en);
}

function lessonPhrase(lang, rng) {
  const map = {
    it: ['anche lezioni di surf', 'vorremmo lezioni'],
    en: ['maybe lessons too', 'surf lessons please'],
    es: ['clases de surf también', 'queremos clases'],
    de: ['Surfkurse bitte', 'auch Surf-Unterricht'],
    mixed: ['lessons too maybe', 'lezioni pls'],
  };
  return pick(rng, map[lang] || map.en);
}

function yogaPhrase(lang, rng) {
  const map = {
    it: ['posso aggiungere yoga?', 'c\'è yoga?'],
    en: ['can we add yoga?', 'is yoga available?'],
    es: ['¿hay yoga?', 'podemos añadir yoga?'],
    de: ['gibt es Yoga?', 'können wir Yoga dazu buchen?'],
    mixed: ['yoga too?', 'posso yoga?'],
  };
  return pick(rng, map[lang] || map.en);
}

function dinnerPhrase(lang, rng) {
  const map = {
    it: ['e magari una cena?', 'possiamo cenare lì?'],
    en: ['and maybe dinner?', 'can we have meals?'],
    es: ['¿y cena?', '¿podemos cenar?'],
    de: ['und vielleicht Abendessen?', 'können wir essen?'],
    mixed: ['dinner too?', 'cena maybe?'],
  };
  return pick(rng, map[lang] || map.en);
}

function transferPhrase(lang, rng) {
  const map = {
    it: ['c\'è transfer da Santander?', 'transfer aeroporto?'],
    en: ['airport transfer from Santander?', 'is transfer included?'],
    es: ['¿hay transfer desde Santander?', 'transfer del aeropuerto?'],
    de: ['Gibt es Transfer vom Flughafen Santander?', 'Transfer vom Flughafen?'],
    mixed: ['transfer from Santander airport?', 'transfer Santander?'],
  };
  return pick(rng, map[lang] || map.en);
}

function cashPhrase(lang, rng) {
  const map = {
    it: ['possiamo pagare in contanti?', 'si paga in cash?'],
    en: ['can we pay cash on arrival?', 'cash payment ok?'],
    es: ['¿podemos pagar en efectivo?', 'pago en efectivo?'],
    de: ['können wir bar zahlen?', 'Barzahlung möglich?'],
    mixed: ['pay cash?', 'efectivo ok?'],
  };
  return pick(rng, map[lang] || map.en);
}

function resetPhrase(lang, rng) {
  const map = {
    it: ['no aspetta, ricominciamo', 'ricominciamo da capo'],
    en: ['wait, let\'s start again', 'start over please'],
    es: ['no espera, empezamos de nuevo', 'empezamos otra vez'],
    de: ['nein, von vorne', 'nochmal von vorn bitte'],
    mixed: ['wait start over', 'empezamos de nuevo'],
  };
  return pick(rng, map[lang] || map.en);
}

function correctionPhrase(lang, n, rng) {
  const map = {
    it: [`in realtà siamo ${n}`, `scusa siamo ${n}`],
    en: [`actually we are ${n}`, `sorry we are ${n}`],
    es: [`en realidad somos ${n}`, `perdón somos ${n}`],
    de: [`eigentlich sind wir ${n}`, `sorry wir sind ${n}`],
    mixed: [`actually we are ${n}`, `siamo ${n} in realtà`],
  };
  return pick(rng, map[lang] || map.en);
}

function buildOpening(lang, stay, guests, pkg, accOnly, rng) {
  const gp = guestsPhrase(lang, guests, rng);
  const dateKey = lang === 'mixed' ? 'label_mixed' : `label_${lang}`;
  const dates = stay[dateKey] || stay.label_en;
  if (accOnly) {
    const acc = accommodationPhrase(lang, rng);
    const templates = {
      it: [`${gp}, ${dates}, ${acc}`],
      en: [`Hey ${gp}, ${dates}, ${acc}`],
      es: [`Hola! ${gp} ${dates}, ${acc}`],
      de: [`Hallo, ${gp}, ${dates}, ${acc}`],
      mixed: [`Ciao! ${gp}, ${dates}, ${acc}`],
    };
    return (templates[lang] || templates.en)[0];
  }
  if (pkg) {
    const pp = packagePhrase(lang, pkg, rng);
    const templates = {
      it: [`Ciao ${gp} ${pp} ${dates}`],
      en: [`Hi ${gp} for ${dates}, ${pp}`],
      es: [`Hola ${gp} ${pp} ${dates}`],
      de: [`Hallo ${gp}, ${pp}, ${dates}`],
      mixed: [`Ciao! ${gp}, ${dates}, ${pp}`],
    };
    return (templates[lang] || templates.en)[0];
  }
  return `Hi ${gp}, ${dates}`;
}

function baseExpect(lang, guests, stay, opts = {}) {
  const expect = {
    expected_guest_count: guests,
    expected_dates: { check_in: stay.check_in, check_out: stay.check_out },
    expected_no_handoff: true,
    no_internal_language: true,
  };
  if (lang !== 'mixed') expect.expected_language = lang;
  if (opts.quoteReady) expect.expected_quote_ready = true;
  if (opts.package) expect.expected_package = opts.package;
  if (opts.accommodation) expect.expected_accommodation_only = true;
  if (opts.service) expect.expected_service_interest = opts.service;
  if (opts.yoga) expect.expected_yoga_request = true;
  if (opts.meals) expect.expected_meals_request = true;
  if (opts.contextPreserved) expect.expected_context_preserved = true;
  if (opts.cashReply) expect.reply_contains = ['cash'];
  if (opts.allowPartial) expect.allow_partial = true;
  return expect;
}

function buildScenario(type, rng, lang, style, index, seed) {
  const guests = pickInt(rng, 1, 4);
  const guests2 = guests === 1 ? 2 : guests - 1 || 2;
  const pkg = pick(rng, PACKAGES);
  const shortStay = type.includes('short') || type === 'out_of_order_all_in_one';
  const stay = buildStay(rng, shortStay ? 'short' : 'week');
  const contactPool = CONTACT_NAMES[lang] || CONTACT_NAMES.en;
  const contact = contactPool[Math.floor(rng() * contactPool.length)];
  const id = `hammer-${seed}-${String(index + 1).padStart(4, '0')}`;

  const scenario = {
    id,
    fixture_set: 'random-hammer',
    language: lang,
    contact_name: contact,
    reference_date: REFERENCE_DATE,
    hammer_meta: {
      seed,
      index: index + 1,
      scenario_type: type,
      language: lang,
      style: style === 'plain' ? [] : style.split('_'),
      generated_at: new Date().toISOString(),
    },
    turns: [],
    final_expect: {
      expected_fields: {
        check_in: stay.check_in,
        check_out: stay.check_out,
        guest_count: guests,
      },
      no_internal_language: true,
      no_handoff: true,
    },
  };

  if (lang !== 'mixed') scenario.final_expect.expected_language = lang;

  switch (type) {
    case 'short_stay_accommodation': {
      const msg = applyStyle(buildOpening(lang, stay, guests, null, true, rng), style, rng);
      scenario.turns.push({
        message: msg,
        expect: baseExpect(lang, guests, stay, { accommodation: true, quoteReady: true }),
      });
      scenario.final_expect.expected_fields.package_interest = 'accommodation_only';
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'package_booking': {
      const msg = applyStyle(buildOpening(lang, stay, guests, pkg, false, rng), style, rng);
      scenario.turns.push({
        message: msg,
        expect: baseExpect(lang, guests, stay, { package: pkg, quoteReady: true }),
      });
      scenario.final_expect.expected_fields.package_interest = pkg;
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'package_surf_addons': {
      const open = applyStyle(buildOpening(lang, stay, guests, pkg, false, rng), style, rng);
      const addon = applyStyle(addonPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: `${open}, ${addon}`,
        expect: baseExpect(lang, guests, stay, {
          package: pkg,
          service: ['wetsuit', 'surfboard'],
          quoteReady: true,
          allowPartial: true,
        }),
      });
      scenario.final_expect.expected_fields.package_interest = pkg;
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'short_stay_surf_addons': {
      const open = applyStyle(buildOpening(lang, stay, guests, null, true, rng), style, rng);
      const addon = applyStyle(addonPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: `${open}, ${addon}`,
        expect: baseExpect(lang, guests, stay, {
          accommodation: true,
          service: ['wetsuit', 'surfboard'],
          quoteReady: true,
          allowPartial: true,
        }),
      });
      scenario.final_expect.expected_fields.package_interest = 'accommodation_only';
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'lesson_addon': {
      const open = applyStyle(buildOpening(lang, stay, guests, null, true, rng), style, rng);
      const lesson = applyStyle(lessonPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: `${open}, ${lesson}`,
        expect: baseExpect(lang, guests, stay, {
          accommodation: true,
          service: ['surf_lesson'],
          quoteReady: true,
          allowPartial: true,
        }),
      });
      scenario.final_expect.expected_fields.package_interest = 'accommodation_only';
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'yoga_request': {
      const open = applyStyle(buildOpening(lang, stay, guests, pkg, false, rng), style, rng);
      scenario.turns.push({
        message: open,
        expect: baseExpect(lang, guests, stay, { package: pkg, quoteReady: true }),
      });
      const yoga = applyStyle(yogaPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: yoga,
        expect: baseExpect(lang, guests, stay, {
          yoga: true,
          contextPreserved: true,
          allowPartial: true,
        }),
      });
      scenario.final_expect.expected_fields.package_interest = pkg;
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'dinner_meals_request': {
      const open = applyStyle(buildOpening(lang, stay, guests, pkg, false, rng), style, rng);
      scenario.turns.push({
        message: open,
        expect: baseExpect(lang, guests, stay, { package: pkg, quoteReady: true }),
      });
      const dinner = applyStyle(dinnerPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: dinner,
        expect: baseExpect(lang, guests, stay, {
          meals: true,
          contextPreserved: true,
          allowPartial: true,
        }),
      });
      scenario.final_expect.expected_fields.package_interest = pkg;
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'transfer_side_question': {
      const open = applyStyle(buildOpening(lang, stay, guests, pkg, false, rng), style, rng);
      scenario.turns.push({
        message: open,
        expect: baseExpect(lang, guests, stay, { package: pkg, quoteReady: true }),
      });
      const xfer = applyStyle(transferPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: xfer,
        expect: baseExpect(lang, guests, stay, { contextPreserved: true, allowPartial: true }),
      });
      scenario.final_expect.expected_fields.package_interest = pkg;
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'cash_payment_side_question': {
      const open = applyStyle(buildOpening(lang, stay, guests, null, true, rng), style, rng);
      scenario.turns.push({
        message: open,
        expect: baseExpect(lang, guests, stay, { accommodation: true, quoteReady: true }),
      });
      const cash = applyStyle(cashPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: cash,
        expect: baseExpect(lang, guests, stay, {
          contextPreserved: true,
          quoteReady: true,
          cashReply: true,
          allowPartial: true,
        }),
      });
      scenario.final_expect.expected_fields.package_interest = 'accommodation_only';
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'correction_flow': {
      const wrongGuests = guests === 1 ? 1 : guests - 1;
      const open = applyStyle(buildOpening(lang, stay, wrongGuests, null, true, rng), style, rng);
      scenario.turns.push({
        message: open,
        expect: baseExpect(lang, wrongGuests, stay, { accommodation: true, quoteReady: true }),
      });
      const corr = applyStyle(correctionPhrase(lang, guests, rng), style, rng);
      scenario.turns.push({
        message: corr,
        expect: {
          expected_guest_count: guests,
          expected_stale_quote: true,
          expected_corrected_fields: ['guest_count'],
          expected_quote_ready: true,
          expected_no_handoff: true,
          no_internal_language: true,
          allowPartial: true,
        },
      });
      scenario.final_expect.expected_fields.guest_count = guests;
      scenario.final_expect.expected_fields.package_interest = 'accommodation_only';
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    case 'reset_flow': {
      const open = applyStyle(buildOpening(lang, stay, guests, pkg, false, rng), style, rng);
      scenario.turns.push({
        message: open,
        expect: baseExpect(lang, guests, stay, { package: pkg, quoteReady: true }),
      });
      const reset = applyStyle(resetPhrase(lang, rng), style, rng);
      scenario.turns.push({
        message: reset,
        expect: {
          expected_reset_detected: true,
          expected_quote_ready: false,
          expected_no_handoff: true,
          no_internal_language: true,
        },
      });
      const stay2 = buildStay(rng, 'short');
      const reopen = applyStyle(buildOpening(lang, stay2, guests2, null, true, rng), style, rng);
      scenario.turns.push({
        message: reopen,
        expect: baseExpect(lang, guests2, stay2, { accommodation: true, allowPartial: true }),
      });
      scenario.final_expect.expected_fields = {
        check_in: stay2.check_in,
        check_out: stay2.check_out,
        guest_count: guests2,
      };
      break;
    }
    case 'out_of_order_all_in_one': {
      const acc = accommodationPhrase(lang, rng);
      const gp = guestsPhrase(lang, guests, rng);
      const dateKey = lang === 'mixed' ? 'label_mixed' : `label_${lang}`;
      const dates = stay[dateKey] || stay.label_en;
      const templates = {
        it: `${gp}, vorremmo ${dates}, ${acc}`,
        en: `${gp}, looking for ${dates}, ${acc}`,
        es: `${gp}, ${dates}, ${acc}`,
        de: `${gp}, ${dates}, ${acc}`,
        mixed: `Ciao! ${gp}, ${dates}, ${acc}`,
      };
      const msg = applyStyle(templates[lang] || templates.en, style, rng);
      scenario.turns.push({
        message: msg,
        expect: baseExpect(lang, guests, stay, { accommodation: true, quoteReady: true }),
      });
      scenario.final_expect.expected_fields.package_interest = 'accommodation_only';
      scenario.final_expect.expected_quote_ready = true;
      break;
    }
    default:
      break;
  }

  return scenario;
}

/**
 * @param {object} opts
 * @param {number} opts.count
 * @param {number} opts.seed
 * @param {string} [opts.language] it|en|es|de|mixed|all
 * @param {number} [opts.maxTurns] cap turns per scenario (truncate)
 */
function generateHammerScenarios(opts) {
  const count = Math.max(1, Number(opts.count) || 50);
  const seed = Number(opts.seed) || 40401;
  const langFilter = opts.language || 'all';
  const maxTurns = opts.maxTurns != null ? Number(opts.maxTurns) : null;
  const rng = createSeededRng(seed);
  const scenarios = [];

  for (let i = 0; i < count; i++) {
    const type = SCENARIO_TYPES[i % SCENARIO_TYPES.length];
    const lang = resolveLanguage(rng, langFilter);
    const style = resolveStyle(rng);
    const scenario = buildScenario(type, rng, lang, style, i, seed);
    if (maxTurns != null && maxTurns > 0 && scenario.turns.length > maxTurns) {
      scenario.turns = scenario.turns.slice(0, maxTurns);
    }
    scenarios.push(scenario);
  }

  return {
    seed,
    count: scenarios.length,
    language_filter: langFilter,
    reference_date: REFERENCE_DATE,
    scenarios,
  };
}

module.exports = {
  SCENARIO_TYPES,
  BASE_LANGUAGES,
  LANGUAGE_FILTERS,
  REFERENCE_DATE,
  createSeededRng,
  generateHammerScenarios,
};
