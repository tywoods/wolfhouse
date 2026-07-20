'use strict';

/**
 * radar-slice16c-staff-api-readiness — RADAR Slice 16C locks + helpers.
 *
 * Source-partial progress only: /readyz + ACA probes in Wolfhouse/Sunset IaC.
 * No live deploy. Deployment + failure drill remain open.
 */

const path = require('path');

const MASTER_BASIS = 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b';
const SLICE = 'RADAR-16C';
const OUTCOME_ID = '16C_staff_api_readiness_dependencies';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16c-staff-api-readiness';

const CONTAINER_PORT = 3036;

/** Conservative ACA probe contract — must match both staging main.bicep files. */
const PROBE_CONTRACT = Object.freeze({
  port: CONTAINER_PORT,
  startup: Object.freeze({
    type: 'Startup',
    path: '/healthz',
    initialDelaySeconds: 10,
    periodSeconds: 10,
    timeoutSeconds: 5,
    failureThreshold: 30,
    successThreshold: 1,
  }),
  liveness: Object.freeze({
    type: 'Liveness',
    path: '/healthz',
    initialDelaySeconds: 30,
    periodSeconds: 20,
    timeoutSeconds: 5,
    failureThreshold: 3,
    successThreshold: 1,
  }),
  readiness: Object.freeze({
    type: 'Readiness',
    path: '/readyz',
    initialDelaySeconds: 5,
    periodSeconds: 10,
    timeoutSeconds: 5,
    failureThreshold: 3,
    successThreshold: 1,
  }),
});

const STAFF_API_REL = 'scripts/staff-query-api.js';
const READINESS_LIB_REL = 'scripts/lib/staff-api-readiness.js';
const WOLFHOUSE_BICEP_REL = 'infra/azure/staging/main.bicep';
const SUNSET_BICEP_REL = 'infra/azure/sunset-staging/main.bicep';

const OWNED_RELS = Object.freeze([
  READINESS_LIB_REL,
  STAFF_API_REL,
  WOLFHOUSE_BICEP_REL,
  SUNSET_BICEP_REL,
  'scripts/lib/radar-slice16c-staff-api-readiness.js',
  'scripts/verify-radar-slice16c-staff-api-readiness.js',
  'fixtures/radar-operations/slice16c-expected-contract.json',
  'fixtures/radar-operations/slice16c-probe-contract.json',
]);

/**
 * Extract the probes: [ ... ] array text from a staff-api container block.
 * @param {string} bicepText
 * @returns {string | null}
 */
function extractProbesBlock(bicepText) {
  const marker = 'RADAR 16C — ACA probes';
  const idx = bicepText.indexOf(marker);
  if (idx < 0) return null;
  const from = bicepText.indexOf('probes: [', idx);
  if (from < 0) return null;
  let depth = 0;
  let started = false;
  for (let i = from; i < bicepText.length; i += 1) {
    const ch = bicepText[i];
    if (ch === '[') {
      depth += 1;
      started = true;
    } else if (ch === ']') {
      depth -= 1;
      if (started && depth === 0) {
        return bicepText.slice(from, i + 1);
      }
    }
  }
  return null;
}

/**
 * Normalize probe block for Wolfhouse/Sunset drift comparison.
 * @param {string} block
 * @returns {string}
 */
function normalizeProbesBlock(block) {
  return String(block || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Assert a single probe type appears with locked path/port/timings.
 * @param {string} block
 * @param {object} spec
 * @returns {{ ok: boolean, detail?: string }}
 */
function probeSpecPresent(block, spec) {
  const typeRe = new RegExp(`type:\\s*'${spec.type}'`);
  if (!typeRe.test(block)) {
    return { ok: false, detail: `missing type ${spec.type}` };
  }
  // Bound the slice around this probe type for path/port checks.
  const typeIdx = block.search(typeRe);
  const slice = block.slice(typeIdx, typeIdx + 450);
  const checks = [
    [`path: '${spec.path}'`, `path ${spec.path}`],
    [`port: ${spec.port || CONTAINER_PORT}`, `port`],
    [`initialDelaySeconds: ${spec.initialDelaySeconds}`, `initialDelaySeconds`],
    [`periodSeconds: ${spec.periodSeconds}`, `periodSeconds`],
    [`timeoutSeconds: ${spec.timeoutSeconds}`, `timeoutSeconds`],
    [`failureThreshold: ${spec.failureThreshold}`, `failureThreshold`],
    [`successThreshold: ${spec.successThreshold}`, `successThreshold`],
  ];
  for (const [needle, label] of checks) {
    if (!slice.includes(needle)) {
      return { ok: false, detail: `${spec.type} missing ${label}` };
    }
  }
  return { ok: true };
}

/**
 * Validate full probe contract in one Bicep source.
 * @param {string} bicepText
 * @returns {{ ok: boolean, detail?: string, block?: string }}
 */
function validateBicepProbeContract(bicepText) {
  const block = extractProbesBlock(bicepText);
  if (!block) return { ok: false, detail: 'probes block absent' };
  if (!/targetPort:\s*3036/.test(bicepText)) {
    return { ok: false, detail: 'ingress targetPort not 3036' };
  }
  for (const key of ['startup', 'liveness', 'readiness']) {
    const r = probeSpecPresent(block, {
      ...PROBE_CONTRACT[key],
      port: PROBE_CONTRACT.port,
    });
    if (!r.ok) return r;
  }

  // Per-probe path semantics (slice locally so Readiness /readyz cannot
  // false-positive against earlier Liveness/Startup entries).
  for (const key of ['startup', 'liveness', 'readiness']) {
    const spec = PROBE_CONTRACT[key];
    const typeRe = new RegExp(`type:\\s*'${spec.type}'`);
    const typeIdx = block.search(typeRe);
    if (typeIdx < 0) return { ok: false, detail: `missing type ${spec.type}` };
    const slice = block.slice(typeIdx, typeIdx + 450);
    const pathMatch = slice.match(/path:\s*'([^']+)'/);
    const path = pathMatch ? pathMatch[1] : null;
    if (path !== spec.path) {
      return { ok: false, detail: `${spec.type} path want ${spec.path} got ${path}` };
    }
    if ((key === 'liveness' || key === 'startup') && path === '/readyz') {
      return { ok: false, detail: `${spec.type} must not use /readyz` };
    }
    if (key === 'readiness' && path !== '/readyz') {
      return { ok: false, detail: 'Readiness path must be /readyz' };
    }
  }
  return { ok: true, block: normalizeProbesBlock(block) };
}

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  CONTAINER_PORT,
  PROBE_CONTRACT,
  STAFF_API_REL,
  READINESS_LIB_REL,
  WOLFHOUSE_BICEP_REL,
  SUNSET_BICEP_REL,
  OWNED_RELS,
  extractProbesBlock,
  normalizeProbesBlock,
  probeSpecPresent,
  validateBicepProbeContract,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
