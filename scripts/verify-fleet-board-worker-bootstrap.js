#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const overlayPath = path.join(__dirname, '..', 'docker', 'hermes-staging', '99z-wh-vm-post-bootstrap.sh');
const src = fs.readFileSync(overlayPath, 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

check('fresh-volume clone seeding covers Deckhand, Seadog, and orchestrator',
  /case "\$HERMES_ROLE" in\s*\n\s*orchestrator\|seadog\|deckhand\)/.test(src));
check('clone seeding installs the github remote',
  src.includes('remote add github https://github.com/tywoods/wolfhouse.git'));

const durability = 'git fetch github && git reset --hard github/master';
check('Deckhand SOUL receives fleet-board operating instructions in 99z',
  /if \[ "\$HERMES_ROLE" = "deckhand" \][\s\S]*## Fleet board — Deckhand operating instructions[\s\S]*task\.js claim <id> --as deckhand[\s\S]*task\.js review <id> --tip-sha <sha> --pr <n>/.test(src));
check('Deckhand instructions require durable master refresh before board work',
  /## Fleet board — Deckhand operating instructions[\s\S]*git fetch github && git reset --hard github\/master/.test(src));
check('Seadog SOUL receives fleet-board review instructions in 99z',
  /if \[ "\$HERMES_ROLE" = "seadog" \][\s\S]*## Fleet board — Seadog operating instructions[\s\S]*task\.js show <id>[\s\S]*task\.js gate <id> --result pass\|fail --notes/.test(src));
check('Seadog instructions require durable master refresh before board work',
  /## Fleet board — Seadog operating instructions[\s\S]*git fetch github && git reset --hard github\/master/.test(src));
check('durability command is present in both worker instruction blocks',
  src.split(durability).length - 1 >= 2);
check('worker board instructions are not written in bootstrap.sh',
  !fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'bootstrap.sh'), 'utf8').includes('Fleet board — Deckhand operating instructions') &&
  !fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'bootstrap.sh'), 'utf8').includes('Fleet board — Seadog operating instructions'));

console.log(`fleet worker bootstrap verifier: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
