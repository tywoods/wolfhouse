'use strict';
// Synthetic isolated source proof, not a historical receipt or live request.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const assert = require('assert');
const cp = require('child_process');
const ROOT = process.env.REVIEW_WORKTREE || process.cwd();
const REL = 'scripts/lib/luna-front-desk-accommodation-availability-service.js';
for (const mod of ['http', 'https']) require(mod).request = require(mod).get = () => { throw Error('NETWORK FORBIDDEN'); };
require('net').Socket.prototype.connect = () => { throw Error('NETWORK FORBIDDEN'); };
const current = require(path.join(ROOT, REL));
const prior = new Module(path.join(ROOT, REL));
prior.filename = path.join(ROOT, REL);
prior.paths = Module._nodeModulePaths(path.dirname(prior.filename));
prior._compile(fs.readFileSync(path.join(__dirname, 'payment-authority-reference9bc76a30.js'), 'utf8'), prior.filename);
const input = {
 client_slug:'wolfhouse-somo', guests:[{name:'unit guest', explicit_gender:'male'}],
 availability:{status:'checked', availability_checked:true, selected_bed_codes:['UNIT-B1'], check_in:'2027-07-05',check_out:'2027-07-07',guest_count:1,room_type:'shared',room_preference:'male_only',gender_preference:'male'},
 room_rows:[{bed_code:'UNIT-B1',room_code:'UNIT',gender_strategy:'male_only'}],
 quote:{success:true,package_code:'package_none',total_cents:8000,deposit_required_cents:8000,payment_link_amount_cents:8000,currency:'EUR'},
 payment_choice:'deposit', per_guest_payment_links:false,
};
const before = prior.exports.buildCheckedWolfhousePreviewOffer(input);
const after = current.buildCheckedWolfhousePreviewOffer(input);
assert.equal(before.offer_revision.payment_choice, 'deposit');
assert.equal(after.offer_revision.payment_choice, 'full');
assert.equal(after.offer_revision.payment_link_amount_cents, 8000);
assert.equal(current.computeWolfhouseOfferFingerprint(after.offer_revision), after.offer_revision.offer_fingerprint);
const stripAlias = rev => {const result=structuredClone(rev); delete result.offer_fingerprint;delete result.payment_choice;return result;};
assert.deepStrictEqual(stripAlias(before.offer_revision),stripAlias(after.offer_revision));
assert.equal(current.buildWolfhouseOfferRevision({...after.offer_revision,payment_choice:'per_guest',per_guest_payment_links:true}).payment_choice,'per_guest');
assert.equal(current.compareAcceptedWolfhouseOffer(after.offer_revision,current.buildWolfhouseOfferRevision({...after.offer_revision,total_cents:9000})).ok,false);
const partialInput=structuredClone(input);
partialInput.quote.deposit_required_cents=2345;
partialInput.quote.payment_link_amount_cents=2345;
const partial=current.buildCheckedWolfhousePreviewOffer(partialInput);
assert.equal(partial.offer_revision.payment_choice,'deposit');
const split=current.buildWolfhouseOfferRevision({...after.offer_revision,payment_choice:'deposit',per_guest_payment_links:true,payment_link_amount_cents:4000,payment_distribution:[{guest_name:'unit guest',amount_cents:4000}]});
console.log(JSON.stringify({probe:'real-authority-build-before-fingerprint', before, after, partial, split, note:'split input is deliberately hostile/inconsistent; no claim it is a supported valid business offer'},null,2));
fs.writeFileSync(path.join(__dirname,'authority-receipts.json'),JSON.stringify({before,after,partial},null,2)+'\n');
