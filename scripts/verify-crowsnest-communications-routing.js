'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderCrowsnestPage } = require('./lib/crowsnest/crowsnest-page');

const html = renderCrowsnestPage({ view: 'communications', cspNonce: 'test-nonce' });

assert.match(html, /Current binding/i);
assert.match(html, /\+34 663 43 94 19/);
assert.match(html, /Sunset/);
assert.match(html, /Wolfhouse/);
assert.match(html, /Save routing/i);
assert.match(html, /Confirm routing change/i);
assert.match(html, /old Luna/i);
assert.match(html, /new Luna/i);
assert.match(html, /who changed/i);
assert.match(html, /when/i);
assert.match(html, /\/api\/communications\/luna-number-route/);
assert.match(html, /flip-to-sunset/);
assert.match(html, /rollback-to-wolfhouse/);
assert.match(html, /crypto\.randomUUID\(\)/);
assert.match(html, /expected_revision/);
assert.match(html, /target_luna/);
assert.match(html, /revision/);
assert.match(html, /Routing saved and verified/);
assert.match(html, /audit_readback_missing/);
assert.match(html, /applied\.audit/);
assert.doesNotMatch(html, /new Date\(\)\.toLocaleString/);
assert.doesNotMatch(html, /Authenticated operator/);
assert.doesNotMatch(html, /\/api\/staging\/luna-routing\//);
assert.doesNotMatch(html, /request\(['\"](?:targets|effective|confirm|apply|audit)['\"]/);
assert.doesNotMatch(html, /type=["']text["'][^>]*name=["'](?:phone|host|command|shell)/i);
assert.doesNotMatch(html, /8094|\/sethome|child_process|exec\(|spawn\(/i);

const apiSource = fs.readFileSync(path.join(__dirname, 'crowsnest-api.js'), 'utf8');
assert.match(apiSource, /pathname\.startsWith\(LUNA_ROUTING_PREFIX\)/);
assert.match(apiSource, /CROWSNEST_LUNA_ROUTING_CONTROLLER_URL/);
assert.match(apiSource, /unknown_or_production_number_denied/);
assert.match(apiSource, /isBrowserUiAuthorized\(req\)/);
assert.match(html, /nonce=["']test-nonce["']/);

console.log('PASS verify:crowsnest-communications-routing');
