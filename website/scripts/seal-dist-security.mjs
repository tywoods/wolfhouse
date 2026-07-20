#!/usr/bin/env node
/**
 * Post-astro-build seal (read-only for tracked files):
 *   1. Verify every dist inline script/style exactly matches the committed inventory
 *   2. Copy the already-committed public/_headers into dist/ only
 *
 * Never writes security/inline-blocks.inventory.json, security/headers.contract.json,
 * or public/_headers. Dist is never an authorization source.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyCommittedHeadersToDist,
  verifyContractHeadersInventoryEquivalence,
  verifyDistAgainstInventory,
} from './lib/inline-csp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('seal-dist-security: dist/index.html missing — run astro build first');
  process.exit(1);
}

const equiv = verifyContractHeadersInventoryEquivalence(ROOT);
if (!equiv.ok) {
  for (const e of equiv.errors) console.error(`FAIL  ${e}`);
  console.error('seal-dist-security: contract/_headers/inventory not canonical');
  process.exit(1);
}

const match = verifyDistAgainstInventory(ROOT);
if (!match.ok) {
  for (const e of match.errors) console.error(`FAIL  ${e}`);
  console.error('seal-dist-security: dist inline blocks do not match committed inventory');
  process.exit(1);
}

copyCommittedHeadersToDist(ROOT);
console.log(
  `seal-dist-security: PASS (${match.found.length} inline block(s) matched inventory; committed _headers copied to dist/)`,
);
