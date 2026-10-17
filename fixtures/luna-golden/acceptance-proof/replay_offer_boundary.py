"""Offline seam replay, NOT a live replay or model-reliability proof.

Captured G1 tool arguments/reply; synthetic Staff responses constrained by the
read-only traces (null revision versus real JS-builder bed-backed revision).
Real patched gateway ingress, installed owner hook, registered tools and SQLite.
No pre-seeded quote/presentation. LLM and all HTTP are substituted; no network.
Default exits RED if a payment invitation escapes without an owner presentation.
"""
import json
import socket
import tempfile
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from agent import conversation_loop
from wolfhouse import accepted_quote as ledger, booking_names
from wolfhouse.offline_ingress_harness import gateway_ingress
from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
import wolfhouse_staff_api as plugin

OUT = Path(__file__).resolve().parent
INPUT = OUT.parent / 'input' / 'guest1.jsonl'
tempfile.tempdir = str(OUT)
recorded = [json.loads(line) for line in INPUT.read_text().splitlines() if line.strip()]

class Registry:
    def __init__(self): self.tools = {}
    def register_tool(self, **kw): self.tools[kw['name']] = kw
    def register_hook(self, *args, **kwargs): pass


def run_case(mode):
    t = FirstYesOwnerTests()
    t.setUp()
    # setUp creates an empty owner session, not a quote/presentation.
    token = booking_names._agent.set(t.agent)
    calls, tools = [], []
    registry = Registry()
    emre = mode == 'emre_null_revision'
    if emre:
        quote_turn = recorded[1]
        quote_args = next(c['args'] for c in quote_turn['resp']['tool_calls'] if c['name'] == 'quote_booking')
        availability_args = next(c['args'] for c in quote_turn['resp']['tool_calls'] if c['name'] == 'check_availability')
        create_args = next(c['args'] for c in recorded[2]['resp']['tool_calls'] if c['name'] == 'create_booking_from_plan')
        quote_text, accept_text = quote_turn['guest_text'], recorded[2]['guest_text']
        draft = quote_turn['resp']['reply_text']
    else:
        quote_args = dict(check_in='2026-10-20', check_out='2026-10-23', guest_count=2,
            room_type='shared', room_preference='male_only', group_gender='male',
            package_code='package_none', guest_name='Jim',
            guests=[{'name': name, 'explicit_gender': 'male'} for name in ('Jim', 'James')])
        availability_args = deepcopy(quote_args)
        create_args = {**quote_args, 'confirm': True, 'payment_choice': 'full'}
        quote_text, accept_text = 'yes, quote accommodation only', 'full payment'
        draft = 'Total EUR 240. Choose EUR 200 deposit or EUR 240 full payment.'

    def staff(path, body):
        calls.append(path)
        if path == '/booking-preview':
            if emre:
                return dict(success=True, next_action='show_quote', currency='EUR',
                    quote={'total_cents':16000, 'deposit_required_cents':10000},
                    availability={'status':'not_checked', 'selected_bed_codes':[]},
                    offer_revision=None)
            result = t._checked_offer({**body, 'payment_choice': body.get('payment_choice') or 'deposit'},
                [dict(bed_code='R4-B'+str(i), room_code='R4', gender_strategy='male preferred') for i in (3,4)],
                quote_overrides=dict(total_cents=24000, deposit_required_cents=20000,
                    payment_link_amount_cents=24000 if body.get('payment_choice') == 'full' else 20000))
            return result
        if path == '/availability-check':
            if emre:
                return dict(success=True, next_action='ask_room_eligibility',
                    has_enough_beds=False, available_beds=[])
            return dict(success=True, has_enough_beds=True,
                exact_bed_eligibility={
                    'eligible': True,
                    'selected_bed_codes': ['R4-B3', 'R4-B4'],
                    'guest_bed_assignments': [
                        {'guest_index': 0, 'guest_name': 'Jim', 'bed_code': 'R4-B3'},
                        {'guest_index': 1, 'guest_name': 'James', 'bed_code': 'R4-B4'},
                    ],
                },
                available_beds=[
                    dict(bed_code='R4-B'+str(i), room_code='R4', room_type='male_only') for i in (3,4)])
        if path == '/booking-create-from-plan':
            if emre:
                raise AssertionError('Must not create from the unchecked fixture')
            # Inert edge receipt; no real booking, Stripe, or persistence claim.
            return dict(success=True, write_performed=True, booking_id='OFFLINE-ONLY', booking_code='OFFLINE-CONTROL')
        if path == '/bookings/update-contact':
            return dict(success=True, email_saved=False, email_sent=False)
        raise AssertionError('Unexpected HTTP edge: '+path)

    def call_tool(name, args):
        result = json.loads(registry.tools[name]['handler'](deepcopy(args)))
        tools.append(dict(name=name, success=result.get('success'), error=result.get('error'),
                          has_revision=bool(result.get('offer_revision'))))
        return result

    def model(agent, text, *args, **kwargs):
        booking_names.begin_turn(session_id=agent.session_id, scope=plugin._booking_name_scope())
        if text == quote_text:
            if not emre: call_tool('check_availability', availability_args)
            call_tool('quote_booking', quote_args)
            if emre: call_tool('check_availability', availability_args)
            return dict(completed=True, final_response=draft,
                        messages=[{'role':'user','content':text}, {'role':'assistant','content':draft}])
        created = call_tool('create_booking_from_plan', create_args)
        if emre and not created.get('success'):
            # Same null-revision recovery condition established by the live trace.
            call_tool('quote_booking', {**quote_args, **create_args})
            created = call_tool('create_booking_from_plan', create_args)
        reply = created.get('booking_code') or created.get('error') or 'No create receipt'
        return dict(completed=True, final_response=reply, booking_result=created,
                    messages=[{'role':'user','content':text}, {'role':'assistant','content':reply}])

    def snapshot():
        rows = t.db._conn.execute("SELECT key,value FROM state_meta WHERE key LIKE 'wolfhouse.accepted_quote.v1:%'").fetchall()
        return {key: json.loads(value) for key,value in rows}

    try:
        with patch.object(conversation_loop, 'run_conversation', model), \
                patch.object(plugin, '_post_bot', side_effect=staff), \
                patch.object(plugin, '_session_guest_phone', return_value='+9990000000011'), \
                patch.object(socket.socket, 'connect', side_effect=AssertionError('NETWORK FORBIDDEN')):
            plugin.register(registry)
            offered = gateway_ingress(t.agent, quote_text, mode+'-quote',
                lambda raw: conversation_loop.run_conversation(t.agent, raw))
            before = snapshot()
            accepted = gateway_ingress(t.agent, accept_text, mode+'-accept',
                lambda raw: conversation_loop.run_conversation(t.agent, raw))
            after = snapshot()
        populated_before = [s for s in before.values() if s.get('quote')]
        populated_after = [s for s in after.values() if s.get('quote')]
        assert len(populated_before) == len(populated_after) == 1
        before_state, after_state = populated_before[0], populated_after[0]
        result = dict(case=mode, fixture='synthetic Staff and frozen model edges; NOT live success',
            gateway='real patched ingress + installed owner hook',
            presentation_before=bool(before_state.get('presentation')),
            presentation_after=bool(after_state.get('presentation')),
            identity_stable=before_state['scope']==after_state['scope'] and before_state['incarnation']==after_state['incarnation'],
            captured_payment_invitation_passed_through=offered['final_response']==draft,
            final_error=accepted['booking_result'].get('error'),
            inert_create_calls=calls.count('/booking-create-from-plan'), tools=tools, paths=calls)
        if not emre:
            assert result['presentation_before'], result
            assert accepted['booking_result'].get('success') and result['inert_create_calls']==1, result
        assert result['identity_stable'], result
        return result
    finally:
        booking_names.end_turn()
        booking_names._agent.reset(token)
        t.tearDown()


if __name__ == '__main__':
    results = [run_case(mode) for mode in ('emre_null_revision', 'jim_checked_control')]
    for result in results:
        print(json.dumps(result), flush=True)
    violation = results[0]['captured_payment_invitation_passed_through'] and not results[0]['presentation_before']
    if violation:
        raise AssertionError('RED: captured payment invitation escaped with no persisted offer; next acceptance cannot book it')
    print('BOUNDARY CONTRACT PASS; not a live acceptance result')
