'use strict';

/**
 * Immutable reviewed-candidate blob certificates.
 *
 * Replaces base/landing-to-HEAD path allowlists. Each certificate binds a
 * reviewed candidate commit to an exact path → content-sha256 map derived from
 * that commit's Git tree. Certificates form an ordered chain: a later
 * certificate may supersede earlier ones for overlapping paths only when it
 * declares those ids in `supersedes`.
 *
 * Whole-path redesign is Git-anchored via breakglass-redesign-candidate-sha.js
 * (never frozen_only, never trust-root from working-tree JSON). The metadata
 * fixture may only mirror locked pin fields; it cannot supply blobs or redefine
 * the candidate SHA.
 *
 * Post-merge squash binding (1E): exact reviewed candidate + landing tip are
 * bound by candidate-path blob equality — never branch-name trust, never
 * ancestry, never basis..HEAD / basis..candidate path-range inference for tip
 * acceptance. package.json is excluded from redesign whole-path protection
 * (concurrent unrelated script keys); MESSI script registration stays GREEN.
 *
 * Fail-closed on: missing refs, certificate blob mismatches vs candidate tree,
 * altered path scope, undeclared/reordered supersession, changed protected
 * blobs at the tip, branch-name spoofing, fixture metadata drift, and any
 * fixture `blobs` map (co-tamper surface).
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const redesignPin = require('./breakglass-redesign-candidate-sha');

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
 * Select certificate paths whose blobs are byte-identical between candidate
 * and tip. No ancestry / merge-base / path-range inference.
 */
function selectPathsByCandidateTipBlobEquality(root, candidateSha, tipSha, paths) {
  const cand = resolveCommitSha(root, candidateSha);
  const tip = resolveCommitSha(root, tipSha);
  const selected = [];
  const rejected = [];
  if (!cand || !tip) {
    return {
      ok: false,
      selected: [],
      rejected: sortedPaths(paths),
      errors: [
        !cand
          ? `missing_ref:reviewed_candidate:${candidateSha}`
          : `missing_ref:binding_tip:${tipSha}`,
      ],
      candidateSha: cand,
      tipSha: tip,
    };
  }
  for (const rel of sortedPaths(paths)) {
    const a = gitBlobSha256AtCommit(root, cand, rel);
    const b = gitBlobSha256AtCommit(root, tip, rel);
    if (a.ok && b.ok && a.sha256 === b.sha256) {
      selected.push(rel);
    } else {
      rejected.push(rel);
    }
  }
  return {
    ok: true,
    selected: Object.freeze(selected),
    rejected: Object.freeze(rejected),
    errors: [],
    candidateSha: cand,
    tipSha: tip,
  };
}

/** Paths that must never enter whole-path redesign / correction certificates. */
const ALWAYS_EXCLUDE_PATHS = Object.freeze(['package.json']);

function filterExcludedPaths(paths, extraExclude) {
  const ban = new Set([
    ...ALWAYS_EXCLUDE_PATHS,
    ...((extraExclude || []).map(String)),
  ]);
  return sortedPaths(paths).filter((p) => !ban.has(p));
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

function freezeCertificate(spec) {
  return deepFreeze({
    id: String(spec.id),
    candidate_sha: String(spec.candidate_sha || ''),
    supersedes: Object.freeze([...(spec.supersedes || [])].map(String)),
    paths: Object.freeze(sortedPaths(spec.paths || Object.keys(spec.blobs || {}))),
    blobs: deepFreeze({ ...(spec.blobs || {}) }),
  });
}

/**
 * Verify one locked certificate against the candidate object store.
 * Every certificate requires a resolvable candidate_sha (no frozen_only).
 */
function verifyCertificateIdentity(root, cert) {
  const errors = [];
  const locked = freezeCertificate(cert);
  if (!locked.id) errors.push('certificate_missing_id');
  if (!locked.paths.length) errors.push(`certificate_empty_scope:${locked.id}`);
  if (!locked.candidate_sha) {
    errors.push(`missing_ref:reviewed_candidate:${locked.id}:empty`);
  }

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

  const owners = new Map();
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

function anchorFixtureAbs(root) {
  const base = root || path.join(__dirname, '..', '..');
  return path.join(base, redesignPin.ANCHOR_FIXTURE_REL);
}

/**
 * Pure metadata validation (pin vs fixture object). Used by live verification
 * and hostile REDs (fixture blobs / metadata / ref co-tamper).
 */
function validateWholePathRedesignAnchorData(pin, raw, root) {
  const errors = [];
  const locked = pin || redesignPin;
  const pinSha = String(locked.REDESIGN_CANDIDATE_SHA || '').trim();
  const activated = typeof locked.isRedesignActivated === 'function'
    ? locked.isRedesignActivated()
    : /^[0-9a-f]{40}$/i.test(pinSha);
  const body = raw && typeof raw === 'object' ? raw : {};

  if (Object.prototype.hasOwnProperty.call(body, 'blobs')) {
    errors.push('fixture_blobs_forbidden:working_tree_json_cannot_redefine_trust_root');
  }

  if (body.id !== locked.REDESIGN_CERT_ID) {
    errors.push(
      `fixture_metadata_id_mismatch:got=${body.id}:locked=${locked.REDESIGN_CERT_ID}`,
    );
  }
  if (body.correction_candidate_bound !== locked.CORRECTION_CANDIDATE_BOUND) {
    errors.push('fixture_metadata_correction_ref_mismatch');
  }
  if (body.master_basis !== locked.MASTER_BASIS_BOUND) {
    errors.push('fixture_metadata_master_basis_mismatch');
  }
  if (!pathsEqual(body.paths || [], locked.REDESIGN_PATHS)) {
    errors.push('fixture_metadata_paths_mismatch');
  }
  if ((body.paths || []).includes('package.json')) {
    errors.push('fixture_metadata_package_json_forbidden_in_redesign_paths');
  }

  if (body.squash_proof_reviewed_candidate
    !== locked.SQUASH_PROOF_REVIEWED_CANDIDATE) {
    errors.push('fixture_metadata_squash_reviewed_mismatch');
  }
  if (body.squash_proof_landing_tip !== locked.SQUASH_PROOF_LANDING_TIP) {
    errors.push('fixture_metadata_squash_landing_mismatch');
  }
  if (!pathsEqual(body.squash_proof_paths || [], locked.SQUASH_PROOF_PATHS || [])) {
    errors.push('fixture_metadata_squash_paths_mismatch');
  }

  const squashPinSha = String(locked.SQUASH_PROOF_CANDIDATE_SHA || '').trim();
  const squashActivated = typeof locked.isSquashProofActivated === 'function'
    ? locked.isSquashProofActivated()
    : /^[0-9a-f]{40}$/i.test(squashPinSha);
  const fixtureSquashSha = String(body.squash_proof_candidate_sha || '').trim();
  if (squashActivated) {
    if (fixtureSquashSha !== squashPinSha) {
      errors.push(
        `fixture_metadata_squash_candidate_sha_mismatch:got=${fixtureSquashSha}:locked=${squashPinSha}`,
      );
    }
    if (root && !resolveCommitSha(root, squashPinSha)) {
      errors.push(`missing_ref:squash_proof_candidate:${squashPinSha}`);
    }
  } else if (fixtureSquashSha) {
    errors.push(
      `fixture_metadata_squash_candidate_sha_premature:got=${fixtureSquashSha}:pin_inactive`,
    );
  }

  const fixtureSha = String(body.candidate_sha || '').trim();
  if (activated) {
    if (fixtureSha !== pinSha) {
      errors.push(
        `fixture_metadata_candidate_sha_mismatch:got=${fixtureSha}:locked=${pinSha}`,
      );
    }
    if (root && !resolveCommitSha(root, pinSha)) {
      errors.push(`missing_ref:redesign_candidate:${pinSha}`);
    }
  } else if (fixtureSha) {
    errors.push(
      `fixture_metadata_candidate_sha_premature:got=${fixtureSha}:pin_inactive`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    activated,
    pinSha: activated ? pinSha : '',
    squashActivated,
    squashPinSha: squashActivated ? squashPinSha : '',
    fixture: body,
  };
}

/**
 * Load + validate redesign metadata fixture against the hardcoded pin.
 * Rejects any `blobs` map so working-tree JSON cannot redefine trust.
 */
function validateWholePathRedesignAnchor(root) {
  const pinSha = String(redesignPin.REDESIGN_CANDIDATE_SHA || '').trim();
  const activated = redesignPin.isRedesignActivated();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(anchorFixtureAbs(root), 'utf8'));
  } catch (err) {
    return {
      ok: false,
      errors: [`whole_path_redesign_anchor_unreadable:${err.message}`],
      activated,
      pinSha,
    };
  }
  return validateWholePathRedesignAnchorData(redesignPin, raw, root);
}

/**
 * Full chain verification against a tip commit.
 * opts.certificates — locked chain
 * opts.tip_sha — default HEAD
 * opts.claimed_certificates — optional forged chain (order/scope RED)
 * opts.skip_anchor_validation — test-only
 */
function verifyReviewedBlobCertificates(root, opts) {
  const options = opts || {};
  const locked = (options.certificates || []).map(freezeCertificate);
  const claimed = options.claimed_certificates
    ? options.claimed_certificates.map(freezeCertificate)
    : locked;
  const tipSha = options.tip_sha || 'HEAD';
  const errors = [];

  if (!options.skip_anchor_validation) {
    const anchor = validateWholePathRedesignAnchor(root);
    if (!anchor.ok) errors.push(...anchor.errors);
  }

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

  if (Object.prototype.hasOwnProperty.call(options, 'branch_name')) {
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
 * Certificates before the redesign/squash-proof certs — used for correction-tip
 * subchain proofs and multi-squash topologies that land pre-redesign candidates.
 */
function certificatesBeforeRedesign(certificates) {
  const skip = new Set([
    redesignPin.REDESIGN_CERT_ID,
    redesignPin.SQUASH_PROOF_CERT_ID,
  ].filter(Boolean));
  return (certificates || [])
    .map(freezeCertificate)
    .filter((c) => !skip.has(c.id));
}

/**
 * RED topology helper: arbitrary unrelated commits before/after multiple
 * squash-like landings. Returns a tip SHA whose tree still matches the
 * effective certificate blobs when landings restore certified paths.
 */
function makeMultiSquashUnrelatedTopology(root, certificates) {
  const certs = (certificates || []).map(freezeCertificate)
    .filter((c) => c.candidate_sha);
  if (certs.length < 2) {
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

  const firstCand = resolveCommitSha(root, certs[0].candidate_sha);
  if (!firstCand) throw new Error(`missing_ref:${certs[0].candidate_sha}`);

  const unrelatedBefore = commitTree(
    treeOf(firstCand),
    [],
    'topology-unrelated-before-landings',
  );

  let tip = unrelatedBefore;
  const landings = [];
  for (let i = 0; i < certs.length; i += 1) {
    const cand = resolveCommitSha(root, certs[i].candidate_sha);
    if (!cand) throw new Error(`missing_ref:${certs[i].candidate_sha}`);
    const unrelatedMid = commitTree(
      treeOf(tip),
      [tip],
      `topology-unrelated-between-${i}`,
    );
    tip = unrelatedMid;
    const landing = commitTree(
      treeOf(cand),
      [tip],
      `topology-squash-landing-${certs[i].id}`,
    );
    landings.push(landing);
    tip = landing;
  }

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
    candidateCertificates: certs,
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
 *   1) reviewed slice candidate — explicit paths or binding-tip blob equality
 *      (never basis..candidate path-range inference when binding_tip_sha set)
 *   2) correction candidate snapshot (53c1abcf) superseding those paths
 *      plus any extra correction paths (package.json always excluded)
 *   3) optional Git-anchored whole-path redesign certificate (pin SHA)
 *   4) optional squash-proof supersession (pin SHA) for post-#154 correction
 */
function buildSupersedingCertificateChain(root, config) {
  const cfg = config || {};
  const errors = [];
  const sliceId = String(cfg.slice_cert_id || 'slice-reviewed');
  const correctionId = String(cfg.correction_cert_id || 'breakglass-53c1abcf');
  const redesignId = String(cfg.redesign_cert_id || redesignPin.REDESIGN_CERT_ID);
  const squashId = String(
    cfg.squash_proof_cert_id || redesignPin.SQUASH_PROOF_CERT_ID || 'breakglass-1e-squash-proof',
  );
  const reviewed = String(cfg.reviewed_candidate || '');
  const basis = String(cfg.master_basis || '');
  const correction = String(cfg.correction_candidate || '');
  const bindingTip = Object.prototype.hasOwnProperty.call(cfg, 'binding_tip_sha')
    ? String(cfg.binding_tip_sha || '').trim()
    : '';

  const anchor = validateWholePathRedesignAnchor(root);
  if (!anchor.ok) errors.push(...anchor.errors);

  let slicePaths;
  if (Array.isArray(cfg.reviewed_paths) && cfg.reviewed_paths.length > 0) {
    slicePaths = filterExcludedPaths(cfg.reviewed_paths, cfg.exclude_paths);
  } else if (bindingTip && reviewed) {
    // Candidate-path blob equality with landing tip — no path-range inference.
    const universe = filterExcludedPaths(
      cfg.path_universe || redesignPin.REDESIGN_PATHS || [],
      cfg.exclude_paths,
    );
    const sel = selectPathsByCandidateTipBlobEquality(
      root,
      reviewed,
      bindingTip,
      universe,
    );
    if (!sel.ok) {
      return {
        ok: false,
        errors: [...sel.errors, ...errors],
        certificates: [],
      };
    }
    slicePaths = [...sel.selected];
    if (slicePaths.length === 0) {
      errors.push('candidate_tip_blob_equality_selected_zero_paths');
    }
  } else {
    // Legacy fallback retained only when caller opts in explicitly.
    if (cfg.allow_path_range_inference !== true) {
      return {
        ok: false,
        errors: [
          'path_range_inference_forbidden:provide_reviewed_paths_or_binding_tip_sha',
          ...errors,
        ],
        certificates: [],
      };
    }
    const inferred = listDiffPaths(root, basis, reviewed);
    if (inferred === null) {
      return {
        ok: false,
        errors: ['candidate_diff_failed', ...errors],
        certificates: [],
      };
    }
    slicePaths = filterExcludedPaths(inferred, cfg.exclude_paths);
  }

  // Slice paths must exist at the correction candidate so the pre-redesign
  // subchain (slice→correction) is self-contained for multi-squash REDs.
  if (correction) {
    const corrSha = resolveCommitSha(root, correction);
    if (corrSha) {
      slicePaths = slicePaths.filter(
        (rel) => gitBlobSha256AtCommit(root, corrSha, rel).ok,
      );
    }
  }

  let correctionChanged = cfg.correction_changed_paths;
  if (!correctionChanged) {
    if (cfg.allow_path_range_inference === true) {
      correctionChanged = listDiffPaths(
        root,
        cfg.correction_basis || basis,
        correction,
      ) || [];
    } else {
      correctionChanged = [];
    }
  }
  const snapshotPaths = filterExcludedPaths(
    sortedPaths(slicePaths.concat(correctionChanged)),
    cfg.exclude_paths,
  ).filter((rel) => {
    const cand = resolveCommitSha(root, correction);
    if (!cand) return false;
    return gitBlobSha256AtCommit(root, cand, rel).ok;
  });

  const c1 = buildCertificateFromCandidate(root, {
    id: sliceId,
    candidate_sha: reviewed,
    supersedes: [],
    paths: slicePaths,
  });
  if (!c1.ok) errors.push(...c1.errors);

  let priorId = sliceId;
  const certificates = [];
  if (c1.certificate) certificates.push(c1.certificate);

  if (snapshotPaths.length > 0) {
    const c2 = buildCertificateFromCandidate(root, {
      id: correctionId,
      candidate_sha: correction,
      supersedes: [sliceId],
      paths: snapshotPaths,
    });
    if (!c2.ok) errors.push(...c2.errors);
    if (c2.certificate) {
      certificates.push(c2.certificate);
      priorId = correctionId;
    }
  }

  const redesignSha = String(
    cfg.redesign_candidate_sha || redesignPin.REDESIGN_CANDIDATE_SHA || '',
  ).trim();
  const redesignPaths = filterExcludedPaths(
    cfg.redesign_paths || redesignPin.REDESIGN_PATHS || [],
    cfg.exclude_paths,
  );

  if (redesignSha && redesignPaths.length > 0) {
    if (!/^[0-9a-f]{40}$/i.test(redesignSha)) {
      errors.push(`redesign_candidate_sha_invalid:${redesignSha}`);
    } else {
      const c3 = buildCertificateFromCandidate(root, {
        id: redesignId,
        candidate_sha: redesignSha,
        // Supersede every prior cert so overlapping paths (including those
        // absent from the correction snapshot) have a declared supersession.
        supersedes: certificates.map((c) => c.id),
        paths: redesignPaths,
      });
      if (!c3.ok) errors.push(...c3.errors);
      if (c3.certificate) certificates.push(c3.certificate);
      priorId = redesignId;
    }
  } else if (Object.prototype.hasOwnProperty.call(cfg, 'redesign_blobs')
    && cfg.redesign_blobs
    && Object.keys(cfg.redesign_blobs).length > 0) {
    errors.push('frozen_only_redesign_blobs_forbidden:use_git_anchored_candidate');
  }

  const squashSha = String(
    cfg.squash_proof_candidate_sha || redesignPin.SQUASH_PROOF_CANDIDATE_SHA || '',
  ).trim();
  const squashPaths = filterExcludedPaths(
    cfg.squash_proof_paths || redesignPin.SQUASH_PROOF_PATHS || [],
    cfg.exclude_paths,
  );
  const squashActive = typeof redesignPin.isSquashProofActivated === 'function'
    ? redesignPin.isSquashProofActivated()
    : /^[0-9a-f]{40}$/i.test(squashSha);

  if (squashActive && squashSha && squashPaths.length > 0) {
    if (!/^[0-9a-f]{40}$/i.test(squashSha)) {
      errors.push(`squash_proof_candidate_sha_invalid:${squashSha}`);
    } else {
      const c4 = buildCertificateFromCandidate(root, {
        id: squashId,
        candidate_sha: squashSha,
        supersedes: certificates.map((c) => c.id),
        paths: squashPaths,
      });
      if (!c4.ok) errors.push(...c4.errors);
      if (c4.certificate) certificates.push(c4.certificate);
    }
  }

  const order = verifyCertificateChainOrder(certificates);
  if (!order.ok) errors.push(...order.errors);

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    certificates: order.certificates || certificates,
    redesignActivated: Boolean(redesignSha),
    squashProofActivated: Boolean(squashActive && squashSha),
    bindingTipSha: bindingTip || null,
  };
}

/**
 * @deprecated Fixture is metadata-only; use validateWholePathRedesignAnchor.
 * Retained name so call sites can migrate — returns empty object and never
 * supplies trust-root blobs.
 */
function loadWholePathRedesignBlobs(root) {
  const anchor = validateWholePathRedesignAnchor(root);
  if (!anchor.ok) {
    throw new Error(`whole_path_redesign_anchor_invalid:${anchor.errors.join(';')}`);
  }
  return deepFreeze({});
}

module.exports = deepFreeze({
  deepFreeze,
  resolveCommitSha,
  listDiffPaths,
  gitBlobSha256AtCommit,
  sha256Buffer,
  sortedPaths,
  pathsEqual,
  selectPathsByCandidateTipBlobEquality,
  filterExcludedPaths,
  ALWAYS_EXCLUDE_PATHS,
  buildCertificateFromCandidate,
  freezeCertificate,
  verifyCertificateIdentity,
  verifyCertificateChainOrder,
  effectiveBlobMap,
  verifyEffectiveBlobsAtTip,
  validateWholePathRedesignAnchor,
  validateWholePathRedesignAnchorData,
  verifyReviewedBlobCertificates,
  tipAcceptsCertificates,
  certificatesBeforeRedesign,
  makeMultiSquashUnrelatedTopology,
  deriveBlobs,
  buildSupersedingCertificateChain,
  loadWholePathRedesignBlobs,
  WHOLE_PATH_BLOBS_FIXTURE_REL: redesignPin.ANCHOR_FIXTURE_REL,
  REDESIGN_CERT_ID: redesignPin.REDESIGN_CERT_ID,
  SQUASH_PROOF_CERT_ID: redesignPin.SQUASH_PROOF_CERT_ID,
  redesignPin,
});
