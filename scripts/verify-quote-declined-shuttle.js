'use strict';

// Offline regression: execute the real successful-preview reply branch and its
// real helper. No Staff API startup, HTTP, database or booking/payment writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildBotQuoteReplyDraft } = require('./lib/bot-booking-package-normalize');

const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const handler = source.indexOf('async function handleBotBookingPreview(');
const start = source.indexOf('// ── reply_draft', handler);
const end = source.indexOf('// ── Audit log', start);
assert(handler >= 0 && start > handler && end > start, 'actual preview reply branch must exist');
const replyBranch = source.slice(start, end);

function previewReply(body) {
  return vm.runInNewContext(`(() => { ${replyBranch}\nreturn replyDraft; })()`, {
    body,
    quote: { success: true, total_cents: 18000, deposit_required_cents: 18000 },
    pkgCtx: { isShortStay: false, isNoPackage: false, quotePackageCode: 'malibu' },
    packageCode: 'malibu',
    buildBotQuoteReplyDraft,
  });
}

test('quote reply preserves prices but does not re-ask a declined shuttle', () => {
  const unresolved = previewReply({});
  assert.match(unresolved, /Do you need the free Santander airport shuttle/);
  const declined = previewReply({ shuttle_choice: 'declined' });
  assert.doesNotMatch(declined, /shuttle|\?/i,
    'declined shuttle must not be re-offered or replaced with a new consent question');
  assert.equal(declined,
    unresolved.split(' Do you need the free Santander airport shuttle')[0],
    'only the resolved question disappears; quote facts remain byte-identical');
});
