"""Emit the HTTP request made by the authentic registered Luna v3 tool.

Test helper only: stdout is one JSON object containing request body and trusted
lifecycle headers. No network call is made.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

plugin_path = Path(__file__).resolve().parent / "__init__.py"
sys.path[:0] = [str(plugin_path.parents[2]), "/opt/hermes"]
from runtime.trusted_turn_context import bind_inbound_event
from tools.registry import ToolRegistry
import gateway.session_context as gateway_session_context

gateway_session_context.get_session_env = lambda _name, default="": os.environ.get("LUNA_V3_SESSION_ID", default)
arguments = json.loads(os.environ["LUNA_V3_TEST_ARGUMENTS"])
bind_inbound_event(os.environ["LUNA_V3_TEST_INBOUND_EVENT"])
spec = importlib.util.spec_from_file_location("luna_v3_staff_api_request_probe", plugin_path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

captured = {}

class Response:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self): return b'{"ok":true}'

def capture(request, _base_url):
    captured["body"] = json.loads(request.data.decode("utf-8"))
    captured["turn_id"] = request.get_header("X-luna-v3-turn-id")
    captured["inbound_event_id"] = request.get_header("X-luna-v3-inbound-event")
    return Response()

plugin._open_staff = capture
registry = ToolRegistry()
plugin.register(type("Context", (), {"register_tool": registry.register})())
registry.dispatch("check_quote_book", arguments, task_id="postgres-plugin-lifecycle-proof")
print(json.dumps(captured, separators=(",", ":")))
