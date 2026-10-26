#!/usr/bin/env python3
"""Independent request/session binding, using actual plugin and captured owner bytes.

Offline transport/runtime and rendered replies are explicit doubles, not live proof.
Expected authority is constructed from the retained request BEFORE plugin execution.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/lib'))
from luna_v3_grader_test_support import produce


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load('session_matrix', 'run-luna-v3-rendered-reply-matrix.py')
p = load('session_pipeline', 'test-luna-v3-grader-pipeline.py')
OWNER = Path(os.environ.get('LUNA_GRADER_OWNER_EVIDENCE', str(ROOT / 'fixtures/luna-v3-grader-owner')))
KINDS = ('accommodation', 'package', 'rental', 'service:lesson_a', 'service:lesson_b', 'mixed', 'multi_guest')


def authority_for(thread):
    return {'tenant_id': 'wolfhouse-somo',
            'session_id': 'luna-v3:' + hashlib.sha256(thread.encode()).hexdigest()[:24],
            'external_send_allowed': False, 'staff_alert_allowed': False}


class IndependentSession(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = json.loads((OWNER / 'matrix-fixture.json').read_text())
        snapshot = json.loads((OWNER / 'capability-snapshot.raw.json').read_text())
        cls.cases = m.make_cases(snapshot, fixture)

    def case(self, category='package'):
        return copy.deepcopy(next(c for c in self.cases if c['category'] == category))

    def evidence(self, case, *, thread='+34699988001', event_id='session-event-1',
                 producer_session=None, corrected=False):
        request = {'thread': thread, 'text': case['correction_prompt'] if corrected else case['prompt']}
        authority = authority_for(request['thread'])
        capture = case['owner_execution_receipt']['correction' if corrected else 'evidence']['prepare']
        control = case['corrected_control'] if corrected else case['control']
        call, result, exchange = produce(m._public_prepare(control), raw=capture['body'].encode(),
            status=capture['status'], event_id=event_id,
            session=authority['session_id'] if producer_session is None else producer_session,
            fault=case.get('fault') or '')
        reply = (p.quote_reply(m.canonical_facts(result)) if result.get('ok') is True else
                 'I am unable to verify the quote.' if case.get('fault') else
                 'That quantity is invalid. Please correct your request.')
        event = {'event_id': event_id, 'request': request, 'response': {'reply_text': reply,
            'harness_trace': {'messages': [{'role': 'user', 'content': request['text']},
                {'role': 'assistant', 'tool_calls': [call]},
                {'role': 'tool', 'tool_call_id': call['id'],
                 'content_parsed': {k: v for k, v in result.items() if k != '_tool_call_id'}}],
                'staff_http_exchanges': [exchange]}}}
        return event, authority, call, result, exchange

    def test_public_semantic_score_missing_context_rejects_actual_plugin(self):
        case = self.case()
        event, authority, call, result, exchange = self.evidence(case)
        for case_metadata in ({}, {'_expected_authority': authority}):
            with self.subTest(case_metadata=case_metadata):
                score = m.semantic_score({**case, **case_metadata}, event['response']['reply_text'],
                    [call], [result], exchange, current_event_id=event['event_id'])
                self.assertIs(score['fidelity'], False)

    def test_all_seven_actual_plugin_kinds_pass_with_independent_request_context(self):
        for category in KINDS:
            with self.subTest(category=category):
                case = self.case(category)
                event, authority, call, result, exchange = self.evidence(case)
                score = m.semantic_score(case, event['response']['reply_text'], [call], [result],
                    exchange, current_event_id=event['event_id'], expected_authority=authority)
                self.assertIs(score['fidelity'], True)
                row = m.score_events(case, [event])[0]
                self.assertIs(row['semantic']['fidelity'], True)
                self.assertIs(row['owner_control_matches'], True)
                # Every positive kind must reject the same evidence without context.
                missing = copy.deepcopy(event)
                missing.pop('request')
                self.assertIs(m.score_events(case, [missing])[0]['semantic']['fidelity'], False)
                for expected in (None, {**authority, 'session_id': 'luna-v3:foreign'}):
                    score = m.semantic_score(case, event['response']['reply_text'], [call], [result],
                        exchange, current_event_id=event['event_id'], expected_authority=expected)
                    self.assertIs(score['fidelity'], False)
                for value in (exchange['trusted_authority'], exchange['request']):
                    value['session_id'] = 'luna-v3:forged'
                self.assertIs(m.score_events(case, [event])[0]['semantic']['fidelity'], False)

    def test_direct_wrong_or_incomplete_authority_rejects(self):
        case = self.case()
        event, authority, call, result, exchange = self.evidence(case)
        for expected in (None, {}, 'not-an-authority',
                         {**authority, 'session_id': 'luna-v3:foreign'},
                         {**authority, 'tenant_id': 'foreign'},
                         {**authority, 'external_send_allowed': 0}):
            with self.subTest(authority=expected):
                score = m.semantic_score(case, event['response']['reply_text'], [call], [result],
                    exchange, current_event_id=event['event_id'], expected_authority=expected)
                self.assertIs(score['fidelity'], False)

    def test_standalone_missing_malformed_or_wrong_request_rejects(self):
        case = self.case()
        for producer_session in (None, 'luna-v3:foreign'):
            event, authority, *_ = self.evidence(case, producer_session=producer_session)
            # Neither old case metadata nor response/trace claims are request authority.
            case['_expected_authority'] = authority
            event['response']['session_id'] = authority['session_id']
            event['response']['thread'] = event['request']['thread']
            event['response']['harness_trace']['trusted_authority'] = authority
            for request in (None, {}, [], 'invalid', {'thread': ''}, {'thread': '   '},
                            {'thread': 123}, {'thread': '+346****9999'}):
                with self.subTest(producer_session=producer_session, request=request):
                    bad = copy.deepcopy(event)
                    if request is None:
                        bad.pop('request')
                    else:
                        bad['request'] = request
                    self.assertIs(m.score_events(case, [bad])[0]['semantic']['fidelity'], False)

    def test_standalone_foreign_receipt_cannot_override_request_authority(self):
        case = self.case()
        event, _, *_ = self.evidence(case, producer_session='luna-v3:foreign')
        case['_expected_authority'] = event['response']['harness_trace']['staff_http_exchanges'][0]['trusted_authority']
        self.assertIs(m.score_events(case, [event])[0]['semantic']['fidelity'], False)

    def test_correction_requires_same_independent_session_and_new_event(self):
        case = self.case('continuation')
        first, *_ = self.evidence(case)
        corrected, *_ = self.evidence(case, event_id='session-event-2', corrected=True)
        self.assertTrue(all(row['semantic']['fidelity'] for row in m.score_events(case, [first, corrected])))
        foreign, *_ = self.evidence(case, thread='+346****8002', event_id='session-event-2', corrected=True)
        replayed, *_ = self.evidence(case, event_id=first['event_id'], corrected=True)
        for invalid in (foreign, replayed):
            with self.subTest(request=invalid['request'], event_id=invalid['event_id']):
                rows = m.score_events(case, [first, invalid])
                self.assertIs(rows[0]['semantic']['fidelity'], True)
                self.assertIs(rows[1]['semantic']['fidelity'], False)
        missing = copy.deepcopy(first)
        missing.pop('request')
        self.assertFalse(any(row['semantic']['fidelity'] for row in m.score_events(case, [missing, corrected])))

    def test_event_and_call_pairing_still_rejects_replay_and_ambiguity(self):
        case = self.case()
        event, *_ = self.evidence(case)
        for change in ('event', 'model_call', 'receipt_call', 'duplicate_receipt', 'duplicate_result'):
            bad = copy.deepcopy(event)
            trace = bad['response']['harness_trace']
            if change == 'event':
                bad['event_id'] = 'another-event'
            elif change == 'model_call':
                trace['messages'][-1]['tool_call_id'] = 'another-call'
            elif change == 'receipt_call':
                trace['staff_http_exchanges'][0]['call_id'] = 'another-local-call'
            elif change == 'duplicate_receipt':
                trace['staff_http_exchanges'].append(copy.deepcopy(trace['staff_http_exchanges'][0]))
            else:
                trace['messages'].append(copy.deepcopy(trace['messages'][-1]))
            with self.subTest(change=change):
                self.assertIs(m.score_events(case, [bad])[0]['semantic']['fidelity'], False)

    def test_coherently_forged_receipt_authority_is_not_independent_context(self):
        case = self.case()
        event, authority, call, result, exchange = self.evidence(case)
        for value in (exchange['trusted_authority'], exchange['request']):
            value['session_id'] = 'luna-v3:forged'
        score = m.semantic_score(case, event['response']['reply_text'], [call], [result],
            exchange, current_event_id=event['event_id'], expected_authority=authority)
        self.assertIs(score['fidelity'], False)
        self.assertIs(m.score_events(case, [event])[0]['semantic']['fidelity'], False)

    def test_fault_refusals_also_require_independent_context(self):
        for case in (copy.deepcopy(c) for c in self.cases if c.get('fault')):
            with self.subTest(fault=case['fault']):
                event, *_ = self.evidence(case)
                self.assertIs(m.score_events(case, [event])[0]['semantic']['fidelity'], True)
                event.pop('request')
                self.assertIs(m.score_events(case, [event])[0]['semantic']['fidelity'], False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
