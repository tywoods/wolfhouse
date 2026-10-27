"""Durable semantic ownership for the last guest-facing booking question."""
from copy import deepcopy
import re

_ADD_ON = 'add_on'
_PAYMENT_CHOICE = 'payment_choice'
_GO_AHEAD = 'go_ahead'


def quote_question_kind(plan, offer, language, create_ready):
    """Return the semantic question rendered by the quote finalizer, if any."""
    if create_ready:
        return _GO_AHEAD
    package_codes = [str(offer.get('package_code') or plan.get('package_code') or '').strip()]
    package_codes.extend(str(row.get('package_code') or row.get('code') or '').strip()
                         for row in (plan.get('guest_packages') or []) if isinstance(row, dict))
    package_selected = any(code and code not in {
        'package_none', 'none', 'accommodation_only', 'no_package'} for code in package_codes)
    shuttle_resolved = ('pending_transfers' in plan or plan.get('shuttle_needed') is False
                        or plan.get('needs_shuttle') is False
                        or str(plan.get('shuttle_choice') or '').strip().casefold()
                        in {'no', 'none', 'declined', 'not_needed'})
    # All supported quote languages use the same semantic question; wording belongs
    # solely to the renderer.
    if language in {'en', 'es', 'it'} and package_selected and not shuttle_resolved:
        return _ADD_ON
    return _PAYMENT_CHOICE


def rendered_options(plan, offer, language, create_ready, kind=None):
    """Return the two choices in the wording that was actually rendered."""
    kind = kind or quote_question_kind(plan, offer, language, create_ready)
    if kind != _PAYMENT_CHOICE or create_ready:
        return None
    party_size = offer.get('guest_count', plan.get('guest_count'))
    if language in {'en', 'es'} and type(party_size) is int and party_size >= 2:
        return ['together', 'separate']
    return ['deposit', 'full']


def persist(state, kind, options=None):
    if kind in {_ADD_ON, _PAYMENT_CHOICE, _GO_AHEAD}:
        pending = {'kind': kind}
        if isinstance(options, list) and len(options) == 2:
            pending['options'] = list(options)
        state['pending_question'] = pending


def _cancellation_intent(raw):
    """Resolve cancellation polarity and scope independently of the pending question."""
    normalized = str(raw or '').casefold()
    cancellation_verb = re.search(
        r'\b(?:cancel\w*|anular\w*|annull\w*|cancell\w*|stop)\b', normalized)
    negated_booking_verb = re.search(
        r"\b(?:(?:do\s+not|don['’]?t)\s+book|no\s+reserv\w*|non\s+prenot\w*)\b",
        normalized,
    )
    if not (cancellation_verb or negated_booking_verb):
        return None

    whole_booking_target = re.search(
        r'\b(?:booking|reservation|stay|everything|all|reserva|estancia|todo|toda|'
        r'prenotazione|soggiorno|tutto|inter[ao]|entire|whole)\b',
        normalized,
    )
    pending_add_on_target = re.search(
        r'\b(?:shuttle|transfer|ride|traslado|transporte|navetta|transferimento)\b',
        normalized,
    )
    if whole_booking_target:
        scope = 'whole_booking'
    elif pending_add_on_target:
        scope = 'pending_add_on'
    elif negated_booking_verb:
        # A bare "don't book this" names the booking through its verb.
        scope = 'whole_booking'
    else:
        scope = 'unspecified'
    return {'polarity': 'cancel', 'scope': scope}


def explicit_cancellation(raw, pending_kind=None):
    """Return true only when cancellation escapes the pending question target."""
    intent = _cancellation_intent(raw)
    if not intent:
        return False
    if pending_kind != _ADD_ON:
        return True
    return intent['scope'] == 'whole_booking'


def bind_answer(state, action, raw):
    """Bind a model's short accept/reject interpretation to durable question kind.

    Returns a semantic boundary result or ``None`` when ordinary quote adjudication
    should continue.  It deliberately does not inspect service names or phrases.
    """
    pending = state.get('pending_question')
    kind = pending.get('kind') if isinstance(pending, dict) else None
    if kind not in {_ADD_ON, _PAYMENT_CHOICE, _GO_AHEAD}:
        return None
    if explicit_cancellation(raw, kind):
        return {'kind': _GO_AHEAD, 'cancelled': True}
    if kind == _ADD_ON and action in {'accept', 'reject'}:
        answer = 'accepted' if action == 'accept' else 'declined'
        # Write the canonical plan fields consumed by quote rendering and booking
        # creation; a side ledger alone would let the same add-on be re-asked.
        plan = state.setdefault('plan', {})
        # Staff's create consumer expects a list of transfer request objects, not
        # a truthy sentinel. Empty means the guest explicitly declined.
        plan['pending_transfers'] = ([{'direction': 'arrival'}, {'direction': 'departure'}]
                                     if action == 'accept' else [])
        state.setdefault('add_on_decisions', {})['shuttle'] = answer
        state['pending_question'] = {'kind': _GO_AHEAD}
        return {'kind': _ADD_ON, 'cancelled': False, 'answer': answer, 'plan_changed': True}
    if kind == _PAYMENT_CHOICE and action in {'accept', 'reject'}:
        # The pending descriptor, not wording in the reply, owns the target. The
        # interpreter supplies polarity; only an explicit booking cancellation
        # above is allowed to escape this payment-choice boundary.
        options = pending.get('options') if isinstance(pending.get('options'), list) else None
        if not options or len(options) != 2:
            return None
        selected = options[0] if action == 'accept' else options[1]
        payment_choice = {'together': 'deposit', 'separate': 'per_guest'}.get(selected, selected)
        if payment_choice not in {'deposit', 'full', 'per_guest'}:
            return None
        plan = state.setdefault('plan', {})
        plan['payment_choice'] = payment_choice
        state['pending_question'] = {'kind': _GO_AHEAD}
        return {'kind': _PAYMENT_CHOICE, 'cancelled': False,
                'answer': payment_choice, 'plan_changed': True}
    return None


def go_ahead_question(language):
    return {
        'en': 'Shall I save this booking?',
        'es': '¿Guardo esta reserva?',
        'it': 'Salvo questa prenotazione?',
    }.get(language, 'Shall I save this booking?')
