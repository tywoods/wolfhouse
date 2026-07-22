'use strict';

/**
 * Immutable reviewed-candidate blob certificates.
 *
 * Replaces base/landing-to-HEAD path allowlists. Each certificate binds a
 * reviewed candidate commit to an exact path → content-sha256 map. Certificates
 * form an ordered chain: a later certificate may supersede earlier ones for
 * overlapping paths only when it declares those ids in `supersedes`.
 *
 * Effective expected blobs are applied in chain order. Current tip/tree blobs
 * must match the effective map. Paths never mentioned by any certificate —
 * including arbitrary unrelated master commits before or after squash landings —
 * are irrelevant.
 *
 * Fail-closed on: missing refs, certificate blob mismatches vs candidate tree,
 * altered path scope, undeclared/reordered supersession, changed protected
 * blobs at the tip, and branch-name spoofing (branch is never trusted).
 */

const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function resolveCommitSha(root, sha) {
  const raw = String(sha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(raw)) return null;
  try {
    return execSync(`git rev-parse --verify ${raw}^{commit}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function listDiffPaths(root, fromSha, toSha) {
  try {
    const out = execSync(`git diff --name-only ${fromSha}..${toSha}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) return [];
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

function gitBlobSha256AtCommit(root, commitSha, rel) {
  const r = spawnSync('git', ['show', `${commitSha}:${rel}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      detail: String(r.stderr || r.stdout || 'git show failed'),
    };
  }
  return {
    ok: true,
    sha256: crypto.createHash('sha256').update(r.stdout).digest('hex'),
  };
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sortedPaths(paths) {
  return [...new Set((paths || []).map((p) => String(p)))].sort();
}

function pathsEqual(a, b) {
  const aa = sortedPaths(a);
  const bb = sortedPaths(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

/**
 * Build a certificate object from a candidate commit + explicit path list.
 * Blobs are read from the candidate tree (fail-closed on missing paths).
 */
function buildCertificateFromCandidate(root, spec) {
  const id = String(spec.id || '').trim();
  const candidateSha = resolveCommitSha(root, spec.candidate_sha);
  const supersedes = Object.freeze([...(spec.supersedes || [])].map(String));
  const paths = sortedPaths(spec.paths || []);
  const errors = [];
  if (!id) errors.push('certificate_missing_id');
  if (!candidateSha) {
    errors.push(`missing_ref:reviewed_candidate:${spec.candidate_sha}`);
  }
  const blobs = {};
  if (candidateSha) {
    for (const rel of paths) {
      const blob = gitBlobSha256AtCommit(root, candidateSha, rel);
      if (!blob.ok) {
        errors.push(`missing_blob_at_candidate:${rel}`);
      } else {
        blobs[rel] = blob.sha256;
      }
    }
  }
  const cert = deepFreeze({
    id,
    candidate_sha: candidateSha || String(spec.candidate_sha || ''),
    supersedes,
    paths: Object.freeze(paths),
    blobs: deepFreeze(blobs),
  });
  return { ok: errors.length === 0, errors, certificate: cert };
}

/**
 * Build certificate from frozen path→sha256 map (whole-path redesign content).
 * Optional candidate_sha, when present, must carry identical blobs.
 */
function buildCertificateFromFrozenBlobs(root, spec) {
  const id = String(spec.id || '').trim();
  const supersedes = Object.freeze([...(spec.supersedes || [])].map(String));
  const blobsIn = spec.blobs || {};
  const paths = sortedPaths(spec.paths || Object.keys(blobsIn));
  const errors = [];
  if (!id) errors.push('certificate_missing_id');
  const blobs = {};
  for (const rel of paths) {
    const expected = blobsIn[rel];
    if (!expected || !/^[0-9a-f]{64}$/i.test(String(expected))) {
      errors.push(`frozen_blob_missing_or_invalid:${rel}`);
    } else {
      blobs[rel] = String(expected).toLowerCase();
    }
  }
  let candidateSha = null;
  if (spec.candidate_sha) {
    candidateSha = resolveCommitSha(root, spec.candidate_sha);
    if (!candidateSha) {
      errors.push(`missing_ref:reviewed_candidate:${spec.candidate_sha}`);
    } else {
      for (const rel of paths) {
        const blob = gitBlobSha256AtCommit(root, candidateSha, rel);
        if (!blob.ok) {
          errors.push(`missing_blob_at_candidate:${rel}`);
        } else if (blobs[rel] && blob.sha256 !== blobs[rel]) {
          errors.push(`certificate_blob_mismatch:${rel}`);
        }
      }
    }
  }
  const cert = deepFreeze({
    id,
    candidate_sha: candidateSha || String(spec.candidate_sha || ''),
    frozen_only: true,
    supersedes,
    paths: Object.freeze(paths),
    blobs: deepFreeze(blobs),
  });
  return { ok: errors.length === 0, errors, certificate: cert };
}

function freezeCertificate(spec) {
  return deepFreeze({
    id: String(spec.id),
    candidate_sha: String(spec.candidate_sha || ''),
    frozen_only: spec.frozen_only === true,
    supersedes: Object.freeze([...(spec.supersedes || [])].map(String)),
    paths: Object.freeze(sortedPaths(spec.paths || Object.keys(spec.blobs || {}))),
    blobs: deepFreeze({ ...(spec.blobs || {}) }),
  });
}

/**
 * Verify one locked certificate against the candidate object store.
 * frozen_only certificates are content-addressed (no candidate ref required).
 */
function verifyCertificateIdentity(root, cert) {
  const errors = [];
  const locked = freezeCertificate(cert);
  if (!locked.id) errors.push('certificate_missing_id');
  if (!locked.paths.length) errors.push(`certificate_empty_scope:${locked.id}`);

  const blobKeys = sortedPaths(Object.keys(locked.blobs || {}));
  if (!pathsEqual(blobKeys, locked.paths)) {
    errors.push(`altered_certificate_scope:${locked.id}:path_blob_key_mismatch`);
  }

  for (const rel of locked.paths) {
    const expected = locked.blobs[rel];
    if (!expected || !/^[0-9a-f]{64}$/i.test(String(expected))) {
      errors.push(`altered_certificate_scope:${locked.id}:missing_blob_entry:${rel}`);
    }
  }

  if (locked.frozen_only || !locked.candidate_sha) {
    return {
      ok: errors.length === 0,
      errors,
      certificate: locked,
      candidateSha: null,
    };
  }

  const candidateSha = resolveCommitSha(root, locked.candidate_sha);
  if (!candidateSha) {
    errors.push(`missing_ref:reviewed_candidate:${locked.candidate_sha}`);
    return { ok: false, errors, certificate: locked, candidateSha: null };
  }

  for (const rel of locked.paths) {
    const expected = locked.blobs[rel];
    if (!expected) continue;
    const blob = gitBlobSha256AtCommit(root, candidateSha, rel);
    if (!blob.ok) {
      errors.push(`missing_blob_at_candidate:${locked.id}:${rel}`);
    } else if (blob.sha256 !== expected) {
      errors.push(
        `certificate_blob_mismatch:${locked.id}:${rel}:got=${blob.sha256}:expected=${expected}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    certificate: locked,
    candidateSha,
  };
}

/**
 * Enforce locked order + explicit supersession for overlapping paths.
 */
function verifyCertificateChainOrder(certificates) {
  const errors = [];
  const certs = (certificates || []).map(freezeCertificate);
  const ids = certs.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    errors.push('duplicate_certificate_id');
  }
  const indexById = new Map(ids.map((id, i) => [id, i]));

  for (let i = 0; i < certs.length; i += 1) {
    const cert = certs[i];
    for (const dep of cert.supersedes) {
      if (!indexById.has(dep)) {
        errors.push(`supersedes_unknown_certificate:${cert.id}:${dep}`);
      } else if (indexById.get(dep) >= i) {
        errors.push(`reordered_or_superseded_certificates:${cert.id}:${dep}`);
      }
    }
  }

  // Overlapping paths require the later certificate to declare supersession of
  // the immediately prior owner of that path.
  const owners = new Map(); // path -> [cert ids in order]
  for (const cert of certs) {
    for (const rel of cert.paths) {
      if (!owners.has(rel)) owners.set(rel, []);
      owners.get(rel).push(cert.id);
    }
  }
  for (const [rel, chain] of owners.entries()) {
    for (let i = 1; i < chain.length; i += 1) {
      const later = certs[indexById.get(chain[i])];
      const earlier = chain[i - 1];
      if (!later.supersedes.includes(earlier)) {
        errors.push(
          `undeclared_path_supersession:${later.id}:${rel}:prior=${earlier}`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, certificates: certs, ids };
}

function effectiveBlobMap(certificates) {
  const map = Object.create(null);
  const source = Object.create(null);
  for (const cert of (certificates || []).map(freezeCertificate)) {
    for (const rel of cert.paths) {
      map[rel] = cert.blobs[rel];
      source[rel] = cert.id;
    }
  }
  return { map, source };
}

/**
 * Current tip (commit) must carry effective certificate blobs.
 * Unrelated paths are ignored.
 */
function verifyEffectiveBlobsAtTip(root, certificates, tipSha) {
  const errors = [];
  const tip = resolveCommitSha(root, tipSha);
  if (!tip) {
    errors.push(`missing_ref:tip:${tipSha}`);
    return { ok: false, errors, tipSha: null, effective: {}, source: {} };
  }
  const { map, source } = effectiveBlobMap(certificates);
  for (const rel of sortedPaths(Object.keys(map))) {
    const expected = map[rel];
    const blob = gitBlobSha256AtCommit(root, tip, rel);
    if (!blob.ok) {
      errors.push(`missing_protected_blob:${rel}:cert=${source[rel]}`);
    } else if (blob.sha256 !== expected) {
      errors.push(
        `changed_protected_blob:${rel}:cert=${source[rel]}:got=${blob.sha256}:expected=${expected}`,
      );
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    tipSha: tip,
    effective: map,
    source,
  };
}

/**
 * Full chain verification against a tip commit.
 * opts.certificates — locked chain
 * opts.tip_sha — default HEAD
 * opts.claimed_certificates — optional forged chain (order/scope RED)
 */
function verifyReviewedBlobCertificates(root, opts) {
  const options = opts || {};
  const locked = (options.certificates || []).map(freezeCertificate);
  const claimed = options.claimed_certificates
    ? options.claimed_certificates.map(freezeCertificate)
    : locked;
  const tipSha = options.tip_sha || 'HEAD';
  const errors = [];

  const orderLocked = verifyCertificateChainOrder(locked);
  if (!orderLocked.ok) errors.push(...orderLocked.errors);

  const orderClaimed = verifyCertificateChainOrder(claimed);
  if (!orderClaimed.ok) errors.push(...orderClaimed.errors.map((e) => `claimed:${e}`));

  if (claimed.length !== locked.length) {
    errors.push(
      `altered_certificate_scope:chain_length:claimed=${claimed.length}:locked=${locked.length}`,
    );
  } else {
    for (let i = 0; i < locked.length; i += 1) {
      if (claimed[i].id !== locked[i].id) {
        errors.push(
          `reordered_or_superseded_certificates:index=${i}:claimed=${claimed[i].id}:locked=${locked[i].id}`,
        );
      }
      if (claimed[i].candidate_sha !== locked[i].candidate_sha) {
        errors.push(
          `stale_or_wrong_reviewed_candidate:cert=${locked[i].id}:claimed=${claimed[i].candidate_sha}:locked=${locked[i].candidate_sha}`,
        );
      }
      if (!pathsEqual(claimed[i].paths, locked[i].paths)) {
        errors.push(`altered_certificate_scope:${locked[i].id}`);
      }
      if (!pathsEqual(claimed[i].supersedes, locked[i].supersedes)) {
        errors.push(`altered_certificate_scope:supersedes:${locked[i].id}`);
      }
      for (const rel of locked[i].paths) {
        if (claimed[i].blobs[rel] !== locked[i].blobs[rel]) {
          errors.push(`altered_certificate_scope:blob:${locked[i].id}:${rel}`);
        }
      }
    }
  }

  for (const cert of locked) {
    const idn = verifyCertificateIdentity(root, cert);
    if (!idn.ok) errors.push(...idn.errors);
  }

  const tip = verifyEffectiveBlobsAtTip(root, locked, tipSha);
  if (!tip.ok) errors.push(...tip.errors);

  // Branch name is informational only — never consulted.
  if (Object.prototype.hasOwnProperty.call(options, 'branch_name')) {
    // Explicit no-op binding so callers can pass branch without effect.
    void options.branch_name;
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    tipSha: tip.tipSha,
    effective: tip.effective,
    source: tip.source,
    certificates: locked,
  };
}

/**
 * Tip acceptance: certificate blobs match tip tree. Branch never trusted.
 */
function tipAcceptsCertificates(root, certificates, tipSha, _branchName) {
  const tip = String(tipSha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(tip) && tip !== 'HEAD') return false;
  const r = verifyReviewedBlobCertificates(root, {
    certificates,
    tip_sha: tip,
    branch_name: _branchName,
  });
  return r.ok === true;
}

/**
 * RED topology helper: arbitrary unrelated commits before/after multiple
 * squash-like landings. Returns a tip SHA whose tree still matches the
 * effective certificate blobs when landings restore certified paths.
 */
function makeMultiSquashUnrelatedTopology(root, certificates) {
  const certs = (certificates || []).map(freezeCertificate);
  const withCandidates = certs.filter((c) => c.candidate_sha && !c.frozen_only);
  if (withCandidates.length < 2) {
    throw new Error('need_at_least_two_candidate_certificates_for_topology');
  }

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'cert-topology',
    GIT_AUTHOR_EMAIL: 'cert-topology@test',
    GIT_COMMITTER_NAME: 'cert-topology',
    GIT_COMMITTER_EMAIL: 'cert-topology@test',
    GIT_AUTHOR_DATE: '2026-07-22T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-07-22T00:00:00Z',
  };

  function commitTree(tree, parents, message) {
    const args = ['commit-tree', tree];
    for (const p of parents) {
      args.push('-p', p);
    }
    args.push('-m', message);
    const r = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    if (r.status !== 0) {
      throw new Error(String(r.stderr || r.stdout || 'commit-tree failed'));
    }
    return String(r.stdout || '').trim();
  }

  function treeOf(commit) {
    return execSync(`git rev-parse ${commit}^{tree}`, {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  }

  const firstCand = resolveCommitSha(root, withCandidates[0].candidate_sha);
  if (!firstCand) throw new Error(`missing_ref:${withCandidates[0].candidate_sha}`);

  // Orphan unrelated commit before any landing.
  const unrelatedBefore = commitTree(
    treeOf(firstCand),
    [],
    'topology-unrelated-before-landings',
  );

  // Squash-like landings for each candidate certificate, with unrelated
  // commits between landings.
  let tip = unrelatedBefore;
  const landings = [];
  for (let i = 0; i < withCandidates.length; i += 1) {
    const cand = resolveCommitSha(root, withCandidates[i].candidate_sha);
    if (!cand) throw new Error(`missing_ref:${withCandidates[i].candidate_sha}`);
    const unrelatedMid = commitTree(
      treeOf(tip),
      [tip],
      `topology-unrelated-between-${i}`,
    );
    tip = unrelatedMid;
    const landing = commitTree(
      treeOf(cand),
      [tip],
      `topology-squash-landing-${withCandidates[i].id}`,
    );
    landings.push(landing);
    tip = landing;
  }

  // Unrelated commit after final landing (same tree — certified blobs intact
  // for candidate certificates; frozen_only redesign certs are checked against
  // real HEAD separately).
  const unrelatedAfter = commitTree(
    treeOf(tip),
    [tip],
    'topology-unrelated-after-landings',
  );

  return {
    unrelatedBefore,
    landings,
    unrelatedAfter,
    tipSha: unrelatedAfter,
    candidateCertificates: withCandidates,
  };
}

/**
 * Derive frozen path→sha256 map from a candidate for embedding in lock modules.
 */
function deriveBlobs(root, candidateSha, paths) {
  const out = {};
  const cand = resolveCommitSha(root, candidateSha);
  if (!cand) throw new Error(`missing_ref:${candidateSha}`);
  for (const rel of sortedPaths(paths)) {
    const blob = gitBlobSha256AtCommit(root, cand, rel);
    if (!blob.ok) throw new Error(`missing_blob:${rel}`);
    out[rel] = blob.sha256;
  }
  return out;
}

/**
 * Build the standard MESSI/FACTORY break-glass chain:
 *   1) reviewed slice candidate (basis..candidate paths)
 *   2) correction candidate snapshot (53c1abcf) superseding those paths
 *      plus any extra correction paths
 *   3) optional frozen whole-path redesign certificate
 */
function buildSupersedingCertificateChain(root, config) {
  const cfg = config || {};
  const errors = [];
  const sliceId = String(cfg.slice_cert_id || 'slice-reviewed');
  const correctionId = String(cfg.correction_cert_id || 'breakglass-53c1abcf');
  const redesignId = String(cfg.redesign_cert_id || 'breakglass-whole-path');
  const reviewed = String(cfg.reviewed_candidate || '');
  const basis = String(cfg.master_basis || '');
  const correction = String(cfg.correction_candidate || '');

  const slicePaths = listDiffPaths(root, basis, reviewed);
  if (slicePaths === null) {
    return {
      ok: false,
      errors: ['candidate_diff_failed'],
      certificates: [],
    };
  }

  const correctionChanged = cfg.correction_changed_paths
    || listDiffPaths(root, cfg.correction_basis || basis, correction)
    || [];
  const snapshotPaths = sortedPaths(slicePaths.concat(correctionChanged));

  const c1 = buildCertificateFromCandidate(root, {
    id: sliceId,
    candidate_sha: reviewed,
    supersedes: [],
    paths: slicePaths,
  });
  if (!c1.ok) errors.push(...c1.errors);

  const c2 = buildCertificateFromCandidate(root, {
    id: correctionId,
    candidate_sha: correction,
    supersedes: [sliceId],
    paths: snapshotPaths,
  });
  if (!c2.ok) errors.push(...c2.errors);

  const certificates = [];
  if (c1.certificate) certificates.push(c1.certificate);
  if (c2.certificate) certificates.push(c2.certificate);

  const redesignBlobs = cfg.redesign_blobs || null;
  if (redesignBlobs && Object.keys(redesignBlobs).length > 0) {
    const c3 = buildCertificateFromFrozenBlobs(root, {
      id: redesignId,
      candidate_sha: cfg.redesign_candidate_sha || '',
      frozen_only: true,
      supersedes: [correctionId],
      paths: sortedPaths(Object.keys(redesignBlobs)),
      blobs: redesignBlobs,
    });
    if (!c3.ok) errors.push(...c3.errors);
    if (c3.certificate) certificates.push(c3.certificate);
  }

  const order = verifyCertificateChainOrder(certificates);
  if (!order.ok) errors.push(...order.errors);

  return {
    ok: errors.length === 0,
    errors,
    certificates: order.certificates || certificates,
  };
}

/**
 * Load whole-path redesign blobs from the external fixture (not self-hashed into
 * lock modules — breaks the lock-file self-hash cycle while still binding
 * correction candidate 53c1abcf and redesigned tip blobs).
 */
function loadWholePathRedesignBlobs(root) {
  const abs = pathModuleJoin(root);
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const blobs = raw && raw.blobs && typeof raw.blobs === 'object' ? raw.blobs : {};
    return deepFreeze({ ...blobs });
  } catch (err) {
    throw new Error(`whole_path_redesign_blobs_fixture_unreadable:${err.message}`);
  }
}

function pathModuleJoin(root) {
  const path = require('path');
  const base = root || path.join(__dirname, '..', '..');
  return path.join(base, 'fixtures', 'messi-acceptance', 'breakglass-whole-path-blobs.json');
}

module.exports = deepFreeze({
  deepFreeze,
  resolveCommitSha,
  listDiffPaths,
  gitBlobSha256AtCommit,
  sha256Buffer,
  sortedPaths,
  pathsEqual,
  buildCertificateFromCandidate,
  buildCertificateFromFrozenBlobs,
  freezeCertificate,
  verifyCertificateIdentity,
  verifyCertificateChainOrder,
  effectiveBlobMap,
  verifyEffectiveBlobsAtTip,
  verifyReviewedBlobCertificates,
  tipAcceptsCertificates,
  makeMultiSquashUnrelatedTopology,
  deriveBlobs,
  buildSupersedingCertificateChain,
  loadWholePathRedesignBlobs,
  WHOLE_PATH_BLOBS_FIXTURE_REL:
    'fixtures/messi-acceptance/breakglass-whole-path-blobs.json',
});
