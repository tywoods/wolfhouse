'use strict';

/** Microsoft-only compatibility surface over the shared atomic transaction owner. */
const shared = require('./email-verified-grant-installer');

const ERROR_CODE = 'MICROSOFT_VERIFIED_GRANT_INSTALLER_INVALID';
const ERROR_MESSAGE = 'Microsoft verified grant install failed.';

function createMicrosoftVerifiedGrantInstaller(dependencies) {
  return shared.createMicrosoftOnlyVerifiedGrantInstaller(dependencies);
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  GRANT_GENERATION_INITIAL: shared.GRANT_GENERATION_INITIAL,
  INSTALLER_METHOD: shared.INSTALLER_METHOD,
  INSTALLER_ACK_STATUS: shared.INSTALLER_ACK_STATUS,
  INSTALLER_ACK: shared.INSTALLER_ACK,
  INSTALL_KEYS: shared.INSTALL_KEYS,
  IDENTITY_KEYS: shared.IDENTITY_KEYS,
  DEPENDENCY_KEYS: shared.DEPENDENCY_KEYS,
  ELIGIBLE_BINDING_STATUSES: shared.ELIGIBLE_BINDING_STATUSES,
  LOCK_ROW_KEYS: shared.LOCK_ROW_KEYS,
  GRANT_RETURNING_KEYS: shared.GRANT_RETURNING_KEYS,
  UPDATE_RETURNING_KEYS: shared.UPDATE_RETURNING_KEYS,
  createMicrosoftVerifiedGrantInstaller,
});
