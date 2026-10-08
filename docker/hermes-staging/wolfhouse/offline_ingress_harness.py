"""Offline real patched ingress harness: stub only delivery/LLM worker edges.

No capability construction by fixtures. Run the full patched _handle_message,
_run_agent and real context-preserving executor, then the installed loop hook.
"""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def gateway_ingress(agent, raw, message_id, model_call, *, enriched=None, internal=False,
                    rewrite=None, before_worker=None, async_return=False):
    import gateway.run as runtime
    from gateway.config import Platform
    from gateway.session import SessionSource
    from gateway.platforms.base import MessageEvent
    from apply_gateway_patches import apply_original_inbound_source, apply_original_message_identity_source
    source_text = apply_original_inbound_source(
        apply_original_message_identity_source(Path(runtime.__file__).read_text())
    )
    tree = ast.parse(source_text)
    owner = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'GatewayRunner')
    methods = [n for n in owner.body if isinstance(n, ast.AsyncFunctionDef)
               and n.name in ('_handle_message', '_run_agent')]
    namespace = dict(vars(runtime))
    from wolfhouse.original_inbound import gateway_event_owner, gateway_run_owner
    namespace.update(_wh_gateway_event_owner=gateway_event_owner, _wh_gateway_run_owner=gateway_run_owner)
    harness = ast.Module(body=[ast.ClassDef(name='OfflineOwner', bases=[ast.Name(id='GatewayRunner', ctx=ast.Load())],
        keywords=[], body=methods, decorator_list=[])], type_ignores=[])
    exec(compile(ast.fix_missing_locations(harness), '<real-patched-gateway-owners>', 'exec'), namespace)
    runner = object.__new__(namespace['OfflineOwner'])
    runner._session_db = agent._session_db
    runner.config = SimpleNamespace(multiplex_profiles=False)
    runner.session_store = SimpleNamespace()
    runner._running_agents = {}
    runner._session_run_generations = {}
    runner._active_session_leases = {}
    runner._is_user_authorized = lambda source: True
    runner._session_key_for_source = lambda source: 'key1'
    runner._is_telegram_topic_root_lobby = lambda source: False
    runner._claim_active_session_slot = lambda *a: (None, None)
    runner._release_running_agent_state = lambda *a, **k: None
    source = SessionSource(platform=Platform.WHATSAPP, chat_id='chat1', user_id='guest1', message_id=message_id)
    event = MessageEvent(source=source, text=raw, message_id=message_id, internal=internal)
    async def inner(message, context_prompt, history, source, session_id, **kwargs):
        return await runner._run_in_executor_with_context(model_call,
            enriched if enriched is not None else message)
    runner._run_agent_inner = inner
    binding_owner = next(n for n in owner.body if isinstance(n, ast.AsyncFunctionDef)
                         and n.name == '_handle_message_with_agent')
    anchor_index = next(i for i, n in enumerate(binding_owner.body)
                        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name)
                            and t.id == '_session_env_tokens' for t in n.targets))
    # Execute the actual inserted import/call statements from the patched owner,
    # not a fixture-written helper invocation. Upstream session selection and
    # downstream delivery remain offline edges, not a full handler proof.
    binding_code = compile(ast.fix_missing_locations(ast.Module(
        body=binding_owner.body[anchor_index + 1:anchor_index + 3], type_ignores=[])),
        '<actual-inserted-pre-enrichment-binding>', 'exec')
    async def dispatch(event, source, quick_key, generation):
        exec(binding_code, dict(namespace, self=runner,
             session_entry=SimpleNamespace(session_id=agent.session_id),
             session_key='key1', source=source, event=event))
        if before_worker is not None:
            before_worker(event, source)
        return await runner._run_agent(event.text or '', '', [], source, agent.session_id,
            session_key='key1', event_message_id=event.message_id,
            _wh_original_message_id=event.message_id)
    runner._handle_message_with_agent = dispatch
    async def run():
        results = [{'action': 'rewrite', 'text': rewrite}] if rewrite is not None else []
        with patch('hermes_cli.plugins.invoke_hook', return_value=results):
            return await runner._handle_message(event)
    return run() if async_return else asyncio.run(run())
