"""Offline required-behavior gate, not characterization. No business dispatch.
Artifact-only extension of owner-probes.py's canonical-new-change reproducer.
Original male->null refresh plus unchanged-male and already-null controls.
Real SessionDB + real PreparedPlans; Staff-shaped revisions built by local JS.
The contradictory refresh is synthetic stale authority, not a live Staff claim.
"""
import json
import os
import socket
import subprocess
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from wolfhouse import accepted_quote as owner
from wolfhouse.test_accepted_quote import OwnerHostileTests

E = Path(__file__).resolve().parent
ROOT = Path(owner.__file__).resolve().parents[3]
receipts = json.loads((E / 'authority-receipts.json').read_text())

def snapshot():
    return owner._transaction(lambda state, ingress: deepcopy(state))

def revision_with_alias(revision, alias):
    value = deepcopy(revision)
    value['gender_preference'] = alias
    js = """for (const n of ['http','https']) require(n).request=require(n).get=()=>{throw Error('NETWORK FORBIDDEN')};require('net').Socket.prototype.connect=()=>{throw Error('NETWORK FORBIDDEN')};const api=require('./scripts/lib/luna-front-desk-accommodation-availability-service');console.log(JSON.stringify(api.buildWolfhouseOfferRevision(JSON.parse(process.argv[1]))));"""
    return json.loads(subprocess.check_output(['node', '-e', js, json.dumps(value)], cwd=ROOT))

def run(label, before_alias, after_alias, new_gender, expect_ready):
    t = OwnerHostileTests()
    t.setUp()
    t.agent.session_id = label
    t.db.create_session(label, source='whatsapp')
    diagnostics = []
    try:
        t.turn(label + '-quote', 'Quote this booking')
        response = deepcopy(receipts['partial'])
        response['offer_revision'] = revision_with_alias(response['offer_revision'], before_alias)
        revision = response['offer_revision']
        assert 'guests' not in revision, 'Real Staff revision has hints/assignments, not canonical guests'
        response.update(success=True, total_cents=revision['total_cents'],
                        deposit_required_cents=revision['deposit_required_cents'],
                        currency=revision['currency'], payment_choice_needed=False,
                        full_payment_only=False, missing_fields=[])
        plan = {key: deepcopy(revision[key]) for key in (
            'check_in', 'check_out', 'guest_count', 'package_code', 'room_type',
            'room_preference', 'gender_preference', 'room_name_hints',
            'per_guest_payment_links', 'add_ons', 'payment_choice')}
        plan.update(guests=[{'name': 'unit guest', 'explicit_gender': 'male'}],
                    selected_bed_codes=['UNIT-B1'])
        owner.record_quote(plan, response)
        owner.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        t.turn(label + '-accept', 'Book it with the deposit')
        refresh = owner.prepare_create({})
        assert refresh.revalidation
        initial = snapshot()
        assert initial['accepted_presentation']['plan']['guests'][0]['explicit_gender'] == 'male'
        prepared = owner.prepare_quote({'guests': [{'name': 'unit guest', 'explicit_gender': new_gender}]})
        assert isinstance(prepared, owner.PreparedPlan)
        checked = deepcopy(response)
        checked['offer_revision'] = revision_with_alias(revision, after_alias)
        original = owner._completion_revision_matches
        def diagnostic(*args, **kwargs):
            result = original(*args, **kwargs)
            diagnostics.append({'person_plan': deepcopy(kwargs.get('person_plan')),
                                'result': result})
            return result
        with patch.object(owner, '_completion_revision_matches', side_effect=diagnostic):
            owner.record_quote(prepared, checked)
        after = snapshot()
        try:
            ready = owner.prepare_create({})
            outcome = {'create_prepared': 'accepted_offer' in ready,
                       'revalidation': ready.revalidation, 'ready': dict(ready)}
        except owner.QuoteBoundaryError as error:
            outcome = {'create_prepared': False, 'error': str(error)}
        result = {'probe': label, 'initial_alias': before_alias, 'refresh_alias': after_alias,
                  'current_canonical_gender': new_gender,
                  'required_create_prepared': expect_ready,
                  'passed': outcome['create_prepared'] is expect_ready,
                  'status': after['status'], 'comparator_calls': diagnostics, **outcome}
        (E / (label + '.json')).write_text(json.dumps({**result, 'initial': initial,
            'prepared': dict(prepared), 'refresh_receipt': checked, 'after': after}, indent=2) + '\n')
        print(json.dumps(result), flush=True)
        return result
    finally:
        t.tearDown()

with patch.dict(os.environ, {'PATH': os.environ['PATH'], 'HOME': '/tmp',
        'PYTHON_DOTENV_DISABLED': '1', 'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
        'LUNA_BOT_INTERNAL_TOKEN': 'offline-not-a-credential',
        'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff.invalid'}, clear=True), \
        patch('socket.socket.connect', side_effect=AssertionError('NETWORK FORBIDDEN')), \
        patch('socket.create_connection', side_effect=AssertionError('NETWORK FORBIDDEN')):
    results = [run(*case) for case in [
        ('canonical-original-drop-alias', 'male', None, 'female', False),
        ('canonical-new-change-keep-alias', 'male', 'male', 'female', False),
        ('canonical-new-change-already-null', None, None, 'female', False),
        ('canonical-consistent-already-null', None, None, 'male', True),
    ]]
failures = [r['probe'] for r in results if not r['passed']]
print(json.dumps({'requirements': len(results), 'failed_requirements': failures,
                  'source': str(ROOT), 'business_dispatches': 0}), flush=True)
assert not failures, failures
