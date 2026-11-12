#!/usr/bin/env node
'use strict';

/**
 * France Wolfhouse TEST/staging fast deploy for Skip.
 *
 * Rebuilds only Staff and/or Luna based on files changed between two SHAs.
 * Mandatory backup. Never prod. Never prune. Default: plan only (no compose up).
 *
 *   node scripts/france-wolfhouse-staging-fast-deploy.js --from <liveSha> --to <masterSha>
 *   node scripts/france-wolfhouse-staging-fast-deploy.js --staff-from <sha> --staff-to <sha> --luna-from <sha> --luna-to <sha>
 *   node scripts/france-wolfhouse-staging-fast-deploy.js --from <liveSha> --to <masterSha> --apply
 *
 * Staff and Luna may be pinned to different tested SHAs.
 * --skip-in-image-tests is allowed only when --github-checks-passed-sha equals the Luna (or shared) to-SHA.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  STAFF_IMAGE,
  LUNA_IMAGE,
  LUNA_IMAGE_ALIAS,
  STAFF_COMPOSE,
  LUNA_COMPOSE,
  STAFF_SERVICE,
  LUNA_SERVICE,
  classifyChangedImages,
  isProdComposePath,
  canSkipInImageTests,
  estimateMinutes,
} = require('./lib/france-staging-changed-images');
const {
  assertDeployTargetHasCodeMigrations,
} = require('./lib/deploy-required-migrations-gate');

function die(msg) {
  console.error('FASTDEPLOY FAIL:', msg);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || '').trim();
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) die(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}

function changedFiles(fromSha, toSha, cwd) {
  if (!fromSha || !toSha) return [];
  const out = git(['diff', '--name-only', `${fromSha}...${toSha}`], cwd);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

function printHelp() {
  console.log(`France Wolfhouse TEST staging fast deploy (Skip helper)

Usage:
  node scripts/france-wolfhouse-staging-fast-deploy.js --from <liveSha> --to <masterSha>
  node scripts/france-wolfhouse-staging-fast-deploy.js --staff-from <sha> --staff-to <sha> --luna-from <sha> --luna-to <sha>
  node scripts/france-wolfhouse-staging-fast-deploy.js --from <liveSha> --to <masterSha> --apply

Flags:
  --from SHA                     shared live revision (fallback for both services)
  --to SHA                       shared land SHA (fallback for both services)
  --staff-from SHA               live Staff image revision
  --staff-to SHA                 tested Staff image/SHA to pin
  --luna-from SHA                live Luna image revision
  --luna-to SHA                  tested Luna image/SHA to pin
  --apply                        backup, build, compose swap, health, exact-commit (default: plan only)
  --skip-in-image-tests          skip Luna in-image unittests
  --github-checks-passed-sha SHA required with --skip-in-image-tests; must equal Luna to-SHA (or shared --to)
  --repo DIR                     git repo (default: cwd)
  --staff-compose PATH           default ${STAFF_COMPOSE}
  --luna-compose PATH            default ${LUNA_COMPOSE}

Rules:
  Backup is mandatory before any compose swap.
  Rebuild only the image(s) whose files changed.
  Staff image: ${STAFF_IMAGE}:<sha>
  Luna image:  ${LUNA_IMAGE}:<sha> (compose may still say ${LUNA_IMAGE_ALIAS})
  Never prod compose. Never --remove-orphans. --no-deps --pull never only.
  Expected one-line Staff-only: ~4 min. Luna-only with skip-tests: ~8 min. Both skip-tests: ~10 min.
`);
}

function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }
  const started = Date.now();
  const repo = arg('--repo', process.cwd());
  const sharedFrom = arg('--from', '');
  const sharedTo = arg('--to', '');
  let staffFrom = arg('--staff-from', '') || sharedFrom;
  let staffTo = arg('--staff-to', '') || sharedTo;
  let lunaFrom = arg('--luna-from', '') || sharedFrom;
  let lunaTo = arg('--luna-to', '') || sharedTo;
  if (!staffTo && !lunaTo) {
    const head = git(['rev-parse', 'HEAD'], repo);
    staffTo = head;
    lunaTo = head;
  }
  const apply = hasFlag('--apply');
  const staffCompose = arg('--staff-compose', STAFF_COMPOSE);
  const lunaCompose = arg('--luna-compose', LUNA_COMPOSE);
  const wantSkipTests = hasFlag('--skip-in-image-tests');
  const checksSha = arg('--github-checks-passed-sha', '');
  const skipAgainst = lunaTo || staffTo;
  const skipTests = canSkipInImageTests({
    githubChecksPassed: wantSkipTests && !!checksSha,
    commitSha: skipAgainst,
    checkedSha: checksSha,
  });

  if (wantSkipTests && !skipTests) {
    die('--skip-in-image-tests requires --github-checks-passed-sha equal to Luna --luna-to (or shared --to)');
  }
  if (isProdComposePath(staffCompose) || isProdComposePath(lunaCompose)) {
    die('prod compose path refused');
  }

  const staffFiles = changedFiles(staffFrom, staffTo, repo);
  const lunaFiles = changedFiles(lunaFrom, lunaTo, repo);
  const plan = {
    staff: classifyChangedImages(staffFiles).staff,
    luna: classifyChangedImages(lunaFiles).luna,
  };
  const files = [...new Set([...staffFiles, ...lunaFiles])];
  const minutes = estimateMinutes(plan, skipTests);

  console.log('FASTDEPLOY plan');
  console.log('staff_from', staffFrom || '(none)');
  console.log('staff_to', staffTo || '(none)');
  console.log('luna_from', lunaFrom || '(none)');
  console.log('luna_to', lunaTo || '(none)');
  console.log('staff', plan.staff ? 'BUILD' : 'skip');
  console.log('luna', plan.luna ? 'BUILD' : 'skip');
  console.log('skip_in_image_tests', skipTests ? 'yes' : 'no (default on)');
  console.log('apply', apply ? 'yes' : 'no (plan only)');
  console.log('expected_minutes', minutes);
  console.log('changed_files', files.length);
  files.slice(0, 40).forEach((f) => console.log(' -', f));

  if (!apply) {
    console.log(`FASTDEPLOY PLAN-ONLY ${((Date.now() - started) / 1000).toFixed(1)}s expected ~${minutes} min`);
    return;
  }
  if (plan.staff && !staffFrom) die('--staff-from or --from is required with --apply when Staff is in the plan');
  if (plan.luna && !lunaFrom) die('--luna-from or --from is required with --apply when Luna is in the plan');
  if (!plan.staff && !plan.luna) {
    console.log('FASTDEPLOY nothing to rebuild');
    console.log(`FASTDEPLOY DONE ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  applyDeploy({
    repo,
    staffFrom,
    staffTo,
    lunaFrom,
    lunaTo,
    plan,
    skipTests,
    staffCompose,
    lunaCompose,
    started,
    minutes,
  });
}

function sh(bin, args, opts) {
  const r = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(opts || {}) });
  if (r.status !== 0) die(`${bin} ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}

function materializeCommitTree(repo, sha, dest) {
  if (!sha) die('missing commit to materialize');
  fs.mkdirSync(dest, { recursive: true });
  const archived = spawnSync('git', ['-C', repo, 'archive', sha], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archived.status !== 0) {
    die(`git archive ${sha}: ${String(archived.stderr || archived.stdout || '')}`);
  }
  const extracted = spawnSync('tar', ['-x', '-C', dest], { input: archived.stdout });
  if (extracted.status !== 0) {
    die(`tar extract ${sha}: ${String(extracted.stderr || extracted.stdout || '')}`);
  }
  return dest;
}

function imageRevision(imageTag) {
  const r = spawnSync('sudo', [
    'docker', 'image', 'inspect', '-f',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    imageTag,
  ], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function buildFromCommit(opts) {
  const imageTag = `${opts.image}:${opts.sha}`;
  if (imageRevision(imageTag) === opts.sha) {
    console.log('reuse', imageTag);
    return;
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-deploy-'));
  try {
    materializeCommitTree(opts.repo, opts.sha, dest);
    const context = path.join(dest, opts.contextRel || '.');
    const dockerfile = path.join(dest, opts.dockerfileRel);
    const args = [
      'docker', 'build',
      '--label', `org.opencontainers.image.revision=${opts.sha}`,
      '-t', imageTag,
      '-f', dockerfile,
    ];
    if (opts.extraArgs && opts.extraArgs.length) args.splice(2, 0, ...opts.extraArgs);
    args.push(context);
    console.log('build', imageTag, 'from', opts.sha);
    sh('sudo', args, { stdio: 'inherit' });
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function backupFile(src, destDir) {
  if (isProdComposePath(src)) die('prod compose refused: ' + src);
  if (!fs.existsSync(src)) die('compose missing: ' + src);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  if (fs.existsSync(dest)) die('backup already exists, refuse overwrite: ' + dest);
  fs.copyFileSync(src, dest);
  console.log('backup', dest);
  return dest;
}

function replaceImageOnce(composePath, oldTag, newTag) {
  const text = fs.readFileSync(composePath, 'utf8');
  const count = text.split(oldTag).length - 1;
  if (count !== 1) die(`expected exactly one ${oldTag} in ${composePath}, found ${count}`);
  fs.writeFileSync(composePath, text.replace(oldTag, newTag));
}

function applyDeploy(ctx) {
  const {
    repo, plan, skipTests,
    staffCompose, lunaCompose, started, minutes,
  } = ctx;
  const staffFrom = ctx.staffFrom || ctx.fromSha;
  const staffTo = ctx.staffTo || ctx.toSha;
  const lunaFrom = ctx.lunaFrom || ctx.fromSha;
  const lunaTo = ctx.lunaTo || ctx.toSha;
  const ts = stamp();
  const staffRollback = `/srv/staff/rollback/pre-fast-${String(staffTo || 'staff').slice(0, 8)}-${ts}`;
  const lunaRollback = `/srv/luna/wolfhouse/rollback/pre-fast-${String(lunaTo || 'luna').slice(0, 8)}-${ts}`;

  if (plan.staff) backupFile(staffCompose, staffRollback);
  if (plan.luna) backupFile(lunaCompose, lunaRollback);
  console.log('backup_ok');

  if (plan.staff) {
    const t0 = Date.now();
    buildFromCommit({
      repo,
      sha: staffTo,
      image: STAFF_IMAGE,
      dockerfileRel: 'Dockerfile',
      contextRel: '.',
    });
    console.log('staff_build_s', ((Date.now() - t0) / 1000).toFixed(1));
  }
  if (plan.luna) {
    const t0 = Date.now();
    const extraArgs = skipTests ? ['--build-arg', 'SKIP_IN_IMAGE_TESTS=1'] : [];
    buildFromCommit({
      repo,
      sha: lunaTo,
      image: LUNA_IMAGE,
      dockerfileRel: 'docker/hermes-staging/Dockerfile',
      contextRel: 'docker/hermes-staging',
      extraArgs,
    });
    sh('sudo', ['docker', 'tag', `${LUNA_IMAGE}:${lunaTo}`, `${LUNA_IMAGE_ALIAS}:${lunaTo}`]);
    console.log('luna_build_s', ((Date.now() - t0) / 1000).toFixed(1));
  }

  if (plan.staff) {
    // The image must never go live with only a SQL file shipped but not applied.
    // This narrowly scoped migration changes pricing settings only, not bookings.
    if (staffCompose !== STAFF_COMPOSE) die('migration134 requires the exact France staging compose');
    const composeOwner = sh('sudo', ['docker', 'inspect', '-f',
      '{{index .Config.Labels "com.docker.compose.project.config_files"}}', 'ovh-wolfhouse-staff']);
    if (composeOwner !== STAFF_COMPOSE) die('migration134 staging container ownership mismatch');
    const program = require('./lib/france-staging-nights-deposit-migration').buildMigrationProgram(repo);
    const receipt = sh('sudo', ['docker', 'exec', '-i', 'ovh-wolfhouse-staff', 'node', '-'], { input: program, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!receipt.startsWith('MIGRATION134_PASS ')) die('migration134 missing verified receipt');
    fs.writeFileSync(path.join(staffRollback, 'migration134-receipt.log'), receipt + '\n', { mode: 0o600 });
    console.log(receipt);
    replaceImageOnce(staffCompose, `${STAFF_IMAGE}:${staffFrom}`, `${STAFF_IMAGE}:${staffTo}`);
    sh('sudo', [
      'docker', 'compose', '--project-directory', '/srv/staff/compose',
      '-f', staffCompose, 'up', '-d', '--no-deps', '--pull', 'never', STAFF_SERVICE,
    ], { stdio: 'inherit' });
  }
  if (plan.luna) {
    const lunaText = fs.readFileSync(lunaCompose, 'utf8');
    const lunaOld = lunaText.includes(`${LUNA_IMAGE}:${lunaFrom}`)
      ? `${LUNA_IMAGE}:${lunaFrom}`
      : `${LUNA_IMAGE_ALIAS}:${lunaFrom}`;
    const lunaNew = lunaOld.startsWith(LUNA_IMAGE + ':')
      ? `${LUNA_IMAGE}:${lunaTo}`
      : `${LUNA_IMAGE_ALIAS}:${lunaTo}`;
    replaceImageOnce(lunaCompose, lunaOld, lunaNew);
    sh('sudo', [
      'docker', 'compose', '-p', 'config',
      '-f', lunaCompose, 'up', '-d', '--no-deps', '--pull', 'never', LUNA_SERVICE,
    ], { stdio: 'inherit' });
  }

  if (plan.staff) {
    const health = sh('curl', ['-fsS', '-o', '/dev/null', '-w', '%{http_code}', 'https://staff-staging.lunafrontdesk.com/healthz']);
    if (health !== '200') die('staff healthz ' + health);
    console.log('staff_healthz 200');
    const rev = sh('sudo', ['docker', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', 'ovh-wolfhouse-staff']);
    if (rev !== staffTo) die('staff revision ' + rev + ' != ' + staffTo);
    console.log('staff_revision', rev);
  }
  if (plan.luna) {
    const rev = sh('sudo', ['docker', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', 'hermes-luna']);
    if (rev !== lunaTo) die('luna revision ' + rev + ' != ' + lunaTo);
    console.log('luna_revision', rev);
  }
  try {
    assertDeployTargetHasCodeMigrations({
      repoRoot: repo,
      target: 'france-staging',
      exec: (bin, args) => sh(bin, args),
    });
  } catch (err) {
    die(err && err.message ? err.message : err);
  }
  console.log(`FASTDEPLOY DONE ${((Date.now() - started) / 1000).toFixed(1)}s (budget ~${minutes} min) staff ${staffTo} luna ${lunaTo}`);
}

if (require.main === module) {
  main();
}

module.exports = { changedFiles, main, materializeCommitTree, buildFromCommit };
