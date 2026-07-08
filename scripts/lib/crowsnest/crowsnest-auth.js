'use strict';

/**
 * Crowsnest auth — placeholder for future internal operator auth.
 * Not enforced in skeleton slice. See docs/CROWSNEST.md.
 */

function isCrowsnestAuthEnabled() {
  const raw = String(process.env.CROWSNEST_AUTH_REQUIRED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return false;
}

function getAllowedCrowsnestUsers() {
  const raw = String(process.env.CROWSNEST_ALLOWED_USERS || '').trim();
  if (!raw) {
    // TODO: enforce auth once login/session slice lands; default allow-list for docs only.
    return ['Monshies', 'Earthling'];
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  isCrowsnestAuthEnabled,
  getAllowedCrowsnestUsers,
};
