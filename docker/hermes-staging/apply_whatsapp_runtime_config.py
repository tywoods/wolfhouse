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
# Relative to the anchor statement. The pinned gateway keeps that statement
# indented inside a function, so a fixed left margin makes the try body
# illegal Python.
HOOK_BODY = (
    "try:",
    "    import wolfhouse.whatsapp_runtime_config as _wa_runtime_config",
    "    _wa_runtime_config.apply_whatsapp_runtime_config()",
    "except ModuleNotFoundError:",
    '    if any(os.getenv(key) for key in ("WA_PHONE_NUMBER_ID", "WA_BUSINESS_ACCOUNT_ID", "WA_APP_ID", "WA_ACCESS_TOKEN", "WA_APP_SECRET")):',
    "        raise",
)


def install_hook(text: str) -> str:
    if MARKER in text:
        return text
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()
    hits = [index for index, line in enumerate(lines) if line.strip() == ANCHOR]
    if len(hits) != 1:
        raise SystemExit("whatsapp runtime config anchor not found")
    index = hits[0]
    raw = lines[index]
    indent = raw[: len(raw) - len(raw.lstrip(" "))]
    if "\t" in indent or raw != f"{indent}{ANCHOR}":
        raise SystemExit("whatsapp runtime config anchor indent unsupported")
    hooked = [f"{indent}{body}" for body in HOOK_BODY]
    updated_lines = lines[:index] + hooked + lines[index:]
    updated = newline.join(updated_lines)
    if text.endswith(("\n", "\r\n")):
        updated += newline
    return updated


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
