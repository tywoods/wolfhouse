#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const wrapperPath = path.join(__dirname, 'run-luna-routing-r4.sh');
const wrapper = fs.readFileSync(wrapperPath, 'utf8');

function extractFunction(name) {
  const start = wrapper.indexOf(`${name}(){`);
  assert.notStrictEqual(start, -1, `missing ${name} function`);
  const end = wrapper.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, `unterminated ${name} function`);
  return wrapper.slice(start, end + 2);
}

function runHarness({ failuresBeforeSuccess = null, consumeAttemptTimeout = false, consumeSuccessfulAttemptTimeout = false, successfulReturnDelay = 0, advanceBeforeFirstBudget = false }) {
  const fn = extractFunction('wait_for_certificate');
  const script = `
set -u -o pipefail
SITE=whatsapp-staging.lunafrontdesk.com
SECONDS=0
attempts=0
rolled_back=0
committed=0
advanced_budget=0
curl(){
  ((attempts+=1))
  ${consumeAttemptTimeout ? 'while (($#)); do if [[ $1 == --max-time ]]; then SECONDS=$((SECONDS + $2)); break; fi; shift; done' : ':'}
  ${consumeSuccessfulAttemptTimeout ? `if (( attempts > ${failuresBeforeSuccess} )); then while (($#)); do if [[ $1 == --max-time ]]; then SECONDS=$((SECONDS + $2)); break; fi; shift; done; SECONDS=$((SECONDS + ${successfulReturnDelay})); fi` : ':'}
  ${failuresBeforeSuccess === null ? 'return 1' : `(( attempts > ${failuresBeforeSuccess} ))`}
}
sleep(){ SECONDS=$((SECONDS + $1)); }
on_exit(){
  local rc=$?
  (( committed == 1 )) || { rolled_back=1; printf 'rollback=%s attempts=%s seconds=%s\\n' "$rolled_back" "$attempts" "$SECONDS"; }
  exit "$rc"
}
${fn}
${advanceBeforeFirstBudget ? `
debug_clock(){
  if (( advanced_budget == 0 )) && [[ $BASH_COMMAND == 'remaining=$((deadline - SECONDS))' ]]; then
    advanced_budget=1
    SECONDS=$deadline
  fi
}
set -T
trap debug_clock DEBUG
` : ''}
trap on_exit EXIT
wait_for_certificate || exit $?
committed=1
printf 'committed=%s attempts=%s seconds=%s\\n' "$committed" "$attempts" "$SECONDS"
`;
  return cp.spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

const delayed = runHarness({ failuresBeforeSuccess: 3 });
assert.strictEqual(delayed.status, 0, delayed.stderr);
assert.match(delayed.stdout, /committed=1 attempts=4 seconds=6/);
assert.doesNotMatch(delayed.stdout, /rollback=/);

const permanent = runHarness({ failuresBeforeSuccess: null });
assert.strictEqual(permanent.status, 1, permanent.stderr);
assert.match(permanent.stdout, /rollback=1 attempts=60 seconds=120/);

const slowPermanent = runHarness({ failuresBeforeSuccess: null, consumeAttemptTimeout: true });
assert.strictEqual(slowPermanent.status, 1, slowPermanent.stderr);
assert.match(slowPermanent.stdout, /rollback=1 attempts=12 seconds=120/);

const successAtDeadline = runHarness({ failuresBeforeSuccess: 59, consumeSuccessfulAttemptTimeout: true });
assert.strictEqual(successAtDeadline.status, 1, successAtDeadline.stderr);
assert.match(successAtDeadline.stdout, /rollback=1 attempts=60 seconds=120/);

const successAfterDeadline = runHarness({ failuresBeforeSuccess: 59, consumeSuccessfulAttemptTimeout: true, successfulReturnDelay: 1 });
assert.strictEqual(successAfterDeadline.status, 1, successAfterDeadline.stderr);
assert.match(successAfterDeadline.stdout, /rollback=1 attempts=60 seconds=121/);

const preCurlClockAdvance = runHarness({ failuresBeforeSuccess: 0, advanceBeforeFirstBudget: true });
assert.strictEqual(preCurlClockAdvance.status, 1, preCurlClockAdvance.stderr);
assert.match(preCurlClockAdvance.stdout, /rollback=1 attempts=0 seconds=120/);

assert.match(wrapper, /must wait_for_certificate\nrequire require_unauthorized/);
assert.doesNotMatch(extractFunction('wait_for_certificate'), /(?:^|\s)-k(?:\s|$)|--insecure/);
assert.match(wrapper, /must capture_public_contract "\$BACKUP\/public\.after"; cmp -s "\$BACKUP\/public\.before" "\$BACKUP\/public\.after"\|\|die 1 'protected HTTP\/TLS\/Location drifted'/);

console.log('PASS certificate readiness waits, timeout rollback, and protected acceptance contract');
