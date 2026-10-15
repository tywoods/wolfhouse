#!/usr/bin/env python3
"""Regression: real Hermes registration/dispatch accepts runtime metadata safely.

Run with PYTHONPATH containing docker/hermes-staging, its plugins directory, and
matching Hermes source. This is offline: model, Staff I/O, and sockets are denied.
"""
from __future__ import annotations

import importlib
import inspect
import json
import socket
from types import SimpleNamespace
from unittest.mock import patch

from hermes_cli.plugins import PluginContext
from tools.registry import ToolRegistry

import wolfhouse_staff_api as plugin
from wolfhouse.test_accepted_quote import OwnerHostileTests


RUNTIME_METADATA = {
    "task_id": "offline-task",
    "session_id": "offline-runtime-session",
    "user_task": "offline-user-task",
}


def main() -> int:
    registry_module = importlib.import_module("tools.registry")
    network_attempts: list[str] = []

    def deny_network(*_args, **_kwargs):
        network_attempts.append("attempt")
        raise AssertionError("network forbidden")

    test = OwnerHostileTests()
    test.setUp()
    try:
        registry = ToolRegistry()
        context = PluginContext(
            SimpleNamespace(name="wolfhouse_staff_api"),
            SimpleNamespace(_plugin_tool_names=set()),
        )
        with (
            patch.object(socket.socket, "connect", deny_network),
            patch.object(socket, "create_connection", deny_network),
            patch.object(plugin, "_post_bot", side_effect=AssertionError("Staff I/O forbidden")),
            patch.object(registry_module, "registry", registry),
            patch.object(context, "register_hook"),
            patch.object(test.ledger, "install_owner_hook"),
        ):
            plugin.register(context)
            raw = "I accept the quote"
            test.turn("accept-runtime-dispatch", raw)
            payload = {
                "action": "accept",
                "action_evidence": raw,
                "ambiguous": False,
                "negated": False,
                "conditional": False,
                "material_changes": [],
                "completions": {},
            }
            with patch.object(
                test.ledger,
                "interpret_owner_turn",
                wraps=test.ledger.interpret_owner_turn,
            ) as owner:
                result = json.loads(
                    registry.dispatch("interpret_booking_turn", payload, **RUNTIME_METADATA)
                )

        assert result.get("success") is True, result
        assert result.get("accepted") is True, result
        assert result.get("create_ready") is True, result
        assert owner.call_count == 1, owner.call_count
        assert not network_attempts, network_attempts

        incompatible = {}
        signatures = {}
        for name in registry.get_all_tool_names():
            handler = registry.get_entry(name).handler
            signature = inspect.signature(handler, follow_wrapped=False)
            signatures[name] = str(signature)
            try:
                signature.bind({}, **RUNTIME_METADATA)
            except TypeError as error:
                incompatible[name] = str(error)
        assert not incompatible, incompatible

        print(json.dumps({
            "success": True,
            "runtime_metadata": sorted(RUNTIME_METADATA),
            "owner_entry_count": owner.call_count,
            "accepted": result.get("accepted"),
            "create_ready": result.get("create_ready"),
            "network_attempts": len(network_attempts),
            "registered_handler_signatures": signatures,
            "incompatible_handlers": incompatible,
        }, indent=2, sort_keys=True))
        return 0
    finally:
        test.tearDown()


if __name__ == "__main__":
    raise SystemExit(main())
