'use strict';

const path = require('path');

/**
 * The reviewed prod apply target is the isolated Docker service on
 * wolfhouse-prod-private. Postgres is not published on the France host.
 * Import runs from a one-off container on that network.
 */
const REVIEWED_PROD_TARGET = Object.freeze({
  host: 'wolfhouse-prod-postgres',
  port: 5432,
  database: 'wolfhouse_prod',
  network: 'wolfhouse-prod-private',
});

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function assertReviewedProdTarget(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) fail('invalid_target');
  if (t.host !== REVIEWED_PROD_TARGET.host) fail('invalid_target');
  if (t.database !== REVIEWED_PROD_TARGET.database) fail('invalid_target');
  if (t.network !== REVIEWED_PROD_TARGET.network) fail('invalid_target');
  if (t.port != null && Number(t.port) !== REVIEWED_PROD_TARGET.port) fail('invalid_target');
  if (!t.manifestId || !t.mounts || !t.mounts.data || !t.mounts.backupSpool) fail('invalid_target');
  if (path.resolve(t.mounts.data) === path.resolve(t.mounts.backupSpool)) fail('aliased_mounts');
  if (!/^azure:\/\/[^/]+\/[^/]+\/.+/.test(t.backupDestination || '')) fail('invalid_backup_destination');
  return true;
}

module.exports = {
  REVIEWED_PROD_TARGET,
  assertReviewedProdTarget,
};
