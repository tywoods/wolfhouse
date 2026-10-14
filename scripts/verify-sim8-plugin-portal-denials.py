"""Exact transport/consumer functions, inert HTTPError fixture; never calls network."""
import ast, io, json, re, sys, types, urllib.request, urllib.error
from pathlib import Path
root=Path(sys.argv[1]); out=Path(__file__).parent
source=(root/'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py').read_text(); tree=ast.parse(source)
names={'_clean','_safe_text','_normalize_bot_path','_portal_policy_denial','_post_bot','_intentional_capability_block','_payment_link_result'}
selected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
terms=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='GUEST_UNSAFE_TERMS' for t in n.targets))
package=types.ModuleType('wolfhouse'); package.__path__=[]
door=types.ModuleType('wolfhouse.crowsnest_guest_door');door.staff_transport_denial=lambda p:None
sys.modules['wolfhouse']=package;sys.modules['wolfhouse.crowsnest_guest_door']=door
current={};calls=[];handoffs=[]
def no_network(request,timeout):
    calls.append({'url':request.full_url,'timeout':timeout})
    raise urllib.error.HTTPError(request.full_url,current['status'],'synthetic policy refusal',{},io.BytesIO(json.dumps(current['body']).encode()))
ns={'re':re,'json':json,'os':types.SimpleNamespace(getenv=lambda k,default='':default),
    'urllib':types.SimpleNamespace(request=types.SimpleNamespace(Request=urllib.request.Request,urlopen=no_network),error=urllib.error),
    '_bot_token':lambda:'offline-review-placeholder','_trusted_client_slug':lambda:'wolfhouse-somo',
    '_session_guest_phone':lambda:'+'+''.join(map(str,[999,123,456,789])),
    '_base_url':lambda:'https://invalid.test',
    'GUEST_UNSAFE_TERMS':ast.literal_eval(terms.value)}
exec(compile(ast.Module(body=selected,type_ignores=[]),'<production-transport-consumer>','exec'),ns)
ns['_payment_failure_handoff']=lambda tool:handoffs.append(tool) or {'handoff_boundary_reached':True}
observations=[]
def denial(status, reason, source):
    return {'status':status,'body':{
      'success':False,'reason_code':reason,'policy_source':source,'write_performed':False,
      'creates_stripe_link':False,'sends_whatsapp':False,'staff_review_needed':False,'do_not_escalate':True,
    }}
inputs=[
 denial(403,'booking_channel_off','inbox_channel_modes'),
 denial(403,'booking_channel_draft','inbox_channel_modes'),
 denial(403,'booking_global_paused','bot_pause_states'),
 denial(403,'booking_conversation_paused','bot_pause_states'),
 denial(403,'booking_needs_human','conversations'),
 denial(503,'booking_policy_unavailable','staff_portal'),
]
assert len(inputs)==6
for current in inputs:
    for path in ['/booking-create-from-plan','/payments/fixture-id/create-stripe-link']:
        calls.clear();handoffs.clear(); response=ns['_post_bot'](path,{})
        assert response['status']==current['status']
        assert response['staff_review_needed'] is False
        assert response['reason_code']==current['body']['reason_code'] and response['do_not_escalate'] is True
        assert response['write_performed'] is False
        assert response['policy_source']==current['body']['policy_source']
        result=None
        if path.startswith('/payments/'):
            result=ns['_payment_link_result']('create_payment_link',response,{'success':False})
            assert result.get('payment_operation_failed') is not True and len(handoffs)==0
        assert len(calls)==1
        observations.append({'path':path,'actual_js_response':current,'transport_result':response,'consumer_result':result,'inert_handoff_calls':list(handoffs)})
print('verify-sim8-plugin-portal-denials PASS: 12 typed refusals preserved; 6 payment refusals produced zero handoff calls')
