#!/usr/bin/env node
/**
 * Verify Sea Dog / Deckhand keep hearing peer-bot @mentions after a CoS job cycle.
 *
 * Gates the durable fix in docker/hermes-staging/99z-wh-vm-post-bootstrap.sh:
 * 1. DISCORD_ALLOW_BOTS=mentions boot pin (Skipper-style) for seadog + deckhand
 * 2. sitecustomize force of DISCORD_ALLOW_BOTS for those roles
 * 3. hop-cap resets on @mention of self (so CoS reset/approve/approved_job
 *    bursts never silence Sea Dog after a done)
 *
 * Also runs a pure Python simulation of the hop-cap decision table.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NINEZ = path.join(ROOT, 'docker/hermes-staging/99z-wh-vm-post-bootstrap.sh');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`ok: ${msg}`);
}

const src = fs.readFileSync(NINEZ, 'utf8');

if (!src.includes('_wh_seadog_env_set DISCORD_ALLOW_BOTS mentions')) {
  fail('seadog boot pin missing DISCORD_ALLOW_BOTS=mentions');
}
ok('seadog DISCORD_ALLOW_BOTS boot pin present');

if (!src.includes('_wh_deckhand_env_set DISCORD_ALLOW_BOTS mentions')) {
  fail('deckhand boot pin missing DISCORD_ALLOW_BOTS=mentions');
}
ok('deckhand DISCORD_ALLOW_BOTS boot pin present');

if (!src.includes('_os.environ["DISCORD_ALLOW_BOTS"] = "mentions"')) {
  fail('sitecustomize does not force DISCORD_ALLOW_BOTS=mentions');
}
ok('sitecustomize forces DISCORD_ALLOW_BOTS=mentions for seadog|deckhand');

if (!src.includes('def _wh_message_mentions_me(message):')) {
  fail('hop-cap missing _wh_message_mentions_me helper');
}
if (!src.includes('if _wh_message_mentions_me(message):')) {
  fail('hop-cap does not reset on self @mention');
}
if (!src.includes('_wh_hops[_ch] = 0') || !src.includes('new job wake')) {
  fail('hop-cap mention path does not reset counter');
}
ok('hop-cap resets on peer-bot @mention of self');

// Pure simulation of hop-cap decisions (mirrors sitecustomize logic).
const py = `
WH_MAX = 6
SEADOG = {1519467061397684385, 1519629455297876090}

def mentions_me(mentions):
    return bool(set(mentions) & SEADOG)

def decide(hops, is_bot, mentions):
    if not is_bot:
        return 0, False  # human reset, never drop
    if mentions_me(mentions):
        return 0, False  # @me reset, never drop
    n = hops + 1
    return n, n > WH_MAX

hops = 0
# With mention-reset: CoS approved_job @SeaDog after 6 unmentioned hops must hear
hops = 6
hops, drop = decide(hops, True, [])
assert drop and hops == 7, ("unmentioned over cap must drop", hops, drop)

hops = 6
hops, drop = decide(hops, True, [1519467061397684385])
assert not drop and hops == 0, ("@seadog must reset+hear", hops, drop)

hops = 0
for _ in range(6):
    hops, drop = decide(hops, True, [])
    assert not drop
hops, drop = decide(hops, True, [])
assert drop, "7th unmentioned peer-bot must drop"

hops, drop = decide(hops, False, [])
assert hops == 0 and not drop, "human must reset"

print("hopcap_sim_ok")
`;

const sim = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
if (sim.status !== 0) {
  fail(`hop-cap simulation failed: ${sim.stderr || sim.stdout}`);
}
if (!String(sim.stdout).includes('hopcap_sim_ok')) {
  fail(`hop-cap simulation missing ok marker: ${sim.stdout}`);
}
ok('hop-cap decision simulation');

console.log('PASS verify-seadog-bot-hearing');
