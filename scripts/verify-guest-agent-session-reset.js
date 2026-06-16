'use strict';

/**
 * Static gate — Hermes guest session hard-delete + portal reset wiring.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const freshStart = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/wolfhouse_guest_fresh_start.py'), 'utf8');
const patches = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py'), 'utf8');
const staffApi = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const resetLib = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-hermes-guest-session-reset.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }

console.log('\nverify-guest-agent-session-reset.js\n');

check('A1', /delete_guest_agent_sessions/.test(freshStart), 'hard-delete helper exists');
check('A2', /delete_session\(/.test(freshStart), 'calls SessionDB.delete_session');
check('A3', /_entries\.pop\(session_key/.test(freshStart), 'drops routing entry (not rotate-only)');
check('A4', /hard_delete/.test(freshStart), 'fresh-start API accepts hard_delete');
check('A5', /clear_luna_agent_memories/.test(freshStart), 'hard-delete clears agent memories');
check('A6', /memories_cleared/.test(freshStart), 'reset returns memories_cleared');

check('B1', /session_stale_routing_skip/.test(patches), 'session stale routing patch wired');
check('B2', /luna_soul_reload/.test(patches), 'Luna SOUL reload patch wired');
check('B3', /_evict_cached_agent\(session_key\)/.test(patches), 'evicts agent cache each Luna turn');

check('C1', /reset-agent-session/.test(staffApi), 'portal reset-agent-session route');
check('C2', /btn-agent-session-reset/.test(staffApi), 'Reset Luna session button');
check('C3', /handleConversationResetAgentSession/.test(staffApi), 'agent-only reset handler');
check('C4', /hard_delete:\s*true/.test(staffApi), 'full wipe uses hard_delete');

check('D1', /hard_delete/.test(resetLib), 'Staff API client sends hard_delete');
check('D2', /lunabox\.lunafrontdesk\.com/.test(resetLib), 'default Hermes base is Lunabox');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
