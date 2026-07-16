'use strict';

/**
 * One-shot migration: staff-tenant-scope-debt-registry v1 (file:line) → v2 (fingerprint).
 * Run from repo root: node scripts/migrate-staff-tenant-scope-debt-registry-v2.js
 */

const fs = require('fs');
const path = require('path');
const {
  scanSqlScopeDebt,
  buildRegistryEntryFromHotspot,
  classifyHotspotByEvidence,
} = require('./lib/staff-tenant-scope-hotspot');

const REPO_ROOT = path.join(__dirname, '..');
const V1_PATH = path.join(__dirname, 'fixtures', 'staff-tenant-scope-debt-registry.json');
const V1_HOTSPOTS_PATH = path.join(__dirname, 'fixtures', 'staff-tenant-scope-debt-hotspots.json');
const OUT_PATH = V1_PATH;

function loadV1() {
  const raw = fs.readFileSync(V1_PATH, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function snippetOverlap(a, b) {
  const na = String(a || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  const nb = String(b || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  if (!na || !nb) return 0;
  if (na.includes(nb) || nb.includes(na)) return 1;
  let shared = 0;
  const wordsA = na.split(/\W+/).filter(Boolean);
  for (const w of wordsA) {
    if (nb.includes(w) && w.length > 3) shared += 1;
  }
  return shared / Math.max(wordsA.length, 1);
}

function migrateV1Reason(v1Entry, hit) {
  if (!v1Entry) return null;
  if (v1Entry.status === 'ok' && v1Entry.risk === 'false_positive') {
    return {
      status: 'ok',
      risk: 'false_positive',
      reason: v1Entry.reason,
    };
  }
  if (v1Entry.status === 'todo' && v1Entry.risk === 'must_fix_before_live_multiclient') {
    const evidence = classifyHotspotByEvidence(hit);
    if (evidence.status === 'ok') return evidence;
    return {
      status: 'todo',
      risk: 'must_fix_before_live_multiclient',
      reason: v1Entry.reason,
      suggested_fix: v1Entry.suggested_fix,
    };
  }
  return {
    status: v1Entry.status,
    risk: v1Entry.risk,
    reason: v1Entry.reason,
    ...(v1Entry.suggested_fix ? { suggested_fix: v1Entry.suggested_fix } : {}),
  };
}

function findV1Match(v1Entries, hit) {
  let best = null;
  let bestScore = 0;
  for (const entry of v1Entries) {
    if (entry.file !== hit.file || entry.table !== hit.table) continue;
    const score = snippetOverlap(entry.snippet, hit.snippet);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore >= 0.35 ? best : null;
}

function main() {
  const v1 = loadV1();
  const { debt } = scanSqlScopeDebt(REPO_ROOT);
  const entries = [];
  const unmatchedV1 = [...(v1.entries || [])];

  for (const hit of debt) {
    const base = buildRegistryEntryFromHotspot(hit);
    const v1Match = findV1Match(v1.entries || [], hit);
    if (v1Match) {
      const idx = unmatchedV1.findIndex((e) => e.id === v1Match.id);
      if (idx >= 0) unmatchedV1.splice(idx, 1);
      const migrated = migrateV1Reason(v1Match, hit);
      if (migrated) {
        base.status = migrated.status;
        base.risk = migrated.risk;
        base.reason = migrated.reason;
        if (migrated.suggested_fix) base.suggested_fix = migrated.suggested_fix;
      }
      base.migrated_from_v1 = v1Match.id;
    }
    entries.push(base);
  }

  if (unmatchedV1.length > 0) {
    console.error('Unmatched v1 registry entries (retired hotspots):');
    for (const e of unmatchedV1) {
      console.error(`  ${e.id} ${e.file}:${e.line}`);
    }
  }

  const byStatus = { ok: 0, todo: 0 };
  const byRisk = {
    false_positive: 0,
    ok_session_or_indirect_scope: 0,
    must_fix_before_shared_staging_router: 0,
    must_fix_before_live_multiclient: 0,
  };
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    byRisk[e.risk] = (byRisk[e.risk] || 0) + 1;
  }

  const out = {
    schema_version: 2,
    identity_model: 'fingerprint:v1',
    generated_from: 'scripts/migrate-staff-tenant-scope-debt-registry-v2.js',
    slice: 'wb-3-tenant-scope-debt-stable-identity',
    summary: {
      total: entries.length,
      by_status: byStatus,
      by_risk: byRisk,
    },
    entries: entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  hotspots: ${entries.length}`);
  console.log(`  by_status: ${JSON.stringify(byStatus)}`);
  console.log(`  by_risk: ${JSON.stringify(byRisk)}`);
  console.log(`  retired v1 entries: ${unmatchedV1.length}`);

  const todoCount = entries.filter((e) => e.status === 'todo').length;
  if (todoCount > 0) {
    console.log('\nRemaining todo entries:');
    for (const e of entries.filter((x) => x.status === 'todo')) {
      console.log(`  ${e.fingerprint} ${e.file}:${e.line} [${e.table}] ${e.reason}`);
    }
    process.exit(1);
  }
}

main();
