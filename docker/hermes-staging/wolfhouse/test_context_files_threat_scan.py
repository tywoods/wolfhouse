"""Guard Hermes context files against promptware threat-pattern false positives."""

from __future__ import annotations

import unittest
from pathlib import Path

from tools.threat_patterns import scan_for_threats


REPO_ROOT = Path(__file__).resolve().parents[3]
CONTEXT_FILES = (
    REPO_ROOT / "docker/hermes-staging/SOUL.md",
    REPO_ROOT / "docker/hermes-staging/deckhand-SOUL.md",
    REPO_ROOT / "docker/hermes-staging/orchestrator-SOUL.md",
    REPO_ROOT / "docker/hermes-staging/seadog-SOUL.md",
    REPO_ROOT / "docker/hermes-sunset/SOUL.md",
)


class ContextFilesThreatScanTests(unittest.TestCase):
    def test_context_files_have_no_threat_findings(self) -> None:
        failures: list[str] = []
        for path in CONTEXT_FILES:
            content = path.read_text(encoding="utf-8")
            for line_number, line in enumerate(content.splitlines(), start=1):
                for finding in scan_for_threats(line, scope="context"):
                    failures.append(
                        f"{path.relative_to(REPO_ROOT)}:{line_number}: {finding}"
                    )

        self.assertEqual([], failures, "\n" + "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
