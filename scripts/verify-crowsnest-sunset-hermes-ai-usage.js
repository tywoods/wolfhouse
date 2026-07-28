'use strict';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateCrowsnestAiUsageEvent } = require('./lib/crowsnest/crowsnest-ai-usage-contract');

const root = path.resolve(__dirname, '..');
const py = `
import json,sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'docker/hermes-staging'))})
from types import SimpleNamespace
from wolfhouse.crowsnest_ai_usage_reporter import build_success_event, build_failure_event
env={
'CROWSNEST_AI_USAGE_INGEST_URL':'https://example.invalid/ingest',
'CROWSNEST_AI_USAGE_INGEST_TOKEN':'oracle-token-not-emitted',
'CROWSNEST_AI_USAGE_CLIENT_SLUG':'client_opaque_123',
'CROWSNEST_AI_USAGE_TENANT_ID':'tenant_opaque_456',
'CROWSNEST_AI_USAGE_SOURCE_SERVICE':'sunset-hermes'}
raw=SimpleNamespace(model='gpt-5.5', usage=SimpleNamespace(input_tokens=12,output_tokens=8,total_tokens=20), output_text='FORBIDDEN COMPLETION', request=\"FORBIDDEN PROMPT\")
print(json.dumps([build_success_event(raw,31,env=env),build_failure_event('gpt-5.5',17,'provider_timeout',env=env)]))
`;
const run = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
assert.strictEqual(run.status, 0, run.stderr);
const events = JSON.parse(run.stdout);
assert.strictEqual(events.length, 2);
for (const event of events) {
  const validation = validateCrowsnestAiUsageEvent(event);
  assert.strictEqual(validation.ok, true, validation.errors.join('\n'));
  const serialized = JSON.stringify(event).toLowerCase();
  for (const forbidden of ['prompt','response','message','completion','oracle-token','authorization','output_text']) assert(!serialized.includes(forbidden), forbidden);
}
assert.strictEqual(events[0].status, 'succeeded');
assert.deepStrictEqual(events[0].tokens, {availability:'measured',input_tokens:12,output_tokens:8,total_tokens:20});
assert.strictEqual(events[1].status, 'failed');
console.log('verify:crowsnest-sunset-hermes-ai-usage PASSED (2 Python receipts validated by canonical JS contract)');
