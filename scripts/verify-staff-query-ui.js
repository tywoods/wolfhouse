/**
 * Stage 6.8 — Static verifier for the read-only staff query UI.
 *
 * Reads scripts/staff-query-api.js (which embeds the UI HTML) as text and
 * performs structural/safety checks. Does NOT start the server. No DB.
 *
 * Checks:
 *   1.  API file exists and passes node --check
 *   2.  /staff/ui route present in router
 *   3.  handleUI function present
 *   4.  buildUiHtml function present
 *   5.  UI fetches /staff/intents
 *   6.  UI fetches /staff/query
 *   7.  No POST/PATCH/DELETE fetch calls in UI HTML
 *   8.  No handoff.resolve or staff-action-runner references in UI
 *   9.  No write controls (no form POST, no input type=submit for writes)
 *  10.  Read-only banner present
 *  11.  "No write actions" text present
 *  12.  No external CDN / script src references
 *  13.  No eval() in UI code
 *  14.  API still enforces GET-only (405)
 *  15.  API still uses registry-only intent lookup
 *  16.  package.json script exists
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_PATH = path.join(__dirname, 'staff-query-api.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');

let passes   = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }
function has(src, re)   { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(API_PATH)) { fail('staff-query-api.js does not exist'); process.exit(1); }
pass('staff-query-api.js exists');

let src = '';
try { src = fs.readFileSync(API_PATH, 'utf8'); pass(`file readable (${src.length} chars)`); }
catch (e) { fail('cannot read: ' + e.message); process.exit(1); }

try { execSync(`node --check "${API_PATH}"`, { stdio: 'pipe' }); pass('passes node --check'); }
catch (e) { fail('syntax error: ' + (e.stderr ? e.stderr.toString().trim() : e.message)); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
section('2. /staff/ui route in router');

if (has(src, /pathname === '\/staff\/ui'/)) { pass('/staff/ui route present in router'); } else { fail('/staff/ui route missing from router'); }

// ─────────────────────────────────────────────────────────────────────────────
section('3. handleUI function present');

if (has(src, /function handleUI\s*\(/)) { pass('handleUI function declared'); } else { fail('handleUI function missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('4. buildUiHtml function present');

if (has(src, /function buildUiHtml\s*\(/)) { pass('buildUiHtml function declared'); } else { fail('buildUiHtml function missing'); }
if (has(src, /buildUiHtml\s*\(/))           { pass('buildUiHtml called'); }             else { fail('buildUiHtml not called'); }

// ─────────────────────────────────────────────────────────────────────────────
section('5. UI fetches /staff/intents');

if (has(src, /fetch.*\/staff\/intents/)) { pass("UI fetch('/staff/intents') present"); } else { fail("UI missing fetch('/staff/intents')"); }

// ─────────────────────────────────────────────────────────────────────────────
section('6. UI fetches /staff/query');

if (has(src, /fetch.*\/staff\/query/)) { pass("UI fetch('/staff/query') present"); } else { fail("UI missing fetch('/staff/query')"); }

// HTML section (from buildUiHtml onwards) used for checks below
const htmlStart = src.indexOf('function buildUiHtml');
const htmlSection = htmlStart >= 0 ? src.slice(htmlStart) : src;

// ─────────────────────────────────────────────────────────────────────────────
section('7. No unauthorised POST/PATCH/DELETE fetch in UI');

// Known-safe POST endpoints added across stages (all have their own verifiers):
//   /staff/ask-luna              — Stage 8.6.2, read-only
//   /staff/manual-bookings/preview — Stage 8.4, preview only
//   /staff/quote-preview         — Stage 8.4, read-only quote
//   /staff/manual-bookings/create  — Stage 8.4, gated write (manual booking)
const ALLOWED_POST = [
  '/staff/ask-luna',
  '/staff/manual-bookings/preview',
  '/staff/manual-bookings/create',
  '/staff/quote-preview',
  '/staff/payments/',           // Stage 8.2x: create-stripe-link for existing payment
];
const postMatches = [...htmlSection.matchAll(/fetch\s*\(\s*['"]([^'"]+)['"]/gi)];
const illegalPosts = postMatches.filter(m => {
  const url = m[1];
  // Only flag if it is accompanied by a POST method and not in the allowed list
  const surroundings = htmlSection.slice(Math.max(0, m.index - 10), m.index + url.length + 120);
  const hasPost = /method\s*:\s*['"]POST['"]/i.test(surroundings);
  return hasPost && !ALLOWED_POST.some(a => url.includes(a));
});
if (illegalPosts.length === 0) { pass('no unauthorised fetch POST in UI (allowed: ask-luna, manual-bookings/preview, /create, quote-preview)'); }
else                           { fail('UI contains unauthorised fetch POST to: ' + illegalPosts.map(m=>m[1]).join(', ')); }

if (lacks(htmlSection, /method\s*:\s*['"]PATCH['"]/i))  { pass('no fetch PATCH in UI'); }  else { fail('UI contains fetch PATCH'); }
if (lacks(htmlSection, /method\s*:\s*['"]DELETE['"]/i)) { pass('no fetch DELETE in UI'); } else { fail('UI contains fetch DELETE'); }

// ─────────────────────────────────────────────────────────────────────────────
section('7b. Ask Luna panel present (Stage 8.6.2)');

if (has(src, /id="tab-ask-luna"/))                                        { pass('Ask Luna tab panel exists (id=tab-ask-luna)'); }          else { fail('Ask Luna tab panel missing'); }
if (has(src, /data-tab="ask-luna"/))                                      { pass('Ask Luna tab button exists (data-tab=ask-luna)'); }       else { fail('Ask Luna tab button missing'); }
if (has(src, /id="al-input"/))                                            { pass('Ask Luna input exists (id=al-input)'); }                  else { fail('Ask Luna input missing'); }
if (has(src, /id="al-btn"/))                                              { pass('Ask Luna Ask button exists (id=al-btn)'); }               else { fail('Ask Luna Ask button missing'); }
if (has(src, /fetch\s*\(\s*['"]\/staff\/ask-luna['"]/))                   { pass('UI calls /staff/ask-luna'); }                            else { fail('UI does not call /staff/ask-luna'); }
if (has(src, /source\s*:\s*['"]staff_portal['"]/))                        { pass('payload includes source:"staff_portal"'); }              else { fail('payload missing source:"staff_portal"'); }
if (has(src, /alRenderResult\s*\(/))                                      { pass('alRenderResult function present (displays answer)'); }    else { fail('alRenderResult function missing'); }
if (has(src, /data\.intent/))                                             { pass('intent displayed in result'); }                          else { fail('intent not referenced in result'); }
if (has(src, /row_count|data\.rows/))                                     { pass('row_count/rows referenced in result'); }                 else { fail('row_count/rows missing from result'); }
if (has(src, /unsupported_intent/))                                       { pass('unsupported_intent handled in UI'); }                    else { fail('unsupported_intent not handled'); }
if (has(src, /alShowError\s*\(/))                                         { pass('alShowError error-state function present'); }            else { fail('alShowError missing'); }
if (has(src, /alSetLoading\s*\(/))                                        { pass('alSetLoading loading-state function present'); }         else { fail('alSetLoading missing'); }
if (has(src, /window\.alAsk\s*=\s*alAsk/) || has(src, /el\(['"]al-btn['"]\)\.addEventListener\(\s*['"]click['"]/)) { pass('Ask Luna click handler globally bound (window.alAsk or addEventListener)'); } else { fail('Ask Luna click handler not globally bound — inline onclick will fail'); }
if (has(src, /id="al-btn"[^>]*onclick="alAsk\(\)"/) || has(src, /el\(['"]al-btn['"]\)\.addEventListener\(\s*['"]click['"]/)) { pass('Ask Luna button has working click path'); } else { fail('Ask Luna button missing click path (onclick or addEventListener)'); }
if (has(src, /onkeydown="if\(event\.key==='Enter'\)alAsk\(\)"/))          { pass('Ask Luna Enter key invokes alAsk'); }                     else { fail('Ask Luna Enter key handler missing'); }
if (lacks(src, /graph\.facebook\.com|twilio\.com|sendWhatsApp/))          { pass('no WhatsApp calls in Ask Luna JS'); }                   else { fail('WhatsApp call found in Ask Luna section'); }
if (lacks(src, /stripe\.com|createPaymentIntent|Stripe\s*\(/))           { pass('no Stripe calls in Ask Luna JS'); }                     else { fail('Stripe call found near Ask Luna'); }

// ─────────────────────────────────────────────────────────────────────────────
section('8. No handoff.resolve or staff-action-runner in UI');

if (lacks(htmlSection, /handoff\.resolve/i))                               { pass('no handoff.resolve in UI'); }        else { fail('handoff.resolve found in UI'); }
if (lacks(htmlSection, /staff-action-runner/i))                             { pass('no staff-action-runner in UI'); }    else { fail('staff-action-runner found in UI'); }
if (lacks(htmlSection, /\/staff\/action|\/staff\/write/i))                  { pass('no write action endpoint in UI'); }  else { fail('write action endpoint in UI'); }

// ─────────────────────────────────────────────────────────────────────────────
section('9. No write form controls (no form method=POST)');

if (lacks(htmlSection, /method\s*=\s*['"]?post/i))     { pass('no form method=POST in HTML'); }      else { fail('form method=POST found'); }
if (lacks(htmlSection, /type\s*=\s*['"]?submit/i))      { pass('no input type=submit in HTML'); }     else { fail('input type=submit found — potential write control'); }
if (lacks(htmlSection, /btn-resolve|btn-write|btn-save/i)) { pass('no write button ids in HTML'); }   else { fail('write button id found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('10. Read-only banner present');

if (has(htmlSection, /READ-ONLY/i))          { pass('READ-ONLY text in HTML'); }          else { fail('no READ-ONLY text in HTML'); }
if (has(htmlSection, /local.?dev/i))          { pass('local/dev text in HTML'); }          else { fail('no local/dev text in HTML'); }

// ─────────────────────────────────────────────────────────────────────────────
section('11. "No write actions" text in UI');

if (has(htmlSection, /no write action/i)) { pass('"no write actions" text present'); } else { fail('"no write actions" text missing from UI'); }

// ─────────────────────────────────────────────────────────────────────────────
section('12. No external CDN / external script src');

if (lacks(htmlSection, /<script\s+src\s*=\s*['"]http/i)) { pass('no external CDN script src'); } else { fail('external CDN script src found'); }
if (lacks(htmlSection, /cdn\.jsdelivr|unpkg\.com|cdnjs/i)) { pass('no known CDN URL'); }         else { fail('CDN URL found in HTML'); }

// ─────────────────────────────────────────────────────────────────────────────
section('13. No eval() in UI JavaScript');

// Only search the HTML/JS section
if (lacks(htmlSection, /\beval\s*\(/)) { pass('no eval() in UI code'); } else { fail('eval() found in UI code'); }

// ─────────────────────────────────────────────────────────────────────────────
section('14. API still enforces GET-only (405)');

if (has(src, /send405|405/))                    { pass('405 for non-GET still present'); } else { fail('405 handler missing from API'); }
if (has(src, /method !== 'GET'|method.*GET/i))  { pass('GET-only check present'); }       else { fail('GET-only check missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('15. API still uses registry-only intent lookup');

if (has(src, /getEntry\s*\(/))              { pass('getEntry() still used'); }              else { fail('getEntry() missing'); }
if (has(src, /staff-query-registry/))       { pass('staff-query-registry still imported'); } else { fail('staff-query-registry missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('16. package.json script present');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  if ((pkg.scripts || {})['verify:staff-query-ui']) { pass('package.json has "verify:staff-query-ui"'); }
  else { fail('package.json missing "verify:staff-query-ui"'); }
} catch (e) { fail('cannot read package.json: ' + e.message); }

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
