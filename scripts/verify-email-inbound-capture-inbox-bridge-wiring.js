'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EMAIL_INBOUND_CAPTURE_INBOX_BRIDGE_WIRED,
  ENV_DURABLE_INBOUND_CAPTURE_ENABLED,
} = require('./lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition');

function main() {
  assert.equal(EMAIL_INBOUND_CAPTURE_INBOX_BRIDGE_WIRED, true);
  assert.equal(ENV_DURABLE_INBOUND_CAPTURE_ENABLED, 'LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED');
  const src = fs.readFileSync(
    path.join(__dirname, 'lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition.js'),
    'utf8',
  );
  assert.match(src, /createEmailInboundInboxBridge/);
  assert.match(src, /projectInboundEvent/);
  assert.match(src, /durableConsumer\(envelopes\)/);
  console.log('verify:email-inbound-capture-inbox-bridge-wiring: ok');
}

main();
