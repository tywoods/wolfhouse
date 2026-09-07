#!/usr/bin/env python3
"""Idempotently patch the pinned Hermes main-turn and Responses-attempt seams."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MARKER = "crowsnest_attempt_boundary_v2"

RUNTIME_SETUP_ANCHOR = '''    max_stream_retries = 1
    # Accumulate streamed text so callers / compat shims can read it.
'''
RUNTIME_SETUP_REPLACEMENT = '''    max_stream_retries = 1
    # crowsnest_attempt_boundary_v2: callbacks are fail-open and scoped by the
    # guest-reply ContextVar set only at the approved main-turn callsite.
    try:
        from wolfhouse.crowsnest_ai_usage_reporter import (
            observe_attempt_failure as _crowsnest_failure,
            observe_attempt_result as _crowsnest_result,
        )
    except Exception:
        _crowsnest_failure = _crowsnest_result = None

    def _crowsnest_latency(started):
        return max(0, round((time.monotonic() - started) * 1000))

    def _crowsnest_observe_failure(exc, started):
        if _crowsnest_failure is not None:
            try:
                _crowsnest_failure(exc, api_kwargs.get("model"), _crowsnest_latency(started),
                                    provider=getattr(agent, "provider", ""), env=os.environ)
            except Exception:
                pass

    def _crowsnest_observe_result(response, started):
        if _crowsnest_result is not None:
            try:
                _crowsnest_result(response, api_kwargs.get("model"), _crowsnest_latency(started),
                                   provider=getattr(agent, "provider", ""), env=os.environ)
            except Exception:
                pass

    # Accumulate streamed text so callers / compat shims can read it.
'''
RUNTIME_ATTEMPT_ANCHOR = '''        try:
            event_stream = active_client.responses.create(**stream_kwargs)
        except (_httpx.RemoteProtocolError, _httpx.ReadTimeout, _httpx.ConnectError, ConnectionError) as exc:
            if attempt < max_stream_retries:
'''
RUNTIME_ATTEMPT_REPLACEMENT = '''        _crowsnest_attempt_started = time.monotonic()
        try:
            event_stream = active_client.responses.create(**stream_kwargs)
        except (_httpx.RemoteProtocolError, _httpx.ReadTimeout, _httpx.ConnectError, ConnectionError) as exc:
            _crowsnest_observe_failure(exc, _crowsnest_attempt_started)
            if attempt < max_stream_retries:
'''
RUNTIME_ATTEMPT_EXCEPTION_ANCHOR = '''                continue
            raise

        try:
            # Compatibility: some mocks/providers return a concrete response
'''
RUNTIME_ATTEMPT_EXCEPTION_REPLACEMENT = '''                continue
            raise
        except Exception as exc:
            _crowsnest_observe_failure(exc, _crowsnest_attempt_started)
            raise

        try:
            # Compatibility: some mocks/providers return a concrete response
'''
RUNTIME_ITERATION_ANCHOR = '''            except (_httpx.RemoteProtocolError, _httpx.ReadTimeout, _httpx.ConnectError, ConnectionError) as exc:
                if attempt < max_stream_retries:
'''
RUNTIME_ITERATION_REPLACEMENT = '''            except (_httpx.RemoteProtocolError, _httpx.ReadTimeout, _httpx.ConnectError, ConnectionError) as exc:
                _crowsnest_observe_failure(exc, _crowsnest_attempt_started)
                if attempt < max_stream_retries:
'''
RUNTIME_ITERATION_EXCEPTION_ANCHOR = '''                    continue
                raise

            if final.status in {"incomplete", "failed"}:
'''
RUNTIME_ITERATION_EXCEPTION_REPLACEMENT = '''                    continue
                raise
            except Exception as exc:
                _crowsnest_observe_failure(exc, _crowsnest_attempt_started)
                raise

            if final.status in {"incomplete", "failed"}:
'''
RUNTIME_CONCRETE_ANCHOR = '''            if hasattr(event_stream, "output") and not hasattr(event_stream, "__iter__"):
                return event_stream
'''
RUNTIME_CONCRETE_REPLACEMENT = '''            if hasattr(event_stream, "output") and not hasattr(event_stream, "__iter__"):
                _crowsnest_observe_result(event_stream, _crowsnest_attempt_started)
                return event_stream
'''
RUNTIME_RESULT_ANCHOR = '''            if final.status in {"incomplete", "failed"}:
                logger.warning(
'''
RUNTIME_RESULT_REPLACEMENT = '''            _crowsnest_observe_result(final, _crowsnest_attempt_started)
            if final.status in {"incomplete", "failed"}:
                logger.warning(
'''
RUNTIME_TERMINAL_ANCHOR = '''            if event_type == "response.completed":
                terminal_status = terminal_status or "completed"
            elif event_type == "response.incomplete":
                terminal_status = terminal_status or "incomplete"
            elif event_type == "response.failed":
                terminal_status = terminal_status or "failed"
'''
RUNTIME_TERMINAL_REPLACEMENT = '''            if event_type == "response.completed":
                terminal_status = "completed"
            elif event_type == "response.incomplete":
                terminal_status = "incomplete"
            elif event_type == "response.failed":
                terminal_status = "failed"
'''
RUNTIME_DEFAULT_STATUS_ANCHOR = '''    terminal_status: str = "completed"
'''
RUNTIME_DEFAULT_STATUS_REPLACEMENT = '''    terminal_status: str = "failed"
'''
RUNTIME_FINAL_ANCHOR = '''        incomplete_details=terminal_incomplete_details,
        error=terminal_error,
    )
'''
RUNTIME_FINAL_REPLACEMENT = '''        incomplete_details=terminal_incomplete_details,
        error=terminal_error,
        terminal_event_type="response.completed" if saw_terminal and terminal_status == "completed" else (
            "response.incomplete" if saw_terminal and terminal_status == "incomplete" else (
                "response.failed" if saw_terminal else None
            )
        ),
    )
'''

HELPER_ANCHOR = '''                result["response"] = agent._run_codex_stream(
                    api_kwargs,
                    client=request_client,
                    on_first_delta=getattr(agent, "_codex_on_first_delta", None),
                )
'''
HELPER_REPLACEMENT = '''                # crowsnest_guest_reply_context_v2: deliberately excludes iteration-limit
                # summaries, compression, auxiliary and coding calls.
                from wolfhouse.crowsnest_ai_usage_reporter import guest_reply_context
                with guest_reply_context():
                    result["response"] = agent._run_codex_stream(
                        api_kwargs,
                        client=request_client,
                        on_first_delta=getattr(agent, "_codex_on_first_delta", None),
                    )
'''


def _replace_once(text: str, anchor: str, replacement: str, label: str) -> str:
    if text.count(anchor) != 1:
        raise RuntimeError(f"{label} anchor not found exactly once")
    return text.replace(anchor, replacement, 1)


def _validate_patched(runtime: str, helper: str) -> None:
    required = {
        "runtime marker": (runtime, MARKER, 1),
        "attempt start": (runtime, "_crowsnest_attempt_started = time.monotonic()", 1),
        "failure observers": (runtime, "_crowsnest_observe_failure(exc, _crowsnest_attempt_started)", 4),
        "responses create seam": (runtime, "active_client.responses.create(**stream_kwargs)", 1),
        "generic create wrapper": (runtime, "except Exception as exc:\n            _crowsnest_observe_failure(exc, _crowsnest_attempt_started)", 1),
        "generic iteration wrapper": (runtime, "except Exception as exc:\n                _crowsnest_observe_failure(exc, _crowsnest_attempt_started)", 1),
        "stream result observer": (runtime, "_crowsnest_observe_result(final, _crowsnest_attempt_started)", 1),
        "concrete result observer": (runtime, "_crowsnest_observe_result(event_stream, _crowsnest_attempt_started)", 1),
        "helper marker": (helper, "crowsnest_guest_reply_context_v2", 1),
        "guest context import": (helper, "from wolfhouse.crowsnest_ai_usage_reporter import guest_reply_context", 1),
        "guest context use": (helper, "with guest_reply_context():", 1),
        "authoritative terminal assignments": (runtime, RUNTIME_TERMINAL_REPLACEMENT, 1),
        "terminal proof": (runtime, RUNTIME_FINAL_REPLACEMENT, 1),
    }
    for label, (text, needle, count) in required.items():
        if text.count(needle) != count:
            raise RuntimeError(f"crowsnest patch corruption: {label}")


def prepare_files(run_agent_path: Path, runtime_path: Path, helper_path: Path):
    """Read, validate and compile candidates without writing any input."""
    paths = (run_agent_path, runtime_path, helper_path)
    originals = [p.read_text(encoding="utf-8") for p in paths]
    runtime, helper = originals[1], originals[2]
    runtime_marked = MARKER in runtime
    helper_marked = "crowsnest_guest_reply_context_v2" in helper
    if runtime_marked or helper_marked:
        if not (runtime_marked and helper_marked):
            raise RuntimeError("crowsnest patch corruption: partial markers")
        _validate_patched(runtime, helper)
        for text, path in zip(originals, (run_agent_path, runtime_path, helper_path)):
            compile(text, str(path), "exec")
        result = {"changed": False, "paths": [str(runtime_path), str(helper_path)]}
        return dict(zip(paths, originals)), dict(zip(paths, originals)), result

    patched_runtime = _replace_once(runtime, RUNTIME_TERMINAL_ANCHOR, RUNTIME_TERMINAL_REPLACEMENT, "terminal event status")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_DEFAULT_STATUS_ANCHOR, RUNTIME_DEFAULT_STATUS_REPLACEMENT, "default terminal status")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_FINAL_ANCHOR, RUNTIME_FINAL_REPLACEMENT, "terminal proof")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_SETUP_ANCHOR, RUNTIME_SETUP_REPLACEMENT, "codex runtime setup")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_ATTEMPT_ANCHOR, RUNTIME_ATTEMPT_REPLACEMENT, "responses.create attempt")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_ATTEMPT_EXCEPTION_ANCHOR, RUNTIME_ATTEMPT_EXCEPTION_REPLACEMENT, "responses.create generic exception")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_ITERATION_ANCHOR, RUNTIME_ITERATION_REPLACEMENT, "response iteration attempt")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_ITERATION_EXCEPTION_ANCHOR, RUNTIME_ITERATION_EXCEPTION_REPLACEMENT, "response iteration generic exception")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_CONCRETE_ANCHOR, RUNTIME_CONCRETE_REPLACEMENT, "concrete response result")
    patched_runtime = _replace_once(patched_runtime, RUNTIME_RESULT_ANCHOR, RUNTIME_RESULT_REPLACEMENT, "terminal result")
    patched_helper = _replace_once(helper, HELPER_ANCHOR, HELPER_REPLACEMENT, "approved main Luna turn")
    _validate_patched(patched_runtime, patched_helper)
    compile(originals[0], str(run_agent_path), "exec")
    compile(patched_runtime, str(runtime_path), "exec")
    compile(patched_helper, str(helper_path), "exec")
    candidates = dict(zip(paths, (originals[0], patched_runtime, patched_helper)))
    result = {"changed": True, "paths": [str(runtime_path), str(helper_path)]}
    return dict(zip(paths, originals)), candidates, result


def patch_files(run_agent_path: Path, runtime_path: Path, helper_path: Path):
    originals, candidates, result = prepare_files(run_agent_path, runtime_path, helper_path)
    if not result["changed"]:
        return result
    runtime_path.write_text(candidates[runtime_path], encoding="utf-8")
    try:
        helper_path.write_text(candidates[helper_path], encoding="utf-8")
    except Exception:
        runtime_path.write_text(originals[runtime_path], encoding="utf-8")
        raise
    return result


def _module_path(name: str) -> Path:
    spec = importlib.util.find_spec(name)
    if not spec or not spec.origin:
        raise RuntimeError(f"{name} module not found")
    return Path(spec.origin)


def patch_cancelled_registration(text: str) -> str:
    """Two-hunk owner extension; accept only the exact pinned post-Crowsnest helper."""
    import hashlib
    registration = '            request_client_holder["owner_tid"] = threading.get_ident()\n'
    guarded = registration + (
        '            if _request_cancelled["value"]:\n'
        '                raise InterruptedError("Request cancelled before client registration")\n'
    )
    cancellation = '            _request_cancelled["value"] = True\n'
    ordered = '            with request_client_lock:\n    ' + cancellation
    start = text.index('def interruptible_api_call(agent, api_kwargs: dict):\n')
    end = text.index('\ndef build_api_kwargs(', start)
    prefix, owner, suffix = text[:start], text[start:end], text[end:]
    normalized = owner
    marked = guarded in owner or ordered in owner
    if marked:
        normalized = _replace_once(normalized, guarded, registration, "cancel registration guard")
        normalized = _replace_once(normalized, ordered, cancellation, "cancel writer lock")
    if hashlib.sha256((prefix + normalized + suffix).encode("utf-8")).hexdigest() != (
        "64fb34842dc0267927f6a28daf6e400b3a46310e427dfbebf902db10219e7bd2"
    ):
        raise RuntimeError("cancel registration source fingerprint drift")
    patched = _replace_once(normalized, registration, guarded, "client ownership registration")
    patched = _replace_once(patched, cancellation, ordered, "request cancellation writer")
    patched = prefix + patched + suffix
    compile(patched, "agent/chat_completion_helpers.py", "exec")
    return patched


# B3e operands are scoped to the named lexical owner; hashes cover full modules.
B3E = (
    ('_run_codex_stream', '7a36be48ffdc0fe62b855263683d55c1c7138cc65acf597175920fcf86b45bd5', (
        ('    def _run_codex_stream(self, api_kwargs: dict, client: Any = None, on_first_delta: callable = None):\n',
         '    def _run_codex_stream(self, api_kwargs: dict, client: Any = None, on_first_delta: callable = None,\n                          request_cancelled=None, admit_attempt=None):\n'),
        ('        return run_codex_stream(self, api_kwargs, client, on_first_delta)\n',
         '        return run_codex_stream(self, api_kwargs, client, on_first_delta,\n                                request_cancelled=request_cancelled, admit_attempt=admit_attempt)\n'),
    )),
    ('run_codex_stream', '0d1ac4bc9cee7976a0d152613f858cdc91d9dd9faeaf7308accf3117ba397935', (
        ('def run_codex_stream(agent, api_kwargs: dict, client: Any = None, on_first_delta=None):\n',
         'def run_codex_stream(agent, api_kwargs: dict, client: Any = None, on_first_delta=None,\n                     request_cancelled=None, admit_attempt=None):\n'),
        ('        return bool(agent._interrupt_requested)\n',
         '        return bool(agent._interrupt_requested or (request_cancelled and request_cancelled()))\n'),
        ('        if agent._interrupt_requested:\n', '        if _interrupt_check():\n'),
        ('            event_stream = active_client.responses.create(**stream_kwargs)\n',
         '            if admit_attempt is not None:\n                admit_attempt()\n            event_stream = active_client.responses.create(**stream_kwargs)\n'),
    )),
    ('interruptible_api_call', '96b0fa3846ba7e39fa828cbca26dcb7c136c1410c8db49034804fcb9aad21e35', (
        ('    def _call():\n',
         '    def request_cancelled():\n        return _request_cancelled["value"]\n\n    def admit_attempt():\n        with request_client_lock:\n            if request_cancelled():\n                raise InterruptedError("Request cancelled before Codex attempt")\n\n    def _call():\n'),
        ('                        on_first_delta=getattr(agent, "_codex_on_first_delta", None),\n',
         '                        on_first_delta=getattr(agent, "_codex_on_first_delta", None),\n                        request_cancelled=request_cancelled,\n                        admit_attempt=admit_attempt,\n'),
    )),
)


def _b3e_replace(text, owner, changes, inverse=False):
    import ast
    nodes = [n for n in ast.walk(ast.parse(text)) if isinstance(n, ast.FunctionDef) and n.name == owner]
    if len(nodes) != 1:
        raise RuntimeError("B3e lexical owner drift")
    node, lines = nodes[0], text.splitlines(keepends=True)
    body = ''.join(lines[node.lineno - 1:node.end_lineno])
    for old, new in reversed(changes) if inverse else changes:
        body = _replace_once(body, new if inverse else old, old if inverse else new, "B3e lexical replacement")
    return ''.join(lines[:node.lineno - 1]) + body + ''.join(lines[node.end_lineno:])


B4_HELPER = (
    ('try_activate_fallback', ((
        '    if reason in {FailoverReason.rate_limit, FailoverReason.billing}:\n',
        '    from wolfhouse.luna_personality_isolation import current_isolated_turn, IsolationAbort\n'
        '    if current_isolated_turn() is not None:\n'
        '        raise IsolationAbort("isolated_fallback_denied")\n'
        '    if reason in {FailoverReason.rate_limit, FailoverReason.billing}:\n',
    ),)),
    ('interruptible_api_call', ((
        '        except Exception as e:\n',
        '        except Exception as e:\n'
        '            from wolfhouse.luna_personality_isolation import IsolationAbort, retain_worker_abort\n'
        '            if isinstance(e, IsolationAbort):\n'
        '                result["error"] = e\n'
        '                retain_worker_abort(e)\n'
        '                return\n',
    ),)),
)
B4_CATCH = ((
    '            except Exception as api_error:\n',
    '            except Exception as api_error:\n'
    '                from wolfhouse.luna_personality_isolation import IsolationAbort\n'
    '                if isinstance(api_error, IsolationAbort):\n'
    '                    raise\n',
),)


def patch_conversation_abort(text):
    import hashlib
    marked = B4_CATCH[0][1] in text
    original = _b3e_replace(text, 'run_conversation', B4_CATCH, inverse=True) if marked else text
    if hashlib.sha256(original.encode('utf-8')).hexdigest() != '3e89d9bb00d0b375b94a947600dd15934b300119bc1d56f2b04bdf59db56341b':
        raise RuntimeError('B4 conversation source fingerprint drift')
    return _b3e_replace(original, 'run_conversation', B4_CATCH)


def patch_codex_cancellation(candidates, paths):
    import hashlib
    helper = paths[2]
    b4_marked = [changes[0][1] in candidates[helper] for owner, changes in B4_HELPER]
    if any(b4_marked) and not all(b4_marked):
        raise RuntimeError('B4 mixed helper state')
    if all(b4_marked):
        for owner, changes in reversed(B4_HELPER):
            candidates[helper] = _b3e_replace(candidates[helper], owner, changes, inverse=True)
    marked = ['request_cancelled=' in candidates[path] for path in paths]
    if any(marked) and not all(marked):
        raise RuntimeError("B3e mixed cancellation state")
    for path, (owner, expected, changes) in zip(paths, B3E):
        text = candidates[path]
        if all(marked):
            text = _b3e_replace(text, owner, changes, inverse=True)
        if owner == 'interruptible_api_call':
            text = patch_cancelled_registration(text)  # inverse B3e precedes B3d validation
        if hashlib.sha256(text.encode('utf-8')).hexdigest() != expected:
            raise RuntimeError("B3e reconstructed source fingerprint drift")
        patched = _b3e_replace(text, owner, changes)
        if all(marked) and patched != candidates[path]:
            raise RuntimeError("B3e noncanonical cancellation state")
        candidates[path] = patched
    for owner, changes in B4_HELPER:
        candidates[helper] = _b3e_replace(candidates[helper], owner, changes)


def main():
    originals = {}
    try:
        helper_path = _module_path("agent.chat_completion_helpers")
        runtime_path = _module_path("agent.codex_runtime")
        run_agent_path = _module_path("run_agent")
        conversation_path = _module_path("agent.conversation_loop")
        paths = (runtime_path, helper_path, run_agent_path, conversation_path)
        originals = {path: path.read_bytes() for path in paths}
        source, candidates, result = prepare_files(run_agent_path, runtime_path, helper_path)
        source[conversation_path] = originals[conversation_path].decode('utf-8')
        if (B4_CATCH[0][1] in source[conversation_path]) != (B4_HELPER[0][1][0][1] in source[helper_path]):
            raise RuntimeError('B4 mixed conversation/helper state')
        candidates[conversation_path] = patch_conversation_abort(source[conversation_path])
        patch_codex_cancellation(candidates, (run_agent_path, runtime_path, helper_path))
        for path in paths:
            compile(candidates[path], str(path), "exec")
        for path in paths:
            if candidates[path] != source[path]:
                path.write_text(candidates[path], encoding="utf-8")
        print(result)
    except Exception as exc:
        # Best-effort caught-error recovery, not a crash-atomic transaction.
        for path, data in originals.items():
            try:
                if path.read_bytes() != data:
                    path.write_bytes(data)
            except Exception as restore_exc:
                print(f"apply_crowsnest_ai_usage_patch rollback failed: {path}: {restore_exc}", file=sys.stderr)
        print(f"apply_crowsnest_ai_usage_patch failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
