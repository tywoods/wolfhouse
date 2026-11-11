"""Bounded direct inference only. No refresh, tools, transport, or source edits."""
import base64, hashlib, json, pathlib, shlex, subprocess, time, urllib.request, urllib.error, sys
ROOT=pathlib.Path('/opt/data/workspace/sandbox-repos/luna-v4-seadog')
OUT=ROOT/'docs/reviews/luna-v4-real-model'
OUT.mkdir(parents=True,exist_ok=True)
CAT=pathlib.Path('/opt/data/workspace/sandbox-repos/WH-seadog/artifacts/luna-v4-real-model/catalog.json')
START=time.time(); DEADLINE=START+21600
ENV={}
for line in pathlib.Path('/opt/data/secrets/luna_staging_model.env').read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k,v=line.split('=',1); ENV[k.strip()]=shlex.split(v)[0]
TOKEN=ENV['OPENAI_API_KEY']; ACCOUNT=ENV.get('CHATGPT_ACCOUNT_ID','')
assert ENV['HERMES_PROVIDER']=='openai-codex' and ENV['HERMES_MODEL']=='gpt-6.1-sol'
BASE=ENV['OPENAI_BASE_URL'].rstrip('/')
assert BASE.startswith('https://chatgpt.com/backend-api/codex'), 'Unapproved endpoint'
URL=BASE if BASE.endswith('/responses') else BASE+'/responses'
SECRET=[v for k,v in ENV.items() if k in ('OPENAI_API_KEY','CHATGPT_ACCOUNT_ID') and v]
def clean(s):
    for v in SECRET:s=s.replace(v,'[REDACTED]')
    return s
def save(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(clean(json.dumps(data,ensure_ascii=False,indent=2)))
def expired():
    parts=TOKEN.split('.')
    if len(parts)!=3:return False
    d=json.loads(base64.urlsafe_b64decode(parts[1]+'='*(-len(parts[1])%4)))
    return d.get('exp',time.time()+1)<=time.time()
def call(body,path):
    if expired():raise RuntimeError('STOP_TOKEN_EXPIRED_NO_REFRESH')
    if time.time()>DEADLINE:raise RuntimeError('STOP_BOUNDED_DEADLINE')
    save(path/'request.json',body)
    req=urllib.request.Request(URL,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+TOKEN,'ChatGPT-Account-Id':ACCOUNT,'Content-Type':'application/json','Accept':'text/event-stream','OpenAI-Beta':'responses=experimental','originator':'codex_cli_rs'})
    events=[]; response=None; delta=[]
    try:
        with urllib.request.urlopen(req,timeout=150) as stream:
            for raw in stream:
                if time.time()>DEADLINE:raise RuntimeError('STOP_BOUNDED_DEADLINE')
                line=raw.decode().strip()
                if not line.startswith('data:'):continue
                value=line[5:].strip()
                if value=='[DONE]':continue
                event=json.loads(value); events.append(event)
                if event.get('type')=='response.output_text.delta':delta.append(event.get('delta',''))
                if event.get('type') in ('response.completed','response.incomplete','response.failed'):response=event.get('response');break
        save(path/'events.json',events)
        if not response:raise RuntimeError('MISSING_COMPLETED_RESPONSE')
        save(path/'response.json',response)
        if response.get('status')!='completed':raise RuntimeError('RESPONSE_NOT_COMPLETED')
        text=''.join(c.get('text','') for item in response.get('output',[]) for c in item.get('content',[]) if c.get('type')=='output_text') or ''.join(delta)
        if not text:raise RuntimeError('EMPTY_TEXT')
        return text
    except urllib.error.HTTPError as e:
        save(path/'failure.json',{'http_status':e.code,'body':e.read().decode(errors='replace'),'refresh_attempted':False})
        raise RuntimeError('STOP_HTTP_'+str(e.code)) from None
    except Exception as e:
        save(path/'failure.json',{'error':clean(str(e)),'refresh_attempted':False})
        raise

def body(instructions,history):return {'model':'gpt-6.1-sol','instructions':instructions,'input':history,'store':False,'stream':True,'tools':[],'tool_choice':'none','parallel_tool_calls':False}
def msg(role,text):return {'role':role,'content':text}
source='scripts/lib/luna-guest-personality-packs.js'
head=subprocess.check_output(['git','show','HEAD:'+source],cwd=ROOT,text=True)
working=(ROOT/source).read_text()
def packs(s):
    code="const m={exports:{}}; new Function('module','exports',"+json.dumps(s)+")(m,m.exports); console.log(JSON.stringify(m.exports.PACKS));"
    return json.loads(subprocess.check_output(['node','-e',code],text=True))
hp=packs(head); wp=packs(working)
PACKS={'sunny_source_default':hp['sunny']['instruction'],'conversationalist_HEAD':hp['conversationalist']['instruction'],'conversationalist_candidate':wp['conversationalist']['instruction']}
assert len(PACKS['conversationalist_candidate'])==894
catalog=json.loads(CAT.read_text())
guides={t:(ROOT/p).read_text() for t,p in {'Wolfhouse':'docker/hermes-staging/SOUL.md','Sunset':'docker/hermes-sunset/SOUL.md'}.items()}
core=(ROOT/'docker/hermes-staging/soul-guides/01-core-voice-language.md').read_text()
save(OUT/'manifest.json',{'status':'RUNNING','head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'catalog_sha256':hashlib.sha256(CAT.read_bytes()).hexdigest(),'packs':PACKS,'guides':guides,'shared_core_unchanged':core,'model':'gpt-6.1-sol','protocol_source':'https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/chatgpt_base_url.rs','limits':{'wall_seconds':21600,'http_timeout_seconds':150},'scope':'Synthetic direct-model prompt evaluation, NOT runtime/tool/transport proof; existing token only, never refreshed.'})
results=[]
try:
    for case in catalog['cases']:
        for variant in case['variants']:
            triplet={}
            for name,pack in PACKS.items():
                dest=OUT/'chats'/case['id']/variant['id']/name
                instructions=guides.get(case['tenant'],guides['Wolfhouse'])+'\n\nUNCHANGED SHARED CORE GUIDE:\n'+core+'\n\nSELECTED PERSONALITY PACK:\n'+pack+'\n\nEVALUATION ENVIRONMENT: This is an isolated synthetic conversation. All supplied fixtures and receipt-shaped objects are synthetic, NOT actual executed tool results. No tools or external delivery exist. Do not claim to execute operations. Use fixture facts only within this hypothetical test universe. The source guides above are unchanged, including any identity conflict. Do not silently override their conflict.'
                history=[msg('developer','SYNTHETIC FIXTURE — NOT ACTUAL TOOL RECEIPTS:\n'+json.dumps(variant['trusted_context_fixture'],ensure_ascii=False))]
                transcript=[]
                for turn in variant['user_turns']:
                    n=turn['turn']
                    for event in variant.get('fixture_events',[]):
                        if event.get('before_turn')==n or event.get('after_turn')==n-1:
                            history.append(msg('developer','SYNTHETIC FIXTURE UPDATE — NOT EXECUTED:\n'+json.dumps(event,ensure_ascii=False)))
                    if n>1:
                        gate=body('You are a conservative replay auditor. Determine whether the next scripted user message can coherently follow the actual preceding assistant reply. Do not force a yes/consent to a missing question. Return JSON only: {"proceed":true/false,"reason":"..."}. Ordinary independent user requests can proceed.',[msg('user',json.dumps({'history':history,'next_turn':turn},ensure_ascii=False))])
                        gate_text=call(gate,dest/('gate-'+str(n)))
                        try:allowed=json.loads(gate_text.strip().removeprefix('```json').removesuffix('```').strip())
                        except ValueError:allowed={'proceed':False,'reason':'Gate returned invalid JSON'}
                        if allowed.get('proceed') is not True:
                            transcript.append({'turn':n,'status':'NOT_RUN_BRANCH_PRECONDITION','gate':allowed});break
                    history.append(msg('user',turn['content']))
                    text=call(body(instructions,history),dest/('turn-'+str(n)))
                    history.append(msg('assistant',text));transcript.append({'turn':n,'user':turn['content'],'assistant':text})
                save(dest/'transcript.json',transcript);triplet[name]=transcript
                results.append({'case':case['id'],'variant':variant['id'],'pack':name,'status':'CAPTURED','path':str(dest)})
                save(OUT/'progress.json',{'status':'RUNNING','completed_chats':len(results),'results':results})
                print('CAPTURED',case['id'],variant['id'],name,flush=True)
            rubric='You are an evidence reviewer. Score EACH of the three actual chats against the required outcome and synthetic fixture. Return JSON with per_pack entries containing score_0_to_5, verdict, failures, evidence_quotes; plus candidate_vs_sunny_voice_distinction (must be more than brevity: detail-specific response, cadence, warmth, natural stopping), candidate_vs_HEAD, identity_conflict, pack_strengthening_needed and reasons. Never infer executed tools, writes, transport, runtime consent enforcement or real receipts from synthetic prompt output. Distinguish inability due to tool-less harness from pack defects. Missing branches are NOT RUN. Be strict and honest. This is model-assisted scoring, not independent human approval.'
            score=call(body(rubric,[msg('user',json.dumps({'case':case,'variant':variant,'actual_chats':triplet},ensure_ascii=False))]),OUT/'scores'/case['id']/variant['id'])
            save(OUT/'scores'/case['id']/variant['id']/'assessment.json',{'method':'same-model assisted assessment; human review required','assessment':score})
    save(OUT/'status.json',{'status':'COMPLETE_CAPTURE_AND_MODEL_ASSISTED_SCORING','completed_chats':len(results),'human_review':'PENDING','elapsed_seconds':time.time()-START})
except Exception as e:
    save(OUT/'status.json',{'status':'STOPPED','error':clean(str(e)),'completed_chats':len(results),'elapsed_seconds':time.time()-START,'refresh_attempted':False})
    print('STOPPED',clean(str(e)),flush=True);sys.exit(1)
