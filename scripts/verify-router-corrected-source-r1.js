'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'deploy/luna-routing/install-luna-routing.sh'), 'utf8');

// A failed stop or an unconfirmed inactive state must gate every artifact restore/removal.
assert.match(installer, /controller_stop_unconfirmed=0/);
assert.match(installer, /systemctl is-active --quiet luna-routing-controller\.service/);
assert.match(installer, /for p in Caddyfile fragment env controller unit sudoers tmpfiles[\s\S]*controller_stop_unconfirmed.*-ne 0/);
assert.match(installer, /controller stop or inactive confirmation failed; retaining controller artifacts and runtime dependencies/);
assert.match(installer, /ROLLBACK INCOMPLETE: manual recovery is required/);
assert.match(installer, /exit 2/);

console.log('PASS corrected installer retention contract');
