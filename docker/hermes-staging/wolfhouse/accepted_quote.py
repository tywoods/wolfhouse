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
import logging
import os
import re
import sys
import unicodedata
from threading import RLock
from urllib.parse import urlsplit


logger = logging.getLogger('wolfhouse.accepted_quote')


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
        self.revalidation = False


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
           'room_type', 'room_preference', 'gender_preference', 'group_gender', 'keep_together',
           'add_ons', 'catalog_selections', 'selected_bed_codes', 'email',
           'language', 'pending_transfers', 'shuttle_needed', 'needs_shuttle', 'shuttle_choice')
_CHECKED_FIELDS = ('guests', 'room_name_hints', 'payment_choice',
                   'payment_link_distribution', 'per_guest_payment_links')
_CARRIED_FIELDS = ('language', 'group_gender', 'gender_preference', 'room_preference', 'keep_together',
                   'room_name_hints', 'email', 'guests', 'payment_choice',
                   'payment_link_distribution',
                   'per_guest_payment_links', 'shuttle_needed', 'needs_shuttle', 'shuttle_choice')
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
    persisted = state.get('operation_key')
    if isinstance(persisted, str) and persisted:
        return persisted
    # Never reinterpret a legacy operation which may already have reached Staff.
    if state.get('dispatch_pending') or isinstance(state.get('receipt'), dict):
        payload = {
            'scope': state['scope'], 'incarnation': state['incarnation'],
            'offer': state.get('offer_message'),
            'acceptance': state['acceptance_message'],
            'plan': state['plan'], 'quote': state['quote'],
        }
    else:
        presentation = state.get('accepted_presentation') or state.get('presentation') or {}
        payload = {
            'scope': state['scope'], 'incarnation': state['incarnation'],
            'material_offer': _material_projection(
                presentation.get('plan') or state.get('plan') or {},
                presentation.get('quote_revision') or state.get('checked_offer')),
        }
    return 'luna-owner-' + hashlib.sha256(_encode(payload).encode()).hexdigest()[:32]


def _normalized_selection_rows(rows, *, catalog=False):
    """Canonical actual services; missing and empty are equivalent."""
    normalized = []
    for row in rows or []:
        if isinstance(row, str):
            code, quantity, days = row.strip(), 1, None
        elif isinstance(row, dict):
            code = str(row.get('service_code' if catalog else 'code')
                       or row.get('code') or row.get('item_code') or '').strip()
            quantity, days = row.get('quantity') or 1, row.get('days')
        else:
            continue
        if code:
            normalized.append((code, quantity, days))
    return sorted(set(normalized), key=lambda item: _encode(item))


def _material_projection(plan, revision=None, *, include_personal=False):
    """Canonical shown-offer identity, optionally including retry-bound people."""
    plan = plan if isinstance(plan, dict) else {}
    revision = revision if isinstance(revision, dict) else {}
    value = lambda key: plan[key] if key in plan else revision.get(key)
    assignments = revision.get('guest_bed_assignments') or []
    rooms = {row.get('bed_code'): row for row in (revision.get('room_arrangement') or [])
             if isinstance(row, dict) and row.get('bed_code')}
    codes = value('selected_bed_codes')
    if codes is None:
        codes = [row.get('bed_code') for row in assignments if isinstance(row, dict)]
    allocation = [(index, code, rooms.get(code, {}).get('room_code'),
                   rooms.get(code, {}).get('gender_strategy'))
                  for index, code in enumerate(codes or [])]
    packages = []
    for index, row in enumerate(value('guest_packages') or []):
        if isinstance(row, dict):
            packages.append((row.get('guest_index', index),
                             row.get('package_code') or row.get('code')))
        else:
            packages.append((index, row))
    services = set(_normalized_selection_rows(value('add_ons')))
    services.update(_normalized_selection_rows(value('catalog_selections'), catalog=True))
    distribution = revision.get('payment_distribution')
    if isinstance(distribution, list):
        if not isinstance(distribution, list):
            distribution = None
        else:
            normalized_distribution = []
            for index, row in enumerate(distribution):
                if isinstance(row, dict):
                    normalized_distribution.append((
                        index,
                        ' '.join(str(row.get('guest_name') or '').split()).casefold(),
                        row.get('amount_due_cents', row.get('amount_cents')),
                        row.get('currency') or revision.get('currency')))
                elif (isinstance(row, (list, tuple)) and len(row) == 4
                      and row[0] == index):
                    # Stored owner projections are already canonical tuples.
                    normalized_distribution.append(tuple(row))
                else:
                    normalized_distribution = None
                    break
            distribution = normalized_distribution
            if distribution is not None and len(distribution) != len(revision.get('payment_distribution') or []):
                distribution = None
    projection = {
        'check_in': value('check_in'), 'check_out': value('check_out'),
        'guest_count': value('guest_count'), 'room_type': value('room_type'),
        'keep_together': value('keep_together') is True,
        'allocation': allocation, 'package_code': value('package_code'),
        'guest_packages': packages,
        'payment_distribution': distribution,
        'services': sorted(services, key=lambda item: _encode(item)),
        # Price and currency are accepted Staff-owned commercial terms.
        'total_cents': revision.get('total_cents'),
        'currency': revision.get('currency'),
    }
    if include_personal:
        people = value('guests')
        if not isinstance(people, list):
            people = [{'name': row.get('guest_name')}
                      for row in assignments if isinstance(row, dict)]
        projection.update(
            payment_choice=value('payment_choice'),
            occupants=[(
                ' '.join(str(guest.get('name') or '').split()).casefold(),
                str(guest.get('explicit_gender') or '').strip().casefold() or None,
            ) for guest in people if isinstance(guest, dict)],
        )
    return projection


def _same_material_offer(left_plan, right_plan, left_revision=None, right_revision=None,
                         *, include_personal=False):
    return (_material_projection(left_plan, left_revision,
                                 include_personal=include_personal)
            == _material_projection(right_plan, right_revision,
                                    include_personal=include_personal))


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
    # Direct/installed entrypoints can exist before gateway ingress has supplied
    # an authenticated conversation scope. Treat that as an absent owner turn;
    # never dereference it or manufacture authority from the model callback.
    if not isinstance(scope, dict) or not scope.get('ID'):
        raise QuoteBoundaryError('quote_owner_turn_missing')
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


def _plain_stay_date(value, language='en'):
    """Guest date only. Invalid values stay unchanged; never invent a date."""
    text = str(value or '').strip()
    match = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', text)
    if not match:
        return text
    try:
        day = date(int(match[1]), int(match[2]), int(match[3]))
    except ValueError:
        return text
    weekdays = {
        'en': ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'),
        'es': ('lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'),
        'fr': ('lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'),
        'it': ('lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'), 'de': ('Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'),
    }.get(language, ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'))
    months = {
        'en': ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'),
        'es': ('ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'),
        'fr': ('janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'),
        'it': ('gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'), 'de': ('Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'),
    }.get(language, ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'))
    return f'{weekdays[day.weekday()]} {day.day} {months[day.month - 1]}'


def _guest_count_label(count, language='en'):
    labels = {'en': ('guest', 'guests'), 'es': ('huésped', 'huéspedes'),
              'fr': ('personne', 'personnes'), 'it': ('ospite', 'ospiti'), 'de': ('Gast', 'Gäste')}
    one, many = labels.get(language, labels['en'])
    return f'{count} {one if count == 1 else many}'


def _join_names(names, language='en'):
    if not names:
        return ''
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} { {'es': 'y', 'fr': 'et', 'it': 'e', 'de': 'und'}.get(language, 'and') } {names[1]}"
    conjunction = {'es': 'y', 'fr': 'et', 'it': 'e', 'de': 'und'}.get(language, 'and')
    separator = ', ' if language == 'en' else ' '
    return ', '.join(names[:-1]) + f'{separator}{conjunction} {names[-1]}'


def _count_word(count, language='en'):
    words = ('two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten')
    translated = {'es': ('dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'),
                  'fr': ('deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'),
                  'it': ('due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'), 'de': ('zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn')}
    words = translated.get(language, words)
    return words[count - 2] if 2 <= count <= 10 else str(count)


def _has_private_room(offer):
    """A charged private supplement is authoritative private-sale evidence."""
    if offer.get('room_type') == 'private':
        return True
    return any(isinstance(row, dict) and row.get('code') == 'room_supplement'
               and type(row.get('total_cents')) is int and row['total_cents'] > 0
               for row in (offer.get('included_items') or []))


def _room_kind(offer, room, language='en'):
    if _has_private_room(offer):
        return {'es': 'habitación privada', 'fr': 'chambre privée',
                'it': 'camera privata', 'de': 'Privatzimmer'}.get(language, 'private room')
    labels_by_language = {
        'en': {'female_only': "women's room", 'male_only': "men's room", 'mixed': 'mixed room', 'flexible': 'shared room'},
        'es': {'female_only': 'habitación femenina', 'male_only': 'habitación masculina', 'mixed': 'habitación mixta', 'flexible': 'habitación compartida'},
        'fr': {'female_only': 'chambre pour femmes', 'male_only': 'chambre pour hommes', 'mixed': 'chambre mixte', 'flexible': 'chambre partagée'},
        'it': {'female_only': 'dormitorio femminile', 'male_only': 'dormitorio maschile', 'mixed': 'dormitorio misto', 'flexible': 'dormitorio condiviso'}, 'de': {'female_only': 'Frauenzimmer', 'male_only': 'Männerzimmer', 'mixed': 'gemischten Zimmer', 'flexible': 'Mehrbettzimmer'},
    }
    labels = labels_by_language.get(language, labels_by_language['en'])
    strategy = str(room.get('gender_strategy') or '').strip().lower().replace(' ', '_')
    # Staff gender_strategy is free text. A preference is not an exclusivity
    # guarantee, so localize it as a neutral shared room rather than overstating
    # it as women-only or men-only.
    strategy = {'female_preferred': 'flexible', 'male_preferred': 'flexible'}.get(strategy, strategy)
    return labels.get(strategy, labels['flexible'])


def _plural_room_kind(kind, language='en'):
    """Pluralize only our fixed guest-facing room labels."""
    plurals = {
        'en': {"women's room": "women's rooms", "men's room": "men's rooms",
               'mixed room': 'mixed rooms', 'shared room': 'shared rooms'},
        'es': {'habitación femenina': 'habitaciones femeninas',
               'habitación masculina': 'habitaciones masculinas',
               'habitación mixta': 'habitaciones mixtas',
               'habitación compartida': 'habitaciones compartidas'},
        'fr': {'chambre pour femmes': 'chambres pour femmes',
               'chambre pour hommes': 'chambres pour hommes',
               'chambre mixte': 'chambres mixtes',
               'chambre partagée': 'chambres partagées'},
        'it': {'dormitorio femminile': 'dormitori femminili', 'dormitorio maschile': 'dormitori maschili', 'dormitorio misto': 'dormitori misti', 'dormitorio condiviso': 'dormitori condivisi'}, 'de': {'Frauenzimmer': 'Frauenzimmern', 'Männerzimmer': 'Männerzimmern',
               'gemischten Zimmer': 'gemischten Zimmern', 'Mehrbettzimmer': 'Mehrbettzimmern'},
    }
    return plurals.get(language, plurals['en']).get(kind, kind)


def _requested_room_change_line(plan, offer, language='en'):
    preference = str(plan.get('room_preference') or '').strip()
    match = re.fullmatch(r'(?:room|r)\s*[-_ ]?\s*(\d+)', preference, re.IGNORECASE)
    if not match:
        return None
    requested = f'R{int(match.group(1))}'
    allocated = []
    for row in offer.get('room_arrangement') or []:
        code = str((row or {}).get('room_code') or '').strip().upper()
        if code and code not in allocated:
            allocated.append(code)
    if not allocated or requested in allocated:
        return None
    room_word = {'en': 'Room', 'es': 'Habitación', 'fr': 'Chambre', 'it': 'Camera', 'de': 'Zimmer'}.get(language, 'Room')
    requested_label = f'{room_word} {int(match.group(1))}'
    allocated_labels = ', '.join(f'{room_word} {code[1:]}' if re.fullmatch(r'R\d+', code) else code
                                 for code in allocated)
    templates = {
        'en': f'{requested_label} is not available for these dates, so this quote is for {allocated_labels}.',
        'es': f'{requested_label} no está disponible para estas fechas, así que este presupuesto es para {allocated_labels}.',
        'fr': f'{requested_label} n’est pas disponible à ces dates, donc ce devis est pour {allocated_labels}.',
        'it': f'{requested_label} non è disponibile per queste date, quindi questo preventivo è per {allocated_labels}.', 'de': f'{requested_label} ist für diese Daten nicht verfügbar, daher gilt dieses Angebot für {allocated_labels}.',
    }
    return templates.get(language, templates['en'])


def _guest_room_lines(plan, offer, language='en'):
    """Group people by frozen room and disclose an authoritative room split."""
    rooms = {row['bed_code']: row for row in offer['room_arrangement']}
    assignments = offer.get('guest_bed_assignments')
    if isinstance(assignments, list) and assignments:
        guests = []
        selected_bed_codes = []
        plan_guests = plan.get('guests') if isinstance(plan.get('guests'), list) else []
        for assignment in assignments:
            if not isinstance(assignment, dict) or assignment.get('bed_code') not in rooms:
                continue
            guest_index = assignment.get('guest_index')
            fallback_name = (plan_guests[guest_index].get('name')
                             if type(guest_index) is int and 0 <= guest_index < len(plan_guests)
                             and isinstance(plan_guests[guest_index], dict) else '')
            authoritative_name = assignment.get('guest_name') or ''
            # The checked offer binds the person to the bed by guest_index. Use
            # the guest's spelling only while that same slot still identifies
            # the authoritative person; stale rosters cannot relabel a bed.
            normalized_fallback = unicodedata.normalize(
                'NFC', ' '.join(str(fallback_name or '').split())).casefold()
            normalized_authoritative = unicodedata.normalize(
                'NFC', ' '.join(str(authoritative_name).split())).casefold()
            display_name = (fallback_name if normalized_fallback
                            and normalized_fallback == normalized_authoritative
                            else authoritative_name)
            guests.append({'name': display_name})
            selected_bed_codes.append(assignment['bed_code'])
    else:
        guests = plan.get('guests') if isinstance(plan.get('guests'), list) else []
        selected_bed_codes = (plan.get('selected_bed_codes')
                              if isinstance(plan.get('selected_bed_codes'), list) else [])
    groups = []
    index = {}
    for guest, code in zip(guests, selected_bed_codes):
        room = rooms.get(code)
        if not isinstance(room, dict):
            continue
        kind = _room_kind(offer, room, language)
        key = (room.get('room_code'), kind)
        if key not in index:
            index[key] = len(groups)
            groups.append({'kind': kind, 'room': room.get('room_code'), 'names': [], 'beds': 0})
        groups[index[key]]['beds'] += 1
        name = guest.get('name') if isinstance(guest, dict) else ''
        if isinstance(name, str) and name.strip():
            groups[index[key]]['names'].append(name.strip())
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
        if _has_private_room(offer):
            # Staff's bed codes represent allocated places, not physical beds.
            # Private sale alone does not certify a double/twin configuration.
            for position, item in enumerate(same):
                who = (_join_names(item['names'], language)
                       if len(item['names']) == item['beds'] else
                       _guest_count_label(item['beds'], language))
                labels = {
                    'en': ('Private room', 'Another private room', 'for'),
                    'es': ('Habitación privada', 'Otra habitación privada', 'para'),
                    'it': ('Camera privata', 'Un’altra camera privata', 'per'),
                    'fr': ('Chambre privée', 'Une autre chambre privée', 'pour'),
                    'de': ('Privatzimmer', 'Ein weiteres Privatzimmer', 'für'),
                }
                first_label, other_label, preposition = labels.get(language, labels['en'])
                lines.append(f'{other_label if position else first_label} {preposition} {who}.')
            continue
        if len(same) > 1 and all(len(item['names']) <= 1 for item in same):
            names = [name for item in same for name in item['names']]
            all_guests_named = len(names) == sum(item['beds'] for item in same)
            count = _count_word(len(same), language)
            plural_kind = _plural_room_kind(kind, language)
            who = _join_names(names, language) if all_guests_named else ''
            templates = {
                'en': (f'{who} have beds in {count} separate {plural_kind}.' if who
                       else f'Beds in {count} separate {plural_kind}.'),
                'es': (f'{who} tienen camas en {count} {plural_kind} separadas.' if who
                       else f'Camas en {count} {plural_kind} separadas.'),
                'fr': (f'{who} ont des lits dans {count} {plural_kind} séparées.' if who
                       else f'Lits dans {count} {plural_kind} séparées.'),
                'it': (f'{who} hanno posti letto in {count} {plural_kind} separati.' if who else f'Posti letto in {count} {plural_kind} separati.'), 'de': (f'{who} haben Betten in {count} getrennten {plural_kind}.' if who
                       else f'Betten in {count} getrennten {plural_kind}.'),
            }
            lines.append(templates.get(language, templates['en']))
            continue
        first = True
        for item in same:
            names = item['names'] if len(item['names']) == item['beds'] else []
            who = _join_names(names, language)
            beds = item['beds']
            n = _count_word(beds, language)
            # A numbered room is useful guest-facing identity (unlike a bed
            # code). Disclose it only when Staff supplied it authoritatively.
            room_code = str(item.get('room') or '').strip().upper()
            requested_match = re.fullmatch(
                r'(?:room|r)\s*[-_ ]?\s*(\d+)',
                str(plan.get('room_preference') or '').strip(), re.IGNORECASE)
            room_suffix = (f" (Room {room_code[1:]})"
                           if requested_match and room_code == f'R{int(requested_match.group(1))}'
                           else '')
            # Ty-approved guest copy does not label a one-person stay with
            # ``Name:``. Keep the identity naturally in the sentence instead.
            singleton = (offer.get('guest_count', plan.get('guest_count')) == 1
                         or sum(entry['beds'] for entry in groups) == 1)
            prefix = f'{who}: ' if who and not singleton else ''
            natural_name = ({'es': f' para {who}', 'fr': f' pour {who}', 'it': f' per {who}', 'de': f' für {who}'}.get(language, f' for {who}')
                            if who and singleton else '')
            if language != 'en':
                if beds == 1:
                    if language == 'it':
                        where = f'un {kind}' if first else f'un altro {kind}'
                        line = f'{prefix}un letto in {where}{natural_name}.'
                    elif who and language == 'fr':
                        where = f'une {kind}' if first else f'une autre {kind}'
                        line = f'{who} a un lit dans {where}.'
                    elif who and language == 'de':
                        where = f'einem {kind}' if first else f'einem anderen {kind}'
                        line = f'{who} hat ein Bett in {where}.'
                    else:
                        line = {'es': f'{prefix}una cama en una {kind}{natural_name}.',
                                'fr': f'{prefix}un lit dans une {kind}{natural_name}.',
                                'it': f'{prefix}un letto in un {kind}{natural_name}.', 'de': f'{prefix}ein Bett in einem {kind}{natural_name}.'}[language]
                else:
                    line = {
                        'es': (f'{who} tienen {n} camas en la misma {kind}.' if who
                               else f'{n} camas en la misma {kind}.'),
                        'fr': (f'{who} ont {n} lits dans la même {kind}.' if who
                               else f'{n} lits dans la même {kind}.'),
                        'it': (f'{who} hanno {n} letti nello stesso {kind}.' if who else f'{n} letti nello stesso {kind}.'), 'de': (f'{who} haben {n} Betten im selben {kind}.' if who
                               else f'{n} Betten im selben {kind}.'),
                    }[language]
                if len(same) > 1 and not first and language == 'es':
                    line = f'{who}: {n if beds > 1 else "una"} cama' + ('s' if beds > 1 else '') + f' en otra {kind}.'
                elif len(same) > 1 and not first and beds > 1:
                    line = {
                        'fr': f'{who} ont {n} lits dans une autre {kind}.',
                        'it': (f'{who} hanno {n} letti in un altro {kind}.' if who else f'{n} letti in un altro {kind}.'), 'de': f'{who} haben {n} Betten in einem anderen {kind}.',
                    }[language]
                lines.append(line)
                first = False
                continue
            if len(same) == 1 and beds == 1:
                lines.append(f"{prefix}one bed in a {kind}{room_suffix}{natural_name}.")
            elif len(same) == 1:
                lines.append((f"{who} have {_count_word(beds)} beds in the same {kind}{room_suffix}."
                              if who else f"{_count_word(beds)} beds in the same {kind}{room_suffix}."))
            elif beds == 1:
                where = f"the {kind}" if first else f"a separate {kind}"
                lines.append(f"{who}: a bed in {where}{room_suffix}.")
            else:
                where = f"the same {kind}" if first else f"a separate {kind}"
                lines.append(f"{who}: {_count_word(beds)} beds in {where}{room_suffix}.")
            first = False
    return [line[:1].upper() + line[1:] for line in lines]


def _guest_language(state):
    """Use the owner-observed guest locale; explicit internal hints are fallback only."""
    observed = str(state.get('guest_language') or '').strip().casefold()
    if observed in ('en', 'es', 'fr', 'de', 'it'):
        return observed
    plan = _presentation_plan(state)
    authoritative = str(plan.get('language') or '').strip().casefold() if isinstance(plan, dict) else ''
    aliases = {'english': 'en', 'spanish': 'es', 'español': 'es', 'french': 'fr',
               'français': 'fr', 'german': 'de', 'deutsch': 'de', 'italian': 'it', 'italiano': 'it'}
    authoritative = aliases.get(authoritative, authoritative.split('-', 1)[0])
    return authoritative if authoritative in ('en', 'es', 'fr', 'de', 'it') else 'en'


def _style_copy(language):
    from .guest_copy import copy as guest_copy
    copy = guest_copy(language)
    return {key: copy[f'quote_style_{key}'] for key in (
        'opener','dates','room','package','guests','total','booking','saved','saved_anon','invoice_saved','invoice_saved_anon','deposit_due','deposit_choice','group_payment_choice','shuttle_choice','save','save_updated','remaining','balance','due','link','guest','guests_word','opener_group','deposit_choice_group','save_group','save_updated_group')}


from .output_guard import format_reply_text as _whatsapp_emphasis
from . import pending_question


def _guest_money(cents, currency='EUR'):
    """Render guest-facing money without accounting-style trailing zeroes."""
    amount = f'{cents / 100:.2f}'.rstrip('0').rstrip('.')
    return f'€{amount}' if currency == 'EUR' else f'{amount} {currency}'


def _styled_room_value(plan, offer, language):
    """One natural, authoritative room value; never expose bed/internal codes."""
    lines = _guest_room_lines(plan, offer, language)
    count = offer.get('guest_count', plan.get('guest_count'))
    if count == 1 and offer.get('room_arrangement'):
        room = offer['room_arrangement'][0]
        kind = _room_kind(offer, room, language)
        room_code = str(room.get('room_code') or '').strip().upper()
        room_words = {'en': 'Room', 'es': 'Habitación', 'fr': 'Chambre', 'it': 'Camera', 'de': 'Zimmer'}
        room_suffix = (f" ({room_words.get(language, 'Room')} {room_code[1:]})"
                       if re.fullmatch(r'R\d+', room_code) else '')
        private = offer.get('room_type') == 'private'
        if language == 'es':
            return ('Habitación privada' if private else f'Una cama en nuestra {kind}') + room_suffix
        if language == 'fr':
            return ('Chambre privée' if private else f'Un lit dans notre {kind}') + room_suffix
        if language == 'it':
            return ('Camera privata' if private else f'Un letto nel nostro {kind}') + room_suffix
        if language == 'de':
            return ('Privatzimmer' if private else f'Ein Bett in unserem {kind}') + room_suffix
        if private:
            return 'Private room' + room_suffix
        adjective = 'mixed shared room' if kind == 'mixed room' else kind
        return f'A bed in our {adjective}{room_suffix}'
    return '. '.join(line.rstrip('.') for line in lines)


def _styled_dates_value(plan, offer, language, *, include_nights=False):
    check_in = offer.get('check_in') or plan.get('check_in')
    check_out = offer.get('check_out') or plan.get('check_out')
    value = f'{_plain_stay_date(check_in, language)} – {_plain_stay_date(check_out, language)}'
    count = offer.get('guest_count', plan.get('guest_count'))
    if not include_nights and type(count) is int:
        copy = _style_copy(language)
        value += f" · {count} {copy['guest'] if count == 1 else copy['guests_word']}"
    if include_nights:
        try:
            nights = (date.fromisoformat(check_out) - date.fromisoformat(check_in)).days
        except (TypeError, ValueError):
            nights = None
        if type(nights) is int and nights >= 0:
            night_word = {'es': ('noche', 'noches'), 'fr': ('nuit', 'nuits'),
                          'it': ('notte', 'notti'), 'de': ('Nacht', 'Nächte')}.get(language, ('night', 'nights'))
            value += f" ({nights} {night_word[0] if nights == 1 else night_word[1]})"
    return value


_EXTRA_LABELS = {
        'room_supplement': {'en': 'Private room supplement', 'es': 'Suplemento de habitación privada',
                            'fr': 'Supplément chambre privée', 'it': 'Supplemento camera privata', 'de': 'Privatzimmerzuschlag'},
        'yoga_class': {'en': 'Yoga class', 'es': 'Clase de yoga', 'fr': 'Cours de yoga', 'it': 'Lezione di yoga', 'de': 'Yogastunde'},
        'surf_lesson_single': {'en': 'Surf lesson', 'es': 'Clase de surf', 'fr': 'Cours de surf', 'it': 'Lezione di surf', 'de': 'Surfstunde'},
        'surf_lesson_multi': {'en': 'Surf lessons', 'es': 'Clases de surf', 'fr': 'Cours de surf', 'it': 'Lezioni di surf', 'de': 'Surfstunden'},
        'soft_top_rental': {'en': 'Soft board rental', 'es': 'Alquiler de tabla blanda', 'fr': 'Location de planche soft', 'it': 'Noleggio tavola morbida', 'de': 'Softboard-Miete'},
        'hard_board_rental': {'en': 'Hard board rental', 'es': 'Alquiler de tabla rígida', 'fr': 'Location de planche rigide', 'it': 'Noleggio tavola rigida', 'de': 'Hardboard-Miete'},
        'wetsuit_rental': {'en': 'Wetsuit rental', 'es': 'Alquiler de neopreno', 'fr': 'Location de combinaison', 'it': 'Noleggio muta', 'de': 'Neoprenanzug-Miete'},
        'meals': {'en': 'Meals', 'es': 'Comidas', 'fr': 'Repas', 'it': 'Pasti', 'de': 'Mahlzeiten'},
    'wetsuit_soft_top_combo': {'en': 'Wetsuit and soft board rental', 'es': 'Alquiler de neopreno y tabla blanda', 'fr': 'Location de combinaison et planche soft', 'it': 'Noleggio muta e tavola morbida', 'de': 'Neoprenanzug- und Softboard-Miete'},
    'wetsuit_hard_board_combo': {'en': 'Wetsuit and hard board rental', 'es': 'Alquiler de neopreno y tabla rígida', 'fr': 'Location de combinaison et planche rigide', 'it': 'Noleggio muta e tavola rigida', 'de': 'Neoprenanzug- und Hardboard-Miete'},
}


def _quoted_deposit_line(offer, language, currency, due_now=None):
    """Explain Staff's quoted (possibly capped) deposit, never infer its tariff."""
    deposit = offer.get('deposit_required_cents')
    if type(deposit) is not int or deposit < 0:
        return None
    # Once full payment is selected, the historical quoted deposit is not part
    # of the chosen-payment summary.
    if offer.get('payment_choice') == 'full':
        return None
    if offer.get('payment_choice') == 'deposit' and deposit == due_now:
        return None  # The due-now deposit line already states this exact fact.
    labels = {
        'en': ('Quoted deposit', 'per person'),
        'es': ('Depósito del presupuesto', 'por persona'),
        'it': ('Acconto del preventivo', 'a persona'),
        'fr': ('Acompte du devis', 'par personne'),
        'de': ('Anzahlung laut Angebot', 'pro Person'),
    }
    label, per_person = labels.get(language, labels['en'])
    value = _guest_money(deposit, currency)
    people = offer.get('per_person')
    count = offer.get('guest_count')
    if (isinstance(people, list) and type(count) is int and count > 0
            and len(people) == count
            and all(isinstance(row, dict) and type(row.get('guest_number')) is int
                    and type(row.get('deposit_cents')) is int and row['deposit_cents'] >= 0
                    for row in people)
            and sorted(row['guest_number'] for row in people) == list(range(1, count + 1))
            and sum(row['deposit_cents'] for row in people) == deposit):
        amounts = {row['deposit_cents'] for row in people}
        if len(amounts) == 1:
            value += f" ({_guest_money(people[0]['deposit_cents'], currency)} {per_person} × {count})"
    return f'💳 *{label}:* {value}'


def _staff_deposit_terms(offer, language, currency, due_now):
    """Display only guest-safe payment terms; the quoted deposit is rendered above."""
    del currency
    arrival = offer.get('payment_choice') == 'pay_on_arrival'
    lines = []
    if arrival and type(due_now) is int and due_now == 0:
        lines.append({
            'en': 'No payment is due now.',
            'es': 'No hay ningún pago pendiente ahora.',
            'it': 'Nessun pagamento è dovuto ora.',
            'fr': 'Aucun paiement n’est dû maintenant.',
            'de': 'Jetzt ist keine Zahlung fällig.',
        }.get(language, 'No payment is due now.'))
    if arrival and offer.get('staff_review_required') is True:
        lines.append({
            'en': 'Payment on arrival still needs review; that arrangement is not confirmed yet.',
            'es': 'El pago a la llegada aún necesita revisión; esa modalidad todavía no está confirmada.',
            'it': 'Il pagamento all’arrivo richiede ancora una verifica; questa modalità non è ancora confermata.',
            'fr': 'Le paiement à l’arrivée nécessite encore une vérification ; cette modalité n’est pas encore confirmée.',
            'de': 'Die Zahlung bei Ankunft erfordert noch eine Prüfung; diese Zahlungsart ist noch nicht bestätigt.',
        }.get(language, 'Payment on arrival still needs review; that arrangement is not confirmed yet.'))
    return lines


def _styled_quote_copy(plan, offer, language='en', *, create_ready=True, updated=False):
    """Render provisional or checked Staff terms in Ty-approved WhatsApp style."""
    copy = _style_copy(language)
    party_count = offer.get('guest_count', plan.get('guest_count'))
    if language == 'de' and type(party_count) is int and party_count > 1:
        copy = {**copy, 'opener': copy['opener_group'],
                'deposit_choice': copy['deposit_choice_group'],
                'save': copy['save_group'], 'save_updated': copy['save_updated_group']}
    currency = offer.get('currency') or 'EUR'
    total = offer.get('total_cents')
    lines = [copy['opener'],
             f"📅 *{copy['dates']}:* {_styled_dates_value(plan, offer, language)}",
             f"🛏️ *{copy['room']}:* {_styled_room_value(plan, offer, language)}"]
    substitution = _requested_room_change_line(plan, offer, language)
    if substitution:
        lines.append(substitution)
    package_code = offer.get('package_code') or plan.get('package_code')
    offer_guest_packages = offer.get('guest_packages')
    offer_packages_valid = (isinstance(offer_guest_packages, list)
                            and all(isinstance(row, dict)
                                    and isinstance(identifier := row.get('package_code') or row.get('code'), str)
                                    and bool(identifier.strip())
                                    for row in offer_guest_packages))
    guest_packages = offer_guest_packages if offer_packages_valid else plan.get('guest_packages')
    guests = offer.get('guests') or plan.get('guests') or []
    guests = guests if isinstance(guests, list) else []
    def package_label(code):
        if code in ('package_none', 'none', 'accommodation_only', 'no_package'):
            return None
        return str(code).removeprefix('package_').replace('_', ' ').title()
    values = []
    if isinstance(guest_packages, list) and guest_packages:
        for index, row in enumerate(guest_packages):
            if not isinstance(row, dict):
                continue
            guest_index = row.get('guest_index')
            if type(guest_index) is not int:
                guest_number = row.get('guest_number')
                guest_index = guest_number - 1 if type(guest_number) is int else index
            code = row.get('package_code') or row.get('code')
            name = (guests[guest_index].get('name') if type(guest_index) is int and 0 <= guest_index < len(guests) and isinstance(guests[guest_index], dict) else f"{copy['guest']} {guest_index + 1}")
            if code and (label := package_label(code)):
                values.append(f"{name}: {label}")
    if values:
        lines.append(f"🏄 *{copy['package']}:* " + '; '.join(values))
    elif package_code and (label := package_label(package_code)):
        lines.append(f"🏄 *{copy['package']}:* {label}")
    offer_extras = offer.get('add_ons')
    offer_extras_valid = (isinstance(offer_extras, list)
                          and all(isinstance(row, dict)
                                  and isinstance(identifier := row.get('code') or row.get('service_code'), str)
                                  and bool(identifier.strip())
                                  for row in offer_extras))
    plan_extras = plan.get('add_ons')
    extras = offer_extras if offer_extras_valid else plan_extras
    if isinstance(extras, list) and extras:
        values = []
        for row in extras:
            if not isinstance(row, dict): continue
            code = row.get('code') or row.get('service_code')
            if code:
                quantity = row.get('quantity')
                days = row.get('days')
                priced = [item for item in (offer.get('included_items') or [])
                          if isinstance(item, dict) and item.get('code') == code]
                if (len(priced) == 1 and type(priced[0].get('days')) is int
                        and priced[0]['days'] > 0):
                    days = priced[0]['days']
                    quantity = priced[0].get('quantity', priced[0].get('people_count', quantity))
                if type(days) is not int and extras is offer_extras and isinstance(plan_extras, list):
                    plan_row = next((candidate for candidate in plan_extras
                                     if isinstance(candidate, dict)
                                     and (candidate.get('code') or candidate.get('service_code')) == code), None)
                    if plan_row is not None and type(plan_row.get('days')) is int:
                        days = plan_row['days']
                count = quantity
                if type(count) is not int:
                    count = 1
                if count <= 0:
                    continue
                label = _EXTRA_LABELS.get(str(code), {}).get(language)
                if not label:
                    # Unknown catalog codes are not English guest-facing labels.
                    label = copy['package']
                if type(days) is int and days > 0:
                    duration = {
                        'en': f'for {days} {"day" if days == 1 else "days"}',
                        'es': f'durante {days} {"día" if days == 1 else "días"}',
                        'fr': f'pour {days} {"jour" if days == 1 else "jours"}',
                        'it': f'per {days} {"giorno" if days == 1 else "giorni"}', 'de': f'für {days} {"Tag" if days == 1 else "Tage"}',
                    }.get(language, f'for {days} {"day" if days == 1 else "days"}')
                    quantity_text = f' × {quantity}' if type(quantity) is int and quantity > 0 else ''
                    values.append(f'{label}{quantity_text} {duration}')
                else:
                    values.append(f'{label} ×{count}' if count != 1 else label)
        if values: lines.append(f"🌊 *{copy['package']}:* " + ', '.join(values))
    supplement_rows = [row for row in (offer.get('included_items') or [])
                       if isinstance(row, dict) and row.get('code') == 'room_supplement']
    if offer.get('room_type') == 'private' and len(supplement_rows) == 1:
        supplement = supplement_rows[0].get('total_cents')
        if type(supplement) is int and supplement > 0:
            supplement_label = {
                'en': 'Private room supplement',
                'es': 'Suplemento de habitación privada',
                'fr': 'Supplément chambre privée',
                'it': 'Supplemento camera privata', 'de': 'Privatzimmerzuschlag',
            }.get(language, 'Private room supplement')
            lines.append(f"➕ *{supplement_label}:* {_guest_money(supplement, currency)}")
    if type(total) is int:
        due = offer.get('payment_link_amount_cents')
        full_only = (offer.get('full_payment_only') is True
                     and type(due) is int and due == total and total >= 0)
        if full_only:
            labels = {
                'en': ('Total and due now', 'full payment'),
                'es': ('Total y a pagar ahora', 'pago completo'),
                'fr': ('Total et à payer maintenant', 'paiement intégral'),
                'it': ('Totale da pagare ora', 'pagamento completo'), 'de': ('Gesamtpreis und jetzt fällig', 'vollständige Zahlung'),
            }
            timing, full = labels.get(language, labels['en'])
            lines.append(f"💶 *{timing}:* {_guest_money(total, currency)} ({full})")
        else:
            lines.append(f"💶 *{copy['total']}:* {_guest_money(total, currency)}")
        deposit_line = _quoted_deposit_line(offer, language, currency, due if create_ready else None)
        if deposit_line:
            lines.append(deposit_line)
        lines.extend(_staff_deposit_terms(offer, language, currency, due if create_ready else None))
        if create_ready:
            if type(due) is int and due >= 0:
                payment_choice = offer.get('payment_choice')
                if not full_only:
                    # Amount is code-owned truth. Internal payment enums are not guest copy.
                    lines.append(f"💳 *{copy['due']}:* {_guest_money(due, currency)}")
                remaining = total - due
                if remaining > 0:
                    remaining_label = (copy['balance']
                                       if due == 0 and payment_choice == 'pay_on_arrival'
                                       and offer.get('staff_review_required') is not True
                                       else copy['balance'] if due == 0 else copy['remaining'])
                    lines.append(f"⏳ *{remaining_label}:* {_guest_money(remaining, currency)}")
    if create_ready and offer.get('payment_choice') == 'per_guest':
        guests = offer.get('guests') or plan.get('guests') or []
        guests = guests if isinstance(guests, list) else []
        valid_guests = [row for row in guests if isinstance(row, dict)
                        and isinstance(row.get('name'), str) and row.get('name').strip()]
        expected_names = [row['name'].strip() for row in valid_guests]
        expected_keys = [name.casefold() for name in expected_names]
        unique_roster = (len(valid_guests) == len(guests)
                         and len(set(expected_keys)) == len(expected_keys))
        distribution = offer.get('payment_distribution')
        values = []
        amounts = []
        if isinstance(distribution, list) and distribution:
            for index, row in enumerate(distribution):
                if not isinstance(row, dict):
                    continue
                amount = row.get('amount_due_cents')
                if type(amount) is not int:
                    amount = row.get('amount_cents')
                name = str(row.get('guest_name') or '').strip()
                if not name and index < len(guests) and isinstance(guests[index], dict):
                    name = str(guests[index].get('name') or '').strip()
                row_currency = row.get('currency') or currency
                if name and type(amount) is int and amount >= 0 and row_currency == currency:
                    values.append(f'{name}: {_guest_money(amount, currency)}')
                    amounts.append(amount)
            shown_names = [value.split(':', 1)[0].strip().casefold() for value in values]
            due = offer.get('payment_link_amount_cents')
            if (not unique_roster or len(values) != len(distribution)
                    or len(set(shown_names)) != len(shown_names)
                    or sorted(shown_names) != sorted(expected_keys)
                    or (type(due) is int and sum(amounts) != due)):
                values = []
        elif (offer.get('per_guest_payment_links') is True and valid_guests
              and unique_roster
              and type(total) is int and total % len(valid_guests) == 0):
            share = _guest_money(total // len(valid_guests), currency)
            values = [f"{row['name'].strip()}: {share}" for row in valid_guests]
        if values:
            lines.append(f"💳 *{copy['due']}:* " + '; '.join(values))
    question = copy['save_updated' if updated else 'save'] if create_ready else None
    if not create_ready and type(offer.get('deposit_required_cents')) is int and type(total) is int:
        package_code = str(offer.get('package_code') or plan.get('package_code') or '').strip()
        party_size = offer.get('guest_count', plan.get('guest_count'))
        package_codes = [package_code]
        package_codes.extend(
            str(row.get('package_code') or row.get('code') or '').strip()
            for row in (plan.get('guest_packages') or []) if isinstance(row, dict))
        package_selected = any(code and code not in (
            'package_none', 'none', 'accommodation_only', 'no_package') for code in package_codes)
        shuttle_resolved = (
            plan.get('shuttle_needed') is False
            or plan.get('needs_shuttle') is False
            or str(plan.get('shuttle_choice') or '').strip().casefold()
            in ('yes', 'accepted', 'wanted', 'no', 'none', 'declined', 'not_needed'))
        if package_selected and not shuttle_resolved:
            # Package stays ask once about the unresolved shuttle before payment.
            question = copy['shuttle_choice']
        elif offer['deposit_required_cents'] >= total:
            question = copy['save']
        elif (type(party_size) is int and party_size >= 2
              and 'per_guest_payment_links' not in plan):
            question = copy['group_payment_choice']
        else:
            question = copy['deposit_choice'].format(
                deposit=_guest_money(offer['deposit_required_cents'], currency),
                total=_guest_money(total, currency))
    if question:
        lines.extend(['', question])
    return _whatsapp_emphasis('\n'.join(lines))


def _usable_payment_url(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = urlsplit(value.strip())
        hostname = parsed.hostname
    except ValueError:
        return None
    return value.strip() if parsed.scheme == 'https' and bool(hostname) else None


def _staff_invoice_lines(plan, offer, language, currency):
    """Render only a complete, arithmetically self-consistent Staff breakdown."""
    people = offer.get('per_person')
    items = offer.get('included_items')
    total = offer.get('total_cents')
    count = offer.get('guest_count', plan.get('guest_count'))
    if (not isinstance(people, list) or not isinstance(items, list)
            or type(total) is not int or type(count) is not int
            or count < 1 or len(people) != count):
        return []
    guests = plan.get('guests') if isinstance(plan.get('guests'), list) else []
    if any(not isinstance(row, dict) for row in items):
        return []
    base_codes = {'package', 'package_proration', 'accommodation_only', 'manual_accommodation'}
    guest_base_codes = {f'guest_{code}' for code in base_codes}
    recognized_base_codes = base_codes | guest_base_codes
    base_items = [row for row in items if row.get('code') in recognized_base_codes]
    extra_items = [row for row in items if row not in base_items]
    if not base_items or any(str(row.get('code') or '').startswith('guest_')
                             for row in extra_items):
        return []
    generic_base = [row for row in base_items if row.get('guest_number') is None]
    numbered_base = [row for row in base_items if row.get('guest_number') is not None]
    if ((generic_base and (len(generic_base) != 1 or numbered_base))
            or (numbered_base and len(numbered_base) != count)):
        return []
    numbered_by_guest = {}
    for row in numbered_base:
        number = row.get('guest_number')
        if type(number) is not int or not 1 <= number <= count or number in numbered_by_guest:
            return []
        numbered_by_guest[number] = row
    lines = []
    accommodation_total = 0
    for index, person in enumerate(people):
        if not isinstance(person, dict):
            return []
        number = person.get('guest_number')
        accommodation = person.get('accommodation_cents')
        package = person.get('package_code')
        if type(number) is not int or number != index + 1 or type(accommodation) is not int or accommodation < 0:
            return []
        source = numbered_by_guest.get(number) or (generic_base[0] if generic_base else None)
        nights = source.get('nights') if isinstance(source, dict) else None
        unit = source.get('unit_cents') if isinstance(source, dict) else None
        source_count = source.get('guest_count') if isinstance(source, dict) else None
        source_total = source.get('total_cents') if isinstance(source, dict) else None
        source_guest_number = source.get('guest_number') if isinstance(source, dict) else None
        source_multiplier = source_count if source_guest_number is None else 1
        if (type(nights) is not int or nights < 1 or type(unit) is not int or unit < 0
                or type(source_total) is not int or source_total < 0
                or type(source_multiplier) is not int or source_multiplier < 1
                or unit * nights * source_multiplier != source_total
                or unit * nights != accommodation
                or (source_guest_number is None and source_count != count)
                or (source_guest_number is not None and source_count != 1)
                or (source_guest_number is not None
                    and (source or {}).get('package_code') != package)):
            return []
        guest = guests[index] if index < len(guests) and isinstance(guests[index], dict) else {}
        name = str(guest.get('name') or '').strip()
        if not name:
            name = f"{_style_copy(language)['guest']} {number}"
        package_label = (str(package).removeprefix('package_').replace('_', ' ').title() if package in
                         ('package_none', 'none', 'accommodation_only', 'no_package')
                         else str(package or '').removeprefix('package_').replace('_', ' ').title())
        if not package_label:
            return []
        night_words = {'es': ('noche', 'noches'), 'fr': ('nuit', 'nuits'),
                       'it': ('notte', 'notti'), 'de': ('Nacht', 'Nächte')}.get(language, ('night', 'nights'))
        night_label = night_words[0] if nights == 1 else night_words[1]
        lines.append(f"• {name} · {package_label} · {nights} {night_label} × "
                     f"{_guest_money(unit, currency)} = {_guest_money(accommodation, currency)}")
        subtotal = person.get('subtotal_cents')
        if type(subtotal) is not int or subtotal < accommodation:
            return []
        accommodation_total += accommodation
    labels = _EXTRA_LABELS
    extras_total = 0
    for row in extra_items:
        code = row.get('code')
        label = labels.get(code, {}).get(language)
        unit = row.get('unit_cents')
        amount = row.get('total_cents')
        if not label or type(unit) is not int or unit < 0 or type(amount) is not int or amount < 0:
            return []
        if code == 'room_supplement':
            quantity = row.get('nights')
            unit_text = {'en': 'night', 'es': 'noche', 'fr': 'nuit', 'it': 'notte', 'de': 'Nacht'}[language]
            unit_text += '' if quantity == 1 else {'en': 's', 'es': 's', 'fr': 's', 'it': '', 'de': 'e'}[language]
            if language == 'it':
                unit_text = 'notte' if quantity == 1 else 'notti'
            prefix = f"{quantity} {unit_text}"
        elif type(row.get('days')) is int:
            quantity = row.get('quantity', row.get('people_count', 1))
            days = row['days']
            prefix = f"{quantity} × {days} " + {'en': 'days', 'es': 'días', 'fr': 'jours', 'it': 'giorni', 'de': 'Tage'}[language]
        else:
            quantity = row.get('quantity', 1)
            prefix = str(quantity)
        if type(quantity) is not int or quantity < 1:
            return []
        multiplier = quantity * (row.get('days') if type(row.get('days')) is int else 1)
        if multiplier * unit != amount:
            return []
        lines.append(f"• {label} · {prefix} × {_guest_money(unit, currency)} = "
                     f"{_guest_money(amount, currency)}")
        extras_total += amount
    subtotals_total = sum(person['subtotal_cents'] for person in people)
    return lines if (accommodation_total + extras_total == total
                     and subtotals_total == total) else []


def _styled_booking_receipt_copy(plan, offer, receipt, language='en'):
    """Render booking-saved truth without implying a payment was received."""
    copy = _style_copy(language)
    guests = plan.get('guests') if isinstance(plan.get('guests'), list) else []
    name = str((guests[0].get('name') if guests and isinstance(guests[0], dict) else '') or '').strip().split(' ')[0]
    headline = copy['saved'].format(name=name) if name else copy['saved_anon']
    reference = receipt.get('booking_code') or receipt.get('booking_id')
    currency = offer.get('currency') or receipt.get('currency') or 'EUR'
    total = offer.get('total_cents')
    invoice_lines = _staff_invoice_lines(plan, offer, language, currency)
    if invoice_lines:
        headline = (copy['invoice_saved'].format(name=name) if name
                    else copy['invoice_saved_anon'])
    # The current payment-link receipt is newer payment truth than the accepted
    # offer. Fall back to the offer only when no link amount was returned.
    split = receipt.get('guest_payment_links')
    if isinstance(split, list):
        linked = [row for row in split if isinstance(row, dict)
                  and _usable_payment_url(row.get('secure_payment_url') or row.get('guest_payment_url'))]
        valid = [row for row in linked if type(row.get('amount_due_cents')) is int
                 and row.get('amount_due_cents') >= 0
                 and str(row.get('currency') or currency).upper() == str(currency).upper()]
        paid_or_due = sum(row['amount_due_cents'] for row in valid) if valid else None
    else:
        paid_or_due = receipt.get('amount_due_cents')
    if type(paid_or_due) is not int and not isinstance(split, list):
        paid_or_due = offer.get('payment_link_amount_cents')
    if invoice_lines:
        lines = [headline, '', f"📌 *{copy['booking']}:* {reference}", '', *invoice_lines]
    else:
        lines = [headline, '', f"📌 *{copy['booking']}:* {reference}",
                 f"📅 *{copy['dates']}:* {_styled_dates_value(plan, offer, language, include_nights=True)}",
                 f"🛏️ *{copy['room']}:* {_styled_room_value(plan, offer, language)}",
                 f"👥 *{copy['guests']}:* {offer.get('guest_count', plan.get('guest_count'))}"]
    if type(total) is int:
        lines.append(f"💶 *{copy['total']}:* {_guest_money(total, currency)}")
        deposit_line = _quoted_deposit_line(offer, language, currency, paid_or_due)
        if deposit_line:
            lines.append(deposit_line)
        lines.extend(_staff_deposit_terms(offer, language, currency, paid_or_due))
        if type(paid_or_due) is int:
            payment_choice = str(offer.get('payment_choice') or plan.get('payment_choice') or '').strip().lower()
            due_label = copy['deposit_due'] if invoice_lines and payment_choice == 'deposit' else copy['due']
            lines.append(f"💳 *{due_label}:* {_guest_money(paid_or_due, currency)}")
            remaining = total - paid_or_due
            if remaining:
                remaining_label = (copy['balance']
                                   if paid_or_due == 0 and payment_choice == 'pay_on_arrival'
                                   and offer.get('staff_review_required') is not True
                                   else copy['balance'] if paid_or_due == 0 else copy['remaining'])
                lines.append(f"⏳ *{remaining_label}:* {_guest_money(remaining, currency)}")
        else:
            lines.append(f"⏳ *{copy['balance']}:* {_guest_money(total, currency)}")
    url = receipt.get('secure_payment_url')
    if isinstance(url, str) and url.strip():
        lines.extend(['', f"🔗 *{copy['link']}:* {url.strip()}"])
    return _whatsapp_emphasis('\n'.join(lines))


def _blocked_clarification_copy(result, plan, language):
    """Render typed offerless outcomes without conflating package, room or stock."""
    result = result if isinstance(result, dict) else {}
    known_unavailable = (result.get('unavailable') is True
                         or result.get('availability_status') == 'unavailable')
    if known_unavailable:
        return None
    if result.get('package_choice_needed') is True:
        if (result.get('next_action') == 'offer_accommodation_or_change_dates'
                and result.get('package_eligible') is False):
            return {
                'en': 'This stay is not eligible for the requested package. Would you like an accommodation-only quote, or would you like to change the dates?',
                'es': 'Esta estancia no cumple los requisitos del paquete solicitado. ¿Quieres un presupuesto de solo alojamiento o prefieres cambiar las fechas?',
                'fr': 'Ce séjour n’est pas éligible au forfait demandé. Souhaitez-vous un devis d’hébergement seul ou modifier les dates ?',
                'it': 'Questo soggiorno non soddisfa i requisiti del pacchetto richiesto. Preferisci un preventivo per il solo pernottamento o vuoi cambiare le date?', 'de': 'Dieser Aufenthalt ist für das gewünschte Paket nicht berechtigt. Möchten Sie ein Angebot nur für die Unterkunft oder die Reisedaten ändern?',
            }[language]
        if result.get('next_action') == 'package_eligibility_unavailable':
            return {
                'en': "I couldn't retrieve the package options just now. Would you like an accommodation-only quote instead?",
                'es': 'No pude obtener ahora las opciones de paquete. ¿Quieres un presupuesto de solo alojamiento?',
                'fr': "Je n’ai pas pu obtenir les options de forfait pour le moment. Souhaitez-vous un devis d’hébergement seul ?",
                'it': 'Non sono riuscita a recuperare le opzioni dei pacchetti. Preferisci un preventivo per il solo pernottamento?', 'de': 'Ich konnte die Paketoptionen gerade nicht abrufen. Möchten Sie stattdessen ein Angebot nur für die Unterkunft?',
            }[language]
        packages = result.get('packages')
        if (result.get('next_action') == 'explain_packages_then_ask_choice'
                and isinstance(packages, dict)):
            options = []
            for code, details in packages.items():
                cents = details.get('total_cents') if isinstance(details, dict) else None
                if (isinstance(code, str) and code.strip() and type(cents) is int
                        and cents >= 0):
                    amount = f'{cents / 100:.2f}'.rstrip('0').rstrip('.')
                    description = str(details.get('includes_line') or '').strip()
                    label = f'{code.replace("_", " ").title()} (€{amount})'
                    options.append(f'{label}: {description}' if description else label)
            if options:
                intro = {
                    'en': 'The available Staff-checked options are ',
                    'es': 'Las opciones comprobadas disponibles son ',
                    'fr': 'Les options vérifiées disponibles sont ',
                    'it': 'Le opzioni disponibili verificate sono ', 'de': 'Die verfügbaren geprüften Optionen sind ',
                }[language]
                question = {
                    'en': 'Which package would you like for this stay?',
                    'es': '¿Qué paquete quieres para esta estancia?',
                    'fr': 'Quel forfait souhaitez-vous pour ce séjour ?',
                    'it': 'Quale pacchetto preferisci per questo soggiorno?', 'de': 'Welches Paket möchten Sie für diesen Aufenthalt?',
                }[language]
                return intro + ', '.join(options) + '. ' + question
        return {
            'en': 'Which package would you like for this stay?',
            'es': '¿Qué paquete quieres para esta estancia?',
            'fr': 'Quel forfait souhaitez-vous pour ce séjour ?',
            'it': 'Quale pacchetto preferisci per questo soggiorno?', 'de': 'Welches Paket möchten Sie für diesen Aufenthalt?',
        }[language]
    eligibility = result.get('room_eligibility') or result.get('room_decision')
    text = _structured_eligibility_copy(eligibility, plan, language)
    return text


def _structured_eligibility_copy(eligibility, plan, language):
    """Render Staff's structured room decision without classifying Staff prose."""
    if not isinstance(eligibility, dict):
        return None
    status = eligibility.get('status')
    room = eligibility.get('requested_room_preference')
    indices = eligibility.get('affected_guest_indices')
    if (status not in ('unsure', 'no') or room not in ('female_only', 'male_only')
            or not isinstance(indices, list) or not indices
            or (status == 'unsure'
                and eligibility.get('question_kind') != 'confirm_room_eligibility')):
        return None
    guests = plan.get('guests') if isinstance(plan, dict) else []
    guests = guests if isinstance(guests, list) else []
    names = []
    for index in indices:
        if type(index) is not int or index < 0:
            return None
        guest = guests[index] if index < len(guests) and isinstance(guests[index], dict) else {}
        names.append(str(guest.get('name') or '').strip())
    # A one-person party is still one person: address the affected slot rather
    # than presenting the grammatically plural "all guests" question.
    all_party = len(guests) > 1 and indices == list(range(len(guests)))
    partial_group = not all_party and len(indices) > 1
    partial_numbers = ''
    if all_party:
        subject = {'en': 'all guests', 'es': 'todas las personas', 'fr': 'toutes les personnes',
                   'it': 'tutti gli ospiti', 'de': 'alle Gäste'}[language]
    elif partial_group:
        joiner = {'en': ' and ', 'es': ' y ', 'fr': ' et ', 'it': ' e ', 'de': ' und '}[language]
        partial_numbers = joiner.join(str(index + 1) for index in indices)
        subject = {'en': f'guests {partial_numbers}', 'es': f'las personas {partial_numbers}',
                   'fr': f'les personnes {partial_numbers}', 'it': f'gli ospiti {partial_numbers}', 'de': f'Gäste {partial_numbers}'}[language]
    elif len(names) == 1 and names[0]:
        subject = names[0]
    else:
        numbers = ', '.join(str(index + 1) for index in indices)
        subject = {'en': f'guest {numbers}', 'es': f'la persona {numbers}',
                   'fr': f'la personne {numbers}', 'it': f'l’ospite {numbers}', 'de': f'Gast {numbers}'}[language]
    female = room == 'female_only'
    room_label = {
        'en': 'women-only room' if female else 'men-only room',
        'es': 'habitación solicitada solo para mujeres' if female else 'habitación solicitada solo para hombres',
        'fr': 'chambre demandée réservée aux femmes' if female else 'chambre demandée réservée aux hommes',
        'it': 'camera richiesta riservata alle donne' if female else 'camera richiesta riservata agli uomini', 'de': 'gewünschten Frauenzimmer' if female else 'gewünschten Männerzimmer',
    }[language]
    if status == 'unsure':
        if len(guests) == 1 and indices == [0]:
            return {
                'en': f'Just to confirm, are you a {"woman" if female else "man"}?',
                'es': f'Solo para confirmar, ¿eres {"mujer" if female else "hombre"}?',
                'fr': f'Juste pour confirmer, êtes-vous {"une femme" if female else "un homme"} ?',
                'it': f'Solo per confermare, sei {"una donna" if female else "un uomo"}?', 'de': f'Nur zur Bestätigung: Bist du {"eine Frau" if female else "ein Mann"}?',
            }[language]
        if len(indices) == 1:
            return {
                'en': f'Just to confirm, is {subject} a {"woman" if female else "man"}?',
                'es': f'Solo para confirmar, ¿{subject} es {"mujer" if female else "hombre"}?',
                'fr': f'Juste pour confirmer, {subject} est-{"elle une femme" if female else "il un homme"} ?',
                'it': f'Solo per confermare, {subject} è {"una donna" if female else "un uomo"}?', 'de': f'Nur zur Bestätigung: Ist {subject} {"eine Frau" if female else "ein Mann"}?',
            }[language]
        if all_party or partial_group:
            named = [name for name in names if name]
            if len(named) == len(indices):
                affected = _join_names(named, language)
            else:
                affected = subject
            return {
                'en': f'Just to confirm, are {affected} {"women" if female else "men"}?',
                'es': f'Solo para confirmar, ¿{affected} son {"mujeres" if female else "hombres"}?',
                'fr': f'Juste pour confirmer, {affected} sont-{"elles des femmes" if female else "ils des hommes"} ?',
                'it': f'Solo per confermare, {affected} sono {"donne" if female else "uomini"}?', 'de': f'Nur zur Bestätigung: Sind {affected} {"Frauen" if female else "Männer"}?',
            }[language]
        return {
            'en': f'Is {subject} eligible for the requested {room_label}?',
            'es': f'¿Puede {subject} alojarse en la {room_label}?',
            'fr': f'Est-ce que {subject} peut séjourner dans la {room_label} ?',
            'it': f'{subject} può soggiornare nella {room_label}?', 'de': f'Kann {subject} im {room_label} übernachten?',
        }[language]
    if all_party:
        details = {
            'en': 'the guest details provided',
            'es': 'los datos proporcionados de las personas',
            'fr': 'les informations fournies sur les personnes',
            'it': 'i dati forniti sugli ospiti', 'de': 'den angegebenen Gästedaten',
        }[language]
    elif partial_group:
        details = {
            'en': f'the guest details for guests {partial_numbers}',
            'es': f'los datos de las personas {partial_numbers}',
            'fr': f'les informations des personnes {partial_numbers}',
            'it': f'i dati degli ospiti {partial_numbers}', 'de': f'den Angaben zu den Gästen {partial_numbers}',
        }[language]
    else:
        details = {
            'en': f"{subject}'s guest details",
            'es': f'los datos de {subject}',
            'fr': f'les informations de {subject}',
            'it': f'i dati di {subject}', 'de': f'den Angaben zu {subject}',
        }[language]
    return {
        'en': f'The requested {room_label} is not compatible with {details}. Would you like to see other room options?',
        'es': f'La {room_label} no es compatible con {details}. ¿Quieres ver otras opciones de habitación?',
        'fr': f'La {room_label} n’est pas compatible avec {details}. Voulez-vous voir d’autres options de chambre ?',
        'it': f'La {room_label} non è compatibile con {details}. Vuoi vedere altre opzioni di camera?', 'de': f"Das {'gewünschte Frauenzimmer' if female else 'gewünschte Männerzimmer'} ist mit {details} nicht vereinbar. Möchten Sie andere Zimmeroptionen sehen?",
    }[language]


def _prepend_revision_acknowledgement(state, text, language):
    """Acknowledge a same-turn date correction before the one needed question."""
    changes = state.get('authorized_revision_changes') if isinstance(state, dict) else None
    values = {row.get('field'): row.get('value') for row in changes or []
              if isinstance(row, dict)}
    if not values.get('check_in') or not values.get('check_out'):
        acknowledgement = state.get('quote_date_acknowledgement') if isinstance(state, dict) else None
        current = state.get('current_turn') if isinstance(state, dict) else None
        if (not isinstance(acknowledgement, dict) or not isinstance(current, dict)
                or acknowledgement.get('message_id') != current.get('message_id')):
            return text
        values = acknowledgement
    start = _plain_stay_date(values['check_in'], language)
    end = _plain_stay_date(values['check_out'], language)
    acknowledgements = {
        'en': f'Thanks — I’ve updated the stay to {start} to {end}.',
        'es': f'Gracias — he actualizado la estancia del {start} al {end}.',
        'fr': f'Merci — j’ai mis à jour le séjour du {start} au {end}.',
        'it': f'Grazie — ho aggiornato il soggiorno dal {start} al {end}.', 'de': f'Danke — ich habe den Aufenthalt auf {start} bis {end} aktualisiert.',
    }
    return acknowledgements.get(language, acknowledgements['en']) + '\n' + text


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


def _eligibility_is_evidenced(value, evidence):
    """Verify explicit ordinary-language eligibility without name/room inference."""
    if not isinstance(evidence, str):
        return False
    words = set(_evidence_tokens(evidence))
    # A gendered bed/room request is preference, not a fact about a person.
    if words & {'room', 'dorm', 'bed'}:
        return False
    aliases = {
        'female': {'female', 'woman', 'women', 'girl', 'lady'},
        'male': {'male', 'man', 'men', 'boy', 'guy'},
    }
    if value not in aliases or not words & aliases[value]:
        return False
    terms = '|'.join(re.escape(term) for term in aliases[value])
    return not bool(re.search(r'\b(?:not|no)\s+(?:a\s+)?(?:' + terms + r')\b',
                              evidence, re.IGNORECASE))


def _eligibility_subject_is_affirmed(value, evidence, name, guest_index):
    """Recognize a small set of affirmative facts bound to this guest's subject."""
    if not isinstance(evidence, str) or value not in ('male', 'female'):
        return False
    aliases = {
        'female': r'(?:female|woman|women|girl|lady)',
        'male': r'(?:male|man|men|boy|guy)',
    }
    noun = aliases[value]
    # A demographic noun is authority only as the predicate itself, never as
    # the prefix of a possessive noun phrase (for example, "a woman's husband").
    predicate = noun + r"\b(?!\s*['’])"
    # Anchoring prevents a speaker, object, or later sentence from lending
    # another person's fact to this guest slot.
    if guest_index == 0 and re.match(
            r"^\s*i\s*(?:am|'m)\s+(?:actually\s+)?(?:a\s+)?" + predicate,
            evidence, re.IGNORECASE):
        return True
    if not isinstance(name, str) or not name.strip():
        return False
    escaped_name = re.escape(name.strip())
    if re.match(r'^\s*' + escaped_name + r'\s+(?:is|are)\s+'
                r'(?:actually\s+)?(?:a\s+)?' + predicate, evidence, re.IGNORECASE):
        return True
    group = re.match(r'^\s*(.+?)\s+are\s+both\s+' + predicate,
                     evidence, re.IGNORECASE)
    if not group:
        return False
    subjects = [part.strip().casefold() for part in
                re.split(r'\s*(?:,|\band\b)\s*', group.group(1), flags=re.IGNORECASE)
                if part.strip()]
    return name.strip().casefold() in subjects


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
        elif field == 'keep_together':
            # The model owns the semantic interpretation; this is a proposal to
            # re-quote, never acceptance. Bind it to the whole current turn.
            if (field in scalar_seen or set(change) != {'field', 'value', 'evidence'}
                    or type(change.get('value')) is not bool
                    or not _action_evidence_is_current_turn(raw, evidence)):
                return None
            scalar_seen.add(field)
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
    if state.get('pending_payment_distribution_completion'):
        for key in ('payment_link_distribution', 'payment_distribution',
                    'per_guest_payment_links'):
            if key in presented:
                expected[key] = deepcopy(presented[key])
            else:
                expected.pop(key, None)
    if state.get('pending_payment_completion'):
        if 'payment_choice' in presented:
            expected['payment_choice'] = presented['payment_choice']
        else:
            expected.pop('payment_choice', None)
    return expected == presented


def _canonical_gender_alias_is_redundant(before, after):
    """Allow a dropped aggregate alias only when canonical person facts persist."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    gender = before.get('gender_preference')
    if gender not in ('male', 'female') or after.get('gender_preference') is not None:
        return False
    hints = after.get('room_name_hints')
    if hints != before.get('room_name_hints'):
        return False
    def occupant_names(revision):
        guests = revision.get('guests')
        if isinstance(guests, list) and guests:
            return [guest.get('name') for guest in guests if isinstance(guest, dict)]
        assignments = revision.get('guest_bed_assignments')
        if isinstance(assignments, list) and assignments:
            return [row.get('guest_name') for row in assignments if isinstance(row, dict)]
        return []
    before_names = occupant_names(before)
    after_names = occupant_names(after)
    if (before_names != after_names or not after_names or not isinstance(hints, list)
            or len(after_names) != len(hints)
            or any(not isinstance(row, dict) for row in hints)):
        return False
    normalize = lambda value: ' '.join(str(value or '').split()).casefold()
    names = [normalize(name) for name in after_names]
    facts = {normalize(hint.get('name')): hint.get('explicit_gender') for hint in hints}
    for revision in (before, after):
        guests = revision.get('guests')
        if isinstance(guests, list):
            canonical = {
                normalize(guest.get('name')): guest.get('explicit_gender')
                for guest in guests if isinstance(guest, dict)
                and guest.get('explicit_gender') in ('male', 'female')
            }
            if any(canonical.get(name) not in (None, gender) for name in names):
                return False
    return (all(names) and len(set(names)) == len(names) and len(facts) == len(hints)
            and all(facts.get(name) == gender for name in names))


def _person_plan_does_not_contradict_hints(plan, hints):
    """Sparse request plans may omit facts, but may never contradict Staff facts."""
    if plan is None:
        return True
    if not isinstance(plan, dict) or not isinstance(hints, list):
        return False
    normalize = lambda value: ' '.join(str(value or '').split()).casefold()
    authoritative = {
        normalize(row.get('name')): row.get('explicit_gender')
        for row in hints if isinstance(row, dict)
        and row.get('explicit_gender') in ('male', 'female')
    }
    for key in ('guests', 'room_name_hints'):
        rows = plan.get(key)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if (isinstance(row, dict)
                    and row.get('explicit_gender') in ('male', 'female')
                    and authoritative.get(normalize(row.get('name'))) != row.get('explicit_gender')):
                return False
    return True


def _reconcile_carried_hint_order(supplied, canonical):
    """Keep carried hint metadata in the canonical occupant-slot order."""
    if not isinstance(supplied, list) or not isinstance(canonical, list):
        return supplied
    normalize = lambda value: ' '.join(str(value or '').split()).casefold()
    supplied_by_name = {
        normalize(row.get('name')): row for row in supplied if isinstance(row, dict)
        and normalize(row.get('name'))
    }
    canonical_names = [normalize(row.get('name')) for row in canonical
                       if isinstance(row, dict)]
    if (len(supplied_by_name) != len(supplied) or len(canonical_names) != len(canonical)
            or len(set(canonical_names)) != len(canonical_names)
            or set(supplied_by_name) != set(canonical_names)):
        return supplied
    return [deepcopy(supplied_by_name[name]) for name in canonical_names]


def _canonical_person_facts_consistent(revision):
    if not isinstance(revision, dict):
        return False
    hints = revision.get('room_name_hints')
    guests = revision.get('guests')
    if not isinstance(hints, list) or not isinstance(guests, list):
        return True
    normalize = lambda value: ' '.join(str(value or '').split()).casefold()
    authoritative = {
        normalize(row.get('name')): row.get('explicit_gender')
        for row in hints if isinstance(row, dict)
        and row.get('explicit_gender') in ('male', 'female')
    }
    return all(
        not isinstance(guest, dict)
        or guest.get('explicit_gender') not in ('male', 'female')
        or authoritative.get(normalize(guest.get('name'))) == guest.get('explicit_gender')
        for guest in guests)


def _request_plan_matches_canonical_people(expected, current, prior_revision, current_revision):
    if not _same_material_offer(expected, current, prior_revision, current_revision):
        return False
    expected_alias = expected.get('gender_preference')
    current_alias = current.get('gender_preference')
    hints = current_revision.get('room_name_hints') if isinstance(current_revision, dict) else None
    normalize = lambda value: ' '.join(str(value or '').split()).casefold()
    expected_guests = expected.get('guests')
    current_guests = current.get('guests')
    names = ([normalize(row.get('name')) for row in expected_guests]
             if isinstance(expected_guests, list)
             and all(isinstance(row, dict) for row in expected_guests) else [])
    current_names = ([normalize(row.get('name')) for row in current_guests]
                     if isinstance(current_guests, list)
                     and all(isinstance(row, dict) for row in current_guests) else [])
    authoritative = ({normalize(row.get('name')): row.get('explicit_gender') for row in hints
                      if isinstance(row, dict)} if isinstance(hints, list) else {})
    request_alias_redundant = (
        expected_alias in ('male', 'female') and current_alias is None
        and names and names == current_names and len(set(names)) == len(names)
        and len(authoritative) == len(names)
        and all(authoritative.get(name) == expected_alias for name in names)
        and _person_plan_does_not_contradict_hints(current, hints))
    # Alias consistency remains a person-policy check, not offer identity.
    return (expected_alias == current_alias or request_alias_redundant
            or expected_alias is None or current_alias is None)


def _completion_revision_matches(prior, current, *, payment_choice=None,
                                 guest_index=None, guest_name=None, guest_completions=None,
                                 eligibility_index=None, eligibility_value=None,
                                 eligibility_completions=None, person_plan=None,
                                 aggregate_group_fact=None):
    """Compare the complete Staff revision, ignoring only authorized completions."""
    if not isinstance(prior, dict) or not isinstance(current, dict):
        return False
    if not _canonical_person_facts_consistent(current):
        return False
    if not _person_plan_does_not_contradict_hints(
            person_plan, current.get('room_name_hints')):
        return False
    before, after = deepcopy(prior), deepcopy(current)
    before.pop('offer_fingerprint', None)
    after.pop('offer_fingerprint', None)
    if (aggregate_group_fact in ('male', 'female', 'mixed')
            and before.get('group_gender') is None
            and after.get('group_gender') == aggregate_group_fact):
        before.pop('group_gender', None)
        after.pop('group_gender', None)
    # Staff's completed canonical offer may drop a redundant aggregate alias,
    # but only while the same person-bound authority remains in both revisions.
    if (_canonical_gender_alias_is_redundant(before, after)
            and _person_plan_does_not_contradict_hints(
                person_plan, after.get('room_name_hints'))):
        before['gender_preference'] = None
    if payment_choice:
        if payment_choice not in ('deposit', 'full', 'per_guest'):
            return False
        canonical_choice = 'deposit' if payment_choice == 'per_guest' else payment_choice
        expected_amount = (after.get('deposit_required_cents')
                           if canonical_choice == 'deposit' else after.get('total_cents'))
        prior_choice = before.get('payment_choice')
        prior_amount = (before.get('deposit_required_cents')
                        if prior_choice == 'deposit' else before.get('total_cents'))
        if (type(expected_amount) is not int
                or after.get('payment_choice') != canonical_choice
                or (payment_choice == 'per_guest' and after.get('per_guest_payment_links') is not True)
                or after.get('payment_link_amount_cents') != expected_amount
                or prior_choice not in ('deposit', 'full')
                or before.get('payment_link_amount_cents') != prior_amount):
            return False
        before.pop('payment_choice', None)
        after.pop('payment_choice', None)
        before.pop('per_guest_payment_links', None)
        after.pop('per_guest_payment_links', None)
        before.pop('payment_link_amount_cents', None)
        after.pop('payment_link_amount_cents', None)
    completions = guest_completions or ([{'guest_index': guest_index,
                                          'completed_name': guest_name}]
                                        if type(guest_index) is int else [])
    normalize = lambda value: ' '.join(str(value or '').split()).casefold()
    if len({item.get('guest_index') for item in completions if isinstance(item, dict)}) != len(completions):
        return False
    for completion in completions:
        if not isinstance(completion, dict):
            return False
        guest_index = completion.get('guest_index')
        guest_name = completion.get('completed_name')
        actual_rows = [item for item in after.get('guest_bed_assignments', [])
                       if isinstance(item, dict) and item.get('guest_index') == guest_index]
        if (type(guest_index) is not int or len(actual_rows) != 1
                or normalize(actual_rows[0].get('guest_name')) != normalize(guest_name)):
            return False
        prior_rows = [item for item in before.get('guest_bed_assignments', [])
                      if isinstance(item, dict) and item.get('guest_index') == guest_index]
        prior_target_name = (normalize(prior_rows[0].get('guest_name'))
                             if len(prior_rows) == 1 else '')
        for revision in (before, after):
            assignments = revision.get('guest_bed_assignments')
            target_assignment_name = None
            if isinstance(assignments, list):
                for item in assignments:
                    if isinstance(item, dict) and item.get('guest_index') == guest_index:
                        target_assignment_name = normalize(item.get('guest_name'))
                        item['guest_name'] = '<completed-name-%s>' % guest_index
            distribution = revision.get('payment_distribution')
            if isinstance(distribution, list) and guest_index < len(distribution):
                row = distribution[guest_index]
                if isinstance(row, dict):
                    if normalize(row.get('guest_name')) == target_assignment_name:
                        row['guest_name'] = '<completed-name-%s>' % guest_index
                    else:
                        return False
                elif (isinstance(row, (list, tuple)) and len(row) == 4
                      and row[0] == guest_index
                      and normalize(row[1]) == target_assignment_name):
                    distribution[guest_index] = (
                        guest_index, '<completed-name-%s>' % guest_index, row[2], row[3])
                else:
                    return False
            hints = revision.get('room_name_hints')
            if isinstance(hints, list):
                matching_hints = ([hint for hint in hints
                                   if isinstance(hint, dict)
                                   and normalize(hint.get('name')) == target_assignment_name]
                                  if target_assignment_name else [])
                if len(matching_hints) > 1:
                    return False
                if matching_hints:
                    if revision is before or prior_target_name:
                        matching_hints[0]['name'] = '<completed-name-%s>' % guest_index
                    elif any(key not in ('name', 'explicit_gender')
                             for key in matching_hints[0]):
                        return False
                    else:
                        # A previously unnamed indexed occupant has no prior hint
                        # row. The completed row is identity data, while Staff's
                        # checked assignment/room/price facts remain compared.
                        hints.remove(matching_hints[0])
    eligibility = eligibility_completions or (
        [{'guest_index': eligibility_index, 'value': eligibility_value}]
        if type(eligibility_index) is int else [])
    if len({item.get('guest_index') for item in eligibility}) != len(eligibility):
        return False
    for completion in eligibility:
        index = completion.get('guest_index')
        value = completion.get('value')
        rows = [row for row in after.get('guest_bed_assignments', [])
                if isinstance(row, dict) and row.get('guest_index') == index]
        prior_rows = [row for row in before.get('guest_bed_assignments', [])
                      if isinstance(row, dict) and row.get('guest_index') == index]
        if (type(index) is not int or len(rows) != 1 or len(prior_rows) != 1
                or rows != prior_rows or value not in ('male', 'female')):
            return False
        target_name = normalize(rows[0].get('guest_name'))
        for revision, required in ((before, False), (after, True)):
            hints = revision.get('room_name_hints') or []
            if not isinstance(hints, list):
                return False
            matches = [hint for hint in hints if isinstance(hint, dict)
                       and normalize(hint.get('name')) == target_name]
            if (len(matches) > 1 or (required and len(matches) != 1)
                    or any(set(hint) != {'name', 'explicit_gender'} for hint in matches)
                    or (required and matches[0].get('explicit_gender') != value)):
                return False
            revision['room_name_hints'] = [hint for hint in hints if hint not in matches]
    if eligibility:
        for revision in (before, after):
            if not revision.get('room_name_hints'):
                revision.pop('room_name_hints', None)
    return (_material_projection({}, before) == _material_projection({}, after)
            and before.get('client_slug') == after.get('client_slug')
            and before.get('total_cents') == after.get('total_cents')
            and before.get('currency') == after.get('currency')
            and before.get('availability_checked') == after.get('availability_checked'))


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
        if (not isinstance(completions, dict)
                or set(completions) - {'guests', 'payment_choice', 'payment_link_distribution',
                                       'shuttle_choice', 'eligibility'}):
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
        if any(change['field'] == 'keep_together' for change in bounded_changes):
            # A stock refusal can remove the old presentation. A placement-only
            # revision must still be possible, but grants no create authority.
            if (action != 'revise' or len(bounded_changes) != 1 or completions
                    or any(interpretation[key] for key in ('ambiguous', 'negated', 'conditional'))
                    or bounded_changes[0]['value'] is not False):
                raise QuoteBoundaryError('keep_together_revision_required')
            if 'interpretation_result' in pending:
                return deepcopy(pending['interpretation_result'])
            if _presentation_plan(state).get('keep_together') is not True:
                raise QuoteBoundaryError('keep_together_revision_required')
            _revoke_placement_authority(state)
            state['authorized_revision_changes'] = bounded_changes
            state['unresolved_change'] = False
            result = {'accepted': False, 'create_ready': False, 'action': 'revise',
                      'question_required': False, 'next_action': 'requote_material_changes'}
            pending['interpretation_result'] = deepcopy(result)
            return result
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
            result = deepcopy(pending['interpretation_result'])
            # Compatibility diagnostics describe current facts, never an old
            # readiness verdict captured before the Staff refresh.
            if result.get('accepted') is True:
                ready = (state.get('checked_offer') is not None
                         and presentation.get('quote_revision') == state['checked_offer']
                         and not any(state.get(key) for key in (
                             'pending_name_completion', 'pending_payment_completion',
                             'pending_eligibility_completion')))
                result.update(create_ready=ready,
                              missing=[] if ready else ['staff_checked_offer'],
                              next_action='create_booking' if ready else 'revalidate_selected_terms')
            return result
        fallback = state.get('private_decline_fallback')
        private_fallback_pending = (isinstance(fallback, dict)
                                    and isinstance(fallback.get('checked_offer'), dict)
                                    and fallback['checked_offer'].get('room_type') == 'shared'
                                    and (state.get('checked_offer') or {}).get('room_type') == 'private')
        # A private comparison never turns a later bare "yes" into consent for
        # the higher-priced option. The owner context keeps the shared authority
        # unless this acceptance expressly selects the private alternative.
        private_selected = bool(set(_evidence_tokens(raw)) & {
            'private', 'privada', 'privado', 'privée', 'privee', 'privatzimmer'})
        if action == 'accept' and private_fallback_pending and not private_selected:
            state.pop('private_decline_fallback', None)
            for key, value in fallback.items():
                state[key] = deepcopy(value)
            presentation = state.get('presentation')
            presented = state.get('presented_offer')
        checked_ready = (isinstance(presented, dict)
                         and isinstance(state.get('checked_offer'), dict)
                         and presented == state['checked_offer']
                         and presentation.get('create_ready') is True
                         and presentation.get('quote_revision') == presented)
        # A conditional or ambiguous interpretation is not a choice, even when
        # its polarity resembles an answer to the last rendered question.
        # Do this before binding because bind_answer deliberately trusts the
        # model action for short add-on replies.
        uncertain_answer = interpretation['ambiguous'] or interpretation['conditional']
        # Pending-question polarity owns only a reply with no independently
        # evidenced completion or material revision. Structured content keeps its
        # normal adjudication path instead of being collapsed into answer-last.
        answer_has_own_target = bool(changes or completions)
        bound_answer = (None if uncertain_answer or answer_has_own_target
                        else pending_question.bind_answer(state, action, raw))
        pending_kind = ((state.get('pending_question') or {}).get('kind')
                        if isinstance(state.get('pending_question'), dict) else None)
        non_save_pending_acceptance = (
            action == 'accept'
            and pending_kind == 'payment_choice'
            and pending_question.clear_go_ahead_acceptance(raw)
            and bound_answer is None
        )
        if bound_answer and not bound_answer['cancelled']:
            if bound_answer.get('kind') == 'go_ahead':
                # The owner-rendered save question and closed multilingual
                # affirmative grammar outrank stale model-carried question state.
                # No plan fact changed, so continue through acceptance without a
                # re-quote or a second save question.
                action = 'accept'
            if bound_answer.get('kind') == 'add_on':
                # The durable decision, rather than transfer details, owns the
                # once-only shuttle question. Flight details may be present before
                # the guest has accepted or declined the shuttle.
                state.setdefault('plan', {})['shuttle_choice'] = bound_answer.get('answer')
            # A bound payment/add-on answer changes priced/create input. It must
            # follow the revoke-and-requote boundary. A go-ahead answer changes no
            # fact and continues into the acceptance block below.
            if bound_answer.get('plan_changed') is not False:
                if bound_answer.get('create_consent'):
                    # Deposit/full is the guest's single create consent. Recheck the
                    # selected amount against Staff, then the existing accepted
                    # revalidation path creates in this same turn; never ask yes again.
                    accepted_presentation = deepcopy(presentation)
                    raw_digest = hashlib.sha256(raw.encode()).hexdigest()
                    payment_choice = bound_answer.get('answer')
                    for key in ('checked_offer', 'presented_offer', 'operation_key',
                                'dispatch_pending', 'dispatch_payload'):
                        state.pop(key, None)
                    state['epoch'] += 1
                    _current.get().epoch = state['epoch']
                    state.pop('pending_question', None)
                    state.update(
                        status='accepted',
                        accepted_presentation=accepted_presentation,
                        acceptance_message=ingress['MESSAGE_ID'],
                        acceptance_raw_digest=raw_digest,
                        pending_payment_completion=payment_choice,
                        completion_plan={'payment_choice': payment_choice},
                        auto_acceptance=False,
                    )
                    result = {
                        'accepted': True, 'action': action, 'create_ready': False,
                        'question_required': False,
                        'next_action': 'revalidate_selected_terms',
                    }
                else:
                    _revoke_placement_authority(state)
                    result = {
                        'accepted': False, 'action': action, 'question_required': False,
                        'next_action': 'requote_material_changes',
                    }
                pending['interpretation_digest'] = interpretation_digest
                pending['interpretation_result'] = deepcopy(result)
                return result

        # Typed model-understood answers own these semantic facts even when the
        # model labels a combined/out-of-order reply as ``clarify``.  Exact
        # current-turn evidence is still mandatory, but we deliberately do not
        # maintain a second multilingual keyword parser here.
        resolved = {}
        for field, allowed in (
                ('payment_link_distribution', {'together', 'separate'}),
                ('shuttle_choice', {'accepted', 'declined'})):
            completion = completions.get(field)
            if completion is None:
                continue
            evidence = completion.get('evidence') if isinstance(completion, dict) else None
            if (not isinstance(completion, dict)
                    or set(completion) != {'value', 'evidence'}
                    or completion.get('value') not in allowed
                    or not _evidence_in_current_turn(raw, evidence)):
                raise QuoteBoundaryError('quote_completion_evidence_invalid')
            resolved[field] = completion['value']
        # Validate these typed completions here, but do not adjudicate them on a
        # private fast path. Names, revisions, conditions, and every sibling
        # completion must be validated and applied by the same atomic turn.

        guests = completions.get('guests', [])
        if not isinstance(guests, list):
            raise QuoteBoundaryError('quote_intent_schema_invalid')
        plan_guests = _presentation_plan(state).get('guests')
        if guests and not isinstance(plan_guests, list):
            raise QuoteBoundaryError('quote_completion_not_supported')
        unnamed = {index for index, guest in enumerate(plan_guests or [])
                   if isinstance(guest, dict) and not str(guest.get('name') or '').strip()}
        supplied = [item.get('guest_index') for item in guests if isinstance(item, dict)]
        # Decide the turn's disposition before enforcing create-only roster
        # completeness. Conditional accepts and material revisions cannot book;
        # they must remain available even when only some anonymous slots are named.
        books_now = (
            action == 'accept'
            and not interpretation['conditional']
            and not interpretation['ambiguous']
            and not interpretation['negated']
            and not changes
            and not resolved
        )
        # Incomplete anonymous-slot mappings are an identity transfer risk only
        # when this turn grants create authority. A booking accept must name every
        # anonymous indexed slot atomically and must not duplicate a supplied index.
        if (books_now and guests and unnamed
                and (not unnamed.issubset(set(supplied))
                     or len(supplied) != len(set(supplied)))):
            raise QuoteBoundaryError('quote_completion_identity_changed')
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
                if ((old and (' ' in old
                              or not normalized_new.startswith(normalized_old + ' ')))
                        or (old and sum(1 for guest in (plan_guests or [])
                               if isinstance(guest, dict)
                               and ' '.join(str(guest.get('name') or '').split()).casefold()
                               == normalized_old) != 1)):
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
                    or not _evidence_in_current_turn(raw, payment.get('evidence'))):
                raise QuoteBoundaryError('quote_completion_evidence_invalid')
            current_payment = (state.get('checked_offer') or {}).get('payment_choice')
            if checked_ready:
                if payment['value'] != current_payment:
                    raise QuoteBoundaryError('quote_payment_terms_not_presented')
            else:
                if payment['value'] not in presentation.get('payment_choices', []):
                    raise QuoteBoundaryError('quote_payment_terms_not_presented')
                if not uncertain_answer:
                    state.setdefault('completion_plan', {})['payment_choice'] = payment['value']
                    state['pending_payment_completion'] = payment['value']

        # A distribution/shuttle completion forces a refreshed quote. Carry an
        # explicitly evidenced, unconditional payment choice through that same
        # refresh even when it matched the old checked offer. Conditional or
        # ambiguous choices remain validated above but unresolved.
        if payment is not None and resolved and not uncertain_answer:
            state.setdefault('completion_plan', {})['payment_choice'] = payment['value']
            state['pending_payment_completion'] = payment['value']

        if (payment is not None and state.get('pending_payment_distribution_completion')
                and not uncertain_answer):
            # The amount completes the two-step payment decision. Revoke once,
            # then re-quote both distribution and amount together.
            state.pop('pending_payment_distribution_completion', None)
            _revoke_placement_authority(state)
            checked_ready = False

        if (payment is not None and state.get('pending_payment_completion')
                and not state.get('pending_payment_distribution_completion')
                and not uncertain_answer):
            # A solo amount choice completes the live payment question without a
            # distribution answer to advance the target. Mark that transition so
            # the checked re-quote renders save instead of retaining the stale
            # deposit-vs-full prompt.
            state['question_target_advanced'] = True
            state.pop('pending_question', None)

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

        if resolved and not uncertain_answer:
            completion_plan = state.setdefault('completion_plan', {})
            distribution_only = (
                set(resolved) == {'payment_link_distribution'}
                and payment is None and not guests and eligibility is None
            )
            if 'payment_link_distribution' in resolved:
                distribution = resolved['payment_link_distribution']
                completion_plan['payment_link_distribution'] = distribution
                # Internal compatibility only. The plugin removes this legacy
                # string before Staff transport, where the key is list-valued.
                completion_plan['payment_distribution'] = distribution
                completion_plan['per_guest_payment_links'] = distribution == 'separate'
            if 'shuttle_choice' in resolved:
                shuttle = resolved['shuttle_choice']
                completion_plan['shuttle_choice'] = shuttle
                if shuttle == 'declined':
                    completion_plan['pending_transfers'] = []
            state['question_target_advanced'] = True
            state.pop('pending_question', None)
            if distribution_only:
                # Distribution is the first half of one payment completion. Keep
                # the same checked/presented offer long enough to ask for amount;
                # the amount turn performs the single Staff refresh with both.
                state['pending_payment_distribution_completion'] = resolved['payment_link_distribution']
                pending_question.persist(state, 'payment_choice', ['deposit', 'full'])
            else:
                state.pop('pending_payment_distribution_completion', None)
                _revoke_placement_authority(state)
            checked_ready = False

        # Persist an evidenced revision independently from the final disposition
        # so a same-turn condition cannot erase it.
        if bounded_changes:
            state['authorized_revision_changes'] = bounded_changes
            state['unresolved_change'] = False

        pending_question_text = None
        if uncertain_answer or non_save_pending_acceptance:
            displayed = presentation.get('displayed_text')
            if isinstance(displayed, str) and displayed.strip():
                pending_question_text = displayed.rsplit('\n\n', 1)[-1].strip()
        # A condition is not a rejection, even if its first word is a localized
        # negative. All sibling completions have already passed common validation.
        if (interpretation['conditional'] or action != 'accept' or interpretation['ambiguous']
                or interpretation['negated'] or changes or non_save_pending_acceptance):
            if not interpretation['conditional'] and (interpretation['negated'] or action == 'reject'):
                fallback = state.pop('private_decline_fallback', None)
                if (isinstance(fallback, dict)
                        and (state.get('checked_offer') or {}).get('room_type') == 'private'
                        and (fallback.get('checked_offer') or {}).get('room_type') == 'shared'):
                    for key, value in fallback.items():
                        state[key] = deepcopy(value)
            state.update(status=('offered' if state.get('pending_payment_distribution_completion')
                                 else 'blocked' if (resolved or state.get('pending_payment_completion'))
                                 else 'offered'),
                         auto_acceptance=False)
            state.pop('acceptance_message', None)
            state.pop('acceptance_raw_digest', None)
            if non_save_pending_acceptance:
                next_action = 'clarify_pending_question'
                question = pending_question_text or 'Please choose one of the presented options first.'
            elif uncertain_answer:
                next_action = 'clarify_condition'
                question = pending_question_text or 'Should I create the presented booking now, without that condition?'
            elif interpretation['negated'] or action == 'reject':
                next_action = 'do_not_create'
                question = 'What would you like to change about this booking?'
            elif changes or action == 'revise':
                if bounded_changes:
                    next_action = 'requote_material_changes'
                    question = 'I will recheck those requested booking changes.'
                else:
                    state.pop('authorized_revision_changes', None)
                    state['unresolved_change'] = True
                    next_action = 'clarify_material_changes'
                    question = 'What exact booking detail would you like changed?'
            elif resolved or state.get('pending_payment_completion'):
                if state.get('pending_payment_distribution_completion'):
                    next_action = 'ask_payment_choice'
                    question = None
                else:
                    next_action = 'requote_material_changes'
                    question = 'I will recheck those completed details with the presented booking.'
            else:
                next_action = 'clarify_acceptance'
                question = pending_question_text or 'Should I create the presented booking exactly as shown?'
            result = {'accepted': False, 'action': action,
                      'question_required': next_action not in ('requote_material_changes',),
                      'next_action': next_action, 'question': question}
            if next_action == 'ask_payment_choice':
                result['question_intent'] = pending_question.question_intent(
                    'payment_choice', ['deposit', 'full'])
            pending['interpretation_digest'] = interpretation_digest
            pending['interpretation_result'] = deepcopy(result)
            return result

        if resolved:
            awaiting_amount = bool(state.get('pending_payment_distribution_completion'))
            result = {'accepted': False, 'action': action,
                      'question_required': awaiting_amount,
                      'next_action': ('ask_payment_choice' if awaiting_amount
                                      else 'requote_material_changes')}
            if awaiting_amount:
                result['question_intent'] = pending_question.question_intent(
                    'payment_choice', ['deposit', 'full'])
            pending['interpretation_digest'] = interpretation_digest
            pending['interpretation_result'] = deepcopy(result)
            return result

        raw_digest = hashlib.sha256(raw.encode()).hexdigest()
        state.pop('private_decline_fallback', None)
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
                                    or state.get('pending_payment_completion')
                                    or 'payment_choice' not in missing) else
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
        # Locale belongs to owner-observed ingress, not to quote_booking's model
        # schema. A short acknowledgment retains the last resolved guest locale.
        from .output_guard import _guest_lang_from_history
        detected_language = _guest_lang_from_history([{'role': 'user', 'content': raw}])
        if detected_language in ('en', 'es', 'fr', 'de', 'it'):
            state['guest_language'] = detected_language
        # A private comparison can be revoked by an explicit negative or shared
        # choice on the ordinary ingress path; this only removes authority.
        fallback = state.get('private_decline_fallback')
        tokens = set(_evidence_tokens(raw))
        private_comparison = (isinstance(fallback, dict)
                              and (state.get('checked_offer') or {}).get('room_type') == 'private'
                              and (fallback.get('checked_offer') or {}).get('room_type') == 'shared')
        normalized_raw = raw.casefold().replace('’', "'").replace('ʼ', "'")
        negative = (bool(tokens & {'no', 'nope', 'nah', 'not', 'dont', "don't", 'nein', 'non'})
                    or "don't want" in normalized_raw
                    or 'do not want' in normalized_raw
                    or "doesn't want" in normalized_raw
                    or 'does not want' in normalized_raw)
        # Attribute each negation to the option which follows it; articles and
        # filler words are not option authority.
        option_gap = r'(?:\s+(?:a|the|any|have|need|want|like|take|for))*\s+'
        private_rejected = bool(re.search(
            r'\b(?:not|no|without)' + option_gap + r'private\b'
            r'|\b(?:don\'t|dont|do not|doesn\'t|does not|rather not)' + option_gap + r'private\b'
            r'|\bno need for' + option_gap + r'private\b', normalized_raw))
        shared_rejected = bool(re.search(
            r'\b(?:not|no|without)' + option_gap + r'shared\b'
            r'|\b(?:don\'t|do not|doesn\'t|does not|rather not)' + option_gap + r'shared\b'
            r'|\bno need for' + option_gap + r'shared\b', normalized_raw))
        selects_shared = ('shared' in normalized_raw and not shared_rejected
                          and ('private' not in normalized_raw or private_rejected))
        generic_decline = negative and 'private' not in normalized_raw and 'shared' not in normalized_raw
        if private_comparison and (private_rejected or selects_shared or generic_decline):
            state.pop('private_decline_fallback', None)
            for key, value in fallback.items():
                state[key] = deepcopy(value)
        # IDs stay durable for the incarnation; do not age out replay protection.
        # Raw text is otherwise provenance only. It never grants or revises booking
        # authority: every acceptance or revision of an owner presentation must be
        # adjudicated by interpret_owner_turn.
        if isinstance(state.get('presentation'), dict):
            return
    try:
        return _transaction(observe)
    except Exception:
        close_turn()
        raise


def shuttle_offer_context():
    """Return durable guidance for the single package-shuttle question."""
    try:
        snapshot = _transaction(lambda state, _ingress: {
            'plan': deepcopy(state.get('plan') or {}),
            'language': state.get('guest_language'),
        })
    except Exception:
        return None
    plan = snapshot['plan']
    package_codes = [plan.get('package_code')]
    package_codes.extend(row.get('package_code') for row in (plan.get('guest_packages') or [])
                         if isinstance(row, dict))
    has_package = any(str(code or '').strip().casefold() not in {
        '', 'none', 'package_none', 'accommodation_only', 'no_package'}
        for code in package_codes)
    resolved = (
        plan.get('shuttle_needed') is False
        or plan.get('needs_shuttle') is False
        or str(plan.get('shuttle_choice') or '').strip().casefold()
        in {'yes', 'accepted', 'wanted', 'no', 'none', 'declined', 'not_needed'}
    )
    if not has_package or resolved:
        return None
    return {
        'shuttle_offer_required': True,
        'guest_language': snapshot['language'],
        'context': (
            'Trusted package workflow: proactively offer the Santander airport shuttle now, '
            'once for this booking, in the established guest language. Ask one shuttle question. '
            'Do not wait for the guest to request it and do not repeat it after acceptance or refusal.'
        ),
    }


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


def _project_room_name_hints_from_guests(guests, retained_hints, guest_count):
    """Return a one-to-one Staff-wire hint projection for a named roster.

    A retained person fact may be consumed once. A completed name may bind its
    same-slot hint or one uniquely matching short-name prefix; unrelated people
    never inherit a hint merely because they occupy the same list index.
    """
    if (not isinstance(guests, list) or len(guests) != guest_count
            or not all(isinstance(guest, dict)
                       and str(guest.get('name') or '').strip() for guest in guests)):
        return None
    retained_hints = retained_hints if isinstance(retained_hints, list) else []
    normalize = lambda value: ' '.join(str(value or '').split()).casefold()

    def same_person(old_name, new_name):
        return bool(old_name and new_name
                    and (old_name == new_name or new_name.startswith(old_name + ' ')))

    projected = []
    consumed = set()
    for index, guest in enumerate(guests):
        new_name = normalize(guest.get('name'))
        candidate_index = None
        if index < len(retained_hints) and isinstance(retained_hints[index], dict):
            hint = retained_hints[index]
            if same_person(normalize(hint.get('name')), new_name):
                candidate_index = index
        if candidate_index is None:
            matches = [hint_index for hint_index, hint in enumerate(retained_hints)
                       if hint_index not in consumed and isinstance(hint, dict)
                       and same_person(normalize(hint.get('name')), new_name)]
            if len(matches) == 1:
                candidate_index = matches[0]
        candidate = (retained_hints[candidate_index]
                     if candidate_index is not None and candidate_index not in consumed
                     else None)
        if candidate is not None:
            consumed.add(candidate_index)
        old_gender = candidate.get('explicit_gender') if candidate else None
        new_gender = guest.get('explicit_gender')
        if (old_gender in ('male', 'female') and new_gender in ('male', 'female')
                and old_gender != new_gender):
            raise QuoteBoundaryError('quote_completion_identity_changed')
        gender = new_gender if new_gender in ('male', 'female') else old_gender
        if gender in ('male', 'female'):
            projected.append({'name': guest.get('name'), 'explicit_gender': gender})
    return projected


def _revoke_placement_authority(state):
    for key in ('checked_offer', 'presented_offer', 'presentation',
                'accepted_presentation', 'acceptance_message', 'acceptance_raw_digest',
                'operation_key', 'dispatch_pending', 'dispatch_payload', 'pending_fact_refresh'):
        state.pop(key, None)
    state.update(status='blocked', quote=None, auto_acceptance=False)
    state['epoch'] += 1
    _current.get().epoch = state['epoch']


def _split_revision_proposed(state):
    return (state.get('current_turn', {}).get('interpretation_result', {}).get('next_action')
            == 'requote_material_changes'
            and any(change.get('field') == 'keep_together' and change.get('value') is False
                    for change in state.get('authorized_revision_changes') or []))


def _validate_keep_together(params):
    """Reject malformed placement constraints before touching owner state."""
    if 'keep_together' in params and type(params['keep_together']) is not bool:
        raise QuoteBoundaryError('invalid_keep_together')


def prepare_quote(params):
    """Prepare a read-only Staff quote, preserving omitted draft selections.

    Quote admission is intentionally not a consent boundary: explicit model values
    are sent to Staff for pricing, while omitted values retain the previous draft.
    """
    _validate_keep_together(params)
    def prepare(state, ingress):
        normalized_params = dict(params)
        authorized = state.get('authorized_revision_changes') or []
        catalog_removal_authorized = any(
            isinstance(change, dict)
            and change.get('field') == 'catalog_selections'
            and change.get('operation') == 'remove'
            for change in authorized)
        # Tool schemas may materialize an omitted optional list as []. Treat it
        # as absence unless this turn carries an evidenced catalog removal.
        if (normalized_params.get('catalog_selections') == []
                and not catalog_removal_authorized):
            normalized_params.pop('catalog_selections')
        result = deepcopy(normalized_params)
        preserved = deepcopy(state.get('plan') or {})
        preserved.update(deepcopy(state.get('completion_plan') or {}))
        if (preserved.get('keep_together') is True and result.get('keep_together') is False
                and not _split_revision_proposed(state)):
            raise QuoteBoundaryError('keep_together_revision_required')
        prior_room_preference = str(preserved.get('room_preference') or '').strip()
        new_room_preference = str(result.get('room_preference') or '').strip().casefold()
        explicit_prior_room = re.fullmatch(
            r'(?:room|r)\s*[-_ ]?\s*\d+', prior_room_preference, re.IGNORECASE)
        if (explicit_prior_room
                and new_room_preference in {'shared', 'mixed'}):
            # A generic model restatement must not erase a guest's specific room
            # preference during re-quote/create. Staff can still allocate another
            # room, but the rendered quote must disclose that before acceptance.
            result['room_preference'] = prior_room_preference
        for key in _FIELDS + _CHECKED_FIELDS:
            if key not in result and key in preserved:
                result[key] = preserved[key]
        # Keep the owner projection identical to the Staff wire projection.
        # This must also replace stale hints supplied by a prior owner plan.
        projected_hints = _project_room_name_hints_from_guests(
            result.get('guests'), result.get('room_name_hints'), result.get('guest_count'))
        if projected_hints is not None:
            result['room_name_hints'] = projected_hints
        # Catalog and atomic add-ons are aliases of the same priced selection.
        # An explicit replacement owns that alias; an omitted field is retained,
        # except for stale duplicates of the explicitly replaced representation.
        old_catalog = preserved.get('catalog_selections') or []
        if 'catalog_selections' in params and 'add_ons' not in params:
            replacements = [
                {'operation': 'remove', 'item': item} for item in old_catalog
                if isinstance(item, dict)]
            replacements.extend({'operation': 'add', 'item': item}
                                for item in (params.get('catalog_selections') or [])
                                if isinstance(item, dict))
            projected = _sync_catalog_projection(
                result.get('add_ons') or [], replacements, old_catalog)
            if projected is None:
                raise QuoteBoundaryError('catalog_addon_conflict')
            result['add_ons'] = projected
        elif 'add_ons' in params and 'catalog_selections' not in params:
            prior_codes = {item.get('code') for item in (preserved.get('add_ons') or [])
                           if isinstance(item, dict)}
            prior_codes.update(item.get('code') for item in (params.get('add_ons') or [])
                               if isinstance(item, dict))
            result['catalog_selections'] = [item for item in old_catalog
                if not isinstance(item, dict) or item.get('service_code') not in prior_codes]
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
        for index, guest in enumerate(guests):
            if isinstance(guest, dict) and guest.get('explicit_gender') in ('male', 'female'):
                allowed[index] = guest['explicit_gender']
        group = prepared.get('group_gender')
        if group in ('male', 'female') and len(guests) == prepared.get('guest_count'):
            # An explicit whole-party fact binds every existing roster slot;
            # a more specific contradictory individual fact is never overwritten.
            for index in range(len(guests)):
                if isinstance(guests[index], dict):
                    allowed.setdefault(index, group)
        checked = state.get('checked_offer') or (
            (state.get('quote') or {}).get('offer_revision')) or {}
        normalize_name = lambda value: ' '.join(str(value or '').split()).casefold()
        bindings = state.get('pending_name_completions') or (
            [state['pending_name_completion']] if isinstance(
                state.get('pending_name_completion'), dict) else [])
        bound_names = {}
        assignments = checked.get('guest_bed_assignments') if isinstance(checked, dict) else None
        if bindings and isinstance(assignments, list) and len(assignments) == len(guests):
            candidate = {}
            for binding in bindings:
                index = binding.get('guest_index') if isinstance(binding, dict) else None
                previous = normalize_name(binding.get('previous_name')) if isinstance(binding, dict) else ''
                completed = normalize_name(binding.get('completed_name')) if isinstance(binding, dict) else ''
                if (type(index) is not int or not 0 <= index < len(guests)
                        or index in candidate or not previous or not completed
                        or not isinstance(guests[index], dict)
                        or normalize_name(guests[index].get('name')) != completed
                        or not isinstance(assignments[index], dict)
                        or assignments[index].get('guest_index') != index
                        or normalize_name(assignments[index].get('guest_name')) != previous):
                    candidate = {}
                    break
                candidate[index] = previous
            changed = set(candidate)
            if candidate and all(
                    isinstance(row, dict) and row.get('guest_index') == index
                    and (index in changed or (isinstance(guests[index], dict)
                         and normalize_name(guests[index].get('name'))
                         == normalize_name(row.get('guest_name'))))
                    for index, row in enumerate(assignments)):
                bound_names = candidate
        hints = checked.get('room_name_hints') if isinstance(checked, dict) else None
        if isinstance(hints, list):
            for hint in hints:
                if (not isinstance(hint, dict)
                        or hint.get('explicit_gender') not in ('male', 'female')):
                    continue
                name = normalize_name(hint.get('name'))
                bound_matches = [index for index, previous in bound_names.items()
                                 if name == previous]
                if len(bound_matches) == 1:
                    allowed.setdefault(bound_matches[0], hint['explicit_gender'])
                    continue
                matches = [index for index, guest in enumerate(guests)
                           if isinstance(guest, dict)
                           and str(guest.get('name', '')).strip().casefold() == name]
                if len(matches) == 1:
                    allowed.setdefault(matches[0], hint['explicit_gender'])
        pending = state.get('pending_eligibility_completion')
        completion = state.get('completion_plan') or {}
        completed_guests = completion.get('guests') if isinstance(completion, dict) else None
        if isinstance(pending, dict) and isinstance(completed_guests, list):
            index = pending.get('guest_index')
            value = pending.get('value')
            if (type(index) is int and 0 <= index < len(guests)
                    and index < len(completed_guests) and value in ('male', 'female')
                    and completed_guests[index] == guests[index]):
                allowed.setdefault(index, value)
        return allowed
    return _transaction(read)


def validated_unnamed_group_composition(prepared):
    """Return whole-party composition while any roster slots remain unnamed."""
    def read(state, _ingress):
        if (not isinstance(prepared, PreparedPlan)
                or prepared.capability is not _current.get()
                or prepared.epoch != state['epoch']):
            raise QuoteBoundaryError('quote_response_superseded')
        guests = prepared.get('guests')
        if (isinstance(guests, list)
                and len(guests) >= prepared.get('guest_count', 0)):
            return None
        group = prepared.get('group_gender')
        return group if group in ('male', 'female') else None
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
    requested_payment = prepared.get('payment_choice')
    canonical_split_deposit = (
        requested_payment == 'per_guest'
        and offer.get('payment_choice') == 'deposit'
        and offer.get('per_guest_payment_links') is True)
    if (offer.get('payment_choice') != requested_payment
            and not canonical_split_deposit):
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
    if canonical_split_deposit:
        # Staff prices individual deposit links through its canonical deposit
        # tier. That does not replace the guest's split-payment instruction.
        plan['payment_choice'] = 'per_guest'
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
    """Validate priced provisional terms without granting create authority."""
    offer = response.get('offer_revision')
    availability = response.get('availability')
    requested_payment = (plan or {}).get('payment_choice')
    assignments = offer.get('guest_bed_assignments') if isinstance(offer, dict) else None
    count = offer.get('guest_count') if isinstance(offer, dict) else None
    missing_names = (type(count) is int and count > 0 and isinstance(assignments, list)
                     and len(assignments) == count and any(
                         not isinstance(row, dict) or not row.get('guest_name')
                         for row in assignments))
    full_only = (response.get('full_payment_only') is True
                 and response.get('payment_choice_needed') is False)
    chosen_full_with_missing_names = (
        requested_payment == 'full'
        and response.get('payment_choice_needed') is False and missing_names)
    expected_payment = ('full' if full_only or chosen_full_with_missing_names else 'deposit')
    expected_amount = (offer.get('total_cents') if expected_payment == 'full' else
                       offer.get('deposit_required_cents')) if isinstance(offer, dict) else None
    if (not isinstance(offer, dict) or not isinstance(availability, dict)
            or (response.get('payment_choice_needed') is not True
                and not full_only and not chosen_full_with_missing_names)
            or (requested_payment in ('full', 'deposit', 'pay_on_arrival', 'per_guest')
                and not full_only and not chosen_full_with_missing_names)
            or offer.get('client_slug') != tenant
            or offer.get('availability_checked') is not True
            or availability.get('status') != 'checked'
            or offer.get('payment_choice') != expected_payment
            or not offer.get('offer_fingerprint')
            or any(not isinstance(offer.get(key), str) or not offer[key].strip()
                   for key in ('check_in', 'check_out', 'currency', 'room_type', 'package_code'))
            or any(type(offer.get(key)) is not int or offer[key] < 0 for key in
                   ('guest_count', 'total_cents', 'deposit_required_cents', 'payment_link_amount_cents'))
            or offer.get('total_cents') != response.get('total_cents')
            or offer.get('payment_link_amount_cents') != expected_amount
            or (full_only and offer.get('deposit_required_cents') != offer.get('total_cents'))):
        return False
    rooms = offer.get('room_arrangement')
    return (isinstance(assignments, list) and len(assignments) == count
            and isinstance(rooms, list) and len(rooms) == count
            and availability.get('selected_bed_codes') == [row.get('bed_code') for row in assignments]
            and all(isinstance(row, dict) and row.get('guest_index') == index
                    and (row.get('guest_name') is None or isinstance(row.get('guest_name'), str))
                    and row.get('bed_code') for index, row in enumerate(assignments))
            and all(isinstance(row, dict) and row.get('bed_code') and row.get('room_code')
                    and row.get('gender_strategy') for row in rooms))


def _assignment_completion_guests(supplied, assignments):
    supplied = supplied if isinstance(supplied, list) else []

    def normalized(value):
        return unicodedata.normalize('NFC', ' '.join(str(value or '').split())).casefold()

    completed = []
    for index, row in enumerate(assignments):
        canonical = row.get('guest_name') or ''
        candidate = supplied[index] if index < len(supplied) and isinstance(supplied[index], dict) else {}
        if normalized(candidate.get('name')) and normalized(candidate.get('name')) == normalized(canonical):
            guest = deepcopy(candidate)
            guest['name'] = candidate['name']
        else:
            guest = {'name': canonical}
        completed.append(guest)
    return completed


def record_quote(params, response):
    prepared = params if isinstance(params, PreparedPlan) else prepare_quote(params)
    response = deepcopy(response)
    # A full-only tariff has one policy-defined charge, not a guest choice. Some
    # legacy Staff receipts still label that charge "deposit" and list payment
    # choice as missing; normalize all linked semantics without claiming consent.
    if (response.get('success') is True and response.get('full_payment_only') is True
            and response.get('payment_choice_needed') is False
            and not prepared.get('payment_choice')
            and type(response.get('total_cents')) is int
            and response.get('deposit_required_cents') == response.get('total_cents')
            and isinstance(response.get('offer_revision'), dict)):
        response['missing_fields'] = [field for field in response.get('missing_fields', [])
                                      if field != 'payment_choice']
        response['offer_revision']['payment_choice'] = 'full'
        response['offer_revision']['payment_link_amount_cents'] = response['total_cents']
    def record(state, ingress):
        if prepared.capability is not _current.get() or prepared.epoch != state['epoch']:
            raise QuoteBoundaryError('quote_response_superseded')
        plan = {key: deepcopy(prepared[key]) for key in _FIELDS if key in prepared}
        # The model plan may carry a stale locale from an earlier turn. Locale
        # authority belongs to owner-observed guest ingress and must not be
        # overwritten while recording a quote.
        completion_plan = {key: deepcopy(prepared[key]) for key in _CHECKED_FIELDS
                           if key in prepared}
        checked = _checked_plan(prepared, response, ingress['tenant'])
        if checked is not None:
            plan = checked
            completion_plan = {}
        elif _incomplete_payment_revision(response, ingress['tenant'], prepared):
            assignments = response['offer_revision'].get('guest_bed_assignments') or []
            if len(assignments) == response['offer_revision'].get('guest_count'):
                supplied = prepared.get('guests') if isinstance(prepared.get('guests'), list) else []
                completion_plan['guests'] = _assignment_completion_guests(supplied, assignments)
            if response.get('full_payment_only') is True:
                completion_plan['payment_choice'] = 'full'
        previous_checked = state.get('checked_offer')
        previous_plan = state.get('plan') if isinstance(state.get('plan'), dict) else {}
        previous_presentation = state.get('presentation')
        if (checked is not None and checked.get('room_type') == 'private'
                and isinstance(previous_checked, dict)
                and previous_checked.get('room_type') == 'shared'
                and isinstance(previous_presentation, dict)):
            state['private_decline_fallback'] = deepcopy({
                key: state.get(key) for key in (
                    'checked_offer', 'presented_offer', 'presentation', 'quote', 'plan',
                    'completion_plan', 'offer_message')
            })
        elif checked is not None and checked.get('room_type') != 'private':
            state.pop('private_decline_fallback', None)
        total = response.get('total_cents')
        valid = response.get('success') is True and type(total) is int and total > 0
        provisional = _incomplete_payment_revision(response, ingress['tenant'], prepared)
        if response.get('offer_revision') and provisional:
            valid = valid and provisional
        elif previous_checked or response.get('offer_revision'):
            valid = valid and checked is not None
        pending_payment = state.get('pending_payment_completion')
        pending_name = state.get('pending_name_completion')
        pending_eligibility = state.get('pending_eligibility_completion')
        if (valid and checked is not None and state['status'] in ('accepted', 'clarify')
                and (pending_payment or pending_name or pending_eligibility
                     or state.get('pending_fact_refresh'))
                and isinstance(state.get('accepted_presentation'), dict)):
            prior = state['accepted_presentation']
            prior_plan = prior.get('plan') or {}
            expected_plan = deepcopy(prior_plan)
            expected_plan.update(deepcopy(state.get('completion_plan') or {}))
            prior_quote = prior.get('authoritative_quote') or {}
            prior_revision = prior.get('quote_revision') or prior_quote.get('offer_revision')
            new_revision = response.get('offer_revision')
            pending_names = state.get('pending_name_completions') or (
                [pending_name] if pending_name else [])
            eligibility_index = ((pending_eligibility or {}).get('guest_index')
                                 if pending_eligibility else None)
            eligibility_value = ((pending_eligibility or {}).get('value')
                                 if pending_eligibility else None)
            canonical_split_completion = (
                pending_payment == 'per_guest'
                and response.get('offer_revision', {}).get('payment_choice') == 'deposit'
                and response.get('offer_revision', {}).get('per_guest_payment_links') is True
                and 'per_guest' in prior.get('payment_choices', []))
            terms_unchanged = (
                _request_plan_matches_canonical_people(
                    expected_plan, plan, prior_revision, new_revision)
                and _completion_revision_matches(
                    prior_revision, new_revision,
                    payment_choice=pending_payment, guest_completions=pending_names,
                    eligibility_index=eligibility_index,
                    eligibility_value=eligibility_value,
                    eligibility_completions=state.get('pending_eligibility_completions'),
                    person_plan=dict(prepared),
                    aggregate_group_fact=state.get('pending_group_gender_fact'))
                and response.get('total_cents') == prior_quote.get('total_cents')
                and response.get('deposit_required_cents') == prior_quote.get('deposit_required_cents')
                and response.get('currency') == prior_quote.get('currency')
                and (not pending_payment or canonical_split_completion or (
                    response.get('offer_revision', {}).get('payment_choice') == pending_payment
                    and pending_payment in prior.get('payment_choices', [])))
            )
            if terms_unchanged:
                state['status'] = 'accepted'
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
                state.pop('pending_eligibility_completions', None)
                state.pop('pending_group_gender_fact', None)
                state.pop('pending_fact_refresh', None)
                state['epoch'] += 1
                prepared.capability.epoch = state['epoch']
                return
        presentation = state.get('presentation')
        if valid and isinstance(presentation, dict):
            prior_revision = presentation.get('quote_revision') or {}
            revision = response.get('offer_revision') or {}
            prior_rows = prior_revision.get('guest_bed_assignments') or []
            rows = revision.get('guest_bed_assignments') or []
            names = []
            same_people = len(prior_rows) == len(rows)
            normalize = lambda value: ' '.join(str(value or '').split()).casefold()
            for index, (before, after) in enumerate(zip(prior_rows, rows)):
                old, new = normalize(before.get('guest_name')), normalize(after.get('guest_name'))
                if old != new:
                    if (not new
                            or (old and (' ' in old or not new.startswith(old + ' ')
                                         or sum(normalize(row.get('guest_name')) == old
                                                for row in prior_rows) != 1))
                            or sum(normalize(row.get('guest_name')) == new for row in rows) != 1):
                        same_people = False
                    names.append({'guest_index': index, 'completed_name': after.get('guest_name')})
            payment = prepared.get('payment_choice')
            payment_completion = (payment if payment != prior_revision.get('payment_choice')
                                  else None)
            prior_quote = presentation.get('authoritative_quote') or {}
            prior_plan = presentation.get('plan') or {}
            material_matches = _same_material_offer(
                prior_plan, plan, prior_revision, revision)
            if not material_matches and same_people and names:
                # A checked indexed surname completion may update that payer label;
                # compare it through the same authorized completion equivalence.
                material_matches = _completion_revision_matches(
                    prior_revision, revision, guest_completions=names,
                    person_plan=plan)
            completed_named_revision = (bool(rows)
                and all(isinstance(row, dict) and str(row.get('guest_name') or '').strip()
                        for row in rows))
            payment_preserved_by_completed_revision = (
                payment == prior_revision.get('payment_choice')
                and completed_named_revision)
            if (material_matches and same_people
                    and (not payment or payment in presentation.get('payment_choices', [])
                         or payment_preserved_by_completed_revision)
                    and _completion_revision_matches(prior_revision, revision,
                        payment_choice=payment_completion, guest_completions=names,
                        person_plan=plan)
                    and all(response.get(key) == prior_quote.get(key)
                            for key in ('total_cents', 'deposit_required_cents', 'currency'))):
                # Preserve the owner-rendered text while advancing only the
                # authoritative, materially identical completion snapshot.
                state['plan'] = deepcopy(plan)
                state['completion_plan'] = deepcopy(completion_plan)
                state['quote'] = deepcopy(response)
                completed_authority = (completed_named_revision
                    and bool(revision.get('payment_choice'))
                    and revision.get('availability_checked') is True
                    and response.get('payment_choice_needed') is not True
                    and not response.get('missing_fields'))
                if completed_authority:
                    state['checked_offer'] = deepcopy(revision)
                    state.pop('pending_payment_distribution_completion', None)
                    state.pop('pending_payment_completion', None)
                    stale_target = state.pop('question_target_advanced', False) is True
                    if state.get('status') != 'accepted' and stale_target:
                        # The commercial terms are equivalent, but this turn has
                        # advanced past a concrete question.  Re-render the current
                        # save question instead of retaining the earlier target.
                        state['status'] = 'offered'
                        state['offer_message'] = ingress['MESSAGE_ID']
                        state.pop('presentation', None)
                        state.pop('presented_offer', None)
                        state.pop('pending_question', None)
                    else:
                        state['presented_offer'] = deepcopy(revision)
                presentation = state.get('presentation')
                if isinstance(presentation, dict):
                    presentation['plan'] = _presentation_plan(state)
                    presentation['quote_revision'] = deepcopy(revision)
                    presentation['authoritative_quote'] = deepcopy(response)
                if state.get('status') == 'accepted' and completed_authority:
                    # A fact-equivalent Staff re-quote advances the authority
                    # already accepted for this same person/conversation.  Do
                    # not leave the acceptance snapshots pointing at the prior
                    # fingerprint and then refuse the exact refreshed offer.
                    state['accepted_offer_snapshot'] = deepcopy(revision)
                    state['accepted_presentation'] = deepcopy(presentation)
                return
        if (valid and checked is not None and state['status'] == 'accepted'
                and isinstance(state.get('presentation'), dict)
                and _same_material_offer(state['plan'], plan, previous_checked,
                                         response['offer_revision'])
                and response.get('total_cents') == (state.get('quote') or {}).get('total_cents')
                and response.get('currency') == (state.get('quote') or {}).get('currency')):
            # Cosmetic revalidation metadata must not mint a new operation or
            # erase consent. Keep the original snapshot, receipt and key inputs.
            return
        state['checked_offer'] = deepcopy(response['offer_revision']) if checked is not None else None
        state.pop('presented_offer', None)
        state.pop('presentation', None)
        state.pop('accepted_presentation', None)
        state.pop('receipt', None)
        state.pop('completion', None)
        state.pop('partial_completion', None)
        state.pop('dispatch_pending', None)
        state.pop('dispatch_payload', None)
        state.pop('post_booking_contact', None)
        # This is a newly checked material offer; any prepared identity belonged
        # to the prior accepted offer and cannot authorize this one.
        state.pop('operation_key', None)
        unresolved_eligibility = (
            response.get('success') is False
            and response.get('quote_status') == 'needs_guest_clarification'
            and response.get('offer_revision') is None
        )
        dates_changed = (all(isinstance(previous_plan.get(field), str) and previous_plan[field]
                             for field in ('check_in', 'check_out'))
                         and any(previous_plan.get(field) != plan.get(field)
                                 for field in ('check_in', 'check_out')))
        if (dates_changed and all(isinstance(plan.get(field), str) and plan[field]
                                  for field in ('check_in', 'check_out'))):
            state['quote_date_acknowledgement'] = {
                'message_id': ingress['MESSAGE_ID'],
                'check_in': plan['check_in'],
                'check_out': plan['check_out'],
            }
        else:
            acknowledgement = state.get('quote_date_acknowledgement')
            same_current_dates = (
                isinstance(acknowledgement, dict)
                and acknowledgement.get('message_id') == ingress['MESSAGE_ID']
                and acknowledgement.get('check_in') == plan.get('check_in')
                and acknowledgement.get('check_out') == plan.get('check_out')
            )
            if not same_current_dates:
                state.pop('quote_date_acknowledgement', None)
        typed_package_preview = (
            response.get('quote_status') == 'needs_guest_clarification'
            and response.get('offer_revision') is None
            and response.get('package_choice_needed') is True
            and response.get('next_action') in (
                'explain_packages_then_ask_choice', 'offer_accommodation_or_change_dates',
                'package_eligibility_unavailable'))
        state.update(plan=plan, completion_plan=completion_plan,
                     quote=deepcopy(response) if (valid or unresolved_eligibility or typed_package_preview) else None,
                     status='offered' if valid else 'blocked', offer_message=ingress['MESSAGE_ID'])
        state.pop('acceptance_message', None)
        state.pop('pending_name_completion', None)
        state.pop('pending_name_completions', None)
        state.pop('pending_payment_completion', None)
        state.pop('pending_eligibility_completion', None)
        state.pop('pending_eligibility_completions', None)
        state.pop('pending_fact_refresh', None)
        # Keep bounded revision authority for retries within this interpreted
        # ingress. observe_owner_turn clears it before any fresh guest turn.
        state['unresolved_change'] = False
        state['delta'] = {}
        state['epoch'] += 1
        prepared.capability.epoch = state['epoch']
    return _transaction(record)


def record_availability_context(params):
    """Merge trusted availability facts without replacing booking authority."""
    _validate_keep_together(params)
    projection = {key: deepcopy(params[key]) for key in (*_FIELDS, *_CHECKED_FIELDS)
                  if key in params}
    def record(state, ingress):
        previous = _presentation_plan(state)
        if (previous.get('keep_together') is True and projection.get('keep_together') is False
                and not _split_revision_proposed(state)):
            raise QuoteBoundaryError('keep_together_revision_required')
        tightened = projection.get('keep_together') is True and previous.get('keep_together') is not True
        changed = (all(isinstance(projection.get(key), str) and projection[key]
                       for key in ('check_in', 'check_out'))
                   and all(isinstance(previous.get(key), str) and previous[key]
                           for key in ('check_in', 'check_out'))
                   and any(previous.get(key) != projection.get(key)
                           for key in ('check_in', 'check_out')))
        merged = deepcopy(previous)
        known_guests = previous.get('guests')
        old_size = previous.get('guest_count')
        new_size = projection.get('guest_count')
        retired = {index for index in state.get('retired_guest_indices') or []
                   if type(index) is int and index >= 0}
        newly_retired = set()
        if type(old_size) is int and type(new_size) is int and new_size < old_size:
            newly_retired.update(range(max(new_size, 0), old_size))
            retired.update(newly_retired)
        # An owner-evidenced completion is the only authority that may assign a
        # previously retired/regrown slot again. A completion that predates this
        # shrink cannot undo the retirement created by the same transition.
        completion_guests = (state.get('completion_plan') or {}).get('guests')
        if isinstance(completion_guests, list):
            for index, guest in enumerate(completion_guests):
                if (index not in newly_retired
                        and isinstance(guest, dict)
                        and isinstance(guest.get('name'), str)
                        and guest['name'].strip()):
                    retired.discard(index)
        for key, value in projection.items():
            if key == 'guests' and isinstance(value, list) and isinstance(known_guests, list):
                roster = deepcopy(known_guests)
                target_size = new_size if type(new_size) is int and new_size >= 0 else len(value)
                roster = roster[:target_size]
                while len(roster) < target_size:
                    roster.append({})
                for index, guest in enumerate(value[:target_size]):
                    if not isinstance(guest, dict):
                        continue
                    current = roster[index] if isinstance(roster[index], dict) else {}
                    current_name = current.get('name')
                    incoming = deepcopy(guest)
                    if ((isinstance(current_name, str) and current_name.strip())
                            or index in retired):
                        incoming.pop('name', None)
                    roster[index] = {**current, **incoming}
                merged[key] = roster
            else:
                merged[key] = deepcopy(value)
        party_size = merged.get('guest_count')
        if type(party_size) is int and party_size >= 0:
            for key in ('guests', 'room_name_hints'):
                if isinstance(merged.get(key), list):
                    merged[key] = merged[key][:party_size]
        state['retired_guest_indices'] = sorted(retired)
        state['plan'] = merged
        if tightened or (previous.get('keep_together') is True
                         and projection.get('keep_together') is False):
            # Both directions revoke all old authority; a fresh checked offer
            # and its presentation/acceptance are mandatory before any create.
            _revoke_placement_authority(state)
        # Availability is a projection, not a new commercial/person owner.  Keep
        # completions already accepted by the quote owner and fold them into the
        # merged plan so a later create sees one coherent authoritative snapshot.
        state['completion_plan'] = {}
        acknowledgement = state.get('quote_date_acknowledgement')
        same_retry = (isinstance(acknowledgement, dict)
                      and acknowledgement.get('message_id') == ingress['MESSAGE_ID']
                      and acknowledgement.get('check_in') == merged.get('check_in')
                      and acknowledgement.get('check_out') == merged.get('check_out'))
        if changed or same_retry:
            state['quote_date_acknowledgement'] = {
                'message_id': ingress['MESSAGE_ID'], 'check_in': merged['check_in'],
                'check_out': merged['check_out']}
        else:
            state.pop('quote_date_acknowledgement', None)
        return deepcopy(merged)
    return _transaction(record)


def prepare_create(params):
    _validate_keep_together(params)
    params = deepcopy(params)
    def prepare(state, ingress):
        frozen_dispatch = state.get('dispatch_payload')
        if (state.get('dispatch_pending') and isinstance(state.get('checked_offer'), dict)
                and isinstance(frozen_dispatch, dict)):
            # Recovery reuses the owner-frozen operation only when any restated
            # business fields still describe that operation. Omitted fields are
            # recovered; changed dates/people/beds/terms cannot ride its receipt.
            candidate = deepcopy(frozen_dispatch)
            candidate.update({key: deepcopy(value) for key, value in params.items()
                              if key not in ('confirm', 'ready', 'accepted_offer',
                                             'require_offer_identity', 'idempotency_key')})
            if not _same_material_offer(frozen_dispatch, candidate,
                                        state['checked_offer'], state['checked_offer'],
                                        include_personal=True):
                raise QuoteBoundaryError('accepted_quote_changed')
            return PreparedPlan(deepcopy(frozen_dispatch), _current.get(), state['epoch'])
        # The model supplies structured completions; Staff revalidates them in
        # this invocation. Names are indexed data, not literal-word evidence.
        baseline = _presentation_plan(state)
        presentation = state.get('presentation') or {}
        shown = presentation.get('quote_revision') or {}
        shown_assignments = shown.get('guest_bed_assignments') or []
        if (baseline.get('selected_bed_codes') is None and shown_assignments
                and all(isinstance(row, dict) and row.get('guest_index') == index
                        and isinstance(row.get('bed_code'), str)
                        for index, row in enumerate(shown_assignments))
                and params.get('selected_bed_codes') == [row['bed_code'] for row in shown_assignments]):
            # Provisional plan may omit codes already frozen in the shown offer.
            params.pop('selected_bed_codes')
        if (params.get('add_ons') == [] and baseline.get('add_ons') is None
                and shown.get('add_ons') == []):
            # Only an explicitly empty authoritative offer proves this alias.
            params.pop('add_ons')
        if (params.get('catalog_selections') == []
                and baseline.get('catalog_selections') is None
                and shown.get('availability_checked') is True):
            # Registered quote rejects every nonempty catalog selection before
            # issuing a checked offer: successful shown authority proves none.
            params.pop('catalog_selections')
        gender = params.get('gender_preference')
        # Provisional payment/name completion can project names-only rows into
        # completion_plan; retain explicit facts from the original shown plan.
        roster = baseline.get('guests') or []
        hints = baseline.get('room_name_hints') or []
        if (len(hints) == len(roster) and all(isinstance(row, dict) for row in hints)
                and all(isinstance(row, dict) for row in roster)):
            normalized_name = lambda value: ' '.join(str(value or '').split()).casefold()
            hint_names = [normalized_name(row.get('name')) for row in hints]
            if (len(set(hint_names)) == len(hint_names) and all(hint_names)
                    and hint_names == [normalized_name(row.get('name')) for row in roster]):
                roster = [{**hint, **guest,
                           'explicit_gender': guest.get('explicit_gender') or hint.get('explicit_gender')}
                          for guest, hint in zip(roster, hints)]
        if (params.get('payment_choice') == 'deposit'
                and shown.get('payment_choice') == 'full'
                and shown.get('total_cents') == shown.get('deposit_required_cents')
                and type(shown.get('total_cents')) is int
                and shown['total_cents'] > 0
                and presentation.get('payment_choices') == ['full']):
            params['payment_choice'] = 'full'
        if (gender in ('male', 'female') and baseline.get('gender_preference') is None
                and len(roster) == baseline.get('guest_count')
                and all(isinstance(guest, dict) and guest.get('explicit_gender') == gender
                        for guest in roster)):
            # Person-bound facts already establish this redundant representation;
            # room/bed and roster changes still face the ordinary comparisons.
            params.pop('gender_preference')
        supplied_hints = params.get('room_name_hints')
        canonical_hints = baseline.get('room_name_hints')
        if (isinstance(supplied_hints, list) and isinstance(canonical_hints, list)
                and len(supplied_hints) == len(canonical_hints)
                and all(isinstance(row, dict) for row in supplied_hints + canonical_hints)):
            normalize_hint_name = lambda value: ' '.join(str(value or '').split()).casefold()
            hint_completion = True
            for supplied, canonical in zip(supplied_hints, canonical_hints):
                old_name = normalize_hint_name(supplied.get('name'))
                new_name = normalize_hint_name(canonical.get('name'))
                if ({key: value for key, value in supplied.items() if key != 'name'}
                        != {key: value for key, value in canonical.items() if key != 'name'}
                        or not old_name or not new_name
                        or (old_name != new_name and not new_name.startswith(old_name + ' '))):
                    hint_completion = False
                    break
            if (hint_completion
                    and len({normalize_hint_name(row.get('name')) for row in supplied_hints})
                    == len(supplied_hints)
                    and len({normalize_hint_name(row.get('name')) for row in canonical_hints})
                    == len(canonical_hints)):
                # Staff already synchronized this same-person completion. A
                # stale model hint cannot veto the first create; any changed
                # eligibility, person, or ordering still fails below.
                params['room_name_hints'] = deepcopy(canonical_hints)
        if isinstance(state.get('presentation'), dict):
            updates = {}
            guests = params.get('guests')
            old_guests = baseline.get('guests') or []
            if guests is not None and guests != old_guests:
                if (not isinstance(guests, list) or len(guests) != len(old_guests)
                        or any(not isinstance(g, dict) or not str(g.get('name') or '').strip()
                               for g in guests)):
                    raise QuoteBoundaryError('quote_completion_identity_changed')
                normalize = lambda name: ' '.join(str(name or '').split()).casefold()
                old_names = [normalize(g.get('name')) for g in old_guests]
                names = [normalize(g.get('name')) for g in guests]
                same_slot_completion = all(
                    old_name and name
                    and (name == old_name or name.startswith(old_name + ' '))
                    for old_name, name in zip(old_names, names))
                completed_old_names = [old_names[index] for index, name in enumerate(names)
                                       if name != old_names[index]]
                if (len(set(names)) != len(names)
                        or len(set(completed_old_names)) != len(completed_old_names)
                        or not same_slot_completion):
                    raise QuoteBoundaryError('quote_completion_identity_changed')
                updates['guests'] = deepcopy(guests)
                state['pending_name_completions'] = [
                    {'guest_index': index, 'completed_name': guest['name'],
                     'previous_name': old_guests[index].get('name')}
                    for index, guest in enumerate(guests)]
                state['pending_name_completion'] = state['pending_name_completions'][0]
                state['pending_eligibility_completions'] = [
                    {'guest_index': index, 'value': guest['explicit_gender']}
                    for index, guest in enumerate(guests)
                    if 'explicit_gender' in guest
                    and guest.get('explicit_gender') != old_guests[index].get('explicit_gender')]
            payment = params.get('payment_choice')
            if payment and payment != baseline.get('payment_choice'):
                if payment not in state['presentation'].get('payment_choices', []):
                    raise QuoteBoundaryError('accepted_quote_changed')
                updates['payment_choice'] = payment
                state['pending_payment_completion'] = payment
            if updates:
                state.setdefault('completion_plan', {}).update(updates)
        if (state['status'] != 'accepted' or not state.get('checked_offer')
                or any(state.get(key) for key in (
                    'pending_name_completion', 'pending_payment_completion',
                    'pending_eligibility_completion'))):
            presentation = state.get('presentation')
            shown = presentation.get('quote_revision') if isinstance(presentation, dict) else None
            baseline = _presentation_plan(state) if isinstance(presentation, dict) else None
            if (state.get('status') not in ('offered', 'accepted')
                    or not isinstance(presentation, dict)
                    or presentation.get('tenant') != ingress['tenant']
                    or presentation.get('scope') != state.get('scope')
                    or presentation.get('incarnation') != state.get('incarnation')
                    or presentation.get('original_turn') not in state.get('seen', [])
                    or not isinstance(presentation.get('displayed_text'), str)
                    or presentation.get('displayed_text_digest') != hashlib.sha256(
                        presentation['displayed_text'].encode()).hexdigest()
                    or not isinstance(shown, dict)
                    or (state.get('checked_offer') is not None
                        and shown != state['checked_offer'])
                    or not isinstance(baseline, dict)):
                raise QuoteBoundaryError('quote_owner_presented_offer_required')
            # The model owns the semantic decision to invoke create. Code owns the
            # facts: repeated arguments must match the shown offer; omitted values
            # come from that offer rather than model-created readiness state.
            new_group_fact = (params.get('group_gender')
                              if baseline.get('group_gender') is None
                              and params.get('group_gender') in ('male', 'female', 'mixed')
                              else None)
            candidate = deepcopy(baseline)
            candidate.update({key: deepcopy(value) for key, value in params.items()
                              if key not in ('confirm', 'ready')})
            if not _same_material_offer(baseline, candidate, shown, shown):
                raise QuoteBoundaryError('accepted_quote_changed')
            projected_hints = _project_room_name_hints_from_guests(
                candidate.get('guests'), baseline.get('room_name_hints')
                or shown.get('room_name_hints') or [], candidate.get('guest_count'))
            if 'room_name_hints' in params:
                supplied_projection = _project_room_name_hints_from_guests(
                    candidate.get('guests'), params.get('room_name_hints'),
                    candidate.get('guest_count'))
                if (projected_hints is None or supplied_projection != projected_hints):
                    raise QuoteBoundaryError('accepted_quote_changed')
                # Both a stale short-name restatement and an already-completed
                # restatement resolve to the same person-bound canonical hints.
                params['room_name_hints'] = deepcopy(projected_hints)
            if ('room_name_hints' in params
                    and not _person_plan_does_not_contradict_hints(
                        params, projected_hints or [])):
                raise QuoteBoundaryError('accepted_quote_changed')
            # Carried hints follow frozen guest slots even when restated out of order.
            if 'room_name_hints' in params:
                params['room_name_hints'] = _reconcile_carried_hint_order(
                    params['room_name_hints'], baseline.get('room_name_hints') or [])
            result = deepcopy(baseline)
            for key in _CARRIED_FIELDS:
                if key in params:
                    result[key] = deepcopy(params[key])
            projected_hints = _project_room_name_hints_from_guests(
                result.get('guests'), result.get('room_name_hints'), result.get('guest_count'))
            if projected_hints is not None:
                result['room_name_hints'] = projected_hints
            if new_group_fact is not None:
                result['group_gender'] = new_group_fact
                state['pending_group_gender_fact'] = new_group_fact
            state['status'] = 'accepted'
            state['accepted_presentation'] = deepcopy(presentation)
            state['completion_plan'] = {key: deepcopy(result[key]) for key in _CHECKED_FIELDS
                                        if key in result}
            # Force the existing quote recorder through its unchanged-terms path.
            # This is a fact refresh, not a cached readiness permission bit.
            state['pending_fact_refresh'] = True
            if not state.get('acceptance_message'):
                state['acceptance_message'] = ingress['MESSAGE_ID']
                state['acceptance_raw_digest'] = (state.get('current_turn') or {}).get('raw_digest')
            prepared = PreparedPlan(result, _current.get(), state['epoch'])
            prepared.revalidation = True
            return prepared
        # The model's create call is the contextual acceptance decision.
        # Interpreter schema/evidence/digest state remains diagnostic only.
        if (not isinstance(state.get('presentation'), dict)
                or not isinstance(state.get('accepted_presentation'), dict)
                or not isinstance(state.get('checked_offer'), dict)
                or not _same_material_offer(
                    state.get('plan'), _presentation_plan(state),
                    state.get('accepted_offer_snapshot'), state.get('checked_offer'))
                or not _same_material_offer(
                    state['accepted_presentation'].get('plan'), state.get('plan'),
                    state['accepted_presentation'].get('quote_revision'),
                    state.get('checked_offer'))
                or (state['accepted_presentation'].get('authoritative_quote') or {}).get('total_cents')
                    != (state.get('quote') or {}).get('total_cents')
                or (state['accepted_presentation'].get('authoritative_quote') or {}).get('currency')
                    != (state.get('quote') or {}).get('currency')):
            # No phrase/confirm compatibility path may bypass owner presentation,
            # structural interpretation, and the exact Staff-checked revision.
            raise QuoteBoundaryError('quote_owner_acceptance_required')
        result = deepcopy(params)
        plan = state['plan']
        candidate = deepcopy(plan)
        candidate.update({key: deepcopy(value) for key, value in params.items()
                          if key not in ('confirm', 'ready')})
        if not _same_material_offer(plan, candidate, state.get('checked_offer'),
                                    state.get('checked_offer')):
            raise QuoteBoundaryError('accepted_quote_changed')
        if ('room_name_hints' in params
                and not _person_plan_does_not_contradict_hints(
                    params, plan.get('room_name_hints')
                    or state.get('checked_offer', {}).get('room_name_hints') or [])):
            raise QuoteBoundaryError('accepted_quote_changed')
        # Carried hints follow frozen guest slots even when restated out of order.
        if 'room_name_hints' in params:
            params['room_name_hints'] = _reconcile_carried_hint_order(
                params['room_name_hints'], plan.get('room_name_hints') or [])
        for key, value in plan.items():
            if key not in _CARRIED_FIELDS:
                result[key] = deepcopy(value)
        for key in _CARRIED_FIELDS:
            if key in params:
                result[key] = deepcopy(params[key])
            elif key in plan:
                result[key] = deepcopy(plan[key])
        checked_offer = state.get('checked_offer') or {}
        # The accepted Staff revision owns create identity. Project its canonical
        # fields back onto the transport payload so model aliases or stale plan
        # representations cannot rebuild a different fingerprint at Staff.
        for key in ('check_in', 'check_out', 'guest_count', 'room_type',
                    'room_preference', 'gender_preference', 'package_code',
                    'guest_packages', 'add_ons', 'room_name_hints'):
            if key in checked_offer:
                result[key] = deepcopy(checked_offer[key])
        assignments = checked_offer.get('guest_bed_assignments')
        if isinstance(assignments, list) and assignments:
            ordered = sorted(assignments, key=lambda row: row.get('guest_index', -1))
            if (all(isinstance(row, dict) and type(row.get('guest_index')) is int
                    and isinstance(row.get('bed_code'), str)
                    and isinstance(row.get('guest_name'), str) for row in ordered)
                    and [row['guest_index'] for row in ordered] == list(range(len(ordered)))):
                current_guests = result.get('guests')
                if (not isinstance(current_guests, list) or len(current_guests) != len(ordered)
                        or any(not isinstance(guest, dict)
                               or ' '.join(str(guest.get('name') or '').split()).casefold()
                                  != row['guest_name'].casefold()
                               for guest, row in zip(current_guests, ordered))):
                    raise QuoteBoundaryError('accepted_quote_changed')
                # Keep human spelling/accents from the accepted plan while freezing
                # exact assignment order and bed identity from Staff's revision.
                result['guests'] = deepcopy(current_guests)
                result['selected_bed_codes'] = [row['bed_code'] for row in ordered]
        if type(checked_offer.get('per_guest_payment_links')) is bool:
            split = checked_offer['per_guest_payment_links']
            accepted_payment = checked_offer.get('payment_choice')
            if not (split and result.get('payment_choice') == 'per_guest'
                    and accepted_payment == 'deposit'):
                result['payment_choice'] = accepted_payment
            result['per_guest_payment_links'] = split
            result['payment_link_distribution'] = 'separate' if split else 'together'
            result.pop('payment_distribution', None)
        # Model-provided totals/quote IDs are not authority and never forwarded.
        for key in ('total_cents', 'quote_total_cents', 'accepted_quote_id',
                    'accepted_offer', 'require_offer_identity', 'offer_revision', 'availability'):
            result.pop(key, None)
        if state.get('checked_offer'):
            result['accepted_offer'] = deepcopy(state['checked_offer'])
            result['require_offer_identity'] = True
        # Replay/retry identity is owner-issued, never model-controlled. Keep
        # it stable across restart and omitted identities for this acceptance.
        result['idempotency_key'] = _owner_operation_key(state)
        state.setdefault('operation_key', result['idempotency_key'])
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
            'receipt': deepcopy(completion or state.get('partial_completion') or state.get('receipt')),
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
        receipt = state.get('completion') or state.get('partial_completion') or state.get('receipt')
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
        # The Staff create receipt is durable independently of adapter follow-up.
        # Do not freeze a failed/uncertain payment-link attempt as completion: a
        # same-operation retry must retain the booking IDs and retry only that
        # substep.  Link generation is not payment truth.
        if (response.get('payment_link_error')
                or any(isinstance(row, dict) for row in
                       (response.get('payment_link_failures') or []))):
            state['partial_completion'] = deepcopy(response)
            return
        if any(receipt.get(key) is not None and response.get(key) != receipt[key]
               for key in ('booking_id', 'booking_code', 'payment_id')):
            raise QuoteBoundaryError('create_completion_identity_mismatch')
        state['completion'] = deepcopy(response)
        state.pop('partial_completion', None)
    _transaction(complete)


def record_payment_completion(response):
    """Retain only successful payment truth bound to this owner's receipt."""
    def complete(state, ingress):
        del ingress
        if not isinstance(response, dict) or response.get('success') is not True:
            return
        receipt = state.get('completion') or state.get('partial_completion') or state.get('receipt')
        if not isinstance(receipt, dict):
            return
        compared_booking_keys = [key for key in ('booking_id', 'booking_code')
                                 if receipt.get(key) is not None
                                 and response.get(key) is not None]
        if (not compared_booking_keys
                or any(response.get(key) != receipt.get(key)
                       for key in compared_booking_keys)):
            return
        completion = deepcopy(receipt)
        if response.get('tool') == 'create_guest_payment_link':
            guest_id = response.get('booking_guest_id')
            known_guests = completion.get('booking_guests')
            if not (isinstance(guest_id, str) and guest_id
                    and isinstance(known_guests, list)
                    and any(isinstance(row, dict)
                            and row.get('booking_guest_id') == guest_id
                            for row in known_guests)):
                return
            links = [deepcopy(row) for row in completion.get('guest_payment_links') or []
                     if isinstance(row, dict)
                     and row.get('booking_guest_id') != guest_id]
            links.append({key: deepcopy(response.get(key)) for key in (
                'booking_guest_id', 'guest_number', 'guest_name', 'payment_id',
                'payment_target', 'amount_due_cents', 'currency',
                'secure_payment_url', 'payment_status', 'location_url')
                          if response.get(key) is not None})
            completion['guest_payment_links'] = links
        elif response.get('tool') == 'create_payment_link':
            if (receipt.get('payment_id') is not None
                    and response.get('payment_id') != receipt.get('payment_id')):
                return
            for key in ('payment_id', 'amount_due_cents', 'currency',
                        'secure_payment_url', 'payment_status', 'location_url'):
                if response.get(key) is not None:
                    completion[key] = deepcopy(response[key])
        else:
            return
        state['completion'] = completion
    try:
        _transaction(complete)
    except QuoteBoundaryError:
        return


def _revoke_checked_offer(state):
    state.update(status='clarify', quote=None, checked_offer=None)
    # Retain immutable accepted authority for exact fresh revalidation. The
    # clarify status and cleared checked offer still deny every create retry.
    state['pending_fact_refresh'] = True
    for key in ('presented_offer', 'auto_acceptance', 'dispatch_pending', 'dispatch_payload'):
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
        state['dispatch_payload'] = deepcopy(dict(prepared))
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


# The model writes these tokens. Code replaces each one from the saved booking.
_CONFIRMATION_SLOTS = (
    'ref', 'guest_names', 'check_in', 'check_out', 'room',
    'package', 'total', 'deposit', 'balance', 'balance_due_date', 'payment_link', 'location',
)
_SAVED_CONFIRMATION_SLOT_TEMPLATE = (
    'Booked {ref} for {guest_names}, {check_in} to {check_out}, '
    'room {room}, total {total}, deposit {deposit}.\n{payment_link}'
)


def _checkout_balance_required(facts):
    return (isinstance(facts, dict) and facts.get('balance_settlement') == 'checkout'
            and type(facts.get('remains_owed_cents')) is int
            and facts['remains_owed_cents'] > 0)


def _saved_confirmation_fallback_template(facts):
    """Keep English as a last resort without dropping saved settlement facts."""
    template = _SAVED_CONFIRMATION_SLOT_TEMPLATE
    if isinstance(facts.get('package'), str) and facts['package'].strip():
        template = template.replace(', total {total}', ', package {package}, total {total}')
    if _checkout_balance_required(facts):
        template = template.replace('.\n{payment_link}',
                                    '; {balance} remains and is paid at checkout.\n{payment_link}')
    return template
_INTERNAL_PAY_TAG = re.compile(r'\(\s*(?:full|deposit)\s*\)', re.IGNORECASE)
_ENGLISH_LOCATION = re.compile(r'here is our location\s*:', re.IGNORECASE)
_ENGLISH_CONFIRMATION_WORD = re.compile(
    r'\b(?:booked|booking|for|room|package|total|deposit|remains|paid|checkout|payment\s+link)\b',
    re.IGNORECASE)
_CONFIRMATION_LANGUAGE_WORDS = {
    'de': re.compile(r'\b(?:buchung|gebucht|für|zimmer|gesamt(?:preis)?|anzahlung|restbetrag|standort|gespeichert)\b', re.IGNORECASE),
    'es': re.compile(r'\b(?:reserva|reservad[ao]|para|habitación|depósito|saldo|ubicación|guardada)\b', re.IGNORECASE),
    'fr': re.compile(r'\b(?:réservation|réservée?|pour|chambre|acompte|solde|emplacement|enregistrée?)\b', re.IGNORECASE),
    'it': re.compile(r'\b(?:prenotazione|prenotat[ao]|per|camera|totale|deposito|saldo|posizione|salvata)\b', re.IGNORECASE),
}
_LOCATION_URL = re.compile(r'https://[^\s]+')
_CONFIRMATION_MONEY_OUTSIDE = re.compile(
    r'(?:€|£|\$)\s*\d|\d[\d.\s]*\s*(?:€|£|\$)'
    r'|\d[\d.,]*\s*(?:eur|usd|gbp)\b'
    r'|(?<![\d.,])\d{1,7}[.,]\d{2}(?!\d)',
    re.IGNORECASE)
_CONFIRMATION_REF_OUTSIDE = re.compile(r'\bWH-\d+(?:-\d+)*\b', re.IGNORECASE)
_CONFIRMATION_ROOM_OUTSIDE = re.compile(
    r'\b(?:rooms?|zimmer|habitaci[oó]n|chambres?|camera)\s*[:#\-–]?\s*[a-zA-Z]*\d+\b',
    re.IGNORECASE)
_CONFIRMATION_DATE_TOKEN = re.compile(r'\b\d{4}-\d{2}-\d{2}\b|\b\d{2}\.\d{2}\.\d{4}\b')
_INVENTED_PAID = (
    'payment confirmed', 'payment is confirmed', 'fully paid', 'has been paid',
    'zahlung bestätigt', 'vollständig bezahlt', 'pago confirmado',
    'pagamento confermato', 'paiement confirmé',
)
_CHECKOUT_SETTLEMENT = re.compile(
    r'\b(?:at\s+check[- ]?out|check[- ]?out|al\s+salir|a\s+la\s+salida|'
    r'al\s+hacer\s+el\s+check[- ]?out|alla\s+partenza|au\s+d[ée]part|bei\s+der\s+abreise)\b',
    re.IGNORECASE)


def _confirmation_language(facts):
    context = facts.get('rewrite_context') if isinstance(facts, dict) else None
    if not isinstance(context, dict):
        return 'en', ''
    language = str(context.get('language') or 'en').strip().lower()
    if language not in ('en', 'es', 'fr', 'de', 'it'):
        language = 'en'
    date_style = str(context.get('date_style') or '').strip().upper()
    return language, date_style


def _confirmation_date(value, language, date_style=''):
    """Saved stay date in the guest's language. German and DMY use day.month.year."""
    text = str(value or '').strip()
    iso = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', text)
    if iso and (language == 'de' or date_style == 'DMY'):
        return f'{iso[3]}.{iso[2]}.{iso[1]}'
    return _plain_stay_date(text, language)


def _confirmation_money(cents, language):
    """Saved cents as a guest amount. English uses €499.00; other languages 499,00 €."""
    whole, fraction = divmod(int(cents), 100)
    if language == 'en':
        return f'€{whole}.{fraction:02d}'
    return f'{whole},{fraction:02d} €'


def _confirmation_location_url(facts):
    if not isinstance(facts, dict):
        return None
    url = facts.get('location_url')
    return _usable_payment_url(url) if isinstance(url, str) else None


def _extract_location_url(*sources):
    for source in sources:
        if not isinstance(source, dict):
            continue
        line = source.get('guest_location_line') or source.get('location_url')
        if not isinstance(line, str) or not line.strip():
            continue
        match = _LOCATION_URL.search(line.strip())
        candidate = match.group(0).rstrip('.,);') if match else line.strip()
        url = _usable_payment_url(candidate)
        if url:
            return url
    return None


def _saved_property_location_url():
    """Read the current Staff-owned property map at confirmation time."""
    staff = (sys.modules.get('hermes_plugins.wolfhouse_staff_api')
             or sys.modules.get('wolfhouse_staff_api'))
    if staff is None:
        return None
    try:
        result = staff._post_bot('/house-info', {})
    except Exception:
        return None
    return _extract_location_url(result)


def _confirmation_is_english(text, facts):
    if not isinstance(text, str) or not text.strip():
        return False
    language, _date_style = _confirmation_language(facts)
    if language == 'en':
        return False
    without_slots = re.sub(r'\{[a-z_]+\}', '', text)
    target_words = _CONFIRMATION_LANGUAGE_WORDS.get(language)
    if target_words is not None and len(target_words.findall(without_slots)) < 2:
        return True
    return len(_ENGLISH_CONFIRMATION_WORD.findall(without_slots)) >= 3


def _confirmation_has_guest_leak(text, facts):
    """Internal pay tags and English location copy are not guest-facing."""
    if not isinstance(text, str) or not text.strip():
        return False
    if _INTERNAL_PAY_TAG.search(text):
        return True
    language, _date_style = _confirmation_language(facts)
    if _confirmation_is_english(text, facts):
        return True
    if language != 'en' and _ENGLISH_LOCATION.search(text):
        return True
    return False


def _strip_english_location_lines(text):
    """Drop English 'Here is our Location:' lines. Fact checks stay unchanged."""
    if not isinstance(text, str) or not text.strip():
        return text
    kept = [line for line in text.splitlines() if not _ENGLISH_LOCATION.search(line)]
    return '\n'.join(kept).strip()


def _payment_link_rows_from_receipt(receipt, guests):
    rows = []
    split = receipt.get('guest_payment_links') if isinstance(receipt, dict) else None
    if isinstance(split, list) and split:
        for index, row in enumerate(split):
            if not isinstance(row, dict):
                continue
            url = _usable_payment_url(row.get('secure_payment_url') or row.get('guest_payment_url'))
            if not url:
                continue
            name = row.get('guest_name')
            if not isinstance(name, str) or not name.strip():
                name = guests[index] if index < len(guests) else None
            item = {'url': url}
            if isinstance(name, str) and name.strip():
                item['name'] = name.strip()
            amount = row.get('amount_due_cents')
            if type(amount) is int and amount >= 0:
                item['amount_cents'] = amount
            rows.append(item)
        return rows
    return []


def _amount_due_now_cents(facts):
    """Cents the guest pays now. Full payment uses the total, not the policy deposit."""
    if not isinstance(facts, dict):
        return None
    due = facts.get('amount_due_now_cents')
    if type(due) is int and due >= 0:
        return due
    deposit = facts.get('deposit_cents')
    if type(deposit) is int and deposit >= 0:
        return deposit
    return None


def _confirmation_slot_values(facts):
    """Format saved booking facts for the confirmation slots. None if one is missing."""
    if not isinstance(facts, dict):
        return None
    language, date_style = _confirmation_language(facts)
    reference = facts.get('reference')
    check_in = facts.get('check_in')
    check_out = facts.get('check_out')
    guests = facts.get('guest_names')
    rooms = facts.get('room')
    links = facts.get('payment_links')
    total = facts.get('total_cents')
    deposit = _amount_due_now_cents(facts)
    if (not isinstance(reference, str) or not reference.strip()
            or not isinstance(check_in, str) or not check_in.strip()
            or not isinstance(check_out, str) or not check_out.strip()
            or not isinstance(guests, list) or not guests
            or any(not isinstance(value, str) or not value.strip() for value in guests)
            or not isinstance(rooms, list) or not rooms
            or any(not isinstance(value, str) or not value.strip() for value in rooms)
            or not isinstance(links, list) or not links
            or any(not isinstance(value, str) or not value.strip() for value in links)
            or type(total) is not int or total < 0
            or type(deposit) is not int or deposit < 0):
        return None
    values = {
        'ref': reference.strip(),
        'guest_names': _join_names([value.strip() for value in guests], language),
        'check_in': _confirmation_date(check_in, language, date_style),
        'check_out': _confirmation_date(check_out, language, date_style),
        'room': ', '.join(value.strip() for value in rooms),
        'total': _confirmation_money(total, language),
        'deposit': _confirmation_money(deposit, language),
        'payment_link': '\n'.join(value.strip() for value in links),
    }
    rows = facts.get('payment_link_rows')
    if isinstance(rows, list) and len(rows) == len(links):
        paired = []
        for row, link in zip(rows, links):
            if (not isinstance(row, dict) or row.get('url') != link
                    or not isinstance(row.get('name'), str) or not row['name'].strip()):
                paired = []
                break
            paired.append(f"{row['name'].strip()}: {link.strip()}")
        if paired:
            values['payment_link'] = '\n'.join(paired)
    package = facts.get('package')
    if isinstance(package, str) and package.strip():
        values['package'] = package.strip()
    due = facts.get('balance_due_at')
    if isinstance(due, str) and due.strip():
        values['balance_due_date'] = _confirmation_date(due, language, date_style)
    if any(not isinstance(value, str) or not value.strip() for value in values.values()):
        return None
    return values


def _confirmation_outside_slots(text):
    outside = text
    for name in _CONFIRMATION_SLOTS:
        outside = outside.replace('{' + name + '}', ' ')
    return outside


def _confirmation_outside_has_foreign_fact(outside):
    """Money, WH-digit refs, and room numbers the model wrote beside the slots."""
    masked = _CONFIRMATION_DATE_TOKEN.sub(' ', outside)
    if _CONFIRMATION_MONEY_OUTSIDE.search(masked):
        return True
    if _CONFIRMATION_REF_OUTSIDE.search(outside):
        return True
    if _CONFIRMATION_ROOM_OUTSIDE.search(outside):
        return True
    return False


_CONFIRMATION_URL_TOKEN = re.compile(r'https?://[^\s<>"\']+', re.IGNORECASE)
_CONFIRMATION_URL_TRAILING_PUNCTUATION = '.,;:!?)]}'


def _confirmation_has_exact_location_url(text, location):
    """Require the complete URL token, ignoring only surrounding punctuation."""
    if not isinstance(text, str) or not isinstance(location, str) or not location.strip():
        return False
    expected = location.strip()
    tokens = [
        match.group(0).rstrip(_CONFIRMATION_URL_TRAILING_PUNCTUATION)
        for match in _CONFIRMATION_URL_TOKEN.finditer(text)
    ]
    return expected in tokens


def _fill_confirmation_slots(text, facts):
    """Return the guest message with slots filled from the saved booking, or None.

    Every required slot must appear exactly once. The model may choose the
    surrounding words. Any other money amount, WH-digit booking ref, or room
    number outside the slots is rejected. A missing saved fact is not invented.
    """
    if not isinstance(text, str) or not text.strip() or not isinstance(facts, dict):
        return None
    folded = ' '.join(text.casefold().split())
    if any(claim in folded for claim in _INVENTED_PAID):
        return None
    values = _confirmation_slot_values(facts)
    if not values:
        return None
    if '{balance}' in text:
        owed = facts.get('remains_owed_cents')
        if type(owed) is not int or owed < 0:
            return None
        language, _date_style = _confirmation_language(facts)
        values = dict(values, balance=_confirmation_money(owed, language))
    elif _checkout_balance_required(facts):
        return None
    location = _confirmation_location_url(facts)
    if location:
        values = dict(values, location=location)
    elif '{location}' in text:
        return None
    required = [name for name in _CONFIRMATION_SLOTS if name in values]
    if any(text.count('{' + name + '}') != 1 for name in required):
        return None
    # A balance-due slot with no saved date would be sent as a literal token.
    if '{balance_due_date}' in text and 'balance_due_date' not in values:
        return None
    outside = _confirmation_outside_slots(text)
    if _confirmation_outside_has_foreign_fact(outside):
        return None
    if _confirmation_has_guest_leak(outside, facts):
        return None
    filled = text
    for name in required:
        filled = filled.replace('{' + name + '}', values[name], 1)
    if any('{' + name + '}' in filled for name in _CONFIRMATION_SLOTS):
        return None
    if location and not _confirmation_has_exact_location_url(filled, location):
        return None
    if _confirmation_has_guest_leak(filled, facts):
        return None
    if (_checkout_balance_required(facts)
            and not _CHECKOUT_SETTLEMENT.search(filled)):
        return None
    return filled.strip()


def _confirmation_has_all_facts(text, facts):
    """True when the model draft can be sent after slot fill from the saved booking."""
    return _sendable_saved_confirmation(text, facts) is not None


_MONEY_AMOUNT = re.compile(
    r'(?:€|eur(?:o)?s?)\s*(\d{1,7}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)'
    r'|(\d{1,7}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:€|eur(?:o)?s?)',
    re.IGNORECASE)
_TOTAL_ROLE = re.compile(
    r'\b(total|gesamt(?:preis|betrag)?|insgesamt|totale)\b', re.IGNORECASE)
_DEPOSIT_ROLE = re.compile(
    r'\b(deposit|anzahlung|caparra|acompte|seña|due now|pay now|'
    r'zahlung|vollständig|full(?:\s+payment)?)\b', re.IGNORECASE)
_BALANCE_ROLE = re.compile(
    r'\b(balance|rest(?:betrag)?|remaining|saldo|restzahlung|noch\s+zu\s+zahlen|'
    r'offen(?:er|e|es|en)?(?:\s+betrag)?|verbleib(?:end(?:er|e|es|en)?)?)\b',
    re.IGNORECASE)
_MONTH_INDEX = {
    'january': 1, 'jan': 1, 'januar': 1, 'febrero': 2, 'february': 2, 'feb': 2,
    'februar': 2, 'march': 3, 'mar': 3, 'märz': 3, 'maerz': 3, 'mär': 3, 'marzo': 3,
    'april': 4, 'apr': 4, 'abril': 4, 'may': 5, 'mai': 5, 'mayo': 5, 'june': 6,
    'jun': 6, 'juni': 6, 'junio': 6, 'july': 7, 'jul': 7, 'juli': 7, 'julio': 7,
    'august': 8, 'aug': 8, 'agosto': 8, 'september': 9, 'sep': 9, 'sept': 9,
    'septiembre': 9, 'october': 10, 'oct': 10, 'oktober': 10, 'okt': 10, 'octubre': 10,
    'november': 11, 'nov': 11, 'noviembre': 11, 'december': 12, 'dec': 12,
    'dezember': 12, 'dez': 12, 'diciembre': 12,
}


def _money_token_to_cents(token):
    raw = str(token or '').strip()
    if not raw:
        return None
    if re.fullmatch(r'\d{1,7}', raw):
        return int(raw) * 100
    if re.fullmatch(r'\d{1,3}(?:\.\d{3})+,\d{1,2}', raw):
        whole, frac = raw.replace('.', '').split(',')
        return int(whole) * 100 + int((frac + '0')[:2])
    if re.fullmatch(r'\d{1,3}(?:,\d{3})+\.\d{1,2}', raw):
        whole, frac = raw.replace(',', '').split('.')
        return int(whole) * 100 + int((frac + '0')[:2])
    if re.fullmatch(r'\d{1,7},\d{1,2}', raw):
        whole, frac = raw.split(',')
        return int(whole) * 100 + int((frac + '0')[:2])
    if re.fullmatch(r'\d{1,7}\.\d{1,2}', raw):
        whole, frac = raw.split('.')
        return int(whole) * 100 + int((frac + '0')[:2])
    return None


def _parse_money_amounts(text):
    found = []
    for match in _MONEY_AMOUNT.finditer(text or ''):
        token = match.group(1) or match.group(2)
        cents = _money_token_to_cents(token)
        if type(cents) is int:
            found.append((match.start(), match.end(), cents))
    return found


def _role_window(text, start, width=48):
    return text[max(0, start - width):start]


def _nearest_money_role(text, start, width=40):
    """Role word closest before this amount, within width characters."""
    best = None
    prefix = text[:start]
    for regex, role in ((_TOTAL_ROLE, 'total'), (_DEPOSIT_ROLE, 'deposit'),
                        (_BALANCE_ROLE, 'balance')):
        for match in regex.finditer(prefix):
            dist = start - match.end()
            if 0 <= dist <= width and (best is None or dist < best[0]):
                best = (dist, role)
    return best[1] if best else None


def _iso_parts(value):
    match = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', str(value or '').strip())
    if not match:
        return None
    return int(match[1]), int(match[2]), int(match[3])


def _saved_date_mentioned(text, iso):
    parts = _iso_parts(iso)
    if not parts:
        return False
    year, month, day = parts
    folded = ' '.join(str(text or '').casefold().split())
    dotted = (f'{day:02d}.{month:02d}.{year:04d}', f'{day}.{month:02d}.{year:04d}',
              f'{day}.{month}.{year:04d}', f'{year:04d}-{month:02d}-{day:02d}')
    if any(token in folded or token in str(text or '') for token in dotted):
        return True
    for match in re.finditer(r'(\d{1,2})\.?\s*([a-zäöü]{3,})', folded):
        month_idx = _MONTH_INDEX.get(match.group(2)) or _MONTH_INDEX.get(match.group(2)[:3])
        if month_idx == month and int(match.group(1)) == day:
            return True
    return False


def _looks_like_saved_confirmation(text, facts):
    if not isinstance(text, str) or not text.strip() or not isinstance(facts, dict):
        return False
    if any('{' + name + '}' in text for name in _CONFIRMATION_SLOTS):
        return True
    reference = facts.get('reference')
    if not isinstance(reference, str) or not reference.strip() or reference.strip() not in text:
        return False
    return len(_parse_money_amounts(text)) >= 2


def _filled_confirmation_matches_facts(text, facts):
    """Role-aware check: total next to total, deposit/due next to deposit, plus identity facts."""
    if not isinstance(text, str) or not text.strip() or not isinstance(facts, dict):
        return False
    folded = ' '.join(text.casefold().split())
    if any(claim in folded for claim in _INVENTED_PAID):
        return False
    if _confirmation_has_guest_leak(text, facts):
        return False
    reference = facts.get('reference')
    guests = facts.get('guest_names')
    rooms = facts.get('room')
    package = facts.get('package')
    links = facts.get('payment_links')
    total = facts.get('total_cents')
    due = _amount_due_now_cents(facts)
    location = _confirmation_location_url(facts)
    if (not isinstance(reference, str) or reference.strip() not in text
            or not isinstance(guests, list) or not guests
            or any(not isinstance(name, str) or name.strip() not in text for name in guests)
            or not isinstance(rooms, list) or not rooms
            or any(not isinstance(room, str) or room.strip() not in text for room in rooms)
            or (isinstance(package, str) and package.strip() and package.strip() not in text)
            or not isinstance(links, list) or not links
            or any(not isinstance(link, str) or link.strip() not in text for link in links)
            or (location is not None
                and not _confirmation_has_exact_location_url(text, location))
            or type(total) is not int or type(due) is not int):
        return False
    others = [match.group(0) for match in _CONFIRMATION_REF_OUTSIDE.finditer(text)
              if match.group(0).upper() != reference.strip().upper()]
    if others:
        return False
    if not _saved_date_mentioned(text, facts.get('check_in')):
        return False
    if not _saved_date_mentioned(text, facts.get('check_out')):
        return False
    amounts = _parse_money_amounts(text)
    total_ok = False
    deposit_ok = False
    swapped = False
    for start, _end, cents in amounts:
        role = _nearest_money_role(text, start)
        if role == 'total':
            if cents == total:
                total_ok = True
            elif cents == due and due != total:
                swapped = True
        elif role == 'deposit':
            if cents == due:
                deposit_ok = True
            elif cents == total and due != total:
                swapped = True
    if swapped or not total_ok or not deposit_ok:
        return False
    owed = facts.get('remains_owed_cents')
    balance_ok = not _checkout_balance_required(facts)
    for start, _end, cents in amounts:
        if _nearest_money_role(text, start) != 'balance':
            continue
        if type(owed) is int and owed >= 0 and cents != owed:
            return False
        if type(owed) is int and cents == owed:
            balance_ok = True
    if (not balance_ok or (_checkout_balance_required(facts)
                           and not _CHECKOUT_SETTLEMENT.search(text))):
        return False
    return True


def _sendable_saved_confirmation(text, facts):
    """Slot-fill a draft, or keep already-filled text that matches saved facts."""
    filled = _fill_confirmation_slots(text, facts)
    if filled:
        return filled
    if _filled_confirmation_matches_facts(text, facts):
        return text.strip()
    return None


def _confirmation_reject_reasons(text, facts):
    """Why the fact check refused this draft. Does not change the checks."""
    if _sendable_saved_confirmation(text, facts) is not None:
        return []
    if not isinstance(text, str) or not text.strip():
        return ['empty_draft']
    if not isinstance(facts, dict):
        return ['missing_facts']
    reasons = []
    language, _date_style = _confirmation_language(facts)
    if _INTERNAL_PAY_TAG.search(text):
        reasons.append('internal_pay_tag')
    if language != 'en' and _ENGLISH_LOCATION.search(text):
        reasons.append('english_location_line')
    location = _confirmation_location_url(facts)
    if location and location not in text and '{location}' not in text:
        reasons.append('missing_location')
    folded = ' '.join(text.casefold().split())
    if any(claim in folded for claim in _INVENTED_PAID):
        reasons.append('invented_paid_claim')
    reference = facts.get('reference')
    if not isinstance(reference, str) or not reference.strip() or reference.strip() not in text:
        reasons.append('missing_reference')
    guests = facts.get('guest_names') if isinstance(facts.get('guest_names'), list) else []
    for name in guests:
        if isinstance(name, str) and name.strip() and name.strip() not in text:
            reasons.append('missing_guest_name')
    rooms = facts.get('room') if isinstance(facts.get('room'), list) else []
    for room in rooms:
        if isinstance(room, str) and room.strip() and room.strip() not in text:
            reasons.append('missing_room')
    package = facts.get('package')
    if isinstance(package, str) and package.strip() and package.strip() not in text:
        reasons.append('missing_package')
    links = facts.get('payment_links') if isinstance(facts.get('payment_links'), list) else []
    for link in links:
        if isinstance(link, str) and link.strip() and link.strip() not in text:
            reasons.append('missing_payment_link')
    if not _saved_date_mentioned(text, facts.get('check_in')):
        reasons.append('check_in_date_not_mentioned')
    if not _saved_date_mentioned(text, facts.get('check_out')):
        reasons.append('check_out_date_not_mentioned')
    total = facts.get('total_cents')
    due = _amount_due_now_cents(facts)
    amounts = _parse_money_amounts(text)
    total_ok = False
    deposit_ok = False
    swapped = False
    if type(total) is int and type(due) is int:
        for start, _end, cents in amounts:
            role = _nearest_money_role(text, start)
            if role == 'total':
                if cents == total:
                    total_ok = True
                elif cents == due and due != total:
                    swapped = True
            elif role == 'deposit':
                if cents == due:
                    deposit_ok = True
                elif cents == total and due != total:
                    swapped = True
        if swapped:
            reasons.append('total_and_deposit_swapped')
        if not total_ok:
            reasons.append('total_amount_missing_or_not_next_to_total_role')
        if not deposit_ok:
            reasons.append('deposit_amount_missing_or_not_next_to_deposit_role')
    owed = facts.get('remains_owed_cents')
    for start, _end, cents in amounts:
        if _nearest_money_role(text, start) != 'balance':
            continue
        if type(owed) is int and owed >= 0 and cents != owed:
            reasons.append('wrong_balance_amount')
            break
    others = [match.group(0) for match in _CONFIRMATION_REF_OUTSIDE.finditer(text)
              if isinstance(reference, str) and match.group(0).upper() != reference.strip().upper()]
    if others:
        reasons.append('foreign_booking_reference')
    if '{' in text:
        outside = _confirmation_outside_slots(text)
        if _confirmation_outside_has_foreign_fact(outside):
            reasons.append('foreign_fact_outside_slots')
    if not reasons:
        reasons.append('facts_not_matched')
    return reasons


def _rewrite_saved_confirmation(agent, facts, invalid_draft, timeout=12):
    """Make a bounded tool-disabled rewrite, retrying once on wrong-language output."""
    language, _date_style = _confirmation_language(facts)
    reasons = _confirmation_reject_reasons(invalid_draft, facts)
    try:
        import logging
        logging.getLogger('wolfhouse.accepted_quote').warning(
            'saved-booking-confirmation-rejected language=%s reasons=%s',
            language, reasons)
    except Exception:
        pass
    prompt = json.dumps({
        'canonical_saved_booking': facts,
        'invalid_draft': invalid_draft if isinstance(invalid_draft, str) else None,
        'guest_language': language,
        'reject_reasons': reasons,
        'booking_confirmation_guide': (
            'The previous confirmation draft was rejected. Rewrite ONE confirmation '
            'in the guest language (' + language + '). Keep every saved fact. Do not '
            'switch to English unless the guest language is English. '
            'After the booking is saved, confirm it in the same reply as the payment link. '
            'Facts come from the saved booking; only the wording is yours. Write each saved '
            'fact as a slot, exactly once: {ref}, {guest_names}, {check_in}, {check_out}, '
            '{room}, {package} when a package was saved, {total}, {deposit}, '
            '{balance} whenever a balance remains, and say in your own words in the guest '
            'language that this balance is paid at checkout. '
            '{balance_due_date} when a balance due date was saved, {payment_link}, and '
            '{location} when a map URL was saved. Include every guest name only through '
            '{guest_names}. {room} is the saved room from the booking. Do not write (full) '
            'or (deposit). {location} is the map URL; word the map line in the guest '
            'language and never write English "Here is our Location:" unless the guest '
            'language is English. Do not write any other money amount, any other booking '
            'reference (WH- plus digits), or any other room number outside those slots. '
            'Code fills the slots in the guest language. Match the selected Staff '
            'personality style. Keep it warm and short. Extra style uses a fitting '
            'self-selected emoji on every fact line; all other styles use plain short lines '
            'or bullets without emoji bullets. One next step: pay through the link. Never '
            'invent, round, omit, or alter a fact, and do not claim payment succeeded.'),
        'requirements': ('Write one guest-facing confirmation in the guest language whose '
                         'saved facts are the slots '
                         '{ref}, {guest_names}, {check_in}, {check_out}, {room}, '
                         '{package} when saved, {total}, '
                         '{deposit}, {balance} if stated, {balance_due_date} when saved, '
                         '{payment_link}, and {location} when a map URL was saved, each '
                         'exactly once. Do not put a money amount, WH-digit reference, or room '
                         'number anywhere else. Preserve register and personality layout. '
                         'Fix exactly the reject_reasons. Use the guest language only.'),
    }, ensure_ascii=False, sort_keys=True)
    messages = [
        {'role': 'system', 'content': ('Rewrite only from supplied canonical facts. '
                                      'You have no tools and may not perform operations.')},
        {'role': 'user', 'content': prompt},
    ]
    client = agent._create_request_openai_client(reason='saved-booking-confirmation-rewrite')
    try:
        for attempt in range(2):
            if attempt:
                payload = json.loads(prompt)
                payload['language_retry'] = True
                payload['retry_instruction'] = (
                    'The prior rewrite was empty or English. Return a complete confirmation '
                    f'only in guest_language={language}; never return English.')
                messages[1]['content'] = json.dumps(
                    payload, ensure_ascii=False, sort_keys=True)
            if getattr(agent, 'api_mode', 'chat_completions') == 'codex_responses':
                response = client.responses.create(model=agent.model, input=messages, tools=[],
                                                   stream=False, timeout=timeout)
                text = getattr(response, 'output_text', None)
            else:
                response = client.chat.completions.create(model=agent.model, messages=messages,
                                                          tools=[], tool_choice='none', stream=False,
                                                          timeout=timeout)
                text = response.choices[0].message.content
            text = text.strip() if isinstance(text, str) and text.strip() else None
            if text and not _confirmation_is_english(text, facts):
                return text
        return None
    finally:
        closer = getattr(agent, '_close_request_openai_client', None)
        if callable(closer):
            closer(client)


def _saved_confirmation_facts(plan, offer, receipt):
    """Build the complete, value-only contract a model confirmation must repeat."""
    reference = receipt.get('booking_code') or receipt.get('booking_id')
    guests = [row.get('name').strip() for row in plan.get('guests', [])
              if isinstance(row, dict) and isinstance(row.get('name'), str)
              and row.get('name').strip()]
    rooms = []
    for row in offer.get('room_arrangement', []):
        if not isinstance(row, dict):
            continue
        # Do not invent a room-kind contract: use only Staff-returned identifiers.
        value = row.get('bed_code') or row.get('room_code')
        if isinstance(value, str) and value.strip() and value.strip() not in rooms:
            rooms.append(value.strip())
    links = []
    split = receipt.get('guest_payment_links')
    candidates = split if isinstance(split, list) else [receipt]
    for row in candidates:
        if isinstance(row, dict):
            value = _usable_payment_url(row.get('secure_payment_url') or row.get('guest_payment_url'))
            if value and value not in links:
                links.append(value)
    facts = {
        'reference': reference, 'check_in': plan.get('check_in'),
        'check_out': plan.get('check_out'), 'guest_names': guests, 'room': rooms,
        'total_cents': offer.get('total_cents'),
        'deposit_cents': offer.get('deposit_required_cents'),
        'payment_links': links,
    }
    # Prefer explicit saved-booking labels and settlement facts.  Their absence
    # is not permission to derive guest-facing policy from a quote description.
    nights = receipt.get('nights')
    if type(nights) is not int:
        nights = offer.get('nights')
    if type(nights) is int and nights > 0:
        facts['nights'] = nights
    guest_rooms = receipt.get('guest_rooms') or offer.get('guest_rooms')
    projected_rooms = []
    projected_types = set()
    if isinstance(guest_rooms, list):
        for row in guest_rooms:
            if not isinstance(row, dict):
                continue
            label = (row.get('guest_safe_room_label') or row.get('room_label')
                     or row.get('room_name') or row.get('room_code')
                     or row.get('number'))
            if isinstance(label, str) and label.strip() and label.strip() not in projected_rooms:
                projected_rooms.append(label.strip())
            kind = (row.get('room_type') or row.get('room_kind')
                    or row.get('selected_room_description'))
            if kind == 'private':
                projected_types.add('private')
            elif kind in ('shared', 'male_only', 'female_only', 'mixed'):
                projected_types.add('shared')
    if projected_rooms:
        facts['room'] = projected_rooms
    room_label = (receipt.get('guest_safe_room_label')
                  or offer.get('guest_safe_room_label')
                  or receipt.get('room_label') or offer.get('room_label'))
    room_description = (receipt.get('selected_room_description')
                        or offer.get('selected_room_description'))
    room_type = receipt.get('room_type') or offer.get('room_type')
    if isinstance(room_label, str) and room_label.strip() and not projected_rooms:
        facts['room'] = [room_label.strip()]
    if projected_types == {'private'}:
        room_type = 'private'
    elif projected_types:
        room_type = 'shared'
    elif room_description == 'private':
        room_type = 'private'
    elif room_description in ('male_only', 'female_only', 'mixed', 'shared'):
        room_type = 'shared'
    if room_type in ('private', 'shared'):
        facts['room_type'] = room_type
    package = receipt.get('package_label') or offer.get('package_label')
    if not (isinstance(package, str) and package.strip()):
        package_code = receipt.get('package_code') or offer.get('package_code') or plan.get('package_code')
        package = {'malibu': 'Malibu', 'uluwatu': 'Uluwatu', 'waimea': 'Waimea'}.get(
            package_code.strip().lower() if isinstance(package_code, str) else '')
    if isinstance(package, str) and package.strip():
        facts['package'] = package.strip()
    due_now = receipt.get('amount_due_cents')
    if type(due_now) is not int and isinstance(split, list):
        split_amounts: list[int] = []
        split_amounts_valid = bool(split)
        for row in split:
            value = row.get('amount_due_cents') if isinstance(row, dict) else None
            if type(value) is not int or value < 0:
                split_amounts_valid = False
                break
            split_amounts.append(value)
        if split_amounts_valid:
            due_now = sum(split_amounts)
    if type(due_now) is int and due_now >= 0:
        facts['amount_due_now_cents'] = due_now
    owed = receipt.get('remaining_balance_cents')
    if type(owed) is not int:
        owed = receipt.get('balance_cents')
    if type(owed) is not int:
        owed = offer.get('remaining_after_deposit_cents')
    # A saved receipt's exact amount due now is authoritative enough to recover
    # the owed amount when Staff omitted the redundant balance projection.
    total = facts.get('total_cents')
    if (type(owed) is not int and type(total) is int and type(due_now) is int
            and 0 <= due_now <= total):
        owed = total - due_now
    if type(owed) is int and owed >= 0:
        facts['remains_owed_cents'] = owed
        if owed > 0:
            facts['balance_settlement'] = 'checkout'
    due_at = receipt.get('balance_due_at') or offer.get('balance_due_at')
    if isinstance(due_at, str) and due_at.strip():
        facts['balance_due_at'] = due_at.strip()
    language = plan.get('language')
    style = plan.get('personality_style') or receipt.get('personality_style')
    date_style = plan.get('date_style') or receipt.get('date_style')
    if language or style or date_style:
        facts['rewrite_context'] = {
            key: value for key, value in (('language', language),
                                         ('personality_style', style),
                                         ('date_style', date_style))
            if isinstance(value, str) and value.strip()
        }
    rows = _payment_link_rows_from_receipt(receipt, guests)
    if rows and any(row.get('name') or type(row.get('amount_cents')) is int for row in rows):
        facts['payment_link_rows'] = rows
    location = _saved_property_location_url()
    if location:
        facts['location_url'] = location
    return facts


def _persisted_handoff_copy(messages, language):
    """Return only model-authored handoff wording after persisted tool truth."""
    del language
    if not isinstance(messages, list):
        return None
    last_user = max((i for i, item in enumerate(messages)
                     if isinstance(item, dict) and item.get('role') == 'user'), default=-1)
    persisted = False
    for item in messages[last_user + 1:]:
        if not isinstance(item, dict):
            continue
        if item.get('role') == 'tool':
            try:
                outcome = json.loads(item.get('content') or '{}')
            except (TypeError, ValueError):
                continue
            persisted = bool(isinstance(outcome, dict)
                             and outcome.get('tool') == 'flag_needs_human'
                             and outcome.get('success') is True
                             and outcome.get('needs_human') is True
                             and outcome.get('handoff_persisted') is True)
        elif persisted and item.get('role') == 'assistant':
            wording = item.get('content')
            if isinstance(wording, str) and wording.strip():
                return wording.strip()
    return None


def _surface_confirmation_owed(output, facts, status=None):
    reference = facts.get('reference') if isinstance(facts, dict) else None
    visible = deepcopy(status) if isinstance(status, dict) else {}
    visible.update({
        'status': 'owed',
        'booking_reference': reference,
        'reason': visible.get('reason') or 'confirmation_rewrite_failed',
    })
    output['confirmation_withheld'] = True
    output['confirmation_status'] = visible
    logger.warning('confirmation_owed reference=%s reason=%s',
                   reference or 'unknown', visible['reason'])
    return visible


def finalize_offer_response(result, rewrite_callback=None, saved_booking_projection=None):
    """Own quote presentation and successful-create truth in the returned reply."""
    if not isinstance(result, dict):
        return result
    terminal_failure = (result.get('completed') is not True
                        or result.get('failed') or result.get('interrupted')
                        or result.get('error'))
    normalized = _whatsapp_emphasis(result.get('final_response'))
    if normalized != result.get('final_response'):
        result = deepcopy(result)
        result['final_response'] = normalized
        output_messages = result.get('messages')
        if (isinstance(output_messages, list) and output_messages
                and isinstance(output_messages[-1], dict)
                and output_messages[-1].get('role') == 'assistant'):
            output_messages[-1]['content'] = normalized
    def present(state, ingress):
        messages = result.get('messages')
        retained_receipt = (state.get('completion') or state.get('partial_completion')
                            or state.get('receipt'))
        saved_booking_exists = bool(
            isinstance(saved_booking_projection, dict)
            or isinstance(state.get('confirmation_owed'), dict)
            or (isinstance(retained_receipt, dict)
                and retained_receipt.get('success') is True
                and (retained_receipt.get('booking_code')
                     or retained_receipt.get('booking_id'))
                and isinstance(state.get('checked_offer'), dict)))
        # Once Staff has saved the booking, an exhausted post-tool model loop no
        # longer owns the outcome. Build the confirmation directly from the
        # retained receipt instead of returning an empty/error gateway result.
        if terminal_failure and not saved_booking_exists:
            return result
        handoff_text = _persisted_handoff_copy(messages, _guest_language(state))
        # Tool truth owns this copy boundary. eligibility_required means person
        # eligibility is unknown, never that requested stock is unavailable.
        if isinstance(messages, list) and not handoff_text:
            last_user = max((index for index, item in enumerate(messages)
                             if isinstance(item, dict) and item.get('role') == 'user'),
                            default=-1)
            for item in reversed(messages[last_user + 1:]):
                if not isinstance(item, dict) or item.get('role') != 'tool':
                    continue
                try:
                    tool_result = json.loads(item.get('content') or '{}')
                except (TypeError, ValueError):
                    continue
                if not isinstance(tool_result, dict):
                    continue
                structured = (tool_result.get('room_decision') or tool_result.get('room_eligibility')
                              if isinstance(tool_result, dict) else None)
                structured_text = _structured_eligibility_copy(
                    structured, _presentation_plan(state), _guest_language(state))
                legacy_draft = (tool_result.get('reply_draft', '').strip()
                                if not isinstance(structured, dict)
                                and isinstance(tool_result.get('reply_draft'), str)
                                and tool_result['reply_draft'].strip().endswith('?') else None)
                # Iteration is newest-first: a newer no-stock quote resolves any
                # older eligibility uncertainty in this same guest turn.
                if (tool_result.get('unavailable') is True
                        or tool_result.get('availability_status') == 'unavailable'):
                    break
                if (isinstance(tool_result, dict)
                        and tool_result.get('availability_status') == 'eligibility_required'
                        and tool_result.get('next_action') == 'ask_room_eligibility'
                        and (structured_text or legacy_draft)):
                    output = deepcopy(result)
                    text = _prepend_revision_acknowledgement(
                        state, structured_text or legacy_draft, _guest_language(state))
                    output['final_response'] = text
                    output_messages = output.get('messages')
                    if (output_messages and isinstance(output_messages[-1], dict)
                            and output_messages[-1].get('role') == 'assistant'):
                        output_messages[-1]['content'] = text
                    return output
                # Checked quote/create truth also resolves any older eligibility
                # uncertainty in this same guest turn.
                if (isinstance(tool_result, dict) and tool_result.get('success') is True
                        and (isinstance(tool_result.get('offer_revision'), dict)
                             or tool_result.get('booking_id')
                             or tool_result.get('booking_code'))):
                    break
        unresolved = state.get('quote') or {}
        unresolved_presentable = (
            state.get('status') == 'blocked'
            and unresolved.get('quote_status') == 'needs_guest_clarification'
            and unresolved.get('offer_revision') is None
            and state.get('offer_message') == ingress['MESSAGE_ID']
        )
        if unresolved_presentable and not handoff_text:
            language = _guest_language(state)
            plan = _presentation_plan(state)
            # Package selection, room eligibility, and inventory are distinct
            # typed outcomes. A nested package-preview failure must never fall
            # through to the eligible-bed refusal copy.
            owner_copy = _blocked_clarification_copy(unresolved, plan, language)
            if owner_copy is None:
                output = deepcopy(result)
                output['response_intent'] = {
                    'kind': 'offer_unavailable',
                    'facts': deepcopy(unresolved),
                }
                return output
            text = _prepend_revision_acknowledgement(state, owner_copy, language)
            output = deepcopy(result)
            output['final_response'] = text
            output_messages = output.get('messages')
            if (isinstance(output_messages, list) and output_messages
                    and isinstance(output_messages[-1], dict)
                    and output_messages[-1].get('role') == 'assistant'):
                output_messages[-1]['content'] = text
            return output
        current_tools = []
        receipt = state.get('completion') or state.get('partial_completion') or state.get('receipt')
        if isinstance(saved_booking_projection, dict):
            # Recovery dispatch bypasses the model loop and has no tool message.
            # Only the installed owner boundary may supply this handler receipt.
            receipt = saved_booking_projection
        if isinstance(messages, list) and isinstance(receipt, dict):
            last_user = max((index for index, item in enumerate(messages)
                             if isinstance(item, dict) and item.get('role') == 'user'),
                            default=-1)
            current_tools = [item for item in messages[last_user + 1:]
                             if isinstance(item, dict) and item.get('role') == 'tool']
        current_create = (isinstance(saved_booking_projection, dict)
                          or isinstance(state.get('confirmation_owed'), dict))
        created_this_turn = isinstance(saved_booking_projection, dict)
        if isinstance(messages, list) and isinstance(receipt, dict):
            last_user = max((index for index, item in enumerate(messages)
                             if isinstance(item, dict) and item.get('role') == 'user'),
                            default=-1)
            for item in messages[last_user + 1:]:
                if not isinstance(item, dict) or item.get('role') != 'tool':
                    continue
                try:
                    candidate = json.loads(item.get('content') or '{}')
                except (TypeError, ValueError):
                    continue
                if (isinstance(candidate, dict)
                        and candidate.get('tool') == 'create_booking_from_plan'
                        and candidate.get('success') is True):
                    current_create = True
                    created_this_turn = True
                    break
        owed_confirmation = isinstance(state.get('confirmation_owed'), dict)
        if (current_create and (owed_confirmation or (
                isinstance(receipt, dict) and isinstance(state.get('checked_offer'), dict)))):
            # Recovery owns a durable projection and must not depend on ephemeral
            # quote/receipt state surviving into the next inbound turn.
            completed_offer = state.get('checked_offer') or {}
            # A successful save always crosses the confirmation validator. A
            # missing room projection is a missing canonical fact, never permission
            # to send unchecked model text.
            if True:
                model_confirmation = result.get('final_response')
                projected_receipt = (deepcopy(receipt)
                                     if isinstance(receipt, dict) else {})
                reference = projected_receipt.get('booking_code') or projected_receipt.get('booking_id')
                for tool_message in current_tools:
                    try:
                        candidate = json.loads(tool_message.get('content') or '{}')
                    except (TypeError, ValueError):
                        continue
                    if (isinstance(candidate, dict)
                            and candidate.get('tool') in (
                                'create_payment_link', 'create_guest_payment_link')
                            and candidate.get('success') is True
                            and reference
                            and ((candidate.get('booking_code') is not None
                                  and projected_receipt.get('booking_code') == candidate.get('booking_code'))
                                 or (candidate.get('booking_id') is not None
                                     and projected_receipt.get('booking_id') == candidate.get('booking_id')))
                            and (
                                (candidate.get('booking_code') is None
                                 or projected_receipt.get('booking_code') == candidate.get('booking_code'))
                                and (candidate.get('booking_id') is None
                                     or projected_receipt.get('booking_id') == candidate.get('booking_id')))):
                        if candidate.get('tool') == 'create_guest_payment_link':
                            guest_id = candidate.get('booking_guest_id')
                            known_guests = projected_receipt.get('booking_guests')
                            if not (isinstance(guest_id, str) and guest_id
                                    and isinstance(known_guests, list)
                                    and any(isinstance(row, dict)
                                            and row.get('booking_guest_id') == guest_id
                                            for row in known_guests)):
                                continue
                            guest_links = [deepcopy(row) for row in
                                           projected_receipt.get('guest_payment_links') or []
                                           if isinstance(row, dict)
                                           and row.get('booking_guest_id') != guest_id]
                            guest_links.append({
                                key: deepcopy(value) for key, value in candidate.items()
                                if key in ('booking_guest_id', 'guest_number', 'guest_name',
                                           'payment_id', 'payment_target', 'amount_due_cents',
                                           'currency', 'secure_payment_url', 'payment_status',
                                           'location_url') and value is not None
                            })
                            projected_receipt['guest_payment_links'] = guest_links
                        projected_receipt.update({
                            key: value for key, value in candidate.items()
                            if key in ('secure_payment_url', 'amount_due_cents',
                                       'remaining_balance_cents', 'balance_cents',
                                       'balance_due_at', 'guest_payment_links',
                                       'guest_location_line', 'location_url')})
                fresh_facts = (_saved_confirmation_facts(
                    _presentation_plan(state), completed_offer, projected_receipt)
                    if projected_receipt else {})
                owed_facts = state.get('confirmation_owed')
                if isinstance(owed_facts, dict):
                    owed_reference = owed_facts.get('reference')
                    fresh_reference = fresh_facts.get('reference')
                    if (fresh_reference is not None and owed_reference is not None
                            and fresh_reference != owed_reference):
                        fresh_facts = {}
                    # Recovery retains fields that Staff did not repeat, but every
                    # freshly projected value wins, especially room truth.
                    present_fresh = {
                        key: value for key, value in fresh_facts.items()
                        if value is not None and value != '' and value != [] and value != {}
                    }
                    confirmation_facts = {**deepcopy(owed_facts), **present_fresh}
                else:
                    confirmation_facts = fresh_facts
                rewrite_context = confirmation_facts.setdefault('rewrite_context', {})
                rewrite_context['language'] = _guest_language(state)
                plan = _presentation_plan(state)
                guest_register = (plan.get('register') or plan.get('guest_register')
                                  or plan.get('address_register'))
                if isinstance(guest_register, str) and guest_register.strip():
                    rewrite_context['register'] = guest_register.strip()
                try:
                    from .luna_personality import get_bound_personality
                    bound_pack = (get_bound_personality() or {}).get('pack') or {}
                    selected_style = bound_pack.get('id')
                except Exception:
                    selected_style = None
                if isinstance(selected_style, str) and selected_style.strip():
                    rewrite_context['personality_style'] = selected_style.strip()
                filled = _sendable_saved_confirmation(model_confirmation, confirmation_facts)
                if (filled is None and isinstance(model_confirmation, str)
                        and _confirmation_language(confirmation_facts)[0] != 'en'):
                    stripped = _strip_english_location_lines(model_confirmation)
                    if stripped and stripped != model_confirmation.strip():
                        filled = _sendable_saved_confirmation(stripped, confirmation_facts)
                ask_rewrite = (
                    filled is None and callable(rewrite_callback)
                    and (created_this_turn or _looks_like_saved_confirmation(
                        model_confirmation if isinstance(model_confirmation, str) else '',
                        confirmation_facts))
                )
                if ask_rewrite:
                    rewritten = None
                    try:
                        rewritten = rewrite_callback(confirmation_facts, model_confirmation)
                    except Exception:
                        rewritten = None
                    filled = _sendable_saved_confirmation(rewritten, confirmation_facts)
                    if (filled is None and isinstance(rewritten, str)
                            and _confirmation_language(confirmation_facts)[0] != 'en'):
                        stripped_rewrite = _strip_english_location_lines(rewritten)
                        if stripped_rewrite and stripped_rewrite != rewritten.strip():
                            filled = _sendable_saved_confirmation(stripped_rewrite, confirmation_facts)
                if filled is None:
                    filled = _sendable_saved_confirmation(model_confirmation, confirmation_facts)
                if (filled is None and _confirmation_language(confirmation_facts)[0] == 'en' and (
                        created_this_turn
                        or _looks_like_saved_confirmation(
                            model_confirmation if isinstance(model_confirmation, str) else '',
                            confirmation_facts))):
                    filled = _fill_confirmation_slots(
                        _saved_confirmation_fallback_template(confirmation_facts),
                        confirmation_facts)
                if not filled:
                    # Persist the complete canonical projection. A later turn must
                    # cross this same validation/rewrite boundary before sending it.
                    state['confirmation_owed'] = deepcopy(confirmation_facts)
                    status = state.get('confirmation_owed_status')
                    if not isinstance(status, dict):
                        status = {
                            'status': 'owed',
                            'booking_reference': confirmation_facts.get('reference'),
                            'reason': 'confirmation_rewrite_failed',
                        }
                    state['confirmation_owed_status'] = deepcopy(status)
                    output = deepcopy(result)
                    original = model_confirmation if isinstance(model_confirmation, str) else ''
                    if original.strip() and not _looks_like_saved_confirmation(
                            original, confirmation_facts):
                        output['final_response'] = original.strip()
                        output_messages = output.get('messages')
                        if (isinstance(output_messages, list) and output_messages
                                and isinstance(output_messages[-1], dict)
                                and output_messages[-1].get('role') == 'assistant'):
                            output_messages[-1]['content'] = original.strip()
                        _surface_confirmation_owed(output, confirmation_facts, status)
                        return output
                    output['final_response'] = None
                    _surface_confirmation_owed(output, confirmation_facts, status)
                    output_messages = output.get('messages')
                    if (isinstance(output_messages, list) and output_messages
                            and isinstance(output_messages[-1], dict)
                            and output_messages[-1].get('role') == 'assistant'):
                        output_messages[-1]['content'] = None
                    return output
                state.pop('confirmation_owed', None)
                state.pop('confirmation_owed_status', None)
                output = deepcopy(result)
                output['completed'] = True
                output.pop('partial', None)
                output.pop('failed', None)
                output.pop('interrupted', None)
                output.pop('error', None)
                output['final_response'] = filled
                output_messages = output.get('messages')
                if (isinstance(output_messages, list) and output_messages
                        and isinstance(output_messages[-1], dict)
                        and output_messages[-1].get('role') == 'assistant'):
                    output_messages[-1]['content'] = filled
                return output
                language = _guest_language(state)
                room_lines = _guest_room_lines(_presentation_plan(state), completed_offer,
                                               language)
                if room_lines:
                    reference = receipt.get('booking_code') or receipt.get('booking_id')
                    # The registered create completion is the owner-retained source.
                    # A current separate payment tool may add newer canonical payment
                    # truth, but arbitrary model text/top-level metadata never does.
                    payment = receipt
                    for tool_message in current_tools:
                        try:
                            candidate = json.loads(tool_message.get('content') or '{}')
                        except (TypeError, ValueError):
                            continue
                        if (isinstance(candidate, dict)
                                and candidate.get('tool') == 'create_payment_link'
                                and candidate.get('success') is True
                                and (not reference or candidate.get('booking_code') in (None, reference)
                                     or candidate.get('booking_id') in (None, reference))):
                            payment = candidate
                    styled_receipt = deepcopy(receipt)
                    styled_receipt.update({key: value for key, value in payment.items()
                                           if key in ('secure_payment_url', 'amount_due_cents', 'currency',
                                                      'guest_payment_links')})
                    text = _styled_booking_receipt_copy(
                        _presentation_plan(state), completed_offer, styled_receipt, language)
                    split = payment.get('guest_payment_links')
                    if not isinstance(split, list):
                        split = receipt.get('guest_payment_links')
                    currency = payment.get('currency') or receipt.get('currency') or completed_offer.get('currency')
                    payment_lines = []
                    if isinstance(split, list) and split:
                        labels = {'en': 'Payment link', 'es': 'Enlace de pago',
                                  'fr': 'Lien de paiement', 'it': 'Link di pagamento', 'de': 'Zahlungslink'}
                        for row in split:
                            if not isinstance(row, dict):
                                continue
                            url = row.get('secure_payment_url')
                            amount = row.get('amount_due_cents')
                            name = row.get('guest_name')
                            row_currency = str(row.get('currency') or currency).upper()
                            url = _usable_payment_url(url)
                            if (url and type(amount) is int and amount >= 0
                                    and row_currency == str(currency).upper()):
                                who = f' — {name}' if isinstance(name, str) and name.strip() else ''
                                value = f' ({_guest_money(amount, currency)})'
                                payment_lines.append(
                                    f"🔗 *{labels.get(language, labels['en'])}{who}:* {url}{value}")
                    if payment_lines:
                        text += '\n\n' + '\n'.join(payment_lines)
                    if handoff_text:
                        pending_copy = {
                            'en': 'The outstanding request has also been passed to the team for review; that part is not confirmed yet.',
                            'es': 'La solicitud pendiente también se ha pasado al equipo para revisión; esa parte aún no está confirmada.',
                            'it': 'Anche la richiesta in sospeso è stata passata al team per verifica; quella parte non è ancora confermata.',
                            'fr': 'La demande en attente a aussi été transmise à l’équipe ; cette partie n’est pas encore confirmée.',
                            'de': 'Die offene Anfrage wurde zusätzlich zur Prüfung an das Team weitergegeben; dieser Teil ist noch nicht bestätigt.',
                        }
                        text += '\n\n' + pending_copy.get(language, pending_copy['en'])
                    output = deepcopy(result)
                    output['final_response'] = text
                    output_messages = output.get('messages')
                    if (isinstance(output_messages, list) and output_messages
                            and isinstance(output_messages[-1], dict)
                            and output_messages[-1].get('role') == 'assistant'):
                        output_messages[-1]['content'] = text
                    return output
        if handoff_text:
            output = deepcopy(result)
            output['final_response'] = handoff_text
            output_messages = output.get('messages')
            if (isinstance(output_messages, list) and output_messages
                    and isinstance(output_messages[-1], dict)
                    and output_messages[-1].get('role') == 'assistant'):
                output_messages[-1]['content'] = handoff_text
            return output
        if isinstance(receipt, dict):
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
                text = ((f'La prenotazione {reference} è stata salvata in precedenza. '
                         'Al momento non riesco a verificarne i dettagli aggiornati.')
                        if _guest_language(state) == 'it' else
                        (f"Booking {reference} was saved earlier. "
                         "I can't verify its current details right now."))
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
        revision = quote.get('offer_revision') if isinstance(quote.get('offer_revision'), dict) else {}
        assignments = revision.get('guest_bed_assignments')
        chosen_full_names_missing = (
            quote.get('full_payment_only') is not True
            and quote.get('payment_choice_needed') is False
            and revision.get('payment_choice') == 'full'
            and isinstance(assignments, list) and assignments
            and any(not isinstance(row, dict) or not row.get('guest_name') for row in assignments))
        choices = []
        if (quote.get('full_payment_only') is True
                and quote.get('payment_choice_needed') is False):
            choices.append('full')
        elif (quote.get('payment_choice_needed') is True
              and type(quote.get('deposit_required_cents')) is int
              and type(quote.get('total_cents')) is int
              and quote.get('deposit_required_cents') == quote.get('total_cents')):
            choices.append('full')
        elif quote.get('payment_choice_needed') is True:
            deposit = quote.get('deposit_required_cents', revision.get('deposit_required_cents'))
            total = quote.get('total_cents', revision.get('total_cents'))
            if type(deposit) is int:
                choices.append('deposit')
                party_size = _presentation_plan(state).get('guest_count')
                if type(party_size) is not int:
                    party_size = revision.get('guest_count')
                if type(party_size) is int and party_size >= 2:
                    choices.append('per_guest')
            if type(total) is int:
                choices.append('full')
        elif isinstance(offer, dict) and offer.get('payment_choice'):
            shown_plan = _presentation_plan(state)
            if (shown_plan.get('payment_choice') == 'per_guest'
                    and offer.get('payment_choice') == 'deposit'
                    and offer.get('per_guest_payment_links') is True):
                # The canonical Staff revision labels split links as deposit;
                # authorize the intent presented to the guest, not that tier.
                choices.append('per_guest')
            else:
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
            provisional_offer = quote.get('offer_revision') or quote
            if (not isinstance(currency, str) or type(total) is not int
                    or not isinstance(provisional_offer.get('room_arrangement'), list)):
                return result
            language = _guest_language(state)
            full_payment_only = quote.get('full_payment_only') is True
            provisional_offer = {**provisional_offer, 'currency': currency,
                                 'total_cents': total,
                                 'deposit_required_cents': quote.get('deposit_required_cents'),
                                 'full_payment_only': full_payment_only,
                                 'payment_link_amount_cents': (total if full_payment_only else
                                                               provisional_offer.get('payment_link_amount_cents'))}
            text = _styled_quote_copy(plan, provisional_offer, language, create_ready=False)

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
            # Persist the semantic question that remains after final-copy
            # replacement, not the provisional renderer's payment default.
            if chosen_full_names_missing:
                # The final renderer replaced its provisional payment prompt
                # with a names question. Persist that actual question, with no
                # obsolete payment choices that a later bare answer could bind.
                kind = 'names'
                state['pending_question'] = {'kind': kind}
                state['presentation']['question_intent'] = {'kind': kind}
            else:
                rendered_shuttle = text.rstrip().endswith(
                    _style_copy(language)['shuttle_choice'])
                kind = ('go_ahead' if quote.get('full_payment_only') is True
                        else 'add_on' if rendered_shuttle
                        else pending_question.quote_question_kind(plan, provisional_offer, language, False))
                options = pending_question.rendered_options(
                    plan, provisional_offer, language, False, kind)
                pending_question.persist(state, kind, options)
            state['presentation']['question_kind'] = kind
            return output
        plan = state['plan']
        language = _guest_language(state)
        prior = state.get('accepted_offer_snapshot')
        text = _styled_quote_copy(
            plan, offer, language, create_ready=True,
            updated=isinstance(prior, dict) and prior != offer)
        output = deepcopy(result)
        output['final_response'] = text
        messages = output.get('messages')
        if isinstance(messages, list) and messages and messages[-1].get('role') == 'assistant':
            messages[-1]['content'] = text
        state['presented_offer'] = deepcopy(offer)
        kind = pending_question.quote_question_kind(plan, offer, language, True)
        state['presentation'].update(
            displayed_text=text,
            displayed_text_digest=hashlib.sha256(text.encode()).hexdigest(),
            reply_reference=(messages[-1].get('id') or messages[-1].get('message_id')
                             if isinstance(messages, list) and messages
                             and isinstance(messages[-1], dict) else None)
                            or state['presentation']['reply_reference'],
            quote_revision=deepcopy(offer),
            create_ready=True,
            question_kind=kind,
        )
        pending_question.persist(state, kind)
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
            capability = _current.get()
            if (capability is not None and _registered_create is not None
                    and isinstance(capability.binding[2], dict)):
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
                    receipt = json.loads(_registered_create({}))
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
                    recovery_result = {
                        'completed': True, 'final_response': text, 'api_calls': 0,
                        'messages': [*deepcopy(history), {'role': 'user', 'content': user_message},
                                     {'role': 'assistant', 'content': text}],
                        'booking_result': receipt,
                    }
                    return finalize_offer_response(
                        recovery_result,
                        lambda facts, draft: _rewrite_saved_confirmation(agent, facts, draft),
                        receipt if receipt.get('success') is True else None,
                    )
            if exact_retry is not None:
                return _exact_retry_refusal(user_message, args, kwargs)
            result = original(agent, user_message, *args, **kwargs)
            if _current.get() is not None:
                return finalize_offer_response(
                    result, lambda facts, draft: _rewrite_saved_confirmation(agent, facts, draft))
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
