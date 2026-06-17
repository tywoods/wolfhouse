'use strict';

/**
 * Stage 43a — Guest-facing Somo surf report formatter + intent routing.
 * Consumes Stormglass staff metrics shape or mock fixtures; never exposes API keys.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
const DEFAULT_CLIENT = 'wolfhouse-somo';
const CACHE = new Map();

const STORMY_WIND_MPS = 10;
const MINOR_WIND_MPS = 8;

/** @type {((opts: object) => Promise<object|null>)|null} */
let _fetchOverrideForTests = null;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function configPathForClient(clientSlug) {
  return path.join(CONFIG_DIR, `${trimStr(clientSlug) || DEFAULT_CLIENT}.surf-report.json`);
}

function loadSurfReportConfig(clientSlug) {
  const slug = trimStr(clientSlug) || DEFAULT_CLIENT;
  if (CACHE.has(slug)) return CACHE.get(slug);
  const filePath = configPathForClient(slug);
  if (!fs.existsSync(filePath)) {
    CACHE.set(slug, null);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    CACHE.set(slug, null);
    return null;
  }
  CACHE.set(slug, parsed);
  return parsed;
}

function normalizeSurfQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function surfHasTodayWord(q) {
  return /\b(today|tonight|hoy|oggi|heute|aujourdhui|aujourd hui)\b/.test(q);
}

function surfHasTomorrowWord(q) {
  return /\b(tomorrow|manana|domani|morgen|demain)\b/.test(q);
}

function isLessonScheduleQuestion(q) {
  return /\b(?:what\s+time|when\s+are|a\s+che\s+ora|horario|wann\s+sind|lesson\s+times?)\b/.test(q)
    && /\blesson|lezioni|clases|kurse|surfkurse\b/.test(q);
}

function matchesGuestSurfReportTopic(q) {
  if (isLessonScheduleQuestion(q)) return false;
  if (/\b(?:who has|who needs|how many|booked|scheduled|show)\b/.test(q) && /\blessons?\b/.test(q)) {
    return false;
  }
  if (/\b(?:surf\s*report|surfbericht|prevision(?:e| del)? surf|prevision del surf)\b/.test(q)) return true;
  if (/\bhow are the waves\b/.test(q)) return true;
  if (/\bhow(?:'s|s| is)\s+the\s+surf\b/.test(q)) return true;
  if (/\bhow(?:'s|s| is)\s+it\s+(?:out\s+there|in\s+the\s+water)\b/.test(q)) return true;
  if (/\b(?:what'?s|whats) the surf like\b/.test(q)) return true;
  if (/\b(?:is|are) somo good\b/.test(q)) return true;
  if (/\bare there waves\b/.test(q)) return true;
  if (/\bhow are conditions\b/.test(q)) return true;
  if (/\b(?:is there surf|any surf)\b/.test(q)) return true;
  if (/\b(?:como estan las olas|como esta el surf|que tal las olas|prevision del surf|prevision de olas)\b/.test(q)) return true;
  if (/\b(?:com e il mare|come sono le onde|previsione surf|previsione delle onde)\b/.test(q)) return true;
  if (/\b(?:wie sind die wellen|surfbericht)\b/.test(q)) return true;
  if (/\b(?:should i take lessons|devo fare lezioni|debo tomar clases|soll ich.*?kurse)\b/.test(q)
    && surfHasTomorrowWord(q)) return true;
  if (/\b(?:waves?|surf|olas|onde|wellen)\b/.test(q)
    && /\b(?:good|bad|like|conditions?|forecast|prevision|report|today|tomorrow|hoy|oggi|heute|domani|manana|morgen)\b/.test(q)) {
    return true;
  }
  return false;
}

function resolveSurfReportDayLabel(question) {
  const q = normalizeSurfQuestionText(question);
  if (surfHasTomorrowWord(q) && !surfHasTodayWord(q)) return 'tomorrow';
  if (surfHasTomorrowWord(q)) return 'tomorrow';
  return 'today';
}

/**
 * @param {string} text
 * @returns {{ day: 'today'|'tomorrow', intent: 'surf_report' }|null}
 */
function detectGuestSurfReportIntent(text) {
  const raw = trimStr(text);
  if (!raw) return null;
  const q = normalizeSurfQuestionText(raw);
  if (!matchesGuestSurfReportTopic(q)) return null;
  return { day: resolveSurfReportDayLabel(raw), intent: 'surf_report' };
}

function shouldPrioritizeSurfReportOverService(text, guestContext) {
  const intent = detectGuestSurfReportIntent(text);
  if (!intent) return false;
  void guestContext;
  return true;
}

function detectSurfReportLanguage(messageText, explicitLang) {
  const t = String(messageText || '');
  if (/\b(?:come sono|com e il mare|le onde|oggi)\b/i.test(t)) return 'it';
  if (/\b(?:qu[eé] tal|como est[aá]|las olas|hoy)\b/i.test(t)) return 'es';
  if (/\b(?:wie sind|wellen|heute|surfbericht)\b/i.test(t)) return 'de';
  const lang = trimStr(explicitLang).slice(0, 2);
  if (lang && lang !== 'en') return lang;
  return 'en';
}

function classifySurfConditions(metrics, config) {
  const cfg = config || loadSurfReportConfig(DEFAULT_CLIENT) || {};
  const wh = metrics && metrics.wave_height_m != null ? Number(metrics.wave_height_m) : null;
  const wind = metrics && metrics.wind_speed_mps != null ? Number(metrics.wind_speed_mps) : null;
  const stormyThreshold = (cfg.wind_guidance && cfg.wind_guidance.stormy_threshold_mps) || STORMY_WIND_MPS;
  const idealMax = (cfg.ideal_wave_height_m && cfg.ideal_wave_height_m.max) || 2.5;

  if (wind != null && wind >= stormyThreshold) return 'stormy_messy';
  if (wh != null && wh > idealMax + 0.3 && wind != null && wind >= MINOR_WIND_MPS) return 'stormy_messy';

  if (wh == null) return 'fun';
  if (wh < 0.15) return 'tiny_flat';
  if (wh < 0.8) return 'small_friendly';
  if (wh < 1.5) return 'fun';
  if (wh <= idealMax + 0.2) return 'solid';
  return 'stormy_messy';
}

function inferTidePhase(metrics) {
  const phase = metrics && trimStr(metrics.tide_phase).toLowerCase();
  if (['rising', 'high', 'low', 'falling'].includes(phase)) return phase;
  if (metrics && metrics.tide_rising === true) return 'rising';
  if (metrics && metrics.tide_high === true) return 'high';
  if (metrics && metrics.tide_low === true) return 'low';
  return null;
}

function tideGuidanceForBucket(bucket, metrics, config) {
  const cfg = config || {};
  const wh = metrics && metrics.wave_height_m != null ? Number(metrics.wave_height_m) : null;
  const tide = inferTidePhase(metrics);
  const biggerMin = cfg.tide_guidance && cfg.tide_guidance.bigger_waves_m
    ? cfg.tide_guidance.bigger_waves_m.min
    : 1.0;

  if (bucket === 'tiny_flat' || bucket === 'small_friendly') {
    if (tide === 'low' || tide === 'falling') return 'lower_tide';
    return 'lower_tide_general';
  }
  if (wh != null && wh >= biggerMin && (bucket === 'solid' || bucket === 'fun')) {
    if (tide === 'rising' || tide === 'high') return 'rising_high';
    return 'rising_high_general';
  }
  if (tide === 'rising' || tide === 'high') return 'rising_high';
  return null;
}

function buildMidFlowTail(fields, quote, pc, lang, messageText) {
  try {
    const { buildMidFlowKnowledgeReturnTail } = require('./luna-guest-knowledge-config');
    return buildMidFlowKnowledgeReturnTail(fields, quote, pc, lang, messageText);
  } catch (_) {
    return null;
  }
}

function capitalizePhrase(text) {
  const s = trimStr(text);
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function guestFriendlyWaveSizePhrase(waveM, lang) {
  const w = Number(waveM);
  if (!Number.isFinite(w)) return null;
  const L = trimStr(lang).slice(0, 2) || 'en';
  const map = {
    en: [
      [0.3, 'barely a ripple — super small'],
      [0.6, 'small and mellow'],
      [1.0, 'around knee-high'],
      [1.4, 'around waist-high'],
      [1.8, 'around chest-high'],
      [2.5, 'around head-high'],
      [Infinity, 'pretty solid size for Somo'],
    ],
    it: [
      [0.3, 'quasi piattino'],
      [0.6, 'piccole e mellow'],
      [1.0, 'circa al ginocchio'],
      [1.4, 'circa alla vita'],
      [1.8, 'circa al petto'],
      [2.5, 'circa alla testa'],
      [Infinity, 'belle dimensioni per Somo'],
    ],
    es: [
      [0.3, 'casi planito'],
      [0.6, 'pequeñas y suaves'],
      [1.0, 'aprox. a la rodilla'],
      [1.4, 'aprox. a la cintura'],
      [1.8, 'aprox. al pecho'],
      [2.5, 'aprox. a la cabeza'],
      [Infinity, 'buen tamaño para Somo'],
    ],
    de: [
      [0.3, 'kaum eine Welle'],
      [0.6, 'klein und mellow'],
      [1.0, 'ungefähr knietief'],
      [1.4, 'ungefähr hüfttief'],
      [1.8, 'ungefähr brusttief'],
      [2.5, 'ungefähr kopfhoch'],
      [Infinity, 'ordentlich Größe für Somo'],
    ],
  };
  const bands = map[L] || map.en;
  for (const [max, phrase] of bands) {
    if (w <= max) return phrase;
  }
  return bands[bands.length - 1][1];
}

function guestWindPhrase(windMps, lang, config) {
  const wind = Number(windMps);
  if (!Number.isFinite(wind)) return '';
  const cfg = config || loadSurfReportConfig(DEFAULT_CLIENT) || {};
  const stormy = (cfg.wind_guidance && cfg.wind_guidance.stormy_threshold_mps) || STORMY_WIND_MPS;
  const minor = (cfg.wind_guidance && cfg.wind_guidance.ignore_below_mps) || MINOR_WIND_MPS;
  const L = trimStr(lang).slice(0, 2) || 'en';
  if (wind >= stormy) {
    return {
      en: ' with a pretty windy feel',
      it: ' con vento abbastanza presente',
      es: ' con bastante viento',
      de: ' mit ziemlich viel Wind',
    }[L] || ' with a pretty windy feel';
  }
  if (wind >= minor) {
    return {
      en: ' and a light breeze in the mix',
      it: ' e una brezza leggera',
      es: ' y una brisa suave',
      de: ' und eine leichte Brise',
    }[L] || ' and a light breeze in the mix';
  }
  return '';
}

function surfDayLabel(day, lang) {
  const L = trimStr(lang).slice(0, 2) || 'en';
  if (day === 'tomorrow') {
    return { en: 'tomorrow', it: 'domani', es: 'mañana', de: 'morgen' }[L] || 'tomorrow';
  }
  return { en: 'today', it: 'oggi', es: 'hoy', de: 'heute' }[L] || 'today';
}

function buildLiveGuestSurfParagraph(metrics, day, lang, bucket, config) {
  const L = trimStr(lang).slice(0, 2) || 'en';
  const dayLabel = surfDayLabel(day, lang);
  const size = guestFriendlyWaveSizePhrase(metrics.wave_height_m, L);
  if (!size) return null;
  const windBit = guestWindPhrase(metrics.wind_speed_mps, L, config);
  const tide = inferTidePhase(metrics);
  const tideLower = tide === 'low' || tide === 'falling';
  const tideHigher = tide === 'rising' || tide === 'high';

  const templates = {
    en: {
      tiny_flat: `I just peeked at Somo for ${dayLabel} 🌊 it's pretty flat — ${size}${windBit} — more beach-walk and coffee vibes than a surf day ☀️ If things shift, the team will know the sweet spot.`,
      small_friendly: `I just peeked at Somo for ${dayLabel} 🌊 ${capitalizePhrase(size)} waves${windBit} — small and friendly, could be a sweet mellow session${tideLower ? ', especially around the lower tide windows' : ''} 🤙`,
      fun: `I just peeked at Somo for ${dayLabel} 🌊 ${capitalizePhrase(size)} waves${windBit} — looks like a fun Somo day!${tideHigher ? ' With the tide pushing higher it should have some lovely windows.' : ''} The surf school will still pick the best lesson time, but overall it's looking good 🌊`,
      solid: `I just peeked at Somo for ${dayLabel} 🌊 there's a bit more energy in the water — ${size}${windBit}. With waves on the bigger side for Somo, ${tideHigher ? 'rising/high tide is usually the nicer window' : 'the team will find the best window'} 🤙 The surf school will choose the best timing for lessons.`,
      stormy_messy: `I just peeked at Somo for ${dayLabel} 🌊 it's looking a bit stormy and messy${windBit} — I'd keep it flexible and let the surf school pick the nicest window when it cleans up 🌊`,
    },
    it: {
      tiny_flat: `Ho dato un'occhiata a Somo per ${dayLabel} 🌊 è piuttosto piattino — ${capitalizePhrase(size)}${windBit} — più giornata da passeggiata e caffè che da surf ☀️ Se cambia qualcosa, il team saprà la finestra migliore.`,
      small_friendly: `Ho dato un'occhiata a Somo per ${dayLabel} 🌊 onde ${size}${windBit} — piccole e amichevoli, bella sessione mellow${tideLower ? ', soprattutto con maree più basse' : ''} 🤙`,
      fun: `Ho dato un'occhiata a Somo per ${dayLabel} 🌊 onde ${size}${windBit} — sembra una bella giornata a Somo!${tideHigher ? ' Con la marea che sale dovrebbero esserci finestre lovely.' : ''} La scuola surf sceglierà comunque l'orario migliore per le lezioni 🌊`,
      solid: `Ho dato un'occhiata a Somo per ${dayLabel} 🌊 c'è un po' più energia in acqua — ${size}${windBit}. Con onde verso il limite alto per Somo, ${tideHigher ? 'marea crescente/alta di solito è la finestra più bella' : 'il team troverà la finestra migliore'} 🤙 La scuola surf sceglierà il timing migliore per le lezioni.`,
      stormy_messy: `Ho dato un'occhiata a Somo per ${dayLabel} 🌊 sembra un po' stormy/mosso${windBit} — meglio restare flessibili e lasciare che la scuola surf scelga la finestra migliore 🌊`,
    },
    es: {
      tiny_flat: `Acabo de mirar Somo para ${dayLabel} 🌊 está bastante plano — ${size}${windBit} — más día de paseo y café que de surf ☀️ Si cambia algo, el equipo sabrá la mejor ventana.`,
      small_friendly: `Acabo de mirar Somo para ${dayLabel} 🌊 olas ${size}${windBit} — pequeñas y amigables, sesión suave${tideLower ? ', sobre todo con mareas más bajas' : ''} 🤙`,
      fun: `Acabo de mirar Somo para ${dayLabel} 🌊 olas ${size}${windBit} — ¡parece un día divertido en Somo!${tideHigher ? ' Con la marea subiendo debería haber ventanas bonitas.' : ''} La escuela de surf elegirá la mejor hora, pero en general pinta bien 🌊`,
      solid: `Acabo de mirar Somo para ${dayLabel} 🌊 hay un poco más de energía en el agua — ${size}${windBit}. Con olas hacia el rango alto para Somo, ${tideHigher ? 'marea creciente/alta suele ser la ventana más bonita' : 'el equipo encontrará la mejor ventana'} 🤙 La escuela de surf elegirá el mejor timing para clases.`,
      stormy_messy: `Acabo de mirar Somo para ${dayLabel} 🌊 se ve un poco stormy/movedizo${windBit} — mejor mantenerlo flexible y dejar que la escuela elija la mejor ventana 🌊`,
    },
    de: {
      tiny_flat: `Ich hab Somo für ${dayLabel} gecheckt 🌊 ziemlich flach — ${capitalizePhrase(size)}${windBit} — eher Strandspaziergang und Kaffee als Surf ☀️ Wenn sich was ändert, kennt das Team das beste Fenster.`,
      small_friendly: `Ich hab Somo für ${dayLabel} gecheckt 🌊 ${capitalizePhrase(size)} Wellen${windBit} — klein und freundlich, mellow Session${tideLower ? ', besonders bei Niedrigwasser' : ''} 🤙`,
      fun: `Ich hab Somo für ${dayLabel} gecheckt 🌊 ${capitalizePhrase(size)} Wellen${windBit} — sieht nach einem schönen Somo-Tag aus!${tideHigher ? ' Mit steigender Tide sollten schöne Fenster dabei sein.' : ''} Die Surfschule wählt trotzdem die beste Unterrichtszeit 🌊`,
      solid: `Ich hab Somo für ${dayLabel} gecheckt 🌊 etwas mehr Energie im Wasser — ${size}${windBit}. Bei Wellen am oberen Ende für Somo ist ${tideHigher ? 'steigende/hohe Tide meist das schönere Fenster' : 'das Team findet das beste Fenster'} 🤙 Die Surfschule wählt das beste Timing für Kurse.`,
      stormy_messy: `Ich hab Somo für ${dayLabel} gecheckt 🌊 etwas stürmisch/unruhig${windBit} — am besten flexibel bleiben und die Surfschule das beste Fenster wählen lassen 🌊`,
    },
  };

  const pack = templates[L] || templates.en;
  return pack[bucket] || pack.fun;
}

function localizedSurfParagraphs(lang) {
  const L = trimStr(lang).slice(0, 2) || 'en';
  const map = {
    en: {
      tiny_flat: "It's looking pretty tiny/flat in Somo today — maybe more of a beach walk and coffee kind of surf check ☀️ If conditions change, the team will know the best window.",
      small_friendly: 'Looks small and friendly today in Somo 🌊 Could be a sweet day for beginners or a mellow session, especially around the lower tide windows.',
      fun: 'Looks like a fun Somo day 🌊 Waves are in a nice range, and with the tide pushing higher it should have some lovely windows. The school/team will still pick the best lesson time, but overall it looks like a good one.',
      solid: "Looks like there's a bit more energy in the water today 🌊 With waves around the bigger end for Somo, rising/high tide is usually the nicer window. The surf school will choose the best timing for lessons.",
      stormy_messy: "Looks a bit stormy/messy today 🌊 I'd keep it flexible and wait for the school/team to pick the best window.",
      tide_lower: 'especially around the lower tide windows',
      tide_rising: 'with the tide pushing higher it should have some lovely windows',
      tide_rising_bigger: 'rising/high tide is usually the nicer window',
      school_note: 'The surf school will choose the best timing for lessons.',
      tomorrow_prefix: 'For tomorrow in Somo',
    },
    it: {
      tiny_flat: 'A Somo oggi sembra piuttosto piattino/mini — più giornata da passeggiata in spiaggia e caffè ☀️ Se cambia qualcosa, il team saprà la finestra migliore.',
      small_friendly: 'Le onde a Somo sembrano piccole e amichevoli oggi 🌊 Una bella giornata per principianti o una sessione soft, soprattutto con maree più basse.',
      fun: 'Le onde a Somo sembrano carine oggi 🌊 Sono in una bella fascia e con la marea che sale dovrebbero esserci delle finestre lovely. La scuola/team sceglierà comunque l\'orario migliore per le lezioni, ma nel complesso promette bene.',
      solid: 'C\'è un po\' più energia in acqua oggi a Somo 🌊 Con onde verso il limite alto per Somo, marea crescente/alta di solito è la finestra più bella. La scuola surf sceglierà il timing migliore per le lezioni.',
      stormy_messy: 'Oggi a Somo sembra un po\' stormy/mosso 🌊 Meglio restare flessibili e lasciare che scuola/team scelgano la finestra migliore.',
      tide_lower: 'soprattutto con maree più basse',
      tide_rising: 'con la marea che sale dovrebbero esserci delle finestre lovely',
      tide_rising_bigger: 'marea crescente/alta di solito è la finestra più bella',
      school_note: 'La scuola surf sceglierà il timing migliore per le lezioni.',
      tomorrow_prefix: 'Per domani a Somo',
    },
    es: {
      tiny_flat: 'En Somo hoy se ve bastante mini/plano — más día de paseo por la playa y café ☀️ Si cambia algo, el equipo sabrá la mejor ventana.',
      small_friendly: 'Parece que Somo tiene olitas bonitas hoy 🌊 Día dulce para principiantes o sesión suave, sobre todo con mareas más bajas.',
      fun: 'Parece que Somo tiene olitas bonitas hoy 🌊 Van en un rango agradable y con la marea subiendo debería haber ventanas lovely. La escuela/equipo elegirá la mejor hora de clase, pero en general pinta bien.',
      solid: 'Hay un poco más de energía en el agua hoy en Somo 🌊 Con olas hacia el rango alto para Somo, marea creciente/alta suele ser la ventana más bonita. La escuela de surf elegirá el mejor timing para clases.',
      stormy_messy: 'Hoy en Somo se ve un poco stormy/movedizo 🌊 Mejor mantenerlo flexible y dejar que escuela/equipo elijan la mejor ventana.',
      tide_lower: 'sobre todo con mareas más bajas',
      tide_rising: 'con la marea subiendo debería haber ventanas lovely',
      tide_rising_bigger: 'marea creciente/alta suele ser la ventana más bonita',
      school_note: 'La escuela de surf elegirá el mejor timing para clases.',
      tomorrow_prefix: 'Para mañana en Somo',
    },
    de: {
      tiny_flat: 'In Somo sieht es heute ziemlich mini/flach aus — eher Strandspaziergang und Kaffee ☀️ Wenn sich was ändert, kennt das Team das beste Fenster.',
      small_friendly: 'Sieht nach einem schönen Somo-Surftag aus 🌊 Klein und freundlich — gut für Anfänger oder eine mellow Session, besonders bei Niedrigwasser.',
      fun: 'Sieht nach einem schönen Somo-Surftag aus 🌊 Die Wellen liegen in einem netten Bereich und mit steigender Tide sollten schöne Fenster dabei sein. Die Surfschule/das Team wählt trotzdem die beste Unterrichtszeit — insgesamt sieht es gut aus.',
      solid: 'Heute hat das Wasser in Somo etwas mehr Energie 🌊 Bei Wellen am oberen Ende für Somo ist steigende/hohe Tide meist das schönere Fenster. Die Surfschule wählt das beste Timing für Kurse.',
      stormy_messy: 'Heute wirkt es in Somo etwas stürmisch/unruhig 🌊 Am besten flexibel bleiben und die Surfschule/das Team das beste Fenster wählen lassen.',
      tide_lower: 'besonders bei Niedrigwasser',
      tide_rising: 'mit steigender Tide sollten schöne Fenster dabei sein',
      tide_rising_bigger: 'steigende/hohe Tide ist meist das schönere Fenster',
      school_note: 'Die Surfschule wählt das beste Timing für Kurse.',
      tomorrow_prefix: 'Für morgen in Somo',
    },
  };
  return map[L] || map.en;
}

function formatGuestSurfReportReply(input) {
  const inp = input || {};
  const config = loadSurfReportConfig(inp.client_slug) || {};
  const lang = detectSurfReportLanguage(inp.message_text, inp.lang);
  const day = trimStr(inp.day) || 'today';
  const paragraphs = localizedSurfParagraphs(lang);

  if (inp.unavailable === true) {
    const fb = (config.fallback && (config.fallback[lang] || config.fallback.en))
      || paragraphs.tiny_flat;
    let reply = fb;
    const tail = inp.preserve_booking_context !== false
      ? buildMidFlowTail(inp.fields, inp.quote, inp.payment_choice, lang, inp.message_text)
      : null;
    if (tail) reply = `${reply} ${tail}`;
    return { reply, bucket: null, unavailable: true, language: lang, day };
  }

  const metrics = inp.metrics || {};
  const bucket = classifySurfConditions(metrics, config);
  let reply;
  if (metrics.wave_height_m != null && Number.isFinite(Number(metrics.wave_height_m))) {
    reply = buildLiveGuestSurfParagraph(metrics, day, lang, bucket, config);
  }
  if (!reply) {
    reply = (localizedSurfParagraphs(lang)[bucket]) || localizedSurfParagraphs(lang).fun;
  }

  if (day === 'tomorrow') {
    reply = reply.replace(/today/gi, 'tomorrow').replace(/oggi/gi, 'domani').replace(/hoy/gi, 'mañana').replace(/heute/gi, 'morgen');
    if (!/tomorrow|domani|mañana|morgen/i.test(reply)) {
      reply = `${paragraphs.tomorrow_prefix}, ${reply.charAt(0).toLowerCase()}${reply.slice(1)}`;
    }
  }

  const tail = inp.preserve_booking_context !== false
    ? buildMidFlowTail(inp.fields, inp.quote, inp.payment_choice, lang, inp.message_text)
    : null;
  if (tail) reply = `${reply} ${tail}`;

  return {
    reply,
    bucket,
    unavailable: false,
    language: lang,
    day,
    metrics_used: {
      wave_height_m: metrics.wave_height_m ?? null,
      wind_speed_mps: metrics.wind_speed_mps ?? null,
      tide_phase: inferTidePhase(metrics),
    },
  };
}

function normalizeMockSurfData(mock) {
  if (mock == null) return null;
  if (mock === 'unavailable' || mock === 'timeout') return { unavailable: true };
  if (typeof mock === 'string') {
    try {
      return JSON.parse(mock);
    } catch (_) {
      return null;
    }
  }
  if (typeof mock === 'object') {
    if (mock.unavailable === true || mock.api_unavailable === true) return { unavailable: true };
    return { metrics: mock, unavailable: false };
  }
  return null;
}

/**
 * Fetch or resolve surf data for guest reply (mock > live API > unavailable).
 * @param {{ clientSlug: string, day: string, mock?: object|string, timeoutMs?: number }} opts
 */
async function fetchGuestSurfReportData(opts) {
  const clientSlug = trimStr(opts.clientSlug) || DEFAULT_CLIENT;
  const day = trimStr(opts.day) || 'today';
  const mockNorm = normalizeMockSurfData(opts.mock);

  if (_fetchOverrideForTests) {
    return _fetchOverrideForTests({ ...opts, clientSlug, day, mockNorm });
  }

  if (mockNorm) {
    if (mockNorm.unavailable) return { unavailable: true, day, source: 'mock' };
    return { metrics: mockNorm.metrics || mockNorm, day, source: 'mock' };
  }

  let hasConfig = false;
  let fetchStaff;
  try {
    const stormConfig = require('./staff-stormglass-config');
    const stormForecast = require('./staff-stormglass-forecast');
    fetchStaff = stormForecast.fetchSurfForecastForStaff;
    hasConfig = stormConfig.hasStormglassConfig();
  } catch (_) {
    return { unavailable: true, day, source: 'none' };
  }

  if (!hasConfig) {
    return { unavailable: true, day, source: 'none' };
  }

  try {
    const payload = await fetchStaff({
      clientSlug,
      day,
      timeoutMs: opts.timeoutMs || 8000,
    });
    const fc = payload.forecast || {};
    return {
      metrics: {
        wave_height_m: fc.wave_height_m,
        swell_height_m: fc.swell_height_m,
        wind_speed_mps: fc.wind_speed_mps,
        tide_phase: fc.tide_summary_if_available,
      },
      day: payload.day || day,
      source: payload.source || 'stormglass',
      unavailable: false,
    };
  } catch (err) {
    const error = trimStr(err && err.message) || 'stormglass_request_failed';
    const errorCode = trimStr(err && err.code) || 'UPSTREAM_ERROR';
    const status = err && err.status;
    console.error('[surf-report] stormglass fetch failed', {
      clientSlug,
      day,
      error,
      errorCode,
      status: status || null,
    });
    return {
      unavailable: true,
      day,
      source: 'stormglass_error',
      error,
      error_code: errorCode,
      upstream_status: status || null,
    };
  }
}

function setGuestSurfReportFetchForTests(fn) {
  _fetchOverrideForTests = fn || null;
}

function buildGuestSurfReportReply(input) {
  const inp = input || {};
  const data = inp.surf_data || {};
  if (data.unavailable === true) {
    return formatGuestSurfReportReply({ ...inp, unavailable: true });
  }
  return formatGuestSurfReportReply({
    ...inp,
    metrics: data.metrics || inp.metrics,
    day: data.day || inp.day,
    unavailable: false,
  });
}

module.exports = {
  loadSurfReportConfig,
  detectGuestSurfReportIntent,
  shouldPrioritizeSurfReportOverService,
  detectSurfReportLanguage,
  classifySurfConditions,
  formatGuestSurfReportReply,
  buildGuestSurfReportReply,
  fetchGuestSurfReportData,
  setGuestSurfReportFetchForTests,
  normalizeMockSurfData,
  tideGuidanceForBucket,
  DEFAULT_CLIENT,
};
