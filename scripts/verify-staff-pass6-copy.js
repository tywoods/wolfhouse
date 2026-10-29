'use strict';

const assert = require('assert/strict');
const pass3 = require('./lib/staff-portal-i18n-pass3-es-it');

const required = {
  en: {
    'drawer.payments.history.draftPayment': 'Unsent payment link',
    'drawer.payments.history.fullPayment': 'Full payment',
    'drawer.payments.history.depositPayment': 'Deposit payment',
  },
  es: {
    'drawer.payments.history.draftPayment': 'Enlace de pago sin enviar',
    'drawer.payments.history.fullPayment': 'Pago completo',
    'drawer.payments.history.depositPayment': 'Pago del depósito',
  },
  it: {
    'drawer.payments.history.draftPayment': 'Link di pagamento non inviato',
    'drawer.payments.history.fullPayment': 'Pagamento completo',
    'drawer.payments.history.depositPayment': 'Pagamento della caparra',
  },
};
for (const [locale, expectations] of Object.entries(required)) {
  for (const [key, value] of Object.entries(expectations)) {
    assert.equal(pass3[locale][key], value, `${locale}.${key}`);
  }
}
assert.notEqual(pass3.it['drawer.payments.history.fullPayment'], pass3.it['drawer.payments.history.depositPayment']);

const itFill = require('./lib/staff-portal-i18n-it-fill');
assert.equal(itFill['customers.conversation.open'], 'Apri conversazione');
assert.equal(itFill['customers.editProfile'], 'Modifica profilo');
assert.equal(itFill['customers.detail.addTags'], 'Aggiungi etichette:');
assert.equal(itFill['schedule.drawer.waiverCreateFailed'], 'Impossibile creare il link al modulo:');
assert.equal(itFill['schedule.drawer.waiverLoadFailed'], 'Impossibile caricare lo stato del modulo.');
console.log('PASS verify-staff-pass6-copy');
