#!/usr/bin/env python3
"""Offline actual-plugin crossings; transport/runtime fixtures are NOT live owner proof."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import unittest
import urllib.error
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'docker/hermes-luna-v3'))
sys.path.insert(0, str(ROOT / 'scripts/lib'))
ARTIFACTS = ROOT / 'artifacts/cap-grader-binding'
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = load('binding_actual_plugin', ROOT / 'docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py')
try:
    from luna_v3_receipt_binding import boundary_consistent, valid_staff_exchange
except ModuleNotFoundError:
    legacy = load('binding_legacy_matrix', ROOT / 'scripts/run-luna-v3-rendered-reply-matrix.py')
    boundary_consistent = legacy._boundary_consistent
    valid_staff_exchange = legacy._valid_staff_exchange

from runtime.trusted_turn_context import (bind_inbound_event, clear_inbound_event,
                                        bind_harness_evidence, clear_harness_evidence)

AUTHORITY = {'tenant_id': 'wolfhouse-somo', 'session_id': 'luna-v3:binding-offline',
             'external_send_allowed': False, 'staff_alert_allowed': False}
EVENT = 'binding-offline-event'
ROWS = []


class Response:
    def __init__(self, raw, status=200, error=None):
        self.raw, self.status, self.error = raw, status, error
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def close(self):
        pass
    def read(self, *_):
        if self.error:
            raise self.error
        return self.raw


def produce(owner=None, *, raw=None, status=200, fault='', name='check_quote_book', error=None, connect=None):
    if raw is None:
        raw = json.dumps(owner if owner is not None else {'ok': True, 'state': 'quote'}).encode()
    args = {'action': 'prepare', 'purpose': 'quote'} if name == 'check_quote_book' else {}
    if name in plugin.WRITE_TOOLS and name != 'check_quote_book':
        args['operation_key'] = 'offline-operation'
    call = {'id': 'model-tool-call', 'function': {'name': name, 'arguments_parsed': args}}
    evidence = []
    inbound = bind_inbound_event(EVENT)
    tokens = bind_harness_evidence(evidence, fault)
    response = Response(raw, status, error)
    transport = connect or (urllib.error.HTTPError('https://offline.invalid', status, 'offline', {}, response)
                            if status >= 300 else response)
    transport_patch = {'side_effect': transport} if isinstance(transport, BaseException) else {'return_value': transport}
    try:
        with patch.object(plugin, '_runtime', return_value={'base_url': 'https://offline.invalid',
                          'tenant': AUTHORITY['tenant_id'], 'session_id': AUTHORITY['session_id'], 'token': 'OFFLINE'}), \
             patch.object(plugin, '_open_staff', **transport_patch), \
             patch.object(socket.socket, 'connect', side_effect=AssertionError('NETWORK FORBIDDEN')):
            result = plugin.call_tool(name, args)
    finally:
        clear_harness_evidence(tokens)
        clear_inbound_event(inbound)
    assert len(evidence) == 1, evidence
    result['_tool_call_id'] = call['id']
    ROWS.append({'call': copy.deepcopy(call), 'result': copy.deepcopy(result), 'exchange': copy.deepcopy(evidence[0])})
    return call, result, evidence[0]


class BindingTests(unittest.TestCase):
    def test_real_success_projection_all_tools_preserves_owner_facts(self):
        for name in plugin.TOOL_NAMES:
            with self.subTest(tool=name):
                call, result, exchange = produce({'ok': True, 'state': 'quote', '_owner_fact': {'value': 7},
                    'facts': [{'bookingId': 'private', 'amount': 12}], 'call_id': 'owner-id'}, name=name)
                self.assertEqual(result['call_id'], exchange['call_id'])
                self.assertNotEqual(result['call_id'], 'owner-id')
                self.assertTrue(boundary_consistent(call, result, exchange, EVENT))
                forged = copy.deepcopy(result)
                forged['_owner_fact']['value'] = 8
                self.assertFalse(boundary_consistent(call, forged, exchange, EVENT))


    def test_real_refusal_projection_and_forged_typed_codes(self):
        for status in (302, 400, 409, 422, 500, 503):
            for kind in ('stay', 'package', 'service', 'add_on', 'rental', 'lesson'):
                owner = {'ok': False, 'code': 'price_not_configured', 'classification': 'configuration',
                    'reason': 'missing_owner_price', 'next_step': 'choose_other_dates',
                    'message': 'Owner message', 'correlation_id': 'owner-correlation', 'retry_allowed': True,
                    'pricing_failure': {'type': 'pricing_failure', 'price_kind': kind,
                        'choice': {'item_type': kind, 'item_code': 'owner-choice'}, 'recovery_action': 'choose_other_dates'},
                    'eligibility_facts': {'minimum_nights': 3, 'eligible': False},
                    'season_coverage': {'covered': False, 'uncovered_dates': ['2027-07-01']},
                    'field_errors': [{'path': '$.room', 'code': 'unavailable', 'message': 'Choose another room', 'private': 1}],
                    'handoffId': 'owner-handoff', 'handoffOperationKey': 'owner-operation', 'requiredHumanHandoff': True,
                    'outcome_unknown': True, 'recoveryStatus': 'unknown', 'outcome': 'unknown', '_owner_private': 'not public'}
                with self.subTest(status=status, kind=kind):
                    call, result, exchange = produce(owner, status=status)
                    self.assertTrue(boundary_consistent(call, result, exchange, EVENT))
                    for key, value in (('code', 'forged_typed_code'), ('classification', 'availability'),
                                       ('status', 418), ('next_step', 'book_now')):
                        forged = {**result, key: value}
                        self.assertFalse(boundary_consistent(call, forged, exchange, EVENT))
        # Bounds are adapter rules, not a permissive owner subset comparison.
        owner = {'code': 'x' * 161, 'message': 'x' * 501, 'classification': 'invented',
                 'field_errors': [{'path': '$', 'code': 'x', 'message': ''}],
                 'pricing_failure': {'type': 'pricing_failure', 'price_kind': 'stay', 'choice': {'private': 1}},
                 'eligibility_facts': {'minimum_nights': 100001}, 'season_coverage': {'private': True}}
        call, result, exchange = produce(owner, status=422)
        self.assertTrue(boundary_consistent(call, result, exchange, EVENT))


    def test_fault_crossings_accept_invalid_and_null_originals(self):
        for status in (200, 201, 400, 422, 500, 503):
            for raw in (b'{"ok":true,"facts":{"amount":12}}', b'not-json', b'null', b'42', b'[]', b''):
                for fault in ('', 'non-json', 'malformed', 'http-422', 'timeout', 'exception'):
                    with self.subTest(status=status, raw=raw, fault=fault):
                        call, result, exchange = produce(raw=raw, status=status, fault=fault)
                        self.assertEqual(exchange['original_response_hex'], raw.hex())
                        self.assertEqual(exchange['original_status'], status)
                        self.assertEqual(exchange['status'], 422 if fault == 'http-422' else status)
                        self.assertTrue(valid_staff_exchange(exchange))
                        self.assertTrue(boundary_consistent(call, result, exchange, EVENT))
                        if fault:
                            for key, value in (('code', 'forged'), ('classification', 'availability'), ('status', 418)):
                                self.assertFalse(boundary_consistent(call, {**result, key: value}, exchange, EVENT))
                            for key, value in (('status', 999), ('original_status', -1),
                                               ('fault_observed', 'invented'), ('fault_requested', None)):
                                self.assertFalse(boundary_consistent(call, result, {**exchange, key: value}, EVENT))


    def test_read_and_connect_failures_preserve_boundary_status(self):
        for status in (200, 201, 400, 422, 500, 503):
            for error_type in (TimeoutError, RuntimeError, OSError, ConnectionError):
                for fault in ('', 'timeout', 'exception', 'non-json', 'malformed', 'http-422'):
                    with self.subTest(status=status, error=error_type.__name__, fault=fault):
                        call, result, exchange = produce(status=status, error=error_type('offline read'), fault=fault)
                        self.assertEqual((exchange['status'], exchange['original_status']), (status, status))
                        self.assertEqual(exchange['original_response_hex'], '')
                        self.assertEqual(exchange['raw_response_hex'], '')
                        self.assertIsNone(exchange['fault_applied'])
                        self.assertTrue(valid_staff_exchange(exchange))
                        self.assertTrue(boundary_consistent(call, result, exchange, EVENT))
                        self.assertFalse(boundary_consistent(call, result, {**exchange, 'original_status': 418}, EVENT))
        for error in (TimeoutError('offline'), ConnectionError('offline'), urllib.error.URLError('offline'), RuntimeError('offline')):
            for fault in ('', 'timeout', 'exception', 'non-json', 'malformed', 'http-422'):
                with self.subTest(connect=type(error).__name__, fault=fault):
                    call, result, exchange = produce(connect=error, fault=fault)
                    self.assertIsNone(exchange['status'])
                    self.assertIsNone(exchange['original_status'])
                    self.assertIsNone(exchange['fault_applied'])
                    self.assertTrue(valid_staff_exchange(exchange))
                    self.assertTrue(boundary_consistent(call, result, exchange, EVENT))
                    self.assertFalse(boundary_consistent(call, result, {**exchange, 'status': 200}, EVENT))


    def test_identity_authority_and_exact_json_types_fail_closed(self):
        call, result, exchange = produce({'ok': True, 'facts': {'count': 1, 'enabled': False}})
        self.assertTrue(boundary_consistent(call, result, exchange, EVENT, AUTHORITY))
        self.assertFalse(boundary_consistent(call, result, exchange, EVENT, {**AUTHORITY, 'session_id': 'another'}))
        for key, value in (('event_id', 'wrong'), ('call_id', 'wrong'), ('tool', 'read_notes'),
                           ('path', '/staff/unrelated'), ('status', 999), ('original_status', 503),
                           ('raw_response_hex', b'{"ok":true}'.hex()), ('original_response_hex', b'null'.hex()),
                           ('exception_type', 'RuntimeError'), ('fault_observed', 'json_parse_error')):
            with self.subTest(receipt=key):
                self.assertFalse(boundary_consistent(call, result, {**exchange, key: value}, EVENT))
        for key, value in (('call_id', 'wrong'), ('_tool_call_id', 'wrong'), ('_invented_fact', 'forged'), ('ok', 1)):
            with self.subTest(result=key):
                self.assertFalse(boundary_consistent(call, {**result, key: value}, exchange, EVENT))
        forged = copy.deepcopy(result)
        forged['facts']['count'] = True
        self.assertFalse(boundary_consistent(call, forged, exchange, EVENT))
        for key in AUTHORITY:
            forged = copy.deepcopy(exchange)
            forged['request'][key] = 0 if key.endswith('allowed') else 'foreign'
            self.assertFalse(valid_staff_exchange(forged))
            self.assertFalse(boundary_consistent(call, result, forged, EVENT))
        for field in ('request', 'public_request', 'trusted_authority'):
            forged = copy.deepcopy(exchange)
            forged.pop(field)
            self.assertFalse(valid_staff_exchange(forged))
        # Even internally coherent receipts cannot claim forbidden model authority.
        forged = copy.deepcopy(exchange)
        forged_call = copy.deepcopy(call)
        for args in (forged['request'], forged['public_request'], forged_call['function']['arguments_parsed']):
            args['nested'] = {'amount_cents': 12}
        self.assertFalse(boundary_consistent(forged_call, result, forged, EVENT))
        forged = copy.deepcopy(exchange)
        forged['request']['tenant_id'] = forged['trusted_authority']['tenant_id'] = 'other-tenant'
        self.assertFalse(valid_staff_exchange(forged))
        for bad in (None, [], '', 1):
            self.assertFalse(boundary_consistent(bad, result, exchange, EVENT))
            self.assertFalse(boundary_consistent(call, bad, exchange, EVENT))
            self.assertFalse(valid_staff_exchange(bad))
        for status in (None, True, 99, 199, 600, 999, -1, '200', 200.0):
            forged = {**exchange, 'status': status, 'original_status': status}
            self.assertFalse(valid_staff_exchange(forged))
        raw_result = {k: v for k, v in result.items() if k != '_tool_call_id'}
        self.assertTrue(boundary_consistent(call, raw_result, exchange, EVENT))
        self.assertFalse(boundary_consistent({**call, 'id': None}, raw_result, exchange, EVENT))


    def test_request_types_required_receipt_fields_and_trace_identity(self):
        call, result, exchange = produce()
        expected = {**AUTHORITY, 'external_send_allowed': 0}
        self.assertFalse(boundary_consistent(call, result, exchange, EVENT, expected))
        for field in exchange:
            forged = copy.deepcopy(exchange)
            forged.pop(field)
            with self.subTest(missing=field):
                self.assertFalse(valid_staff_exchange(forged))
        # The wire/public objects remain valid; only the paired model arguments differ.
        call['function']['arguments_parsed']['guest_count'] = True
        exchange['public_request']['guest_count'] = 1
        exchange['request']['guest_count'] = 1
        self.assertFalse(boundary_consistent(call, result, exchange, EVENT))


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        (ARTIFACTS / 'producer-crossings.json').write_text(json.dumps(ROWS, indent=2) + '\n')
