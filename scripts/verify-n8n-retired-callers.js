'use strict';

/**
 * Phase 3A guard: retired n8n callers must not return in executable/runtime code.
 *
 * Fails on:
 *   - retired Cloud host (tywoods + app + n8n + cloud)
 *   - active n8n webhook URL shapes (Cloud or local webhook bases)
 *   - new N8N_* runtime env dependencies in scanned runtime surfaces
 *
 * Path allowlist is a closed exact set in scripts/lib/n8n-retired-callers-guard.js.
 * Dangerous runtime patterns are never suppressed by no_n8n / calls_n8n:false text.
 *
 * Exit 0 on pass; nonzero on violations.
 */

const {
  collectViolations,
} = require('./lib/n8n-retired-callers-guard');

function main() {
  const { files, violations } = collectViolations();
  const cloudInScan = violations.filter((v) => v.id === 'n8n_cloud_host' || v.id === 'n8n_cloud_webhook');

  if (violations.length) {
    console.error('verify-n8n-retired-callers FAILED');
    console.error(`Scanned ${files.length} files; ${violations.length} violation(s):\n`);
    for (const v of violations.slice(0, 50)) {
      console.error(`  ${v.file}:${v.line} [${v.id}] ${v.label}`);
      console.error(`    ${v.excerpt}`);
    }
    if (violations.length > 50) console.error(`  … ${violations.length - 50} more`);
    process.exit(1);
  }

  console.log('verify-n8n-retired-callers OK');
  console.log(`  scanned_files=${files.length}`);
  console.log('  cloud_host_in_runtime=0');
  console.log('  allowlist=closed_exact_historical_paths+prefix_roots');
  if (cloudInScan.length !== 0) process.exit(1);
  process.exit(0);
}

main();
