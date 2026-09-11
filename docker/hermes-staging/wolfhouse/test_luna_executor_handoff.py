"""LR-3.2 actual-loop regressions for top-level and nested/Enum handoffs."""

from enum import Enum
from types import SimpleNamespace
from unittest import mock
import json
import sys
import types
import unittest

sys.modules.setdefault("fire", types.SimpleNamespace(Fire=lambda *a, **k: None))
sys.modules.setdefault("firecrawl", types.SimpleNamespace(Firecrawl=object))
sys.modules.setdefault("fal_client", types.SimpleNamespace())

import run_agent


class ItemType(Enum):
    FUNCTION_CALL = "function_call"


class ExecutorHandoffTest(unittest.TestCase):
    def _run_actual_loop(self, call_item):
        tool_name = "get_sunset_lesson_catalog"
        definitions = [{"type": "function", "function": {
            "name": tool_name, "description": "Controlled read.",
            "parameters": {"type": "object", "properties": {}},
        }}]
        with mock.patch.object(run_agent, "get_tool_definitions", return_value=definitions), \
                mock.patch.object(run_agent, "check_toolset_requirements", return_value={}), \
                mock.patch.object(run_agent, "OpenAI", return_value=SimpleNamespace()):
            agent = run_agent.AIAgent(
                model="gpt-5.6-sol", provider="openai-codex",
                api_mode="codex_responses",
                base_url="https://chatgpt.com/backend-api/codex", api_key="offline",
                quiet_mode=True, max_iterations=3,
                skip_context_files=True, skip_memory=True,
            )
        agent._cleanup_task_resources = lambda _task_id: None
        agent._persist_session = lambda _messages, history=None: None
        agent._save_trajectory = lambda _messages, _user_message, _completed: None

        call1 = SimpleNamespace(
            output=[call_item], output_text="", status="completed",
            model="gpt-5.6-sol",
            usage=SimpleNamespace(input_tokens=1, output_tokens=1, total_tokens=2),
        )
        final = SimpleNamespace(
            output=[SimpleNamespace(
                type="message", role="assistant", status="completed",
                content=[SimpleNamespace(type="output_text", text="done")],
            )],
            output_text="done", status="completed", model="gpt-5.6-sol",
            usage=SimpleNamespace(input_tokens=1, output_tokens=1, total_tokens=2),
        )
        responses = [call1, final]
        dispatched = []
        model_requests = []

        def controlled_staff_dispatch(name, arguments, *_args, **_kwargs):
            dispatched.append((name, dict(arguments)))
            return json.dumps({"success": True, "controlled": True})

        def controlled_model(request):
            model_requests.append(request)
            return responses.pop(0)

        with mock.patch.object(agent, "_interruptible_api_call",
                               side_effect=controlled_model), \
                mock.patch.object(run_agent, "handle_function_call",
                                  side_effect=controlled_staff_dispatch):
            result = agent.run_conversation("sealed case 09 call 1")

        self.assertEqual(result["final_response"], "done")
        self.assertEqual(dispatched, [(tool_name, {"location": "sunset-somo"})])
        assistant_calls = [m for m in result["messages"]
                           if m.get("role") == "assistant" and m.get("tool_calls")]
        self.assertEqual(assistant_calls[0]["tool_calls"][0]["id"],
                         "call-sealed-958")
        self.assertTrue(any(m.get("role") == "tool" for m in result["messages"]))
        self.assertEqual(len(model_requests), 2)
        self.assertIn("function_call_output", json.dumps(model_requests[1], default=str))

    def test_sealed_top_level_call_enters_actual_loop_and_dispatcher(self):
        self._run_actual_loop({
            "type": "function_call", "id": "fc-sealed-958",
            "call_id": "call-sealed-958", "name": "get_sunset_lesson_catalog",
            "arguments": json.dumps({"location": "sunset-somo"}),
            "status": "completed",
        })

    def test_nested_enum_call_enters_actual_loop_and_dispatcher(self):
        self._run_actual_loop({
            "type": ItemType.FUNCTION_CALL, "id": "fc-sealed-958",
            "call_id": "call-sealed-958",
            "function": {
                "name": "get_sunset_lesson_catalog",
                "arguments": {"location": "sunset-somo"},
            },
            "status": "completed",
        })


if __name__ == "__main__":
    unittest.main()
