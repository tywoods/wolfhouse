#!/usr/bin/env python3
"""Install the selected WhatsApp runtime hook into the pinned gateway config.

Writes code only. Does not call a vault, Graph, or the hook's secret mapping.
A second run is a no-op. Missing the known config anchor fails closed so an
image cannot claim the hook is installed.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MARKER = "_wa_runtime_config.apply_whatsapp_runtime_config()"
ANCHOR = 'whatsapp_cloud_phone_id = os.getenv("WHATSAPP_CLOUD_PHONE_NUMBER_ID")'
HOOK = """    try:
        import wolfhouse.whatsapp_runtime_config as _wa_runtime_config
        _wa_runtime_config.apply_whatsapp_runtime_config()
    except ModuleNotFoundError:
        if any(os.getenv(key) for key in ("WA_PHONE_NUMBER_ID", "WA_BUSINESS_ACCOUNT_ID", "WA_APP_ID", "WA_ACCESS_TOKEN", "WA_APP_SECRET")):
            raise
"""


def install_hook(text: str) -> str:
    if MARKER in text:
        return text
    if ANCHOR not in text:
        raise SystemExit("whatsapp runtime config anchor not found")
    return text.replace(ANCHOR, HOOK + ANCHOR, 1)


def apply_to_file(path: Path) -> dict:
    original = path.read_text(encoding="utf-8")
    updated = install_hook(original)
    if updated != original:
        path.write_text(updated, encoding="utf-8")
    compile(updated, str(path), "exec")
    return {"ok": True, "path": str(path), "installed": MARKER in updated, "changed": updated != original}


def main() -> int:
    spec = importlib.util.find_spec("gateway.config")
    if not spec or not spec.origin:
        print("gateway.config not found", file=sys.stderr)
        return 1
    result = apply_to_file(Path(spec.origin))
    print(f"whatsapp runtime config hook installed={result['installed']} changed={result['changed']}")
    return 0 if result["installed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
