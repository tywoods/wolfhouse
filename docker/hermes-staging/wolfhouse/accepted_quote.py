"""Owner-only quote ledger in the bound Hermes SessionDB (never an ambient cache).

No business transport, transcript recovery, ancestry transfer or model consent.
A reset, ended incarnation, unbound ingress or malformed ledger fails closed.
"""
from contextvars import ContextVar
from copy import deepcopy
from datetime import date
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
_registered_quote = None
_registered_create = None
_before_create = None
_OWNER_HOOK_TOKEN = object()
_exact_gateway_retry: ContextVar[object | None] = ContextVar(
    'wolfhouse_exact_gateway_retry', default=None)


class _OneShotExactRetry:
    """One claim shared by copied ContextVar executor contexts."""
    def __init__(self, frozen):
        self.frozen = deepcopy(frozen)
        self.lock = RLock()
        self.claimed = False

    def take(self):
        with self.lock:
            if self.claimed:
                return 'spent', None
            self.claimed = True
            return 'claimed', deepcopy(self.frozen)


class QuoteBoundaryError(ValueError):
    pass


_RECOVERY_FIELDS = {
    'session_key', 'session_id', 'identity', 'message_id', 'raw_digest',
    'scope_digest', 'operation_key', 'epoch',
}


def _owner_operation_key(state):
    return 'luna-owner-' + hashlib.sha256(_encode({
        'scope': state['scope'], 'incarnation': state['incarnation'],
        'offer': state.get('offer_message'),
        'acceptance': state['acceptance_message'],
        'plan': state['plan'], 'quote': state['quote'],
    }).encode()).hexdigest()[:32]


def _frozen_recovery(state, *, session_key, session_id, identity, message_id, raw):
    if (not isinstance(state, dict) or type(identity) is not tuple or len(identity) != 3
            or identity[2] != message_id or type(raw) is not str
            or state.get('status') != 'accepted'
            or not isinstance(state.get('scope'), dict)
            or state['scope'].get('ID') != session_id
            or state['scope'].get('KEY') != session_key
            or state['scope'].get('PLATFORM') != identity[0]
            or state['scope'].get('CHAT_ID') != identity[1]
            or not isinstance(state.get('checked_offer'), dict)
            or state.get('auto_acceptance') is not True
            or not (state.get('dispatch_pending') or isinstance(state.get('receipt'), dict))
            or state.get('acceptance_message') != message_id
            or state.get('acceptance_raw_digest') != hashlib.sha256(raw.encode()).hexdigest()
            or type(state.get('epoch')) is not int):
        return None
    try:
        return {
            'session_key': session_key,
            'session_id': session_id,
            'identity': identity,
            'message_id': message_id,
            'raw_digest': hashlib.sha256(raw.encode()).hexdigest(),
            'scope_digest': hashlib.sha256(_encode(state['scope']).encode()).hexdigest(),
            'operation_key': _owner_operation_key(state),
            'epoch': state['epoch'],
        }
    except (KeyError, TypeError, ValueError):
        return None


def recovery_capability_precheck(frozen, state, *, session_key, session_id, identity, raw):
    """Validate the frozen operation before observe_owner_turn can mutate state."""
    if not isinstance(frozen, dict) or set(frozen) != _RECOVERY_FIELDS:
        return False
    current = _frozen_recovery(
        state, session_key=session_key, session_id=session_id, identity=identity,
        message_id=identity[2] if type(identity) is tuple and len(identity) == 3 else None,
        raw=raw)
    return current == frozen


def recovery_capability_matches(frozen, state, *, session_key, session_id, identity, raw):
    if not isinstance(frozen, dict) or set(frozen) != _RECOVERY_FIELDS:
        return False
    current = _frozen_recovery(
        state, session_key=session_key, session_id=session_id, identity=identity,
        message_id=identity[2] if type(identity) is tuple and len(identity) == 3 else None,
        raw=raw)
    if current is None or current.get('epoch') != frozen.get('epoch') + 1:
        return False
    return {key: value for key, value in current.items() if key != 'epoch'} == {
        key: value for key, value in frozen.items() if key != 'epoch'
    }


def _arm_exact_gateway_retry_for_owner(frozen):
    """Arm one internal frozen recovery; request fields cannot construct it."""
    if (not isinstance(frozen, dict) or set(frozen) != _RECOVERY_FIELDS
            or type(frozen.get('epoch')) is not int
            or any(type(frozen.get(key)) is not str or not frozen.get(key) for key in (
                'session_key', 'session_id', 'message_id', 'raw_digest',
                'scope_digest', 'operation_key'))
            or type(frozen['identity']) is not tuple or len(frozen['identity']) != 3
            or frozen['identity'][2] != frozen['message_id']):
        return False
    _exact_gateway_retry.set(_OneShotExactRetry(frozen))
    return True


def _consume_exact_gateway_retry():
    capability = _exact_gateway_retry.get()
    _exact_gateway_retry.set(None)
    if not isinstance(capability, _OneShotExactRetry):
        return 'absent', None
    return capability.take()


def exact_gateway_recovery_capability(*, runner, session_key, identity, message_id, raw):
    """Return one ledger-proven frozen operation capability, else None."""
    if (type(identity) is not tuple or len(identity) != 3
            or identity[2] != message_id or type(raw) is not str):
        return None
    store = getattr(runner, 'session_store', None)
    entry = getattr(store, '_entries', {}).get(session_key) if store is not None else None
    session_id = getattr(entry, 'session_id', None)
    db = getattr(runner, '_session_db', None)
    if not session_id or db is None or not hasattr(db, '_lock') or not hasattr(db, '_conn'):
        return None
    try:
        with db._lock:
            rows = db._conn.execute(
                'SELECT value FROM state_meta WHERE key LIKE ?', (_PREFIX + '%',)
            ).fetchall()
        matches = []
        for row in rows:
            state = json.loads(row[0])
            frozen = _frozen_recovery(
                state, session_key=session_key, session_id=session_id,
                identity=identity, message_id=message_id, raw=raw)
            if frozen is not None:
                matches.append(frozen)
        return matches[0] if len(matches) == 1 else None
    except Exception:
        return None


def arm_exact_gateway_retry(*, runner, session_key, identity, message_id, raw):
    frozen = exact_gateway_recovery_capability(
        runner=runner, session_key=session_key, identity=identity,
        message_id=message_id, raw=raw)
    return frozen is not None and _arm_exact_gateway_retry_for_owner(frozen)


def supports_exact_gateway_retry(*, runner, session_key, identity, message_id, raw):
    return exact_gateway_recovery_capability(
        runner=runner, session_key=session_key, identity=identity,
        message_id=message_id, raw=raw) is not None


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


def _prevalidate_exact_gateway_retry(agent, frozen, raw):
    """Read-only validation before owner observation can alter any authorization."""
    try:
        db, scope = _scope(agent)
        identity_scope = {key: value for key, value in scope.items() if key != 'MESSAGE_ID'}
        key = _PREFIX + hashlib.sha256(_encode(identity_scope).encode()).hexdigest()
        with db._lock:
            session = db._conn.execute(
                'SELECT started_at, ended_at FROM sessions WHERE id=?', (scope['ID'],)
            ).fetchone()
            found = db._conn.execute(
                'SELECT value FROM state_meta WHERE key=?', (key,)
            ).fetchone()
        if session is None or session[1] is not None or found is None:
            return False
        state = json.loads(found[0])
        if state.get('incarnation') != session[0] or state.get('scope') != identity_scope:
            return False
        return recovery_capability_precheck(
            frozen, state, session_key=scope['KEY'], session_id=scope['ID'],
            identity=(scope['PLATFORM'], scope['CHAT_ID'], scope['MESSAGE_ID']), raw=raw)
    except Exception:
        return False


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
                or type(state.get('unresolved_change', False)) is not bool
                or not isinstance(state.get('authorized_revision_changes', []), list)
                or any(not isinstance(change, dict) or change.get('field') not in _FIELDS
                       for change in state.get('authorized_revision_changes', []))):
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


def _plain_stay_date(value):
    """Guest date only. Invalid values stay unchanged; never invent a date."""
    text = str(value or '').strip()
    match = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', text)
    if not match:
        return text
    try:
        day = date(int(match[1]), int(match[2]), int(match[3]))
    except ValueError:
        return text
    weekdays = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
    months = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')
    return f'{weekdays[day.weekday()]} {day.day} {months[day.month - 1]}'


def _guest_count_label(count):
    return '1 guest' if count == 1 else f'{count} guests'


def _join_names(names):
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f'{names[0]} and {names[1]}'
    return ', '.join(names[:-1]) + f', and {names[-1]}'


def _count_word(count):
    words = ('two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten')
    return words[count - 2] if 2 <= count <= 10 else str(count)


def _room_kind(offer, room):
    if offer.get('room_type') == 'private':
        return 'private room'
    labels = {'female_only': "women's room", 'male_only': "men's room",
              'mixed': 'mixed room', 'flexible': 'shared room'}
    return labels.get(room.get('gender_strategy'), 'room')


def _guest_room_lines(plan, offer):
    """Group people by frozen room without showing bed or room codes."""
    rooms = {row['bed_code']: row for row in offer['room_arrangement']}
    groups = []
    index = {}
    for guest, code in zip(plan['guests'], plan['selected_bed_codes']):
        room = rooms[code]
        kind = _room_kind(offer, room)
        key = (room.get('room_code'), kind)
        if key not in index:
            index[key] = len(groups)
            groups.append({'kind': kind, 'names': []})
        groups[index[key]]['names'].append(guest['name'])
    by_kind = {}
    for group in groups:
        by_kind.setdefault(group['kind'], []).append(group)
    lines = []
    emitted = set()
    for group in groups:
        kind = group['kind']
        if kind in emitted:
            continue
        same = by_kind[kind]
        emitted.add(kind)
        if len(same) > 1 and all(len(item['names']) == 1 for item in same):
            names = [name for item in same for name in item['names']]
            lines.append(f"{_join_names(names)}: beds in {_count_word(len(same))} separate {kind}s.")
            continue
        first = True
        for item in same:
            who = _join_names(item['names'])
            beds = len(item['names'])
            if len(same) == 1 and beds == 1:
                lines.append(f"{who}: a bed in the {kind}.")
            elif len(same) == 1:
                lines.append(f"{who}: {_count_word(beds)} beds in the same {kind}.")
            elif beds == 1:
                where = f"the {kind}" if first else f"a separate {kind}"
                lines.append(f"{who}: a bed in {where}.")
            else:
                where = f"the same {kind}" if first else f"a separate {kind}"
                lines.append(f"{who}: {_count_word(beds)} beds in {where}.")
            first = False
    return lines
def _evidence_in_current_turn(raw, evidence):
    """Require interpreter evidence to be literal current-ingress text."""
    if not isinstance(raw, str) or not isinstance(evidence, str):
        return False
    evidence = unicodedata.normalize('NFC', evidence).strip()
    current = unicodedata.normalize('NFC', raw)
    return bool(evidence) and evidence in current


def _action_evidence_is_current_turn(raw, evidence):
    """Bind action semantics to the complete current ingress, not a cherry-picked span."""
    if not isinstance(raw, str) or not isinstance(evidence, str):
        return False
    return unicodedata.normalize('NFC', evidence).strip() == unicodedata.normalize('NFC', raw).strip()


_LIST_REVISION_KEYS = {
    'guest_packages': ('guest_index', 'package_code'),
    'add_ons': ('code',),
    'catalog_selections': None,
}


def _revision_identity_keys(field, item):
    if field != 'catalog_selections':
        keys = _LIST_REVISION_KEYS.get(field)
        return keys if keys and all(key in item for key in keys) else None
    present = [key for key in ('service_id', 'service_code') if key in item]
    return (present[0],) if len(present) == 1 else None


_NUMBER_WORDS = {
    0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
    6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
}
_GENERIC_ITEM_TOKENS = {'class', 'clas', 'service', 'package'}


def _evidence_tokens(value):
    tokens = re.findall(r'[a-z0-9]+', unicodedata.normalize('NFKC', value).casefold())
    return [token[:-1] if token.endswith('s') and len(token) > 3 else token
            for token in tokens]


def _scalar_is_evidenced(value, evidence):
    if not isinstance(evidence, str):
        return False
    if type(value) is int:
        present = set(_evidence_tokens(evidence))
        return str(value) in present or _NUMBER_WORDS.get(value) in present
    if not isinstance(value, str) or not value.strip():
        return False
    return bool(re.search(r'(?<!\w)' + re.escape(value.strip()) + r'(?!\w)',
                          evidence, re.IGNORECASE))


def _item_value_is_evidenced(value, evidence):
    if type(value) is int:
        present = set(_evidence_tokens(evidence))
        return str(value) in present or _NUMBER_WORDS.get(value) in present
    if not isinstance(value, str):
        return False
    wanted = [token for token in _evidence_tokens(value)
              if token not in _GENERIC_ITEM_TOKENS]
    present = set(_evidence_tokens(evidence))
    return bool(wanted) and all(token in present for token in wanted)


def _item_is_evidenced(item, evidence, state):
    guests = _presentation_plan(state).get('guests') if isinstance(state, dict) else None
    for key, value in item.items():
        if key == 'guest_index':
            if type(value) is not int or not isinstance(guests, list) or not 0 <= value < len(guests):
                return False
            name = guests[value].get('name') if isinstance(guests[value], dict) else None
            first_person = value == 0 and bool(re.search(r'\b(i|me|my)\b', evidence, re.I))
            if not first_person and (not isinstance(name, str) or not _scalar_is_evidenced(name, evidence)):
                return False
        elif not _item_value_is_evidenced(value, evidence):
            return False
    return bool(item)


def _validated_material_changes(raw, changes, state=None):
    """Return exact guest-evidenced scalar targets or ordered narrow list operations."""
    if not isinstance(changes, list):
        return None
    normalized = []
    scalar_seen = set()
    list_seen = set()
    for change in changes:
        if not isinstance(change, dict):
            return None
        field = change.get('field')
        evidence = change.get('evidence')
        if field not in _FIELDS or not _evidence_in_current_turn(raw, evidence):
            return None
        if field in _LIST_REVISION_KEYS:
            if (set(change) != {'field', 'operation', 'item', 'evidence'}
                    or change.get('operation') not in ('add', 'remove')
                    or not isinstance(change.get('item'), dict) or not change['item']):
                return None
            identity_keys = _revision_identity_keys(field, change['item'])
            if identity_keys is None:
                return None
            if change['operation'] == 'remove' and set(change['item']) != set(identity_keys):
                return None
            if not _item_is_evidenced(change['item'], evidence, state):
                return None
            marker = (field, tuple(change['item'][key] for key in identity_keys))
            if marker in list_seen:
                return None
            list_seen.add(marker)
        else:
            if (field in scalar_seen or field == 'selected_bed_codes'
                    or set(change) != {'field', 'value', 'evidence'}
                    or isinstance(change.get('value'), (dict, list))
                    or not _scalar_is_evidenced(change.get('value'), evidence)):
                return None
            scalar_seen.add(field)
        normalized.append(deepcopy(change))
    return normalized


def _apply_list_revision(current, change):
    if not isinstance(current, list):
        return None
    item = change['item']
    identity_keys = _revision_identity_keys(change['field'], item)
    if identity_keys is None:
        return None
    def same(candidate):
        return isinstance(candidate, dict) and all(candidate.get(key) == item.get(key)
                                                   for key in identity_keys)
    matches = [index for index, candidate in enumerate(current) if same(candidate)]
    if change['operation'] == 'remove':
        if len(matches) != 1:
            return None
        return [deepcopy(candidate) for index, candidate in enumerate(current)
                if index != matches[0]]
    if matches:
        return None
    return deepcopy(current) + [deepcopy(item)]


def _presentation_plan(state):
    plan = deepcopy(state.get('plan') or {})
    plan.update(deepcopy(state.get('completion_plan') or {}))
    return plan


def _presentation_matches_completion_state(state, presentation):
    """Pending evidenced completions do not mutate immutable presented terms."""
    if not isinstance(presentation, dict) or not isinstance(presentation.get('plan'), dict):
        return False
    expected = _presentation_plan(state)
    presented = presentation['plan']
    if state.get('pending_name_completion') or state.get('pending_eligibility_completion'):
        if 'guests' in presented:
            expected['guests'] = deepcopy(presented['guests'])
        else:
            expected.pop('guests', None)
    if state.get('pending_payment_completion'):
        if 'payment_choice' in presented:
            expected['payment_choice'] = presented['payment_choice']
        else:
            expected.pop('payment_choice', None)
    return expected == presented


def _completion_revision_matches(prior, current, *, payment_choice=None,
                                 guest_index=None, guest_name=None,
                                 eligibility_index=None, eligibility_value=None):
    """Compare the complete Staff revision, ignoring only authorized completions."""
    if not isinstance(prior, dict) or not isinstance(current, dict):
        return False
    before, after = deepcopy(prior), deepcopy(current)
    before.pop('offer_fingerprint', None)
    after.pop('offer_fingerprint', None)
    if payment_choice:
        if payment_choice not in ('deposit', 'full'):
            return False
        expected_amount = (after.get('deposit_required_cents')
                           if payment_choice == 'deposit' else after.get('total_cents'))
        if (type(expected_amount) is not int
                or after.get('payment_link_amount_cents') != expected_amount
                or before.get('payment_choice') != 'deposit'
                or before.get('payment_link_amount_cents') != before.get('deposit_required_cents')):
            return False
        before.pop('payment_choice', None)
        after.pop('payment_choice', None)
        before.pop('payment_link_amount_cents', None)
        after.pop('payment_link_amount_cents', None)
    if type(guest_index) is int:
        actual_rows = [item for item in after.get('guest_bed_assignments', [])
                       if isinstance(item, dict) and item.get('guest_index') == guest_index]
        normalize = lambda value: ' '.join(str(value or '').split()).casefold()
        if (len(actual_rows) != 1
                or normalize(actual_rows[0].get('guest_name')) != normalize(guest_name)):
            return False
        for revision in (before, after):
            assignments = revision.get('guest_bed_assignments')
            target_assignment_name = None
            if isinstance(assignments, list):
                for item in assignments:
                    if isinstance(item, dict) and item.get('guest_index') == guest_index:
                        target_assignment_name = normalize(item.get('guest_name'))
                        item['guest_name'] = '<completed-name>'
            hints = revision.get('room_name_hints')
            if isinstance(hints, list) and target_assignment_name:
                matching_hints = [hint for hint in hints
                                  if isinstance(hint, dict)
                                  and normalize(hint.get('name')) == target_assignment_name]
                if len(matching_hints) > 1:
                    return False
                if matching_hints:
                    matching_hints[0]['name'] = '<completed-name>'
    if type(eligibility_index) is int:
        hints = after.get('room_name_hints')
        assignments = after.get('guest_bed_assignments')
        if (not isinstance(hints, list) or not isinstance(assignments, list)
                or eligibility_index >= len(assignments)):
            return False
        target_name = str(assignments[eligibility_index].get('guest_name', '')).strip().casefold()
        matches = [index for index, hint in enumerate(hints)
                   if isinstance(hint, dict)
                   and set(hint) == {'name', 'explicit_gender'}
                   and str(hint.get('name', '')).strip().casefold() == target_name
                   and hint.get('explicit_gender') == eligibility_value]
        prior_hints = before.get('room_name_hints') or []
        remaining = [hint for index, hint in enumerate(hints) if index not in matches]
        if (len(matches) != 1 or not isinstance(prior_hints, list)
                or remaining != prior_hints):
            return False
        before.pop('room_name_hints', None)
        after.pop('room_name_hints', None)
    return before == after


def interpret_owner_turn(interpretation):
    """Adjudicate one model interpretation against the owner-held presentation.

    The conversation model may interpret arbitrary language, but it cannot mint
    presentation identity, consent provenance, commercial terms, or readiness.
    """
    interpretation_digest = hashlib.sha256(_encode(interpretation).encode()).hexdigest()

    def claim_attempt(state, ingress):
        pending = state.get('current_turn')
        if (not isinstance(pending, dict)
                or pending.get('message_id') != ingress['MESSAGE_ID']
                or not isinstance(pending.get('raw'), str)
                or pending.get('raw_digest') != hashlib.sha256(pending['raw'].encode()).hexdigest()):
            raise QuoteBoundaryError('quote_intent_provenance_invalid')
        prior_digest = pending.get('interpretation_digest')
        if prior_digest and prior_digest != interpretation_digest:
            raise QuoteBoundaryError('quote_intent_already_adjudicated')
        pending.setdefault('interpretation_digest', interpretation_digest)
        if state.get('status') == 'accepted' and 'interpretation_result' not in pending:
            pending.setdefault('pre_interpretation_status', 'accepted')
            state['status'] = 'offered'

    # Claim durably before schema/evidence adjudication. A malformed or rejected
    # proposal cannot be replaced by a different proposal for the same ingress.
    _transaction(claim_attempt)

    def adjudicate(state, ingress):
        if not isinstance(interpretation, dict) or set(interpretation) != {
                'action', 'action_evidence', 'ambiguous', 'negated', 'conditional',
                'material_changes', 'completions'}:
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        action = interpretation.get('action')
        if action not in ('accept', 'reject', 'revise', 'clarify'):
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        if any(type(interpretation.get(key)) is not bool
               for key in ('ambiguous', 'negated', 'conditional')):
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        changes = interpretation.get('material_changes')
        completions = interpretation.get('completions')
        if not isinstance(changes, list):
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        if not isinstance(completions, dict) or set(completions) - {'guests', 'payment_choice', 'eligibility'}:
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        pending = state.get('current_turn')
        if (not isinstance(pending, dict)
                or pending.get('message_id') != ingress['MESSAGE_ID']
                or not isinstance(pending.get('raw'), str)
                or pending.get('raw_digest') != hashlib.sha256(pending['raw'].encode()).hexdigest()):
            raise QuoteBoundaryError('quote_intent_provenance_invalid')
        raw = pending['raw']
        if not _action_evidence_is_current_turn(raw, interpretation.get('action_evidence')):
            raise QuoteBoundaryError('quote_intent_evidence_invalid')
        bounded_changes = _validated_material_changes(raw, changes, state)
        if bounded_changes is None:
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        presentation = state.get('presentation')
        if (not isinstance(presentation, dict)
                or presentation.get('tenant') != ingress['tenant']
                or presentation.get('scope') != state.get('scope')
                or presentation.get('incarnation') != state.get('incarnation')
                or presentation.get('original_turn') != state.get('offer_message')
                or presentation.get('original_turn') not in state.get('seen', [])
                or presentation.get('authoritative_quote') != state.get('quote')
                or not _presentation_matches_completion_state(state, presentation)
                or not isinstance(presentation.get('displayed_text'), str)
                or presentation.get('displayed_text_digest') != hashlib.sha256(
                    presentation['displayed_text'].encode()).hexdigest()):
            raise QuoteBoundaryError('quote_owner_presented_offer_required')
        presented = state.get('presented_offer')
        prior_digest = pending.get('interpretation_digest')
        if prior_digest != interpretation_digest:
            raise QuoteBoundaryError('quote_intent_already_adjudicated')
        if 'interpretation_result' in pending:
            return deepcopy(pending.get('interpretation_result'))
        checked_ready = (isinstance(presented, dict)
                         and isinstance(state.get('checked_offer'), dict)
                         and presented == state['checked_offer']
                         and presentation.get('create_ready') is True
                         and presentation.get('quote_revision') == presented)
        if (action != 'accept' or interpretation['ambiguous'] or interpretation['negated']
                or interpretation['conditional'] or changes):
            # Keep the presentation for a targeted follow-up, but issue no create authority.
            state.update(status='offered', auto_acceptance=False)
            state.pop('acceptance_message', None)
            state.pop('acceptance_raw_digest', None)
            if interpretation['negated'] or action == 'reject':
                next_action = 'do_not_create'
                question = 'What would you like to change about this booking?'
            elif changes or action == 'revise':
                if bounded_changes:
                    state['authorized_revision_changes'] = bounded_changes
                    state['unresolved_change'] = False
                    next_action = 'requote_material_changes'
                    question = 'I will recheck those requested booking changes.'
                else:
                    state.pop('authorized_revision_changes', None)
                    state['unresolved_change'] = True
                    next_action = 'clarify_material_changes'
                    question = 'What exact booking detail would you like changed?'
            elif interpretation['conditional']:
                next_action = 'clarify_condition'
                question = 'Should I create the presented booking now, without that condition?'
            else:
                next_action = 'clarify_acceptance'
                question = 'Should I create the presented booking exactly as shown?'
            result = {'accepted': False, 'action': action, 'question_required': True,
                      'next_action': next_action, 'question': question}
            pending['interpretation_digest'] = interpretation_digest
            pending['interpretation_result'] = deepcopy(result)
            return result

        guests = completions.get('guests', [])
        if not isinstance(guests, list):
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        plan_guests = _presentation_plan(state).get('guests')
        if guests and not isinstance(plan_guests, list):
            raise QuoteBoundaryError('quote_completion_not_supported')
        for item in guests:
            if (not isinstance(item, dict) or set(item) != {'guest_index', 'name', 'evidence'}
                    or type(item.get('guest_index')) is not int
                    or not isinstance(item.get('name'), str) or not item['name'].strip()
                    or not _evidence_in_current_turn(raw, item.get('evidence'))
                    or item['name'].strip() not in item['evidence']
                    or not 0 <= item['guest_index'] < len(plan_guests)):
                raise QuoteBoundaryError('quote_completion_evidence_invalid')
            old = ' '.join(str(plan_guests[item['guest_index']].get('name') or '').split())
            new = ' '.join(item['name'].split())
            if old.casefold() != new.casefold():
                # Only an unambiguous same-person expansion can retain consent;
                # Staff must revalidate the exact person/bed row before create.
                normalized_old = ' '.join(old.split()).casefold()
                normalized_new = ' '.join(new.split()).casefold()
                if (not old or (' ' in old)
                        or not normalized_new.startswith(normalized_old + ' ')
                        or sum(1 for guest in (plan_guests or [])
                               if isinstance(guest, dict)
                               and ' '.join(str(guest.get('name') or '').split()).casefold()
                               == normalized_old) != 1):
                    raise QuoteBoundaryError('quote_completion_identity_changed')
                if any(index != item['guest_index']
                       and ' '.join(str(guest.get('name') or '').split()).casefold()
                       == normalized_new
                       for index, guest in enumerate(plan_guests or [])
                       if isinstance(guest, dict)):
                    raise QuoteBoundaryError('quote_completion_identity_changed')
                updated = deepcopy((state.get('completion_plan') or {}).get('guests')
                                   or plan_guests)
                updated[item['guest_index']] = {**updated[item['guest_index']], 'name': new}
                state.setdefault('completion_plan', {})['guests'] = updated
                pending_names = state.setdefault('pending_name_completions', [])
                if any(row.get('guest_index') == item['guest_index'] for row in pending_names):
                    raise QuoteBoundaryError('quote_completion_identity_changed')
                pending_names.append({
                    'guest_index': item['guest_index'], 'previous_name': old,
                    'completed_name': new,
                })
                state['pending_name_completion'] = pending_names[-1]

        payment = completions.get('payment_choice')
        if payment is not None:
            if (not isinstance(payment, dict) or set(payment) != {'value', 'evidence'}
                    or payment.get('value') not in ('deposit', 'full', 'pay_on_arrival', 'per_guest')
                    or not _evidence_in_current_turn(raw, payment.get('evidence'))
                    or not _scalar_is_evidenced(payment.get('value'), payment.get('evidence'))):
                raise QuoteBoundaryError('quote_completion_evidence_invalid')
            current_payment = (state.get('checked_offer') or {}).get('payment_choice')
            if checked_ready:
                if payment['value'] != current_payment:
                    raise QuoteBoundaryError('quote_payment_terms_not_presented')
            else:
                if payment['value'] not in presentation.get('payment_choices', []):
                    raise QuoteBoundaryError('quote_payment_terms_not_presented')
                state.setdefault('completion_plan', {})['payment_choice'] = payment['value']
                state['pending_payment_completion'] = payment['value']

        # Eligibility completions require exact current-turn evidence plus a fresh
        # Staff quote; they are never inferred from a name or accepted directly.
        eligibility = completions.get('eligibility')
        if eligibility is not None:
            completion_guests = deepcopy((state.get('completion_plan') or {}).get('guests')
                                         or _presentation_plan(state).get('guests'))
            evidence = eligibility.get('evidence') if isinstance(eligibility, dict) else None
            if (not isinstance(eligibility, dict)
                    or set(eligibility) != {'guest_index', 'value', 'evidence'}
                    or type(eligibility.get('guest_index')) is not int
                    or eligibility.get('guest_index') < 0
                    or eligibility.get('value') not in ('male', 'female')
                    or not _evidence_in_current_turn(raw, evidence)
                    or not _scalar_is_evidenced(eligibility.get('value'), evidence)
                    or not isinstance(completion_guests, list)
                    or eligibility['guest_index'] >= len(completion_guests)
                    or not isinstance(completion_guests[eligibility['guest_index']], dict)):
                raise QuoteBoundaryError('quote_completion_evidence_invalid')
            target_name = completion_guests[eligibility['guest_index']].get('name')
            first_person = (eligibility['guest_index'] == 0
                            and bool(re.search(r'\b(i|me|my)\b', evidence, re.I)))
            if not first_person and (not isinstance(target_name, str)
                                     or not _scalar_is_evidenced(target_name, evidence)):
                raise QuoteBoundaryError('quote_completion_evidence_invalid')
            completion_guests[eligibility['guest_index']]['explicit_gender'] = eligibility['value']
            state.setdefault('completion_plan', {})['guests'] = completion_guests
            state['pending_eligibility_completion'] = {
                'guest_index': eligibility['guest_index'],
                'value': eligibility['value'],
            }
            checked_ready = False
        raw_digest = hashlib.sha256(raw.encode()).hexdigest()
        state.update(status='accepted', acceptance_message=ingress['MESSAGE_ID'],
                     acceptance_raw_digest=raw_digest, auto_acceptance=checked_ready,
                     accepted_offer_snapshot=(deepcopy(state['checked_offer'])
                                              if checked_ready else None),
                     accepted_presentation=deepcopy(presentation))
        missing = ([] if checked_ready else [
            key for key in ('payment_choice', 'staff_checked_offer')
            if key == 'staff_checked_offer' or not _presentation_plan(state).get(key)])
        result = {'accepted': True, 'create_ready': checked_ready,
                  'offer_fingerprint': ((state.get('checked_offer') or {}).get('offer_fingerprint')),
                  'missing': missing,
                  'next_action': ('create_booking' if checked_ready else 'revalidate_selected_terms'),
                  'question': (None if checked_ready else
                               ('I will recheck those completed details with the presented booking.'
                                if (state.get('pending_eligibility_completion')
                                    or state.get('pending_payment_completion')) else
                                'Which presented payment option should I check before creating the booking?'))}
        pending['interpretation_digest'] = interpretation_digest
        pending['interpretation_result'] = deepcopy(result)
        return result
    return _transaction(adjudicate)


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
        # A bounded re-quote authorization belongs only to the interpreted ingress
        # that produced it. Any fresh turn must be interpreted independently.
        state.pop('authorized_revision_changes', None)
        state['unresolved_change'] = False
        state['current_turn'] = {
            'message_id': message,
            'raw': raw,
            'raw_digest': raw_digest,
        }
        # IDs stay durable for the incarnation; do not age out replay protection.
        # Raw text is provenance only. It never grants, revokes, or revises booking
        # authority: every response to an owner presentation must be adjudicated by
        # interpret_owner_turn, and no presentation means there is nothing to accept.
        if isinstance(state.get('presentation'), dict):
            return
    try:
        return _transaction(observe)
    except Exception:
        close_turn()
        raise


def _sync_catalog_projection(add_ons, changes, catalog_before=None):
    """Apply authorized catalog-code changes to their accommodation add-on wire alias."""
    if not isinstance(add_ons, list):
        return None
    catalog_before = catalog_before if isinstance(catalog_before, list) else []
    projected = deepcopy(add_ons)
    for change in changes:
        item = change.get('item') if isinstance(change, dict) else None
        if not isinstance(item, dict):
            return None
        code = item.get('service_code')
        if not isinstance(code, str) or not code.strip():
            if change.get('operation') != 'remove':
                continue
            service_id = item.get('service_id')
            candidates = [str(entry['service_code']).strip() for entry in catalog_before
                          if isinstance(entry, dict)
                          and entry.get('service_id') == service_id
                          and isinstance(entry.get('service_code'), str)
                          and entry.get('service_code').strip()]
            if len(candidates) != 1:
                return None
            code = candidates[0]
        code = code.strip()
        matches = [index for index, existing in enumerate(projected)
                   if isinstance(existing, dict) and existing.get('code') == code]
        if change.get('operation') == 'remove':
            if len(matches) > 1:
                return None
            if matches:
                projected.pop(matches[0])
            continue
        wire_item = {'code': code, **{key: deepcopy(item[key])
                                     for key in ('quantity', 'days') if key in item}}
        if matches:
            if len(matches) != 1 or projected[matches[0]] != wire_item:
                return None
        else:
            projected.append(wire_item)
    return projected


def prepare_quote(params):
    def prepare(state, ingress):
        if state.get('unresolved_change'):
            raise QuoteBoundaryError('quote_revision_needs_clarification')
        result = deepcopy(params)
        old = state.get('plan')
        authorized = {}
        for change in state.get('authorized_revision_changes', []):
            authorized.setdefault(change['field'], []).append(change)
        if old:
            preserved = dict(old)
            include_completion = bool(state.get('checked_offer') or state.get('presentation')
                                      or state.get('accepted_presentation'))
            if include_completion:
                preserved.update(state.get('completion_plan') or {})
            fields = _FIELDS + (_CHECKED_FIELDS if include_completion else ())
            for key in fields:
                if key in authorized:
                    changes = authorized[key]
                    if 'value' in changes[0]:
                        target = deepcopy(changes[0]['value'])
                    else:
                        target = deepcopy(preserved.get(key))
                        for change in changes:
                            target = _apply_list_revision(target, change)
                            if target is None:
                                break
                    if target is None or (key in result and result[key] != target):
                        raise QuoteBoundaryError('quote_revision_requires_owner')
                    result[key] = target
                    continue
                if key not in preserved:
                    if key in result:
                        raise QuoteBoundaryError('quote_revision_requires_owner')
                    continue
                expected = state.get('delta', {}).get(key, preserved[key])
                if key in result and result[key] != expected:
                    raise QuoteBoundaryError('quote_revision_requires_owner')
                result.setdefault(key, deepcopy(expected))
            if 'add_ons' in authorized:
                catalog = deepcopy(result.get(
                    'catalog_selections', preserved.get('catalog_selections', [])))
                if not isinstance(catalog, list):
                    raise QuoteBoundaryError('quote_revision_requires_owner')
                for change in authorized['add_ons']:
                    if change.get('operation') != 'remove':
                        continue
                    item = change.get('item')
                    code = item.get('code') if isinstance(item, dict) else None
                    if not isinstance(code, str) or not code.strip():
                        raise QuoteBoundaryError('quote_revision_requires_owner')
                    matches = [index for index, selected in enumerate(catalog)
                               if isinstance(selected, dict)
                               and selected.get('service_code') == code.strip()]
                    if len(matches) > 1:
                        raise QuoteBoundaryError('quote_revision_requires_owner')
                    if matches:
                        catalog.pop(matches[0])
                result['catalog_selections'] = catalog
            if 'catalog_selections' in authorized:
                projected = _sync_catalog_projection(
                    result.get('add_ons', preserved.get('add_ons', [])),
                    authorized['catalog_selections'],
                    preserved.get('catalog_selections', []))
                if projected is None:
                    raise QuoteBoundaryError('quote_revision_requires_owner')
                result['add_ons'] = projected
        if state.get('pending_payment_completion'):
            expected_payment = state['pending_payment_completion']
            if 'payment_choice' in result and result['payment_choice'] != expected_payment:
                raise QuoteBoundaryError('quote_revision_requires_owner')
            result['payment_choice'] = expected_payment
        return PreparedPlan(result, _current.get(), state['epoch'])
    return _transaction(prepare)


def validated_guest_eligibility(prepared):
    """Return only person-bound hints already proved by owner state."""
    def read(state, _ingress):
        if (not isinstance(prepared, PreparedPlan)
                or prepared.capability is not _current.get()
                or prepared.epoch != state['epoch']):
            raise QuoteBoundaryError('quote_response_superseded')
        guests = prepared.get('guests')
        if not isinstance(guests, list):
            return {}
        allowed = {}
        checked = state.get('checked_offer') or {}
        name_binding = state.get('pending_name_completion')
        bound_index = None
        bound_previous = None
        if isinstance(name_binding, dict):
            normalize_name = lambda value: ' '.join(str(value or '').split()).casefold()
            index = name_binding.get('guest_index')
            previous = str(name_binding.get('previous_name') or '').strip()
            completed = str(name_binding.get('completed_name') or '').strip()
            assignments = checked.get('guest_bed_assignments') if isinstance(checked, dict) else None
            if (type(index) is int and 0 <= index < len(guests)
                    and previous and completed
                    and isinstance(guests[index], dict)
                    and normalize_name(guests[index].get('name')) == normalize_name(completed)
                    and isinstance(assignments, list) and len(assignments) == len(guests)
                    and all(isinstance(row, dict) and row.get('guest_index') == row_index
                            for row_index, row in enumerate(assignments))
                    and normalize_name(assignments[index].get('guest_name'))
                    == normalize_name(previous)
                    and all(row_index == index or (
                        isinstance(guests[row_index], dict)
                        and normalize_name(guests[row_index].get('name'))
                        == normalize_name(assignments[row_index].get('guest_name')))
                            for row_index in range(len(guests)))):
                bound_index = index
                bound_previous = previous.casefold()
        hints = checked.get('room_name_hints') if isinstance(checked, dict) else None
        if isinstance(hints, list):
            for hint in hints:
                if (not isinstance(hint, dict)
                        or hint.get('explicit_gender') not in ('male', 'female')):
                    continue
                name = str(hint.get('name', '')).strip().casefold()
                if bound_index is not None and name == bound_previous:
                    allowed[bound_index] = hint['explicit_gender']
                    continue
                matches = [index for index, guest in enumerate(guests)
                           if isinstance(guest, dict)
                           and str(guest.get('name', '')).strip().casefold() == name]
                if len(matches) == 1:
                    allowed[matches[0]] = hint['explicit_gender']
        pending = state.get('pending_eligibility_completion')
        completion = state.get('completion_plan') or {}
        completed_guests = completion.get('guests') if isinstance(completion, dict) else None
        if isinstance(pending, dict) and isinstance(completed_guests, list):
            index = pending.get('guest_index')
            value = pending.get('value')
            if (type(index) is int and 0 <= index < len(guests)
                    and index < len(completed_guests) and value in ('male', 'female')
                    and completed_guests[index] == guests[index]):
                allowed[index] = value
        return allowed
    return _transaction(read)


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
            or offer.get('total_cents') != response.get('total_cents')
            or (offer.get('payment_choice') in ('deposit', 'per_guest')
                and offer.get('payment_link_amount_cents') != offer.get('deposit_required_cents'))
            or (offer.get('payment_choice') == 'full'
                and offer.get('payment_link_amount_cents') != offer.get('total_cents'))):
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
    if prepared.get('room_name_hints'):
        plan['room_name_hints'] = deepcopy(prepared['room_name_hints'])
    elif not plan.get('room_name_hints'):
        plan.pop('room_name_hints', None)
    return plan


def _incomplete_payment_revision(response, tenant, plan=None):
    """Validate Staff's priced provisional revision before guest payment selection."""
    offer = response.get('offer_revision')
    availability = response.get('availability')
    requested_payment = (plan or {}).get('payment_choice')
    if (not isinstance(offer, dict) or not isinstance(availability, dict)
            or response.get('payment_choice_needed') is not True
            or requested_payment in ('full', 'deposit', 'pay_on_arrival', 'per_guest')
            or offer.get('client_slug') != tenant
            or offer.get('availability_checked') is not True
            or availability.get('status') != 'checked'
            or offer.get('payment_choice') != 'deposit'
            or not offer.get('offer_fingerprint')
            or any(not isinstance(offer.get(key), str) or not offer[key].strip()
                   for key in ('check_in', 'check_out', 'currency', 'room_type', 'package_code'))
            or any(type(offer.get(key)) is not int or offer[key] < 0 for key in
                   ('guest_count', 'total_cents', 'deposit_required_cents', 'payment_link_amount_cents'))
            or offer.get('total_cents') != response.get('total_cents')
            or offer.get('payment_link_amount_cents') != offer.get('deposit_required_cents')):
        return False
    assignments = offer.get('guest_bed_assignments')
    rooms = offer.get('room_arrangement')
    count = offer.get('guest_count')
    return (isinstance(assignments, list) and len(assignments) == count
            and isinstance(rooms, list) and len(rooms) == count
            and availability.get('selected_bed_codes') == [row.get('bed_code') for row in assignments]
            and all(isinstance(row, dict) and row.get('guest_index') == index
                    and row.get('guest_name') and row.get('bed_code')
                    for index, row in enumerate(assignments))
            and all(isinstance(row, dict) and row.get('bed_code') and row.get('room_code')
                    and row.get('gender_strategy') for row in rooms))


def record_quote(params, response):
    prepared = params if isinstance(params, PreparedPlan) else prepare_quote(params)
    def record(state, ingress):
        if prepared.capability is not _current.get() or prepared.epoch != state['epoch']:
            raise QuoteBoundaryError('quote_response_superseded')
        plan = {key: deepcopy(prepared[key]) for key in _FIELDS if key in prepared}
        completion_plan = {key: deepcopy(prepared[key]) for key in _CHECKED_FIELDS
                           if key in prepared}
        checked = _checked_plan(prepared, response, ingress['tenant'])
        if checked is not None:
            plan = checked
            completion_plan = {}
        previous_checked = state.get('checked_offer')
        total = response.get('total_cents')
        valid = response.get('success') is True and type(total) is int and total > 0
        if response.get('offer_revision') and response.get('payment_choice_needed') is True:
            valid = valid and _incomplete_payment_revision(
                response, ingress['tenant'], prepared)
        elif previous_checked or response.get('offer_revision'):
            valid = valid and checked is not None
        pending_payment = state.get('pending_payment_completion')
        pending_name = state.get('pending_name_completion')
        pending_eligibility = state.get('pending_eligibility_completion')
        if (valid and checked is not None and state['status'] == 'accepted'
                and (pending_payment or pending_name or pending_eligibility)
                and isinstance(state.get('accepted_presentation'), dict)):
            prior = state['accepted_presentation']
            prior_plan = prior.get('plan') or {}
            expected_plan = deepcopy(prior_plan)
            expected_plan.update(deepcopy(state.get('completion_plan') or {}))
            comparable = {key: expected_plan.get(key) for key in _FIELDS if key in expected_plan}
            current = {key: plan.get(key) for key in _FIELDS if key in expected_plan}
            prior_quote = prior.get('authoritative_quote') or {}
            prior_revision = prior.get('quote_revision') or prior_quote.get('offer_revision')
            new_revision = response.get('offer_revision')
            guest_index = (pending_name or {}).get('guest_index') if pending_name else None
            guest_name = (pending_name or {}).get('completed_name') if pending_name else None
            eligibility_index = ((pending_eligibility or {}).get('guest_index')
                                 if pending_eligibility else None)
            eligibility_value = ((pending_eligibility or {}).get('value')
                                 if pending_eligibility else None)
            terms_unchanged = (
                comparable == current
                and _completion_revision_matches(
                    prior_revision, new_revision,
                    payment_choice=pending_payment, guest_index=guest_index,
                    guest_name=guest_name, eligibility_index=eligibility_index,
                    eligibility_value=eligibility_value)
                and response.get('total_cents') == prior_quote.get('total_cents')
                and response.get('deposit_required_cents') == prior_quote.get('deposit_required_cents')
                and response.get('currency') == prior_quote.get('currency')
                and (not pending_payment or (
                    response.get('offer_revision', {}).get('payment_choice') == pending_payment
                    and pending_payment in prior.get('payment_choices', [])))
            )
            if terms_unchanged:
                state['checked_offer'] = deepcopy(response['offer_revision'])
                state['accepted_offer_snapshot'] = deepcopy(response['offer_revision'])
                state['quote'] = deepcopy(response)
                state['plan'] = plan
                state['completion_plan'] = {}
                derived = deepcopy(prior)
                derived.update(authoritative_quote=deepcopy(response),
                               plan=deepcopy(plan),
                               quote_revision=deepcopy(response['offer_revision']),
                               create_ready=True)
                state['presentation'] = deepcopy(derived)
                state['accepted_presentation'] = derived
                state['presented_offer'] = deepcopy(response['offer_revision'])
                state['auto_acceptance'] = True
                state.pop('pending_payment_completion', None)
                state.pop('pending_name_completion', None)
                state.pop('pending_name_completions', None)
                state.pop('pending_eligibility_completion', None)
                state['epoch'] += 1
                prepared.capability.epoch = state['epoch']
                return
        if (valid and checked is not None and state['status'] == 'accepted'
                and previous_checked == response['offer_revision'] and state['plan'] == plan):
            # Cosmetic revalidation metadata must not mint a new operation or
            # erase consent. Keep the original snapshot, receipt and key inputs.
            return
        state['checked_offer'] = deepcopy(response['offer_revision']) if checked is not None else None
        state.pop('presented_offer', None)
        state.pop('presentation', None)
        state.pop('accepted_presentation', None)
        state.pop('receipt', None)
        state.pop('completion', None)
        state.pop('dispatch_pending', None)
        state.pop('post_booking_contact', None)
        state.update(plan=plan, completion_plan=completion_plan,
                     quote=deepcopy(response) if valid else None,
                     status='offered' if valid else 'blocked', offer_message=ingress['MESSAGE_ID'])
        state.pop('acceptance_message', None)
        state.pop('pending_name_completion', None)
        state.pop('pending_name_completions', None)
        state.pop('pending_payment_completion', None)
        state.pop('pending_eligibility_completion', None)
        state.pop('authorized_revision_changes', None)
        state['unresolved_change'] = False
        state['delta'] = {}
        state['epoch'] += 1
        prepared.capability.epoch = state['epoch']
    return _transaction(record)


def prepare_create(params):
    def prepare(state, ingress):
        if state['status'] != 'accepted' or not state.get('quote'):
            raise QuoteBoundaryError('quote_owner_acceptance_required')
        current = state.get('current_turn')
        acceptance_message = state.get('acceptance_message')
        acceptance_digest = state.get('acceptance_raw_digest')
        adjudicated = (isinstance(current, dict)
                       and current.get('message_id') == acceptance_message
                       and current.get('raw_digest') == acceptance_digest
                       and isinstance(current.get('interpretation_result'), dict)
                       and current['interpretation_result'].get('accepted') is True
                       and ingress['MESSAGE_ID'] == acceptance_message)
        recovering = (ingress['MESSAGE_ID'] == acceptance_message
                      and isinstance(current, dict)
                      and current.get('message_id') == acceptance_message
                      and current.get('raw_digest') == acceptance_digest)
        if not adjudicated and not recovering:
            raise QuoteBoundaryError('quote_current_turn_not_adjudicated')
        if (not isinstance(state.get('presentation'), dict)
                or not isinstance(state.get('accepted_presentation'), dict)
                or not isinstance(state.get('checked_offer'), dict)
                or state.get('accepted_offer_snapshot') != state.get('checked_offer')
                or state['accepted_presentation'].get('quote_revision') != state.get('checked_offer')
                or state['accepted_presentation'].get('plan') != _presentation_plan(state)):
            # No phrase/confirm compatibility path may bypass owner presentation,
            # structural interpretation, and the exact Staff-checked revision.
            raise QuoteBoundaryError('quote_owner_acceptance_required')
        if state.get('pending_name_completion'):
            raise QuoteBoundaryError('quote_name_completion_revalidation_required')
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
        completion = state.get('completion')
        return {
            'receipt': deepcopy(completion or state.get('receipt')),
            'adapter_completed': isinstance(completion, dict),
            'pending': bool(state.get('checked_offer') and state.get('dispatch_pending')),
        }
    return _transaction(inspect)


def current_create_receipt():
    """Return only the current owner scope's completed create receipt, if any.

    Readback tools use this to avoid retracting a Staff write that the same
    conversation already completed. The receipt remains capability/SessionDB
    scoped; callers cannot supply an identity or inspect another owner.
    """
    def inspect(state, ingress):
        receipt = state.get('completion') or state.get('receipt')
        return deepcopy(receipt) if isinstance(receipt, dict) else None
    try:
        return _transaction(inspect)
    except QuoteBoundaryError:
        return None


def _contact_transition(state, action, *, identity, outcome=None):
    """Pure state machine for the owner-owned post-booking contact substep."""
    receipt = state.get('receipt')
    if (not isinstance(identity, dict)
            or set(identity) != {'email', 'booking_code'}
            or any(not isinstance(identity.get(key), str) or not identity[key]
                   for key in ('email', 'booking_code'))
            or not isinstance(receipt, dict)
            or (receipt.get('booking_code') is not None
                and receipt.get('booking_code') != identity['booking_code'])):
        raise QuoteBoundaryError('post_booking_contact_identity_missing')
    contact = state.get('post_booking_contact')
    if contact is None:
        if action != 'ensure':
            raise QuoteBoundaryError('post_booking_contact_not_pending')
        contact = {'status': 'pending', 'identity': deepcopy(identity)}
        state['post_booking_contact'] = contact
    elif contact.get('identity') != identity:
        raise QuoteBoundaryError('post_booking_contact_identity_changed')
    if action == 'ensure':
        return deepcopy(contact)
    if action == 'begin':
        if contact.get('status') != 'pending':
            return {'perform': False, 'contact': deepcopy(contact)}
        # Persist uncertainty before transport. A process death from this point
        # can never cause a blind retry of a write that may have reached Staff.
        contact['status'] = 'unknown'
        return {'perform': True, 'contact': deepcopy(contact)}
    if action == 'complete':
        if contact.get('status') != 'unknown' or not isinstance(outcome, dict):
            raise QuoteBoundaryError('post_booking_contact_completion_invalid')
        contact.update(status='completed', outcome=deepcopy(outcome))
        return deepcopy(contact)
    raise QuoteBoundaryError('post_booking_contact_action_invalid')


def post_booking_contact_status(prepared, *, email, booking_code):
    identity = {'email': email, 'booking_code': booking_code}
    def ensure(state, ingress):
        _validate_dispatch_ticket(prepared, state)
        return _contact_transition(state, 'ensure', identity=identity)
    return _transaction(ensure)


def begin_post_booking_contact(prepared, *, email, booking_code):
    identity = {'email': email, 'booking_code': booking_code}
    def begin(state, ingress):
        _validate_dispatch_ticket(prepared, state)
        return _contact_transition(state, 'begin', identity=identity)
    return _transaction(begin)


def complete_post_booking_contact(prepared, *, email, booking_code, outcome):
    identity = {'email': email, 'booking_code': booking_code}
    def complete(state, ingress):
        _validate_dispatch_ticket(prepared, state)
        return _contact_transition(state, 'complete', identity=identity, outcome=outcome)
    return _transaction(complete)


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
    """Own quote presentation and successful-create truth in the returned reply."""
    if (not isinstance(result, dict) or result.get('completed') is not True
            or result.get('failed') or result.get('interrupted') or result.get('error')):
        return result
    def present(state, ingress):
        messages = result.get('messages')
        receipt = state.get('completion') or state.get('receipt')
        if isinstance(messages, list) and isinstance(receipt, dict):
            last_user = max((index for index, item in enumerate(messages)
                             if isinstance(item, dict) and item.get('role') == 'user'),
                            default=-1)
            current_tools = [item for item in messages[last_user + 1:]
                             if isinstance(item, dict) and item.get('role') == 'tool']
            readback = {}
            for tool_message in reversed(current_tools):
                try:
                    candidate = json.loads(tool_message.get('content') or '{}')
                except (TypeError, ValueError):
                    continue
                if isinstance(candidate, dict) and candidate.get('tool') == 'list_my_bookings':
                    readback = candidate
                    break
            prior = readback.get('prior_create_receipt') if isinstance(readback, dict) else None
            reference = receipt.get('booking_code') or receipt.get('booking_id')
            prior_reference = ((prior.get('booking_code') or prior.get('booking_id'))
                               if isinstance(prior, dict) else None)
            lookup_status = readback.get('lookup_status') if isinstance(readback, dict) else None
            if (readback.get('tool') == 'list_my_bookings'
                    and lookup_status in ('empty', 'unavailable')
                    and reference and prior_reference == reference):
                text = (f"Booking {reference} was created successfully earlier. "
                        "I can't verify its current details right now.")
                output = deepcopy(result)
                output['final_response'] = text
                output_messages = output.get('messages')
                if (isinstance(output_messages, list) and output_messages
                        and output_messages[-1].get('role') == 'assistant'):
                    output_messages[-1]['content'] = text
                return output
        offer = state.get('checked_offer')
        incomplete = _incomplete_payment_revision(
            state.get('quote') or {}, ingress['tenant'], _presentation_plan(state))
        presentable = (state['status'] == 'offered' and state.get('quote')
                       and (isinstance(offer, dict) or incomplete)
                       and state.get('offer_message') == ingress['MESSAGE_ID'])
        if not presentable:
            return result
        displayed = result.get('final_response')
        if not isinstance(displayed, str) or not displayed.strip():
            return result
        assistant = next((item for item in reversed(messages or [])
                          if isinstance(item, dict) and item.get('role') == 'assistant'), {})
        quote = state['quote']
        choices = []
        if quote.get('payment_choice_needed') is True:
            if type(quote.get('deposit_required_cents')) is int:
                choices.append('deposit')
            if type(quote.get('total_cents')) is int:
                choices.append('full')
        elif isinstance(offer, dict) and offer.get('payment_choice'):
            choices.append(offer['payment_choice'])
        state['presentation'] = {
            'tenant': ingress['tenant'],
            'scope': deepcopy(state['scope']),
            'incarnation': state['incarnation'],
            'original_turn': state['offer_message'],
            'reply_reference': assistant.get('id') or assistant.get('message_id')
                               or hashlib.sha256(displayed.encode()).hexdigest(),
            'displayed_text': displayed,
            'displayed_text_digest': hashlib.sha256(displayed.encode()).hexdigest(),
            'authoritative_quote': deepcopy(quote),
            'plan': _presentation_plan(state),
            'quote_revision': deepcopy(offer or quote.get('offer_revision')),
            'payment_choices': choices,
            'create_ready': bool(offer),
        }
        if not offer:
            # Owner-render the Staff-authoritative priced terms. Arbitrary model
            # draft text never becomes presentation evidence.
            plan = _presentation_plan(state)
            currency = quote.get('currency')
            total = quote.get('total_cents')
            if not isinstance(currency, str) or type(total) is not int:
                return result
            def quoted_money(cents):
                return f"{cents // 100}.{cents % 100:02d} {currency}"
            lines = []
            if plan.get('check_in') and plan.get('check_out') and type(plan.get('guest_count')) is int:
                lines.append(f"{_plain_stay_date(plan['check_in'])} to {_plain_stay_date(plan['check_out'])} — {_guest_count_label(plan['guest_count'])}.")
            lines.append(f"Total: {quoted_money(total)}.")
            if choices:
                labels = {'deposit': 'deposit', 'full': 'full payment'}
                lines.append('Payment options: ' + ' or '.join(labels[item] for item in choices) + '.')
            lines.append('Which payment option would you like me to check for this booking?')
            text = '\n'.join(lines)
            output = deepcopy(result)
            output['final_response'] = text
            output_messages = output.get('messages')
            if (isinstance(output_messages, list) and output_messages
                    and output_messages[-1].get('role') == 'assistant'):
                output_messages[-1]['content'] = text
            state['presentation'].update(
                displayed_text=text,
                displayed_text_digest=hashlib.sha256(text.encode()).hexdigest(),
                reply_reference=(output_messages[-1].get('id') or output_messages[-1].get('message_id')
                                 if isinstance(output_messages, list) and output_messages
                                 and isinstance(output_messages[-1], dict) else None)
                                or hashlib.sha256(text.encode()).hexdigest(),
            )
            return output
        def money(cents):
            return f"{cents // 100}.{cents % 100:02d} {offer['currency']}"
        plan = state['plan']
        lines = [f"{_plain_stay_date(offer['check_in'])} to {_plain_stay_date(offer['check_out'])} — {_guest_count_label(offer['guest_count'])}."]
        lines.extend(_guest_room_lines(plan, offer))
        def label(code):
            if code in ('package_none', 'none', 'accommodation_only', 'no_package'):
                return 'Accommodation only'
            return str(code).removeprefix('package_').replace('_', ' ').capitalize()

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
        prior = state.get('accepted_offer_snapshot')
        question = ('Shall I create this updated booking?'
                    if isinstance(prior, dict) and prior != offer
                    else 'Shall I create this booking?')
        lines.append(question)
        text = '\n'.join(lines)
        output = deepcopy(result)
        output['final_response'] = text
        messages = output.get('messages')
        if isinstance(messages, list) and messages and messages[-1].get('role') == 'assistant':
            messages[-1]['content'] = text
        state['presented_offer'] = deepcopy(offer)
        state['presentation'].update(
            displayed_text=text,
            displayed_text_digest=hashlib.sha256(text.encode()).hexdigest(),
            reply_reference=(messages[-1].get('id') or messages[-1].get('message_id')
                             if isinstance(messages, list) and messages
                             and isinstance(messages[-1], dict) else None)
                            or state['presentation']['reply_reference'],
            quote_revision=deepcopy(offer),
            create_ready=True,
        )
        return output
    return _transaction(present)


def _exact_retry_refusal(user_message, args, kwargs):
    text = ('I could not verify that this booking recovery still matches the '
            'original accepted setup. We need to check it before proceeding.')
    history = kwargs.get('conversation_history', args[1] if len(args) > 1 else None) or []
    return {'completed': True, 'final_response': text, 'api_calls': 0,
            'messages': [*deepcopy(history), {'role': 'user', 'content': user_message},
                         {'role': 'assistant', 'content': text}]}


def install_owner_hook(create_handler=None, before_create=None, quote_handler=None):
    global _registered_quote, _registered_create, _before_create
    if quote_handler is not None:
        _registered_quote = quote_handler
    if create_handler is not None:
        _registered_create, _before_create = create_handler, before_create
    try:
        from agent import conversation_loop
    except ModuleNotFoundError:
        # Standalone plugin/unit-test environments may not install Hermes.
        # The live Crowsnest readiness check still requires this hook.
        return
    original = conversation_loop.run_conversation
    if getattr(original, '_wolfhouse_quote_owner_token', None) is _OWNER_HOOK_TOKEN:
        return
    @wraps(original)
    def owned(agent, user_message, *args, **kwargs):
        close_turn()
        retry_state, exact_retry = _consume_exact_gateway_retry()
        if retry_state == 'spent':
            # A copied executor context saw the real token, but another context
            # already consumed it. This is a terminal refusal, never ordinary chat.
            return _exact_retry_refusal(user_message, args, kwargs)
        if retry_state == 'claimed' and not _prevalidate_exact_gateway_retry(
                agent, exact_retry, user_message):
            # Refuse before observe_owner_turn can alter a replacement offer.
            return _exact_retry_refusal(user_message, args, kwargs)
        try:
            from . import original_inbound as owner_inbound
            try:
                inbound = owner_inbound.consume(agent)
                with inbound.lock:
                    observe_owner_turn(agent, inbound.text)
                    capability = _current.get()
                    capability.parent = inbound
                    capability.lock = inbound.lock
            except QuoteBoundaryError as exc:
                owner_inbound.logger.warning(
                    'quote_owner_boundary_rejected stage=inbound_consumption reason=%s',
                    str(exc),
                )
                # Unsupported/unbound ordinary ingress retains conversation but an
                # internally armed exact retry may never fall through to the model.
                close_turn()
                if exact_retry is not None:
                    return _exact_retry_refusal(user_message, args, kwargs)
            if exact_retry is not None:
                try:
                    recovery_valid = _transaction(lambda state, ingress: recovery_capability_matches(
                        exact_retry,
                        state,
                        session_key=ingress['KEY'],
                        session_id=ingress['ID'],
                        identity=(ingress['PLATFORM'], ingress['CHAT_ID'], ingress['MESSAGE_ID']),
                        raw=user_message,
                    ))
                except QuoteBoundaryError:
                    recovery_valid = False
                if recovery_valid is not True:
                    close_turn()
                    return _exact_retry_refusal(user_message, args, kwargs)
            if _current.get() is not None and _registered_create is not None:
                # Automatic dispatch is only authenticated recovery of the exact
                # original consent ingress. A fresh turn must reach the model and
                # interpreter first so cancellation/revision/status text cannot
                # trigger the previously accepted operation.
                automatic = _transaction(lambda state, ingress: (
                    ingress['tenant'] == 'wolfhouse-somo' and state['status'] == 'accepted'
                    and bool(state.get('checked_offer')) and state.get('auto_acceptance') is True
                    and ingress['MESSAGE_ID'] == state.get('acceptance_message')
                    and hashlib.sha256(user_message.encode()).hexdigest()
                        == state.get('acceptance_raw_digest')))
                if automatic:
                    pending_completion = _transaction(
                        lambda state, ingress: bool(state.get('pending_name_completion')))
                    if pending_completion:
                        quote_result = ({'success': False, 'error': 'quote_owner_revalidation_unavailable'}
                                        if _registered_quote is None
                                        else json.loads(_registered_quote({})))
                        revalidated = _transaction(lambda state, ingress: (
                            state['status'] == 'accepted'
                            and bool(state.get('checked_offer'))
                            and not state.get('pending_name_completion')))
                        if quote_result.get('success') is not True or not revalidated:
                            text = ('I could not verify the updated guest name against the accepted '
                                    'offer. I have not created the booking.')
                            history = kwargs.get('conversation_history', args[1] if len(args) > 1 else None) or []
                            return {'completed': True, 'final_response': text, 'api_calls': 0,
                                    'messages': [*deepcopy(history),
                                                 {'role': 'user', 'content': user_message},
                                                 {'role': 'assistant', 'content': text}],
                                    'booking_result': quote_result}
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
            if exact_retry is not None:
                return _exact_retry_refusal(user_message, args, kwargs)
            result = original(agent, user_message, *args, **kwargs)
            if _current.get() is not None:
                return finalize_offer_response(result)
            return result
        finally:
            # An owner capability belongs to one entrypoint turn only. Restoring
            # a stale ambient binding would authorize tools after this turn exits.
            close_turn()
    owned._wolfhouse_quote_owner = True
    owned._wolfhouse_quote_owner_token = _OWNER_HOOK_TOKEN
    conversation_loop.run_conversation = owned


def quote_owner_hook_ready(callable_owner):
    return getattr(callable_owner, '_wolfhouse_quote_owner_token', None) is _OWNER_HOOK_TOKEN
