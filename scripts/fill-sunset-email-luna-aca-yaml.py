#!/usr/bin/env python3
"""Fill MAIL-MVP-007 ACA YAML placeholders from queried Azure IDs.

Refuse to emit a file that still contains <placeholders>. Never prints secrets.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PLACEHOLDER = re.compile(r"<[^>\n]+>")
REQUIRED = (
    "environment-id",
    "identity-id",
    "full-master-sha",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--environment-id", required=True)
    parser.add_argument("--identity-id", required=True)
    parser.add_argument("--full-master-sha", required=True)
    args = parser.parse_args()
    text = Path(args.template).read_text(encoding="utf-8")
    values = {
        "environment-id": args.environment_id.strip(),
        "identity-id": args.identity_id.strip(),
        "full-master-sha": args.full_master_sha.strip(),
    }
    for key, value in values.items():
        if not value or "<" in value or ">" in value:
            print(f"refuse: empty or placeholder {key}", file=sys.stderr)
            return 1
        if key == "full-master-sha" and not re.fullmatch(r"[0-9a-f]{40}", value):
            print("refuse: full-master-sha must be 40 hex", file=sys.stderr)
            return 1
        if key.endswith("-id") and not value.startswith("/subscriptions/"):
            print(f"refuse: {key} must be a resource id", file=sys.stderr)
            return 1
        text = text.replace(f"<{key}>", value)
    leftover = PLACEHOLDER.findall(text)
    if leftover:
        print("refuse: unresolved placeholders: " + ", ".join(sorted(set(leftover))), file=sys.stderr)
        return 1
    if "managedEnvironmentId:" in text:
        print("refuse: YAML still uses deprecated managedEnvironmentId", file=sys.stderr)
        return 1
    if "environmentId:" not in text:
        print("refuse: YAML missing environmentId", file=sys.stderr)
        return 1
    if re.search(r"^\s+command:", text, re.M):
        print("refuse: YAML must not set command (would skip /init)", file=sys.stderr)
        return 1
    Path(args.output).write_text(text, encoding="utf-8")
    print(f"filled {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
