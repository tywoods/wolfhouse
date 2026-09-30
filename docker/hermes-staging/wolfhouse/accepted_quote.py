"""Owner-only quote ledger in the bound Hermes SessionDB (never an ambient cache).

No business transport, transcript recovery, ancestry transfer or model consent.
A reset, ended incarnation, unbound ingress or malformed ledger fails closed.
"""
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
import hashlib
import json
import os
import re
import unicodedata
from threading import RLock


class TurnCapability:
    """Shared by copied contexts; closing any owner invalidates all children."""
    def __init__(self, agent, db, scope, incarnation):
        self.binding = (agent, db, scope, incarnation)
        self.lock = RLock()
        self.closed = False
        self.epoch = None
        self.parent = None


class PreparedPlan(dict):
    def __init__(self, params, capability, epoch):
        super().__init__(params)
        self.capability = capability
        self.epoch = epoch


def close_turn():
    capability = _current.get()
    if capability is not None:
        with capability.lock:
            capability.closed = True
    _current.set(None)


# The actual transport reads this ticket, not model parameters.
_dispatch_ticket: ContextVar[PreparedPlan | None] = ContextVar('wolfhouse_quote_dispatch_ticket', default=None)

_PREFIX = 'wolfhouse.accepted_quote.v1:'
_current: ContextVar[TurnCapability | None] = ContextVar('wolfhouse_quote_owner', default=None)
_FIELDS = ('check_in', 'check_out', 'guest_count', 'package_code', 'guest_packages',
           'room_type', 'room_preference', 'gender_preference', 'group_gender',
           'add_ons', 'catalog_selections', 'selected_bed_codes')


class QuoteBoundaryError(ValueError):
    pass


def _encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _scope(agent):
    from gateway import session_context as ingress
    values = {}
    for name in ('PLATFORM', 'SOURCE', 'CHAT_ID', 'THREAD_ID', 'USER_ID', 'KEY', 'ID', 'MESSAGE_ID'):
        value = ingress._VAR_MAP['HERMES_SESSION_' + name].get()
        if value is ingress._UNSET:
            raise QuoteBoundaryError('quote_owner_ingress_unbound')
        values[name] = value
    tenant = os.environ.get('LUNA_CLIENT_SLUG', '').strip()
    if (not tenant or not all(values[name] for name in ('PLATFORM', 'CHAT_ID', 'USER_ID', 'KEY', 'ID', 'MESSAGE_ID'))
            or values['ID'] != getattr(agent, 'session_id', None)):
        raise QuoteBoundaryError('quote_owner_identity_missing')
    from hermes_state import SessionDB
    db = getattr(agent, '_session_db', None)
    if not isinstance(db, SessionDB):
        raise QuoteBoundaryError('quote_owner_sessiondb_missing')
    return db, {**values, 'tenant': tenant}


def _transaction(fn):
    bound = _current.get()
    if bound is None:
        raise QuoteBoundaryError('quote_owner_turn_missing')
    agent, db, scope, incarnation = bound.binding
    if getattr(agent, '_session_db', None) is not db or getattr(agent, 'session_id', None) != scope['ID']:
        raise QuoteBoundaryError('quote_owner_rotated')
    # Revalidate real task-local identity at every tool call, not only the hook.
    current_db, current_scope = _scope(agent)
    if current_db is not db or current_scope != scope:
        raise QuoteBoundaryError('quote_owner_changed')
    def work(conn):
        row = conn.execute('SELECT started_at, ended_at FROM sessions WHERE id=?', (scope['ID'],)).fetchone()
        if row is None or row[0] != incarnation or row[1] is not None:
            raise QuoteBoundaryError('quote_owner_ended')
        identity = {key: value for key, value in scope.items() if key != 'MESSAGE_ID'}
        key = _PREFIX + hashlib.sha256(_encode(identity).encode()).hexdigest()
        found = conn.execute('SELECT value FROM state_meta WHERE key=?', (key,)).fetchone()
        state = None
        if found:
            try:
                state = json.loads(found[0])
                if (not isinstance(state, dict) or state.get('scope') != identity
                        or state.get('incarnation') != incarnation or state.get('version') != 1
                        or state.get('status') not in ('empty', 'offered', 'accepted', 'revision', 'clarify', 'blocked')
                        or not isinstance(state.get('seen'), list)
                        or any(not isinstance(item, str) or not item for item in state['seen'])
                        or len(set(state['seen'])) != len(state['seen'])
                        or (state.get('plan') is not None and not isinstance(state['plan'], dict))
                        or (state.get('status') in ('offered', 'accepted') and
                            (not isinstance(state.get('plan'), dict)
                             or not isinstance(state.get('quote'), dict)
                             or state['quote'].get('success') is not True
                             or type(state['quote'].get('total_cents')) is not int
                             or state['quote']['total_cents'] <= 0))
                        or (state.get('status') == 'accepted' and
                            state.get('acceptance_message') not in state['seen'])):
                    raise ValueError()
            except (ValueError, TypeError):
                raise QuoteBoundaryError('quote_ledger_invalid')
        else:
            state = {'version': 1, 'scope': identity, 'incarnation': incarnation, 'seen': [],
                     'status': 'empty', 'plan': None, 'quote': None}
        epoch = state.setdefault('epoch', 0)
        if type(epoch) is not int or epoch < 0:
            raise QuoteBoundaryError('quote_ledger_invalid')
        if (not isinstance(state.get('delta', {}), dict)
                or set(state.get('delta', {})) - {'catalog_selections', 'add_ons'}
                or type(state.get('unresolved_change', False)) is not bool):
            raise QuoteBoundaryError('quote_ledger_invalid')
        if bound.epoch is not None and bound.epoch != epoch:
            raise QuoteBoundaryError('quote_owner_superseded')
        result = fn(state, scope)
        conn.execute('INSERT OR REPLACE INTO state_meta(key,value) VALUES (?,?)', (key, _encode(state)))
        return result
    with bound.lock:
        if bound.closed or (getattr(bound, 'parent', None) is not None and bound.parent.closed):
            raise QuoteBoundaryError('quote_owner_turn_closed')
        return db._execute_write(work)


def _accepts(raw, plan):
    text = re.sub(r'\s+', ' ', raw.strip().lower()).rstrip('.!')
    if text in ('i accept the quote', 'i accept this quote', 'book this', 'book this quote',
                'create the booking', 'yes, create the booking', 'yes, book this quote'):
        return True
    # Narrow, complete grammar: arbitrary trailing changed picks/date/quantity cannot pass.
    match = re.fullmatch(r'yes, create the booking with the (yoga|drone) session included for both of us', text)
    selections = plan.get('catalog_selections') or []
    return bool(match and len(selections) == 1
                and selections[0].get('service_code') in (match[1], match[1] + '_class')
                and selections[0].get('quantity') == 2
                and plan.get('guest_count', 2) == 2)


def _contact_continuity(raw):
    """Bounded contact-only grammar; never itself grants acceptance."""
    text = unicodedata.normalize('NFC', raw)
    match = re.fullmatch(r'\s*my name is ([^.!?\n\r]+)[.!]?\s*', text, re.I)
    if not match:
        return False
    name = match[1].strip()
    if not 1 <= len(name) <= 100:
        return False
    # At most eight alphabetic components. Separators cannot lead, trail,
    # repeat or introduce punctuation/instructions; marks must follow letters.
    parts = re.split(r"[ '\u2019-]", name)
    if any(part.casefold() in {'and', 'but', 'then', 'please', 'proceed', 'yes',
                              'with', 'booking', 'quote', 'include', 'included'} for part in parts):
        return False
    return (1 <= len(parts) <= 8 and all(
        part and part[0].isalpha() and all(
            char.isalpha() or unicodedata.category(char).startswith('M')
            for char in part) for part in parts))


def observe_owner_turn(agent, raw):
    """Observe owner text; the installed hook supplies only consumed ingress.

    Direct calls are ledger unit-test seams, not runtime ingress authority.
    """
    close_turn()
    db, scope = _scope(agent)
    row = db.get_session(scope['ID'])
    if not row or row.get('ended_at') is not None:
        raise QuoteBoundaryError('quote_owner_ended')
    if not isinstance(raw, str):
        raise QuoteBoundaryError('quote_owner_raw_missing')
    capability = TurnCapability(agent, db, scope, row['started_at'])
    _current.set(capability)
    def observe(state, ingress):
        message = ingress['MESSAGE_ID']
        if message in state['seen']:
            raise QuoteBoundaryError('quote_owner_replayed_message')
        state['seen'].append(message)
        state['epoch'] += 1
        capability.epoch = state['epoch']
        state.setdefault('delta', {})
        state.setdefault('unresolved_change', False)
        # IDs stay durable for the incarnation; do not age out replay protection.
        if re.search(r'\b(no|not now|not yet|stop|postpone|later|unsure|maybe|wait|hold off|do not book|don.t book|cancel)\b', raw, re.I):
            state.update(status='clarify', quote=None)
            state.pop('acceptance_message', None)
        elif re.search(r'\b(change|revise|remove|instead|without|different|add)\b', raw, re.I):
            state.update(status='revision', quote=None)
            state.pop('acceptance_message', None)
            # Only complete named removal grants a supported field delta.
            removal = re.fullmatch(r'\s*remove (?:the )?(yoga|drone)(?: session)?[.!]?\s*', raw, re.I)
            contact = re.fullmatch(r'\s*(?:add|change) my (?:phone number|email|name)[.!]?\s*', raw, re.I)
            reprice = re.fullmatch(r'\s*(?:revise|refresh) (?:the )?quote[.!]?\s*', raw, re.I)
            state['unresolved_change'] = state['unresolved_change'] or not bool(removal or contact or reprice)
            if removal and state.get('plan'):
                code = removal[1].lower()
                for field, code_field in (('catalog_selections', 'service_code'), ('add_ons', 'code')):
                    old = state['delta'].get(field, state['plan'].get(field))
                    if isinstance(old, list):
                        state['delta'][field] = [deepcopy(item) for item in old
                            if item.get(code_field) not in (code, code + '_class')]
        elif state['status'] == 'offered' and state['quote'] and _accepts(raw, state['plan']):
            state.update(status='accepted', acceptance_message=message)
        elif re.search(r'\b(create|book|accept)\b', raw, re.I) or re.search(r'\d', raw):
            # Changed or unsupported booking acceptance needs a fresh quote, never
            # silently falls back to the former quote (including accepted state).
            state.update(status='clarify', quote=None)
        elif state['status'] == 'accepted' and not (
                re.fullmatch(r'\s*(?:thanks|thank you|ok|okay|please proceed)[.!]?\s*', raw, re.I)
                or _contact_continuity(raw)):
            # Unknown new intent is not fresh create authority. Only deliberately
            # narrow neutral/contact continuity survives; clarify everything else.
            state.update(status='clarify', quote=None)
            state.pop('acceptance_message', None)
    try:
        return _transaction(observe)
    except Exception:
        close_turn()
        raise


def prepare_quote(params):
    def prepare(state, ingress):
        if state.get('unresolved_change'):
            raise QuoteBoundaryError('quote_revision_needs_clarification')
        result = deepcopy(params)
        old = state.get('plan')
        if old:
            for key in _FIELDS:
                if key not in old:
                    if key in result:
                        raise QuoteBoundaryError('quote_revision_requires_owner')
                    continue
                expected = state.get('delta', {}).get(key, old[key])
                if key in result and result[key] != expected:
                    raise QuoteBoundaryError('quote_revision_requires_owner')
                result.setdefault(key, deepcopy(expected))
        return PreparedPlan(result, _current.get(), state['epoch'])
    return _transaction(prepare)


def record_quote(params, response):
    prepared = params if isinstance(params, PreparedPlan) else prepare_quote(params)
    def record(state, ingress):
        if prepared.capability is not _current.get() or prepared.epoch != state['epoch']:
            raise QuoteBoundaryError('quote_response_superseded')
        plan = {key: deepcopy(prepared[key]) for key in _FIELDS if key in prepared}
        total = response.get('total_cents')
        valid = response.get('success') is True and type(total) is int and total > 0
        state.update(plan=plan, quote=deepcopy(response) if valid else None,
                     status='offered' if valid else 'blocked', offer_message=ingress['MESSAGE_ID'])
        state.pop('acceptance_message', None)
        state['delta'] = {}
        state['epoch'] += 1
        prepared.capability.epoch = state['epoch']
    return _transaction(record)


def prepare_create(params):
    def prepare(state, ingress):
        if state['status'] != 'accepted' or not state.get('quote'):
            raise QuoteBoundaryError('quote_owner_acceptance_required')
        result = deepcopy(params)
        plan = state['plan']
        for key in _FIELDS:
            if key in result and result[key] != plan.get(key):
                raise QuoteBoundaryError('accepted_quote_changed')
            if key in plan:
                result[key] = deepcopy(plan[key])
        # Model-provided totals/quote IDs are not authority and never forwarded.
        for key in ('total_cents', 'quote_total_cents', 'accepted_quote_id'):
            result.pop(key, None)
        # Replay/retry identity is owner-issued, never model-controlled. Keep
        # it stable across restart and omitted identities for this acceptance.
        identity = {key: value for key, value in ingress.items() if key != 'MESSAGE_ID'}
        result['idempotency_key'] = 'luna-owner-' + hashlib.sha256(_encode({
            'scope': identity, 'incarnation': state['incarnation'],
            'offer': state.get('offer_message'), 'acceptance': state['acceptance_message'],
            'plan': plan, 'quote': state['quote'],
        }).encode()).hexdigest()[:32]
        result['confirm'] = True
        return PreparedPlan(result, _current.get(), state['epoch'])
    return _transaction(prepare)


def dispatch_create(prepared, transport):
    """Order actual dispatch against reset/revision on the SQLite writer lock.

    A reset/revision committed first prevents transport. Dispatch locked first
    starts transport before reset/revision can commit. Post-create persistence
    must stay OUTSIDE this critical section. A DB retry cannot repeat transport.
    """
    invoked = False
    def dispatch(state, ingress):
        nonlocal invoked
        if (not isinstance(prepared, PreparedPlan) or prepared.capability is not _current.get()
                or prepared.epoch != state['epoch'] or state['status'] != 'accepted'
                or not state.get('quote')):
            raise QuoteBoundaryError('quote_dispatch_superseded')
        if invoked:
            raise QuoteBoundaryError('quote_dispatch_not_repeatable')
        invoked = True
        return transport()
    return _transaction(dispatch)


def install_owner_hook():
    from agent import conversation_loop
    original = conversation_loop.run_conversation
    if getattr(original, '_wolfhouse_quote_owner', False):
        return
    @wraps(original)
    def owned(agent, user_message, *args, **kwargs):
        close_turn()
        try:
            from .original_inbound import consume
            try:
                inbound = consume(agent)
                with inbound.lock:
                    observe_owner_turn(agent, inbound.text)
                    capability = _current.get()
                    capability.parent = inbound
                    capability.lock = inbound.lock
            except QuoteBoundaryError:
                # Unsupported/unbound ingress retains ordinary conversation,
                # but no ledger authority, including ambient fixture bindings.
                close_turn()
            return original(agent, user_message, *args, **kwargs)
        finally:
            # An owner capability belongs to one entrypoint turn only. Restoring
            # a stale ambient binding would authorize tools after this turn exits.
            close_turn()
    owned._wolfhouse_quote_owner = True
    conversation_loop.run_conversation = owned
