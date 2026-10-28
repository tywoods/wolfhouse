'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {guestCopy,formatGuestMoney,formatGuestDate,language}=require('./luna-guest-copy-catalog');
test('catalog normalises locale tags and whitespace',()=>{assert.equal(language(' de '),'de');assert.equal(language('fr-FR'),'fr');assert.equal(language('it_IT'),'it');assert.equal(language(' es '),'es')});
test('money formatter rejects absent and non-finite input and uses locale decimals',()=>{for(const v of [null,'',NaN,Infinity,'x'])assert.equal(formatGuestMoney(v,'de'),'');assert.equal(formatGuestMoney(76850,'en'),'€768.50');assert.equal(formatGuestMoney(76850,'de'),'768,50 €')});
test('date formatter rejects calendar-invalid dates',()=>{assert.equal(formatGuestDate('2026-02-31','de'),'');assert.equal(formatGuestDate('','fr'),'');assert.equal(formatGuestDate('2026-12-14','de'),'14. Dezember')});
test('native copy has booking and solo/group intent',()=>{assert.match(guestCopy('de').staySummary,/Deine Reise/);assert.match(guestCopy('de').saveConfirmAsk,/buchen|Buchung/);assert.match(guestCopy('de').nameAsk,/Auf welchen Namen darf ich buchen/);assert.equal(typeof guestCopy('es').saveConfirmAskSolo,'string');assert.equal(typeof guestCopy('fr').saveConfirmAskGroup,'string')});
