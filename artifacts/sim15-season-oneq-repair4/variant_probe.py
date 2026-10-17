#!/usr/bin/env python3
"""Isolated exact-tree callback/context probe. Offline and read-only."""
from __future__ import annotations
import hashlib, json, os, socket, sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

root = Path(sys.argv[1]).resolve()
spec = json.load(sys.stdin)
sys.path[:0] = [str(root / "docker/hermes-staging"), str(root / "docker/hermes-staging/plugins"), "/opt/hermes"]

def denied(*_a, **_k):
    raise AssertionError("OFFLINE: network denied")
socket.socket.connect = denied
socket.create_connection = denied
socket.getaddrinfo = denied

import wolfhouse_staff_api as plugin
from wolfhouse import luna_personality as personality

plugin_path = (root / "docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py").resolve()
personality_path = (root / "docker/hermes-staging/wolfhouse/luna_personality.py").resolve()
soul_path = (root / "docker/hermes-staging/SOUL.md").resolve()
assert Path(plugin.__file__).resolve() == plugin_path
assert Path(personality.__file__).resolve() == personality_path

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

registered = {}
registry = SimpleNamespace(register_tool=lambda **kw: registered.update({kw["name"]: kw}))
with patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo", "HERMES_ROLE": "luna"}):
    plugin.register(registry)

names = ["get_house_info", "check_availability", "preview_package_prices", "quote_booking", "lookup_catalog_service"]
descriptions = {name: registered[name]["description"] for name in names}
events, outputs = [], []
for call in spec["calls"]:
    expected_route = call["route"]
    raw = call["staff_response"]
    def staff(route, payload, _expected=expected_route, _raw=raw):
        assert route == _expected, (route, _expected)
        events.append({"tool": call["tool"], "route": route, "payload": payload, "fixture_id": call["fixture_id"], "read_only": True})
        return _raw
    with patch.object(plugin, "_post_bot", side_effect=staff):
        body = json.loads(registered[call["tool"]]["handler"](call["params"]))
    outputs.append({"tool": call["tool"], "tool_call_id": call["tool_call_id"], "fixture_id": call["fixture_id"], "params": call["params"], "actual_callback_output": body})

soul = soul_path.read_text()
assembled = personality.inject_personality_pack_once(soul, personality.get_personality_pack("sunny"))["system_prompt"]
print(json.dumps({
    "loaded_paths": {"plugin": str(plugin_path), "personality": str(personality_path), "soul": str(soul_path)},
    "loaded_sha256": {"plugin": digest(plugin_path), "personality": digest(personality_path), "soul": digest(soul_path)},
    "descriptions": descriptions,
    "descriptions_sha256": hashlib.sha256(json.dumps(descriptions, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
    "assembled_personality_sha256": hashlib.sha256(assembled.encode()).hexdigest(),
    "events": events, "outputs": outputs,
}, ensure_ascii=False))
