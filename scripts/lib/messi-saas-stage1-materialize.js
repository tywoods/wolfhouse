'use strict';

/**
 * MESSI SaaS Stage 1 — materialize FACTORY dry-run into a non-existent DEST.
 * Sibling staging on same FS → verify tree → one directory rename.
 * The sibling lock provides cooperative single-writer semantics. Failure
 * deletes only staging/lock this process created; never operator paths.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gen = require('./factory-slice1c-dry-run-generator');

const STAGE = 'MESSI-SAAS-1';
const OUTCOME_ID = 'saas_stage1_factory_materialization';
const STAGING_PREFIX = '.messi-saas1-staging-';
const STAGING_ATTEMPTS = 3;

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function absent(p) {
  try { fs.lstatSync(p); return false; }
  catch (err) { if (err && err.code === 'ENOENT') return true; throw err; }
}

function resolveDestination(destArg) {
  if (destArg == null || typeof destArg !== 'string' || !destArg.trim()) {
    return { ok: false, errors: ['output_dir_required'] };
  }
  if (destArg.includes('\0')) return { ok: false, errors: ['output_dir_nul'] };
  if (destArg.split(/[\\/]+/).some((p) => p === '..')) {
    return { ok: false, errors: ['output_dir_path_traversal'] };
  }
  const dest = path.resolve(destArg);
  const base = path.basename(dest);
  if (!base || base === '.' || base === '..') return { ok: false, errors: ['output_dir_invalid'] };
  try {
    const lst = fs.lstatSync(dest);
    return { ok: false, errors: [lst.isSymbolicLink() ? 'output_dir_symlink' : 'output_dir_exists'] };
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, errors: [`output_dir_unreadable:${err && err.message}`] };
    }
  }
  const parentResolved = path.resolve(path.dirname(dest));
  let parentLst;
  try { parentLst = fs.lstatSync(parentResolved); }
  catch (err) { return { ok: false, errors: [`output_dir_parent_missing:${err.message}`] }; }
  if (parentLst.isSymbolicLink()) return { ok: false, errors: ['output_dir_parent_symlink'] };
  if (!parentLst.isDirectory()) return { ok: false, errors: ['output_dir_parent_not_directory'] };
  let parentReal;
  try { parentReal = fs.realpathSync(parentResolved); }
  catch (err) { return { ok: false, errors: [`output_dir_parent_realpath_failed:${err.message}`] }; }
  if (parentReal !== parentResolved) return { ok: false, errors: ['output_dir_parent_symlink'] };
  return { ok: true, errors: [], dest, parent: parentReal };
}

function materializeDryRunTo(input) {
  const target = resolveDestination(input && input.dest);
  if (!target.ok) return { ok: false, errors: target.errors };
  const preview = gen.generateDryRunPreview({
    repoRoot: input.repoRoot, archetype: input.archetype,
    mode: gen.MODE_DRY_RUN, substitutions: input.substitutions,
  });
  if (!preview.ok) return { ok: false, errors: preview.errors };
  const pathErrors = [];
  for (const f of preview.files) {
    const rel = f.relativePath;
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\0')
      || rel.split(/[\\/]+/).some((p) => p === '..' || p === '')) {
      pathErrors.push(`output_path_traversal:${rel}`);
    }
  }
  if (pathErrors.length) return { ok: false, errors: [...new Set(pathErrors)].sort() };

  const lock = path.join(target.parent, `.${path.basename(target.dest)}.messi-saas1-lock`);
  let staging; let ownsStaging = false; let ownsLock = false; let lockFd;
  try {
    if (!absent(target.dest)) return { ok: false, errors: ['output_dir_exists'] };
    lockFd = fs.openSync(lock, 'wx', 0o600); ownsLock = true;
    fs.closeSync(lockFd); lockFd = undefined;
    for (let attempt = 0; attempt < STAGING_ATTEMPTS; attempt += 1) {
      staging = path.join(target.parent, STAGING_PREFIX + crypto.randomBytes(8).toString('hex'));
      try { fs.mkdirSync(staging, { recursive: false }); ownsStaging = true; break; }
      catch (err) { if (!err || err.code !== 'EEXIST') throw err; }
    }
    if (!ownsStaging) throw new Error('staging_collision');
    for (const f of preview.files) {
      const abs = path.join(staging, f.relativePath);
      if (!isInside(staging, abs)) throw new Error(`staging_path_escape:${f.relativePath}`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, { encoding: 'utf8', flag: 'wx' });
      const got = fs.readFileSync(abs, 'utf8');
      if (got !== f.content || gen.sha256Hex(got) !== f.sha256) {
        throw new Error(`staging_byte_mismatch:${f.relativePath}`);
      }
    }
    if (!absent(target.dest)) throw new Error('output_dir_exists');
    fs.renameSync(staging, target.dest);
    ownsStaging = false;
    fs.unlinkSync(lock); ownsLock = false;
    return {
      ok: true, errors: [], files: preview.files, manifest: preview.manifest,
      dest: target.dest, stage: STAGE, outcome_id: OUTCOME_ID,
    };
  } catch (err) {
    if (lockFd !== undefined) try { fs.closeSync(lockFd); } catch (_) { /* best effort */ }
    if (ownsStaging) try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* owned */ }
    if (ownsLock) try { fs.unlinkSync(lock); } catch (_) { /* owned */ }
    const msg = err && err.message ? err.message : String(err);
    if (msg === 'output_dir_exists' || msg.startsWith('staging_') || msg.startsWith('output_')) {
      return { ok: false, errors: [msg] };
    }
    return { ok: false, errors: [`materialize_failed:${msg}`] };
  }
}

function emitMaterializeReceipt(result) {
  if (!result || !result.ok) {
    return { ok: false, errors: (result && result.errors) || ['result_not_ok'] };
  }
  return {
    ok: true, errors: [],
    stdout: gen.sortedStringify({
      ok: true, slice: gen.SLICE, stage: STAGE, outcome_id: OUTCOME_ID,
      mode: gen.MODE_DRY_RUN, apply: false, disk_materialization: true,
      disk_materialization_supported: true, writes: true, dest: result.dest,
      manifest: result.manifest,
      files: result.files.map((f) => ({
        kind: f.kind, relativePath: f.relativePath, sha256: f.sha256,
        bytes: Buffer.byteLength(f.content, 'utf8'),
      })),
    }),
  };
}

module.exports = Object.freeze({
  STAGE, OUTCOME_ID, STAGING_PREFIX, resolveDestination, materializeDryRunTo, emitMaterializeReceipt,
});
