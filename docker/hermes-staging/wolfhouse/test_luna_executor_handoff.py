"""LR-3.2 actual-loop regression for the sealed #958 executor handoff."""

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


class ExecutorHandoffTest(unittest.TestCase):
    def test_sealed_call1_enters_actual_loop_and_dispatcher(self):
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

        # Exact sealed call-1 handoff shape: output_item.done is retained as a
        # dict, terminal response is completed, and there is no assistant text.
        call1 = SimpleNamespace(
            output=[{
                "type": "function_call", "id": "fc-sealed-958",
                "call_id": "call-sealed-958", "name": tool_name,
                "arguments": json.dumps({"location": "sunset-somo"}),
                "status": "completed",
            }],
            output_text="", status="completed", model="gpt-5.6-sol",
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

        def controlled_staff_dispatch(name, arguments, *_args, **_kwargs):
            dispatched.append((name, dict(arguments)))
            return json.dumps({"success": True, "controlled": True})

        with mock.patch.object(agent, "_interruptible_api_call",
                               side_effect=lambda _kwargs: responses.pop(0)), \
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


if __name__ == "__main__":
    unittest.main()
