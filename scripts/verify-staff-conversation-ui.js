/**
 * Stage 7.7f — Static verifier for the Cami dashboard conversation UI
 * embedded in scripts/staff-query-api.js (buildUiHtml).
 *
 * Checks (77 total, updated Stage 8.3y — Needs Human two-column layout):
 *   1–3:   File exists, readable, passes node --check
 *   4–6:   Dashboard branding / banner
 *   7–9:   Two-tab structure (Conversations + Query Tools)
 *  10–12:  Inbox section elements
 *   13:    fetch('/staff/conversations') call present
 *   14:    Detail pane present
 *   15:    Back-to-inbox button removed (new two-column layout)
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
 *   47:    Handoff queue list element present (handoff-card / hq-list) [updated 8.3y]
 *   48:    fetch('/staff/handoffs') call present
 *   49:    Needs Human empty state message updated [updated 8.3y]
 *   50:    READ-ONLY HANDOFF QUEUE label present
 *   51:    Resolve disabled notice present in handoff queue UI
 *   52:    timeSince / time-since-open rendering logic present
 *   53:    Today / Needs Attention panel present
 *   54:    Inbox label present as tab button
 *   55:    Developer Tools tab present (Query Tools moved to admin/dev-only)
 *   56:    Shadow Mode badge present in Today panel
 *   57:    loadTodaySummary function present
 *   58:    No POST/PATCH/DELETE fetch added for new Today/nav UI
 *   59:    switchToTab utility function present
 *  --- Stage 8.3x: WhatsApp-style inbox layout ---
 *   60:    Inbox two-column layout CSS present (.inbox-two-col)
 *   61:    Conversation card list present (conv-card / conv-list)
 *   62:    handoffLabel() function present
 *   63:    date_change_requested raw code NOT in normal UI template (hidden by handoffLabel)
 *   64:    "Message thread" count title removed
 *   65:    Raw stage display removed from detail header
 *   66:    Friendly handoff label used in renderInbox (handoffLabel call)
 *  --- Stage 8.3y: Needs Human two-column layout + detail cleanup ---
 *   67:    Needs Human two-column layout elements (hq-right / hq-list / hq-detail-content)
 *   68:    Needs Human uses conv-card layout via renderHandoffQueue
 *   69:    handoffLabel() reused in renderHandoffQueue (Needs Human friendly labels)
 *   70:    reason_code not directly passed to escHtml in list templates
 *   71:    "Messages" section title removed from thread area
 *   72:    Booking sidebar card appears before Bot state card
 *   73:    Pending removed from Bot state
 *   74:    Last reply removed from Bot state
 *   75:    Check-in/Check-out on same line (Stay / fmtDateOnly)
 *   76:    fmtDateOnly helper present for date-only display
 *   77:    Signout functionality present
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

console.log('\nverify-staff-conversation-ui.js  (Stage 7.7f / 8.3y)\n');

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

function sliceBetween(html, startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker, s >= 0 ? s + 1 : 0);
  return s >= 0 && e > s ? html.slice(s, e) : '';
}

function extractHandlerBlock(full, fnName) {
  const start = full.indexOf(`function ${fnName}`);
  if (start < 0) return '';
  const next = full.indexOf('\nfunction ', start + 12);
  return next > start ? full.slice(start, next) : full.slice(start, start + 8000);
}

const convTabSrc = sliceBetween(htmlSrc, 'id="tab-conversations"', 'id="tab-ask-luna"');
const todayTabSrc = sliceBetween(htmlSrc, 'id="tab-today"', 'id="tab-conversations"');
const convInboxJs = [
  'renderInbox', 'loadConvDetail', 'wireLunaPauseSwitch', 'wireNeedsHumanToggle',
  'wireInboxSendReply', 'performInboxSend', 'wireDeleteConversation',
  'renderInboxBookingStackItemHtml', 'fetchBotPauseState',
].map((n) => extractHandlerBlock(htmlSrc, n)).join('\n');
const todayNavJs = extractHandlerBlock(htmlSrc, 'loadTodaySummary') +
  extractHandlerBlock(htmlSrc, 'switchToTab');

// 4. Dashboard branding (UI was renamed from "Cami Dashboard" to "Luna Front Desk" in stage 7.7k)
check(/Luna Front Desk|Cami Dashboard/i.test(htmlSrc), 'Luna Front Desk or Cami Dashboard text in HTML');

// 5. Luna Front Desk branding
check(/Luna Front Desk/i.test(htmlSrc), 'Luna Front Desk text in HTML');

// 6. Legacy top SHADOW MODE strip removed; Luna Front Desk branding kept
check(/Luna Front Desk/i.test(htmlSrc) &&
      !/READ-ONLY.*SHADOW MODE|SHADOW MODE.*READ-ONLY/i.test(
        htmlSrc.slice(0, htmlSrc.indexOf('id="tab-conversations"') >= 0
          ? htmlSrc.indexOf('id="tab-conversations"') : 8000)
      ),
  'Luna Front Desk branding without legacy READ-ONLY / SHADOW MODE top banner');

// 7. Conversations tab button
check(/Conversations/i.test(htmlSrc) && /tab-btn/i.test(htmlSrc),
  'Conversations tab button present');

// 8. Query Tools tab button
check(/Query Tools/i.test(htmlSrc), 'Query Tools tab button present');

// 9. Tab panel structure
check(/tab-panel/i.test(htmlSrc) && /tab-conversations/i.test(htmlSrc),
  'Tab panel structure with conversations panel');

// 10. Inbox card or conv-list element (two-column left panel)
check(/inbox-card|conv-list/i.test(htmlSrc),
  'Inbox left panel element present (inbox-card / conv-list)');

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

// 15. Back-to-inbox button REMOVED (new two-column persistent layout)
check(!/Back to inbox/i.test(htmlSrc) && !/id="btn-back"/.test(htmlSrc),
  'Back-to-inbox button removed (two-column layout has no back navigation)');

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

// 30. Staff-gated Send reply (replaces disabled Approve/Send shadow button)
check(/btn-send-reply|id="btn-send-reply"/.test(htmlSrc) && /performInboxSend/.test(htmlSrc),
  'Send reply button wired via Staff API (replaces disabled Approve/Send)');

// 31. No active fetch call to approve-send endpoint
check(!/fetch\s*\([^)]*approve.send/i.test(htmlSrc) &&
      !/fetch\s*\([^)]*approve_send/i.test(htmlSrc),
  'No active approve-send fetch endpoint call');

// 32. No handoff.resolve UI action
check(!/handoff\.resolve|handoff-resolve/i.test(htmlSrc),
  'No handoff.resolve action in UI');

// 33. Conversation inbox JS has no PATCH/PUT (bed calendar drawer may PATCH elsewhere)
const fetchWriteRe = /fetch\s*\([^,)]+,\s*\{[^}]*method\s*:\s*['"](?:PATCH|PUT)['"]/i;
check(!fetchWriteRe.test(convInboxJs),
  'No PATCH/PUT fetch calls in inbox conversation JS');
check(!/fetch[^)]*manual-bookings\/(create|confirm)/i.test(convTabSrc + convInboxJs),
  'No /manual-bookings/create or /confirm fetch in conversation inbox UI');

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

// 39. Detail view send/review guidance (Staff API gated — legacy READ-ONLY VIEW note hidden)
check(/Edit reply before sending|send_performed|Send blocked|draft-send-status/i.test(htmlSrc),
  'Conversation detail send/review guidance present (Staff API gated)');

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

// 44. Legacy Stage 7.7f dev banner label removed from conversation UI
check(!/Stage 7\.7f/i.test(convTabSrc),
  'Legacy Stage 7.7f banner label removed from conversation UI');

// ── Stage 7.7f — Handoff queue checks ─────────────────────────────────────

// 45. Inbox filter controls (Stage 8.7.13 — no separate Needs Human sub-page)
check(/inbox-filter-btn|data-inbox-filter/i.test(htmlSrc) &&
      /All conversations/i.test(htmlSrc) &&
      /Needs human/i.test(htmlSrc),
  'Inbox filter controls present (All conversations / Needs human) (Stage 8.7.13)');

// 46. No separate Needs Human sub-tab / sub-panel page
check(!/subtab-handoffs|id="hq-list"|id="hq-right"|id="hq-detail-content"/i.test(htmlSrc),
  'Separate Needs Human sub-page removed (no subtab-handoffs / hq-list / hq-right) (Stage 8.7.13)');

// 47. Single conversation list (conv-list) for filtered inbox
check(/id="conv-list"/.test(htmlSrc) && /inbox-two-col/.test(htmlSrc),
  'Needs-human filter uses same inbox-two-col + conv-list layout (Stage 8.7.13)');

// 48. Inbox filters conversations client-side — no separate /staff/handoffs fetch in UI
check(!/fetch\s*\([^)]*\/staff\/handoffs/.test(htmlSrc),
  'No fetch("/staff/handoffs") in inbox UI — filter uses /staff/conversations data (Stage 8.7.13)');

// 49. Needs Human empty state message
check(/No conversations need staff review right now/i.test(htmlSrc),
  'Needs Human empty state message present (Stage 8.7.13)');

// 50. Legacy READ-ONLY HANDOFF QUEUE label removed
check(!/READ-ONLY HANDOFF QUEUE/i.test(convTabSrc),
  'Legacy READ-ONLY HANDOFF QUEUE label removed (Stage 8.7.13+)');

// 51. Legacy resolve-disabled notice removed from inbox filter UI
check(!/Resolve actions are disabled/i.test(convTabSrc),
  'Legacy resolve-disabled notice removed from inbox filter UI');

// 52. Legacy handoff sub-page layout absent (hq-table may remain for message-events tooling)
check(!/id="hq-list"|id="hq-right"|subtab-handoffs/i.test(htmlSrc),
  'Legacy handoff queue sub-page layout absent (Stage 8.7.13)');

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

// 56. Today panel kept without legacy Shadow Mode badge
check(/tab-today/i.test(htmlSrc) && !/Shadow Mode.*active|Read-only.*Shadow Mode/i.test(todayTabSrc),
  'Today panel present without legacy Shadow Mode badge (Stage 8.2+)');

// 57. loadTodaySummary function present
check(/loadTodaySummary/i.test(htmlSrc),
  'loadTodaySummary function present (Stage 8.2)');

// 58. Today/nav helpers stay read-only; conversation inbox may DELETE via gated API
check(!/fetch\s*\([^,)]+,\s*\{[^}]*method\s*:\s*['"](?:PATCH|DELETE)['"]/i.test(todayNavJs),
  'No PATCH/DELETE fetch in Today/nav helpers (Stage 8.2 / 8.3l)');
check(!/fetch[^)]*manual-bookings\/(create|confirm)/i.test(convTabSrc + convInboxJs + todayNavJs),
  'No manual-bookings create/confirm in conversation/today UI slices');

// 59. switchToTab utility function present
check(/switchToTab/i.test(htmlSrc),
  'switchToTab navigation utility present (Stage 8.2)');

// ── Stage 8.3x — WhatsApp-style inbox layout ──────────────────────────────

// 60. Inbox two-column layout CSS present
check(/inbox-two-col/i.test(htmlSrc),
  'Inbox two-column layout CSS present (.inbox-two-col) (Stage 8.3x)');

// 61. Conversation card list elements present
check(/conv-card|conv-list/i.test(htmlSrc),
  'Conversation card list elements present (conv-card / conv-list) (Stage 8.3x)');

// 62. handoffLabel function present
check(/function handoffLabel/.test(htmlSrc),
  'handoffLabel() friendly text formatter function present (Stage 8.3x)');

// 63. date_change_requested raw code NOT shown directly in normal UI template
// (it should only appear inside handoffLabel's lookup table, not in escHtml template output)
check(!/escHtml.*date_change_requested|date_change_requested.*escHtml/i.test(htmlSrc),
  'date_change_requested raw code not exposed via escHtml in UI template (Stage 8.3x)');

// 64. "Message thread" count title removed from thread section
check(!/Message thread.*messages|message.*span.*font-weight.*400.*color.*#9aabb8/i.test(htmlSrc),
  '"Message thread — N messages" count title removed from detail view (Stage 8.3x)');

// 65. Raw stage display removed from detail header meta line
check(!/Stage:.*escHtml.*conversation_stage|conversation_stage.*Stage:/i.test(htmlSrc),
  'Raw stage display removed from detail header meta (Stage 8.3x)');

// 66. handoffLabel() called in renderInbox for friendly handoff display
check(/handoffLabel\s*\(/.test(htmlSrc),
  'handoffLabel() called in renderInbox for friendly handoff text (Stage 8.3x)');

// ── Stage 8.3y — Needs Human two-column + detail cleanup ─────────────────

// 67. Single Inbox two-column layout (no duplicate hq-right panel)
check(/inbox-two-col/.test(htmlSrc) && /id="conv-detail"/.test(htmlSrc) &&
      !/id="hq-right"|id="hq-detail-content"/i.test(htmlSrc),
  'Single inbox-two-col layout — no duplicate Needs Human right panel (Stage 8.7.13)');

// 68. setInboxFilter + conversationNeedsHuman filter helpers present
check(/function setInboxFilter/.test(htmlSrc) && /function conversationNeedsHuman/.test(htmlSrc),
  'setInboxFilter() and conversationNeedsHuman() present (Stage 8.7.13)');

// 69. Needs Human filter reuses renderInbox + handoffLabel (not separate renderHandoffQueue page)
check(!/function renderHandoffQueue/.test(htmlSrc) &&
      /function renderInbox/.test(htmlSrc) && /handoffLabel\s*\(/.test(htmlSrc),
  'Needs Human filter uses renderInbox + handoffLabel (no renderHandoffQueue page) (Stage 8.7.13)');

// 70. reason_code not directly passed to escHtml in list templates (goes via handoffLabel)
check(!/escHtml\s*\(\s*[a-z]+\.reason_code/i.test(htmlSrc),
  'reason_code not directly passed to escHtml in list template (Stage 8.3y)');

// 71. "Messages" section title removed from thread area
check(!/'<h3>Messages<\/h3>'/.test(htmlSrc) &&
      !/html\s*\+=\s*'<h3>Messages<\/h3>'/.test(htmlSrc),
  '"Messages" section title removed from thread area (Stage 8.3y)');

// 72. Bot state sidebar card appears before Bookings stack
const bookingsIdx = htmlSrc.indexOf("'<h3>Bookings</h3>'");
const botIdx     = htmlSrc.indexOf("'<h3>Bot state</h3>'");
check(bookingsIdx !== -1 && botIdx !== -1 && botIdx < bookingsIdx,
  'Bot state sidebar card rendered before Bookings stack');

// 72b. Multiple bookings stack support
check(/inbox-booking-stack/.test(htmlSrc) && /renderInboxBookingStackItemHtml/.test(htmlSrc),
  'Inbox sidebar stacks multiple guest bookings');
check(/ctxData\.bookings/.test(htmlSrc),
  'Inbox detail uses bookings array from context API');

// 73. Pending row removed from Bot state
check(!/kv\s*\(\s*['"]Pending['"]/i.test(htmlSrc),
  'Pending row removed from Bot state sidebar (Stage 8.3y)');

// 74. Last reply row removed from Bot state
check(!/kv\s*\(\s*['"]Last reply['"]/i.test(htmlSrc),
  'Last reply row removed from Bot state sidebar (Stage 8.3y)');

// 75. Check-in and Check-out on same line using fmtDateOnly
check(/kv\s*\(\s*['"]Stay['"]/.test(htmlSrc) || /fmtDateOnly.*fmtDateOnly/.test(htmlSrc),
  'Check-in/Check-out combined on one line (Stay row / fmtDateOnly) (Stage 8.3y)');

// 76. fmtDateOnly helper function present
check(/function fmtDateOnly/.test(htmlSrc),
  'fmtDateOnly() date-only formatter present (Stage 8.3y)');

// 77. Signout functionality present
check(/signout|logout|sign-out|log-out/i.test(htmlSrc),
  'Signout functionality present (Stage 8.3y)');

// ── Stage 8.7.13 — Needs Human as Inbox filter ────────────────────────────

// 78. Today Needs Human tile applies inbox filter (not separate page reload)
check(/switchToTab\s*\(\s*['"]conversations['"]\s*,\s*['"]handoffs['"]\s*\)/.test(htmlSrc) &&
      /setInboxFilter\s*\(\s*['"]needs-human['"]\s*\)/.test(htmlSrc),
  'Today Needs Human → switchToTab + setInboxFilter(needs-human) (Stage 8.7.13)');

// 79. Auto-select top conversation after inbox render
check(/Auto-select top conversation|pickId|convs\[0\]\.conversation_id/.test(htmlSrc),
  'Top conversation auto-select logic in renderInbox (Stage 8.7.13)');

// 80. Inbox Luna pause toggle (Phase 9.5b — server-gated via BOT_PAUSE_CONTROLS)
check(/luna-pause-switch|Pause Luna/.test(htmlSrc) && /wireLunaPauseSwitch/.test(htmlSrc),
  'Inbox Luna pause toggle present (Phase 9.5b — server-gated)');

// ── Phase 9.3 / 9.5 — Inbox Luna pause status + Staff API wiring ─────────

// 82. Luna automation status display + pause/resume via Staff API
check(/Luna active/.test(htmlSrc) && /Luna paused/.test(htmlSrc),
  'Luna active/paused status strings present (Phase 9.3)');
check(/function isLunaGuestAutomationPaused/.test(htmlSrc),
  'isLunaGuestAutomationPaused() helper present (Phase 9.3)');
check(/Automation status: active/.test(htmlSrc),
  'Active automation helper copy present (Phase 9.3)');
check(/fetch\([^)]*\/staff\/bot\/pause-state/i.test(htmlSrc),
  'Read-only pause lookup via GET /staff/bot/pause-state (Phase 9.5)');
check(/fetch\([^)]*\/staff\/bot\/pause|fetch\([^)]*\/staff\/bot\/resume/i.test(convInboxJs),
  'Pause/resume POST routed via Staff API (Phase 9.5b)');
check(/bot_pause_controls_disabled|Pause controls are disabled/.test(convInboxJs),
  'Pause UI handles disabled gate when BOT_PAUSE_CONTROLS off');
check(/\/staff\/inbox\/send-reply/.test(convInboxJs),
  'Staff reply send uses /staff/inbox/send-reply (gated — not raw WhatsApp URL)');
check(/wireDeleteConversation/.test(htmlSrc) && /needs-human/.test(convInboxJs),
  'Allowed gated conversation writes: needs-human toggle + delete conversation');

// 81. Safety — no WhatsApp / n8n / Stripe in conversation UI
check(!/graph\.facebook\.com/.test(htmlSrc),
  'Conversation UI has no graph.facebook.com (Stage 8.7.13)');
check(!/api\.stripe\.com/.test(htmlSrc),
  'Conversation UI has no api.stripe.com (Stage 8.7.13)');
check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(htmlSrc)),
  'Conversation UI has no n8n URL fetch (Stage 8.7.13)');

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
