'use strict';

/**
 * i18n guest-copy lint (robustness plan, step 4).
 *
 * Walks config/clients/*.personalities.json, finds every per-language dict
 * (an object keyed by language codes — en/it/de/es/fr), and reports keys present
 * in `en` but MISSING in another language. A missing key means the runtime
 * silently falls back to the English string → a guest gets one stray English line
 * in an otherwise-Italian reply (the "BUG D" class of mixed-language output).
 *
 * RATCHET model (mirrors the golden-suite xfail): the non-English templates carry
 * a large pre-existing translation debt, so we do NOT hard-block deploys on it.
 * The accepted debt lives in a committed baseline; the lint PASSES on baselined
 * gaps and FAILS only on NEW gaps — i.e. someone added an `en` key (or a whole
 * dict) without translating it. That stops the debt from growing while we chip it
 * down. When you intentionally accept or CLOSE gaps, refresh with --update-baseline.
 *
 * Usage:
 *   node scripts/check-i18n-guest-copy.js                 # gate: fail on NEW gaps
 *   node scripts/check-i18n-guest-copy.js --report        # full debt report, never fails
 *   node scripts/check-i18n-guest-copy.js --update-baseline
 *
 * Exit 0 = no new gaps, 1 = a new gap (regression) or a missing baseline.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENTS_DIR = path.join(ROOT, 'config', 'clients');
const BASELINE = path.join(__dirname, 'i18n-gaps-baseline.json');
const LANGS = new Set(['en', 'it', 'de', 'es', 'fr']);

const argv = process.argv.slice(2);
const update = argv.includes('--update-baseline');
const reportOnly = argv.includes('--report');

// Walk an object, yielding [dotPath, dict] for every per-language dict (an object
// with >=2 language-code keys whose values are objects of string templates).
function findLangDicts(obj, p, out) {
  if (!obj || typeof obj !== 'object') return;
  if (!Array.isArray(obj)) {
    const langKeys = Object.keys(obj).filter((k) => LANGS.has(k));
    if (langKeys.length >= 2 && langKeys.every((k) => obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]))) {
      out[p] = obj;
      return; // don't descend into the language sub-dicts themselves
    }
    for (const k of Object.keys(obj)) findLangDicts(obj[k], p ? `${p}.${k}` : k, out);
  }
}

// gaps shape: { "<file>::<dotpath>": { "<lang>": ["missingKey", ...] } }
function collectGaps() {
  const gaps = {};
  if (!fs.existsSync(CLIENTS_DIR)) return gaps;
  for (const f of fs.readdirSync(CLIENTS_DIR).filter((n) => n.endsWith('.personalities.json'))) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, f), 'utf8'));
    } catch (e) {
      gaps[`${f}::<parse-error>`] = { en: [`JSON parse failed: ${e.message}`] };
      continue;
    }
    const dicts = {};
    findLangDicts(data, '', dicts);
    for (const [dp, dict] of Object.entries(dicts)) {
      if (!dict.en) continue; // need an English reference to diff against
      const enKeys = new Set(Object.keys(dict.en));
      for (const lang of Object.keys(dict)) {
        if (lang === 'en' || !LANGS.has(lang)) continue;
        const have = new Set(Object.keys(dict[lang]));
        const missing = [...enKeys].filter((k) => !have.has(k)).sort();
        if (missing.length) ((gaps[`${f}::${dp}`] ||= {})[lang] = missing);
      }
    }
  }
  return gaps;
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { return null; }
}

function main() {
  const gaps = collectGaps();
  const totalMissing = Object.values(gaps).reduce(
    (a, byLang) => a + Object.values(byLang).reduce((b, arr) => b + arr.length, 0), 0);

  if (update) {
    fs.writeFileSync(BASELINE, JSON.stringify(gaps, null, 2) + '\n');
    console.log(`✓ i18n baseline updated: ${Object.keys(gaps).length} dict(s), ${totalMissing} accepted gap(s) → ${path.relative(ROOT, BASELINE)}`);
    return process.exit(0);
  }

  if (reportOnly) {
    console.log(`i18n guest-copy debt report — ${totalMissing} missing translation key(s):`);
    for (const [loc, byLang] of Object.entries(gaps))
      for (const [lang, keys] of Object.entries(byLang))
        console.log(`  ${loc} [${lang}] missing ${keys.length}: ${keys.join(', ')}`);
    return process.exit(0);
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error('✗ i18n: no baseline found. Run: node scripts/check-i18n-guest-copy.js --update-baseline');
    return process.exit(1);
  }

  // NEW gap = a missing key now that the baseline did not already accept.
  const newGaps = [];
  const closed = [];
  for (const [loc, byLang] of Object.entries(gaps)) {
    for (const [lang, keys] of Object.entries(byLang)) {
      const accepted = new Set(((baseline[loc] || {})[lang]) || []);
      for (const k of keys) if (!accepted.has(k)) newGaps.push(`${loc} [${lang}] ${k}`);
    }
  }
  // CLOSED = baselined gap that's now translated (good — baseline should shrink).
  for (const [loc, byLang] of Object.entries(baseline)) {
    for (const [lang, keys] of Object.entries(byLang)) {
      const current = new Set(((gaps[loc] || {})[lang]) || []);
      for (const k of keys) if (!current.has(k)) closed.push(`${loc} [${lang}] ${k}`);
    }
  }

  console.log(`i18n guest-copy lint: ${totalMissing} known gap(s) baselined; ${newGaps.length} new, ${closed.length} closed.`);
  if (closed.length)
    console.log(`  ✓ ${closed.length} gap(s) now translated — run --update-baseline to ratchet the baseline down.`);
  if (newGaps.length) {
    console.error(`✗ i18n: ${newGaps.length} NEW untranslated key(s) (an en key/dict added without a translation):`);
    for (const g of newGaps.slice(0, 40)) console.error(`    ${g}`);
    return process.exit(1);
  }
  console.log('✓ i18n: no new untranslated keys.');
  return process.exit(0);
}

main();
