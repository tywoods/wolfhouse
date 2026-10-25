#!/usr/bin/env python3
"""Cap authentic rendered-reply matrix.

This runner has no fixture/model-output mode. Inventory and expected facts are obtained
from authenticated Staff admission, every case gets three fresh TEST sessions, and any
missing evidence fails closed. HTTP bytes are retained before parsing.
"""
from __future__ import annotations
import hashlib, json, os, pathlib, subprocess, sys, time, urllib.error, urllib.request

REPS=3
EXPECTED={"provider":"openai-codex","model":"gpt-6.1-sol","reasoning":"low","temperature":"provider-default","fallback":""}
SECRET_KEYS=("token","authorization","password","secret","api_key","cookie")

def need(n):
 v=os.environ.get(n,"").strip()
 if not v: raise SystemExit(f"BLOCKED: {n} is required")
 return v

def canon(v): return json.dumps(v,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
def digest_bytes(v): return hashlib.sha256(v).hexdigest()
def digest(v): return digest_bytes(canon(v))
def redact(v):
 if isinstance(v,list): return [redact(x) for x in v]
 if isinstance(v,dict): return {k:("[REDACTED]" if any(s in k.lower() for s in SECRET_KEYS) else redact(x)) for k,x in v.items()}
 return v

def request(url,token,trace,payload,*,fault=None,timeout=240):
 headers={"Authorization":f"Bearer {token}","Content-Type":"application/json","Accept":"application/json","X-Luna-V3-Harness-Trace":trace}
 if fault: headers["X-Luna-V3-Harness-Fault"]=fault
 req=urllib.request.Request(url,canon(payload),headers,method="POST")
 started=time.time()
 try:
  with urllib.request.urlopen(req,timeout=timeout) as r: status=r.status; raw=r.read(); response_headers=dict(r.headers.items())
 except urllib.error.HTTPError as e: status=e.code; raw=e.read(); response_headers=dict(e.headers.items())
 except Exception as e: return {"status":None,"raw":b"","headers":{},"elapsed_ms":round((time.time()-started)*1000),"transport_error":type(e).__name__}
 try: parsed=json.loads(raw)
 except Exception: parsed=None
 return {"status":status,"raw":raw,"headers":response_headers,"elapsed_ms":round((time.time()-started)*1000),"parsed":parsed}

def make_cases(snapshot,fixture):
 choices=snapshot.get("choices")
 if snapshot.get("ok") is not True or not snapshot.get("revision") or not isinstance(choices,list): raise SystemExit("BLOCKED: malformed live Staff capability snapshot")
 by_kind={}
 for c in choices:
  if not isinstance(c,dict) or not c.get("kind") or not c.get("code"): raise SystemExit("BLOCKED: malformed live Staff choice")
  if c.get("active",True): by_kind.setdefault(c["kind"],[]).append(c)
 required={"accommodation","package","rental","service"}
 lesson_rows=[c for c in by_kind.get("service",[]) if "lesson" in " ".join(str(c.get(k,"")) for k in ("code","label","product","category")).lower()]
 missing=sorted(required-set(by_kind))
 if missing or len(lesson_rows)<2: raise SystemExit(f"BLOCKED: missing required active capability kinds or two lesson products: kinds={missing}, lessons={len(lesson_rows)}")
 out=[]
 def add(cid,prompt,expect,choice=None,prepare=True,continuation=False,fault=None,control=None):
  default={"check_in":fixture["valid_dates"]["check_in"],"check_out":fixture["valid_dates"]["check_out"],"guests":["Alex"],"room":{"kind":"shared"},"package":"package_none","add_ons":[]} if prepare else None
  out.append({"id":cid,"prompt":prompt,"expect":expect,"choice":choice,"prepare_required":prepare,"continuation":continuation,"fault":fault,"control":control or default})
 good=fixture["valid_dates"]; bad=fixture["invalid_dates"]
 gd=f'{good["check_in"]} to {good["check_out"]}'; bd=f'{bad["check_in"]} to {bad["check_out"]}'
 add("stay-only-refusal",f"Quote accommodation only for Alex, one guest, shared room, {bd}. Repeat Staff's exact reason, facts, path and next step if refused.","refusal")
 add("stay-only-success-control",f"Quote accommodation only for Alex, one guest, shared room, {gd}. Do not hold or book.","quote")
 for kind in ("package","rental","service"):
  rows=by_kind.get(kind,[])
  for c in rows:
   label=c.get("label") or c["code"]
   dates=f" on {good['check_in']}" if kind in ('rental','service') else ''
   control={"check_in":good["check_in"],"check_out":good["check_out"],"guests":["Alex"],"room":{"kind":"shared"},"package":c['code'] if kind=='package' else 'package_none',"add_ons":[] if kind=='package' else [{"code":c['code'],"quantity":1,"people":["Alex"],"dates":[good['check_in']]}]}
   add(f"{kind}-{c['code']}-success",f"Quote active {kind} {label} ({c['code']}) for Alex, quantity 1{dates}, {gd}. Use exact Staff amount and terms; do not hold or book.","quote",c,control=control)
   add(f"{kind}-{c['code']}-refusal",f"Quote active {kind} {label} ({c['code']}) for Alex, quantity 1{dates}, {bd}. Repeat Staff's exact refusal and correction path.","refusal",c,control=control)
 mixed_addons=[{"code":c["code"],"quantity":1,"people":["Alex"],"dates":[good["check_in"]]} for kind in ("rental","service") for c in by_kind[kind]]
 mixed_control={"check_in":good["check_in"],"check_out":good["check_out"],"guests":["Alex"],"room":{"kind":"shared"},"package":by_kind["package"][0]["code"],"add_ons":mixed_addons}
 add("mixed",f"Quote accommodation plus {by_kind['package'][0]['code']} and these active extras: {', '.join(x['code'] for x in mixed_addons)}, for Alex, {gd}. Preserve exact Staff facts and terms; do not hold or book.","mixed",control=mixed_control)
 group_control={"check_in":good["check_in"],"check_out":good["check_out"],"guests":["Alex","Sam","Jo"],"room":{"kind":"shared","together":"preferred"},"package":"package_none","add_ons":[]}
 add("multi-guest",f"Quote shared accommodation for Alex, Sam and Jo, {gd}. Keep them together if available; preserve exact Staff amounts and terms; do not hold or book.","quote",control=group_control)
 advertised=(by_kind.get('package') or [{'code':'package_none','label':'Accommodation only'}])[0]
 add("genuine-continuation",f"Quote {advertised.get('label')} ({advertised['code']}) for Alex for {bd}. If Staff refuses, explain its exact correction path.","quote",advertised,continuation=True)
 add("missing-dates-clarification","I would like a quote for accommodation only for Alex in a shared room.","clarification",prepare=False)
 for fault in ("non-json","malformed","http-422","exception","timeout"): add(f"staff-boundary-{fault}",f"Quote shared accommodation for Alex, {gd}. If Staff cannot verify, clearly state uncertainty and do not invent facts.","uncertain",fault=fault)
 for case in out:
  if case["expect"]=="refusal" or case["continuation"]:
   case["control"]={**case["control"],"check_in":bad["check_in"],"check_out":bad["check_out"]}
  if case["continuation"]:
   case["corrected_control"]={**case["control"],"check_in":good["check_in"],"check_out":good["check_out"]}
  if case["prepare_required"] and not validate_control(case,choices): raise SystemExit(f"BLOCKED: owner-invalid complete control: {case['id']}")
 return out

def validate_control(case,choices):
 control=case.get("control")
 if not isinstance(control,dict) or not all(control.get(k) for k in ("check_in","check_out","guests","room","package")) or not isinstance(control.get("add_ons"),list): return False
 active={c.get("code"):c for c in choices if isinstance(c,dict) and c.get("active",True)}
 if control["package"] not in active: return False
 for addon in control["add_ons"]:
  if not isinstance(addon,dict) or addon.get("code") not in active or type(addon.get("quantity")) is not int or addon["quantity"]<1: return False
  requirements=active[addon["code"]].get("requirements") or {}
  if requirements.get("dates") and not addon.get("dates"): return False
  if requirements.get("participants") and not addon.get("people"): return False
 return True

def control_matches_prepare(control,args):
 if not isinstance(control,dict) or not isinstance(args,dict): return False
 if any(args.get(k)!=control.get(k) for k in ("check_in","check_out")): return False
 guest_names=[g.get("name") if isinstance(g,dict) else g for g in args.get("guests") or []]
 if guest_names!=control.get("guests"): return False
 room=args.get("room") or {}
 if not isinstance(room,dict) or room.get("kind")!=control.get("room",{}).get("kind") or control.get("room",{}).get("together") and room.get("together")!=control["room"]["together"]: return False
 package=args.get("package"); package_code=package.get("code") or package.get("name") if isinstance(package,dict) else package
 if package_code!=control.get("package"): return False
 def addon_key(row):
  return (row.get("code") or row.get("name"),row.get("quantity"),tuple(row.get("dates") or row.get("requested_dates") or []),tuple(row.get("people") or []))
 return sorted(addon_key(x) for x in args.get("add_ons") or [])==sorted(addon_key(x) for x in control.get("add_ons") or [])

STATE_FIELDS={"booking_count","hold_count","payment_count","external_send_count","staff_alert_count"}
def valid_state_receipt(value,thread):
 return isinstance(value,dict) and value.get("ok") is True and value.get("schema")=="luna-v3-test-state/v1" and value.get("authenticated") is True and value.get("tenant")=="wolfhouse-somo" and value.get("thread")==thread and all(type(value.get(k)) is int and value[k]>=0 for k in STATE_FIELDS)

def semantic_score(case,reply,calls,results,fault_exchange):
 prepared=len(calls); clarification=case.get("expect")=="clarification"; progress=prepared==(1 if case.get("prepare_required") else 0)
 if clarification: fidelity=None
 elif not results: fidelity=False
 else:
  result=results[-1] if isinstance(results[-1],dict) else {}; text=str(reply or '').lower()
  fidelity=any(str(v).lower() in text for k,v in result.items() if k in ('message','reason','next_step','total_cents','amount_cents','deposit_cents') and v is not None)
 if case.get('fault'):
  fault_ok=bool(fault_exchange and fault_exchange.get('fault')==case['fault'])
  if case['fault']=='http-422': fault_ok=fault_ok and fault_exchange.get('status')==422
  if case['fault']=='exception': fault_ok=fault_ok and fault_exchange.get('exception_type')=='RuntimeError'
  if case['fault']=='timeout': fault_ok=fault_ok and fault_exchange.get('exception_type')=='TimeoutError'
  fidelity=bool(fault_ok and any(x in str(reply).lower() for x in ('cannot verify','could not verify','uncertain')))
 return {"clarification":bool(clarification and '?' in str(reply) and prepared==0),"progress":progress,"fidelity":fidelity}

def _event_parts(body):
 trace=body.get("harness_trace") if isinstance(body,dict) else None; messages=trace.get("messages") if isinstance(trace,dict) else []
 start=max((i for i,m in enumerate(messages) if isinstance(m,dict) and m.get("role")=="user"),default=-1)
 current=messages[start+1:]; calls=[]
 for m in current:
  if isinstance(m,dict) and m.get("role")=="assistant": calls.extend(m.get("tool_calls") or [])
 prepare=[c for c in calls if ((c.get("function") or {}).get("name") or c.get("name"))=="check_quote_book" and (((c.get("function") or {}).get("arguments_parsed") or c.get("arguments_parsed") or {}).get("action")=="prepare")]
 results=[m.get("content_parsed") for m in current if isinstance(m,dict) and m.get("role")=="tool"]
 exchanges=trace.get("staff_http_exchanges") if isinstance(trace,dict) else []
 return prepare,results,exchanges or []

def score_events(case,events):
 rows=[]
 for event in events:
  body=event.get("response") or {}; calls,results,exchanges=_event_parts(body); event_case=dict(case)
  if case.get("continuation"): event_case["expect"]="refusal" if not rows else "quote"
  score=semantic_score(event_case,body.get("reply_text"),calls,results,exchanges[-1] if exchanges else None)
  expected_control=case.get("corrected_control") if rows and case.get("continuation") else case.get("control")
  function=(calls[0].get("function") or {}) if len(calls)==1 else {}
  arguments=function.get("arguments_parsed") or calls[0].get("arguments_parsed") if len(calls)==1 else None
  rows.append({"event_id":event.get("event_id"),"prepare_count":len(calls),"owner_control_matches":control_matches_prepare(expected_control,arguments) if expected_control else None,"semantic":score})
 return rows

def scalars(v,prefix="$"):
 out=[]
 if isinstance(v,dict):
  for k,x in v.items(): out += scalars(x,f"{prefix}.{k}")
 elif isinstance(v,list):
  for i,x in enumerate(v): out += scalars(x,f"{prefix}[{i}]")
 elif isinstance(v,(str,int,float)) and not isinstance(v,bool): out.append((prefix,str(v)))
 return out

def judge(case,body,pre,post):
 trace=body.get("harness_trace") if isinstance(body,dict) else None
 messages=trace.get("messages") if isinstance(trace,dict) else None
 final=trace.get("final_response") if isinstance(trace,dict) else None
 reply=body.get("reply_text") if isinstance(body,dict) else None
 calls=[]
 if isinstance(messages,list):
  for m in messages:
   if isinstance(m,dict) and m.get("role")=="assistant":
    for c in m.get("tool_calls") or []: calls.append(c)
 prepare=[c for c in calls if ((c.get("function") or {}).get("name") or c.get("name"))=="check_quote_book" and (((c.get("function") or {}).get("arguments_parsed") or c.get("arguments_parsed") or {}).get("action")=="prepare")]
 tool_results=[m.get("content_parsed") for m in messages or [] if isinstance(m,dict) and m.get("role")=="tool"]
 evidence=" ".join(x for _,x in sum((scalars(x) for x in tool_results),[]) if len(x)>=2)
 reply_s=str(reply or "")
 exact_fields=[]
 for result in tool_results:
  if isinstance(result,dict):
   for key in ("reason","reason_code","facts","path","next_step","total_cents","amount_cents","deposit_cents","terms"):
    if key in result:
     vals=[x for _,x in scalars(result[key]) if len(x)>=2]
     exact_fields += [(key,x,x.lower() in reply_s.lower()) for x in vals]
 quote_only=case["expect"] in ("quote","mixed")
 checks={
  "reply_present":bool(reply_s.strip()),"reply_equals_final_response":isinstance(final,str) and reply==final,
  "complete_exact_trace":isinstance(messages,list) and bool(messages) and trace.get("untruncated") is True,
  "raw_staff_responses_present":isinstance(trace,dict) and isinstance(trace.get("staff_http_exchanges"),list),
  "installed_plugin_result_present":isinstance(trace,dict) and isinstance(trace.get("installed_plugin"),dict) and bool(trace["installed_plugin"].get("sha256")),
  "runtime_readback_present":isinstance(trace,dict) and isinstance(trace.get("runtime_readback"),dict),
  "pre_post_state_present":isinstance(pre,dict) and isinstance(post,dict),
  "one_prepare_per_turn":len(prepare)==(2 if case["continuation"] else 1) if case["prepare_required"] else len(prepare)==0,
  "staff_fields_rendered_exactly":all(ok for _,_,ok in exact_fields) and (bool(exact_fields) or case["expect"] in ("uncertain","n/a")),
  "no_hold_or_booking_for_quote":not quote_only or pre.get("booking_count")==post.get("booking_count") and pre.get("hold_count")==post.get("hold_count"),
  "send_suppressed":body.get("external_send_allowed") is False and body.get("staff_alert_allowed") is False,
 }
 if case["expect"]=="uncertain": checks["fault_uncertainty"]=("uncertain" in reply_s.lower() or "cannot verify" in reply_s.lower() or "couldn't verify" in reply_s.lower()) and not any(x.lower() in reply_s.lower() for x in evidence.split() if len(x)>20)
 if case["continuation"]:
  checks["genuine_one_use_continuation"]=isinstance(trace,dict) and trace.get("continuation_consumed") is True
  checks["first_refusal_then_success"]=any(isinstance(x,dict) and x.get("ok") is False for x in tool_results) and any(isinstance(x,dict) and x.get("ok") is True for x in tool_results)
 return checks,exact_fields

def main():
 root=pathlib.Path(__file__).resolve().parents[1]; head=subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()
 if head!=need("LUNA_MATRIX_CANDIDATE_SHA"): raise SystemExit("BLOCKED: checkout does not equal pinned candidate SHA")
 settings={"provider":need("HERMES_MODEL_PROVIDER"),"model":need("HERMES_MODEL"),"reasoning":need("HERMES_REASONING_EFFORT"),"temperature":os.environ.get("HERMES_TEMPERATURE","provider-default"),"fallback":os.environ.get("HERMES_FALLBACK_MODEL","")}
 if settings!=EXPECTED: raise SystemExit(f"BLOCKED: effective model settings mismatch: {settings}")
 base=need("LUNA_MATRIX_SIMULATOR_URL").rstrip("/"); token=need("LUNA_MATRIX_SIMULATOR_TOKEN"); trace_token=need("LUNA_V3_HARNESS_TRACE_TOKEN")
 out=pathlib.Path(os.environ.get("LUNA_MATRIX_OUTPUT","artifacts/rendered-reply-matrix")); out.mkdir(parents=True,exist_ok=False)
 preflight=request(base+"/wolfhouse/luna-v3-harness/preflight",token,trace_token,{"candidate_sha":head})
 if preflight["status"]!=200 or not isinstance(preflight["parsed"],dict) or preflight["parsed"].get("ok") is not True: raise SystemExit("BLOCKED: authentic model/runtime preflight failed")
 pf=preflight["parsed"]
 if pf.get("effective_model")!=EXPECTED or pf.get("fallback_possible") is not False: raise SystemExit("BLOCKED: runtime readback/fallback proof failed")
 pins=pf.get("pins")
 required_pins=("candidate_sha","image_digest","base_image_digest","instruction_sha256","plugin_sha256","contract_sha256")
 if not isinstance(pins,dict) or pins.get("candidate_sha")!=head or any(not str(pins.get(k) or "").strip() for k in required_pins): raise SystemExit("BLOCKED: immutable runtime pins missing/mismatched")
 snapshot=pf.get("staff_admission",{}).get("capability_snapshot")
 fixture_path=pathlib.Path(need("LUNA_MATRIX_FIXTURE_METADATA"))
 try: fixture=json.loads(fixture_path.read_text())
 except Exception as exc: raise SystemExit(f"BLOCKED: fixture metadata unreadable: {exc}")
 if fixture.get("tenant")!="wolfhouse-somo" or not all(isinstance(fixture.get(k),dict) for k in ("valid_dates","invalid_dates")): raise SystemExit("BLOCKED: malformed fixture metadata")
 cases=make_cases(snapshot,fixture); records=[]; seq=0
 for case in cases:
  if case["expect"]=="n/a": records.append({"case":case,"repetition":None,"verdict":"N/A","reason":"live Staff admission snapshot has no active cell for this kind"}); continue
  for rep in range(1,REPS+1):
   seq+=1; phone=f"+346999{seq:05d}"
   pre_wire=request(base+"/wolfhouse/luna-v3-harness/state",token,trace_token,{"thread":phone})
   state=pre_wire.get("parsed")
   payload={"thread":phone,"text":case["prompt"],"external_send_allowed":False,"capture_continuation":case["continuation"]}
   wire=request(base+"/wolfhouse/simulate-guest-turn",token,trace_token,payload,fault=case["fault"])
   body=wire["parsed"] or {}; event_receipts=[]
   def retain_event(event_wire,event_body,event_payload,event_number):
    trace=event_body.get("harness_trace") if isinstance(event_body,dict) else None
    event_id=trace.get("inbound_event_id") if isinstance(trace,dict) else None
    raw_name=f"raw/{seq:04d}-event-{event_number}.bin"; (out/raw_name).parent.mkdir(exist_ok=True); (out/raw_name).write_bytes(event_wire["raw"])
    event_receipts.append({"event_id":event_id,"request":event_payload,"http":redact({k:v for k,v in event_wire.items() if k not in ('raw','parsed')}),"response":event_body,"raw_file":raw_name,"raw_sha256":digest_bytes(event_wire["raw"])})
   retain_event(wire,body,payload,1)
   if case["continuation"] and body.get("continuation_ref"):
    correction=f"Correct the specific refusal by changing dates to {fixture['valid_dates']['check_in']} through {fixture['valid_dates']['check_out']}; keep the advertised selection {case['choice']['code']}."
    next_payload={"thread":phone,"text":correction,"continuation_ref":body["continuation_ref"],"external_send_allowed":False,"refusal_correction":True}
    wire=request(base+"/wolfhouse/simulate-guest-turn",token,trace_token,next_payload)
    body=wire["parsed"] or {}; retain_event(wire,body,next_payload,2)
   post_wire=request(base+"/wolfhouse/luna-v3-harness/state",token,trace_token,{"thread":phone})
   post=post_wire.get("parsed")
   checks,fields=judge(case,body,state if isinstance(state,dict) else {},post if isinstance(post,dict) else {})
   event_scores=score_events(case,event_receipts)
   semantic_ok=all(row["semantic"]["progress"] and (row["semantic"]["clarification"] if case["expect"]=="clarification" else row["semantic"]["fidelity"]) for row in event_scores)
   checks["one_prepare_per_turn"]=all(row["prepare_count"]==(0 if case["expect"]=="clarification" else 1) for row in event_scores)
   checks["owner_complete_control_used"]=all(row["owner_control_matches"] is not False for row in event_scores)
   checks["all_semantic_scores_pass"]=semantic_ok
   linkage={}
   if case["continuation"] and len(event_receipts)==2:
    first_calls,first_results,_=_event_parts(event_receipts[0]["response"]); second_calls,second_results,_=_event_parts(event_receipts[1]["response"])
    linkage={"refusal_event_id":event_receipts[0]["event_id"],"corrected_event_id":event_receipts[1]["event_id"],"new_prepare_event_id":event_receipts[1]["event_id"] if len(second_calls)==1 else None,
     "specific_refusal":next((r for r in first_results if isinstance(r,dict) and r.get("ok") is False),None),"corrected_success":next((r for r in second_results if isinstance(r,dict) and r.get("ok") is True),None)}
    checks["first_refusal_then_success"]=bool(linkage["refusal_event_id"] and linkage["corrected_event_id"] and linkage["refusal_event_id"]!=linkage["corrected_event_id"] and linkage["specific_refusal"] and linkage["corrected_success"] and linkage["new_prepare_event_id"])
   checks["typed_authenticated_state_receipts"]=pre_wire.get("status")==200 and post_wire.get("status")==200 and valid_state_receipt(state,phone) and valid_state_receipt(post,phone)
   checks["durable_no_side_effects"]=checks["typed_authenticated_state_receipts"] and all(state[k]==post[k] for k in STATE_FIELDS)
   passed=all(checks.values())
   rec={"case":case,"repetition":rep,"thread":phone,"http":{"status":wire["status"],"elapsed_ms":wire["elapsed_ms"],"transport_error":wire.get("transport_error")},"response":redact(body),"event_receipts":redact(event_receipts),"continuation_linkage":redact(linkage),"semantic_score":event_scores,"pre_staff_state":redact(state),"post_staff_state":redact(post),"compared_staff_fields":fields,"checks":checks,"verdict":"PASS" if passed else "FAIL"}; rec["sha256"]=digest(rec); records.append(rec)
 manifest={"schema":"luna-v3-cap-authentic-matrix/v2","candidate_sha":head,"repetitions":REPS,"no_retries":True,"generated_from_staff_admission_revision":snapshot["revision"],"cases":cases,"pins":pf.get("pins"),"redacted_settings":redact(settings)}
 result={"schema":"luna-v3-cap-authentic-results/v2","manifest_sha256":digest(manifest),"records":records,"pass":all(r.get("verdict") in ("PASS","N/A") for r in records)}
 (out/"manifest.json").write_bytes(canon(manifest)+b"\n"); (out/"results.json").write_bytes(canon(result)+b"\n")
 files=sorted(p for p in out.rglob("*") if p.is_file()); (out/"SHA256SUMS").write_text("".join(f"{digest_bytes(p.read_bytes())}  {p.relative_to(out)}\n" for p in files))
 print(json.dumps({"output":str(out),"cases":len(cases),"executed":sum(r.get("repetition") is not None for r in records),"pass":result["pass"]}))
 return 0 if result["pass"] else 1
if __name__=="__main__": raise SystemExit(main())
