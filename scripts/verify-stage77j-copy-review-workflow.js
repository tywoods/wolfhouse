/**
 * Stage 7.7j — Static verifier for the copy/review shadow workflow
 *
 * Checks that scripts/staff-query-api.js implements the Phase 1 manual-send
 * loop correctly and that no live-send, write, or forbidden actions are present.
 *
 * Checks (28 total):
 *   1–3:   API file exists, readable, passes node --check
 *   4:     draft textarea present (id="draft-textarea")
 *   5:     copy button present (id="btn-copy-draft")
 *   6:     copy reads textarea VALUE (textaEl.value) not a static string
 *   7:     copy confirmation updated: "Copied — send manually in WhatsApp"
 *   8:     manual-send instructions line present (draft-instructions)
 *   9:     shadow-mode checklist present (shadow-checklist)
 *  10:     checklist step: "Read the guest message thread"
 *  11:     checklist step: "Review and edit"
 *  12:     checklist step: "Copy to clipboard"
 *  13:     checklist step: "send manually in WhatsApp"
 *  14:     checklist gate step: live-send gate warning
 *  15:     approve/send button disabled
 *  16:     NOT SENT label on Luna draft
 *  17:     READ-ONLY / SHADOW MODE banner
 *  18:     No active approve-send fetch endpoint call
 *  19:     No POST/PATCH/DELETE fetch in embedded JS
 *  20:     No live WhatsApp send function
 *  21:     No handoff.resolve UI button
 *  22:     No calendar edit / reassign / move controls
 *  23:     Message thread section exists (thread-section / thread-container)
 *  24:     Conversation inbox tab exists (Conversations tab)
 *  25:     Bed Calendar tab still exists
 *  26:     Stage 7.7j badge present
 *  27:     No eval() in embedded JS
 *  28:     package.json has verify:stage77j-copy-review-workflow script
 *
 * Usage:
 *   node scripts/verify-stage77j-copy-review-workflow.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0, failures = 0;
function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\nverify-stage77j-copy-review-workflow.js  (Stage 7.7j)\n');

// 1. File exists
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

// 2. Readable
const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'File is readable and non-trivial');

// 3. Syntax clean
try { execSync('node --check "' + API_FILE + '"', { stdio: 'ignore' }); ok('Passes node --check'); }
catch (_) { fail('Passes node --check'); }

// 4. Draft textarea present
check(/id="draft-textarea"|id='draft-textarea'/.test(src),
  'draft textarea present (id="draft-textarea")');

// 5. Copy button present
check(/id="btn-copy-draft"|id='btn-copy-draft'/.test(src),
  'copy button present (id="btn-copy-draft")');

// 6. Copy reads textarea VALUE (reads .value of textarea element at click time)
check(/textaEl\.value/.test(src),
  'copy button reads textaEl.value (current textarea text after edits)');

// 7. Copy confirmation message includes "send manually in WhatsApp"
check(/Copied.*send manually|Copied.*WhatsApp/i.test(src),
  '"Copied — send manually in WhatsApp" confirmation message present');

// 8. Manual-send instructions line
check(/draft-instructions|Review and edit the draft.*copy it.*send manually/i.test(src),
  'Manual-send instructions line present (draft-instructions)');

// 9. Shadow-mode checklist CSS/element
check(/shadow-checklist/.test(src),
  'shadow-checklist element/CSS present');

// 10. Checklist step: read thread
check(/Read the guest message thread|Read.*thread/i.test(src),
  'Checklist step: read guest message thread');

// 11. Checklist step: review/edit draft
check(/Review and edit|edit.*draft/i.test(src),
  'Checklist step: review and edit Luna draft');

// 12. Checklist step: copy to clipboard
check(/Copy to clipboard/.test(src),
  'Checklist step: Copy to clipboard');

// 13. Checklist step: send manually in WhatsApp
check(/send.*manually.*WhatsApp|manually.*WhatsApp/i.test(src),
  'Checklist step: send manually in WhatsApp');

// 14. Checklist gate: live-send gate warning in checklist
check(/live-send gate required|not.*use.*dashboard.*live|live sends from this dashboard/i.test(src),
  'Checklist gate: live-send gate required warning');

// 15. Approve/send button disabled
check(/btn-send-disabled|disabled.*Approve|Approve.*disabled/i.test(src),
  'Approve/Send button present and disabled');

// 16. NOT SENT label
check(/NOT SENT|draft-not-sent/i.test(src),
  'NOT SENT label on Luna draft panel');

// 17. READ-ONLY / SHADOW MODE banner
check(/READ-ONLY.*SHADOW MODE|SHADOW MODE.*READ-ONLY/i.test(src),
  'READ-ONLY / SHADOW MODE banner present');

// 18. No active approve-send fetch call
check(!/fetch\s*\([^)]*approve.send/i.test(src) &&
      !/fetch\s*\([^)]*approve_send/i.test(src),
  'No active fetch call to approve-send endpoint');

// 19. No POST/PATCH/DELETE in embedded UI JS fetch calls
// Only check the fetch method assignments in the buildUiHtml string (inline JS)
const uiJsSection = src.slice(src.indexOf('buildUiHtml') || 0);
check(!/method\s*:\s*['"]POST['"]|method\s*:\s*['"]PATCH['"]|method\s*:\s*['"]DELETE['"]/i
       .test(uiJsSection),
  'No POST/PATCH/DELETE fetch method in embedded UI JS');

// 20. No live WhatsApp send function
check(!/sendWhatsApp\s*\(|whatsapp\.send\s*\(|client\.messages\.create/i.test(uiJsSection),
  'No live WhatsApp send function in UI JS');

// 21. No handoff.resolve UI button in the HTML template (server-side handleResolveHandoff is allowed)
// Only look inside the buildUiHtml function body (the inline HTML/JS template)
const htmlTemplateStart = src.indexOf("'<!DOCTYPE html>") >= 0
  ? src.indexOf("'<!DOCTYPE html>")
  : src.indexOf('"<!DOCTYPE html>"') >= 0
    ? src.indexOf('"<!DOCTYPE html>"')
    : src.indexOf('buildUiHtml');
const htmlTemplateSection = htmlTemplateStart >= 0 ? src.slice(htmlTemplateStart, htmlTemplateStart + 80000) : uiJsSection;
check(!/resolve-handoff-btn|btn.*resolve.*handoff|onclick.*resolveHandoff/i.test(htmlTemplateSection),
  'No handoff.resolve UI button in HTML template');

// 22. No calendar edit/reassign/move controls
check(!/reassignBed\s*\(|moveBed\s*\(|editBooking\s*\(|cancelBooking\s*\(/i.test(uiJsSection),
  'No calendar edit/reassign/move/cancel functions in UI JS');

// 23. Message thread section
check(/thread-section|thread-container|id="thread/i.test(src),
  'Message thread section/container present');

// 24. Conversations tab
check(/data-tab="conversations"/.test(src) || /data-tab='conversations'/.test(src),
  'Conversations tab exists');

// 25. Bed Calendar tab
check(/data-tab="bed-calendar"/.test(src) || /data-tab='bed-calendar'/.test(src),
  'Bed Calendar tab still exists');

// 26. Stage 7.7j badge
check(/Stage 7\.7j/.test(src),
  'Stage 7.7j badge present');

// 27. No eval() in UI JS
check(!/\beval\s*\(/.test(uiJsSection),
  'No eval() in embedded UI JS');

// 28. package.json script present
let pkg;
try { pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (_) { pkg = {}; }
check(!!(pkg.scripts && pkg.scripts['verify:stage77j-copy-review-workflow']),
  'package.json has verify:stage77j-copy-review-workflow script');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
