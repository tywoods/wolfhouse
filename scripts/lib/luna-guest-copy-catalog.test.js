'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {guestCopy,formatGuestMoney,formatGuestDate}=require('./luna-guest-copy-catalog');
test('native catalog has every requested locale and native local formats',()=>{for(const lang of ['en','de','fr','it','es']){const c=guestCopy(lang);for(const key of ['staySummary','saveConfirmAsk','paymentSplitAsk','nameAsk','handoff','apology','fallback'])assert.equal(typeof c[key],'string')}assert.equal(formatGuestMoney(76800,'de'),'768 €');assert.equal(formatGuestDate('2026-12-14','de'),'14. Dezember');assert.match(guestCopy('fr').fallback,/Réessaie/);assert.match(guestCopy('de').staySummary,/ß/);});
