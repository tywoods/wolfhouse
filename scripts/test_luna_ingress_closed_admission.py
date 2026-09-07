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
# Synthetic disposable-only auth input; no auth owner replacement or host setting.
os.environ['GATEWAY_ALLOWED_USERS'] = 'fixture'
source = SessionSource(platform=Platform.LOCAL, chat_id='fixture', user_id='fixture')

from wolfhouse import luna_personality_isolation as iso
from gateway.platforms.base import MessageEvent, MessageType
import sys, inspect
async def main():
    # Warm the genuine cached owner using the retained SDK external fixture.
    result = await runner._run_agent_inner('fixture question', '', [], source,
        'fixture-session', session_key=runner._session_key_for_source(source))
    assert result['final_response'] == 'fixture ordinary reply'
    assert result.get('api_calls', 0) > 0
    # Staff API is an external boundary absent from the pinned base image.
    # Install an explicit deny-only transport fixture, not a lifecycle stand-in.
    import types
    staff = types.ModuleType('wolfhouse_staff_api')
    def deny_staff(*args, **kwargs):
        raise AssertionError('external Staff operation forbidden')
    staff._post_bot = deny_staff
    sys.modules['wolfhouse_staff_api'] = staff
    iso.install_isolation_runtime(runner=runner)
    cap = iso.IsolatedTurnCapture(case_id='whole-ingress', personality_id='balanced', tenant_id='sunset')
    event = MessageEvent(text='fixture question', message_type=MessageType.TEXT,
                         source=source, message_id='whole-ingress-message')
    observed = []
    def trace(frame, event, arg):
        if event == 'return' and frame.f_code.co_name == '_handle_message':
            import linecache
            print('INGRESS_RETURN', frame.f_lineno, linecache.getline(frame.f_code.co_filename, frame.f_lineno).strip(), flush=True)
        if event == 'call' and frame.f_code.co_name in {'_handle_message', '_isolated_handle', '_handle_message_with_agent', 'settle_isolated_async_work'}:
            observed.append([frame.f_code.co_name, frame.f_code.co_filename])
    print('INGRESS_PREREQUISITES', runner._startup_restore_in_progress, runner._is_user_authorized(source), flush=True)
    ordinary_before = len(calls)
    ordinary = await runner._handle_message(event)
    assert ordinary == 'fixture ordinary reply', ordinary
    assert len(calls) > ordinary_before
    print('ORDINARY_WHOLE_INGRESS_SDK_PASS', len(calls)-ordinary_before, flush=True)
    token = iso.enter_isolated_turn(cap)
    before = len(calls)
    outcome = None
    sys.setprofile(trace)
    try:
        try:
            outcome = await runner._handle_message(event)
        except iso.IsolationAbort as exc:
            outcome = exc.reason
    finally:
        sys.setprofile(None)
        iso.exit_isolated_turn(token)
    print('WHOLE_INGRESS_TRACE', json.dumps({'owners': observed, 'outcome': str(outcome), 'fixture_sdk_delta': len(calls)-before, 'async_work_settled': cap.async_work_settled}), flush=True)
    assert any(name == '_handle_message' for name, path in observed), 'genuine ingress not entered'
    assert any(name == '_handle_message_with_agent' for name, path in observed), 'agent ingress not entered'
    assert outcome == 'runtime_resolution_unverified', outcome
    assert len(calls) == before, 'closed isolation admission reached SDK'
    assert cap.async_work_settled
    print('CAPTURED_AGENT_REACHING_REFUSAL_AND_DRAIN_PASS', flush=True)
    assert any(name == 'settle_isolated_async_work' for name, path in observed), 'production ingress returned without invoking async completion owner'
asyncio.run(main())
