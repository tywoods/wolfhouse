'use strict';

const assert = require('node:assert/strict');
const {
  buildPersonalityReplyLexicon,
} = require('./lib/luna-guest-personality-config');

const EN_GROUP_QUESTION = 'Would you like to pay together (one person pays the deposit for everyone) or separately (each person gets their own deposit link)?';
const ES_GROUP_QUESTION = '¿Preferís pagar juntos (una persona paga el depósito de todos) o por separado (cada uno recibe su propio enlace de depósito)?';

function renderPaymentChoice(lang, guestCount) {
  const lexicon = buildPersonalityReplyLexicon('wolfhouse-somo', lang);
  return lexicon.ask_payment_choice({
    deposit: '€200',
    total: '€800',
    guestCount,
    hasCollectedAddons: false,
    manualNote: '',
  });
}

function renderConfirmation(lang) {
  return buildPersonalityReplyLexicon('wolfhouse-somo', lang).confirmation_sent;
}

const tests = [
  ['English group payment choice uses the exact together/separately wording', () => {
    assert.equal(renderPaymentChoice('en', 2), EN_GROUP_QUESTION);
    assert.equal(renderPaymentChoice('en', 5), EN_GROUP_QUESTION);
  }],
  ['Spanish group payment choice uses the exact together/separately wording', () => {
    assert.equal(renderPaymentChoice('es', 2), ES_GROUP_QUESTION);
    assert.equal(renderPaymentChoice('es', 5), ES_GROUP_QUESTION);
  }],
  ['solo payment choice remains the existing deposit/full-payment wording', () => {
    assert.equal(renderPaymentChoice('en', 1), 'All good — accommodation only 😊\nWould you rather pay the €200 deposit or the full €800 to hold it?');
    assert.equal(renderPaymentChoice('es', 1), 'Perfect — just the stay then 😊\nTo hold the spot, would you prefer to pay the €200 deposit now, or pay the full €800?');
  }],
  ['after-payment confirmation renderer output remains unchanged', () => {
    assert.equal(renderConfirmation('en'), "You're confirmed — welcome to the Wolfhouse family 😊 I've sent your details with address, gate code, and room info.");
    assert.equal(renderConfirmation('es'), '¡Estáis confirmados — bienvenidos a la familia Wolfhouse! 😊 Os he enviado los detalles con dirección, código de la puerta e info de la habitación.');
  }],
];

let passed = 0;
for (const [name, test] of tests) {
  test();
  passed += 1;
  console.log(`PASS ${name}`);
}
console.log(`PASS ${passed}/${tests.length}`);
