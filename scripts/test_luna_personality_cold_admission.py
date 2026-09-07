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
    if mode.startswith('normal-composition'):
        await composition()

async def composition():
    """Actual gateway worker, with two individually bounded offline admissions."""
    import ast, inspect, sys, threading
    from wolfhouse import luna_personality_isolation as iso
    from hermes_cli import runtime_provider
    resolver = runtime_provider.resolve_runtime_provider
    saved_code = resolver.__code__
    saved_guard = iso.refuse_unverified_runtime
    node = ast.parse(inspect.getsource(resolver)).body[0]
    guards = [n for n in node.body if isinstance(n, ast.If)
              and ast.unparse(n.test) == 'current_isolated_turn() is not None'
              and any(isinstance(x, ast.Constant) and x.value == 'runtime_resolution_unverified' for x in ast.walk(n))]
    assert len(guards) == 1, 'test admission owner drift'
    node.body.remove(guards[0])
    scope = {}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<fixture-runtime-admission>', 'exec'), resolver.__globals__, scope)
    cap = iso.IsolatedTurnCapture(case_id='OLD', personality_id='balanced', tenant_id='sunset')
    owners = []
    def trace(frame, event, arg):
        if event == 'call' and frame.f_code.co_name in {'_run_agent_inner', 'run_sync', 'run_conversation', 'interruptible_streaming_api_call', '_call_chat_completions', 'create_openai_client'}:
            owners.append((frame.f_code.co_name, frame.f_code.co_filename, threading.get_ident()))
    before = len(calls)
    token = iso.enter_isolated_turn(cap)
    try:
        iso.refuse_unverified_runtime = lambda: None
        resolver.__code__ = scope[resolver.__name__].__code__
        threading.setprofile_all_threads(trace)
        try:
            result = await runner._run_agent_inner('fixture question', '', [], source,
                'fixture-session', session_key='fixture-key')
        except BaseException as exc:
            print('COMPOSITION_STOP', type(exc).__name__, getattr(exc, 'reason', None), flush=True)
            raise
        assert result.get('final_response') == 'fixture ordinary reply', result
        assert len(calls) > before, 'composition did not reach fixture SDK'
        print('COMPOSITION_ADMITTED_POSITIVE', flush=True)
        for phase in ('acquisition', 'stream'):
            await cancellation_case(phase)
    finally:
        threading.setprofile_all_threads(None)
        sys.setprofile(None)
        resolver.__code__ = saved_code
        iso.refuse_unverified_runtime = saved_guard
        iso.exit_isolated_turn(token)
        assert resolver.__code__ is saved_code and iso.refuse_unverified_runtime is saved_guard
        print('COMPOSITION_OWNERS', owners, flush=True)
        print('COMPOSITION_HTTP_DELTA', len(calls) - before, flush=True)
        print('TEST_ADMISSIONS_RESTORED', flush=True)

async def cancellation_case(phase):
    import threading, sys, time
    from wolfhouse import luna_personality_isolation as iso
    old = iso.IsolatedTurnCapture(case_id='OLD-' + phase, personality_id='balanced', tenant_id='sunset')
    nxt = iso.IsolatedTurnCapture(case_id='NEXT-' + phase, personality_id='balanced', tenant_id='sunset')
    agent = list(iso._iter_effective_agents(runner=runner))[0]
    loop = asyncio.get_running_loop()
    reached, executor_held = asyncio.Event(), asyncio.Event()
    release, executor_release, executor_returned = threading.Event(), threading.Event(), threading.Event()
    effects, owners = [], []
    original_send = httpx.Client.send
    def profile(frame, event, arg):
        if iso.current_isolated_turn() is not old:
            return
        name = frame.f_code.co_name
        if event == 'call' and name in {'run_sync', '_call_chat_completions', 'create_openai_client', '_set_request_client', '_close_request_openai_client', '_abort_request_openai_client'}:
            owners.append((name, threading.get_ident()))
        if event == 'call' and name == 'create_openai_client' and phase == 'acquisition':
            effects.append(('acquisition_entered', threading.get_ident()))
            loop.call_soon_threadsafe(reached.set)
            assert release.wait(10), 'fixture acquisition release timeout'
        if event == 'return' and name == 'create_openai_client':
            effects.append(('acquisition_returned', id(arg)))
        if event == 'return' and name == 'run_sync':
            if phase == 'stream':
                loop.call_soon_threadsafe(executor_held.set)
                assert executor_release.wait(10), 'fixture executor release timeout'
            executor_returned.set()
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            def chunk(delta, finish):
                return ('data: ' + json.dumps({'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0,
                    'model': 'gpt-4o-mini', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}) + '\n\n').encode()
            yield chunk({'role': 'assistant', 'content': 'fixture ordinary reply'}, None)
            effects.append(('stream_consumption_blocked', threading.get_ident()))
            loop.call_soon_threadsafe(reached.set)
            assert release.wait(10), 'fixture stream release timeout'
            yield chunk({}, 'stop')
            yield b'data: [DONE]\n\n'
        def close(self):
            effects.append(('stream_closed', threading.get_ident()))
    def boundary(client, request, **kwargs):
        cap = iso.current_isolated_turn()
        effects.append(('http', getattr(cap, 'case_id', 'ordinary'), request.url.path))
        if cap is old and phase == 'stream':
            assert request.url.host == 'fixture.invalid' and request.url.path == '/v1/chat/completions'
            assert json.loads(request.content).get('stream') is True
            calls.append(request.url.path)
            return httpx.Response(200, request=request, headers={'content-type': 'text/event-stream'}, stream=Stream())
        return original_send(client, request, **kwargs)
    async def invoke(cap):
        token = iso.enter_isolated_turn(cap)
        try:
            return await runner._run_agent_inner('fixture question', '', [], source,
                'fixture-session', session_key='fixture-key')
        finally:
            iso.exit_isolated_turn(token)
    task = None
    try:
        httpx.Client.send = boundary
        threading.setprofile_all_threads(profile)
        task = asyncio.create_task(invoke(old))
        await asyncio.wait_for(reached.wait(), 8)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            effects.append(('gateway_cancelled',))
        else:
            raise AssertionError('gateway cancellation not observed')
        try:
            iso.settle_isolated_work(old, timeout_s=0)
        except iso.IsolationAbort as exc:
            assert exc.reason == 'provider_work_unsettled', exc.reason
            effects.append(('blocked_settlement', exc.reason))
        else:
            raise AssertionError('blocked helper was falsely settled')
        for cap in (None, nxt):
            result = await asyncio.wait_for(invoke(cap), 8)
            assert result.get('final_response') == 'fixture ordinary reply', result
            assert list(iso._iter_effective_agents(runner=runner))[0] is agent, 'cached agent replaced'
        assert nxt._worker_abort is None and not nxt._provider_revoked
        effects.append(('same_cached_ordinary_next_positive',))
        release.set()
        if phase == 'stream':
            await asyncio.wait_for(executor_held.wait(), 8)
        deadline = time.monotonic() + 5
        while any(t.is_alive() for t in old.in_flight_threads) and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert not any(t.is_alive() for t in old.in_flight_threads), 'helper not drained'
        try:
            iso.settle_isolated_work(old, timeout_s=0)
        except iso.IsolationAbort as exc:
            effects.append(('terminal_settlement', exc.reason))
            if old._worker_abort is not None:
                assert exc is old._worker_abort, 'first cause replaced'
        else:
            effects.append(('terminal_settlement', 'returned'))
        if phase == 'acquisition':
            assert not any(e[0] == 'http' and e[1] == old.case_id for e in effects), effects
        print('CANCELLATION_RECEIPT', json.dumps({'phase': phase, 'effects': effects, 'owners': owners,
            'helper_alive': [t.is_alive() for t in old.in_flight_threads], 'provider_operations': old._provider_operations,
            'provider_work_settled': old.provider_work_settled, 'executor_returned': executor_returned.is_set()}), flush=True)
        if phase == 'stream':
            assert not old.provider_work_settled, 'RED: settle_isolated_work certified settled while canonical run_sync executor remains held'
    finally:
        release.set()
        executor_release.set()
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        deadline = time.monotonic() + 5
        while not executor_returned.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        threading.setprofile_all_threads(None)
        sys.setprofile(None)
        httpx.Client.send = original_send
        assert httpx.Client.send is original_send
        assert executor_returned.is_set(), 'canonical executor did not return'
        try:
            iso.settle_isolated_work(old, timeout_s=1)
        except iso.IsolationAbort as exc:
            assert exc is old._worker_abort, 'terminal first cause replaced'
        assert old.provider_work_settled, 'released canonical executor did not settle'
        print('CANCELLATION_FINALLY', phase, 'executor_returned', executor_returned.is_set(),
              'helper_alive', [t.is_alive() for t in old.in_flight_threads],
              'provider_work_settled', old.provider_work_settled, flush=True)

asyncio.run(main())
