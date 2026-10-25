#!/usr/bin/env python3
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "docker/hermes-luna-v3"
sys.path.insert(0, str(root))
import compile_instructions as compiler  # noqa: E402
compiled = compiler.compile_instructions()
assert compiled == (root / "SOUL.md").read_text()
assert len(compiled) <= compiler.TOTAL_LIMIT
schema = json.loads((root / "contracts/check_quote_book.schema.json").read_text())
assert schema["properties"]["action"]["enum"] == ["prepare", "confirm", "decline"]
plugin_text = (root / "plugins/luna_v3_staff_api/__init__.py").read_text()
assert '"check_quote_book": "/staff/bot/luna-v3/check-quote-book"' in plugin_text
for retired in ("hold_beds", "recover_operation", "release_hold", "quote"):
    assert f"`{retired}`" not in compiled, f"retired booking tool leaked into compiled instruction: {retired}"
assert "one clear acceptance question" in compiled
assert "Do not retry, repair, recover" in compiled
print("luna v3 compiled modular instructions: PASS")
