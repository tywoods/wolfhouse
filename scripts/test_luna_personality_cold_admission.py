"""Offline composed cold/warm control; run only in the pinned network-none image."""
import signal
import faulthandler
signal.signal(signal.SIGALRM, signal.SIG_DFL)
signal.alarm(35)
faulthandler.enable()
faulthandler.dump_traceback_later(12, repeat=True)
import asyncio
import json
import os
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
import tools.tirith_security
import tools.lazy_deps
tools.tirith_security.ensure_installed = lambda **kw: False
tools.lazy_deps._venv_pip_install = lambda *args, **kwargs: False
import gateway.run as gateway
from gateway.config import GatewayConfig, Platform
from gateway.session import SessionSource
runner = gateway.GatewayRunner(GatewayConfig())
source = SessionSource(platform=Platform.LOCAL, chat_id='fixture', user_id='fixture')
async def main():
    for temperature in ('cold', 'warm'):
        result = await runner._run_agent_inner('fixture question', '', [], source,
            'fixture-session', session_key='fixture-key')
        assert result.get('final_response') == 'fixture ordinary reply', result.get('final_response')
        assert result.get('api_calls', 0) > 0
        assert len(runner._agent_cache) == 1
        print('NON_EVAL_CONTROL_PASS', temperature, flush=True)
    print('HTTP_FIXTURE_PATHS', calls, flush=True)
    import sys
    import threading
    from wolfhouse import luna_personality_isolation as isolation
    isolation.install_isolation_runtime(runner=runner)
    downstream = []
    def tripwire(frame, event, arg):
        if event == 'call' and frame.f_code.co_name == '_resolve_session_agent_runtime':
            downstream.append('resolver')
            raise AssertionError('resource boundary reached')
    cap = isolation.IsolatedTurnCapture(case_id='fixture', personality_id='balanced', tenant_id='sunset')
    token = isolation.enter_isolated_turn(cap)
    # Profile the real worker before the resolver body, without replacing its owner.
    threading.setprofile_all_threads(tripwire)
    try:
        try:
            await runner._run_agent_inner('fixture question', '', [], source,
                'fixture-session', session_key='fixture-key')
        except isolation.IsolationAbort as exc:
            assert exc.reason == 'runtime_resolution_unverified', exc.reason
        else:
            raise AssertionError('isolated warm request did not propagate runtime_resolution_unverified; downstream=' + repr(downstream))
        assert downstream == []
    finally:
        threading.setprofile_all_threads(None)
        sys.setprofile(None)
        isolation.exit_isolated_turn(token)
asyncio.run(main())
