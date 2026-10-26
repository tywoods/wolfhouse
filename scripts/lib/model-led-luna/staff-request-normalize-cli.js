#!/usr/bin/env node
'use strict';
// The only fixture/runtime normalization adapter. It executes Staff's exported
// normalizeQuoteRequest; Python never carries a second approximation.
const { normalizeQuoteRequest } = require('./staff-request-contract');
const crypto = require('node:crypto');
const RECEIPT_KEY = Buffer.from('luna-v3-offline-owner-receipt-v1-2026-10-26', 'utf8');
const canonical = (v) => JSON.stringify(v, Object.keys(v || {}).sort());
function catalogFromChoices(choices) {
  return {items:(choices || []).filter(x => x && x.active === true).map(x => ({
    item_type:x.kind === 'accommodation' || x.kind === 'package' ? 'package' : x.kind,
    item_code:x.code, label:x.label || x.name || x.code, active:true, metadata:x.metadata || {}
  }))};
}
function execute(payload) {
  const input=payload.input;
  const beds=(input && Array.isArray(input.guests)) ? input.guests.map((_,i)=>`fixture-bed-${i+1}`) : [];
  return normalizeQuoteRequest(input,catalogFromChoices(payload.choices),beds,{sessionId:'fixture-owner',turnId:payload.turn_id || 'fixture'});
}
function sign(body) { return crypto.createHmac('sha256',RECEIPT_KEY).update(JSON.stringify(body)).digest('hex'); }
const payload=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
if(payload.command==='normalize') process.stdout.write(JSON.stringify(execute(payload)));
else if(payload.command==='issue') { const body={schema:'staff-owner-execution/v1',executed_at:payload.executed_at,revision:payload.revision,request:payload.input,result:execute(payload)}; process.stdout.write(JSON.stringify({...body,signature:sign(body)})); }
else if(payload.command==='verify') { const {signature,...body}=payload.receipt || {}; process.stdout.write(JSON.stringify({ok:typeof signature==='string' && crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(sign(body))),body})); }
else throw new Error('unknown command');
