#!/usr/bin/env python3
"""EXTERNAL authorized host only. Do not execute freeze/hash/extract in gateway.
Usage: python3 SCRIPT freeze SOURCE NEW_OUTPUT_DIR
       python3 SCRIPT run CANDIDATE_TAR INDEPENDENT_SHA256 NEW_RESULTS_DIR
No install/build/pull/service mounts; only a disposable network-none container.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import uuid
import unittest
from pathlib import PurePosixPath

REPORT_MARKER = 'PASS4_TEST_RESULT='

def validate_members(members):
    seen = set()
    for member in members:
        name = PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or not member.isfile() or not name.parts:
            raise ValueError('unsafe archive member')
        normalized = str(name)
        if normalized in seen:
            raise ValueError('duplicate normalized archive target')
        # Also reject file/ancestor conflicts before any extraction begins.
        if any(normalized.startswith(old + '/') or old.startswith(normalized + '/') for old in seen):
            raise ValueError('archive file/ancestor conflict')
        seen.add(normalized)
    return sorted(seen)

def test_inventory(suite):
    ids = []
    for test in suite:
        ids.extend(test_inventory(test) if isinstance(test, unittest.TestSuite) else [test.id()])
    return ids

def accept_report(report, name, code):
    try:
        inventory = report['inventory']
        executed = report['executed']
        return (code == 0 and report['suite'] == name and report['complete'] is True
                and type(report['testsRun']) is int and report['testsRun'] > 0
                and len(inventory) == len(set(inventory)) == report['testsRun']
                and sorted(inventory) == sorted(executed)
                and all(isinstance(item, str) and item.startswith(name + '.') for item in inventory)
                and all(report[field] == [] for field in ('failures','errors','skipped','expectedFailures','unexpectedSuccesses')))
    except (KeyError, TypeError, ValueError):
        return False

def execute_suite(suite, name, stream=None):
    inventory = test_inventory(suite)
    class RecordingResult(unittest.TextTestResult):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.executed = []
        def startTest(self, test):
            self.executed.append(test.id())
            super().startTest(test)
    result = unittest.TextTestRunner(stream=stream or sys.stderr, verbosity=2, resultclass=RecordingResult).run(suite)
    report = {'suite':name, 'inventory':inventory, 'executed':result.executed, 'testsRun':result.testsRun,
              'failures':[(t.id(), detail) for t, detail in result.failures],
              'errors':[(t.id(), detail) for t, detail in result.errors],
              'skipped':[(t.id(), detail) for t, detail in result.skipped],
              'expectedFailures':[(t.id(), detail) for t, detail in result.expectedFailures],
              'unexpectedSuccesses':[t.id() for t in result.unexpectedSuccesses], 'complete':True}
    report['complete'] = accept_report(report, name, 0)
    return report

def suite_main(name):
    report = execute_suite(unittest.defaultTestLoader.loadTestsFromName(name), name)
    print(REPORT_MARKER + json.dumps(report, sort_keys=True), flush=True)
    return 0 if report['complete'] else 1


IMAGE = 'sha256:cb7f496ddae204b3d7fa009b420deda5353082814109d39c6d8e2d94e3b6f688'
SOURCE = Path('/opt/data/workspace/sandbox-repos/WH-orchestrator-pass4-liveadmission-20260930')
SUITES = ['wolfhouse.test_owned_worker_lifetime', 'wolfhouse.test_golden_admission_safety',
          'wolfhouse.test_golden_real_storage', 'wolfhouse.test_registered_golden_transport',
          'wolfhouse.test_pass4_ingress_matrix', 'wolfhouse.test_crowsnest_guest_door',
          'wolfhouse.test_accepted_quote', 'wolfhouse.test_original_inbound', 'wolfhouse.test_newir_repairs']

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def fresh(path):
    path.mkdir(parents=True, exist_ok=False)
    return path.resolve()

def parse_git_modes(records):
    modes = {}
    for record in records.split(b'\0'):
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        mode, object_id, stage = metadata.split()
        name = os.fsdecode(name)
        if stage != b'0' or name in modes:
            raise SystemExit('unmerged or duplicate git index path')
        modes[name] = mode.decode('ascii')
    return modes


def source_file(source, name, modes):
    """Resolve only indexed relative file links; never traverse directory links."""
    relative = PurePosixPath(name)
    if (not relative.parts or relative.is_absolute() or '..' in relative.parts
            or '\0' in name or str(relative) != name):
        raise SystemExit('unsafe source path')
    source = source.resolve()
    visited = set()
    while True:
        original = source / relative
        for parent in list(relative.parents)[:-1]:
            if (source / parent).is_symlink():
                raise SystemExit('symlink source ancestor: ' + name)
        if not original.is_symlink():
            if not original.is_file():
                raise SystemExit('nonregular source: ' + name)
            return original
        key = relative.as_posix()
        if modes.get(key) != '120000' or key in visited:
            raise SystemExit('untracked or cyclic source symlink: ' + name)
        visited.add(key)
        link = PurePosixPath(os.readlink(original))
        if link.is_absolute():
            raise SystemExit('absolute source symlink: ' + name)
        parts = list(relative.parent.parts)
        for part in link.parts:
            if part == '..':
                if not parts:
                    raise SystemExit('escaping source symlink: ' + name)
                parts.pop()
            elif part != '.':
                parts.append(part)
        relative = PurePosixPath(*parts)
        if not relative.parts:
            raise SystemExit('nonregular source: ' + name)


def freeze(source, output):
    source = source.resolve()
    if source != SOURCE: raise SystemExit('sole authorized source path required')
    if output.resolve().is_relative_to(source): raise SystemExit('output must be outside source')
    output = fresh(output)
    snapshot = fresh(output / 'snapshot')
    modes = parse_git_modes(subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=source))
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=source).decode().split('\0')
    # Raw local receipts may match repository *.log ignores; retain them in the
    # external test artifact anyway, rather than silently freezing only prose.
    names += ['docs/PASS4-F3F4-focused.log', 'docs/PASS4-F3F4-node.log',
              'docs/PASS4-F3F4-local-results.json']
    manifest = {}
    for name in sorted(set(names) - {''}):
        original = source_file(source, name, modes)
        relative = Path(name)
        target = snapshot / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, target)
        manifest[name] = digest(target)
        target.chmod(0o444)
    (output / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    shutil.copyfile(output / 'manifest.json', snapshot / 'PASS4-FROZEN-MANIFEST.json')
    archive = output / 'candidate.tar'
    with tarfile.open(archive, 'w') as tar:
        for file in sorted(snapshot.rglob('*')):
            if file.is_file(): tar.add(file, arcname=str(file.relative_to(snapshot)), recursive=False)
    archive.chmod(0o444)
    receipt = {'archive':str(archive), 'sha256':digest(archive), 'manifest':str(output / 'manifest.json'),
               'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip(),
               'status':subprocess.check_output(['git','status','--short'],cwd=source,text=True),
               'source_only':True, 'independent_approval':False}
    (output / 'freeze-receipt.json').write_text(json.dumps(receipt,indent=2) + '\n')
    print(json.dumps(receipt,indent=2))

def run(archive, expected, output):
    if len(expected) != 64 or digest(archive) != expected: raise SystemExit('independent archive SHA256 mismatch')
    output = fresh(output)
    candidate = fresh(output / 'candidate')
    with tarfile.open(archive) as tar:
        validate_members(tar.getmembers())
        tar.extractall(candidate, filter='data')
    manifest = json.loads((candidate / 'PASS4-FROZEN-MANIFEST.json').read_text())
    actual = {str(p.relative_to(candidate)):digest(p) for p in candidate.rglob('*') if p.is_file() and str(p.relative_to(candidate)) != 'PASS4-FROZEN-MANIFEST.json'}
    if actual != manifest: raise SystemExit('extracted file manifest mismatch')
    for file in candidate.rglob('*'):
        if file.is_file(): file.chmod(0o444)
    identity = subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',IMAGE],text=True).strip()
    if identity != IMAGE: raise SystemExit('existing image identity mismatch; no pull allowed')
    common = ['docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL',
              '--security-opt=no-new-privileges','--memory=1g','--cpus=1','--pids-limit=128',
              '--tmpfs','/tmp:rw,nosuid,nodev,size=256m','--mount',f'type=bind,src={candidate},dst=/candidate,readonly',
              '--workdir','/candidate/docker/hermes-staging','--env','HOME=/tmp/pass4-home',
              '--env','HERMES_HOME=/tmp/pass4-home','--env','PYTHONDONTWRITEBYTECODE=1',
              '--env','PYTHONPATH=/candidate/docker/hermes-staging:/candidate/docker/hermes-staging/plugins:/opt/hermes',
              '--env','LUNA_BOT_INTERNAL_TOKEN=','--env','WOLFHOUSE_STAFF_API_BASE_URL=http://127.0.0.1:1']
    checks = [('installed-imports',['python3','-c',
        "import os;os.makedirs(os.environ['HOME'],exist_ok=True);import gateway.session,hermes_state,aiohttp;from wolfhouse import crowsnest_guest_door;print(gateway.session.__file__,hermes_state.__file__,aiohttp.__file__,crowsnest_guest_door.__file__)"])]
    checks += [(suite,['python3','/candidate/scripts/pass4-external-offline-runner.py','suite',suite]) for suite in SUITES]
    checks += [('runner-offline',['python3','/candidate/scripts/test_pass4_external_runner.py'])]
    checks += [('node-golden',['node','/candidate/scripts/verify-golden-admission-safety.js'])]
    receipts = []
    for name, argv in checks:
        container_name = 'pass4-offline-' + uuid.uuid4().hex
        command = common + ['--name',container_name,'--entrypoint',argv[0],IMAGE] + argv[1:]
        try:
            result = subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=600)
            code, log = result.returncode, result.stdout
        except subprocess.TimeoutExpired as exc:
            code, log = 124, (exc.stdout or b'') + b'\nEXTERNAL TIMEOUT\n'
            # The Docker CLI may die while its disposable test container lives.
            # Remove ONLY this unpredictable name created by this invocation;
            # never enumerate/touch a gateway or other service container.
            try:
                cleanup = subprocess.run(['docker','rm','--force',container_name],
                    stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
                log += b'\nDISPOSABLE TEST CLEANUP\n' + cleanup.stdout
                log += ('cleanup exit ' + str(cleanup.returncode) + '\n').encode()
            except subprocess.TimeoutExpired:
                log += b'DISPOSABLE TEST CLEANUP TIMEOUT; settlement BLOCK\n'
        (output / (name + '.log')).write_bytes(log)
        report = None
        accepted = code == 0
        if name in SUITES:
            try:
                lines = [line[len(REPORT_MARKER):] for line in log.decode().splitlines() if line.startswith(REPORT_MARKER)]
                report = json.loads(lines[0]) if len(lines) == 1 else None
                accepted = isinstance(report, dict) and accept_report(report, name, code)
            except (ValueError, UnicodeError):
                accepted = False
        receipts.append({'name':name,'exit':code,'command':command,'outcome':report,'complete':accepted})
        print(name, 'exit', code, flush=True)
    after = {str(p.relative_to(candidate)):digest(p) for p in candidate.rglob('*') if p.is_file() and str(p.relative_to(candidate)) != 'PASS4-FROZEN-MANIFEST.json'}
    unchanged = after == manifest and digest(archive) == expected
    inventory_verified = ([r['name'] for r in receipts if r['name'] in SUITES] == SUITES and len(SUITES) == len(set(SUITES)))
    (output / 'results.json').write_text(json.dumps({'image':IMAGE,'archive_sha256':expected,'manifest_verified':True,'suite_inventory_verified':inventory_verified,'source_unchanged_after_tests':unchanged,'results':receipts,'live_authorized':False},indent=2) + '\n')
    raise SystemExit(0 if unchanged and inventory_verified and all(r['complete'] for r in receipts) else 1)

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'suite': raise SystemExit(suite_main(sys.argv[2]))
    elif len(sys.argv) == 4 and sys.argv[1] == 'freeze': freeze(Path(sys.argv[2]),Path(sys.argv[3]))
    elif len(sys.argv) == 5 and sys.argv[1] == 'run': run(Path(sys.argv[2]),sys.argv[3],Path(sys.argv[4]))
    else: raise SystemExit(__doc__)
