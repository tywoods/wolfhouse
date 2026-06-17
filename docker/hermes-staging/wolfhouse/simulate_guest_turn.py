"""CLI: feed one guest text turn to live Luna (Hermes gateway) and print structured output.

Usage (inside hermes-luna container):
  python3 -m wolfhouse.simulate_guest_turn --thread 490000009999 --text "Ciao, 2 persone 15-22 agosto" --lang it --json

Teardown between scenarios:
  curl -X POST http://127.0.0.1:8090/wolfhouse/guest-fresh-start \\
    -H "X-Luna-Bot-Token: $LUNA_BOT_INTERNAL_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"guest_phone":"+490000009999","hard_delete":true}'
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

_STAGING_ROOT = "/etc/hermes-staging"
if _STAGING_ROOT not in sys.path:
    sys.path.insert(0, _STAGING_ROOT)


def _load_hermes_env() -> None:
    """docker exec does not load HERMES_HOME/.env — read token and ports for in-container CLI."""
    home = (os.getenv("HERMES_HOME") or "/opt/data").strip()
    env_path = os.path.join(home, ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            if key and key not in os.environ:
                os.environ[key] = val.strip()


def _simulate_url() -> str:
    explicit = (os.getenv("WOLFHOUSE_SIMULATE_GUEST_TURN_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit
    port = (os.getenv("WHATSAPP_CLOUD_WEBHOOK_PORT") or "8090").strip()
    return f"http://127.0.0.1:{port}/wolfhouse/simulate-guest-turn"


def _post_simulate(payload: dict) -> dict:
    token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Luna-Bot-Token"] = token
    req = urllib.request.Request(_simulate_url(), data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=240) as res:
            return json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = {"error": text}
        data.setdefault("ok", False)
        data["http_status"] = exc.code
        return data


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Simulate one guest WhatsApp turn through live Luna")
    p.add_argument("--thread", required=True, help="Stable session id (guest phone digits or sim:scenario-name)")
    p.add_argument("--text", required=True, help="Guest message text for this turn")
    p.add_argument("--lang", default=None, help="Optional language hint (it, de, es, en)")
    p.add_argument("--allow-writes", action="store_true", help="Enable Staff API writes + Stripe TEST links (still no WhatsApp send)")
    p.add_argument("--json", action="store_true", help="Print full JSON response")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    _load_hermes_env()
    args = parse_args(argv)
    payload = {
        "thread": args.thread,
        "text": args.text,
        "lang": args.lang,
        "allow_writes": bool(args.allow_writes),
    }
    result = _post_simulate(payload)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if not result.get("ok"):
            print(result.get("error") or "simulate failed", file=sys.stderr)
            return 1
        print(result.get("reply_text") or "")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
