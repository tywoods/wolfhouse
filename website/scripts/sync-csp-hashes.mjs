#!/usr/bin/env node
/**
 * REMOVED: sync-csp-hashes used to rewrite tracked contract/_headers from dist
 * (dist-as-authorization). That path is forbidden.
 *
 * Use:
 *   - npm run build              → astro build + seal-dist-security (verify + copy headers)
 *   - npm run report:inline      → print-only candidates (never writes, never in build)
 */
console.error(
  'sync-csp-hashes: removed. Dist must not authorize or rewrite tracked CSP files.\n' +
    '  Review candidates: npm run report:inline\n' +
    '  Build seal:        npm run build (verify inventory, copy committed _headers to dist)',
);
process.exit(1);
