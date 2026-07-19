'use strict';

/**
 * FOUNDATION Slice 13B — build design-only reconciliation artifacts from committed 13A evidence.
 * No Azure / Postgres / live mutation. No executable repair SQL.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '5dc43550d0197efacbb59dab4657960d2aaa36eb';
const CANON_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const LIVE_FP = 'fa7efa9246c2bd75fe41741652c462bb98b3c571906635e55a91ae5735ca1dfd';

function sha256Text(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function assignPhase(stableKey, classification) {
  if (classification === 'observer_normalization_difference') {
    return {
      phaseId: 'A',
      resolution: 'observer_normalization_no_database_mutation',
      rationale: 'Azure Flexible Server identity/ownership/ACL presentation vs local $db_owner fixtures',
    };
  }
  if (classification === 'canonical_manifest_question') {
    return {
      phaseId: 'B',
      resolution: 'promote_location_aware_model_into_canonical_forward',
      rationale: 'Live location_id / *_loc uniques match proposed 023/025 and multi-location Staff/Luna code',
    };
  }
  if (stableKey.includes('customer_message_templates')) {
    return {
      phaseId: 'C',
      resolution: 'additive_apply_migration_035',
      rationale: 'Absent live; CREATE TABLE IF NOT EXISTS + index; no seed',
    };
  }
  if (
    stableKey.startsWith('live_only|columns|tenant_services.')
  ) {
    return {
      phaseId: 'C',
      resolution: 'additive_promote_live_tenant_services_columns',
      rationale: 'Staff ensure-DDL columns required by SaaS catalog/room-block features',
    };
  }
  if (
    stableKey.includes('client_notification')
    || stableKey.includes('tenant_surf_pack_rules')
  ) {
    return {
      phaseId: 'C',
      resolution: 'additive_index_fk_trigger_reconciliation',
      rationale: 'Missing expected indexes/FK/trigger; additive and non-destructive',
    };
  }
  if (
    stableKey.includes('tenant_services_date_window')
    || stableKey.includes('tenant_services_price_unit')
  ) {
    return {
      phaseId: 'D',
      resolution: 'constraint_add_after_preflight_violation_counts',
      rationale: 'Missing CHECK constraints; data-sensitive — require aggregate violation counts before ADD',
    };
  }
  throw new Error(`unmapped mismatch key: ${stableKey}`);
}

function main() {
  const classification = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-mismatch-classification-report.json'), 'utf8'),
  );
  const decisions13a = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-operator-decision-list.json'), 'utf8'),
  );
  const provenance = JSON.parse(
    fs.readFileSync(path.join(FIX, 'slice13a-migration-provenance-matrix.json'), 'utf8'),
  );

  const items = classification.classifications || [];
  if (items.length !== 88) throw new Error(`expected 88 classifications, got ${items.length}`);

  const mapEntries = items.map((c) => {
    const a = assignPhase(c.stableKey, c.classification);
    return {
      stableKey: c.stableKey,
      kind: c.kind,
      section: c.section,
      key: c.key,
      classification: c.classification,
      phaseId: a.phaseId,
      resolution: a.resolution,
      rationale: a.rationale,
    };
  });

  const phaseCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const e of mapEntries) phaseCounts[e.phaseId] += 1;
  if (phaseCounts.A + phaseCounts.B + phaseCounts.C + phaseCounts.D !== 88) {
    throw new Error(`phase map does not sum to 88: ${JSON.stringify(phaseCounts)}`);
  }
  const keys = mapEntries.map((e) => e.stableKey);
  if (new Set(keys).size !== 88) throw new Error('duplicate stableKeys in map');

  const mismatchToPhase = {
    kind: 'sunset-schema-observer-slice13b-mismatch-to-phase-map',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    sourceClassificationReport: 'fixtures/sunset-schema-observer/slice13a-mismatch-classification-report.json',
    canonicalExpectedFingerprint: CANON_FP,
    actualLiveFingerprint: LIVE_FP,
    mismatchCount: 88,
    phaseCounts,
    phaseCountsNote:
      'Phases E (ledger bootstrap) and F (canonical verification) resolve zero of the 88 catalog mismatches; they are sequencing/governance phases. Every mismatch key maps to exactly one of A–D.',
    entries: mapEntries,
    contentHash: null,
  };
  mismatchToPhase.contentHash = sha256Text(
    JSON.stringify({
      mismatchCount: 88,
      phaseCounts,
      keys: mapEntries.map((e) => ({ k: e.stableKey, p: e.phaseId })),
    }),
  );

  const decisionRecord = {
    kind: 'sunset-schema-observer-slice13b-decision-record',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    liveMutation: false,
    designOnly: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    inputs: {
      slice13aClassification: 'fixtures/sunset-schema-observer/slice13a-mismatch-classification-report.json',
      slice13aProvenance: 'fixtures/sunset-schema-observer/slice13a-migration-provenance-matrix.json',
      slice13aDecisions: 'fixtures/sunset-schema-observer/slice13a-operator-decision-list.json',
      slice13a1ChecksumMode: 'canonical_lf_v1',
      canonicalFingerprint: CANON_FP,
      liveFingerprint: LIVE_FP,
      observerExit: 4,
      observerMismatchCount: 88,
    },
    priorDecisionsPreserved: (decisions13a.items || []).map((d) => ({
      id: d.id,
      status: d.status,
    })),
    decisions: [
      {
        id: 'DEC-001',
        topic: 'Azure ownership/ACL/extension observer normalization',
        recommendedDecision:
          'Implement observer-only Azure identity normalization in a later repair/observer slice. Do not ALTER OWNER, GRANT/REVOKE, or rewrite ACLs on live Sunset merely to match local fixture role names.',
        status: 'approved_direction_observer_normalization',
        confidence: 'high',
        operatorApprovalRequired: true,
        evidence: [
          'Slice 13A classified 42 definition_mismatch rows as observer_normalization_difference (azuresu / azure_pg_admin vs $db_owner / pg_database_owner).',
          'scripts/lib/sunset-schema-observer.js normalizeOwnerName only rewrites the connected datdba name to $db_owner; it does not map Azure Flexible Server system roles.',
          'Product fingerprint excludes ledger; ownership presentation is environment identity, not tenant privilege model.',
        ],
        alternativesRejected: [
          {
            alternative: 'ALTER OWNER / ACL rewrite on live to match $db_owner',
            reason: 'Mutates Azure-managed identities; forbidden; does not improve product schema truth',
          },
          {
            alternative: 'Bless live owners into canonical fixture without normalization policy',
            reason: 'Would encode Azure-specific role names into canonical product contract and hide cross-env comparison',
          },
          {
            alternative: 'Ignore ownership/ACL/extension sections entirely',
            reason: 'Could hide genuine privilege escalation or ACL broadenings',
          },
        ],
        normalizationPolicy: {
          mode: 'observer_only',
          databaseMutationAllowed: false,
          allowedSemanticEquivalenceMappings: [
            {
              from: ['azuresu'],
              to: '$db_owner',
              appliesTo: ['extension_owner', 'function_owner'],
              condition:
                'Only when the role is an Azure Flexible Server system superuser/extension owner and the privilege set being compared is ownership identity presentation — not EXECUTE/GRANT broadenings',
            },
            {
              from: ['azure_pg_admin', 'pg_database_owner'],
              to: 'pg_database_owner',
              appliesTo: ['schema_owner', 'acl_grantor_on_schema_public'],
              condition:
                'Only when comparing public schema owner/grantor identity between Azure Flexible Server and local docker fixtures',
            },
            {
              from: ['<connected_datdba_role_name>'],
              to: '$db_owner',
              appliesTo: ['any_owner_field'],
              condition: 'Existing behavior: rewrite exact connected database owner name to $db_owner',
            },
          ],
          forbidden: [
            'Treat PUBLIC or additional roles gaining SELECT/INSERT/UPDATE/DELETE/EXECUTE as equivalent',
            'Collapse distinct privilege grants into a single owner token',
            'Hide ACL widenings (extra grantees, broader privileges, WITH GRANT OPTION additions)',
            'Map arbitrary custom roles to $db_owner',
            'Normalize away ownership when live owner is a least-privilege app role that should not own extensions',
            'Any SQL that ALTER OWNER / GRANT / REVOKE on live',
          ],
          privilegeEscalationDetection:
            'After identity normalization, ACL and ownership comparisons must still fail closed on grantee set expansion, privilege bit expansion, or owner moving from system/extension identity to an application login with broader effective rights than expected.',
        },
        compatibilitySecurityConsequences: {
          staffApi: 'none — observer presentation only',
          security:
            'Reduces false-positive drift noise without mutating privileges; still detects ACL broadenings and unexpected owners',
        },
        abortCondition:
          'ABORT if proposed observer change would equate any ACL with strictly more grantees or privileges than expected after mapping, or if any mapping targets a non-allowlisted role name.',
      },
      {
        id: 'DEC-002',
        topic: 'location_id / *_loc unique indexes vs pre-location canonical uniques',
        recommendedDecision:
          'Approve forward-compatible multi-location SaaS direction: later promote proposed 023 (location_id + *_loc uniques) and 025 (lesson time capacity) into the canonical forward chain and regenerate the expected product-schema fixture. Do not revert live location-aware admin-rule tables. Do not modify schema or canonical manifest in Slice 13B.',
        status: 'approved_direction_promote_location_model',
        confidence: 'high',
        operatorApprovalRequired: true,
        evidence: [
          '17 Slice 13A canonical_manifest_question mismatches: live has location_id + *_loc uniques; canonical expects pre-location uniques.',
          'database/migrations/023_sunset_admin_location_id_PROPOSED.sql and 025_sunset_lesson_time_capacity_PROPOSED.sql match live shape but are proposed_not_executable.',
          'Staff/Luna multi-school routing already uses location_id (sunset-hermes-tenant-router, sunset-school-locations, catalog/admin price identity paths).',
          'Reverting live would be data-sensitive and conflict with current product behavior.',
        ],
        alternativesRejected: [
          {
            alternative: 'Revert live toward pre-location uniques',
            reason: 'Data-sensitive; breaks multi-location SaaS direction already used in code',
          },
          {
            alternative: 'Bless live schema as canonical without promoting migrations',
            reason: 'Forbidden; leaves forward chain and fixture divergent from intentional model',
          },
          {
            alternative: 'Modify canonical manifest/fixture in this design slice',
            reason: 'Slice 13B is design-only; promotion is Phase B of later repair',
          },
        ],
        proposedCanonicalDirection: {
          promoteMigrations: [
            '023_sunset_admin_location_id_PROPOSED.sql → new forward migration (filename/numbering TBD in repair slice)',
            '025_sunset_lesson_time_capacity_PROPOSED.sql → new forward migration',
          ],
          deferConversationLocation:
            '024_sunset_conversation_location_id_PROPOSED remains deferred (DDL commented; metadata JSON path in use)',
          regenerateExpectedFixture: true,
          doNotChangeInSlice13b: true,
        },
        compatibilitySecurityConsequences: {
          staffApi: 'Aligns canonical contract with location-aware admin rules already exercised by Staff/Luna',
          security: 'Unique indexes become location-scoped; tenant isolation remains client_id + location_id',
        },
        abortCondition:
          'ABORT Phase B if promoting would drop or rewrite live location_id data, or if Staff API paths still require pre-location uniqueness semantics.',
      },
      {
        id: 'DEC-003',
        topic: 'Migration 035_customer_message_templates',
        recommendedDecision:
          'Approve additive introduction of customer_message_templates in a later repair phase (Phase C) via existing forward migration 035. No seed/backfill required. Not applied in 13B.',
        status: 'approved_direction_additive_035',
        confidence: 'high',
        operatorApprovalRequired: true,
        evidence: [
          '17 expected_only mismatches for table/columns/PK/FK/index/ownership/ACL/RLS — table absent live.',
          '035 uses CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS; empty table; no seed.',
          'scripts/lib/staff-customer-message-templates.js already implements CRM templates and tolerates missing relation.',
          'Provenance: appearsSafelyAdditive=true, seedOrBackfillRequired=false.',
        ],
        alternativesRejected: [
          {
            alternative: 'Remove table from canonical fixture',
            reason: 'Staff CRM feature depends on it; would bless live absence',
          },
          {
            alternative: 'Apply 035 in this design slice',
            reason: 'Forbidden live mutation / repair implementation',
          },
        ],
        dependencies: {
          table: 'customer_message_templates',
          columns: [
            'id',
            'client_id',
            'title',
            'body',
            'channel',
            'tags',
            'active',
            'created_at',
            'updated_at',
          ],
          primaryKey: 'customer_message_templates_pkey',
          foreignKeys: ['customer_message_templates_client_id_fkey → clients(id) ON DELETE CASCADE'],
          indexes: ['idx_customer_message_templates_client_active'],
          triggers: [],
          checkConstraints: [],
          requiresClientsTable: true,
          seedOrBackfillRequired: false,
        },
        compatibilityRollback: {
          compatibility: 'Staff API already handles missing table; after apply, templates CRUD becomes available',
          rollback:
            'Forward-recovery preferred; DROP TABLE only if rehearsal proves unused and operator explicitly approves (not default)',
        },
        abortCondition:
          'ABORT if live already has a conflicting customer_message_templates relation with incompatible columns, or if clients table is absent.',
      },
      {
        id: 'DEC-004',
        topic: 'tenant_services live-only columns vs missing CHECKs',
        recommendedDecision:
          'Treat live-only columns (weekdays, block_rooms_enabled, blocked_room_codes, room_block_booking_ids) as intentional SaaS catalog/room-block model — promote into a later additive forward migration (Phase C). Add missing CHECKs tenant_services_date_window and tenant_services_price_unit only in Phase D after preflight violation-count queries return zero (or after documented remediation). Do not DROP live columns. Do not inspect product-row contents in 13B.',
        status: 'approved_direction_promote_columns_then_constraints',
        confidence: 'high',
        operatorApprovalRequired: true,
        evidence: [
          '4 live_only tenant_services columns from Staff ensure-DDL (tenant-services-writes.js / tenant-service-room-blocks.js).',
          '2 expected_only CHECK constraints from 028_tenant_services.sql absent live.',
          'schedule_slots already in canonical 028 — not a live-only drift.',
        ],
        alternativesRejected: [
          {
            alternative: 'DROP live-only columns to match current canonical 028',
            reason: 'Destroys product features (room blocks / weekdays)',
          },
          {
            alternative: 'ADD CHECK without preflight counts',
            reason: 'May fail mid-transaction or leave invalid rows blocked',
          },
          {
            alternative: 'Read product row values now',
            reason: 'Forbidden in 13B; specify aggregate queries for later rehearsal only',
          },
        ],
        intendedSaasCatalogModel: {
          retainLiveColumns: [
            'weekdays',
            'block_rooms_enabled',
            'blocked_room_codes',
            'room_block_booking_ids',
          ],
          restoreMissingChecks: ['tenant_services_date_window', 'tenant_services_price_unit'],
        },
        laterPreflightQueriesDesignOnly: [
          {
            purpose: 'count rows violating date_window CHECK semantics',
            sqlSketch:
              "SELECT count(*)::bigint AS violations FROM tenant_services WHERE NOT (/* date_window predicate matching 028 */);",
            note: 'Exact predicate copied from 028 in repair slice; aggregate count only — no row payloads',
          },
          {
            purpose: 'count rows violating price_unit CHECK semantics',
            sqlSketch:
              "SELECT count(*)::bigint AS violations FROM tenant_services WHERE NOT (/* price_unit predicate matching 028 */);",
            note: 'Aggregate count only',
          },
        ],
        compatibilitySecurityConsequences: {
          staffApi: 'Preserves room-block and weekday scheduling features',
          security: 'CHECK restoration improves invariant enforcement after clean preflight',
        },
        abortCondition:
          'ABORT Phase D if either violation count > 0 without an approved remediation plan; ABORT Phase C if promoting columns would require destructive type changes.',
      },
      {
        id: 'DEC-005',
        topic: 'schema_migration_ledger bootstrap',
        recommendedDecision:
          'Introduce fail-closed ledger bootstrap in Phase E after structural reconciliation. Never claim a migration was executed solely from numbering. Use canonical_lf_v1 hashes. Distinguish verified_structural_baseline vs executed_by_canonical_runner. Ambiguous 018/019/020 remain blocked until DEC-006 checks pass. Exact legacySha256 acceptance only under Slice 13A.1 contract.',
        status: 'approved_direction_fail_closed_ledger_bootstrap',
        confidence: 'high',
        operatorApprovalRequired: true,
        evidence: [
          'schema_migration_ledger absent live (Slice 13A).',
          'Catalog-signature inference is not byte-proven apply history.',
          'Slice 13A.1 ledgerChecksumAccepted: exact sha256 or exact legacySha256 only.',
        ],
        alternativesRejected: [
          {
            alternative: 'Backfill ledger rows for all 36 forwards from filename order alone',
            reason: 'Would falsely assert execution; forbidden',
          },
          {
            alternative: 'Skip ledger and continue catalog-only inference forever',
            reason: 'Blocks durable repair discipline and observer confidence',
          },
        ],
        specRef: 'fixtures/sunset-schema-observer/slice13b-ledger-bootstrap-spec.json',
        abortCondition:
          'ABORT if bootstrap would insert executed_by_canonical_runner without runner proof, or would mark ambiguous migrations as applied, or would accept a hash that is neither canonical_lf_v1 nor exact committed legacySha256.',
      },
      {
        id: 'DEC-006',
        topic: 'Ambiguous migrations 018 / 019 / 020',
        recommendedDecision:
          'Keep each migration blocked (not proven fully_applied) until exact metadata/aggregate checks defined in this record pass. Do not guess applied status. Do not auto-repair.',
        status: 'fail_closed_blocked_until_metadata_checks',
        confidence: 'high',
        operatorApprovalRequired: true,
        evidence: [
          'Slice 13A provenance: 018/019/020 inferredState=ambiguous (ALTER-only / weak signatures).',
          '020 is often a no-op on Sunset row sets but that is not apply proof.',
        ],
        alternativesRejected: [
          {
            alternative: 'Mark fully_applied because later migrations exist',
            reason: 'Numbering is not execution proof',
          },
          {
            alternative: 'Re-run migrations blindly on live',
            reason: 'May be non-idempotent or mask partial state; out of scope for design slice',
          },
        ],
        resolutionRequirements: [
          {
            migrationId: '018_booking_service_records_nullable_service_date',
            requiredChecks: [
              {
                id: '018-col-nullability',
                description:
                  'information_schema / pg_attribute confirms booking_service_records.service_date is nullable (attnotnull=false) matching 018 intent',
              },
              {
                id: '018-no-conflicting-check',
                description:
                  'No CHECK constraint remains that requires service_date IS NOT NULL (aggregate constraint catalog query)',
              },
            ],
            blockedUntil: 'all requiredChecks pass with evidence artifact in a later slice',
          },
          {
            migrationId: '019_bookings_language',
            requiredChecks: [
              {
                id: '019-column-present',
                description: 'pg_attribute confirms bookings.language column exists with expected type (text/varchar per 019)',
              },
              {
                id: '019-default-or-nullability',
                description: 'nullability/default matches 019 SQL (aggregate column metadata only)',
              },
            ],
            blockedUntil: 'all requiredChecks pass with evidence artifact in a later slice',
          },
          {
            migrationId: '020_wolfhouse_room_gender_metadata',
            requiredChecks: [
              {
                id: '020-columns-or-comment-present',
                description:
                  'Catalog shows room gender metadata columns/comments introduced by 020 exist on rooms (names per 020 SQL)',
              },
              {
                id: '020-aggregate-population-optional',
                description:
                  'Optional: count(*) of rooms where wolfhouse-somo metadata updated — aggregate only; zero rows on Sunset does not by itself prove apply, but non-zero matching predicate supports structural effect',
              },
            ],
            blockedUntil: 'column/comment catalog checks pass; do not infer solely from Sunset no-op row counts',
          },
        ],
        abortCondition:
          'ABORT any ledger bootstrap or repair phase that marks 018/019/020 as executed_by_canonical_runner or verified_structural_baseline without the requiredChecks evidence.',
      },
    ],
  };

  const phasedDesign = {
    kind: 'sunset-schema-observer-slice13b-phased-reconciliation-design',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    designOnly: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    startingObserver: { exitCode: 4, mismatchCount: 88 },
    fingerprints: { canonical: CANON_FP, live: LIVE_FP },
    phaseMismatchTotals: {
      A: phaseCounts.A,
      B: phaseCounts.B,
      C: phaseCounts.C,
      D: phaseCounts.D,
      E: phaseCounts.E,
      F: phaseCounts.F,
      sumMappedFrom88: phaseCounts.A + phaseCounts.B + phaseCounts.C + phaseCounts.D,
    },
    expectedMismatchCountTrajectory: [
      { afterPhase: null, mismatchCount: 88, note: 'current live vs current canonical fixture' },
      {
        afterPhase: 'A',
        mismatchCount: 46,
        note: 'Observer Azure normalization only — no DB mutation; 42 ownership/ACL/extension noise cleared',
      },
      {
        afterPhase: 'B',
        mismatchCount: 29,
        note: 'After promoting location model into canonical forward + regenerating expected fixture (live already location-aware)',
      },
      {
        afterPhase: 'C',
        mismatchCount: 2,
        note: 'After additive 035 + tenant_services columns + notification/surf-pack indexes/FK/trigger',
      },
      {
        afterPhase: 'D',
        mismatchCount: 0,
        note: 'After CHECK constraints added with zero preflight violations',
      },
      {
        afterPhase: 'E',
        mismatchCount: 0,
        note: 'Ledger bootstrap — product fingerprint sections exclude ledger',
      },
      {
        afterPhase: 'F',
        mismatchCount: 0,
        match: true,
        note: 'Canonical observer verification; second run no-op',
      },
    ],
    phases: [
      {
        id: 'A',
        title: 'Observer Azure normalization correction',
        mismatchKeysResolved: phaseCounts.A,
        expectedMismatchBefore: 88,
        expectedMismatchAfter: 46,
        prerequisites: [
          'Slice 13A classification committed',
          'DEC-001 operator approval of allowlisted mappings',
          'Observer image rebuild/deploy capability in a later slice (not 13B)',
        ],
        transactionalBoundary: 'none — code/config change to observer only',
        lockDowntimeExpectation: 'none on database; brief job image rollout only in later slice',
        staffApiCompatibility: 'unchanged',
        backupRestoreRequirement: 'not required for observer-only change',
        verification: [
          'Unit/RED tests: allowlisted azuresu/azure_pg_admin mappings succeed',
          'Unit/RED tests: ACL broadening still fails closed',
          'Disposable observer run against fixture with Azure-like owners → those 42 keys absent',
        ],
        rollbackOrForwardRecovery: 'Revert observer image/code; no DB rollback',
        redAbortConditions: [
          decisionRecord.decisions.find((d) => d.id === 'DEC-001').abortCondition,
          'ABORT if any database OWNER/ACL SQL is introduced',
        ],
        databaseMutation: false,
      },
      {
        id: 'B',
        title: 'Promote approved canonical forward model (location_id)',
        mismatchKeysResolved: phaseCounts.B,
        expectedMismatchBefore: 46,
        expectedMismatchAfter: 29,
        prerequisites: [
          'DEC-002 operator approval',
          'Phase A ideally complete (ordering preferred, not hard DB dependency)',
          'Design-reviewed forward migrations derived from 023/025 PROPOSED — still not applied in 13B',
        ],
        transactionalBoundary:
          'Later repair: migration apply transaction(s) only if live somehow lacks objects; expected path is fixture/manifest promotion because live already has location schema',
        lockDowntimeExpectation: 'low — primarily git/canonical fixture regeneration; live DDL only if drift from assumed live state',
        staffApiCompatibility: 'aligns contract with existing multi-location behavior',
        backupRestoreRequirement: 'logical backup before any live DDL if live differs from assumed location-aware state',
        verification: [
          'canonical forward includes location model',
          'expected-product-schema regenerated; productFingerprint updated only via migration-derived generator',
          'observer vs live: 17 location keys cleared',
        ],
        rollbackOrForwardRecovery:
          'Forward-fix preferred; do not drop location_id columns as rollback',
        redAbortConditions: [
          decisionRecord.decisions.find((d) => d.id === 'DEC-002').abortCondition,
          'ABORT if repair attempts to bless live without promoting migrations',
        ],
        databaseMutation: 'only in later repair if required; not in 13B',
      },
      {
        id: 'C',
        title: 'Additive schema reconciliation (035 + tenant_services columns + indexes/FK/trigger)',
        mismatchKeysResolved: phaseCounts.C,
        expectedMismatchBefore: 29,
        expectedMismatchAfter: 2,
        prerequisites: [
          'DEC-003 and DEC-004 (columns portion) operator approval',
          'Phase B complete or location mismatches otherwise accounted for',
          'clients table present for 035 FK',
          'Disposable rehearsal (Slice 13C) green',
        ],
        transactionalBoundary: 'each additive migration in its own ledgered transaction via canonical runner',
        lockDowntimeExpectation: 'short ACCESS EXCLUSIVE only around CREATE INDEX/TABLE; prefer CONCURRENTLY only if repair design explicitly allows and runner supports',
        staffApiCompatibility: '035 enables CRM templates; tenant_services columns already used by Staff ensure-DDL',
        backupRestoreRequirement: 'yes before live additive apply',
        verification: [
          '035 objects exist',
          'tenant_services live-only columns present in canonical fixture after promotion',
          'notification + surf-pack expected indexes/FK/trigger present',
          'mismatchCount decreases by 27',
        ],
        rollbackOrForwardRecovery: 'forward-recovery; avoid DROP unless rehearsal-proven safe',
        redAbortConditions: [
          decisionRecord.decisions.find((d) => d.id === 'DEC-003').abortCondition,
          'ABORT on non-additive conflict (existing incompatible relation/column type)',
        ],
        databaseMutation: 'later repair only',
        includes: {
          migration035: true,
          tenantServicesLiveColumns: true,
          notificationIndexes: true,
          surfPackFkIndexTrigger: true,
        },
      },
      {
        id: 'D',
        title: 'Constraint / data-sensitive reconciliation',
        mismatchKeysResolved: phaseCounts.D,
        expectedMismatchBefore: 2,
        expectedMismatchAfter: 0,
        prerequisites: [
          'Phase C complete',
          'Preflight violation counts == 0 for both CHECK predicates (aggregate queries only)',
          'DEC-004 operator approval for constraint add',
        ],
        transactionalBoundary: 'ADD CONSTRAINT in transaction after preflight; abort if validate fails',
        lockDowntimeExpectation: 'brief; CHECK validation may scan tenant_services',
        staffApiCompatibility: 'rejects invalid writes that previously slipped through',
        backupRestoreRequirement: 'yes',
        verification: [
          'both CHECK constraints present',
          'observer mismatchCount 0 for schema sections',
          'preflight counts archived as evidence',
        ],
        rollbackOrForwardRecovery: 'DROP CONSTRAINT forward-recovery only with approval if emergency',
        redAbortConditions: [
          decisionRecord.decisions.find((d) => d.id === 'DEC-004').abortCondition,
          'ABORT if violation count > 0',
        ],
        databaseMutation: 'later repair only',
      },
      {
        id: 'E',
        title: 'Ledger bootstrap',
        mismatchKeysResolved: 0,
        expectedMismatchBefore: 0,
        expectedMismatchAfter: 0,
        prerequisites: [
          'Phases A–D complete or observer already match=true for product schema',
          'DEC-005 / DEC-006 gates',
          'canonical_lf_v1 manifest available',
        ],
        transactionalBoundary: 'create ledger + insert bootstrap rows in controlled transaction(s)',
        lockDowntimeExpectation: 'minimal',
        staffApiCompatibility: 'none expected (ledger excluded from product fingerprint)',
        backupRestoreRequirement: 'yes',
        verification: [
          'ledger present',
          'no ambiguous migration marked applied',
          'checksums canonical_lf_v1 or exact legacySha256 only',
          'source/evidence columns populated per bootstrap spec',
        ],
        rollbackOrForwardRecovery: 'delete bootstrap rows only with operator approval; never invent replacements',
        redAbortConditions: [
          decisionRecord.decisions.find((d) => d.id === 'DEC-005').abortCondition,
          decisionRecord.decisions.find((d) => d.id === 'DEC-006').abortCondition,
        ],
        databaseMutation: 'later repair only',
        specRef: 'fixtures/sunset-schema-observer/slice13b-ledger-bootstrap-spec.json',
      },
      {
        id: 'F',
        title: 'Canonical observer verification and recovery',
        mismatchKeysResolved: 0,
        expectedMismatchBefore: 0,
        expectedMismatchAfter: 0,
        prerequisites: [
          'Phases A–E complete as applicable',
          'Observer image embeds regenerated expected fixture when Phase B/C/D changed canonical',
        ],
        transactionalBoundary: 'none — read-only observer',
        lockDowntimeExpectation: 'none',
        staffApiCompatibility: 'n/a',
        backupRestoreRequirement: 'n/a for verification itself',
        verification: [
          'manual observer job: match=true, mismatchCount=0, exit 0',
          'second run identical no-op',
          'failure-injection recovery drills only on disposable DBs (Slice 13C)',
        ],
        rollbackOrForwardRecovery: 'if mismatch returns, fail closed and re-enter appropriate phase — do not bless live',
        redAbortConditions: [
          'ABORT if operator proposes updating expected fixture from live dump',
          'ABORT if job is scheduled or write credentials are attached',
        ],
        databaseMutation: false,
      },
    ],
  };

  const ledgerSpec = {
    kind: 'sunset-schema-observer-slice13b-ledger-bootstrap-spec',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    designOnly: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    checksumMode: 'canonical_lf_v1',
    principles: [
      'Never claim a migration was executed solely from numbering or filename order',
      'Use canonical_lf_v1 hashes for new ledger writes',
      'Exact committed legacySha256 may be accepted only under Slice 13A.1 ledgerChecksumAccepted contract',
      'Ambiguous migrations remain blocked until DEC-006 checks pass',
      'Preserve source, evidence, and provenance for every bootstrapped row',
    ],
    rowKinds: {
      verified_structural_baseline: {
        meaning:
          'Catalog metadata (and optional aggregates) prove the migration’s structural effects are present; does NOT assert the canonical runner executed the file on this database',
        allowedWhen: [
          'Required object/column/constraint signatures for that migration are present',
          'DEC-006 migrations only after their requiredChecks pass',
        ],
        forbiddenWhen: [
          'Evidence is only “a later migration number exists”',
          'Partial or conflicting signatures',
        ],
        checksumField: 'canonical_lf_v1 sha256 from manifest entry (or exact legacySha256 only if documenting a pre-13A.1 ledger row being preserved — not preferred for new baseline rows)',
      },
      executed_by_canonical_runner: {
        meaning:
          'This database applied the migration file through runCanonicalMigrations (or successor) with advisory lock + transactional apply + ledger insert',
        allowedWhen: [
          'Runner proof exists (apply log/evidence artifact) for this environment',
          'Pre-apply checksum matched manifest under canonical_lf_v1',
        ],
        forbiddenWhen: [
          'Bootstrap-only inference',
          'Manual psql apply without runner evidence',
        ],
        checksumField: 'always entry.sha256 under canonical_lf_v1 at insert time',
      },
    },
    proposedLedgerExtensionsDesignOnly: {
      note: 'Additive columns for bootstrap provenance — design only; DDL occurs in later repair',
      columns: [
        {
          name: 'apply_kind',
          type: 'text',
          values: ['verified_structural_baseline', 'executed_by_canonical_runner'],
        },
        { name: 'evidence_ref', type: 'text', purpose: 'path or id of evidence artifact' },
        { name: 'provenance_notes', type: 'text', purpose: 'human-readable source of truth summary' },
        { name: 'checksum_mode', type: 'text', purpose: 'canonical_lf_v1' },
      ],
      compatibility:
        'Existing Slice 4 ledger shape remains readable; extensions are additive. Until migrated, bootstrap tooling must not pretend apply_kind exists on live.',
    },
    bootstrapAlgorithm: [
      '1. Ensure schema_migration_ledger exists (DDL from migration-integrity LEDGER_DDL + approved extensions).',
      '2. Load canonical manifest (checksumMode canonical_lf_v1).',
      '3. For each forward entry in order: evaluate structural signatures.',
      '4. If DEC-006 blocked → skip insert; leave gap recorded as blocked — fail closed on runner until resolved or explicitly waived by operator with new decision id.',
      '5. If structural signatures fully match → may insert verified_structural_baseline with evidence_ref.',
      '6. Never insert executed_by_canonical_runner during bootstrap.',
      '7. Partial matches → no row; record partial in evidence; block runner for that prefix.',
      '8. Future runner applies: only append executed_by_canonical_runner for unapplied ids; reconcileLedger accepts canonical sha256 or exact legacySha256 per 13A.1.',
    ],
    interactionWithFutureRunner: {
      reconcile:
        'Bootstrapped verified_structural_baseline rows count as applied for skip purposes only if checksum matches accept rules and apply_order forms a contiguous prefix without blocked gaps.',
      newApplies: 'Always insert executed_by_canonical_runner with canonical_lf_v1 hash.',
      blockedAmbiguous:
        'If 018/019/020 lack baseline rows, runner must fail closed on partial history rather than apply later migrations out of order.',
    },
    abortConditions: [
      'Inserting executed_by_canonical_runner without runner proof',
      'Accepting arbitrary checksums',
      'Marking ambiguous migrations applied without DEC-006 checks',
      'Claiming fully_applied from numbering alone',
    ],
  };

  const rehearsalContract = {
    kind: 'sunset-schema-observer-slice13b-slice13c-rehearsal-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    designOnly: true,
    generatedAt: new Date().toISOString(),
    masterShaBasis: MASTER,
    slice: '13C',
    purpose:
      'Disposable rehearsal of approved Slice 13B repair direction before any Sunset live apply slice',
    requirements: {
      disposablePostgreSQLOnly: true,
      forbiddenTargets: [
        'Azure Sunset staging',
        'Azure production',
        'Wolfhouse production',
        'any host matching migration-integrity FORBIDDEN_HOST_PATTERNS',
        'databases named sunset_staging / wolfhouse / prod',
      ],
      preState:
        'Construct disposable DB pre-state that reproduces the approved relevant drift subsets for phases under test (Azure-like owners for A; location-aware live shape for B; absent 035 and missing indexes for C; missing CHECKs with controllable violation rows for D RED paths).',
      repairToolingDefaultsDisabled: true,
      liveApplyCapability: false,
      canonicalObserverEndState: {
        match: true,
        mismatchCount: 0,
        exitCode: 0,
      },
      secondRunNoOp: true,
      failureInjection: [
        'Inject checksum mismatch → fail closed; prove rollback/no partial ledger claim',
        'Inject CHECK violation count > 0 → Phase D aborts before constraint add',
        'Inject ambiguous migration bootstrap attempt → rejected',
      ],
      successCriteria: [
        'Observer match=true / mismatchCount=0 on disposable DB after rehearsal repair path',
        'Second observer run identical no-op',
        'No code path can target live Sunset without explicit future operator-approved slice',
      ],
    },
    nonGoals: [
      'No live apply',
      'No Azure mutation',
      'No blessing live dumps into expected-product-schema.json',
      'No reading production/staging product-row payloads',
    ],
  };

  const findingsMd = `# FOUNDATION Slice 13B — Sunset schema reconciliation design (design only)

**Master basis:** \`${MASTER}\`
**Canonical fingerprint:** \`${CANON_FP}\`
**Live fingerprint:** \`${LIVE_FP}\`
**Current observer:** exit 4, mismatchCount=88

## Verdict

Approved **forward-only** reconciliation direction for Sunset schema drift and absent migration ledger. **Design only** — no repair implementation, rehearsal execution, or live mutation in this slice.

Do **not** bless live as canonical. Do **not** mutate ownership to match local role names. Do **not** invent ledger execution history from numbering.

## DEC recommendations (summary)

| ID | Direction | Status |
|----|-----------|--------|
| DEC-001 | Observer-only Azure identity normalization; no DB ownership mutation | approved_direction_observer_normalization |
| DEC-002 | Promote location_id / *_loc (+ capacity) into canonical forward later; do not revert live | approved_direction_promote_location_model |
| DEC-003 | Additive apply 035 later; no seed | approved_direction_additive_035 |
| DEC-004 | Promote live tenant_services columns; add CHECKs after violation-count preflight | approved_direction_promote_columns_then_constraints |
| DEC-005 | Fail-closed ledger bootstrap with verified_structural_baseline vs executed_by_canonical_runner | approved_direction_fail_closed_ledger_bootstrap |
| DEC-006 | Keep 018/019/020 blocked until exact metadata checks pass | fail_closed_blocked_until_metadata_checks |
| DEC-007 | Already resolved in Slice 13A.1 (\`canonical_lf_v1\`) | resolved_by_slice_13a1 |

## Mismatch totals by phase

| Phase | Keys | Role |
|-------|-----:|------|
| A | ${phaseCounts.A} | Observer Azure normalization (no DB mutation) |
| B | ${phaseCounts.B} | Promote location-aware canonical model |
| C | ${phaseCounts.C} | Additive schema (035, tenant_services columns, indexes/FK/trigger) |
| D | ${phaseCounts.D} | CHECK constraints after preflight counts |
| E | 0 | Ledger bootstrap (governance) |
| F | 0 | Canonical observer verification |
| **Sum A–D** | **88** | Every mismatch key maps exactly once |

Expected trajectory: 88 → 46 → 29 → 2 → 0 (then ledger + verify remain at 0).

## Artifacts

- \`slice13b-decision-record.json\`
- \`slice13b-phased-reconciliation-design.json\`
- \`slice13b-mismatch-to-phase-map.json\`
- \`slice13b-ledger-bootstrap-spec.json\`
- \`slice13b-slice13c-rehearsal-contract.json\`
- This findings note

## Forbidden (honored)

No Azure/PostgreSQL/schema/data/ledger/role/credential/image/job mutation. No observer job start. No executable live-apply tooling or repair SQL. No product-row reads. No canonical migration/hash/manifest/fixture changes in 13B.
`;

  fs.writeFileSync(path.join(FIX, 'slice13b-mismatch-to-phase-map.json'), `${JSON.stringify(mismatchToPhase, null, 2)}\n`);
  fs.writeFileSync(path.join(FIX, 'slice13b-decision-record.json'), `${JSON.stringify(decisionRecord, null, 2)}\n`);
  fs.writeFileSync(path.join(FIX, 'slice13b-phased-reconciliation-design.json'), `${JSON.stringify(phasedDesign, null, 2)}\n`);
  fs.writeFileSync(path.join(FIX, 'slice13b-ledger-bootstrap-spec.json'), `${JSON.stringify(ledgerSpec, null, 2)}\n`);
  fs.writeFileSync(path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json'), `${JSON.stringify(rehearsalContract, null, 2)}\n`);
  fs.writeFileSync(path.join(FIX, 'slice13b-findings.md'), findingsMd);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        phaseCounts,
        decisions: decisionRecord.decisions.map((d) => ({ id: d.id, status: d.status })),
      },
      null,
      2,
    )}\n`,
  );
}

main();
