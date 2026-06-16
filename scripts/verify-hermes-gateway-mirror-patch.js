'use strict';

/**
 * Static gate — Hermes gateway Wolfhouse patches (mirror, quote-reply, Luna SOUL reload).
 */

const fs = require('fs');
const path = require('path');

const patches = fs.readFileSync(
  path.join(__dirname, '..', 'docker/hermes-staging/apply_gateway_patches.py'),
  'utf8',
);

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }

console.log('\nverify-hermes-gateway-mirror-patch.js\n');

check('M1', /mirror_whatsapp_thread/.test(patches), 'mirror hook present');
check('M2', /whatsapp_auto_reply_anchor_disabled/.test(patches), 'base platform reply anchor patch');
check('M3', /luna_plain_reply_chunk_context|LUNA_PLAIN_REPLY_CHUNK_TAG/.test(patches), 'whatsapp_cloud Luna chunk context patch');
check('M4', /wolfhouse_quote_reply/.test(patches), 'interactive quote-reply escape hatch');
check('M5', /runtime_whatsapp_patch_hook|install_runtime_whatsapp_patches/.test(patches), 'gateway runtime WhatsApp patch hook');
check('M6', /session_stale_routing_skip/.test(patches), 'session stale routing patch wired');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
