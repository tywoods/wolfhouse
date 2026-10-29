'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
const manifest = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'canonical-manifest.json'), 'utf8'));

function withoutComments(sql) {
  return String(sql).replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function createdRelations(sql) {
  return [...withoutComments(sql).matchAll(
    /\bCREATE\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)/gi,
  )].map((match) => match[1].toLowerCase());
}

test('executable migrations do not depend on relations created only by proposed migrations', () => {
  const proposedOwners = new Map();
  for (const entry of manifest.entries.filter((item) => item.classification === 'proposed_not_executable')) {
    const sql = fs.readFileSync(path.join(migrationsDir, entry.filename), 'utf8');
    for (const relation of createdRelations(sql)) proposedOwners.set(relation, entry.id);
  }

  const missing = [];
  for (const entry of manifest.entries.filter((item) => item.classification === 'canonical_forward')) {
    const sql = withoutComments(fs.readFileSync(path.join(migrationsDir, entry.filename), 'utf8')).toLowerCase();
    for (const [relation, owner] of proposedOwners) {
      if (new RegExp(`\\b${relation}\\b`).test(sql)) {
        missing.push(`${entry.id} requires ${relation} from proposed ${owner}`);
      }
    }
  }

  assert.deepEqual(missing, [], `canonical forward-chain prerequisites are not executable:\n${missing.join('\n')}`);
});
