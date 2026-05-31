/**
 * Stage 7.7c — Static verifier for the Cami dashboard conversation inbox UI
 * embedded in scripts/staff-query-api.js (buildUiHtml).
 *
 * Checks (34 total):
 *   1–3:   File exists, readable, passes node --check
 *   4–6:   Dashboard branding / banner
 *   7–9:   Two-tab structure (Conversations + Query Tools)
 *   10–12: Inbox section elements
 *   13:    fetch('/staff/conversations') call present
 *  14–15:  Detail pane present
 *  16–17:  Auth-error (401) surface in inbox fetch
 *  18:     Refresh button present
 *  19:     Client input present in conversations tab
 *  20:     READ-ONLY / SHADOW MODE text in HTML
 *  21:     No reply composer (textarea/contenteditable for sending) in inbox UI
 *  22:     No send button in inbox UI
 *  23:     No approve-send reference
 *  24:     No handoff.resolve UI action
 *  25:     No POST/PATCH/DELETE fetch calls in JS
 *  26:     No external CDN script src
 *  27:     No eval() in JS
 *  28:     Query Tools tab preserved (/staff/intents + /staff/query)
 *  29:     fetch('/staff/intents') present (query tools)
 *  30:     fetch('/staff/query') present (query tools)
 *  31:     DRAFT, NOT SENT label (Luna draft is read-only)
 *  32:     READ-ONLY reminder in detail pane
 *  33:     No form method=POST in HTML
 *  34:     package.json has verify:staff-conversation-ui script
 *
 * Usage:
 *   node scripts/verify-staff-conversation-ui.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE  = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE  = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)  { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg){ console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

// ─────────────────────────────────────────────────────────────────────────────

console.log('\nverify-staff-conversation-ui.js\n');

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

// Extract HTML content from buildUiHtml
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

// 4. Cami Dashboard branding
check(/Cami Dashboard/i.test(htmlSrc), 'Cami Dashboard text in HTML');

// 5. Luna Front Desk branding
check(/Luna Front Desk/i.test(htmlSrc), 'Luna Front Desk text in HTML');

// 6. READ-ONLY / SHADOW MODE banner
check(/READ-ONLY.*SHADOW MODE|SHADOW MODE.*READ-ONLY/i.test(htmlSrc),
  'READ-ONLY / SHADOW MODE banner text');

// 7. Conversations tab button
check(/Conversations/i.test(htmlSrc) && /tab-btn/i.test(htmlSrc),
  'Conversations tab button present');

// 8. Query Tools tab button
check(/Query Tools/i.test(htmlSrc),
  'Query Tools tab button present');

// 9. Tab panel structure
check(/tab-panel/i.test(htmlSrc) && /tab-conversations/i.test(htmlSrc),
  'Tab panel structure with conversations panel');

// 10. Inbox table or list element
check(/inbox-table|inbox-tbody|inbox-card/i.test(htmlSrc),
  'Inbox table/card element present');

// 11. Guest name column or label
check(/Guest|guest_name|guest-name/i.test(htmlSrc),
  'Guest name column in inbox');

// 12. Inbox loading/empty state
check(/inbox-state|Loading conversations/i.test(htmlSrc),
  'Inbox loading/empty state element');

// 13. fetch('/staff/conversations') call
check(/fetch\s*\(\s*['"`]\/staff\/conversations/.test(htmlSrc) ||
      /fetch\s*\(\s*'\/staff\/conversations/.test(htmlSrc) ||
      /fetch\(['"`]\/staff\/conversations/.test(src),
  "fetch('/staff/conversations') call present");

// 14. Detail pane element
check(/conv-detail|detail-content/i.test(htmlSrc),
  'Conversation detail pane element present');

// 15. Back button for detail → inbox navigation
check(/btn-back|back-btn|Back to inbox/i.test(htmlSrc),
  'Back-to-inbox navigation button present');

// 16. 401 auth error surfaced
check(/401/.test(htmlSrc) && /login|auth/i.test(htmlSrc),
  '401 auth error surfaced in inbox fetch handler');

// 17. Auth error message shown to user
check(/Authentication required|Please log in|auth.*login|POST.*\/staff\/auth\/login/i.test(htmlSrc),
  'Auth-required message shown when 401');

// 18. Refresh button
check(/btn-refresh|Refresh/i.test(htmlSrc),
  'Refresh button present');

// 19. Client input in conversations tab
check(/c-client|wolfhouse-somo/i.test(htmlSrc),
  'Client input in conversations tab');

// 20. READ-ONLY text (at least one occurrence)
check(/READ-ONLY/i.test(htmlSrc), 'READ-ONLY text present in HTML');

// 21. No send-oriented textarea/contenteditable (reply composer not in this slice)
// Allow textarea only in query tools; flag if near 'send' or 'reply'
const replyTextareaRe = /(<textarea[^>]*(?:reply|send|compose)[^>]*>|(?:reply|send|compose)[^<]*<textarea)/i;
check(!replyTextareaRe.test(htmlSrc),
  'No reply composer textarea in inbox UI (deferred to Stage 7.7d)');

// 22. No send button in inbox/conversation area
const sendBtnRe = /<button[^>]*>(?:\s*)?(?:Send|Approve\s*&amp;\s*Send|Send reply)[^<]*<\/button>/i;
check(!sendBtnRe.test(htmlSrc),
  'No send/approve-send button in UI');

// 23. No approve-send reference
check(!/approve.send|approve_send/i.test(htmlSrc),
  'No approve-send reference in HTML/JS');

// 24. No handoff.resolve UI action
check(!/handoff\.resolve|handoff-resolve/i.test(htmlSrc),
  'No handoff.resolve action in UI');

// 25. No POST/PATCH/DELETE fetch calls in embedded JS
const fetchWriteRe = /fetch\s*\([^,)]+,\s*\{[^}]*method\s*:\s*['"](?:POST|PATCH|DELETE|PUT)['"]/i;
check(!fetchWriteRe.test(htmlSrc),
  'No POST/PATCH/DELETE fetch calls in embedded JS');

// 26. No external CDN script src
check(!/src\s*=\s*['"]https?:\/\//i.test(htmlSrc),
  'No external CDN script src');

// 27. No eval()
check(!/\beval\s*\(/.test(htmlSrc),
  'No eval() in embedded JS');

// 28. Query Tools tab still has intents and query support
check(/f-cat|f-intent|btn-run/i.test(htmlSrc),
  'Query Tools tab retains category/intent/run controls');

// 29. fetch('/staff/intents') present (query tools)
check(/fetch\s*\(\s*['"`]\/staff\/intents/.test(htmlSrc),
  "fetch('/staff/intents') present (query tools)");

// 30. fetch('/staff/query') present (query tools)
check(/fetch\s*\(\s*['"`]\/staff\/query/.test(htmlSrc),
  "fetch('/staff/query') present (query tools)");

// 31. Luna draft is read-only (NOT SENT label)
check(/NOT SENT|not sent|DRAFT.*NOT SENT/i.test(htmlSrc),
  'Luna draft labelled as NOT SENT (read-only)');

// 32. Read-only reminder in detail pane
check(/READ-ONLY VIEW|read-only.*shadow|no send actions/i.test(htmlSrc),
  'Read-only reminder in conversation detail pane');

// 33. No form method=POST in HTML
check(!/method\s*=\s*['"](?:post|POST)['"]/i.test(htmlSrc),
  'No form method=POST in HTML');

// 34. package.json has verify:staff-conversation-ui script
let pkgHasScript = false;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  pkgHasScript = !!(pkg.scripts && pkg.scripts['verify:staff-conversation-ui']);
} catch (_) {}
check(pkgHasScript, 'package.json has verify:staff-conversation-ui script');

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
