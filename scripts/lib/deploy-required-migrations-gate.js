'use strict';

/**
 * Deploy finish gate: the DB must already have every numbered migration the
 * code tree creates tables for. Deploy does not apply SQL here — it fails loud
 * so a land cannot claim DONE while 132/133 (or later) are missing.
 */

const fs = require('node:fs');
const path = require('node:path');

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?(?:("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*\.\s*)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi;

function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function identName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).toLowerCase();
  }
  return s.toLowerCase();
}

function numberedMigrationFiles(repoRoot) {
  const dir = path.join(repoRoot, 'database', 'migrations');
  return fs.readdirSync(dir)
    .filter((name) => /^\d{3}_.+\.sql$/i.test(name))
    .filter((name) => !/_down\.sql$/i.test(name))
    .filter((name) => !/PROPOSED/i.test(name))
    .sort();
}

function createdRelationsFromSql(sql) {
  const out = [];
  const seen = new Set();
  CREATE_TABLE_RE.lastIndex = 0;
  let m;
  const text = stripSqlComments(sql);
  while ((m = CREATE_TABLE_RE.exec(text))) {
    const schema = identName(m[1]);
    const table = identName(m[2]);
    if (!table) continue;
    if (schema && schema !== 'public') continue;
    if (seen.has(table)) continue;
    seen.add(table);
    out.push(table);
  }
  return out;
}

const SUCCESSOR_RELATIONS = Object.freeze({ hostels: 'clients' });

function normalizeMigrationId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^.*\//, '')
    .replace(/\.sql$/, '');
}

function isOtherProductRelation(rel) {
  const name = String(rel || '').toLowerCase();
  return /^(tenant_|luna_guest_|waiver_|broadcast)/.test(name)
    || name.startsWith('staff_automated_notification');
}

function relationPresent(rel, present) {
  const name = String(rel || '').toLowerCase();
  if (present.has(name)) return true;
  const successor = SUCCESSOR_RELATIONS[name];
  return !!(successor && present.has(String(successor).toLowerCase()));
}

function appliedIdSet(appliedMigrationIds) {
  const out = new Set();
  for (const id of appliedMigrationIds || []) {
    const n = normalizeMigrationId(id);
    if (!n) continue;
    out.add(n);
    out.add(`${n}.sql`);
  }
  return out;
}

function missingCodeMigrations({ required, presentRelations, appliedMigrationIds, extraPending, naive } = {}) {
  const present = presentRelations instanceof Set
    ? presentRelations
    : new Set([...(presentRelations || [])].map((r) => String(r).toLowerCase()));
  const applied = appliedIdSet(appliedMigrationIds);
  const missing = [];
  for (const [file, rels] of Object.entries(required || {})) {
    if (!naive && applied.has(normalizeMigrationId(file))) continue;
    const names = rels || [];
    if (!naive && names.length && names.every(isOtherProductRelation)) continue;
    const absent = names.some((rel) => {
      if (naive) return !present.has(String(rel).toLowerCase());
      return !relationPresent(rel, present);
    });
    if (absent) missing.push(file);
  }
  if (!naive) {
    for (const file of extraPending || []) {
      if (!missing.includes(file)) missing.push(file);
    }
  }
  return missing;
}

function requiredRelationsByMigration(repoRoot) {
  const dir = path.join(repoRoot, 'database', 'migrations');
  const required = {};
  for (const name of numberedMigrationFiles(repoRoot)) {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const rels = createdRelationsFromSql(sql);
    if (rels.length) required[name] = rels;
  }
  return required;
}

function formatDeployFail(missing) {
  const list = (missing || []).join(', ') || '(unknown)';
  return `DEPLOY FAIL: database missing migrations the code needs: ${list}`;
}

function assertCodeMigrationsApplied(opts) {
  const missing = missingCodeMigrations(opts || {});
  if (missing.length) {
    const err = new Error(formatDeployFail(missing));
    err.code = 'missing_code_migrations';
    err.missing = missing;
    throw err;
  }
  return { ok: true, missing: [] };
}

const FRANCE_TARGETS = {
  'france-staging': {
    container: 'ovh-pg',
    args: ['psql', '-U', 'postgres', '-d', 'wolfhouse_staging', '-tAc'],
  },
  'france-prod': {
    container: 'wolfhouse-prod-postgres',
    args: ['sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = \'public\' AND c.relkind = \'r\'"'],
  },
};

const RELATIONS_SQL = "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'";
const LEDGER_EXISTS_SQL = "SELECT COALESCE(to_regclass('public.schema_migration_ledger')::text, '')";
const LEDGER_IDS_SQL = "SELECT id FROM schema_migration_ledger";
const DESIGNATION_PENDING_SQL = "SELECT CASE WHEN to_regclass('public.rooms') IS NULL OR to_regclass('public.clients') IS NULL THEN '' WHEN EXISTS (SELECT 1 FROM rooms r JOIN clients c ON c.id = r.client_id WHERE c.slug IN ('wolfhouse-somo','sunset') AND (r.often_used_by_operator IS TRUE OR lower(btrim(r.room_type)) = 'operator_surfweek')) THEN '135_remove_operator_room_designation.sql' ELSE '' END";

function psqlExec(exec, target, sql) {
  const spec = FRANCE_TARGETS[target];
  if (!spec) {
    const err = new Error(`DEPLOY FAIL: unknown deploy target ${target}`);
    err.code = 'unknown_deploy_target';
    throw err;
  }
  if (target === 'france-prod') {
    const wrapped = `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc ${JSON.stringify(sql)}`;
    return exec('sudo', ['docker', 'exec', spec.container, 'sh', '-c', wrapped]);
  }
  return exec('sudo', ['docker', 'exec', spec.container, ...spec.args, sql]);
}

function listPublicRelationsViaPsql(exec, target) {
  const stdout = psqlExec(exec, target, RELATIONS_SQL);
  return new Set(String(stdout || '').split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function listAppliedMigrationIdsViaPsql(exec, target) {
  const exists = String(psqlExec(exec, target, LEDGER_EXISTS_SQL) || '').trim();
  if (!exists) return [];
  return String(psqlExec(exec, target, LEDGER_IDS_SQL) || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function listEffectPendingViaPsql(exec, target) {
  const pending = String(psqlExec(exec, target, DESIGNATION_PENDING_SQL) || '').trim();
  return pending ? [pending] : [];
}

function assertDeployTargetHasCodeMigrations({
  repoRoot, target, exec, presentRelations, appliedMigrationIds, extraPending,
}) {
  const required = requiredRelationsByMigration(repoRoot);
  const present = presentRelations || listPublicRelationsViaPsql(exec, target);
  const applied = appliedMigrationIds != null
    ? appliedMigrationIds
    : (presentRelations ? [] : listAppliedMigrationIdsViaPsql(exec, target));
  const pending = extraPending != null
    ? extraPending
    : (presentRelations ? [] : listEffectPendingViaPsql(exec, target));
  return assertCodeMigrationsApplied({
    required,
    presentRelations: present,
    appliedMigrationIds: applied,
    extraPending: pending,
  });
}

module.exports = {
  numberedMigrationFiles,
  createdRelationsFromSql,
  requiredRelationsByMigration,
  missingCodeMigrations,
  formatDeployFail,
  assertCodeMigrationsApplied,
  listPublicRelationsViaPsql,
  assertDeployTargetHasCodeMigrations,
  FRANCE_TARGETS,
  RELATIONS_SQL,
  LEDGER_EXISTS_SQL,
  LEDGER_IDS_SQL,
  DESIGNATION_PENDING_SQL,
  SUCCESSOR_RELATIONS,
  normalizeMigrationId,
};
