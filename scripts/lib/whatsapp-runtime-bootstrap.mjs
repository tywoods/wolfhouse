/**
 * Pre-main Staff mapping for the selected Wolfhouse TEST profile.
 *
 * Load with `node --import ./scripts/lib/whatsapp-runtime-bootstrap.mjs`.
 * Other profiles are unchanged when none of the WA_* keys are present.
 * Failures print a code only. Secret values are never written or logged.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selected, applyStaffProcessEnv } = require('./whatsapp-runtime-identity.js');

if (selected(process.env)) {
  try {
    applyStaffProcessEnv(process.env);
  } catch (error) {
    console.error(`whatsapp_runtime_bootstrap_failed:${error && error.code ? error.code : 'closed'}`);
    process.exit(1);
  }
}
