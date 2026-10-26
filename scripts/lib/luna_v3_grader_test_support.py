"""Offline real-plugin boundary helper for tests. HTTP bodies are test inputs, not live proof."""
import copy
import importlib.util
import json
from pathlib import Path
import socket
import sys
import urllib.error
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
# Independent caller context for offline tests. Never infer this from receipts.
TEST_AUTHORITY={'tenant_id':'wolfhouse-somo','session_id':'luna-v3:test-session','external_send_allowed':False,'staff_alert_allowed':False}
sys.path.insert(0,str(ROOT/'docker/hermes-luna-v3'))
spec=importlib.util.spec_from_file_location('grader_test_plugin',ROOT/'docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py')
assert spec and spec.loader
plugin=importlib.util.module_from_spec(spec);spec.loader.exec_module(plugin)
from runtime.trusted_turn_context import bind_inbound_event,clear_inbound_event,bind_harness_evidence,clear_harness_evidence

class Response:
    def __init__(self,raw,status=200):self.raw,self.status=raw,status
    def __enter__(self):return self
    def __exit__(self,*args):return False
    def read(self,*args):return self.raw
    def close(self):pass

def produce(args,owner=None,*,raw=None,status=200,event_id='evt',session='luna-v3:test-session',fault='',call_id='offline-tool-call'):
    raw=json.dumps(owner).encode() if raw is None else raw
    call={'id':call_id,'function':{'name':'check_quote_book','arguments_parsed':copy.deepcopy(args)}}
    evidence=[];inbound=bind_inbound_event(event_id);tokens=bind_harness_evidence(evidence,fault)
    transport=Response(raw,status)
    if status>=300:transport=urllib.error.HTTPError('http://offline.invalid',status,'offline',{},transport)
    kwargs={'side_effect':transport} if isinstance(transport,BaseException) else {'return_value':transport}
    try:
        with patch.object(plugin,'_runtime',return_value={'base_url':'http://offline.invalid','tenant':'wolfhouse-somo','session_id':session,'token':'offline-test'}),patch.object(plugin,'_open_staff',**kwargs),patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK FORBIDDEN')):
            result=plugin.call_tool('check_quote_book',args)
    finally:
        clear_harness_evidence(tokens);clear_inbound_event(inbound)
    assert len(evidence)==1,evidence
    result['_tool_call_id']=call_id
    return call,result,evidence[0]

def boundary_evidence(call,result,event_id='evt',status=200,session='luna-v3:test-session'):
    """Replace old fabricated result envelopes with actual plugin projections."""
    call.setdefault('id','offline-tool-call')
    if not isinstance(call.get('function'),dict):call['function']={'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}
    elif not call['function'].get('arguments_parsed'):call['function']['arguments_parsed']={'action':'prepare'}
    args=copy.deepcopy(call['function']['arguments_parsed'])
    owner={k:v for k,v in result.items() if k not in ('_tool_call_id','call_id')}
    status=status if status is not None else (200 if owner.get('ok') is True else 422)
    _,observed,exchange=produce(args,owner,event_id=event_id,status=status,call_id=call['id'],session=session)
    result.clear();result.update(observed)
    return exchange
