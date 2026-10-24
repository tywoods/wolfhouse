'use strict';

const FORBIDDEN_TRANSPORTS = Object.freeze([
  'sendWhatsApp', 'sendSms', 'sendEmail', 'sendStaffAlert', 'enqueueOutbox',
]);

function transportForbidden(name) {
  return async function lunaV3ForbiddenTransport() {
    const error = new Error(`luna_v3_transport_forbidden:${name}`);
    error.code = 'luna_v3_transport_forbidden';
    error.transport = name;
    error.httpStatus = 403;
    throw error;
  };
}

/** Production authority boundary for the Luna v3 registry.
 *
 * Sending capabilities are deliberately present and fail closed.  Keeping the
 * traps on the exact object bound to createOperations means a future operation
 * cannot acquire a sender merely by looking up a conventional authority name.
 */
function createLunaV3StaffAuthorities(dependencies) {
  const d = dependencies || {};
  const authorities = {
    resolveBookingAdmission: d.resolveBookingAdmission,
    async createGuestCheckout(args) {
      if (!d.stripeLinksEnabled || !d.stripeSecretKey || !d.stripeSecretKey.startsWith('sk_test_')
          || !d.checkoutRedirectUrlsConfigured()) {
        const error = new Error('test_provider_unavailable');
        error.code = 'test_provider_unavailable';
        throw error;
      }
      return d.perGuestCheckout.run({
        ...args, withPgClient: d.withPgClient, stripe: d.createStripe(d.stripeSecretKey),
        clientSlug: 'wolfhouse-somo', actorId: args.principalId,
        successUrl: d.checkoutSuccessUrl(), cancelUrl: d.checkoutCancelUrl(),
      });
    },
    async readGuestCheckout(checkoutId) {
      if (!d.stripeLinksEnabled || !d.stripeSecretKey || !d.stripeSecretKey.startsWith('sk_test_')) {
        const error = new Error('test_provider_unavailable');
        error.code = 'test_provider_unavailable';
        throw error;
      }
      return d.createStripe(d.stripeSecretKey).checkout.sessions.retrieve(checkoutId);
    },
  };
  for (const name of FORBIDDEN_TRANSPORTS) authorities[name] = transportForbidden(name);
  return Object.freeze(authorities);
}

module.exports = { FORBIDDEN_TRANSPORTS, createLunaV3StaffAuthorities };
