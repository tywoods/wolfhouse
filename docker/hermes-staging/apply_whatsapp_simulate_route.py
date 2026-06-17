#!/usr/bin/env python3
"""Register Wolfhouse simulate-guest-turn route on Hermes WhatsApp Cloud webhook app."""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

SIMULATE_TAG = "_wsgt.register_simulate_route(app)"
WEBHOOK_ANCHOR = "app.router.add_post(self._webhook_path, self._handle_webhook)"
WEBHOOK_ANCHOR_RE = re.compile(
    r"app\.router\.add_post\(self\._webhook_path, self\._handle_webhook\)",
    re.MULTILINE,
)
SIMULATE_ROUTE = """
        try:
            import sys as _wsgt_sys
            if "/etc/hermes-staging" not in _wsgt_sys.path:
                _wsgt_sys.path.insert(0, "/etc/hermes-staging")
            import wolfhouse.simulate_core as _wsgt
            _wsgt.register_simulate_route(app)
        except Exception:
            pass
"""
OLD_SIMULATE_TRY_RE = re.compile(
    r"\n        try:\n            import sys as _wsgt_sys\n.*?        except Exception:\n            pass\n",
    re.DOTALL,
)


def _migrate_old_simulate_block(s: str) -> tuple[str, bool]:
    idx = s.find(WEBHOOK_ANCHOR)
    if idx < 0:
        return s, False
    rest = s[idx + len(WEBHOOK_ANCHOR) :]
    if "import wolfhouse.simulate_core as _wsgt" in rest[:900]:
        return s, False
    if "wolfhouse.simulate_core" not in rest[:900]:
        return s, False
    m = OLD_SIMULATE_TRY_RE.match(rest)
    if not m:
        return s, False
    return s[: idx + len(WEBHOOK_ANCHOR)] + SIMULATE_ROUTE + rest[m.end() :], True


def _compile_check(path: Path) -> None:
    compile(path.read_text(encoding="utf-8"), str(path), "exec")


def apply_patches(module_path: Path) -> dict:
    s = module_path.read_text(encoding="utf-8")
    original = s
    migrated = False
    s, migrated = _migrate_old_simulate_block(s)
    if not migrated and SIMULATE_TAG not in s:
        if not WEBHOOK_ANCHOR_RE.search(s):
            raise RuntimeError("whatsapp_cloud webhook route anchor not found")
        s = WEBHOOK_ANCHOR_RE.sub(
            lambda m: m.group(0) + SIMULATE_ROUTE,
            s,
            count=1,
        )
    if s != original:
        module_path.write_text(s, encoding="utf-8")
    _compile_check(module_path)
    final = module_path.read_text(encoding="utf-8")
    return {
        "ok": True,
        "path": str(module_path),
        "simulate_route": SIMULATE_TAG in final,
        "import_style": "import wolfhouse.simulate_core as _wsgt" in final,
        "migrated": migrated,
    }


def main() -> int:
    spec = importlib.util.find_spec("gateway.platforms.whatsapp_cloud")
    if not spec or not spec.origin:
        print("gateway.platforms.whatsapp_cloud not found", file=sys.stderr)
        return 1
    module_path = Path(spec.origin)
    try:
        result = apply_patches(module_path)
        print(result)
        return 0
    except Exception as exc:
        print(f"apply_whatsapp_simulate_route failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
