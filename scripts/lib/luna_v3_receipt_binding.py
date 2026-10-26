"""Bind model-visible results to the Luna v3 plugin's authenticated receipts.

Pure offline consumer: no plugin import, transport, environment or model calls.
The projection is deliberately exact, not a subset-of-owner-facts comparison.
Only the matrix-added top-level ``_tool_call_id`` is trace metadata.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

TOOL_PATHS = {
    'check_quote_book': '/staff/bot/luna-v3/check-quote-book',
    'get_booking': '/staff/bot/luna-v3/get-booking',
    'get_payment_status': '/staff/bot/luna-v3/payment-status',
    'send_payment_link': '/staff/bot/luna-v3/payment-link',
    'cancel_unpaid': '/staff/bot/luna-v3/cancel-unpaid',
    'read_notes': '/staff/bot/luna-v3/notes/read',
    'write_note': '/staff/bot/luna-v3/notes/write',
    'save_transfer_request': '/staff/bot/luna-v3/transfer-request',
    'handoff_to_human': '/staff/bot/luna-v3/handoff',
}
PRIVATE = frozenset({'bookingId', 'paymentId', 'paymentIds', 'checkoutId', 'guestId',
    'transferId', 'authoritativeTransferId', 'holdId', 'consumedHoldId', 'authorityKey',
    'payments', 'events', 'booking_id', 'payment_id', 'checkout_id', 'transfer_id',
    'authoritative_transfer_id', 'hold_id'})
AUTHORITY_KEYS = frozenset({'tenant_id', 'session_id', 'external_send_allowed', 'staff_alert_allowed'})


def _success_projection(body: dict, name: str) -> dict:
    private = set(PRIVATE)
    if name == 'get_booking':
        private.update({'id', 'phone', 'booking_code', 'payment_status', 'total_amount_cents',
                        'deposit_required_cents', 'paid_cents', 'balance_due_cents', 'updated_at'})
    if name == 'get_payment_status':
        private.update({'guests', 'associations', 'provider', 'provider_readback'})
    def redact(value):
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, dict):
            return {key: redact(item) for key, item in value.items() if key not in private}
        return value
    return redact(body)


FAILURE_CLASSIFICATIONS = frozenset({'validation', 'authorization', 'configuration', 'conflict',
                                    'availability', 'internal', 'transport', 'http'})


def _refusal(code, classification, status, correlation_id):
    value = {'ok': False, 'code': code, 'classification': classification,
             'message': 'I could not safely complete that booking action.',
             'field_errors': [{'path': '$', 'code': code, 'message': 'Staff could not return a usable result.'}],
             'next_step': 'wait_for_verified_result', 'retry_allowed': False, 'correlation_id': correlation_id}
    if status is not None:
        value['status'] = status
    return value


def _http_projection(staff, status, turn_id):
    result = _refusal('staff_tool_rejected', 'http', status, turn_id)
    for field in ('code', 'reason_code', 'reason', 'error', 'message', 'next_step', 'correlation_id'):
        value = staff.get(field)
        if isinstance(value, str) and 0 < len(value) <= (500 if field == 'message' else 160):
            result[field] = value
    if staff.get('classification') in FAILURE_CLASSIFICATIONS:
        result['classification'] = staff['classification']
    pricing = staff.get('pricing_failure')
    if isinstance(pricing, dict):
        choice = pricing.get('choice')
        if isinstance(choice, dict) and set(choice).issubset({'item_type', 'item_code', 'season_code'}):
            candidate = {key: choice.get(key) for key in ('item_type', 'item_code', 'season_code')}
            if (isinstance(candidate['item_type'], str) and 0 < len(candidate['item_type']) <= 80
                    and isinstance(candidate['item_code'], str) and 0 < len(candidate['item_code']) <= 160
                    and (candidate['season_code'] is None or isinstance(candidate['season_code'], str)
                         and 0 < len(candidate['season_code']) <= 80)
                    and pricing.get('type') == 'pricing_failure'
                    and pricing.get('price_kind') in {'stay', 'package', 'service', 'add_on', 'rental', 'lesson'}
                    and isinstance(pricing.get('recovery_action'), str)
                    and pricing['recovery_action'] == result.get('next_step')):
                result['pricing_failure'] = {'type': 'pricing_failure', 'price_kind': pricing['price_kind'],
                                            'choice': candidate, 'recovery_action': pricing['recovery_action']}
    for field, allowed in (
        ('eligibility_facts', {'package_code', 'package_name', 'minimum_nights', 'requested_nights',
                               'eligible', 'reason', 'check_in', 'check_out'}),
        ('season_coverage', {'season_code', 'season_name', 'check_in', 'check_out', 'covered', 'uncovered_dates', 'reason'}),
    ):
        value = staff.get(field)
        if isinstance(value, dict) and len(value) <= 16 and set(value).issubset(allowed):
            if all(isinstance(v, bool) or isinstance(v, int) and abs(v) <= 100000
                   or isinstance(v, str) and 0 < len(v) <= 240
                   or isinstance(v, list) and len(v) <= 16
                   and all(isinstance(item, str) and 0 < len(item) <= 120 for item in v)
                   for v in value.values()):
                result[field] = value
    if isinstance(staff.get('retry_allowed'), bool):
        result['retry_allowed'] = staff['retry_allowed']
    errors = staff.get('field_errors')
    if isinstance(errors, list) and len(errors) <= 20:
        admitted = []
        for row in errors:
            if isinstance(row, dict):
                safe = {key: row.get(key) for key in ('path', 'code', 'message')}
                if all(isinstance(v, str) and 0 < len(v) <= 500 for v in safe.values()):
                    admitted.append(safe)
        if admitted:
            result['field_errors'] = admitted
    if status == 409:
        for field in ('reason', 'handoffId', 'handoffOperationKey'):
            value = staff.get(field)
            if isinstance(value, str) and 0 < len(value) <= 160:
                result[field] = value
        if isinstance(staff.get('requiredHumanHandoff'), bool):
            result['requiredHumanHandoff'] = staff['requiredHumanHandoff']
    if isinstance(staff.get('outcome_unknown'), bool):
        result['outcome_unknown'] = staff['outcome_unknown']
    for field in ('recoveryStatus', 'outcome'):
        if status < 500 and staff.get(field) in {'rejected', 'unknown'}:
            result[field] = staff[field]
        result.setdefault(field, 'unknown' if status >= 500 else 'rejected')
    return result


FAULTS = frozenset({'non-json', 'malformed', 'http-422', 'timeout', 'exception'})
INJECTED_422 = (b'{"code":"injected_validation","classification":"validation",'
                b'"reason":"injected owner validation refusal","next_step":"correct_request","retry_allowed":false}')


def _decoded(raw):
    try:
        return json.loads(raw.decode('utf-8')), True
    except (ValueError, UnicodeError):
        return None, False


def _receipt_kind(exchange):
    """Validate the producer's state transitions, without parsing original bytes.

    Original bytes may already be non-JSON, null, scalar or empty. They are
    authenticated evidence, not a second model result. Only unmutated paths
    require equality between original and observed bytes.
    """
    status, original_status = exchange['status'], exchange['original_status']
    applied, requested = exchange.get('fault_applied'), exchange.get('fault_requested')
    if requested is not None and requested not in FAULTS:
        return None
    if applied is not None and (applied not in FAULTS or applied != requested):
        return None
    if exchange.get('fault') != applied:
        return None
    original = bytes.fromhex(exchange['original_response_hex'])
    observed = bytes.fromhex(exchange['raw_response_hex'])
    marker, exception = exchange.get('fault_observed'), exchange.get('exception_type')
    if applied == 'http-422':
        if status != 422 or observed != INJECTED_422:
            return None
    elif status != original_status:
        return None
    if applied is None and marker in {'timeout_caught', 'connect_error_caught', 'response_read_error', 'http_error_read_error'}:
        # No injection is consumed until a read completes. The boundary status
        # survives read failure; only a failure before response entry has None.
        if original or observed or not isinstance(exception, str) or not re.fullmatch(r'[A-Za-z_]\w*', exception):
            return None
        network_errors = {'URLError', 'ConnectionError', 'ConnectionAbortedError', 'ConnectionRefusedError',
                          'ConnectionResetError', 'BrokenPipeError'}
        if marker == 'http_error_read_error':
            return 'unreachable' if status is not None and status >= 300 else None
        if status is not None and status >= 300:
            return None
        if marker == 'timeout_caught':
            return 'unreachable' if exception == 'TimeoutError' else None
        if marker == 'connect_error_caught':
            return 'unreachable' if exception in network_errors else None
        return 'internal' if exception not in network_errors | {'TimeoutError', 'HTTPError'} else None
    if status is None or original_status is None:
        return None
    if applied in {'timeout', 'exception'}:
        expected = ('TimeoutError', 'timeout_exception_raised', 'unreachable') if applied == 'timeout' else (
            'RuntimeError', 'runtime_exception_raised', 'internal')
        return expected[2] if (exception, marker) == expected[:2] and observed == original else None
    if exception is not None:
        return None
    if applied == 'non-json':
        if observed != b'CAP-HARNESS-NON-JSON':
            return None
    elif applied == 'malformed':
        if observed != b'[]':
            return None
    elif applied != 'http-422' and (observed != original or requested is not None):
        return None
    body, parsed = _decoded(observed)
    http = status >= 300
    expected_marker = ('http_error_json_parse_error' if http else 'json_parse_error') if not parsed else (
        ('http_error_malformed_shape' if http else 'malformed_shape') if not isinstance(body, dict)
        else ('http_error_read' if http else None))
    if marker != expected_marker:
        return None
    return ('http_non_json' if http else 'non_json') if not parsed else (
        ('http_malformed' if http else 'malformed') if not isinstance(body, dict)
        else ('http' if http else 'success'))


FORBIDDEN_FIELDS = frozenset({'amount', 'amount_cents', 'deposit_cents', 'total_cents', 'remaining_cents',
    'tenant_id', 'destination', 'recipient_phone', 'provider_mode', 'send_whatsapp', 'send_sms', 'send_email',
    'external_send_allowed', 'staff_alert_allowed', 'auto_assign', 'silently_relax_together',
    'totalCents', 'depositCents', 'remainingCents', 'balanceDueCents'})


def _no_model_authority(value):
    if isinstance(value, list):
        return all(_no_model_authority(item) for item in value)
    if isinstance(value, dict):
        return not (set(value) & FORBIDDEN_FIELDS) and all(_no_model_authority(item) for item in value.values())
    return True


def _authority_bound(exchange):
    authority = exchange.get('trusted_authority')
    public = exchange.get('public_request')
    if not isinstance(authority, dict) or set(authority) != AUTHORITY_KEYS or not isinstance(public, dict):
        return False
    if authority.get('tenant_id') != 'wolfhouse-somo' or not isinstance(authority.get('session_id'), str) or not authority['session_id'].strip():
        return False
    if authority.get('external_send_allowed') is not False or authority.get('staff_alert_allowed') is not False:
        return False
    return (not (set(public) & AUTHORITY_KEYS) and _no_model_authority(public)
            and _same_json(exchange.get('request'), {**public, **authority}))


def valid_staff_exchange(exchange: Any) -> bool:
    """Whether a receipt has a usable, internally consistent boundary shape."""
    if not isinstance(exchange, dict) or not {'fault_requested', 'fault_applied', 'fault_observed', 'fault'}.issubset(exchange):
        return False
    if not isinstance(exchange.get('tool'), str) or exchange['tool'] not in TOOL_PATHS or exchange.get('path') != TOOL_PATHS[exchange['tool']]:
        return False
    if not all(isinstance(exchange.get(k), str) and exchange[k] for k in ('call_id', 'event_id')):
        return False
    if any(k not in exchange or exchange[k] is not None and
           (type(exchange[k]) is not int or not 200 <= exchange[k] <= 599)
           for k in ('status', 'original_status')):
        return False
    if not all(isinstance(exchange.get(k), str) and re.fullmatch(r'(?:[0-9a-f]{2})*', exchange[k]) is not None
               for k in ('original_response_hex', 'raw_response_hex')):
        return False
    try:
        return _authority_bound(exchange) and _receipt_kind(exchange) is not None
    except (TypeError, ValueError):
        return False


def _same_json(left, right):
    """JSON equality without Python's bool/int aliasing (including nested facts)."""
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_json(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def boundary_consistent(call: Any, result: Any, exchange: Any, current_event_id: Any,
                        expected_authority: dict | None = None) -> bool:
    """Check request/authority identity and the exact emitted public result."""
    if not isinstance(call, dict) or not isinstance(result, dict) or not valid_staff_exchange(exchange):
        return False
    if not isinstance(current_event_id, str) or not current_event_id or exchange['event_id'] != current_event_id:
        return False
    if not isinstance(call.get('id'), str) or not call['id'].strip():
        return False
    function = call.get('function', call)
    if not isinstance(function, dict) or function.get('name') != exchange['tool']:
        return False
    args = function.get('arguments_parsed', call.get('arguments_parsed'))
    if not isinstance(args, dict) or not _same_json(args, exchange['public_request']):
        return False
    authority = exchange['trusted_authority']
    if expected_authority is not None and not _same_json(authority, expected_authority):
        return False
    if '_tool_call_id' in result and result['_tool_call_id'] != call['id']:
        return False
    kind = _receipt_kind(exchange)
    turn_id = 'turn:' + hashlib.sha256((authority['session_id'] + ':' + current_event_id).encode()).hexdigest()[:32]
    if kind in {'success', 'http'}:
        body, _ = _decoded(bytes.fromhex(exchange['raw_response_hex']))
        try:
            projection = (_http_projection(body, exchange['status'], turn_id) if kind == 'http'
                          else _success_projection(body, exchange['tool']))
        except (TypeError, ValueError):
            return False
    else:
        code, classification, status = {
            'unreachable': ('staff_tool_unreachable', 'transport', 503),
            'internal': ('staff_plugin_internal_failure', 'internal', 500),
            'non_json': ('staff_transport_non_json', 'transport', exchange['status']),
            'malformed': ('malformed_staff_response', 'transport', exchange['status']),
            'http_non_json': ('staff_transport_http_non_json', 'transport', exchange['status']),
            'http_malformed': ('staff_transport_http_malformed', 'transport', exchange['status']),
        }[kind]
        projection = _refusal(code, classification, status, turn_id)
        if kind in {'unreachable', 'http_non_json', 'http_malformed'}:
            projection.update(recoveryStatus='unknown', outcome='unknown')
    expected = {**projection, 'call_id': exchange['call_id']}
    clean_result = {k: v for k, v in result.items() if k != '_tool_call_id'}
    return _same_json(clean_result, expected)
