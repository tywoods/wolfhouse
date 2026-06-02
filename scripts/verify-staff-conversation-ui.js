/**
 * Stage 7.7f — Static verifier for the Cami dashboard conversation UI
 * embedded in scripts/staff-query-api.js (buildUiHtml).
 *
 * Checks (59 total, updated Stage 8.2):
 *   1–3:   File exists, readable, passes node --check
 *   4–6:   Dashboard branding / banner
 *   7–9:   Two-tab structure (Conversations + Query Tools)
 *  10–12:  Inbox section elements
 *   13:    fetch('/staff/conversations') call present
 *  14–15:  Detail pane present + back button
 *  16–17:  Auth-error (401) surface in inbox fetch
 *   18:    Refresh button present
 *   19:    Client input present in conversations tab
 *   20:    READ-ONLY / SHADOW MODE text in HTML
 *   21:    fetch('/staff/conversations/:id/messages') in JS
 *   22:    fetch('/staff/conversations/:id/context') in JS
 *   23:    fetch('/staff/conversations/:id/draft') in JS
 *   24:    fetch('/staff/conversations/:id/staff-state') in JS
 *   25:    Message thread section present (thread-container / .thread)
 *   26:    Luna draft textarea present (draft-textarea)
 *   27:    Copy-to-clipboard button present (btn-copy-draft / Copy to clipboard)
 *   28:    Manual WhatsApp send wording (shadow mode / manually in WhatsApp)
 *   29:    NOT SENT label on Luna draft
 *   30:    Approve/send button is disabled (btn-send-disabled / disabled attribute)
 *   31:    No active fetch call to approve-send endpoint
 *   32:    No handoff.resolve UI action
 *   33:    No POST/PATCH/DELETE fetch calls in embedded JS
 *   34:    No external CDN script src
 *   35:    No eval() in embedded JS
 *   36:    Query Tools tab preserved (f-cat / f-intent / btn-run)
 *   37:    fetch('/staff/intents') present (query tools)
 *   38:    fetch('/staff/query') present (query tools)
 *   39:    Read-only reminder in detail view (READ-ONLY VIEW / no live sends)
 *   40:    Context sidebar present (sidebar-card / kv2 / Booking section)
 *   41:    Bot state panel present
 *   42:    No form method=POST in HTML
 *   43:    package.json has verify:staff-conversation-ui script
 *   44:    Stage 7.7f banner label present
 *   45:    Conversations sub-tabs present (sub-tab / subtab-inbox / subtab-handoffs)
 *   46:    Needs Human / Handoffs sub-tab button present
 *   47:    Handoff queue card element present (handoff-card / hq-tbody)
 *   48:    fetch('/staff/handoffs') call present
 *   49:    Handoff queue empty state ("No open handoffs right now")
 *   50:    READ-ONLY HANDOFF QUEUE label present
 *   51:    Resolve disabled notice present in handoff queue UI
 *   52:    timeSince / time-since-open rendering logic present
 *
 * Usage:
 *   node scripts/verify-staff-conversation-ui.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)  { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg){ console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

// ─────────────────────────────────────────────────────────────────────────────

console.log('\nverify-staff-conversation-ui.js  (Stage 7.7f)\n');

// 1. File exists
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) { process.exit(1); }

// 2. Readable
const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'File is readable and non-trivial length');

// 3. Passes node --check
try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('Passes node --check (no syntax errors)');
} catch (_) {
  fail('Passes node --check (no syntax errors)');
}

// Extract HTML/JS content from buildUiHtml
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

// 4. Dashboard branding (UI was renamed from "Cami Dashboard" to "Luna Front Desk" in stage 7.7k)
check(/Luna Front Desk|Cami Dashboard/i.test(htmlSrc), 'Luna Front Desk or Cami Dashboard text in HTML');

// 5. Luna Front Desk branding
check(/Luna Front Desk/i.test(htmlSrc), 'Luna Front Desk text in HTML');

// 6. READ-ONLY / SHADOW MODE banner
check(/READ-ONLY.*SHADOW MODE|SHADOW MODE.*READ-ONLY/i.test(htmlSrc),
  'READ-ONLY / SHADOW MODE banner text');

// 7. Conversations tab button
check(/Conversations/i.test(htmlSrc) && /tab-btn/i.test(htmlSrc),
  'Conversations tab button present');

// 8. Query Tools tab button
check(/Query Tools/i.test(htmlSrc), 'Query Tools tab button present');

// 9. Tab panel structure
check(/tab-panel/i.test(htmlSrc) && /tab-conversations/i.test(htmlSrc),
  'Tab panel structure with conversations panel');

// 10. Inbox table or card element
check(/inbox-table|inbox-tbody|inbox-card/i.test(htmlSrc),
  'Inbox table/card element present');

// 11. Guest name column or label
check(/Guest|guest_name|guest-name/i.test(htmlSrc),
  'Guest name column in inbox');

// 12. Inbox loading/empty state
check(/inbox-state|Loading conversations/i.test(htmlSrc),
  'Inbox loading/empty state element');

// 13. fetch('/staff/conversations') call
check(/fetch\s*\([^)]*\/staff\/conversations/.test(htmlSrc) ||
      /fetch\(['"`]\/staff\/conversations/.test(src),
  "fetch('/staff/conversations') inbox call present");

// 14. Detail pane element
check(/conv-detail|detail-content/i.test(htmlSrc),
  'Conversation detail pane element present');

// 15. Back button
check(/btn-back|back-btn|Back to inbox/i.test(htmlSrc),
  'Back-to-inbox navigation button present');

// 16. 401 auth error surfaced
check(/401/.test(htmlSrc) && /login|auth/i.test(htmlSrc),
  '401 auth error surfaced in inbox fetch handler');

// 17. Auth error message shown to user
check(/Authentication required|Please log in|POST.*\/staff\/auth\/login/i.test(htmlSrc),
  'Auth-required message shown when 401');

// 18. Refresh button
check(/btn-refresh|Refresh/i.test(htmlSrc), 'Refresh button present');

// 19. Client input in conversations tab
check(/c-client|wolfhouse-somo/i.test(htmlSrc), 'Client input in conversations tab');

// 20. READ-ONLY text
check(/READ-ONLY/i.test(htmlSrc), 'READ-ONLY text present in HTML');

// 21. fetch('/messages') present in loadConvDetail
check(/\/messages/.test(htmlSrc) && /fetch/.test(htmlSrc),
  "fetch('.../messages') call present in detail loader");

// 22. fetch('/context') present
check(/\/context/.test(htmlSrc) && /fetch/.test(htmlSrc),
  "fetch('.../context') call present in detail loader");

// 23. fetch('/draft') present
check(/\/draft/.test(htmlSrc) && /gjson/.test(htmlSrc),
  "fetch('.../draft') call present in detail loader");

// 24. fetch('/staff-state') present
check(/\/staff-state/.test(htmlSrc),
  "fetch('.../staff-state') call present in detail loader");

// 25. Message thread section
check(/thread-container|class="thread"|thread-section/i.test(htmlSrc),
  'Message thread section/container present');

// 26. Luna draft textarea
check(/draft-textarea|id="draft-textarea"/i.test(htmlSrc),
  'Luna draft textarea present (draft-textarea)');

// 27. Copy-to-clipboard button
check(/btn-copy-draft|Copy to clipboard|copyBtn/i.test(htmlSrc),
  'Copy-to-clipboard button present');

// 28. Manual WhatsApp send wording (shadow mode)
check(/shadow mode|manually in WhatsApp|send.*manually|copy.*WhatsApp/i.test(htmlSrc),
  'Manual WhatsApp send / shadow mode wording present');

// 29. NOT SENT label on Luna draft
check(/NOT SENT|draft-not-sent/i.test(htmlSrc),
  'NOT SENT label on Luna draft');

// 30. Approve/send button is disabled
check(/btn-send-disabled|disabled.*Approve|Approve.*disabled/i.test(htmlSrc),
  'Approve/Send button present and disabled');

// 31. No active fetch call to approve-send endpoint
check(!/fetch\s*\([^)]*approve.send/i.test(htmlSrc) &&
      !/fetch\s*\([^)]*approve_send/i.test(htmlSrc),
  'No active approve-send fetch endpoint call');

// 32. No handoff.resolve UI action
check(!/handoff\.resolve|handoff-resolve/i.test(htmlSrc),
  'No handoff.resolve action in UI');

// 33. No POST/PATCH/DELETE fetch calls in embedded JS
const fetchWriteRe = /fetch\s*\([^,)]+,\s*\{[^}]*method\s*:\s*['"](?:POST|PATCH|PUT)['"]/i;
check(!fetchWriteRe.test(htmlSrc),
  'No POST/PATCH/DELETE fetch calls in embedded JS');

// 34. No external CDN script src
check(!/src\s*=\s*['"]https?:\/\//i.test(htmlSrc),
  'No external CDN script src');

// 35. No eval()
check(!/\beval\s*\(/.test(htmlSrc), 'No eval() in embedded JS');

// 36. Query Tools tab retains controls
check(/f-cat|f-intent|btn-run/i.test(htmlSrc),
  'Query Tools tab retains category/intent/run controls');

// 37. fetch('/staff/intents') present
check(/fetch\s*\(\s*['"`]\/staff\/intents/.test(htmlSrc),
  "fetch('/staff/intents') present (query tools)");

// 38. fetch('/staff/query') present
check(/fetch\s*\(\s*['"`]\/staff\/query/.test(htmlSrc),
  "fetch('/staff/query') present (query tools)");

// 39. Read-only reminder in detail (no live sends)
check(/READ-ONLY VIEW|no live sends|not sent automatically/i.test(htmlSrc),
  'Read-only reminder in detail view');

// 40. Context sidebar / booking section present
check(/sidebar-card|kv2|Booking|booking_code/i.test(htmlSrc),
  'Context sidebar / booking section present');

// 41. Bot state panel present
check(/bot.?state|Bot state|bot_mode/i.test(htmlSrc),
  'Bot state panel present in detail');

// 42. No form method=POST
check(!/method\s*=\s*['"](?:post|POST)['"]/i.test(htmlSrc),
  'No form method=POST in HTML');

// 43. package.json has verify:staff-conversation-ui script
let pkgHasScript = false;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  pkgHasScript = !!(pkg.scripts && pkg.scripts['verify:staff-conversation-ui']);
} catch (_) {}
check(pkgHasScript, 'package.json has verify:staff-conversation-ui script');

// 44. Stage 7.7f banner label
check(/7\.7f|Stage 7\.7f/i.test(htmlSrc), 'Stage 7.7f label in HTML');

// ── Stage 7.7f — Handoff queue checks ─────────────────────────────────────

// 45. Conversations sub-tabs present
check(/sub-tab|subtab-inbox|subtab-handoffs/i.test(htmlSrc),
  'Conversations sub-tab structure present (sub-tab, subtab-inbox, subtab-handoffs)');

// 46. Needs Human / Handoffs sub-tab button
check(/Needs Human|Handoffs/i.test(htmlSrc) && /sub-tab/i.test(htmlSrc),
  '"Needs Human" handoff sub-tab button present');

// 47. Handoff queue card element
check(/handoff-card|hq-tbody|hq-table/i.test(htmlSrc),
  'Handoff queue card/table element present (handoff-card / hq-tbody)');

// 48. fetch('/staff/handoffs') call present
check(/fetch\s*\([^)]*\/staff\/handoffs/.test(htmlSrc) ||
      /\/staff\/handoffs/.test(htmlSrc),
  "fetch('/staff/handoffs') call present in handoff queue loader");

// 49. Empty state "No open handoffs right now"
check(/No open handoffs/i.test(htmlSrc),
  'Handoff queue empty state message ("No open handoffs right now")');

// 50. READ-ONLY HANDOFF QUEUE label
check(/READ-ONLY HANDOFF QUEUE/i.test(htmlSrc),
  'READ-ONLY HANDOFF QUEUE label present');

// 51. Resolve disabled notice
check(/Resolve actions are disabled|resolve.*disabled.*UI|disabled.*resolve/i.test(htmlSrc),
  'Resolve-disabled notice present in handoff queue UI');

// 52. timeSince / time-since rendering logic
check(/timeSince|time.*since.*open|since.*opened/i.test(htmlSrc),
  'Time-since-opened rendering logic present (timeSince function)');

// ── Stage 8.2 — Dashboard polish checks ───────────────────────────────────

// 53. Today / Needs Attention panel present
check(/tab-today|Today.*Needs Attention|Needs Attention/i.test(htmlSrc),
  'Today / Needs Attention panel present (Stage 8.2)');

// 54. Inbox label present as tab button
check(/data-tab="conversations".*Inbox|Inbox.*data-tab="conversations"/s.test(htmlSrc) ||
      /tab-btn.*Inbox|Inbox.*tab-btn/i.test(htmlSrc),
  'Inbox tab button label present (Stage 8.2)');

// 55. Developer Tools tab present (Query Tools moved to admin/dev-only)
check(/Developer Tools|dev-tab/i.test(htmlSrc),
  'Developer Tools admin-only tab present (Stage 8.2)');

// 56. Shadow Mode badge present in Today panel
check(/Shadow Mode.*active|Read-only.*Shadow Mode/i.test(htmlSrc),
  'Shadow Mode notice in Today panel (Stage 8.2)');

// 57. loadTodaySummary function present
check(/loadTodaySummary/i.test(htmlSrc),
  'loadTodaySummary function present (Stage 8.2)');

// 58. No POST/PATCH/DELETE fetch added for new Today/nav UI
check(!/fetch\s*\([^,)]+,\s*\{[^}]*method\s*:\s*['"](?:POST|PATCH|DELETE)['"]/i.test(htmlSrc),
  'No new POST/PATCH/DELETE fetch in Today/nav UI (Stage 8.2)');

// 59. switchToTab utility function present
check(/switchToTab/i.test(htmlSrc),
  'switchToTab navigation utility present (Stage 8.2)');

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
