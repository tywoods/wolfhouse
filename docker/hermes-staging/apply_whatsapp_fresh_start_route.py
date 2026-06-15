#!/usr/bin/env python3
"""Register Wolfhouse guest Fresh Start route on Hermes WhatsApp Cloud webhook app."""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

FRESH_START_TAG = "_wgfs.register_fresh_start_route(app)"
WEBHOOK_ANCHOR_RE = re.compile(
    r"app\.router\.add_post\(self\._webhook_path, self\._handle_webhook\)",
    re.MULTILINE,
)
FRESH_START_ROUTE = """
        try:
            import importlib.util as _wgfs_iu
            _wgfs_spec = _wgfs_iu.spec_from_file_location(
                "wolfhouse_guest_fresh_start",
                "/etc/hermes-staging/wolfhouse_guest_fresh_start.py",
            )
            _wgfs = _wgfs_iu.module_from_spec(_wgfs_spec)
            _wgfs_spec.loader.exec_module(_wgfs)
            _wgfs.register_fresh_start_route(app)
        except Exception:
            pass
"""


def _compile_check(path: Path) -> None:
    compile(path.read_text(encoding="utf-8"), str(path), "exec")


def apply_patches(module_path: Path) -> dict:
    s = module_path.read_text(encoding="utf-8")
    if FRESH_START_TAG not in s:
        if not WEBHOOK_ANCHOR_RE.search(s):
            raise RuntimeError("whatsapp_cloud webhook route anchor not found")
        s = WEBHOOK_ANCHOR_RE.sub(
            lambda m: m.group(0) + FRESH_START_ROUTE,
            s,
            count=1,
        )
        module_path.write_text(s, encoding="utf-8")
    _compile_check(module_path)
    return {
        "ok": True,
        "path": str(module_path),
        "fresh_start_route": FRESH_START_TAG in s,
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
        print(f"apply_whatsapp_fresh_start_route failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
