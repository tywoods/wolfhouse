'use strict';

/**
 * verify:sunset-schema-slice13c1 — FOUNDATION Slice 13C.1 RED→GREEN
 * Azure Flexible Server identity normalization (DEC-001). Offline only.
 * No Azure mutation. No DB connections. No repair SQL / live apply.
 */

const fs = require('fs');
const path = require('path');
const {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  compareSnapshots,
  normalizeObservedIdentityPresentation,
  normalizeObservedOwnerAzure,
  normalizePublicSchemaAclAzurePgAdmin,
  resolveNormalizationProfile,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  fingerprintProductSchema,
} = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '896b8220dd8586ce8ca6a416eeeefcb819c2a9b5';
const CANON_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

const AZURE_CTX = { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE };

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

function main() {
  console.log('verify:sunset-schema-slice13c1 — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice13c1-azure-identity-normalization-evidence.json');
  const findingsPath = path.join(FIX, 'slice13c1-findings.md');
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const classPath = path.join(FIX, 'slice13a-mismatch-classification-report.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer.js');
  const buildPath = path.join(ROOT, 'scripts', 'build-sunset-schema-slice13c1-normalization-evidence.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13c1.js');
  const observePath = path.join(ROOT, 'scripts', 'observe-sunset-schema-drift.js');

  pass(
    'artifacts-exist',
    [evidencePath, findingsPath, contractPath, classPath, expectedPath].every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const classReport = JSON.parse(fs.readFileSync(classPath, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const buildSrc = fs.readFileSync(buildPath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const observeSrc = fs.readFileSync(observePath, 'utf8');

  pass('master-and-fingerprints',
    evidence.masterShaBasis === MASTER
    && evidence.fingerprints.canonicalExpected === CANON_FP
    && evidence.fingerprints.liveRawCommitted === LIVE_FP
    && (expected.productFingerprint === CANON_FP || expected.previousProductFingerprint === CANON_FP)
    && classReport.actualLiveFingerprint === LIVE_FP);

  pass('design-safety-flags',
    evidence.secretFree === true
    && evidence.containsRepairSql === false
    && evidence.containsLiveApplyCode === false
    && evidence.blessesLiveAsCanonical === false
    && evidence.liveMutation === false
    && evidence.azureMutation === false
    && evidence.doNotClaimDatabaseMatchesCanonical === true
    && evidence.matchAfterNormalization === false
    && evidence.codeAfterNormalization === 'product_schema_differs');

  pass('profile-is-azure-flexible-server-v1',
    evidence.normalizationProfile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1
    && /azure_flexible_server_v1/.test(libSrc));

  // Allowed mappings GREEN
  {
    const ext = normalizeObservedOwnerAzure('azuresu', { kind: 'extension', name: 'pgcrypto', identity: 'pgcrypto' });
    pass('green-azuresu-extension-owner', ext.applied && ext.owner === '$db_owner');
    const fn = normalizeObservedOwnerAzure('azuresu', {
      kind: 'function',
      name: 'armor',
      identity: 'public.armor(bytea)',
    });
    pass('green-azuresu-function-owner', fn.applied && fn.owner === '$db_owner');
    const sch = normalizeObservedOwnerAzure('azure_pg_admin', {
      kind: 'schema',
      name: 'public',
      identity: 'public',
    });
    pass('green-azure-pg-admin-public-schema-owner', sch.applied && sch.owner === 'pg_database_owner');
    const acl = normalizePublicSchemaAclAzurePgAdmin(
      '=U/azure_pg_admin,azure_pg_admin=UC/azure_pg_admin',
    );
    pass(
      'green-public-schema-acl-grantor-grantee-equivalence',
      acl.ok
        && acl.privilegeSetUnchanged === true
        && acl.acl === '=U/pg_database_owner,pg_database_owner=UC/pg_database_owner',
    );
  }

  // RED: object class / scope refusals
  {
    const table = normalizeObservedOwnerAzure('azuresu', { kind: 'relation', name: 'bookings', identity: 'bookings' });
    pass('red-azuresu-table-owner-not-normalized', !table.applied && table.owner === 'azuresu');
    const typ = normalizeObservedOwnerAzure('azuresu', { kind: 'type', name: 'foo', identity: 'foo' });
    pass('red-azuresu-type-owner-not-normalized', !typ.applied && typ.owner === 'azuresu');
    const sch2 = normalizeObservedOwnerAzure('azuresu', { kind: 'schema', name: 'public', identity: 'public' });
    pass('red-azuresu-schema-owner-not-normalized', !sch2.applied && sch2.owner === 'azuresu');
    const otherSchema = normalizeObservedOwnerAzure('azure_pg_admin', {
      kind: 'schema',
      name: 'other',
      identity: 'other',
    });
    pass('red-azure-pg-admin-outside-public-not-normalized', !otherSchema.applied);
    const arb = normalizeObservedOwnerAzure('app_role', { kind: 'extension', name: 'pgcrypto', identity: 'pgcrypto' });
    pass('red-arbitrary-owner-not-normalized', !arb.applied && arb.owner === 'app_role');
  }

  // RED: unknown profile / non-Azure target
  {
    const unk = resolveNormalizationProfile('not_a_real_profile', AZURE_CTX);
    pass('red-unknown-profile', !unk.ok && unk.code === 'normalization_profile_unknown');
    const nonAzure = normalizeObservedIdentityPresentation(
      { ownership: [{ kind: 'extension', identity: 'pgcrypto', name: 'pgcrypto', owner: 'azuresu', subkind: '' }] },
      {
        profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
        azureContext: { verified: true, host: '127.0.0.1', database: 'sunset_staging' },
      },
    );
    pass('red-azure-profile-on-non-azure-target', !nonAzure.ok);
    const missingCtx = normalizeObservedIdentityPresentation(
      { ownership: [] },
      { profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1 },
    );
    pass('red-missing-azure-context', !missingCtx.ok);
  }

  // RED: ACL privilege broadenings still fail closed after normalization
  {
    const baseLive = {
      tables: [],
      columns: [],
      constraints: [],
      indexes: [],
      sequences: [],
      views: [],
      enums: [],
      functions: [],
      triggers: [],
      rlsFlags: [],
      rlsPolicies: [],
      ownership: [
        {
          kind: 'schema',
          name: 'public',
          identity: 'public',
          subkind: '',
          owner: 'azure_pg_admin',
        },
      ],
      acls: [
        {
          kind: 'schema',
          name: 'public',
          identity: 'public',
          subkind: '',
          acl: '=U/azure_pg_admin,azure_pg_admin=UC/azure_pg_admin',
        },
      ],
      extensions: [],
    };
    const baseExp = deepClone(baseLive);
    baseExp.ownership[0].owner = 'pg_database_owner';
    baseExp.acls[0].acl = '=U/pg_database_owner,pg_database_owner=UC/pg_database_owner';

    const green = compareSnapshots(baseExp, baseLive, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    pass('green-allowlisted-public-acl-and-owner-match', green.ok);

    const extraGrantee = deepClone(baseLive);
    extraGrantee.acls[0].acl = '=U/azure_pg_admin,azure_pg_admin=UC/azure_pg_admin,app_role=U/azure_pg_admin';
    const r1 = compareSnapshots(baseExp, extraGrantee, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    pass('red-extra-acl-grantee-fails', !r1.ok && r1.drifts.some((d) => d.section === 'acls'));

    const extraSelect = deepClone(baseLive);
    extraSelect.acls[0].acl = '=UC/azure_pg_admin,azure_pg_admin=UC/azure_pg_admin';
    const r2 = compareSnapshots(baseExp, extraSelect, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    pass('red-extra-privilege-fails', !r2.ok);

    const grantOpt = deepClone(baseLive);
    grantOpt.acls[0].acl = '=U*/azure_pg_admin,azure_pg_admin=UC/azure_pg_admin';
    const r3 = compareSnapshots(baseExp, grantOpt, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    pass('red-grant-option-broadening-fails', !r3.ok);

    const publicBroad = deepClone(baseLive);
    publicBroad.acls[0].acl = '=UC/azure_pg_admin,azure_pg_admin=UC/azure_pg_admin';
    const r4 = compareSnapshots(baseExp, publicBroad, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    pass('red-public-privilege-broadening-fails', !r4.ok);

    const appOwner = deepClone(baseLive);
    appOwner.ownership[0].owner = 'staff_api_role';
    const r5 = compareSnapshots(baseExp, appOwner, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    pass('red-owner-changed-to-application-role-fails', !r5.ok);
  }

  // Evidence totals 88 → 46
  pass('evidence-totals-88-42-46',
    evidence.totals.originalMismatchCount === 88
    && evidence.totals.normalizedAway === 42
    && evidence.totals.remainingMismatchCount === 46
    && evidence.totals.trajectory === '88 → 46'
    && (evidence.originalKeys || []).length === 88
    && (evidence.normalizedAwayKeys || []).length === 42
    && (evidence.remainingKeys || []).length === 46);

  const classNorm = (classReport.classifications || [])
    .filter((c) => c.classification === 'observer_normalization_difference')
    .map((c) => c.stableKey)
    .sort();
  const classSub = (classReport.classifications || [])
    .filter((c) => c.classification !== 'observer_normalization_difference')
    .map((c) => c.stableKey)
    .sort();
  const evNorm = [...evidence.normalizedAwayKeys].sort();
  const evRem = [...evidence.remainingKeys].sort();
  pass('all-42-normalization-keys-disappear',
    classNorm.length === 42
    && evNorm.length === 42
    && classNorm.every((k, i) => k === evNorm[i])
    && evRem.every((k) => !classNorm.includes(k)));
  pass('remaining-equals-other-46-exactly',
    classSub.length === 46
    && evRem.length === 46
    && classSub.every((k, i) => k === evRem[i]));
  pass('no-substantive-classification-key-disappears',
    classSub.every((k) => evRem.includes(k))
    && evidence.remainingByClassification
    && evidence.remainingByClassification.genuine_database_drift === 29
    && evidence.remainingByClassification.canonical_manifest_question === 17);

  pass('per-key-mapping-rules-and-privilege-unchanged',
    Array.isArray(evidence.perKeyMappingRules)
    && evidence.perKeyMappingRules.length === 42
    && evidence.perKeyMappingRules.every((r) => r.rule && r.privilegeSetUnchanged === true)
    && evidence.privilegeSetUnchangedForAllNormalizedKeys === true);

  // Idempotency
  {
    const snap = {
      ownership: [
        { kind: 'extension', name: 'pgcrypto', identity: 'pgcrypto', subkind: '', owner: 'azuresu' },
      ],
      extensions: [{ name: 'pgcrypto', version: '1.3', owner: 'azuresu', schema: 'public', relocatable: true, configRelations: '', configConditions: '' }],
      acls: [
        {
          kind: 'schema',
          name: 'public',
          identity: 'public',
          subkind: '',
          acl: '=U/azure_pg_admin,azure_pg_admin=UC/azure_pg_admin',
        },
      ],
    };
    const a = normalizeObservedIdentityPresentation(snap, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    const b = normalizeObservedIdentityPresentation(a.snapshot, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    pass(
      'green-normalization-idempotent',
      a.ok && b.ok && fingerprintProductSchema(a.snapshot) === fingerprintProductSchema(b.snapshot),
    );
  }

  // Connected dbOwner path preserved (existing behavior) — still present in lib
  pass('preserves-connected-db-owner-normalization',
    /function normalizeOwnerName/.test(libSrc)
    && /\$db_owner/.test(libSrc));

  // Contract Phase A complete; Phase B completed by Slice 13C.2; C–E remain pending
  pass('slice13c-contract-phase-a-complete-b-status',
    contract.phaseStatus
    && contract.phaseStatus.A === 'complete_offline_identity_normalization'
    && (contract.phaseStatus.B === 'pending' || contract.phaseStatus.B === 'complete_location_model_promotion')
    && contract.phaseStatus.C === 'pending'
    && contract.phaseStatus.D === 'pending'
    && contract.phaseStatus.E === 'pending'
    && contract.slice13c1PhaseA
    && contract.slice13c1PhaseA.normalizationProfile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1
    && contract.requirements.disposablePostgreSQLOnly === true
    && contract.liveApplyCapability === false);

  pass('findings-document-88-to-46',
    /88\s*→\s*46/.test(findings)
    && /azure_flexible_server_v1/.test(findings)
    && /do not claim/i.test(findings)
    && /46 substantive/.test(findings));

  // No live apply / repair SQL / fixture mutation in 13C.1 tooling
  const designBlob = [buildSrc, libSrc, observeSrc, findings, JSON.stringify(evidence)].join('\n');
  pass('no-live-apply-or-repair-sql',
    !/\bALTER\s+OWNER\s+TO\b/i.test(buildSrc)
    && !/\bLIVE_APPLY_ENABLED\b/.test(buildSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(buildSrc)
    && !/writeFileSync\([^)]*canonical-manifest/i.test(buildSrc)
    && evidence.containsLiveApplyCode === false);
  pass('observer-cli-enables-profile-only-on-locked-azure-target',
    /NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1/.test(observeSrc)
    && /allowLocal/.test(observeSrc));
  pass('canonical-fixture-fingerprint-13a-era-recorded',
    (expected.productFingerprint === CANON_FP || expected.previousProductFingerprint === CANON_FP)
    && evidence.fingerprints.canonicalExpected === CANON_FP
    && !/writeFileSync\([^)]*expected-product-schema/i.test(verifySrc));

  console.log(`\n── verify:sunset-schema-slice13c1 ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
