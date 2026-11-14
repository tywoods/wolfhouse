"""Durable semantic ownership for the last guest-facing booking question."""

import re
import hashlib
import unicodedata
from copy import deepcopy


class QuestionLedgerError(RuntimeError):
    """Stable failed-turn contract: never substitute an empty question."""
    code = 'question_ledger_failed'


class PaymentAdmissionError(RuntimeError):
    """Checkout must fail closed; an already saved booking remains saved."""
    code = 'payment_admission_failed'


def open_question(state, kind, options, message_id, text, *, scope):
    """Called only in the transaction inserting the final local outbound row."""
    fields = {'add_on': 'shuttle_choice', 'go_ahead': 'save_choice'}
    if kind in fields and options != ['accepted', 'declined']:
        raise QuestionLedgerError('question_options_invalid')
    if kind == 'payment_choice':
        field = ('payment_choice' if options == ['deposit', 'full'] else
                 'payment_link_distribution' if options == ['together', 'separate'] else None)
    else:
        field = fields.get(kind)
    if not field or not scope or type(message_id) is not int or message_id <= 0:
        raise QuestionLedgerError('question_schema_invalid')
    if not isinstance(options, list) or not options or any(not isinstance(x, str) for x in options):
        raise QuestionLedgerError('question_options_invalid')
    previous = state.get('pending_question') or {}
    if previous.get('status') == 'open':
        if previous['kind'] != kind or previous['options'] != options:
            raise QuestionLedgerError('question_still_open')
        return previous
    if previous.get('question_id') is not None:
        state.setdefault('question_history', []).append(deepcopy(previous))
    serial = state.get('question_serial', 0) + 1
    state['question_serial'] = serial
    record = dict(question_id=serial, kind=kind, field=field, options=list(options),
                  asked_message_id=message_id, outbound_digest=hashlib.sha256(text.encode()).hexdigest(),
                  status='open', answer=None, scope=scope)
    state['pending_question'] = record
    return record


def bind_answer(state, raw, inbound_id, *, scope, question_id=None):
    """Select only the current offered option; never pre-answer the next ask."""
    record = state.get('pending_question') or {}
    if record.get('status') != 'open' or record.get('scope') != scope:
        return False
    if question_id is not None and record['question_id'] != question_id:
        return False
    if not inbound_id or inbound_id in state.get('question_answer_ids', []):
        return False
    folded = ''.join(c for c in unicodedata.normalize('NFKD', raw.casefold())
                     if not unicodedata.combining(c))
    # Conservative ambiguity/negation policy: clarify rather than reverse consent.
    if record['field'] not in {'shuttle_choice', 'save_choice'} and re.search(
            r'\b(?:not|no|non|nicht|nein|without|sin)\b', folded):
        return False
    aliases = {
        'accepted': ('yes', 'si', 'oui', 'ja', 'yes please'),
        'declined': ('no', 'non', 'nein'),
        'full': ('full', 'completo', 'total', 'entero'),
        'deposit': ('deposit', 'deposito', 'acompte', 'anzahlung'),
        'together': ('together', 'juntos', 'ensemble', 'zusammen', 'insieme'),
        'separate': ('separate', 'separado', 'separados', 'getrennt', 'separatamente'),
    }
    hits = [option for option in record['options'] if any(
        re.search(r'\b' + re.escape(word) + r'\b', folded)
        for word in aliases.get(option, (option,)))]
    if len(hits) != 1:
        return False
    selected = hits[0]
    updates = {record['field']: selected}
    if record['field'] == 'payment_choice':
        updates['ask_payment_amount'] = False
    if record['field'] == 'payment_link_distribution':
        updates['per_guest_payment_links'] = selected == 'separate'
    for key in ('plan', 'completion_plan'):
        if not isinstance(state.get(key), dict):
            state[key] = deepcopy(state.get('plan') or {}) if key == 'completion_plan' else {}
        state[key].update(updates)
    state.setdefault('bound_question_fields', {}).update(updates)
    state.setdefault('question_answer_ids', []).append(inbound_id)
    record.update(status='answered', answer={'selected_option': selected, 'raw': raw,
                                            'inbound_message_id': inbound_id})
    return True

_ADD_ON = 'add_on'
_PAYMENT_CHOICE = 'payment_choice'
_GO_AHEAD = 'go_ahead'
_NAMES = 'names'
_KINDS = {_ADD_ON, _PAYMENT_CHOICE, _GO_AHEAD, _NAMES}

# "amount" and the live typo "ammount" both count as the full-payment tier.
_FULL_AMOUNT_RE = re.compile(
    r'\b(?:the\s+)?(?:full|entire|whole)\s+amm?ounts?\b'
    r'|\bpay(?:ment)?\s+in\s+full\b'
    r'|\bfull\s+pay(?:ment)?\b'
)
_TOGETHER_RE = re.compile(r'\btogether\b|\bone\s+(?:payment\s+)?link\b')
_SEPARATE_RE = re.compile(r'\bseparate\b|\beach\b|\ba\s+link\s+each\b')
# Explicit deposit after (or instead of) full: "not the full amount, just the deposit".
_DEPOSIT_NOT_FULL_RE = re.compile(
    r'\bnot\s+(?:the\s+)?(?:full|entire|whole)(?:\s+amm?ounts?)?\b'
    r'|\bjust\s+(?:the\s+)?deposit\b'
    r'|\bonly\s+(?:the\s+)?deposit\b'
    r'|\bdeposit\s+only\b'
)
# Two WhatsApp bubbles a few seconds apart are one payment answer.
PAYMENT_ANSWER_WINDOW_SECONDS = 8


def combine_recent_guest_text(prior_turns, raw, now, window=PAYMENT_ANSWER_WINDOW_SECONDS):
    """Join guest texts sent within the payment-answer window.

    'pay together' then 'full ammount' seconds later is one answer.
    """
    try:
        now = float(now)
        window = float(window)
    except (TypeError, ValueError):
        now, window = 0.0, float(PAYMENT_ANSWER_WINDOW_SECONDS)
    parts = []
    for row in prior_turns or []:
        if not isinstance(row, dict):
            continue
        text = row.get('raw')
        if not isinstance(text, str) or not text.strip():
            continue
        try:
            age = now - float(row.get('at'))
        except (TypeError, ValueError):
            continue
        if 0 <= age <= window:
            parts.append(text.strip())
    incoming = str(raw or '').strip()
    if incoming:
        parts.append(incoming)
    joined = []
    for part in parts:
        if not joined or joined[-1] != part:
            joined.append(part)
    return '\n'.join(joined)


def withhold_payment_link(plan, offer, receipt=None):
    """True when the booking may save but no pay link should be created/sent.

    If the saved receipt already has a pay amount, do not withhold — Luna
    must state that amount, never the quote-deposit guess.
    Together/separate without an explicit deposit/full still withholds the
    link after save (ask_payment_amount), even if payment_choice was kept
    so Staff insert cannot 400 missing_payment_choice.
    """
    if requires_payment_distribution(plan, offer):
        return True
    if saved_pay_amount_cents(receipt) is not None:
        return False
    if isinstance(plan, dict) and plan.get('ask_payment_amount'):
        return True
    return requires_payment_amount_choice(plan, offer)


def requires_payment_distribution(plan, offer):
    """Staff's pricing defaults are not a group guest's distribution answer."""
    count = plan.get('guest_count', offer.get('guest_count'))
    return (type(count) is int and count >= 2
            and type(plan.get('per_guest_payment_links')) is not bool
            and plan.get('payment_link_distribution') not in {'together', 'separate'})


def saved_payment_question(plan, offer):
    """Ordered post-save decisions; neither is a prerequisite to INSERT."""
    if plan.get('ask_payment_amount') or requires_payment_amount_choice(plan, offer):
        return {'kind': _PAYMENT_CHOICE, 'options': ['deposit', 'full']}
    if requires_payment_distribution(plan, offer):
        return {'kind': _PAYMENT_CHOICE, 'options': ['together', 'separate']}
    return None


def saved_pay_amount_cents(receipt, choice=None, *, total_cents=None, deposit_cents=None):
    """Amount the pay page will charge. Receipt/link first; never a quote guess.

    choice + totals is used when switching deposit/full before a new receipt.
    """
    if isinstance(receipt, dict):
        for key in ('amount_due_cents', 'payment_link_amount_cents'):
            value = receipt.get(key)
            if type(value) is int and value >= 0:
                return value
        split = receipt.get('guest_payment_links')
        if isinstance(split, list):
            amounts = []
            for row in split:
                if not isinstance(row, dict):
                    continue
                value = row.get('amount_due_cents')
                if type(value) is int and value >= 0:
                    amounts.append(value)
            if amounts:
                return sum(amounts)
    folded = str(choice or '').strip().casefold()
    if folded in {'full', 'full_amount', 'pay_full'} and type(total_cents) is int and total_cents >= 0:
        return total_cents
    if folded in {'deposit', 'deposit_only'} and type(deposit_cents) is int and deposit_cents >= 0:
        if type(total_cents) is int and total_cents >= 0:
            return min(deposit_cents, total_cents)
        return deposit_cents
    return None


def infer_payment_completions(text):
    """Map guest wording onto typed payment completions.

    Distribution never answers deposit-versus-full. A full-amount typo
    ('full ammount') is still full. Together-only is not a deposit choice.
    When both tiers appear, the latest explicit choice wins.
    """
    folded = ' '.join(str(text or '').casefold().split())
    if not folded:
        return {}
    out = {}
    choice = _latest_payment_choice(folded)
    if choice:
        out['payment_choice'] = choice
    if _TOGETHER_RE.search(folded):
        out['payment_link_distribution'] = 'together'
        out['per_guest_payment_links'] = False
    elif _SEPARATE_RE.search(folded):
        out['payment_link_distribution'] = 'separate'
        out['per_guest_payment_links'] = True
    return out


def _latest_payment_choice(folded):
    """Last explicit deposit/full in the (combined) guest text wins."""
    hits = []
    for m in _DEPOSIT_NOT_FULL_RE.finditer(folded):
        hits.append((m.start(), 'deposit'))
    for m in re.finditer(r'\b(?:actually\s+)?deposit(?:\s+please)?\b', folded):
        hits.append((m.start(), 'deposit'))
    for m in _FULL_AMOUNT_RE.finditer(folded):
        prefix = folded[:m.start()]
        if re.search(r'\bnot\s+(?:the\s+)?$', prefix):
            hits.append((m.start(), 'deposit'))
            continue
        hits.append((m.start(), 'full'))
    for m in re.finditer(r'\bfull\b', folded):
        prefix = folded[:m.start()]
        if re.search(r'\bnot\s+(?:the\s+)?$', prefix):
            hits.append((m.start(), 'deposit'))
            continue
        hits.append((m.start(), 'full'))
    if not hits:
        return None
    hits.sort(key=lambda item: item[0])
    return hits[-1][1]


def requires_payment_amount_choice(plan, offer):
    """Payment distribution never answers deposit-versus-full."""
    deposit = offer.get('deposit_required_cents')
    total = offer.get('total_cents')
    if type(deposit) is not int or type(total) is not int or deposit >= total:
        return False
    return str(plan.get('payment_choice') or '').strip().casefold() not in {
        'deposit', 'full', 'pay_on_arrival'
    }


def shuttle_question_applies(plan, offer=None):
    """Full-stay-only shuttle follows package default_nights. No hard-coded 6."""
    plan = plan if isinstance(plan, dict) else {}
    offer = offer if isinstance(offer, dict) else {}
    nights = offer.get('nights') if type(offer.get('nights')) is int else plan.get('nights')
    default_nights = None
    for src in (offer, plan):
        for key in ('default_nights', 'package_default_nights'):
            value = src.get(key)
            if type(value) is int and value > 0:
                default_nights = value
                break
        if default_nights is not None:
            break
    if type(nights) is int and type(default_nights) is int and nights < default_nights:
        return False
    includes = offer.get('package_includes')
    if includes is None:
        includes = plan.get('package_includes')
    if isinstance(includes, list) and includes:
        blob = ' '.join(str(item).casefold() for item in includes)
        if 'shuttle' not in blob and 'airport transfer' not in blob:
            return False
    return True


def quote_question_kind(plan, offer, language, create_ready):
    """Return the semantic question rendered by the quote finalizer, if any."""
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
    if (package_selected and not shuttle_resolved
            and shuttle_question_applies(plan, offer)):
        return _ADD_ON
    # Deposit/full and together/separate both belong after booking creation.
    # Missing distribution is not a reason to delay the save confirmation.
    return _GO_AHEAD


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


def retire_legacy(state):
    """Old quote transitions cannot delete durable question/answer provenance."""
    if (state.get('pending_question') or {}).get('question_id') is None:
        state.pop('pending_question', None)


def persist(state, kind, options=None):
    # Staged authoring intent is not answer authority until the final row commits.
    if kind in _KINDS:
        offered = options or (['accepted', 'declined'] if kind in {_ADD_ON, _GO_AHEAD} else [])
        state['outbound_question'] = {'kind': kind, 'options': list(offered)}
    else:
        state.pop('outbound_question', None)
    # Legacy authoring descriptors cannot retire a committed question/answer.
    if (state.get('pending_question') or {}).get('question_id') is not None:
        return
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
