"""Final-outbound persistence inside the installed quote-owner loop wrapper.

No installed runtime files are modified. The per-agent flush is deferred until
owner finalization, then restored even on failure. This is local persistence,
not provider delivery. The gateway must not send a failed turn.
"""
from contextlib import contextmanager


class _Outbound:
    def __init__(self, agent, flush, history):
        self.agent, self.flush, self.history = agent, flush, history

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
        # Let the runtime own user/tool history and its ordinary deduplication.
        # The final assistant row alone belongs to the atomic owner transaction.
        self.flush(messages[:-1], self.history)
        receipt = owner.commit_question_outbound(text, descriptor['kind'], descriptor['options'])
        messages[-1]['id'] = receipt['message_id']
        ids = getattr(self.agent, '_flushed_db_message_ids', None)
        if isinstance(ids, set):
            ids.add(id(messages[-1]))
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
