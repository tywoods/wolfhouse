#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage1-materialize — public-CLI Stage 1 gate (no certs/Azure/DB). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'onboard-client.js');
const LIB = path.join(ROOT, 'scripts', 'lib', 'messi-saas-stage1-materialize.js');
const SUBS = path.join(ROOT, 'fixtures/factory-client-productization/slice1c-substitutions-surf_house.json');
const gen = require('./lib/factory-slice1c-dry-run-generator');
let pass = 0; let fail = 0;
function ok(n, c, d) {
  if (c) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); }
}
const red = (n, c, d) => ok(`RED ${n}`, c, d);
const green = (n, c, d) => ok(`GREEN ${n}`, c, d);
const run = (a) => spawnSync(process.execPath, [CLI, ...a], {
  cwd: ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
});
const err = (r) => `${r.stderr || ''}${r.stdout || ''}`;
function listRel(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      for (const r of listRel(abs)) out.push(`${ent.name}/${r}`);
    } else out.push(ent.name);
  }
  return out.sort();
}
const leftovers = (p) => (fs.existsSync(p)
  ? fs.readdirSync(p).filter((n) => n.includes('.messi-saas1-')) : []);
function snap(p) {
  return fs.readdirSync(p).map((n) => {
    const a = path.join(p, n); const st = fs.lstatSync(a);
    if (st.isFile()) return `${n}:f:${gen.sha256Hex(fs.readFileSync(a))}`;
    if (st.isSymbolicLink()) return `${n}:l:${fs.readlinkSync(a)}`;
    return `${n}:d`;
  }).sort();
}

console.log('verify:messi-saas-stage1-materialize — MESSI SaaS Stage 1\n');
console.log('── Owner presence ──');
red('materialize_owner_exists', fs.existsSync(LIB));
let mat = null;
try { mat = require('./lib/messi-saas-stage1-materialize'); } catch (_) { mat = null; }
red('materialize_api', !!(mat && typeof mat.materializeDryRunTo === 'function'));
red('cli_documents_materialize_to', /--materialize-to/.test(fs.readFileSync(CLI, 'utf8')));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
red('package_script', pkg.scripts
  && pkg.scripts['verify:messi-saas-stage1-materialize']
    === 'node scripts/verify-messi-saas-stage1-materialize.js');
if (!mat || typeof mat.materializeDryRunTo !== 'function') {
  console.log(`\nRESULT: FAIL (RED)  pass=${pass} fail=${fail}`);
  process.exit(1);
}

const subs = JSON.parse(fs.readFileSync(SUBS, 'utf8'));
const preview = gen.generateDryRunPreview({
  repoRoot: ROOT, archetype: 'surf_house', mode: gen.MODE_DRY_RUN, substitutions: subs,
});

console.log('\n── Legacy compatibility ──');
{
  const emitted = preview.ok ? gen.emitStdout(preview) : { ok: false };
  const cli = run(['--archetype', 'surf_house', '--substitutions', SUBS]);
  green('dry_run_byte_identical', cli.status === 0 && emitted.ok && cli.stdout === emitted.stdout);
  const leg = run(['--archetype', 'surf_house', '--substitutions', SUBS,
    '--output-dir', path.join(os.tmpdir(), 'saas1-legacy-reject')]);
  red('legacy_output_dir_rejected', leg.status !== 0
    && /disk_materialization_unsupported:--output-dir/.test(err(leg)));
}

console.log('\n── Success + preview parity ──');
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'messi-saas1-p-'));
const dest = path.join(parent, `out-${crypto.randomBytes(4).toString('hex')}`);
{
  const cli = run(['--archetype', 'surf_house', '--substitutions', SUBS, '--materialize-to', dest]);
  green('cli_ok', cli.status === 0, (cli.stderr || '').slice(-200));
  green('receipt_disk_true', cli.status === 0 && /"disk_materialization": true/.test(cli.stdout));
  let parity = cli.status === 0 && preview.ok && fs.existsSync(dest);
  if (parity) {
    for (const f of preview.files) {
      const abs = path.join(dest, f.relativePath);
      const body = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (body !== f.content || gen.sha256Hex(body) !== f.sha256) { parity = false; break; }
    }
    if (!gen.deepEqual(listRel(dest), preview.files.map((f) => f.relativePath).sort())) parity = false;
  }
  green('exact_preview_parity', parity);
  green('no_staging_leftover', leftovers(parent).length === 0);
  const bl = parity && JSON.parse(fs.readFileSync(path.join(dest, `preview/${subs.CLIENT_SLUG}.baseline.json`), 'utf8'));
  const rg = parity && JSON.parse(fs.readFileSync(path.join(dest, `preview/${subs.CLIENT_SLUG}.registry-entry.json`), 'utf8'));
  green('disabled_no_secrets', !!(bl && rg && bl.live_enabled === false && bl.deployment.enabled === false
    && bl.channels.whatsapp.enabled === false && bl.channels.email.enabled === false
    && rg.live_enabled === false && preview.manifest.secrets_materialized === false));
}

console.log('\n── Collision / symlink / traversal (no mutation) ──');
{
  fs.writeFileSync(path.join(parent, 'operator-owned.txt'), 'keep-me\n');
  const beforeOwned = snap(parent).filter((x) => x.startsWith('operator-owned'));
  const collide = path.join(parent, 'already');
  fs.writeFileSync(collide, 'operator-dest\n');
  const c = run(['--archetype', 'surf_house', '--substitutions', SUBS, '--materialize-to', collide]);
  red('rejects_existing_dest', c.status !== 0 && /output_dir_exists/.test(err(c))
    && fs.readFileSync(collide, 'utf8') === 'operator-dest\n');

  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'messi-saas1-sym-'));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'messi-saas1-real-'));
  const link = path.join(box, 'link');
  fs.symlinkSync(real, link, 'dir');
  const symDest = path.join(link, `x-${crypto.randomBytes(3).toString('hex')}`);
  const before = snap(real);
  const s = run(['--archetype', 'surf_house', '--substitutions', SUBS, '--materialize-to', symDest]);
  red('rejects_symlinked_parent', s.status !== 0 && /symlink|parent/.test(err(s))
    && gen.deepEqual(before, snap(real)) && !fs.existsSync(path.join(real, path.basename(symDest))));

  const trav = run(['--archetype', 'surf_house', '--substitutions', SUBS,
    '--materialize-to', `${parent}/../${path.basename(parent)}/trav-out`]);
  red('rejects_traversal', trav.status !== 0 && /traversal/.test(err(trav)));

  const bad = path.join(parent, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ ...subs, CLIENT_SLUG: 'wolfhouse' }));
  const r = run(['--archetype', 'surf_house', '--substitutions', bad,
    '--materialize-to', path.join(parent, 'nope')]);
  red('rejects_reserved_existing', r.status !== 0 && /existing_tenant_conflict:wolfhouse/.test(err(r))
    && !fs.existsSync(path.join(parent, 'nope')));

  const mal = path.join(parent, 'mal.json');
  fs.writeFileSync(mal, JSON.stringify({ ...subs, CLIENT_SLUG: 'Bad_Slug' }));
  const m = run(['--archetype', 'surf_house', '--substitutions', mal,
    '--materialize-to', path.join(parent, 'mal-out')]);
  red('rejects_malformed_identity', m.status !== 0 && /invalid_slug|client_slug_invalid/.test(err(m))
    && !fs.existsSync(path.join(parent, 'mal-out')));
  red('operator_files_untouched', gen.deepEqual(beforeOwned, snap(parent).filter((x) => x.startsWith('operator-owned')))
    && leftovers(parent).length === 0);
}

console.log('\n── Failure cleanup ──');
{
  const fp = fs.mkdtempSync(path.join(os.tmpdir(), 'messi-saas1-fail-'));
  const fd = path.join(fp, 'dest');
  const bytes = Buffer.from('1111111111111111', 'hex');
  const occupied = path.join(fp, `${mat.STAGING_PREFIX}${bytes.toString('hex')}`);
  fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'sentinel'), 'keep');
  const random = crypto.randomBytes; crypto.randomBytes = () => bytes;
  let collision;
  try { collision = mat.materializeDryRunTo({ repoRoot: ROOT, archetype: 'surf_house', substitutions: subs, dest: fd }); }
  finally { crypto.randomBytes = random; }
  red('staging_collision_preserves_sentinel', !collision.ok
    && fs.readFileSync(path.join(occupied, 'sentinel'), 'utf8') === 'keep');

  fs.rmSync(occupied, { recursive: true });
  const rename = fs.renameSync; fs.renameSync = () => { throw new Error('injected_rename_failure'); };
  let failed;
  try { failed = mat.materializeDryRunTo({ repoRoot: ROOT, archetype: 'surf_house', substitutions: subs, dest: fd }); }
  finally { fs.renameSync = rename; }
  red('rename_failure_cleans_owned_staging_and_lock', !failed.ok && !fs.existsSync(fd)
    && leftovers(fp).length === 0 && !/wipeDirectoryContents/.test(fs.readFileSync(LIB, 'utf8')));
}

console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
