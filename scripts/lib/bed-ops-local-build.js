/**
 * Shared helpers for local bed-ops workflow builds (Assign / Reassign / Cancel).
 * Neutralizes prod Airtable base → local test base (same as Main local Stripe fork).
 */
const { execSync } = require('child_process');

const PROD_AIRTABLE_BASE_ID = 'appOCWIN47Bui9CSS';
const TEST_AIRTABLE_BASE_ID = 'appiyO4FmkKsyHZdK';

const N8N_CONTAINER = 'n8n-main';
const N8N_POSTGRES_CONTAINER = 'n8n-postgres';

/**
 * Replace prod Airtable base ID in entire workflow tree (URLs, node params, cachedResultUrl).
 * Table IDs (tbl…) unchanged — duplicated test base keeps same table ids.
 * @param {object} workflow
 * @returns {{ workflow: object, baseReplacements: number }}
 */
function neutralizeProductionAirtableBase(workflow) {
  let json = JSON.stringify(workflow);
  const baseReplacements = json.split(PROD_AIRTABLE_BASE_ID).length - 1;
  json = json.split(PROD_AIRTABLE_BASE_ID).join(TEST_AIRTABLE_BASE_ID);
  return {
    workflow: JSON.parse(json),
    baseReplacements,
  };
}

/**
 * @param {object} workflow
 * @returns {{ ok: boolean, prodBaseHitCount: number, prodBaseNodes: string[] }}
 */
function verifyNoProdAirtableBase(workflow) {
  const prodBaseNodes = [];
  for (const node of workflow.nodes || []) {
    if (JSON.stringify(node).includes(PROD_AIRTABLE_BASE_ID)) {
      prodBaseNodes.push(node.name);
    }
  }
  return {
    ok: prodBaseNodes.length === 0,
    prodBaseHitCount: prodBaseNodes.length,
    prodBaseNodes,
  };
}

/**
 * @param {string} outImportPath absolute path to .n8n-import.json
 * @param {string} [remoteBasename] simple filename under /tmp/ (no spaces)
 * @returns {boolean|null} true on success, false on failure, null if docker unavailable
 */
function importWorkflowInactive(outImportPath, remoteBasename = 'bed-ops-local-import.json') {
  const remote = `/tmp/${remoteBasename.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch {
    console.log('Import skipped: docker CLI not available in this environment');
    console.log(`  docker cp "${outImportPath}" ${N8N_CONTAINER}:${remote}`);
    console.log(`  docker exec ${N8N_CONTAINER} n8n import:workflow --input=${remote}`);
    return null;
  }
  try {
    execSync(`docker cp "${outImportPath}" ${N8N_CONTAINER}:${remote}`, { stdio: 'inherit' });
    const out = execSync(`docker exec ${N8N_CONTAINER} n8n import:workflow --input=${remote}`, {
      encoding: 'utf8',
    });
    console.log(out.trim());
    console.log(`Import: OK (${remoteBasename}, active=false in JSON)`);
    return true;
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    if (err.stdout) console.error(String(err.stdout));
    if (err.stderr) console.error(String(err.stderr));
    return false;
  }
}

/**
 * Read-only query of n8n workflow_entity.active for given workflow ids.
 * @param {string[]} workflowIds
 * @returns {{ ok: boolean, rows: Array<{ id: string, name: string, active: boolean }>, error?: string }}
 */
function queryN8nWorkflowActive(workflowIds) {
  if (!workflowIds.length) return { ok: true, rows: [] };
  const idsSql = workflowIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  const sql = `SELECT id, name, active FROM workflow_entity WHERE id IN (${idsSql}) ORDER BY name;`;
  try {
    execSync('docker --version', { stdio: 'ignore' });
    execSync(`docker inspect ${N8N_POSTGRES_CONTAINER}`, { stdio: 'ignore' });
  } catch {
    return { ok: false, rows: [], error: 'docker or n8n-postgres container unavailable' };
  }
  try {
    const out = execSync(
      `docker exec ${N8N_POSTGRES_CONTAINER} psql -U n8n -d n8n -t -A -F "|" -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8' },
    );
    const rows = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, active] = line.split('|');
        return { id, name, active: active === 't' };
      });
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], error: err.message };
  }
}

function finalizeLocalBedOpsWorkflow(workflow, { workflowId, active = false } = {}) {
  const neutralized = neutralizeProductionAirtableBase(workflow);
  const payload = {
    ...neutralized.workflow,
    id: workflowId ?? neutralized.workflow.id,
    active,
  };
  return {
    workflow: payload,
    baseReplacements: neutralized.baseReplacements,
  };
}

module.exports = {
  PROD_AIRTABLE_BASE_ID,
  TEST_AIRTABLE_BASE_ID,
  neutralizeProductionAirtableBase,
  verifyNoProdAirtableBase,
  importWorkflowInactive,
  queryN8nWorkflowActive,
  finalizeLocalBedOpsWorkflow,
  N8N_CONTAINER,
};
