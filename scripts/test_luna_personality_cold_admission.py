"""Offline composed cold/warm control; run only in the pinned network-none image."""
import signal, faulthandler
signal.signal(signal.SIGALRM, signal.SIG_DFL)
signal.alarm(35)
faulthandler.enable()
faulthandler.dump_traceback_later(12, repeat=True)
import asyncio, json, os
from pathlib import Path

home = Path(os.environ['HERMES_HOME'])
assert str(home) == '/tmp/synthetic/.hermes'
home.mkdir(parents=True, exist_ok=True)
assert not list(home.iterdir())
(home / 'config.yaml').write_text('model:\n  default: gpt-4o-mini\n  provider: custom\n  base_url: https://fixture.invalid/v1\n  api_key: synthetic-not-a-credential\nagent:\n  max_turns: 1\n  toolsets: []\nmemory:\n  memory_enabled: false\n  user_profile_enabled: false\ncompression:\n  enabled: false\ndisplay:\n  tool_progress: off\n  interim_assistant_messages: false\n')
import httpx
calls = []
def send(self, request, **kwargs):
    assert request.url.host == 'fixture.invalid', 'nonfixture HTTP denied'
    calls.append(request.url.path)
    if request.url.path == '/api/show':
        return httpx.Response(200, request=request, json={'model_info': {'general.context_length': 128000}})
    assert request.url.path == '/v1/chat/completions', 'unexpected endpoint'
    body = json.loads(request.content)
    if body.get('stream'):
        chunks = [{'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0,
                   'model': 'gpt-4o-mini', 'choices': [{'index': 0, 'delta': delta,
                   'finish_reason': finish}]} for delta, finish in
                  [({'role': 'assistant', 'content': 'fixture ordinary reply'}, None), ({}, 'stop')]]
        data = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
        return httpx.Response(200, request=request, headers={'content-type': 'text/event-stream'}, content=data)
    return httpx.Response(200, request=request, json={'id': 'fixture', 'object': 'chat.completion',
        'created': 0, 'model': 'gpt-4o-mini', 'choices': [{'index': 0,
        'message': {'role': 'assistant', 'content': 'fixture ordinary reply'}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})
httpx.Client.send = send
import tools.tirith_security, tools.lazy_deps
tools.tirith_security.ensure_installed = lambda **kw: False
tools.lazy_deps._venv_pip_install = lambda *args, **kwargs: False
import gateway.run as gateway
from gateway.config import GatewayConfig, Platform
from gateway.session import SessionSource
runner = gateway.GatewayRunner(GatewayConfig())
source = SessionSource(platform=Platform.LOCAL, chat_id='fixture', user_id='fixture')
async def main():
    mode = globals().get('mode', 'normal')
    for temperature in (() if mode == 'fresh' else ('cold', 'warm')):
        result = await runner._run_agent_inner('fixture question', '', [], source,
            'fixture-session', session_key='fixture-key')
        assert result.get('final_response') == 'fixture ordinary reply', result.get('final_response')
        assert result.get('api_calls', 0) > 0
        assert len(runner._agent_cache) == 1
        print('NON_EVAL_CONTROL_PASS', temperature, flush=True)
    print('HTTP_FIXTURE_PATHS', calls, flush=True)
    import sys, threading
    from wolfhouse import luna_personality_isolation as isolation
    isolation.install_isolation_runtime(runner=runner)
    downstream = []
    def tripwire(frame, event, arg):
        seams = {'_resolve_session_agent_runtime', '_resolve_turn_agent_config',
                 'resolve_runtime_provider', 'load_pool', '_auth_store_lock',
                 'resolve_codex_runtime_credentials', '_save_auth_store',
                 '_refresh_codex_auth_tokens', 'create_openai_client',
                 'get_model_context_length', 'init_agent', '_get_proxy_url', '_run_agent_via_proxy'}
        if mode.startswith('worker-'):
            seams = {'_resolve_session_agent_runtime', 'init_agent'}
        if event == 'call' and frame.f_code.co_name in seams:
            stack, current = [], frame
            while current is not None:
                stack.append(current.f_code.co_name)
                current = current.f_back
            downstream.append(stack)
            raise AssertionError('resource boundary reached')
    cap = isolation.IsolatedTurnCapture(case_id='fixture', personality_id='balanced', tenant_id='sunset')
    token = isolation.enter_isolated_turn(cap)
    # Profile the real worker before the resolver body, without replacing its owner.
    threading.setprofile_all_threads(tripwire)
    try:
        routes = [('configured', None), ('missing', {}), ('unknown', {'api_mode': 'unknown'}),
                  ('malformed', {'api_mode': []}), ('auto', {'provider': 'auto'}),
                  ('custom', {'provider': 'custom'}), ('codex', {'provider': 'openai-codex', 'api_mode': 'codex_responses'}),
                  ('app-server', {'api_mode': 'codex_app_server'}),
                  ('complete-override', {'model': 'fixture-model', 'provider': 'custom', 'api_mode': 'chat_completions',
                                         'api_key': 'synthetic-not-a-credential', 'base_url': 'https://fixture.invalid/v1'})]
        for temperature, session_key in (('cold', 'fixture-cold-key'), ('warm', 'fixture-key')):
            before_cache = dict(runner._agent_cache)
            for route, override in routes:
                if override is not None:
                    runner._session_model_overrides[session_key] = override
                try:
                    await runner._run_agent_inner('fixture question', '', [], source,
                        'fixture-session', session_key=session_key)
                except isolation.IsolationAbort as exc:
                    assert exc.reason == 'runtime_resolution_unverified', exc.reason
                else:
                    raise AssertionError('isolated request admitted; downstream=' + repr(downstream))
                finally:
                    runner._session_model_overrides.pop(session_key, None)
                assert downstream == [], downstream
                assert runner._agent_cache == before_cache, ('cache changed', list(before_cache), list(runner._agent_cache))
                print('ISOLATED_PRE_RESOURCE_PASS', temperature, route, flush=True)
        from run_agent import AIAgent
        for kwargs in ({}, {'provider': 'openai-codex', 'api_mode': 'codex_responses'},
                       {'api_mode': 'codex_app_server'}, {'api_mode': []},
                       {'model': 'gpt-4o-mini', 'provider': 'custom', 'api_key': 'synthetic-not-a-credential',
                        'base_url': 'https://fixture.invalid/v1'}):
            try:
                AIAgent(**kwargs)
            except isolation.IsolationAbort as exc:
                assert exc.reason == 'constructor_boundary_unverified', exc.reason
            else:
                raise AssertionError('isolated constructor admitted without authority')
            assert downstream == [], downstream
        print('CONSTRUCTOR_PRE_RESOURCE_PASS', flush=True)
        # Peer-isolated causal test: bypass only admission, inject an abort before
        # the real resolver body, and exercise its genuine auth-friendly catch.
        original_guard, isolation.refuse_unverified_runtime = isolation.refuse_unverified_runtime, lambda: None
        def abort_at_resolver(frame, event, arg):
            if event == 'call' and frame.f_code.co_name == '_resolve_session_agent_runtime':
                raise isolation.IsolationAbort('constructor_boundary_unverified')
        threading.setprofile_all_threads(abort_at_resolver)
        try:
            try:
                await runner._run_agent_inner('fixture question', '', [], source,
                    'fixture-session', session_key='fixture-key')
            except isolation.IsolationAbort as exc:
                assert exc.reason == 'constructor_boundary_unverified'
            else:
                raise AssertionError('auth-friendly catch swallowed typed cause')
        finally:
            isolation.refuse_unverified_runtime = original_guard
        print('INNER_TYPED_CAUSE_PASS', flush=True)
        threading.setprofile_all_threads(None)
        from gateway.platforms.base import MessageEvent, MessageType
        event = MessageEvent(text='fixture question', message_type=MessageType.TEXT,
                             source=source, message_id='fixture-message')
        try:
            generation = runner._begin_session_run_generation(key := runner._session_key_for_source(source))
            await runner._handle_message_with_agent(event, source, key, generation)
        except isolation.IsolationAbort as exc:
            assert exc.reason == 'runtime_resolution_unverified', exc.reason
        else:
            raise AssertionError('outer gateway catch swallowed typed cause')
    finally:
        threading.setprofile_all_threads(None)
        sys.setprofile(None)
        isolation.exit_isolated_turn(token)
asyncio.run(main())
