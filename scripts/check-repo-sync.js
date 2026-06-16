'use strict';

/**
 * Compare git HEAD across laptop, origin, and Lunabox (/opt/wolfhouse/WH).
 * Warn before push/deploy if Captain has unpulled commits or the VM tree is dirty.
 *
 * Usage:
 *   node scripts/check-repo-sync.js           # warnings to stderr, exit 0
 *   node scripts/check-repo-sync.js --strict  # exit 1 on any drift
 *   node scripts/check-repo-sync.js --strict --ignore-dirty  # pre-push / deploy (sync only)
 *   node scripts/check-repo-sync.js --skip-vm # laptop vs origin only
 *   node scripts/check-repo-sync.js --json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { HERMES_VM } = require('./lib/hermes-vm-profile');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BRANCH = process.env.WH_DEFAULT_BRANCH || 'master';

const strict = process.argv.includes('--strict');
const ignoreDirty = process.argv.includes('--ignore-dirty');
const skipVm = process.argv.includes('--skip-vm');
const jsonOut = process.argv.includes('--json');

function git(args, cwd = ROOT) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

function gitOk(args, cwd = ROOT) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function azVmIp() {
  try {
    const out = execSync(
      `az vm show -g ${HERMES_VM.RG} -n ${HERMES_VM.VM_NAME} -d --query publicIps -o tsv`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function ssh(cmd) {
  const ip = azVmIp();
  if (!ip) return null;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const key = path.join(home, '.ssh', 'id_rsa');
  const keyArg = fs.existsSync(key) ? `-i ${key}` : '';
  try {
    return execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new ${keyArg} azureuser@${ip} ${JSON.stringify(cmd)}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
    ).trim();
  } catch {
    return null;
  }
}

function isAncestor(ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function short(hash) {
  return hash ? hash.slice(0, 12) : null;
}

function collect() {
  const branch = gitOk('branch --show-current') || DEFAULT_BRANCH;
  const localHead = gitOk('rev-parse HEAD');
  const localDirty = Boolean(gitOk('status --porcelain'));
  const originUrl = gitOk('remote get-url origin');
  const originHead = originUrl ? gitOk(`rev-parse origin/${branch}`) : null;

  let vm = null;
  if (!skipVm) {
    const vmHead = ssh(`git -C ${HERMES_VM.REPO_PATH} rev-parse HEAD 2>/dev/null`);
    const vmDirty = ssh(`git -C ${HERMES_VM.REPO_PATH} status --porcelain 2>/dev/null`);
    const vmBranch = ssh(`git -C ${HERMES_VM.REPO_PATH} branch --show-current 2>/dev/null`);
    const vmLog = ssh(`git -C ${HERMES_VM.REPO_PATH} log -1 --oneline 2>/dev/null`);
    if (vmHead) {
      vm = {
        head: vmHead,
        branch: vmBranch || null,
        dirty: Boolean(vmDirty),
        log: vmLog || null,
      };
    }
  }

  const warnings = [];

  if (localDirty && !ignoreDirty) {
    warnings.push('Laptop working tree has uncommitted changes — commit or stash before push/deploy.');
  }
  if (!originUrl) {
    warnings.push('No git remote "origin" — add private GitHub repo (see docs/GITHUB-REPO-SETUP.md).');
  }
  if (originUrl && !originHead) {
    const hasOriginRef = gitOk('rev-parse origin/HEAD')
      || gitOk(`rev-parse origin/${DEFAULT_BRANCH}`);
    if (!hasOriginRef) {
      warnings.push(`origin not fetched or empty — run: git fetch origin`);
    }
    // Missing origin/<branch> on a new local branch is normal before first push.
  }
  if (originHead && localHead && isAncestor(localHead, originHead) && localHead !== originHead) {
    warnings.push('Laptop is behind origin — run: git pull before you push or deploy.');
  }
  if (originHead && localHead && !isAncestor(localHead, originHead) && !isAncestor(originHead, localHead)) {
    warnings.push('Laptop and origin have diverged — pull and merge (or rebase) before push.');
  }
  if (!skipVm && !vm) {
    warnings.push('Could not read Lunabox repo (SSH/az unavailable or no clone at /opt/wolfhouse/WH).');
  }
  if (vm) {
    if (vm.dirty) {
      warnings.push('Lunabox repo has uncommitted changes — Captain should commit + push before laptop overwrites.');
    }
    if (localHead && vm.head && vm.head !== localHead) {
      if (isAncestor(localHead, vm.head) && !isAncestor(vm.head, localHead)) {
        warnings.push('Lunabox is AHEAD of laptop — git pull on laptop (Captain pushed commits you do not have).');
      } else if (!isAncestor(localHead, vm.head) && !isAncestor(vm.head, localHead)) {
        warnings.push('Laptop and Lunabox have diverged — pull/merge on both sides before deploy.');
      }
    }
  }

  return {
    ok: warnings.length === 0,
    branch,
    local: { head: localHead, short: short(localHead), dirty: localDirty },
    origin: originUrl
      ? { url: originUrl, head: originHead, short: short(originHead) }
      : null,
    vm,
    warnings,
  };
}

function main() {
  const report = collect();

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Repo sync check');
    console.log(`  branch:  ${report.branch}`);
    console.log(`  laptop:  ${report.local.short || '?'}${report.local.dirty ? ' (dirty)' : ''}`);
    if (report.origin) {
      console.log(`  origin:  ${report.origin.short || '(not fetched)'}`);
    } else {
      console.log('  origin:  (none)');
    }
    if (report.vm) {
      console.log(
        `  lunabox: ${short(report.vm.head)}${report.vm.dirty ? ' (dirty)' : ''} — ${report.vm.log || ''}`,
      );
    } else if (!skipVm) {
      console.log('  lunabox: (unreachable)');
    }
    if (report.warnings.length) {
      console.error('\nWarnings:');
      for (const w of report.warnings) console.error(`  • ${w}`);
    } else {
      console.log('\n✓ All refs aligned (or only benign ahead-of-VM after push).');
    }
  }

  if (strict && !report.ok) process.exit(1);
}

main();
