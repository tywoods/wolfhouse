"""Gateway-owned original text. Never reconstructed from model input/history.

Only patched ingress owners capture this capability. Copied contexts share its
lock, one-use bit and revocation; cancellation invalidates executor descendants.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from collections import OrderedDict
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
_QUEUE_SNAPSHOT_ATTR = '_wolfhouse_original_inbound_snapshot'
_QUEUE_SNAPSHOTS = OrderedDict()
_QUEUE_SNAPSHOT_LIMIT = 4096


def _source(source):
    return dict(PLATFORM=str(getattr(source.platform, 'value', source.platform)),
                CHAT_ID=str(source.chat_id or ''), USER_ID=str(source.user_id or ''),
                THREAD_ID=str(source.thread_id or ''))


def _snapshot_key(source, message_id):
    identity = _source(source)
    return (identity['PLATFORM'], identity['CHAT_ID'], identity['USER_ID'],
            identity['THREAD_ID'], str(message_id or ''))


def _capture_snapshot(event):
    snapshot = (event.text, _source(event.source), str(event.message_id or ''),
                bool(getattr(event, 'internal', False)))
    setattr(event, _QUEUE_SNAPSHOT_ATTR, snapshot)
    key = _snapshot_key(event.source, event.message_id)
    _QUEUE_SNAPSHOTS[key] = snapshot
    _QUEUE_SNAPSHOTS.move_to_end(key)
    while len(_QUEUE_SNAPSHOTS) > _QUEUE_SNAPSHOT_LIMIT:
        _QUEUE_SNAPSHOTS.popitem(last=False)
    return snapshot


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
        snapshot = _capture_snapshot(event)
        cap = OriginalInbound(snapshot[0], source, event.message_id,
                              getattr(event, 'internal', False))
        token = _current.set(cap if cap.tenant and source['PLATFORM'] in ('whatsapp', 'whatsapp_cloud') else None)
        try:
            return await fn(self, event, *args, **kwargs)
        finally:
            cap.close()
            _current.reset(token)
    owned._wolfhouse_gateway_event_owner_token = _EVENT_OWNER_TOKEN
    return owned


gateway_busy_event_owner = gateway_event_owner


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
    """Mint authority only from the immutable adapter-ingress snapshot."""
    from gateway.platforms.base import MessageEvent
    snapshot = getattr(event, _QUEUE_SNAPSHOT_ATTR, None)
    if isinstance(event, MessageEvent):
        captured = _QUEUE_SNAPSHOTS.pop(
            _snapshot_key(event.source, event.message_id), None)
        if snapshot is None:
            snapshot = captured
    valid = (isinstance(event, MessageEvent) and isinstance(snapshot, tuple)
             and len(snapshot) == 4)
    if valid:
        original_text, original_source, original_message_id, original_internal = snapshot
        source = _source(event.source)
        valid = (not original_internal and source == original_source
                 and str(event.message_id or '') == original_message_id
                 and event.text == original_text)
    else:
        original_text, original_source, original_message_id, original_internal = (None, {}, '', True)
        source = {}
    cap = OriginalInbound(original_text, original_source, original_message_id,
                          original_internal)
    eligible = (valid and cap.tenant
                and source['PLATFORM'] in ('whatsapp', 'whatsapp_cloud'))
    token = _current.set(cap if eligible else None)
    try:
        if eligible:
            cap.bind(db, session_id, session_key, source, original_message_id)
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
    setattr(event, _QUEUE_SNAPSHOT_ATTR,
            (event.text, _source(source), event.message_id, False))
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


def _queued_worker_contained(fn):
    import ast
    import textwrap
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    except (OSError, TypeError, IndentationError, SyntaxError):
        return False
    owners = [node for node in ast.walk(tree)
              if isinstance(node, ast.AsyncFunctionDef)
              and node.name == '_run_agent_inner']
    if len(owners) != 1:
        return False
    owner = owners[0]
    helpers = [node for node in ast.walk(owner) if isinstance(node, ast.With)
               and any(isinstance(item.context_expr, ast.Call)
                       and ((isinstance(item.context_expr.func, ast.Name)
                             and item.context_expr.func.id == '_wh_followup_original')
                            or (isinstance(item.context_expr.func, ast.Attribute)
                                and item.context_expr.func.attr == 'gateway_followup_event_owner'))
                       for item in node.items)]
    workers = [node for node in ast.walk(owner) if isinstance(node, ast.Await)
               and isinstance(node.value, ast.Call)
               and isinstance(node.value.func, ast.Attribute)
               and node.value.func.attr == '_run_agent']
    return (len(helpers) == len(workers) == 1
            and workers[0] in list(ast.walk(helpers[0])))


def gateway_runtime_ready(runner_type):
    queued = getattr(runner_type, '_run_agent_inner', None)
    queued_ready = callable(queued) and _queued_worker_contained(queued)
    wrappers_ready = (
        getattr(getattr(runner_type, '_handle_message', None),
                '_wolfhouse_gateway_event_owner_token', None) is _EVENT_OWNER_TOKEN
        and getattr(getattr(runner_type, '_handle_active_session_busy_message', None),
                    '_wolfhouse_gateway_event_owner_token', None) is _EVENT_OWNER_TOKEN
        and getattr(getattr(runner_type, '_run_agent', None),
                    '_wolfhouse_gateway_run_owner_token', None) is _RUN_OWNER_TOKEN
        and queued_ready
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
