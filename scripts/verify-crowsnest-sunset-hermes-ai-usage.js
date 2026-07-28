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
from wolfhouse.crowsnest_ai_usage_reporter import build_attempt_event, build_failure_event, build_success_event
env={
'CROWSNEST_AI_USAGE_INGEST_URL':'https://crowsnest.lunafrontdesk.com/api/ai-usage',
'CROWSNEST_AI_USAGE_INGEST_TOKEN':'oracle-token-not-emitted',
'CROWSNEST_AI_USAGE_CLIENT_SLUG':'client_opaque_123',
'CROWSNEST_AI_USAGE_TENANT_ID':'tenant_opaque_456',
'CROWSNEST_AI_USAGE_SOURCE_SERVICE':'sunset-hermes'}
usage=SimpleNamespace(input_tokens=12,output_tokens=8,total_tokens=20)
completed=SimpleNamespace(model='runtime-model',status='completed',usage=usage,output_text='FORBIDDEN COMPLETION')
failed=SimpleNamespace(model='runtime-model',status='failed',usage=None,error='FORBIDDEN ERROR BODY')
incomplete=SimpleNamespace(model='runtime-model',status='incomplete',usage=None,incomplete_details='FORBIDDEN DETAILS')
events=[
 build_success_event(completed,31,env=env),
 build_failure_event('configured-model',17,'provider_timeout',env=env),
 build_attempt_event(response=failed,configured_model='configured-model',latency_ms=19,env=env),
 build_attempt_event(response=incomplete,configured_model='configured-model',latency_ms=23,env=env),
]
malicious=[]
for key in ('CROWSNEST_AI_USAGE_CLIENT_SLUG','CROWSNEST_AI_USAGE_TENANT_ID','CROWSNEST_AI_USAGE_SOURCE_SERVICE'):
 bad=dict(env); bad[key]='sk-abcdefghijklmno'; malicious.append(build_success_event(completed,1,env=bad))
for latency in (True,'1',-1,9007199254740992): malicious.append(build_success_event(completed,latency,env=env))
print(json.dumps({'events':events,'malicious':malicious}))
`;
const run = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
assert.strictEqual(run.status, 0, run.stderr);
const payload = JSON.parse(run.stdout);
assert.strictEqual(payload.events.length, 4);
for (const event of payload.events) {
  const validation = validateCrowsnestAiUsageEvent(event);
  assert.strictEqual(validation.ok, true, validation.errors.join('\n'));
  const serialized = JSON.stringify(event).toLowerCase();
  for (const forbidden of ['prompt','message','completion','oracle-token','authorization','output_text','forbidden error body','forbidden details']) assert(!serialized.includes(forbidden), forbidden);
}
assert.deepStrictEqual(payload.events.map((e) => e.status), ['succeeded','failed','failed','failed']);
assert.deepStrictEqual(payload.events.slice(1).map((e) => e.error_code), ['provider_timeout','provider_response_failed','provider_response_incomplete']);
assert.strictEqual(new Set(payload.events.map((e) => e.event_id)).size, 4);
assert(payload.malicious.every((event) => event === null));
console.log('verify:crowsnest-sunset-hermes-ai-usage PASSED (4 Python receipts and malicious boundaries validated by canonical JS contract)');
