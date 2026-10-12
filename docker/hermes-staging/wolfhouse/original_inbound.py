"""Gateway-owned original text. Never reconstructed from model input/history.

Only patched ingress owners capture this capability. Copied contexts share its
lock, one-use bit and revocation; cancellation invalidates executor descendants.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import inspect
import logging
import os
from threading import RLock
from uuid import uuid4


logger = logging.getLogger(__name__)

_current = ContextVar('wolfhouse_original_inbound', default=None)
_EVENT_OWNER_TOKEN = object()
_RUN_OWNER_TOKEN = object()


def _source(source):
    return dict(PLATFORM=str(getattr(source.platform, 'value', source.platform)),
                CHAT_ID=str(source.chat_id or ''), USER_ID=str(source.user_id or ''),
                THREAD_ID=str(source.thread_id or ''))


class OriginalInbound:
    def __init__(self, text, identity, message_id, internal=False):
        self.text = text if isinstance(text, str) and text.strip() and not internal else None
        self.identity = identity
        self.message_id = str(message_id or '')
        self.tenant = os.environ.get('LUNA_CLIENT_SLUG', '').strip()
        self.lock = RLock()
        self.closed = False
        self.used = False
        self.binding = None

    def close(self):
        with self.lock:
            self.closed = True

    def bind(self, db, session_id, session_key, source, message_id):
        from .accepted_quote import QuoteBoundaryError
        with self.lock:
            if (self.closed or self.used or self.binding is not None
                    or self.identity != source or self.message_id != str(message_id or '')
                    or not self.message_id or not self.tenant or not session_key):
                raise QuoteBoundaryError('original_inbound_identity_mismatch')
            row = db.get_session(session_id) if db else None
            if not row or row.get('ended_at') is not None:
                raise QuoteBoundaryError('original_inbound_session_missing')
            scope = dict(source, SOURCE=source['PLATFORM'], KEY=session_key,
                         ID=session_id, MESSAGE_ID=self.message_id, tenant=self.tenant)
            self.binding = (db, scope, row['started_at'])


def gateway_event_owner(fn):
    """Capture at _handle_message entry, before pre_dispatch plugin rewrites."""
    @wraps(fn)
    async def owned(self, event, *args, **kwargs):
        source = _source(event.source)
        cap = OriginalInbound(event.text, source, event.message_id,
                              getattr(event, 'internal', False))
        token = _current.set(cap if cap.tenant and source['PLATFORM'] in ('whatsapp', 'whatsapp_cloud') else None)
        try:
            return await fn(self, event, *args, **kwargs)
        finally:
            cap.close()
            _current.reset(token)
    owned._wolfhouse_gateway_event_owner_token = _EVENT_OWNER_TOKEN
    return owned


@contextmanager
def _session_identity(cap):
    from gateway import session_context as ingress
    db, scope, incarnation = cap.binding
    tokens = [(ingress._VAR_MAP['HERMES_SESSION_' + key],
               ingress._VAR_MAP['HERMES_SESSION_' + key].set(value))
              for key, value in scope.items() if key != 'tenant']
    try:
        yield
    finally:
        for var, token in reversed(tokens):
            var.reset(token)


def bind_gateway_session(db, session_id, session_key, source, message_id):
    """Bind routing/incarnation immediately after session selection, pre-enrichment."""
    from .accepted_quote import QuoteBoundaryError
    cap = _current.get()
    if cap is None:
        return
    try:
        cap.bind(db, session_id, session_key, _source(source), message_id)
    except QuoteBoundaryError as exc:
        logger.warning(
            "quote_owner_boundary_rejected stage=session_binding reason=%s",
            str(exc),
        )
        cap.close()
        _current.set(None)


@contextmanager
def gateway_followup_event_owner(db, event, session_id, session_key):
    """Mint authority only for an adapter-owned queued event."""
    from gateway.platforms.base import MessageEvent
    from .accepted_quote import QuoteBoundaryError
    if not isinstance(event, MessageEvent) or getattr(event, 'internal', False):
        raise QuoteBoundaryError('original_inbound_queued_event_invalid')
    source = _source(event.source)
    cap = OriginalInbound(event.text, source, event.message_id,
                          getattr(event, 'internal', False))
    eligible = cap.tenant and source['PLATFORM'] in ('whatsapp', 'whatsapp_cloud')
    token = _current.set(cap if eligible else None)
    if eligible:
        bind_gateway_session(db, session_id, session_key, event.source, event.message_id)
    try:
        yield
    finally:
        cap.close()
        _current.reset(token)


def gateway_run_owner(fn):
    signature = inspect.signature(fn)
    @wraps(fn)
    async def owned(self, *args, **kwargs):
        cap = _current.get()
        if cap is None:
            return await fn(self, *args, **kwargs)
        values = signature.bind(self, *args, **kwargs)
        values.apply_defaults()
        v = values.arguments
        from .accepted_quote import QuoteBoundaryError
        try:
            try:
                with cap.lock:
                    source_scope = _source(v['source'])
                    expected = dict(source_scope, SOURCE=source_scope['PLATFORM'],
                        ID=v['session_id'], KEY=v['session_key'],
                        MESSAGE_ID=cap.message_id, tenant=cap.tenant)
                    if (cap.closed or cap.used or cap.binding is None
                            or cap.binding[0] is not getattr(self, '_session_db', None)
                            or cap.binding[1] != expected):
                        raise QuoteBoundaryError('original_inbound_identity_mismatch')
            except QuoteBoundaryError as exc:
                logger.warning(
                    'quote_owner_boundary_rejected stage=runner_validation reason=%s',
                    str(exc),
                )
                # Queued/internal follow-ups cannot inherit the initiating event.
                # Keep ordinary conversation available with no consent authority.
                token = _current.set(None)
                try:
                    return await fn(self, *args, **kwargs)
                finally:
                    _current.reset(token)
            with _session_identity(cap):
                return await fn(self, *args, **kwargs)
        finally:
            cap.close()
    owned._wolfhouse_gateway_run_owner_token = _RUN_OWNER_TOKEN
    return owned


def _queued_seam_probe():
    """Actively prove a queued MessageEvent mints, binds, closes and resets."""
    from gateway.config import Platform
    from gateway.platforms.base import MessageEvent
    from gateway.session import SessionSource

    class ProbeDB:
        @staticmethod
        def get_session(session_id):
            if session_id == 'wolfhouse-readiness-probe':
                return {'started_at': 1, 'ended_at': None}
            return None

    source = SessionSource(
        platform=Platform.WHATSAPP_CLOUD,
        chat_id='wolfhouse-readiness-probe',
        user_id='wolfhouse-readiness-probe',
        thread_id=None,
    )
    event = MessageEvent(
        text='readiness probe', message_id='wolfhouse-readiness-probe',
        source=source,
    )
    before = _current.get()
    cap = None
    db = ProbeDB()
    with gateway_followup_event_owner(
            db, event, 'wolfhouse-readiness-probe',
            'agent:main:whatsapp_cloud:dm:wolfhouse-readiness-probe'):
        cap = _current.get()
        if (cap is None or cap.closed or cap.binding is None
                or cap.binding[0] is not db
                or cap.binding[1].get('MESSAGE_ID') != event.message_id):
            return False
    return cap.closed and _current.get() is before


def gateway_runtime_ready(runner_type):
    wrappers_ready = (
        getattr(getattr(runner_type, '_handle_message', None),
                '_wolfhouse_gateway_event_owner_token', None) is _EVENT_OWNER_TOKEN
        and getattr(getattr(runner_type, '_run_agent', None),
                    '_wolfhouse_gateway_run_owner_token', None) is _RUN_OWNER_TOKEN
    )
    if not wrappers_ready:
        return False
    try:
        return bool(_queued_seam_probe())
    except Exception:
        logger.exception('queued original-inbound readiness probe failed')
        return False


def api_original(text, session_id):
    # Supported authenticated API session path is a separate synthetic principal,
    # not a WhatsApp impersonation via caller-supplied history/session-key headers.
    sid = str(session_id or '')
    return OriginalInbound(text, dict(PLATFORM='api_server', CHAT_ID=sid,
        USER_ID='api-session:' + sid, THREAD_ID=''), 'api-' + uuid4().hex)


@contextmanager
def api_worker_owner(cap, agent):
    from .accepted_quote import QuoteBoundaryError
    token = _current.set(cap if cap.tenant else None)
    try:
        sid = getattr(agent, 'session_id', None)
        if not cap.tenant:
            yield
            return
        try:
            if cap.identity['CHAT_ID'] != sid:
                raise QuoteBoundaryError('original_api_session_missing')
            cap.bind(getattr(agent, '_session_db', None), sid, 'api-session:' + str(sid),
                     cap.identity, cap.message_id)
        except QuoteBoundaryError:
            _current.set(None)
            yield
            return
        with _session_identity(cap):
            yield
    finally:
        cap.close()
        _current.reset(token)


def consume(agent):
    from .accepted_quote import _scope, QuoteBoundaryError
    cap = _current.get()
    if cap is None:
        raise QuoteBoundaryError('original_inbound_missing')
    with cap.lock:
        if cap.closed or cap.used or not isinstance(cap.text, str):
            raise QuoteBoundaryError('original_inbound_closed_or_missing_text')
        db, scope = _scope(agent)
        row = db.get_session(scope['ID'])
        if (cap.binding is None or cap.binding[0] is not db or cap.binding[1] != scope
                or not row or row.get('ended_at') is not None
                or row['started_at'] != cap.binding[2]):
            raise QuoteBoundaryError('original_inbound_identity_mismatch')
        cap.used = True
        return cap
