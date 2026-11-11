'use strict';

/** France Wolfhouse TEST/staging image names Skip builds locally. Never prod. */
const STAFF_IMAGE = 'luna-local/wh-staff-api';
const LUNA_IMAGE = 'luna-local/wh-hermes-staging';
const LUNA_IMAGE_ALIAS = 'luna-local/hermes-luna';

const STAFF_COMPOSE = '/srv/staff/compose/compose.yml';
const LUNA_COMPOSE = '/srv/luna/wolfhouse/config/compose.yml';
const STAFF_SERVICE = 'wolfhouse';
const LUNA_SERVICE = 'hermes-luna';

const PROD_COMPOSE_MARKERS = [
  '/opt/wolfhouse-prod/',
  'wolfhouse-prod/compose.yaml',
  'wolfhouse-prod-private',
];

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeRel(p) {
  return trimStr(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function isStaffPath(rel) {
  const p = normalizeRel(rel);
  if (!p) return false;
  if (p === 'Dockerfile' || p === 'package.json' || p === 'package-lock.json') return true;
  if (p.startsWith('scripts/')) return true;
  if (p.startsWith('database/')) return true;
  if (p.startsWith('config/')) return true;
  if (p.startsWith('public/')) return true;
  return false;
}

function isLunaPath(rel) {
  const p = normalizeRel(rel);
  return p === 'docker/hermes-staging/Dockerfile' || p.startsWith('docker/hermes-staging/');
}

function classifyChangedImages(files) {
  const list = Array.isArray(files) ? files : [];
  let staff = false;
  let luna = false;
  for (const f of list) {
    if (isStaffPath(f)) staff = true;
    if (isLunaPath(f)) luna = true;
  }
  return { staff, luna };
}

function isProdComposePath(p) {
  const s = trimStr(p);
  if (!s) return false;
  return PROD_COMPOSE_MARKERS.some((m) => s.includes(m));
}

function canSkipInImageTests(opts) {
  const o = opts || {};
  const commitSha = trimStr(o.commitSha).toLowerCase();
  const checkedSha = trimStr(o.checkedSha).toLowerCase();
  if (!commitSha || !checkedSha) return false;
  if (commitSha !== checkedSha) return false;
  return o.githubChecksPassed === true;
}

function estimateMinutes(plan, skipTests) {
  const p = plan || {};
  if (!p.staff && !p.luna) return 1;
  let min = 2; // backup + health
  if (p.staff) min += 3;
  if (p.luna) min += skipTests ? 5 : 20;
  return min;
}

module.exports = {
  STAFF_IMAGE,
  LUNA_IMAGE,
  LUNA_IMAGE_ALIAS,
  STAFF_COMPOSE,
  LUNA_COMPOSE,
  STAFF_SERVICE,
  LUNA_SERVICE,
  classifyChangedImages,
  isProdComposePath,
  canSkipInImageTests,
  estimateMinutes,
  isStaffPath,
  isLunaPath,
};
