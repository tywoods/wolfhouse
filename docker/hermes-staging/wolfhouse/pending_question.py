"""Durable semantic ownership for the last guest-facing booking question."""

_ADD_ON = 'add_on'
_PAYMENT_CHOICE = 'payment_choice'
_GO_AHEAD = 'go_ahead'
_NAMES = 'names'
_KINDS = {_ADD_ON, _PAYMENT_CHOICE, _GO_AHEAD, _NAMES}


def requires_payment_amount_choice(plan, offer):
    """Payment distribution never answers deposit-versus-full."""
    deposit = offer.get('deposit_required_cents')
    total = offer.get('total_cents')
    if type(deposit) is not int or type(total) is not int or deposit >= total:
        return False
    return str(plan.get('payment_choice') or '').strip().casefold() not in {
        'deposit', 'full', 'pay_on_arrival'
    }


def quote_question_kind(plan, offer, language, create_ready):
    """Return the semantic question rendered by the quote finalizer, if any."""
    if create_ready:
        return _GO_AHEAD
    package_codes = [str(offer.get('package_code') or plan.get('package_code') or '').strip()]
    package_codes.extend(str(row.get('package_code') or row.get('code') or '').strip()
                         for row in (plan.get('guest_packages') or []) if isinstance(row, dict))
    package_selected = any(code and code not in {
        'package_none', 'none', 'accommodation_only', 'no_package'} for code in package_codes)
    shuttle_resolved = (plan.get('shuttle_needed') is False
                        or plan.get('needs_shuttle') is False
                        or str(plan.get('shuttle_choice') or '').strip().casefold()
                        in {'yes', 'accepted', 'requested', 'needed',
                            'no', 'none', 'declined', 'not_needed'})
    # All supported quote languages use the same semantic question; wording belongs
    # solely to the renderer.
    if package_selected and not shuttle_resolved:
        return _ADD_ON
    if not requires_payment_amount_choice(plan, offer):
        return _GO_AHEAD
    return _PAYMENT_CHOICE


def rendered_options(plan, offer, language, create_ready, kind=None):
    """Return the two choices in the wording that was actually rendered."""
    kind = kind or quote_question_kind(plan, offer, language, create_ready)
    if kind != _PAYMENT_CHOICE or create_ready:
        return None
    party_size = offer.get('guest_count', plan.get('guest_count'))
    if (type(party_size) is int and party_size >= 2
            and 'per_guest_payment_links' not in plan):
        return ['together', 'separate']
    return ['deposit', 'full']


def persist(state, kind, options=None):
    if kind in _KINDS:
        pending = {'kind': kind}
        if isinstance(options, list) and len(options) == 2:
            pending['options'] = list(options)
        state['pending_question'] = pending
    else:
        state.pop('pending_question', None)


def question_intent(kind, options=None):
    """Describe the pending ask without owning any guest-facing wording."""
    if kind not in _KINDS:
        raise ValueError(f'unsupported pending question kind: {kind}')
    intent = {'kind': kind}
    if isinstance(options, list) and len(options) == 2:
        intent['options'] = list(options)
    return intent
