#!/usr/bin/env node
'use strict';

/**
 * France Wolfhouse TEST/staging fast deploy for Skip.
 *
 * Rebuilds only Staff and/or Luna based on files changed between two SHAs.
 * Mandatory backup. Never prod. Never prune. Default: plan only (no compose up).
 *
 *   node scripts/france-wolfhouse-staging-fast-deploy.js --from <liveSha> --to <masterSha>
 *   node scripts/france-wolfhouse-staging-fast-deploy.js --from <liveSha> --to <masterSha> --apply
 *
 * --skip-in-image-tests is allowed only when --github-checks-passed-sha equals --to.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
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
  node scripts/france-wolfhouse-staging-fast-deploy.js --from <liveSha> --to <masterSha> --apply

Flags:
  --from SHA                     currently live image revision
  --to SHA                       master SHA to land
  --apply                        backup, build, compose swap, health, exact-commit (default: plan only)
  --skip-in-image-tests          skip Luna in-image unittests
  --github-checks-passed-sha SHA required with --skip-in-image-tests; must equal --to
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
  const fromSha = arg('--from', '');
  const toSha = arg('--to', git(['rev-parse', 'HEAD'], repo));
  const apply = hasFlag('--apply');
  const staffCompose = arg('--staff-compose', STAFF_COMPOSE);
  const lunaCompose = arg('--luna-compose', LUNA_COMPOSE);
  const wantSkipTests = hasFlag('--skip-in-image-tests');
  const checksSha = arg('--github-checks-passed-sha', '');
  const skipTests = canSkipInImageTests({
    githubChecksPassed: wantSkipTests && !!checksSha,
    commitSha: toSha,
    checkedSha: checksSha,
  });

  if (wantSkipTests && !skipTests) {
    die('--skip-in-image-tests requires --github-checks-passed-sha equal to --to (GitHub already green for that exact commit)');
  }
  if (isProdComposePath(staffCompose) || isProdComposePath(lunaCompose)) {
    die('prod compose path refused');
  }

  const files = changedFiles(fromSha, toSha, repo);
  const plan = classifyChangedImages(files);
  const minutes = estimateMinutes(plan, skipTests);

  console.log('FASTDEPLOY plan');
  console.log('from', fromSha || '(none)');
  console.log('to', toSha);
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
  if (!fromSha) die('--from is required with --apply (backup + exact-commit need the live SHA)');
  if (!plan.staff && !plan.luna) {
    console.log('FASTDEPLOY nothing to rebuild');
    console.log(`FASTDEPLOY DONE ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  applyDeploy({
    repo,
    fromSha,
    toSha,
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
  const { repo, fromSha, toSha, plan, skipTests, staffCompose, lunaCompose, started, minutes } = ctx;
  const ts = stamp();
  const staffRollback = `/srv/staff/rollback/pre-fast-${toSha.slice(0, 8)}-${ts}`;
  const lunaRollback = `/srv/luna/wolfhouse/rollback/pre-fast-${toSha.slice(0, 8)}-${ts}`;

  if (plan.staff) backupFile(staffCompose, staffRollback);
  if (plan.luna) backupFile(lunaCompose, lunaRollback);
  console.log('backup_ok');

  if (plan.staff) {
    const t0 = Date.now();
    console.log('build staff', `${STAFF_IMAGE}:${toSha}`);
    sh('sudo', [
      'docker', 'build',
      '--label', `org.opencontainers.image.revision=${toSha}`,
      '-t', `${STAFF_IMAGE}:${toSha}`,
      '-f', path.join(repo, 'Dockerfile'),
      repo,
    ], { stdio: 'inherit' });
    console.log('staff_build_s', ((Date.now() - t0) / 1000).toFixed(1));
  }
  if (plan.luna) {
    const t0 = Date.now();
    const args = [
      'docker', 'build',
      '--label', `org.opencontainers.image.revision=${toSha}`,
      '-t', `${LUNA_IMAGE}:${toSha}`,
      '-f', path.join(repo, 'docker/hermes-staging/Dockerfile'),
      path.join(repo, 'docker/hermes-staging'),
    ];
    if (skipTests) args.splice(2, 0, '--build-arg', 'SKIP_IN_IMAGE_TESTS=1');
    console.log('build luna', `${LUNA_IMAGE}:${toSha}`, skipTests ? 'skip-tests' : 'with-tests');
    sh('sudo', args, { stdio: 'inherit' });
    sh('sudo', ['docker', 'tag', `${LUNA_IMAGE}:${toSha}`, `${LUNA_IMAGE_ALIAS}:${toSha}`]);
    console.log('luna_build_s', ((Date.now() - t0) / 1000).toFixed(1));
  }

  if (plan.staff) {
    replaceImageOnce(staffCompose, `${STAFF_IMAGE}:${fromSha}`, `${STAFF_IMAGE}:${toSha}`);
    sh('sudo', [
      'docker', 'compose', '--project-directory', '/srv/staff/compose',
      '-f', staffCompose, 'up', '-d', '--no-deps', '--pull', 'never', STAFF_SERVICE,
    ], { stdio: 'inherit' });
  }
  if (plan.luna) {
    const lunaText = fs.readFileSync(lunaCompose, 'utf8');
    const lunaOld = lunaText.includes(`${LUNA_IMAGE}:${fromSha}`)
      ? `${LUNA_IMAGE}:${fromSha}`
      : `${LUNA_IMAGE_ALIAS}:${fromSha}`;
    const lunaNew = lunaOld.startsWith(LUNA_IMAGE + ':')
      ? `${LUNA_IMAGE}:${toSha}`
      : `${LUNA_IMAGE_ALIAS}:${toSha}`;
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
    if (rev !== toSha) die('staff revision ' + rev + ' != ' + toSha);
    console.log('staff_revision', rev);
  }
  if (plan.luna) {
    const rev = sh('sudo', ['docker', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', 'hermes-luna']);
    if (rev !== toSha) die('luna revision ' + rev + ' != ' + toSha);
    console.log('luna_revision', rev);
  }
  console.log(`FASTDEPLOY DONE ${((Date.now() - started) / 1000).toFixed(1)}s (budget ~${minutes} min) sha ${toSha}`);
}

if (require.main === module) {
  main();
}

module.exports = { changedFiles, main };
