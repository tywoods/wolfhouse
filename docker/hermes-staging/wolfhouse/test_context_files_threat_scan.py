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


def scan_context_content(content: str) -> list[str]:
    return scan_for_threats(content, scope="context")


class ContextFilesThreatScanTests(unittest.TestCase):
    def test_context_files_have_no_threat_findings(self) -> None:
        failures: list[str] = []
        for path in CONTEXT_FILES:
            content = path.read_text(encoding="utf-8")
            for finding in scan_context_content(content):
                failures.append(f"{path.relative_to(REPO_ROOT)}: {finding}")

        self.assertEqual([], failures, "\n" + "\n".join(failures))

    def test_multiline_threat_is_detected(self) -> None:
        content = "compare check-in\nwith today's date in Europe/Madrid."

        self.assertIn("c2_heartbeat", scan_context_content(content))


if __name__ == "__main__":
    unittest.main()
