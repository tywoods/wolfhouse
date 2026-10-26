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


def persist(state, kind):
    if kind in {_ADD_ON, _PAYMENT_CHOICE, _GO_AHEAD}:
        state['pending_question'] = {'kind': kind}


def explicit_cancellation(raw):
    """Cancellation is distinct from a bare negative answer to a follow-up."""
    normalized = str(raw or '').casefold()
    return bool(re.search(r'\b(?:cancel\w*|anular\w*|annull\w*|cancell\w*|stop)\b', normalized))


def bind_answer(state, action, raw):
    """Bind a model's short accept/reject interpretation to durable question kind.

    Returns a semantic boundary result or ``None`` when ordinary quote adjudication
    should continue.  It deliberately does not inspect service names or phrases.
    """
    pending = state.get('pending_question')
    kind = pending.get('kind') if isinstance(pending, dict) else None
    if kind not in {_ADD_ON, _GO_AHEAD}:
        return None
    if explicit_cancellation(raw):
        return {'kind': _GO_AHEAD, 'cancelled': True}
    if kind == _ADD_ON and action in {'accept', 'reject'}:
        answer = 'accepted' if action == 'accept' else 'declined'
        # Write the canonical plan fields consumed by quote rendering and booking
        # creation; a side ledger alone would let the same add-on be re-asked.
        plan = state.setdefault('plan', {})
        plan['shuttle_needed'] = action == 'accept'
        plan['needs_shuttle'] = action == 'accept'
        plan['shuttle_choice'] = 'yes' if action == 'accept' else 'declined'
        plan['pending_transfers'] = action == 'accept'
        state.setdefault('add_on_decisions', {})['shuttle'] = answer
        state['pending_question'] = {'kind': _GO_AHEAD}
        return {'kind': _ADD_ON, 'cancelled': False, 'answer': answer}
    if kind == _PAYMENT_CHOICE and action in {'accept', 'reject'}:
        plan = state.setdefault('plan', {})
        plan['payment_choice'] = 'deposit' if action == 'accept' else 'full'
        state['pending_question'] = {'kind': _GO_AHEAD}
        return {'kind': _PAYMENT_CHOICE, 'cancelled': False, 'answer': plan['payment_choice']}
    return None


def go_ahead_question(language):
    return {
        'en': 'Shall I save this booking?',
        'es': '¿Guardo esta reserva?',
        'it': 'Salvo questa prenotazione?',
    }.get(language, 'Shall I save this booking?')
