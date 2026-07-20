#!/usr/bin/env node
/** CLI entry for the deterministic local-asset / font origin source scanner. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLocalAssetOrigins } from './lib/local-asset-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { files, errors } = scanLocalAssetOrigins(ROOT);

console.log(`scan-local-font-origins: scanned ${files.length} file(s)`);
if (errors.length) {
  console.error('scan-local-font-origins: FAIL');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log('scan-local-font-origins: PASS');
console.log('LOCAL_STYLESHEET_IMPORT_FONTFACE_ONLY');
