#!/usr/bin/env node
/**
 * Print-only candidate report of inline script/style blocks found in dist/.
 * NEVER writes inventory, contract, or _headers. NEVER used by npm run build.
 *
 * Review output manually; if hashes change, update the committed inventory and
 * matching contract/_headers in a deliberate review commit — do not auto-approve.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInlineCandidates } from './lib/inline-csp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('report-inline-candidates: dist/index.html missing — run npm run build first');
  process.exit(1);
}

const candidates = collectInlineCandidates(DIST);
console.log(JSON.stringify({ note: 'print-only; not an approval', candidates }, null, 2));
console.log(
  `\nreport-inline-candidates: ${candidates.length} candidate(s) printed. No files written.`,
);
