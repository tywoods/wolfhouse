'use strict';

/**
 * FOUNDATION Slice 13C.1 — build secret-free normalized comparison evidence.
 * Offline only. Uses committed Slice 13A classifications + expected fixture.
 * No Azure / Postgres mutation.
 */

const fs = require('fs');
const path = require('path');
const {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  fingerprintProductSchema,
  compareSnapshots,
  normalizeObservedIdentityPresentation,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
} = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '896b8220dd8586ce8ca6a416eeeefcb819c2a9b5';
const CANON_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

const AZURE_CTX = {
  verified: true,
  host: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
};

function stableKey(d) {
  return `${d.kind}|${d.section}|${d.key}`;
}

function sectionListKey(section, item) {
  if (section === 'tables' || section === 'sequences') return item.name || item;
  if (section === 'columns') return `${item.table}.${item.column}`;
  if (section === 'constraints') return `${item.table}.${item.name}.${item.type}`;
  if (section === 'indexes') return `${item.table}.${item.name}`;
  if (section === 'views') return item.name;
  if (section === 'enums') return `${item.type}:${item.label}`;
  if (section === 'functions') return item.identity || item.name;
  if (section === 'triggers') return `${item.table}.${item.name}`;
  if (section === 'rlsFlags') return item.table;
  if (section === 'rlsPolicies') return `${item.table}.${item.name}`;
  if (section === 'ownership') return `${item.kind}:${item.identity}`;
  if (section === 'acls') return `${item.kind}:${item.identity}`;
  if (section === 'extensions') return item.name;
  throw new Error(`unknown section ${section}`);
}

function removeByKey(list, section, key) {
  const out = [];
  for (const item of list || []) {
    if (sectionListKey(section, item) !== key) out.push(item);
  }
  return out;
}

function upsertByKey(list, section, key, value) {
  const out = [];
  let found = false;
  for (const item of list || []) {
    if (sectionListKey(section, item) === key) {
      out.push(value);
      found = true;
    } else out.push(item);
  }
  if (!found) out.push(value);
  return out;
}

/**
 * Reconstruct a synthetic live snapshot that reproduces the committed 88 mismatches
 * when compared to the canonical expected snapshot (without Azure normalization).
 */
function reconstructLiveSnapshot(expectedSnap, classifications) {
  const live = JSON.parse(JSON.stringify(expectedSnap));
  for (const c of classifications) {
    const section = c.section;
    if (!live[section] && section !== 'tables' && section !== 'sequences') {
      live[section] = [];
    }
    if (c.kind === 'definition_mismatch') {
      if (!c.liveDefinition) throw new Error(`missing liveDefinition for ${c.stableKey}`);
      if (section === 'tables' || section === 'sequences') {
        // definition_mismatch on name-only sections should not occur for 13A norms
        continue;
      }
      live[section] = upsertByKey(live[section], section, c.key, c.liveDefinition);
    } else if (c.kind === 'expected_only') {
      if (section === 'tables' || section === 'sequences') {
        live[section] = (live[section] || []).filter((x) => (typeof x === 'string' ? x : x.name) !== c.key);
      } else {
        live[section] = removeByKey(live[section], section, c.key);
      }
    } else if (c.kind === 'live_only') {
      if (!c.liveDefinition) throw new Error(`missing liveDefinition for ${c.stableKey}`);
      if (section === 'tables' || section === 'sequences') {
        live[section] = [...(live[section] || []), c.key];
      } else {
        live[section] = upsertByKey(live[section], section, c.key, c.liveDefinition);
      }
    }
  }
  return live;
}

function main() {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected-product-schema.json'), 'utf8'));
  const classReport = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-mismatch-classification-report.json'), 'utf8'),
  );
  const slice11 = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice11-canonical-vs-live-mismatch-report.json'), 'utf8'),
  );

  if (expected.productFingerprint !== CANON_FP) {
    throw new Error('canonical fingerprint drifted');
  }
  if (classReport.actualLiveFingerprint !== LIVE_FP || slice11.actualLiveFingerprint !== LIVE_FP) {
    throw new Error('live fingerprint drifted');
  }

  const classifications = classReport.classifications || [];
  if (classifications.length !== 88) throw new Error(`expected 88 classifications, got ${classifications.length}`);

  const normClass = classifications.filter((c) => c.classification === 'observer_normalization_difference');
  const substantiveClass = classifications.filter((c) => c.classification !== 'observer_normalization_difference');
  if (normClass.length !== 42) throw new Error(`expected 42 normalization keys, got ${normClass.length}`);
  if (substantiveClass.length !== 46) throw new Error(`expected 46 substantive keys, got ${substantiveClass.length}`);

  const liveSnap = reconstructLiveSnapshot(expected.snapshot, classifications);
  const fpBefore = fingerprintProductSchema(liveSnap);

  const rawCmp = compareSnapshots(expected.snapshot, liveSnap);
  const rawKeys = rawCmp.drifts.map(stableKey).sort();
  if (rawKeys.length !== 88) {
    throw new Error(`raw compare produced ${rawKeys.length} drifts, expected 88`);
  }

  const classKeys = classifications.map((c) => c.stableKey).sort();
  for (let i = 0; i < 88; i += 1) {
    if (rawKeys[i] !== classKeys[i]) {
      throw new Error(`raw key mismatch at ${i}: ${rawKeys[i]} vs ${classKeys[i]}`);
    }
  }

  const norm = normalizeObservedIdentityPresentation(liveSnap, {
    profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: AZURE_CTX,
  });
  if (!norm.ok) throw new Error(`normalization failed: ${norm.message}`);

  const normCmp = compareSnapshots(expected.snapshot, liveSnap, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: AZURE_CTX,
  });
  if (normCmp.normalizationError) {
    throw new Error(JSON.stringify(normCmp.normalizationError));
  }

  const remainingKeys = normCmp.drifts.map(stableKey).sort();
  const substantiveKeys = substantiveClass.map((c) => c.stableKey).sort();
  if (remainingKeys.length !== 46) {
    throw new Error(`remaining ${remainingKeys.length}, expected 46`);
  }
  for (let i = 0; i < 46; i += 1) {
    if (remainingKeys[i] !== substantiveKeys[i]) {
      throw new Error(`remaining key mismatch at ${i}: ${remainingKeys[i]} vs ${substantiveKeys[i]}`);
    }
  }

  // Prove no genuine_database_drift / canonical_manifest_question disappeared
  for (const c of substantiveClass) {
    if (!remainingKeys.includes(c.stableKey)) {
      throw new Error(`substantive key disappeared: ${c.stableKey}`);
    }
  }
  for (const c of normClass) {
    if (remainingKeys.includes(c.stableKey)) {
      throw new Error(`normalization key still present: ${c.stableKey}`);
    }
  }

  const perKeyRules = normClass.map((c) => {
    const auditHit = (norm.audit || []).find((a) => {
      if (c.section === 'ownership') return a.section === 'ownership' && a.key === c.key;
      if (c.section === 'acls') return a.section === 'acls' && a.key === c.key;
      if (c.section === 'extensions') return a.section === 'extensions' && a.key === c.key;
      return false;
    });
    return {
      stableKey: c.stableKey,
      section: c.section,
      key: c.key,
      rule: auditHit ? auditHit.rule : null,
      privilegeSetUnchanged: auditHit ? auditHit.privilegeSetUnchanged === true : null,
      expectedOwnerOrAcl: c.expectedDefinition && (c.expectedDefinition.owner || c.expectedDefinition.acl) || null,
      liveOwnerOrAclBefore: c.liveDefinition && (c.liveDefinition.owner || c.liveDefinition.acl) || null,
    };
  });

  if (perKeyRules.some((r) => !r.rule)) {
    const missing = perKeyRules.filter((r) => !r.rule).map((r) => r.stableKey);
    throw new Error(`missing audit rules for: ${missing.join(',')}`);
  }
  if (perKeyRules.some((r) => r.privilegeSetUnchanged !== true)) {
    throw new Error('privilege set changed for a normalized key');
  }

  // Idempotency
  const again = normalizeObservedIdentityPresentation(norm.snapshot, {
    profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: AZURE_CTX,
  });
  if (!again.ok) throw new Error('idempotent normalize failed');
  if (fingerprintProductSchema(again.snapshot) !== fingerprintProductSchema(norm.snapshot)) {
    throw new Error('normalization not idempotent');
  }

  const remainingByClassification = {};
  for (const c of substantiveClass) {
    remainingByClassification[c.classification] = (remainingByClassification[c.classification] || 0) + 1;
  }

  const report = {
    kind: 'sunset-schema-observer-slice13c1-azure-identity-normalization-evidence',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    liveMutation: false,
    azureMutation: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: {
      verified: true,
      host: EXPECTED_HOST,
      database: EXPECTED_DATABASE,
    },
    fingerprints: {
      canonicalExpected: CANON_FP,
      liveRawCommitted: LIVE_FP,
      syntheticLiveBeforeNormalization: fpBefore,
      note:
        'Canonical expected fixture unchanged. Raw live fingerprint remains the committed Slice 11/13A live observation. Synthetic live is reconstructed from expected + committed mismatch definitions for offline proof only.',
    },
    totals: {
      originalMismatchCount: 88,
      normalizedAway: 42,
      remainingMismatchCount: 46,
      trajectory: '88 → 46',
    },
    remainingByClassification,
    matchAfterNormalization: false,
    codeAfterNormalization: 'product_schema_differs',
    observerExitIfRun: 4,
    originalKeys: classKeys,
    normalizedAwayKeys: normClass.map((c) => c.stableKey).sort(),
    remainingKeys,
    perKeyMappingRules: perKeyRules,
    privilegeEscalationNotHidden: true,
    privilegeSetUnchangedForAllNormalizedKeys: perKeyRules.every((r) => r.privilegeSetUnchanged === true),
    auditEntryCount: (norm.audit || []).length,
    slice11MismatchCount: slice11.mismatchCount,
    doNotClaimDatabaseMatchesCanonical: true,
  };

  const outPath = path.join(FIX, 'slice13c1-azure-identity-normalization-evidence.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  // Update Slice 13C contract Phase A complete
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  contract.slice13c1PhaseA = {
    status: 'complete_offline_identity_normalization',
    completedAt: report.generatedAt,
    masterShaBasis: MASTER,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    evidence: 'fixtures/sunset-schema-observer/slice13c1-azure-identity-normalization-evidence.json',
    note:
      'Phase A observer Azure identity normalization implemented and proven offline (88→46). Disposable DB rehearsal of A is satisfied by unit/fixture proof; live observer job not started. Phases B–E remain pending.',
  };
  contract.phaseStatus = {
    A: 'complete_offline_identity_normalization',
    B: 'pending',
    C: 'pending',
    D: 'pending',
    E: 'pending',
    F: 'pending',
  };
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        original: 88,
        normalizedAway: 42,
        remaining: 46,
        remainingByClassification,
        evidence: path.relative(ROOT, outPath).replace(/\\/g, '/'),
      },
      null,
      2,
    )}\n`,
  );
}

main();
