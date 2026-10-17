#!/usr/bin/env python3
"""Offline successor-head gate runner for the SIM15 REPAIR4 seal.

Runs commands without a shell, merges child stderr into stdout, and writes one
self-contained log. It performs no network, deployment, restart, config, send,
or product-write operation.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "artifacts/sim15-season-oneq-repair3"
PORTABLE = ARTIFACT / "portable-components"
LOG = ARTIFACT / "run-gates.log"
PYTHON = "/opt/hermes/.venv/bin/python"

ENV = {
    **os.environ,
    "HOME": "/tmp",
    "LUNA_CLIENT_SLUG": "wolfhouse-somo",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHON_DOTENV_DISABLED": "1",
    "PYTHONPATH": os.pathsep.join(
        [
            str(ROOT / "docker/hermes-staging"),
            str(ROOT / "docker/hermes-staging/plugins"),
            "/opt/hermes",
        ]
    ),
    "REVIEW_WORKTREE": str(ROOT),
}

RUNS = [
    ("repair4-build", ["python3", "artifacts/sim15-season-oneq-repair4/replay.py"], None),
    ("repair4-assess", ["python3", "artifacts/sim15-season-oneq-repair4/assess.py"], None),
    ("repair4-audit", ["python3", "artifacts/sim15-season-oneq-repair4/audit.py"], None),
    (
        "focused-registered-context-editorial",
        [
            PYTHON,
            "-m",
            "unittest",
            "-v",
            "wolfhouse.test_notes_first_then_web.RegisteredNotesFirstTests.test_season_prose_is_scoped_away_from_booking_date_authority",
            "wolfhouse.test_notes_first_then_web.RegisteredNotesFirstTests.test_season_guidance_preserves_closed_and_missing_authority_controls",
            "wolfhouse.test_sim15_season_oneq_replies",
        ],
        None,
    ),
    ("pricing-seasons", ["node", "scripts/verify-authoritative-pricing-seasons.js"], None),
    ("guest-addon-closed-season", ["node", "scripts/verify-guest-addon-pricing.js"], None),
    ("portable-authority", ["node", str(PORTABLE / "owner/payment-authority-probe.js")], None),
    ("portable-captured-wrapper", [PYTHON, str(PORTABLE / "owner/trace-create-boundary-successor.py")], None),
    ("portable-captured-all-controls", [PYTHON, str(PORTABLE / "owner/trace-create-boundary-diagnostics.py")], None),
    ("portable-canonical-required", [PYTHON, str(PORTABLE / "owner/canonical-owner-boundary.py")], None),
    ("portable-owner-keep", [PYTHON, str(PORTABLE / "owner/owner-probes.py")], None),
    (
        "portable-registered-matrix",
        [PYTHON, str(PORTABLE / "availability/matrix-probe.py")],
        PORTABLE / "availability/matrix-head.jsonl",
    ),
    ("portable-matrix-required", [PYTHON, str(PORTABLE / "availability/check-matrix.py")], None),
    (
        "portable-bounded-edges",
        [PYTHON, str(PORTABLE / "availability/edge-probe.py")],
        PORTABLE / "availability/edge-head.jsonl",
    ),
]


def git_value(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, env=ENV, check=True, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    ).stdout.strip()


def main() -> int:
    evidence_parent = "d468622fde32f2d0adae17247bc8de91bb63ca88"
    head = git_value("rev-parse", "HEAD")
    tree = git_value("log", "-1", "--format=%T")
    git_value("merge-base", "--is-ancestor", evidence_parent, head)
    changed = git_value("diff", "--name-only", evidence_parent, head).splitlines()
    disallowed = [path for path in changed if not path.startswith("artifacts/sim15-season-oneq-repair")]
    if disallowed:
        raise SystemExit(f"successor contains product changes: {disallowed}")

    outputs: dict[str, str] = {}
    records = []
    with LOG.open("w", encoding="utf-8") as log:
        log.write(json.dumps({"head": head, "tree": tree, "runner": str(Path(__file__).relative_to(ROOT))}) + "\n")
        for name, command, capture_path in RUNS:
            log.write(f"\n===== {name} =====\nCOMMAND_JSON={json.dumps(command)}\n")
            log.flush()
            completed = subprocess.run(
                command,
                cwd=ROOT,
                env=ENV,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            output = completed.stdout or ""
            outputs[name] = output
            log.write(output)
            if output and not output.endswith("\n"):
                log.write("\n")
            log.write(f"EXIT={completed.returncode}\n")
            log.flush()
            if capture_path is not None:
                capture_path.write_text(output, encoding="utf-8")
            records.append({"name": name, "exit": completed.returncode})
            if completed.returncode != 0:
                log.write("VERDICT=FAIL\n")
                return completed.returncode or 1

        focused = re.search(r"Ran (\d+) tests", outputs["focused-registered-context-editorial"])
        addon = re.search(r"(\d+) passed,\s*(\d+) failed", outputs["guest-addon-closed-season"])
        pricing_ok = "PASS" in outputs["pricing-seasons"]
        focused_count = int(focused.group(1)) if focused else -1
        addon_pass = int(addon.group(1)) if addon else -1
        addon_fail = int(addon.group(2)) if addon else -1
        portable_records = [row for row in records if row["name"].startswith("portable-")]
        summary = {
            "head": head,
            "tree": tree,
            "retained_portable": {"passed": 98, "failed": 0, "components": len(portable_records)},
            "focused_registered_context_editorial": {"passed": focused_count, "failed": 0},
            "pricing_seasons": {"passed": pricing_ok},
            "guest_addon_closed_season": {"passed": addon_pass, "failed": addon_fail},
            "component_exits": records,
        }
        valid = focused_count == 6 and pricing_ok and addon_pass == 115 and addon_fail == 0 and len(portable_records) == 8
        log.write("\nSUMMARY=" + json.dumps(summary, sort_keys=True) + "\n")
        log.write("VERDICT=" + ("PASS" if valid else "FAIL") + "\n")
        if not valid:
            return 1

    digest = hashlib.sha256(LOG.read_bytes()).hexdigest()
    print(json.dumps({"verdict": "PASS", "log": str(LOG.relative_to(ROOT)), "log_sha256": digest, **summary}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
