import tempfile
import unittest
from pathlib import Path

import apply_crowsnest_ai_usage_patch as patcher

FIXTURE = '''from typing import Any
class A:
    def _run_codex_stream(self, api_kwargs: dict, client: Any = None, on_first_delta: callable = None):
        """Run the Codex Responses API call and assemble its response."""
        _client = client or self.client
        with _client.responses.stream(**api_kwargs) as stream:
            response = stream.get_final_response()
        return response
'''

class PatcherTests(unittest.TestCase):
    def test_pristine_and_prepatched_are_idempotent_and_compile(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"run_agent.py"; p.write_text(FIXTURE)
            first=patcher.patch_file(p); once=p.read_text()
            second=patcher.patch_file(p)
            self.assertTrue(first["changed"]); self.assertFalse(second["changed"])
            self.assertEqual(p.read_text(), once)
            self.assertEqual(once.count("crowsnest_observe_provider_attempt"), 1)

    def test_upstream_drift_fails_closed_without_modification(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"run_agent.py"; original="def drifted():\n    pass\n"; p.write_text(original)
            with self.assertRaisesRegex(RuntimeError, "anchor not found"):
                patcher.patch_file(p)
            self.assertEqual(p.read_text(), original)

    def test_patch_is_role_and_openai_codex_scoped_and_uses_monotonic_daemon(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"run_agent.py"; p.write_text(FIXTURE); patcher.patch_file(p); text=p.read_text()
            for needle in ("HERMES_ROLE", "sunset-luna", "openai-codex", "monotonic", "report_success_daemon", "report_failure_daemon", "guest_reply"):
                self.assertIn(needle, text)

if __name__ == "__main__": unittest.main()
