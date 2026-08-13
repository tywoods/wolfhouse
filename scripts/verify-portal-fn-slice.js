'use strict';

/**
 * verify:portal-fn-slice
 *
 * Locks the slice helper the sunset Create/Edit gates use to eval portal
 * owners offline. A stale `needed` list must die naming the function, not
 * assemble a sandbox with a hole.
 *
 * Offline: no database, no network, no test framework.
 *
 * Run:
 *   node scripts/verify-portal-fn-slice.js
 */

const { collectPortalFunctions, sliceNamespaceVar } = require('./lib/portal-fn-slice');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
  } else {
    console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
    fail += 1;
  }
}

console.log('\nverify:portal-fn-slice\n');

const src = [
  'function owner(){ helper(); }',
  'function helper(){ return 1; }',
  'var ns = (function(){ function method(){ return 2; } return { method: method }; })();',
  'var flag = false;',
  'function readsFlag(){ return flag; }',
  'function callsGuarded(){ if (typeof optionalHelper === "function") optionalHelper(); }',
].join('\n');

console.log('[1] Resolves roots, callees, state, and namespace IIFEs');
{
  const sliced = collectPortalFunctions(src, ['owner', 'readsFlag']);
  ok('root owner is resolved', sliced.resolved.includes('owner'));
  ok('callee helper is pulled in', sliced.resolved.includes('helper'));
  ok('module-level state var is pulled in', sliced.stateVars.includes('flag'));
  ok('nothing missing when the graph is complete', sliced.missing.length === 0);
  const ns = sliceNamespaceVar(src, 'ns');
  ok('namespace IIFE slices to a var assignment',
    !!ns && /^var ns = \(function/.test(ns));
}

console.log('\n[2] Missing root throws and names the function');
{
  let thrown = null;
  try {
    collectPortalFunctions(src, ['owner', 'schedulePortalDoesNotExist']);
  } catch (e) {
    thrown = e;
  }
  ok('missing root throws', thrown instanceof Error, thrown && thrown.message);
  ok('throw names the missing function',
    thrown && /schedulePortalDoesNotExist/.test(thrown.message),
    thrown && thrown.message);
  ok('throw does not name a resolved root',
    thrown && !/\bowner\b/.test(thrown.message),
    thrown && thrown.message);
}

console.log('\n[3] Missing callee is reported, not skipped');
{
  const sliced = collectPortalFunctions(
    'function owner(){ danglingHelper(); }',
    ['owner'],
  );
  ok('owner still resolves', sliced.resolved.includes('owner'));
  ok('dangling callee is in missing', sliced.missing.includes('danglingHelper'),
    'missing=' + sliced.missing.join(','));
}

console.log('\n[4] Provided names are neither sliced nor reported missing');
{
  const sliced = collectPortalFunctions(
    'function owner(){ stubbed(); helper(); } function helper(){ return 1; }',
    ['owner'],
    { provided: ['stubbed'] },
  );
  ok('stubbed is not missing', !sliced.missing.includes('stubbed'),
    'missing=' + sliced.missing.join(','));
  ok('stubbed is not sliced (sandbox already defines it)',
    !sliced.resolved.includes('stubbed'));
  ok('real helper is still sliced', sliced.resolved.includes('helper'));
}

console.log('\n[5] typeof-guarded callees are optional, not missing');
{
  const sliced = collectPortalFunctions(src, ['callsGuarded']);
  ok('guarded callee is not missing', !sliced.missing.includes('optionalHelper'),
    'missing=' + sliced.missing.join(','));
  ok('guarded callee is optional', sliced.optional.includes('optionalHelper'));
}

if (fail) {
  console.error('\nverify:portal-fn-slice — FAILED (pass=' + pass + ' fail=' + fail + ')');
  process.exit(1);
}
console.log('\nverify:portal-fn-slice — ALL CHECKS PASSED (pass=' + pass + ')');
