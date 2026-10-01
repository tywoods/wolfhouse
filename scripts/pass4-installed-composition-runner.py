#!/usr/bin/env python3
"""Separately authorized external host only; no freeze/hash/extract or known suites.
Usage: python3 SCRIPT --describe ABSOLUTE_REVIEWED_SOURCE
       python3 SCRIPT run ABSOLUTE_REVIEWED_SOURCE NEW_RESULTS_DIR
SOURCE must be an independently reviewed, quiescent candidate directory.
This bounded gate does not establish immutable source equivalence or authorize live.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import uuid

IMAGE = 'sha256:cb7f496ddae204b3d7fa009b420deda5353082814109d39c6d8e2d94e3b6f688'
SUITE = 'wolfhouse.test_pass4_installed_composition'
EXPECTED_TEST_IDS = frozenset({
    'wolfhouse.test_pass4_installed_composition.InstalledComposition.test_real_gateway_executor_plugin_alias_and_ordinary_positive',
    'wolfhouse.test_pass4_installed_composition.InstalledComposition.test_already_entered_safe_transport_remains_owned',
    'wolfhouse.test_pass4_installed_composition.InstalledComposition.test_real_gateway_executor_revocation_and_settlement',
    'wolfhouse.test_pass4_installed_composition.InstalledComposition.test_already_entered_real_sqlite_write_fences_cleanup',
    'wolfhouse.test_pass4_installed_composition.InstalledComposition.test_real_aiohttp_handler_auth_and_staging_before_dispatch',
})


def accept_composition_report(report, code, accept_report):
    try:
        expected = sorted(EXPECTED_TEST_IDS)
        return (accept_report(report, SUITE, code)
                and sorted(report['inventory']) == expected
                and sorted(report['executed']) == expected)
    except (KeyError, TypeError, ValueError):
        return False


def command(source, name):
    if not source.is_absolute() or not source.is_dir() or ',' in str(source):
        raise ValueError('absolute reviewed source directory required; commas forbidden')
    return ['docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1g',
            '--cpus=1', '--pids-limit=128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
            '--mount', f'type=bind,src={source},dst=/candidate,readonly',
            '--workdir', '/candidate/docker/hermes-staging', '--name', name,
            '--env', 'HOME=/tmp/pass4-home', '--env', 'HERMES_HOME=/tmp/pass4-home',
            '--env', 'PYTHONDONTWRITEBYTECODE=1',
            '--env', 'PYTHONPATH=/candidate/docker/hermes-staging:/candidate/docker/hermes-staging/plugins:/opt/hermes',
            '--env', 'LUNA_BOT_INTERNAL_TOKEN=', '--env', 'HERMES_ENABLE_PROJECT_PLUGINS=false',
            '--entrypoint', 'python3', IMAGE, '-c',
            "import os,runpy,sys; os.makedirs(os.environ['HOME'],exist_ok=True); "
            "sys.argv=['/candidate/scripts/pass4-external-offline-runner.py','suite',"
            + repr(SUITE) + "]; runpy.run_path(sys.argv[0],run_name='__main__')"]


def main():
    mode, source = sys.argv[1], Path(sys.argv[2]).resolve()
    name = 'pass4-composition-' + uuid.uuid4().hex
    argv = command(source, name)
    if mode == '--describe':
        print(json.dumps(argv, indent=2)); return 0
    if mode != 'run' or len(sys.argv) != 4: raise SystemExit(__doc__)
    output = Path(sys.argv[3]).resolve()
    if output.is_relative_to(source): raise SystemExit('results must be outside candidate')
    output.mkdir(parents=True, exist_ok=False)
    identity = subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',IMAGE],
                                       text=True, timeout=30).strip()
    if identity != IMAGE: raise SystemExit('existing image mismatch; no pull permitted')
    cleanup_ok = True
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        code, log = result.returncode, result.stdout
    except subprocess.TimeoutExpired as exc:
        code, log = 124, (exc.stdout or b'') + b'\nCOMPOSITION TIMEOUT\n'
        try:
            cleanup = subprocess.run(['docker','rm','--force',name], stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, timeout=30)
            cleanup_ok = cleanup.returncode == 0
            log += cleanup.stdout
        except subprocess.TimeoutExpired:
            cleanup_ok = False
    (output / 'composition.log').write_bytes(log)
    helper = source / 'scripts/pass4-external-offline-runner.py'
    spec = importlib.util.spec_from_file_location('pass4_report_validator', helper)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    report = None
    try:
        reports = [line[len(module.REPORT_MARKER):] for line in log.decode().splitlines()
                   if line.startswith(module.REPORT_MARKER)]
        if len(reports) == 1: report = json.loads(reports[0])
    except (ValueError, UnicodeError): pass
    complete = (cleanup_ok and isinstance(report, dict)
                and accept_composition_report(report, code, module.accept_report))
    receipt = {'image':IMAGE,'source':str(source),'command':argv,'exit':code,
               'complete':complete,'report':report,'cleanup_ok':cleanup_ok,
               'immutable_source_verified':False,'live_authorized':False}
    (output / 'results.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))
    return 0 if complete else 1


if __name__ == '__main__': raise SystemExit(main())
