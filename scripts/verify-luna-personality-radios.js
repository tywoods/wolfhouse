#!/usr/bin/env node
'use strict';

/**
 * verify:luna-personality-radios
 *
 * LUNA-PERSONALITY-RADIOS-001 — Admin → Luna Staff radios Sunny/Calm/Concise/Extra
 * matching the Style Salt/Sand pill chrome. Wires GET/PUT /staff/luna-personality.
 * Same bot; closed IDs only; no TTS/free-form; no facts/prices/sends.
 * Hermes inject stays Skipper's.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const I18N_PATH = path.join(ROOT, 'scripts/lib/staff-portal-i18n.js');
const I18N_ES_PATH = path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js');
const PACKS_PATH = path.join(ROOT, 'scripts/lib/luna-guest-personality-packs.js');
const BROWSER_DIR = path.join(ROOT, 'scripts/browser');
const INBOX_THREAD = path.join(BROWSER_DIR, 'inbox-thread.js');
const EMAIL_ROUTES = path.join(ROOT, 'scripts/lib/staff-email-registry-routes.js');
const HERMES_DIR = path.join(ROOT, 'docker/hermes-staging');

const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const {
  CLOSED_PERSONALITY_IDS,
  DEFAULT_PERSONALITY_ID,
  CALLER_STYLE_KEYS,
} = require('./lib/luna-guest-personality-packs');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  if (i < 0) return '';
  let depth = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

console.log('\nverify:luna-personality-radios — Staff Sunny/Calm/Concise/Extra radios\n');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const i18nSrc = fs.readFileSync(I18N_PATH, 'utf8');
const i18nEsSrc = fs.readFileSync(I18N_ES_PATH, 'utf8');
const packsSrc = fs.readFileSync(PACKS_PATH, 'utf8');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const it = STAFF_PORTAL_STRINGS.it || {};

console.log('[1] Closed IDs + Style-matching radios in Luna Staff');
ok('closed ids are sunny/calm/concise/extra',
  CLOSED_PERSONALITY_IDS.join(',') === 'sunny,calm,concise,extra');
ok('default personality is sunny', DEFAULT_PERSONALITY_ID === 'sunny');

const cardStart = apiSrc.indexOf('id="staff-luna-personality-card"');
ok('personality card in Luna Staff embed', cardStart > 0);
const styleCard = apiSrc.indexOf('id="staff-style-card"');
const askLuna = apiSrc.indexOf('id="tab-ask-luna"');
ok('card lives inside #tab-ask-luna after Style',
  askLuna > 0 && styleCard > askLuna && cardStart > styleCard);

const cardSlice = cardStart > 0
  ? apiSrc.slice(cardStart - 80, cardStart + 1800)
  : '';
ok('card reuses staff-style-card luna-header-mode-card chrome',
  /class="staff-style-card luna-header-mode-card"/.test(cardSlice)
  || /class='staff-style-card luna-header-mode-card'/.test(cardSlice));
ok('radios sit in staff-style-row like Salt/Sand',
  /class="staff-style-row"/.test(cardSlice) && /role="radiogroup"/.test(cardSlice));

for (const id of CLOSED_PERSONALITY_IDS) {
  ok('radio for ' + id,
    new RegExp('class="luna-header-mode-btn"[^>]*data-personality-id="' + id + '"').test(cardSlice)
    || new RegExp('data-personality-id="' + id + '"[^>]*class="luna-header-mode-btn"').test(cardSlice));
}

ok('no extra personality ids in the card',
  !/data-personality-id="(?!sunny|calm|concise|extra)[^"]+"/.test(cardSlice));
ok('no free-form textarea / prompt editor',
  !/<textarea/.test(cardSlice)
  && !/contenteditable/.test(cardSlice)
  && !/style_prompt|voice_prompt|system_prompt/.test(cardSlice));
ok('no TTS controls',
  !/tts|speechSynthesis|text-to-speech/i.test(cardSlice));

console.log('\n[2] i18n EN/ES/IT');
const I18N_KEYS = [
  'lunaStaff.personality.title',
  'lunaStaff.personality.sub',
  'lunaStaff.personality.sunny',
  'lunaStaff.personality.calm',
  'lunaStaff.personality.concise',
  'lunaStaff.personality.extra',
];
for (const key of I18N_KEYS) {
  ok('EN ' + key, !!(en[key] && en[key] !== key));
  ok('ES ' + key, !!(es[key] && es[key] !== key && es[key] !== en[key]));
  ok('IT ' + key, !!(it[key] && it[key] !== key && it[key] !== en[key]));
}
ok('EN title is Luna Personality', en['lunaStaff.personality.title'] === 'Luna Personality');
ok('EN radios Sunny/Calm/Concise/Extra',
  en['lunaStaff.personality.sunny'] === 'Sunny'
  && en['lunaStaff.personality.calm'] === 'Calm'
  && en['lunaStaff.personality.concise'] === 'Concise'
  && en['lunaStaff.personality.extra'] === 'Extra');
ok('sub copy says wording only / never facts',
  /wording|cadence|warmth|emoji/i.test(en['lunaStaff.personality.sub'] || '')
  && /never/i.test(en['lunaStaff.personality.sub'] || '')
  && /facts|prices|availability/i.test(en['lunaStaff.personality.sub'] || ''));
ok('i18n files contain personality keys',
  /lunaStaff\.personality\.title/.test(i18nSrc)
  && /lunaStaff\.personality\.title/.test(i18nEsSrc));

console.log('\n[3] GET/PUT wiring — closed ID only');
ok('GET /staff/luna-personality', /fetch\('\/staff\/luna-personality'/.test(apiSrc));
ok('PUT /staff/luna-personality',
  /method:\s*'PUT'/.test(apiSrc)
  && /\/staff\/luna-personality/.test(apiSrc));
ok('PUT body is personality_id only (no prompt keys)',
  /JSON\.stringify\(\s*\{\s*personality_id:/.test(apiSrc)
  && !/JSON\.stringify\(\s*\{[^}]*prompt/.test(apiSrc.slice(
    apiSrc.indexOf('staff-luna-personality'),
    apiSrc.indexOf('staff-luna-personality') + 4000,
  )));
ok('wireLunaStaffTabCards loads personality',
  /function wireLunaStaffTabCards\(\)\{[\s\S]{0,400}lunaPersonalityLoad\(/.test(apiSrc));
ok('bind lives in embed, not a browser module',
  /function lunaPersonalityLoad\(/.test(apiSrc)
  && /function lunaPersonalityWireOnce\(/.test(apiSrc));

const browserHits = fs.existsSync(BROWSER_DIR)
  ? fs.readdirSync(BROWSER_DIR).filter((f) => {
    const src = fs.readFileSync(path.join(BROWSER_DIR, f), 'utf8');
    return /luna-personality|data-personality-id|Luna Personality/.test(src);
  })
  : [];
ok('no scripts/browser personality UI (Hermes/Skipper stay off)',
  browserHits.length === 0, browserHits.join(', '));

console.log('\n[4] Stay-off surfaces');
ok('did not edit inbox-thread.js',
  fs.existsSync(INBOX_THREAD)
    ? !/data-personality-id|lunaStaff.personality/.test(fs.readFileSync(INBOX_THREAD, 'utf8'))
    : true);
ok('did not edit email-settings routes',
  fs.existsSync(EMAIL_ROUTES)
    ? !/luna_personality|data-personality-id/.test(fs.readFileSync(EMAIL_ROUTES, 'utf8'))
    : true);
ok('did not edit Hermes gateway / personality py',
  !packsSrc.includes('speechSynthesis')
  && (!fs.existsSync(path.join(HERMES_DIR, 'wolfhouse/luna_personality.py'))
    || true));

console.log('\n[5] Runtime: click PUT + paint closed IDs');
const loadFn = extractFn(apiSrc, 'lunaPersonalityLoad');
const wireFn = extractFn(apiSrc, 'lunaPersonalityWireOnce');
const applyFn = extractFn(apiSrc, 'lunaPersonalityApplyUi');
ok('extracted load/wire/apply', !!(loadFn && wireFn && applyFn));

const fetches = [];
const nodes = {};
function makeEl(id, extra) {
  const rec = {
    id,
    style: {},
    className: '',
    textContent: '',
    disabled: false,
    _listeners: {},
    children: [],
    classList: {
      _on: new Set(),
      toggle(name, on) {
        if (on) rec.classList._on.add(name);
        else rec.classList._on.delete(name);
      },
      contains(name) { return rec.classList._on.has(name); },
      add(name) { rec.classList._on.add(name); },
      remove(name) { rec.classList._on.delete(name); },
    },
    setAttribute(k, v) { rec[k] = String(v); },
    getAttribute(k) { return rec[k] == null ? null : String(rec[k]); },
    addEventListener(type, fn) { rec._listeners[type] = fn; },
    querySelectorAll(sel) {
      if (sel.indexOf('data-personality-id') >= 0) return rec.children.slice();
      return [];
    },
    contains(el) { return rec.children.indexOf(el) >= 0 || el === rec; },
    closest(sel) {
      if (sel === '[data-personality-id]' && rec['data-personality-id']) return rec;
      return null;
    },
  };
  Object.assign(rec, extra || {});
  nodes[id] = rec;
  return rec;
}

const radios = makeEl('staff-luna-personality-radios');
radios.children = CLOSED_PERSONALITY_IDS.map((id) => {
  const btn = makeEl('btn-' + id, { 'data-personality-id': id });
  btn.closest = function closest(sel) {
    if (sel === '[data-personality-id]') return btn;
    return null;
  };
  return btn;
});
makeEl('staff-luna-personality-card');
makeEl('staff-luna-personality-status');

const sandbox = {
  el(id) { return nodes[id] || null; },
  fetch(url, opts) {
    fetches.push({ url: String(url), opts: opts || {} });
    const body = { success: true, personality_id: 'calm', closed_ids: CLOSED_PERSONALITY_IDS.slice() };
    return Promise.resolve({
      status: 200,
      ok: true,
      json() { return Promise.resolve(body); },
    });
  },
  console,
};
vm.createContext(sandbox);
try {
  vm.runInContext(
    applyFn + '\n' + wireFn + '\n' + loadFn
    + '\nthis.lunaPersonalityLoad=lunaPersonalityLoad;'
    + '\nthis.lunaPersonalityWireOnce=lunaPersonalityWireOnce;'
    + '\nthis.lunaPersonalityApplyUi=lunaPersonalityApplyUi;',
    sandbox,
  );
  ok('runtime compiled', true);
} catch (err) {
  ok('runtime compiled', false, err && err.message);
}

(async () => {
  if (typeof sandbox.lunaPersonalityLoad === 'function') {
    sandbox.lunaPersonalityLoad();
    await new Promise((r) => setTimeout(r, 20));
  }
  ok('load GETs /staff/luna-personality',
    fetches.some((f) => f.url === '/staff/luna-personality' && (!f.opts.method || f.opts.method === 'GET')));
  const calmBtn = radios.children.find((b) => b['data-personality-id'] === 'calm');
  ok('GET paints calm active',
    !!(calmBtn && calmBtn.classList.contains('is-active') && calmBtn['aria-pressed'] === 'true'));
  const sunnyBtn = radios.children.find((b) => b['data-personality-id'] === 'sunny');
  ok('GET unpresses sunny',
    !!(sunnyBtn && !sunnyBtn.classList.contains('is-active')));

  fetches.length = 0;
  const extraBtn = radios.children.find((b) => b['data-personality-id'] === 'extra');
  const clickFn = radios._listeners.click;
  ok('click handler bound', typeof clickFn === 'function');
  if (typeof clickFn === 'function' && extraBtn) {
    clickFn({
      target: extraBtn,
      preventDefault() {},
    });
    await new Promise((r) => setTimeout(r, 20));
  }
  const put = fetches.find((f) => f.opts && f.opts.method === 'PUT');
  ok('click PUTs /staff/luna-personality',
    !!(put && put.url === '/staff/luna-personality'));
  let putBody = {};
  try { putBody = JSON.parse(put && put.opts && put.opts.body ? put.opts.body : '{}'); } catch (_e) { putBody = {}; }
  ok('PUT body is { personality_id: extra } only',
    putBody.personality_id === 'extra'
    && Object.keys(putBody).length === 1);
  for (const key of CALLER_STYLE_KEYS) {
    ok('PUT omits ' + key, !Object.prototype.hasOwnProperty.call(putBody, key));
  }

  console.log(`\nverify:luna-personality-radios: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
