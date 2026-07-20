'use strict';

/**
 * radar-slice16i-staff-api-readiness — RADAR Slice 16I locks + helpers.
 *
 * Source-partial progress only: /readyz + ACA probes in Wolfhouse/Sunset IaC.
 * Supersedes deferred 16C. No live deploy. Deployment + failure drill +
 * lifecycle integration remain open.
 */

const path = require('path');

const MASTER_BASIS = 'd922099cc1eec1596ef4c67f265c8b6c5e6bc81e';
const SLICE = 'RADAR-16I';
const OUTCOME_ID = '16I_staff_api_readiness_dependencies';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16i-readiness-replacement';

const DEFERRED_16C = Object.freeze({
  branch: 'radar/slice-16c-staff-api-readiness',
  tip_sha: '0a2c0ac8a3b508a97c75b31dad1c211027edf134',
  policy: 'do_not_merge_do_not_modify',
});

const CONTAINER_PORT = 3036;

/**
 * Conservative ACA probe contract — must match both staging main.bicep files.
 * Readiness periodSeconds must exceed MAX_OPERATION_BOUND_MS (3500).
 */
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
  'scripts/lib/radar-slice16i-staff-api-readiness.js',
  'scripts/verify-radar-slice16i-staff-api-readiness.js',
  'fixtures/radar-operations/slice16i-expected-contract.json',
  'fixtures/radar-operations/slice16i-probe-contract.json',
]);

/**
 * Extract the probes: [ ... ] array text from a staff-api container block.
 * @param {string} bicepText
 * @returns {string | null}
 */
function extractProbesBlock(bicepText) {
  const marker = 'RADAR 16I — ACA probes';
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
  DEFERRED_16C,
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
