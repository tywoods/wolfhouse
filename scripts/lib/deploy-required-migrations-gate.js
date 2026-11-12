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

function missingCodeMigrations({ required, presentRelations }) {
  const present = presentRelations instanceof Set
    ? presentRelations
    : new Set([...(presentRelations || [])].map((r) => String(r).toLowerCase()));
  const missing = [];
  for (const [file, rels] of Object.entries(required || {})) {
    if ((rels || []).some((rel) => !present.has(String(rel).toLowerCase()))) {
      missing.push(file);
    }
  }
  return missing;
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

function listPublicRelationsViaPsql(exec, target) {
  const spec = FRANCE_TARGETS[target];
  if (!spec) {
    const err = new Error(`DEPLOY FAIL: unknown deploy target ${target}`);
    err.code = 'unknown_deploy_target';
    throw err;
  }
  let stdout;
  if (target === 'france-prod') {
    stdout = exec('sudo', ['docker', 'exec', spec.container, ...spec.args]);
  } else {
    stdout = exec('sudo', ['docker', 'exec', spec.container, ...spec.args, RELATIONS_SQL]);
  }
  return new Set(String(stdout || '').split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function assertDeployTargetHasCodeMigrations({ repoRoot, target, exec, presentRelations }) {
  const required = requiredRelationsByMigration(repoRoot);
  const present = presentRelations || listPublicRelationsViaPsql(exec, target);
  return assertCodeMigrationsApplied({ required, presentRelations: present });
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
};
