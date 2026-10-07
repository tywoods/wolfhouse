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
           'add_ons', 'catalog_selections', 'selected_bed_codes', 'email')
_CHECKED_FIELDS = ('guests', 'room_name_hints', 'payment_choice', 'per_guest_payment_links')
_registered_create = None
_before_create = None


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
        raw_digest = hashlib.sha256(raw.encode()).hexdigest()
        recovering = (state['status'] == 'accepted' and state.get('checked_offer')
                      and state.get('auto_acceptance') is True
                      and (state.get('dispatch_pending') or state.get('receipt'))
                      and message == state.get('acceptance_message')
                      and raw_digest == state.get('acceptance_raw_digest'))
        if message in state['seen'] and not recovering:
            raise QuoteBoundaryError('quote_owner_replayed_message')
        if message not in state['seen']:
            state['seen'].append(message)
        state['epoch'] += 1
        capability.epoch = state['epoch']
        if recovering:
            # Same original consent may recover ONLY its frozen operation/key;
            # it never creates fresh authority or revives a reset/revised quote.
            return
        state.setdefault('delta', {})
        state.setdefault('unresolved_change', False)
        presented = state.pop('presented_offer', None)
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
        elif state['status'] == 'offered' and state['quote'] and (
                _accepts(raw, state['plan']) or (presented and state.get('checked_offer')
                    and presented == state['checked_offer']
                    and re.fullmatch(r'\s*yes[.!]?\s*', raw, re.I))):
            state.update(status='accepted', acceptance_message=message, acceptance_raw_digest=raw_digest)
            state['auto_acceptance'] = bool(presented and presented == state.get('checked_offer'))
        elif re.search(r'\b(create|book|accept)\b', raw, re.I) or re.search(r'\d', raw):
            # Changed or unsupported booking acceptance needs a fresh quote, never
            # silently falls back to the former quote (including accepted state).
            state.update(status='clarify', quote=None)
        elif state['status'] == 'accepted' and not (
                re.fullmatch(r'\s*(?:thanks|thank you|ok|okay|please proceed)[.!]?\s*', raw, re.I)
                or (state.get('auto_acceptance') is True and state.get('checked_offer')
                    and re.fullmatch(r'\s*yes[.!]?\s*', raw, re.I))
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
            for key in _FIELDS + (_CHECKED_FIELDS if state.get('checked_offer') else ()):
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


def _checked_plan(prepared, response, tenant):
    """Freeze Staff's revision, not any model-supplied offer/bed authority."""
    offer = response.get('offer_revision')
    availability = response.get('availability')
    if (not isinstance(offer, dict) or not isinstance(availability, dict)
            or response.get('success') is not True or response.get('payment_choice_needed')
            or response.get('missing_fields') or response.get('staff_review_needed')
            or offer.get('availability_checked') is not True
            or availability.get('status') != 'checked'
            or not offer.get('offer_fingerprint') or offer.get('client_slug') != tenant
            or any(not isinstance(offer.get(key), str) or not offer[key].strip()
                   for key in ('check_in', 'check_out', 'currency', 'room_type', 'package_code'))
            or offer.get('payment_choice') not in ('full', 'deposit', 'pay_on_arrival', 'per_guest')
            or not prepared.get('payment_choice')
            or any(type(offer.get(key)) is not int or offer[key] < 0 for key in
                   ('total_cents', 'deposit_required_cents', 'payment_link_amount_cents'))
            or offer.get('total_cents') != response.get('total_cents')):
        return None
    assignments = offer.get('guest_bed_assignments')
    count = offer.get('guest_count')
    if (type(count) is not int or count < 1 or not isinstance(assignments, list)
            or len(assignments) != count or any(
                not isinstance(row, dict) or row.get('guest_index') != index
                or not row.get('guest_name') or not row.get('bed_code')
                for index, row in enumerate(assignments))):
        return None
    codes = [row['bed_code'] for row in assignments]
    rooms = offer.get('room_arrangement')
    if (any(not isinstance(code, str) or not code.strip() for code in codes)
            or len(set(codes)) != count or availability.get('selected_bed_codes') != codes
            or not isinstance(rooms, list) or len(rooms) != count
            or any(not isinstance(row, dict) or not row.get('room_code')
                   or not row.get('gender_strategy') for row in rooms)
            or sorted(row.get('bed_code', '') for row in rooms) != sorted(codes)):
        return None
    plan = {key: deepcopy(prepared[key]) for key in _FIELDS if key in prepared}
    for key in _FIELDS + _CHECKED_FIELDS:
        if key in offer:
            plan[key] = deepcopy(offer[key])
    # Staff's offer normalizer fingerprints code/quantity, while the checked
    # request can also carry rental days. Preserve the actual quoted request
    # when its normalized projection matches, rather than dropping duration.
    extras = prepared.get('add_ons')
    if isinstance(extras, list):
        normalized = []
        for item in extras:
            if isinstance(item, str):
                normalized.append({'code': item.strip(), 'quantity': 1})
            elif isinstance(item, dict):
                normalized.append({'code': str(item.get('code') or item.get('item_code') or '').strip(),
                                   'quantity': item.get('quantity') or 1})
            else:
                return None
        if normalized != offer.get('add_ons'):
            return None
        plan['add_ons'] = deepcopy(extras)
    plan['guests'] = [{'name': row['guest_name']} for row in assignments]
    # Staff fingerprints normalized names; keep guest spelling only when the
    # complete ordered roster matches those authoritative identities.
    guests = prepared.get('guests')
    if (isinstance(guests, list) and len(guests) == count and all(
            isinstance(guest, dict) and isinstance(guest.get('name'), str)
            and guest['name'].strip().lower() == row['guest_name']
            for guest, row in zip(guests, assignments))):
        plan['guests'] = deepcopy(guests)
    plan['selected_bed_codes'] = [row['bed_code'] for row in assignments]
    if 'room_name_hints' in prepared:
        plan['room_name_hints'] = deepcopy(prepared['room_name_hints'])
    return plan


def record_quote(params, response):
    prepared = params if isinstance(params, PreparedPlan) else prepare_quote(params)
    def record(state, ingress):
        if prepared.capability is not _current.get() or prepared.epoch != state['epoch']:
            raise QuoteBoundaryError('quote_response_superseded')
        plan = {key: deepcopy(prepared[key]) for key in _FIELDS if key in prepared}
        checked = _checked_plan(prepared, response, ingress['tenant'])
        if checked is not None:
            plan = checked
        previous_checked = state.get('checked_offer')
        total = response.get('total_cents')
        valid = response.get('success') is True and type(total) is int and total > 0
        if previous_checked or response.get('offer_revision'):
            valid = valid and checked is not None
        if (valid and checked is not None and state['status'] == 'accepted'
                and previous_checked == response['offer_revision'] and state['plan'] == plan):
            # Cosmetic revalidation metadata must not mint a new operation or
            # erase consent. Keep the original snapshot, receipt and key inputs.
            return
        state['checked_offer'] = deepcopy(response['offer_revision']) if checked is not None else None
        state.pop('presented_offer', None)
        state.pop('receipt', None)
        state.pop('completion', None)
        state.pop('dispatch_pending', None)
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
        for key in _FIELDS + (_CHECKED_FIELDS if state.get('checked_offer') else ()):
            if key in result and result[key] != plan.get(key):
                raise QuoteBoundaryError('accepted_quote_changed')
            if key in plan:
                result[key] = deepcopy(plan[key])
        # Model-provided totals/quote IDs are not authority and never forwarded.
        for key in ('total_cents', 'quote_total_cents', 'accepted_quote_id',
                    'accepted_offer', 'require_offer_identity', 'offer_revision', 'availability'):
            result.pop(key, None)
        if state.get('checked_offer'):
            result['accepted_offer'] = deepcopy(state['checked_offer'])
            result['require_offer_identity'] = True
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


def _validate_dispatch_ticket(prepared, state):
    if (not isinstance(prepared, PreparedPlan) or prepared.capability is not _current.get()
            or prepared.epoch != state['epoch'] or state['status'] != 'accepted'
            or not state.get('quote')):
        raise QuoteBoundaryError('quote_dispatch_superseded')


def dispatch_recovery(prepared):
    """Owner-only receipt/recovery state, never a model-supplied retry boolean."""
    def inspect(state, ingress):
        _validate_dispatch_ticket(prepared, state)
        return {'receipt': deepcopy(state.get('completion') or state.get('receipt')),
                'pending': bool(state.get('checked_offer') and state.get('dispatch_pending'))}
    return _transaction(inspect)


def record_create_completion(prepared, response):
    """Retain the completed adapter result, including already-created links."""
    def complete(state, ingress):
        _validate_dispatch_ticket(prepared, state)
        receipt = state.get('receipt')
        if not receipt or not isinstance(response, dict) or response.get('success') is not True:
            return
        if any(receipt.get(key) is not None and response.get(key) != receipt[key]
               for key in ('booking_id', 'booking_code', 'payment_id')):
            raise QuoteBoundaryError('create_completion_identity_mismatch')
        state['completion'] = deepcopy(response)
    _transaction(complete)


def _revoke_checked_offer(state):
    state.update(status='clarify', quote=None, checked_offer=None)
    for key in ('presented_offer', 'auto_acceptance', 'dispatch_pending',
                'acceptance_message', 'acceptance_raw_digest'):
        state.pop(key, None)


def reject_checked_offer(prepared):
    """A definitive pre-write refusal requires a fresh offer/consent, not retry."""
    def reject(state, ingress):
        _validate_dispatch_ticket(prepared, state)
        if state.get('checked_offer') and not state.get('receipt'):
            _revoke_checked_offer(state)
    _transaction(reject)


def dispatch_create(prepared, transport):
    """Order actual dispatch against reset/revision on the SQLite writer lock.

    Persist pending separately before transport: a process death after Staff's
    commit must not roll back the only evidence needed for idempotent recovery.
    Ticket validation repeats under the dispatch lock, so reset/revision winning
    between those transactions still prevents transport. No new journal/schema.
    """
    def mark_pending(state, ingress):
        _validate_dispatch_ticket(prepared, state)
        state['dispatch_pending'] = True
    _transaction(mark_pending)
    invoked = False
    def dispatch(state, ingress):
        nonlocal invoked
        _validate_dispatch_ticket(prepared, state)
        if state.get('receipt'):
            return deepcopy(state['receipt'])
        if invoked:
            raise QuoteBoundaryError('quote_dispatch_not_repeatable')
        invoked = True
        response = transport()
        if (isinstance(response, dict) and response.get('success') is True
                and (response.get('booking_id') or response.get('booking_code'))):
            state['receipt'] = deepcopy(response)
        elif (isinstance(response, dict) and state.get('checked_offer')
              and response.get('booking_create_refused') is True):
            _revoke_checked_offer(state)
        return response
    return _transaction(dispatch)


def finalize_offer_response(result):
    """Own the actual returned question; quote tool success is not presentation."""
    if (not isinstance(result, dict) or result.get('completed') is not True
            or result.get('failed') or result.get('interrupted') or result.get('error')):
        return result
    def present(state, ingress):
        offer = state.get('checked_offer')
        if (state['status'] != 'offered' or not offer or not state.get('quote')
                or state.get('offer_message') != ingress['MESSAGE_ID']):
            return result
        def money(cents):
            return f"{cents // 100}.{cents % 100:02d} {offer['currency']}"
        plan = state['plan']
        lines = [f"{offer['check_in']} to {offer['check_out']} — {offer['guest_count']} guests."]
        rooms = {row['bed_code']: row for row in offer['room_arrangement']}
        def label(code):
            if code in ('package_none', 'none', 'accommodation_only', 'no_package'):
                return 'Accommodation only'
            return str(code).removeprefix('package_').replace('_', ' ').capitalize()
        room_labels = {'female_only': "women's room", 'male_only': "men's room",
                       'mixed': 'mixed room', 'flexible': 'shared room'}
        for guest, code in zip(plan['guests'], plan['selected_bed_codes']):
            room = rooms[code]
            kind = ('private room' if offer['room_type'] == 'private' else
                    room_labels.get(room['gender_strategy'], 'room'))
            lines.append(f"{guest['name']}: bed {code}, {kind} {room['room_code']}.")
        lines.append(label(offer['package_code']) + '.')
        for item in offer['guest_packages']:
            number = item.get('guest_number')
            who = (plan['guests'][number - 1]['name'] if type(number) is int
                   and 1 <= number <= len(plan['guests']) else f'Guest {number}')
            lines.append(f"{who}: {label(item['package_code'])}.")
        if offer['add_ons']:
            extras = []
            for index, item in enumerate(offer['add_ons']):
                accepted = plan['add_ons'][index]
                duration = accepted.get('days') if isinstance(accepted, dict) else None
                text = f"{label(item['code'])} × {item['quantity']}"
                if duration is not None:
                    text += f" for {duration} days"
                extras.append(text)
            lines.append('Extras: ' + '; '.join(extras) + '.')
        lines.append(f"Total: {money(offer['total_cents'])}.")
        payment = {'full': 'Full payment', 'deposit': 'Deposit',
                   'pay_on_arrival': 'Payment on arrival', 'per_guest': 'Individual payments'}
        lines.append(f"{payment[offer['payment_choice']]}: {money(offer['payment_link_amount_cents'])}.")
        if offer['per_guest_payment_links']:
            lines.extend(f"{item['guest_name']}: {money(item['amount_cents'])}."
                         for item in offer['payment_distribution'])
        lines.append('Availability checked, subject to confirmation when booking.')
        lines.append('Shall I create this booking?')
        text = '\n'.join(lines)
        output = deepcopy(result)
        output['final_response'] = text
        messages = output.get('messages')
        if isinstance(messages, list) and messages and messages[-1].get('role') == 'assistant':
            messages[-1]['content'] = text
        state['presented_offer'] = deepcopy(offer)
        return output
    return _transaction(present)


def install_owner_hook(create_handler=None, before_create=None):
    global _registered_create, _before_create
    if create_handler is not None:
        _registered_create, _before_create = create_handler, before_create
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
            if _current.get() is not None and _registered_create is not None:
                automatic = _transaction(lambda state, ingress: (
                    ingress['tenant'] == 'wolfhouse-somo' and state['status'] == 'accepted'
                    and bool(state.get('checked_offer')) and state.get('auto_acceptance') is True))
                if automatic:
                    if _before_create is not None:
                        _before_create(session_id=agent.session_id)
                    receipt = json.loads(_registered_create(dict(prepare_create({}))))
                    if receipt.get('success') is True and (receipt.get('booking_code') or receipt.get('booking_id')):
                        reference = receipt.get('booking_code') or receipt['booking_id']
                        text = f"Booking {reference} saved. Payment is not confirmed."
                        if receipt.get('secure_payment_url'):
                            text += '\n' + receipt['secure_payment_url']
                        for link in receipt.get('guest_payment_links') or []:
                            if link.get('secure_payment_url'):
                                text += '\n' + str(link.get('guest_name') or '') + ': ' + link['secure_payment_url']
                    else:
                        text = 'I could not verify that this booking was created. We need to check the accepted setup before proceeding.'
                    history = kwargs.get('conversation_history', args[1] if len(args) > 1 else None) or []
                    return {'completed': True, 'final_response': text, 'api_calls': 0,
                            'messages': [*deepcopy(history), {'role': 'user', 'content': user_message},
                                         {'role': 'assistant', 'content': text}],
                            'booking_result': receipt}
            result = original(agent, user_message, *args, **kwargs)
            if _current.get() is not None:
                return finalize_offer_response(result)
            return result
        finally:
            # An owner capability belongs to one entrypoint turn only. Restoring
            # a stale ambient binding would authorize tools after this turn exits.
            close_turn()
    owned._wolfhouse_quote_owner = True
    conversation_loop.run_conversation = owned
