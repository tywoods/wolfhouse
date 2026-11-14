"""Final-outbound persistence inside the installed quote-owner loop wrapper.

No installed runtime files are modified. The per-agent flush is deferred until
owner finalization, then restored even on failure. This is local persistence,
not provider delivery. The gateway must not send a failed turn.
"""
from contextlib import contextmanager
from copy import deepcopy


class _Outbound:
    def __init__(self, agent, flush, history):
        self.agent, self.flush, self.history = agent, flush, deepcopy(history)

    def commit(self, result):
        from . import accepted_quote as owner
        from .pending_question import QuestionLedgerError
        if not isinstance(result, dict):
            raise QuestionLedgerError('final_outbound_missing')
        messages = result.get('messages') or []
        descriptor = owner._read_owner_state(lambda s, _: s.get('outbound_question'))
        if not descriptor:
            self.flush(messages, self.history)
            return result
        text = result.get('final_response')
        if (not messages or messages[-1].get('role') != 'assistant'
                or messages[-1].get('content') != text or messages[-1].get('tool_calls')):
            raise QuestionLedgerError('final_outbound_mismatch')
        # Finalization deep-copies the transcript. Validate the frozen historical
        # prefix by value, never by Python object identity. A rewritten/compacted
        # boundary is ambiguous and must fail closed rather than duplicate rows.
        history = self.history or []
        if messages[:len(history)] != history:
            raise QuestionLedgerError('historical_boundary_changed')
        self.agent._apply_persist_user_message_override(messages)
        # Match ordinary runtime persistence without stripping the live API/replay
        # transcript. SessionDB serialization alone retains raw image payloads.
        from agent.tool_dispatch_helpers import _is_multimodal_tool_result, _multimodal_text_summary
        rows = deepcopy(messages[len(history):])
        for row in rows:
            content = row.get('content')
            if _is_multimodal_tool_result(content):
                row['content'] = _multimodal_text_summary(content)
            elif isinstance(content, list):
                parts = []
                for part in content:
                    if isinstance(part, dict) and part.get('type') == 'text':
                        parts.append(str(part.get('text', '')))
                    elif isinstance(part, dict) and part.get('type') in {'image', 'image_url', 'input_image'}:
                        parts.append('[screenshot]')
                row['content'] = '\n'.join(parts) if parts else None
        receipt = owner.commit_question_outbound(
            text, descriptor['kind'], descriptor['options'], messages=rows)
        messages[-1]['id'] = receipt['message_id']
        self.agent._flushed_db_message_ids = {id(m) for m in messages}
        self.agent._flushed_db_message_session_id = self.agent.session_id
        self.agent._last_flushed_db_idx = len(messages)
        return result


@contextmanager
def final_outbound(agent, history=None):
    from .pending_question import QuestionLedgerError
    flush = getattr(agent, '_flush_messages_to_session_db', None)
    if not callable(flush):
        raise QuestionLedgerError('runtime_flush_missing')
    previous = agent.__dict__.get('_flush_messages_to_session_db')
    had_instance_method = '_flush_messages_to_session_db' in agent.__dict__
    # Intermediate flushes are intentionally withheld: they contain the draft,
    # not the final owner-authored question. No transport is invoked here.
    agent._flush_messages_to_session_db = lambda *a, **kw: None
    try:
        yield _Outbound(agent, flush, history)
    finally:
        if had_instance_method:
            agent._flush_messages_to_session_db = previous
        else:
            del agent._flush_messages_to_session_db
