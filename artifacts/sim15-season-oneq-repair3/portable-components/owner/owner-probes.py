"""Artifact-only adaptation of prior payment/offline-source-probes.py.
Old BAD expectations for erasure/deposit replaced with repaired expectations.
New synthetic female/contradiction/binding/catalog controls; no business dispatch.
Uses fresh Staff-built receipts, temporary real SessionDB, socket tripwires.
"""
import json, os, socket, unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from wolfhouse import accepted_quote as owner
from wolfhouse.test_accepted_quote import OwnerHostileTests
E = Path(__file__).resolve().parent
receipts = json.loads((E/'authority-receipts.json').read_text())

def emit(probe, **kw):
    print(json.dumps(dict(probe=probe, **kw), ensure_ascii=False), flush=True)

def response(key='partial', provisional=True):
    result=deepcopy(receipts[key]); rev=result['offer_revision']
    result.update(success=True,total_cents=rev['total_cents'],deposit_required_cents=rev['deposit_required_cents'],currency=rev['currency'],full_payment_only=key=='after',payment_choice_needed=provisional,missing_fields=[])
    return result

def plan_for(resp, provisional=True, canonical=None):
    rev=resp['offer_revision']
    result={key:deepcopy(rev[key]) for key in ('check_in','check_out','guest_count','package_code','room_type','room_preference','gender_preference','room_name_hints','per_guest_payment_links','add_ons')}
    result.update(guests=[{'name':'unit guest','explicit_gender':canonical or rev['gender_preference']}],selected_bed_codes=['UNIT-B1'])
    if not provisional: result['payment_choice']=rev['payment_choice']
    return result

def fixture(name):
    t=OwnerHostileTests();t.setUp();t.agent.session_id=name
    t.db.create_session(name,source='whatsapp');t.turn(name+'-quote','Quote this booking');return t

def state(): return owner._transaction(lambda s,_:deepcopy(s))

def create_outcome():
    try:
        ready=owner.prepare_create({})
        return dict(create_prepared='accepted_offer' in ready,ready=dict(ready),revalidation=getattr(ready,'revalidation',False))
    except owner.QuoteBoundaryError as ex:
        return dict(create_prepared=False,error=str(ex))

def alias_case(label, gender='male', mutation=None, canonical=None, provisional=True, prepare_args=None):
    t=fixture(label)
    try:
        resp=response(provisional=provisional)
        # Female equivalent is explicitly synthetic and changes ALL authority facts together.
        for container in (resp['offer_revision'],resp['availability']):
            if 'gender_preference' in container: container['gender_preference']=gender
            if 'room_preference' in container: container['room_preference']=gender+'_only'
            for row in container.get('room_name_hints',[]): row['explicit_gender']=gender
            for row in container.get('room_arrangement',[]): row['gender_strategy']=gender+'_only'
        plan=plan_for(resp,provisional,canonical)
        owner.record_quote(plan,resp);owner.finalize_offer_response({'completed':True,'final_response':'draft'})
        raw='Book it with the deposit';t.turn(label+'-accept',raw)
        if provisional:
            t.interpret(raw,completions={'payment_choice':{'value':'deposit','evidence':'deposit'}})
            prepared=owner.prepare_quote({})
        else: prepared=owner.prepare_create({})
        if prepare_args is not None: prepared=owner.prepare_quote(prepare_args)
        before=state();expected=deepcopy(before['accepted_presentation']['plan']);expected.update(deepcopy(before.get('completion_plan') or {}))
        checked=deepcopy(resp);checked['payment_choice_needed']=False
        checked['offer_revision']['gender_preference']=None
        checked['offer_revision']['offer_fingerprint']='synthetic-'+label
        if mutation: mutation(checked,prepared)
        comparator=owner._completion_revision_matches(resp['offer_revision'],checked['offer_revision'],payment_choice='deposit',person_plan=expected)
        helper=owner._canonical_gender_alias_is_redundant(expected,{**deepcopy(expected),'gender_preference':None})
        owner.record_quote(prepared,checked);after=state();out=create_outcome()
        emit(label,comparator=comparator,plan_helper=helper,expected_guests=expected.get('guests'),prior_hints=resp['offer_revision']['room_name_hints'],new_hints=checked['offer_revision']['room_name_hints'],status=after['status'],**out)
        return out,comparator
    finally:t.tearDown()

with patch.dict(os.environ,{'PATH':os.environ['PATH'],'PYTHON_DOTENV_DISABLED':'1','LUNA_CLIENT_SLUG':'wolfhouse-somo','LUNA_BOT_INTERNAL_TOKEN':'offline-not-a-credential','WOLFHOUSE_STAFF_API_BASE_URL':'https://staff.invalid'},clear=True),patch('socket.socket.connect',side_effect=AssertionError('NETWORK FORBIDDEN')),patch('socket.create_connection',side_effect=AssertionError('NETWORK FORBIDDEN')):
    for gender in ('male','female'):
        out,cmp=alias_case(gender+'-alias',gender)
        assert out['create_prepared'] and cmp
    def erase(r,p):r['offer_revision']['room_name_hints']=[]
    out,cmp=alias_case('authority-erasure',mutation=erase)
    assert not out['create_prepared'] and not cmp
    def hint_conflict(r,p):r['offer_revision']['room_name_hints'][0]['explicit_gender']='female'
    out,cmp=alias_case('authority-hint-conflict',mutation=hint_conflict)
    assert not out['create_prepared'] and not cmp
    for field,value in [('total_cents',99999),('client_slug','other-tenant')]:
        def mutate(r,p,field=field,value=value):
            r['offer_revision'][field]=value
            if field=='total_cents':r['total_cents']=value
        out,cmp=alias_case('bound-'+field,mutation=mutate)
        assert not out['create_prepared'] and not cmp
    def identity(r,p):r['offer_revision']['guest_bed_assignments'][0]['guest_name']='other guest'
    out,cmp=alias_case('bound-identity',mutation=identity)
    assert not out['create_prepared'] and not cmp
    def bed(r,p):
        for obj in (r['offer_revision'],r['availability']):
            obj['guest_bed_assignments'][0]['bed_code']='UNIT-B2';obj['room_arrangement'][0]['bed_code']='UNIT-B2'
        r['availability']['selected_bed_codes']=['UNIT-B2']
    out,cmp=alias_case('bound-bed',mutation=bed)
    assert not out['create_prepared'] and not cmp
    # Explicit canonical contradictions, NOT merely changed legacy hints.
    rev=deepcopy(receipts['partial']['offer_revision']);after=deepcopy(rev);after['gender_preference']=None
    person=plan_for(response());person['guests'][0]['explicit_gender']='female'
    helper=owner._canonical_gender_alias_is_redundant(person,{**deepcopy(person),'gender_preference':None})
    cmp=owner._completion_revision_matches(rev,after,payment_choice='deposit',person_plan=person)
    emit('canonical-conflict-direct',helper=helper,comparator=cmp,canonical_guests=person['guests'],hints=person['room_name_hints'],required_result=False)
    alias_case('canonical-conflict-persisted-checked',canonical='female',provisional=False)
    alias_case('canonical-conflict-provisional',canonical='female',provisional=True)
    out,cmp=alias_case('canonical-new-change',prepare_args={'guests':[{'name':'unit guest','explicit_gender':'female'}]},provisional=False)
    emit('canonical-new-change-verdict',required_create_prepared=False,actual_create_prepared=out['create_prepared'])
    out,cmp=alias_case('request-hint-change',prepare_args={'room_name_hints':[{'name':'unit guest','explicit_gender':'female'}]},provisional=False)
    assert not out['create_prepared']

    t=fixture('deposit-display')
    try:
        resp=response();owner.record_quote(plan_for(resp),resp)
        out=owner.finalize_offer_response({'completed':True,'final_response':'Draft deposit 99.99 EUR','messages':[{'role':'assistant','content':'Draft deposit 99.99 EUR'}]})
        assert '23.45 EUR' in out['final_response'] and '99.99' not in out['final_response']
        assert out['messages'][-1]['content']==out['final_response']
        emit('staff-deposit-display',staff_total=resp['total_cents'],staff_deposit=resp['deposit_required_cents'],**out)
    finally:t.tearDown()
    t=fixture('full-only')
    try:
        resp=response('after',False);owner.record_quote(plan_for(resp,False),resp)
        out=owner.finalize_offer_response({'completed':True,'final_response':'draft'})
        assert 'Full payment: 80.00 EUR.' in out['final_response']  # checked-offer rendering branch
        t.turn('full-only-accept','deposit please');prepared=owner.prepare_create({'payment_choice':'deposit'})
        assert prepared['payment_choice']=='full';owner.record_quote(prepared,resp)
        ready=owner.prepare_create({});assert ready['accepted_offer']==resp['offer_revision']
        emit('full-only-deposit-label',payment_choice=ready['payment_choice'],rendered=out['final_response'])
    finally:t.tearDown()

    t=OwnerHostileTests();t.setUp()
    try:
        raw='Remove the yoga';t.turn('catalog-remove',raw)
        t.interpret(raw,action='revise',material_changes=[{'field':'catalog_selections','operation':'remove','item':{'service_code':'yoga_class'},'evidence':'yoga'}])
        authorized=deepcopy(state()['authorized_revision_changes'])
        first=owner.prepare_quote({'catalog_selections':[]});assert first['catalog_selections']==[] and first['add_ons']==[]
        owner.record_quote(first,t.checked(first))
        assert state()['authorized_revision_changes']==authorized
        retry=owner.prepare_quote({'catalog_selections':[]});assert retry['catalog_selections']==[]
        owner.record_quote(retry,t.checked(retry));assert state()['authorized_revision_changes']==authorized
        # Quote-only permission never creates an unseen changed offer.
        no_consent=create_outcome();assert not no_consent['create_prepared']
        # Restore a nonempty draft in this ingress, as the existing registered retry test does.
        restored=owner.prepare_quote({'catalog_selections':t.plan['catalog_selections']})
        owner.record_quote(restored,t.checked(restored));assert state()['authorized_revision_changes']==authorized
        t.turn('catalog-fresh-ingress','Actually, wait')
        assert 'authorized_revision_changes' not in state()
        fresh=owner.prepare_quote({'catalog_selections':[]})
        assert fresh['catalog_selections']==t.plan['catalog_selections']
        emit('catalog-bounded-retry',authorized_after_record=authorized,same_turn_retry_catalog=retry['catalog_selections'],new_ingress_authority=state().get('authorized_revision_changes'),new_ingress_catalog=fresh['catalog_selections'],new_ingress_addons=fresh.get('add_ons'),unseen_create=no_consent)
    finally:t.tearDown()
    # Focused existing keep-list only. Parent runs full 80 suite.
    names=['test_named_removal_authorizes_only_evidenced_material_field','test_registered_catalog_removal_syncs_staff_wire_projection','test_export_g1_g4_provisional_male_alias_survives_checked_revalidation','test_material_revision_is_bound_to_exact_interpreted_value','test_registered_adapter_preserves_provisional_payment_then_revalidates_explicit_choices']
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(OwnerHostileTests(n) for n in names))
    assert result.wasSuccessful()
emit('completed',network_requests=0,business_dispatches=0,full_suite_run=False)
