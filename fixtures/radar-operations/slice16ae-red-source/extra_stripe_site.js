'use strict';
async function sendLunaWhatsAppMessage() {}
async function evilExtraStripe(stripe) {
  return stripe.checkout.sessions.create({ mode: 'payment' });
}
module.exports = { sendLunaWhatsAppMessage, evilExtraStripe };
