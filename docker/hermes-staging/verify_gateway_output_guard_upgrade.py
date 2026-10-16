#!/usr/bin/env python3
"""Upgrade regression for copied Hermes with the legacy four-argument guard call."""
from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
PATCHER = HERE / "apply_gateway_patches.py"
BASELINE = HERE / "fixtures" / "gateway-run-output-guard-four-arg.py"
LEGACY = 'response = _wh_guard_turn(response, agent_result, history, getattr(source, "platform", None))'
CURRENT = LEGACY[:-1] + ", message_text)"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    patcher = load(PATCHER, "copied_hermes_candidate_patcher")
    with tempfile.TemporaryDirectory(prefix="copied-hermes-") as raw:
        copied = Path(raw) / "gateway" / "run.py"
        copied.parent.mkdir()
        shutil.copyfile(BASELINE, copied)  # byte-for-byte installed baseline copy
        baseline_bytes = copied.read_bytes()
        assert LEGACY.encode() in baseline_bytes and CURRENT.encode() not in baseline_bytes

        patcher_source = PATCHER.read_text(encoding="utf-8")
        assert "s = migrate_output_guard_call(s)" in patcher_source
        first = patcher.migrate_output_guard_call(copied.read_text(encoding="utf-8"))
        copied.write_text(first, encoding="utf-8")
        second = patcher.migrate_output_guard_call(copied.read_text(encoding="utf-8"))
        assert second == first, "candidate migration is not idempotent"
        assert first.count(CURRENT) == 1 and LEGACY not in first
        assert patcher.migrate_output_guard_call(patcher.OUTPUT_GUARD) == patcher.OUTPUT_GUARD, (
            "fresh five-argument insertion changed"
        )
        three_arg = "response = _wh_guard_turn(response, agent_result, history)"
        assert patcher.migrate_output_guard_call(three_arg) == CURRENT

        calls = []
        output_guard = types.ModuleType("wolfhouse.output_guard")
        def guard_turn_response(response, agent_result, history, platform, message_text=None):
            calls.append((response, agent_result, history, platform, message_text))
            return "English current-message fallback" if message_text == "Please answer in English" else "Respuesta en español"
        output_guard.guard_turn_response = guard_turn_response
        wolfhouse = types.ModuleType("wolfhouse")
        wolfhouse.output_guard = output_guard
        previous = {name: sys.modules.get(name) for name in ("wolfhouse", "wolfhouse.output_guard")}
        sys.modules["wolfhouse"] = wolfhouse
        sys.modules["wolfhouse.output_guard"] = output_guard
        try:
            gateway_run = load(copied, "copied_gateway_run")
            response = gateway_run.copied_gateway_ingress(
                "Please answer in English",
                [{"role": "user", "content": "Responde en español"}],
                SimpleNamespace(platform="whatsapp_cloud"),
                None,
                "El sistema no respondió.",
            )
        finally:
            for name, old in previous.items():
                if old is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = old

        assert response == "English current-message fallback", response
        assert calls and calls[0][4] == "Please answer in English"
        print("PASS: baseline copied-Hermes four-arg guard migrated to five args")
        print("PASS: actual copied gateway ingress uses the current English message")
        print("PASS: migration is idempotent and preserves a single current call")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
