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

const esSunset = require('./lib/staff-portal-i18n-es-sunset');
assert.equal(esSunset['admin.bookings.status.cancelled'], 'Cancelado');
assert.equal(esSunset['schedule.status.cancelled'], 'Cancelada');
assert.equal(esSunset['admin.bookings.waiver'], 'Exención');
assert.equal(esSunset['admin.bookings.waiverUnknown'], 'Sin enlace de exención');
assert.equal(esSunset['schedule.status.waiverSigned'], 'Exención firmada');
const itPersonale = require('./lib/staff-portal-i18n-it-personale');
assert.equal(itPersonale['calendar.detail.status.deposit_paid'], 'Caparra pagata');
const esFill = require('./lib/staff-portal-i18n-es-fill');
assert.equal(esFill['customers.editProfile'], 'Editar perfil');
assert.equal(esFill['drawer.field.editPrivateRoom'], 'Editar habitación privada');
assert.equal(esFill['customers.outreach.sendComplete'], 'Envío completado.');
assert.equal(esFill['schedule.addon.oneDay'], '1 día');
const esComplete = require('./lib/staff-portal-i18n-es');
assert.equal(esComplete['admin.finance.wh.depositsPartialNote'], 'Solo depósitos verificados. Datos de cobros incompletos; se desconoce el total de depósitos.');
const itComplete = require('./lib/staff-portal-i18n-it-complete');
assert.equal(itComplete['admin.finance.wh.depositsPartialNote'], 'Solo caparre verificate. Dati di pagamento incompleti; il totale delle caparre non è disponibile.');

const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
for (const locale of ['es', 'it']) {
  for (const key of ['customers.conversation.open', 'customers.conversation.failed', 'schedule.drawer.conversationFailed']) {
    assert.ok(!/\b(conversation|open|complete)\b/i.test(STAFF_PORTAL_STRINGS[locale][key]), `${locale}.${key} leaks English`);
  }
}
assert.equal(STAFF_PORTAL_STRINGS.it['customers.outreach.sendComplete'], 'Invio completato.');
assert.equal(STAFF_PORTAL_STRINGS.it['calendar.detail.status.deposit_paid'], 'Caparra pagata');
assert.equal(STAFF_PORTAL_STRINGS.it['drawer.invoice.payStatus.deposit_paid'], 'Caparra pagata');

console.log('PASS verify-staff-pass6-copy');
