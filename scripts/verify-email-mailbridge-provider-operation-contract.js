'use strict';

const assert = require('assert/strict');
const path = require('path');

const MODULE_PATH = path.join(__dirname, 'lib', 'email-mailbridge-provider-operation-contract.js');
const contract = require(MODULE_PATH);

assert.deepEqual(contract.MAILBRIDGE_OUTCOMES, [
  'committed',
  'not_committed',
  'outcome_unknown',
  'reauthorization_required',
  'conflict',
]);
assert.deepEqual(contract.MAILBRIDGE_OUTBOUND_METHODS, [
  'prepareReply',
  'applyApprovedBody',
  'dispatch',
  'reconcile',
]);

const graph = contract.validateOutboundAdapterDescriptor({
  provider: 'microsoft_graph',
  capabilities: { remote_drafts: true, reconcile: true },
  methods: {
    prepareReply() {}, applyApprovedBody() {}, dispatch() {}, reconcile() {},
  },
});
assert.equal(graph.ok, true);
assert.equal(Object.isFrozen(graph.value), true);

const smtp = contract.validateOutboundAdapterDescriptor({
  provider: 'imap_smtp',
  capabilities: { remote_drafts: false, reconcile: false },
  methods: { dispatch() {} },
});
assert.equal(smtp.ok, true);

assert.equal(contract.validateOutboundAdapterDescriptor({
  provider: 'imap_smtp',
  capabilities: { remote_drafts: false, reconcile: false },
  methods: { prepareReply() {}, dispatch() {} },
}).ok, false, 'SMTP must not expose remote-draft phases when remote_drafts=false');

assert.equal(contract.validateOutboundAdapterDescriptor({
  provider: 'gmail_api',
  capabilities: { remote_drafts: true, reconcile: true },
  methods: { dispatch() {}, reconcile() {} },
}).ok, false, 'remote-draft providers require prepare/apply methods');

assert.equal(contract.validateProviderOutcome('committed').ok, true);
assert.equal(contract.validateProviderOutcome('sent').ok, false);

const cursor = contract.validateCursorDescriptor({
  provider: 'gmail_api',
  endpoint_id: '11111111-1111-4111-8111-111111111111',
  provider_mailbox_id: 'opaque-mailbox-id',
  query_version: 'gmail-history-v1',
  cursor_kind: 'history_id',
  opaque_cursor: '123456789',
});
assert.equal(cursor.ok, true);
assert.equal(Object.isFrozen(cursor.value), true);
assert.equal(contract.validateCursorDescriptor({
  provider: 'gmail_api',
  endpoint_id: '11111111-1111-4111-8111-111111111111',
  provider_mailbox_id: 'opaque-mailbox-id',
  query_version: 'gmail-history-v1',
  cursor_kind: 'history_id',
  opaque_cursor: '123456789',
  client_id: 'attacker-selected',
}).ok, false, 'cursor rejects unknown authority fields');

const refresh = contract.validateRefreshStrategy({
  provider: 'gmail_api',
  refreshGrant() {},
});
assert.equal(refresh.ok, true);
assert.equal(contract.validateRefreshStrategy({
  provider: 'gmail_api',
  refreshGrant: 'not-a-function',
}).ok, false);

console.log('verify:email-mailbridge-provider-operation-contract PASS');
