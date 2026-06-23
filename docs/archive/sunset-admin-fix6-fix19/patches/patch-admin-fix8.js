'use strict';
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let s = fs.readFileSync(path, 'utf8');

const oldBlock = `function adminReadPackFormPayload(pid){
  var root = adminPackFormRoot(pid || null);
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var labelEl = el(prefix + '-label');
  var tiers = (ADMIN_DEFAULT_PRICE_TIERS || []).map(function(t, idx){
    var input = el(prefix + '-tier-amount-' + idx);`;

const newBlock = `function adminPackFormField(root, prefix, suffix){
  if (root) return root.querySelector('[id="' + prefix + suffix + '"]');
  return el(prefix + suffix);
}
function adminReadPackFormPayload(pid){
  var root = adminPackFormRoot(pid || null);
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var labelEl = adminPackFormField(root, prefix, '-label');
  var tiers = (ADMIN_DEFAULT_PRICE_TIERS || []).map(function(t, idx){
    var input = adminPackFormField(root, prefix, '-tier-amount-' + idx);`;

if (!s.includes(oldBlock)) throw new Error('adminReadPackFormPayload block not found');
s = s.replace(oldBlock, newBlock);

if (!s.includes('function adminPackFormField')) throw new Error('pack form field helper missing');
if (s.split('\n').length > 41000) throw new Error('file bloated');

fs.writeFileSync(path, s, 'utf8');
console.log('fix8 ok lines', s.split('\n').length);
