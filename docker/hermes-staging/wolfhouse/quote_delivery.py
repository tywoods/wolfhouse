"""Provider-accepted quote evidence, separate from model-authored presentation."""
import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass
from contextvars import ContextVar
from contextlib import contextmanager
import asyncio
import inspect
import logging
import secrets
from types import SimpleNamespace

logger = logging.getLogger(__name__)
_gateway = ContextVar('wolfhouse_quote_gateway', default=None)
_sending = ContextVar('wolfhouse_quote_sending', default=None)
_internal = ContextVar('wolfhouse_quote_internal_continuation', default=False)
_handoff_notice = ContextVar('wolfhouse_quote_handoff_notice', default=False)
_pending_send = ContextVar('wolfhouse_quote_pending_send', default=None)


def assert_runtime_live():
    transport = _gateway.get()
    if transport is not None and not transport.live():
        from .accepted_quote import QuoteBoundaryError
        raise QuoteBoundaryError('quote_dispatch_superseded')


def internal_continuation_active():
    if not _internal.get():
        return False
    assert_runtime_live()
    return _gateway.get() is not None


def suppress_unfinalized_send():
    transport = _gateway.get()
    if _handoff_notice.get() and transport is not None and transport.live():
        from .explicit_human_handoff import _SENDING_ACK
        if _SENDING_ACK.get():
            return False  # Only the existing guarded handoff note, never a quote receipt.
    return transport is not None and not transport.closed and _sending.get() is None


def record_provider_result(content, result):
    ticket = _sending.get()
    if ticket is None:
        return False
    transport = _gateway.get()
    if transport is not None and not transport.live():
        return False
    raw = getattr(result, 'raw_response', None)
    suppressed = isinstance(raw, dict) and any(
        str(key).startswith('suppressed_') for key in raw)
    if getattr(result, 'success', False) is not True or suppressed:
        return False
    return acknowledge(ticket, content, getattr(result, 'message_id', None))


async def _receipt_wait(pending, seconds):
    try:
        await asyncio.wait_for(pending.signal.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


class _ReceiptClient:
    """Delegate unchanged HTTP I/O, adding a nonce only to the checked quote.

    Context-local correlation does not capture unrelated concurrent sends. The
    nonce carries no guest data and only lives for this bounded send attempt.
    """
    def __init__(self, client, adapter):
        self.client, self.adapter = client, adapter

    def __getattr__(self, name):
        return getattr(self.client, name)

    async def post(self, *args, **kwargs):
        pending = _pending_send.get()
        payload = kwargs.get('json')
        if (pending is not None and pending.transport.live()
                and pending.adapter is self.adapter
                and isinstance(payload, dict) and payload.get('type') == 'text'
                and str(payload.get('to', '')).lstrip('+') == pending.chat_id.lstrip('+')
                and (payload.get('text') or {}).get('body') == self.adapter.format_message(pending.text)):
            kwargs['json'] = dict(payload, biz_opaque_callback_data=pending.nonce)
        return await self.client.post(*args, **kwargs)


def _collect_receipts(adapter, payload):
    pending_sends = getattr(adapter, '_wolfhouse_quote_receipts', {})
    if not pending_sends or not isinstance(payload, dict):
        return
    for entry in payload.get('entry') or []:
        if not isinstance(entry, dict):
            continue
        for change in entry.get('changes') or []:
            if not isinstance(change, dict) or change.get('field') != 'messages':
                continue
            value = change.get('value') or {}
            if not isinstance(value, dict):
                continue
            metadata = value.get('metadata')
            if (not isinstance(metadata, dict)
                    or metadata.get('phone_number_id') != adapter._phone_number_id):
                continue
            for status in value.get('statuses') or []:
                if not isinstance(status, dict):
                    continue
                nonce = status.get('biz_opaque_callback_data')
                pending = pending_sends.get(nonce) if isinstance(nonce, str) else None
                if (pending is None or not pending.transport.live()
                        or str(status.get('recipient_id', '')).lstrip('+') != pending.chat_id.lstrip('+')):
                    continue
                if status.get('status') == 'failed':
                    pending.failed = True
                    pending.signal.set()
                elif (not pending.failed and status.get('status') in ('sent', 'delivered', 'read')
                      and isinstance(status.get('id'), str) and status['id'].strip()):
                    pending.receipt = dict(status)
                    pending.signal.set()


def install_receipt_observer(adapter_class):
    original = adapter_class._handle_webhook
    if getattr(original, '_wolfhouse_quote_receipts', False):
        return

    async def receive(self, request):
        result = await original(self, request)
        # Only the existing authenticated Meta webhook may supply late receipts.
        # Recheck its signature as well: guest text/model/mirror data never count.
        if result.status == 200 and getattr(self, '_wolfhouse_quote_receipts', None):
            raw = await request.read()
            if self._verify_signature(raw, request.headers.get('X-Hub-Signature-256', '')):
                _collect_receipts(self, json.loads(raw))
        return result
    receive._wolfhouse_quote_receipts = True
    adapter_class._handle_webhook = receive


class GatewayTransport:
    def __init__(self, runner, cap, values):
        self.runner, self.cap, self.values = runner, cap, values
        self.loop = asyncio.get_running_loop()
        self.closed = False
        self.failure_reason = None

    def live(self):
        if self.closed or self.cap.closed:
            return False
        key = self.values.get('session_key')
        generation = self.values.get('run_generation')
        if not self.runner._is_session_run_current(key, generation):
            return False
        source = self.values.get('source')
        adapter = self.runner.adapters.get(source.platform)
        if adapter is None or getattr(adapter, '_pending_messages', {}).get(key):
            return False
        entry = self.runner.session_store._entries.get(key)
        return entry is not None and entry.session_id == self.cap.binding[1]['ID']

    async def send(self, ticket, text):
        if not self.live():
            return False
        source = self.values['source']
        adapter = self.runner.adapters[source.platform]
        pending = SimpleNamespace(
            transport=self, adapter=adapter, ticket=ticket, text=text,
            chat_id=str(source.chat_id), nonce=secrets.token_urlsafe(24),
            receipt=None, failed=False, signal=asyncio.Event())
        receipts = getattr(adapter, '_wolfhouse_quote_receipts', None)
        if receipts is None:
            receipts = adapter._wolfhouse_quote_receipts = {}
        receipts[pending.nonce] = pending
        client = getattr(adapter, '_http_client', None)
        if client is not None and not isinstance(client, _ReceiptClient):
            adapter._http_client = _ReceiptClient(client, adapter)
        token = _sending.set(ticket)
        receipt_token = _pending_send.set(pending)
        def acknowledged():
            return self.live() and _state_call(ticket.binding, lambda state:
                state.get('epoch') == ticket.epoch and has_send_ack(state.get('presentation'))
                and _presentation_digest(state['presentation']) == ticket.digest) is True
        try:
            from .guest_send_guard import mark_agent_reply_metadata
            metadata = mark_agent_reply_metadata(
                self.runner._thread_metadata_for_source(
                    source, self.values.get('event_message_id')), source.platform)
            # A definite refusal must hand off, not resend altered/plain-text
            # quote bodies through the generic platform fallback loop.
            result = await adapter.send(
                chat_id=source.chat_id, content=text,
                reply_to=self.values.get('event_message_id'), metadata=metadata)
            raw = getattr(result, 'raw_response', None)
            suppressed = isinstance(raw, dict) and any(
                str(key).startswith('suppressed_') for key in raw)
            if suppressed:
                return False  # Kill switches/pauses remain silent; never bypass them.
            missing_id = isinstance(raw, dict) and raw.get('blocked_reason') == 'provider_returned_no_message_id'
            if pending.failed or (getattr(result, 'success', False) is not True and not missing_id):
                self.failure_reason = 'whatsapp_quote_send_failed'
                return False
            if acknowledged():
                return True
            # Four receipt checks over 30 seconds; no quote resends. A signed
            # failure/success webhook wakes the current interval immediately.
            for _ in range(4):
                await _receipt_wait(pending, 7.5)
                if not self.live():
                    return False
                if pending.failed:
                    self.failure_reason = 'whatsapp_quote_send_failed'
                    return False
                if pending.receipt and acknowledge(ticket, text, pending.receipt['id']):
                    return acknowledged()
            self.failure_reason = 'whatsapp_quote_receipt_missing'
            return False
        finally:
            receipts.pop(pending.nonce, None)
            _pending_send.reset(receipt_token)
            _sending.reset(token)


@contextmanager
def gateway_transport(runner, cap, values):
    transport = GatewayTransport(runner, cap, values)
    token = _gateway.set(transport)
    try:
        yield transport
    finally:
        transport.closed = True
        _gateway.reset(token)


def finish_turn(agent, result, original, args, kwargs):
    """Await the gated send in the still-active gateway task; resume at most once.

    This runs in the model executor. It never observes a fabricated guest turn,
    never dispatches Staff directly, and never waits while holding a DB lock.
    """
    transport = _gateway.get()
    if transport is None or not isinstance(result, dict) or result.get('failed'):
        return result
    text = result.get('final_response')
    ticket = prepare(transport.cap.binding, text)
    if ticket is None:
        return result
    future = asyncio.run_coroutine_threadsafe(transport.send(ticket, text), transport.loop)
    try:
        sent = future.result(timeout=90)
    except Exception:
        future.cancel()
        logger.exception('checked_quote_send_not_acknowledged')
        sent = False
    output = dict(result, already_sent=True)
    if not sent and transport.failure_reason and transport.live():
        from .explicit_human_handoff import _load_flag_needs_human
        flag = _load_flag_needs_human()
        language = _state_call(ticket.binding, lambda state: state.get('guest_language'))
        token = _handoff_notice.set(True)
        try:
            raw = flag({'reason': 'business_tool_error: ' + transport.failure_reason,
                        'language': language}) if flag else None
            handoff = json.loads(raw) if isinstance(raw, str) else raw
            output['quote_send_handoff'] = handoff
            if not isinstance(handoff, dict) or handoff.get('needs_human') is not True:
                logger.error('quote_send_handoff_not_persisted')
        finally:
            _handoff_notice.reset(token)
    if not sent or not transport.live() or not claim_continuation(ticket):
        return output
    # These are internal transport facts, not guest consent. Original ingress,
    # quote scope and epoch remain untouched while the ordinary model/tool loop
    # finishes its earlier, deferred create request.
    call = inspect.signature(original).bind(*args, **kwargs)
    call.arguments['user_message'] = (
        '[Internal transport continuation; not a guest message.] '
        'The exact checked priced reply was successfully sent through WhatsApp. '
        'Finish the booking you already attempted, using the existing guest request '
        'and unchanged checked terms. Call create_booking_from_plan now, then send '
        'the receipt-backed confirmation and links. Do not ask shall I book, do not '
        'wait for another guest reply, and do not invent or reconfirm consent.')
    call.arguments['conversation_history'] = result.get('messages') or []
    if 'persist_user_message' in call.arguments:
        call.arguments['persist_user_message'] = None
    token = _internal.set(True)
    try:
        resumed = original(*call.args, **call.kwargs)
    finally:
        _internal.reset(token)
    # Preserve the first pass's transcript offset: the guest, price, resumed
    # tools and confirmation belong to one inbound event, not a new user turn.
    if isinstance(resumed, dict) and 'history_offset' in result:
        resumed['history_offset'] = result['history_offset']
    from . import accepted_quote as owner
    projection = resumed.get('booking_result') if isinstance(resumed, dict) else None
    if not isinstance(projection, dict) or projection.get('success') is not True:
        projection = None
    finalized = owner.finalize_offer_response(
        resumed, lambda facts, draft: owner._rewrite_saved_confirmation(agent, facts, draft),
        projection, owner._quote_rewrite_callback(agent))
    # A fresh Staff recheck can replace the quoted terms during continuation.
    # Never let that new reply fall through to the ordinary ungated final send:
    # prepare/ack/claim must bind the revised presentation before another create.
    # The owner's create-attempt budget bounds the repricing allowance.
    return finish_turn(agent, finalized, original, args, kwargs)


@dataclass(frozen=True)
class SendTicket:
    binding: tuple
    epoch: int
    digest: str


def _state_call(binding, fn, *, write=False):
    # This boundary deliberately outlives the model turn, but not its session,
    # incarnation or ingress. Binding comes only from the installed gateway.
    from . import accepted_quote as owner
    db, scope, incarnation = binding
    identity = {key: value for key, value in scope.items() if key != 'MESSAGE_ID'}
    key = owner._PREFIX + hashlib.sha256(owner._encode(identity).encode()).hexdigest()

    def work(conn):
        row = conn.execute('SELECT started_at, ended_at FROM sessions WHERE id=?',
                           (scope['ID'],)).fetchone()
        stored = conn.execute('SELECT value FROM state_meta WHERE key=?', (key,)).fetchone()
        if not row or row[0] != incarnation or row[1] is not None or not stored:
            return None
        state = json.loads(stored[0])
        if (state.get('scope') != identity or state.get('incarnation') != incarnation
                or state.get('version') != 1
                or (state.get('current_turn') or {}).get('message_id') != scope['MESSAGE_ID']):
            return None
        result = fn(state)
        if write:
            conn.execute('UPDATE state_meta SET value=? WHERE key=?', (owner._encode(state), key))
        return result

    if write:
        return db._execute_write(work)
    with db._lock:
        return work(db._conn)


def prepare(binding, text):
    from . import accepted_quote as owner
    if not binding or binding[1].get('PLATFORM') not in ('whatsapp', 'whatsapp_cloud'):
        return None

    def read(state):
        p = state.get('presentation')
        if (not owner._presentation_has_priced_terms(p) or has_send_ack(p)
                or p.get('displayed_text') != text
                or p.get('original_turn') != binding[1]['MESSAGE_ID']
                or state.get('receipt') or state.get('dispatch_pending')):
            return None
        return SendTicket((binding[0], deepcopy(binding[1]), binding[2]),
                          state['epoch'], _presentation_digest(p))
    return _state_call(binding, read)


def acknowledge(ticket, sent_text, message_id):
    if not isinstance(ticket, SendTicket) or not isinstance(message_id, str) or not message_id.strip():
        return False

    def record(state):
        p = state.get('presentation')
        if (state.get('epoch') != ticket.epoch or not isinstance(p, dict)
                or _presentation_digest(p) != ticket.digest
                or sent_text != p.get('displayed_text')):
            return False
        if has_send_ack(p):
            return p['send_ack']['message_id'] == message_id
        p['send_ack'] = {'message_id': message_id, 'presentation_digest': ticket.digest}
        return True
    return _state_call(ticket.binding, record, write=True) is True


def claim_continuation(ticket):
    if not isinstance(ticket, SendTicket):
        return False

    def claim(state):
        p = state.get('presentation') or {}
        requested = state.get('post_price_create_requested') or {}
        if (state.get('epoch') != ticket.epoch or not has_send_ack(p)
                or _presentation_digest(p) != ticket.digest
                or requested.get('epoch') != ticket.epoch
                or requested.get('quote_revision') != p.get('quote_revision')
                or state.get('checked_offer') != p.get('quote_revision')
                or p['send_ack'].get('continuation_claimed')
                or state.get('receipt') or state.get('dispatch_pending')):
            return False
        p['send_ack']['continuation_claimed'] = True
        return True
    return _state_call(ticket.binding, claim, write=True) is True


def _presentation_digest(presentation):
    return hashlib.sha256(json.dumps(
        {key: value for key, value in presentation.items() if key != 'send_ack'},
        sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def has_send_ack(presentation):
    if not isinstance(presentation, dict):
        return False
    ack = presentation.get('send_ack')
    return (isinstance(ack, dict) and isinstance(ack.get('message_id'), str)
            and bool(ack['message_id'].strip())
            and ack.get('presentation_digest') == _presentation_digest(presentation))
