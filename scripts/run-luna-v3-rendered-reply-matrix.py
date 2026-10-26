#!/usr/bin/env python3
"""Cap authentic rendered-reply matrix.

This runner has no fixture/model-output mode. Inventory and expected facts are obtained
from authenticated Staff admission, every case gets three fresh TEST sessions, and any
missing evidence fails closed. HTTP bytes are retained before parsing.
"""
from __future__ import annotations
import hashlib, json, os, pathlib, re, subprocess, sys, time, urllib.error, urllib.request

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
 """Fail closed unless cases are explicitly authored and proven by the Staff owner."""
 choices=snapshot.get("choices") if isinstance(snapshot,dict) else None
 if not isinstance(snapshot,dict) or snapshot.get("ok") is not True or not snapshot.get("revision") or not isinstance(choices,list): raise SystemExit("BLOCKED: malformed live Staff capability snapshot")
 if not isinstance(fixture,dict) or fixture.get("schema")!="luna-matrix-fixture/v1" or fixture.get("tenant")!="wolfhouse-somo": raise SystemExit("BLOCKED: malformed fixture schema")
 owner=fixture.get("owner_provenance")
 if not isinstance(owner,dict) or owner.get("authority")!="staff-owner" or not all(isinstance(owner.get(k),str) and owner[k].strip() for k in ("fixture_id","approved_by","approved_at","owner_revision_or_receipt_id")): raise SystemExit("BLOCKED: fixture lacks owner provenance")
 if fixture.get("capability_revision")!=snapshot["revision"]: raise SystemExit("BLOCKED: fixture capability revision mismatch")
 cases=fixture.get("cases"); allowed={"accommodation","package","rental","service:lesson_a","service:lesson_b","mixed","multi_guest","continuation","clarification","fault"}
 if not isinstance(cases,list) or not cases: raise SystemExit("BLOCKED: fixture has no explicit cases")
 ids=set(); categories=set(); out=[]
 for source in cases:
  if not isinstance(source,dict): raise SystemExit("BLOCKED: malformed fixture case")
  case=json.loads(json.dumps(source)); cid=case.get("id"); category=case.get("category"); outcome=case.get("intended_owner_outcome")
  if not isinstance(cid,str) or not cid.strip() or cid in ids or category not in allowed or not isinstance(case.get("prompt"),str) or not case["prompt"].strip() or not isinstance(outcome,dict): raise SystemExit("BLOCKED: malformed explicit fixture case")
  ids.add(cid); categories.add(category); case["prepare_required"]=category!="clarification"; case["continuation"]=category=="continuation"; case["expect"]=outcome.get("expect")
  if case["expect"] not in {"quote","mixed","refusal","clarification","uncertain"}: raise SystemExit(f"BLOCKED: invalid intended owner outcome: {cid}")
  if category=="fault" and case.get("fault") not in {"non-json","malformed","http-422","exception","timeout"}: raise SystemExit(f"BLOCKED: invalid fault case: {cid}")
  if category=="mixed" and outcome.get("compatibility_proven") is not True: raise SystemExit("BLOCKED: mixed case lacks owner compatibility proof")
  if case["prepare_required"] and not validate_control(case,choices): raise SystemExit(f"BLOCKED: owner-invalid complete control: {cid}")
  if case["continuation"] and not validate_control({"control":case.get("corrected_control")},choices): raise SystemExit(f"BLOCKED: continuation lacks owner-proven corrected control: {cid}")
  out.append(case)
 required=set(allowed)
 if not required.issubset(categories): raise SystemExit(f"BLOCKED: fixture coverage missing: {sorted(required-categories)}")
 group=next(c for c in out if c["category"]=="multi_guest")["control"]; package=group.get("package")
 packages=package.get("per_guest") if isinstance(package,dict) else None
 add_people={person for a in group.get("add_ons",[]) if isinstance(a,dict) for person in a.get("people",[])}
 if not isinstance(packages,list) or len(packages)!=len(group["guests"]) or len({p.get("name") for p in packages if isinstance(p,dict)})<2 or len(add_people)<2: raise SystemExit("BLOCKED: multi-guest case lacks differentiated per-guest package/add-on choices")
 return out

def validate_control(case,choices):
 control=case.get("control")
 if not isinstance(control,dict) or not all(control.get(k) for k in ("check_in","check_out","guests","room","package")) or not isinstance(control.get("add_ons"),list): return False
 if control["check_out"]<=control["check_in"] or len(control["guests"])!=len(set(control["guests"])): return False
 active={c.get("code"):c for c in choices if isinstance(c,dict) and c.get("active") is True}
 package=control["package"]
 package_codes=[package] if isinstance(package,str) else [p.get("name") for p in package.get("per_guest",[]) if isinstance(p,dict)] if isinstance(package,dict) else []
 if not package_codes or any(code not in active or active[code].get("kind") not in ("package","accommodation") for code in package_codes): return False
 for addon in control["add_ons"]:
  if not isinstance(addon,dict) or addon.get("code") not in active or type(addon.get("quantity")) is not int or addon["quantity"]<1: return False
  requirements=active[addon["code"]].get("requirements") or {}
  if requirements.get("dates") and not addon.get("dates"): return False
  if requirements.get("participants") and not addon.get("people"): return False
  if any(person not in control["guests"] for person in addon.get("people") or []): return False
  if any(date<control["check_in"] or date>=control["check_out"] for date in addon.get("dates") or []): return False
 return True

def control_matches_prepare(control,args):
 if not isinstance(control,dict) or not isinstance(args,dict): return False
 if args.get("action")!="prepare" or args.get("purpose")!="quote" or "payment" in args: return False
 if any(args.get(k)!=control.get(k) for k in ("check_in","check_out")): return False
 guest_names=[g.get("name") if isinstance(g,dict) else g for g in args.get("guests") or []]
 if guest_names!=control.get("guests"): return False
 if args.get("room")!=control.get("room"): return False
 package=args.get("package")
 if isinstance(control.get("package"),dict):
  if package!=control["package"]: return False
 else:
  package_code=package.get("code") or package.get("name") if isinstance(package,dict) else package
  if package_code!=control.get("package"): return False
 def addon_key(row):
  return (row.get("code") or row.get("name"),row.get("quantity"),tuple(row.get("dates") or row.get("requested_dates") or []),tuple(row.get("people") or []))
 return sorted(addon_key(x) for x in args.get("add_ons") or [])==sorted(addon_key(x) for x in control.get("add_ons") or [])

STATE_FIELDS={"booking_count","hold_count","payment_count","external_send_count","staff_alert_count"}
def valid_state_receipt(value,thread):
 return isinstance(value,dict) and value.get("ok") is True and value.get("schema")=="luna-v3-test-state/v1" and value.get("authenticated") is True and value.get("tenant")=="wolfhouse-somo" and value.get("thread")==thread and all(type(value.get(k)) is int and value[k]>=0 for k in STATE_FIELDS)

def semantic_score(case,reply,calls,results,fault_exchange):
 result={}
 prepared=len(calls); clarification=case.get("expect")=="clarification"; progress=prepared==(1 if case.get("prepare_required") else 0)
 if clarification: fidelity=None
 elif not results: fidelity=False
 else:
  call=calls[0] if len(calls)==1 else {}; tool_call_id=call.get('id')
  paired=[r for r in results if isinstance(r,dict) and r.get('_tool_call_id')==tool_call_id]
  result=paired[0] if len(paired)==1 else {}; text=str(reply or '').lower(); expected=case.get("expect")
  success=expected in ("quote","mixed")
  intended=(result.get("ok") is True and result.get("state","quote")=="quote" and result.get("held") is not True and result.get("booked") is not True) if success else (result.get("ok") is False and result.get("classification") not in ("internal","transport") if expected=="refusal" else result.get("ok") is False)
  authoritative=[(p,v) for p,v in scalars(result) if any(k in p.lower() for k in ("totalcents","total_cents","depositcents","deposit_cents","remainingcents","remaining_cents","currency","check_in","check_out","package","add_ons"))]
  def rendered(path,value):
   if "cents" in path.lower() and str(value).lstrip('-').isdigit():
    cents=int(value); tokens=re.findall(r'(?<![\w.])-?\d+(?:[.,]\d{1,2})?(?![\w.])',text)
    return str(cents) in tokens or f"{cents/100:.2f}" in [x.replace(',','.') for x in tokens]
   return bool(re.search(r'(?<!\w)'+re.escape(str(value).lower())+r'(?!\w)',text))
  authoritative_cents={int(v) for p,v in authoritative if "cents" in p.lower() and str(v).lstrip('-').isdigit()}
  money_claims=set()
  for whole,decimal in re.findall(r'(?:€|eur\s*|\$)\s*(-?\d+)(?:[.,](\d{1,2}))?',text,re.I): money_claims.add(int(whole)*100+(int(decimal.ljust(2,'0')) if decimal else 0))
  unsupported_money=bool(money_claims-authoritative_cents)
  authoritative_dates={v for p,v in authoritative if any(k in p.lower() for k in ("check_in","check_out"))}
  unsupported_dates=bool(set(re.findall(r'\b\d{4}-\d{2}-\d{2}\b',text))-authoritative_dates)
  forbidden=(result.get("booked") is not True and re.search(r'\b(booked|booking confirmed)\b',text)) or (result.get("held") is not True and re.search(r'\b(held|on hold)\b',text)) or (result.get("paid") is not True and re.search(r'\b(paid|payment received)\b',text))
  rendered_truth=all(rendered(p,v) for p,v in authoritative) if success else bool(text.strip())
  fidelity=bool(intended and (authoritative or not success) and rendered_truth and not unsupported_money and not unsupported_dates and not forbidden)
 if case.get('fault'):
  observed={"http-422":"http_error_read","exception":"runtime_exception_raised","timeout":"timeout_exception_raised","non-json":"json_parse_error","malformed":"malformed_shape"}[case['fault']]
  fault_ok=bool(fault_exchange and result.get('call_id')==fault_exchange.get('call_id') and fault_exchange.get('tool')=='check_quote_book' and fault_exchange.get('fault_requested')==case['fault'] and fault_exchange.get('fault_applied')==case['fault'] and fault_exchange.get('fault_observed')==observed and fault_exchange.get('call_id') and fault_exchange.get('event_id') and 'original_response_hex' in fault_exchange and 'raw_response_hex' in fault_exchange)
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
 results=[{**m.get("content_parsed"),"_tool_call_id":m.get("tool_call_id")} for m in current if isinstance(m,dict) and m.get("role")=="tool" and isinstance(m.get("content_parsed"),dict)]
 exchanges=trace.get("staff_http_exchanges") if isinstance(trace,dict) else []
 return prepare,results,exchanges or []

def score_events(case,events):
 rows=[]
 for event in events:
  body=event.get("response") or {}; calls,results,exchanges=_event_parts(body); event_case=dict(case)
  if case.get("continuation"): event_case["expect"]="refusal" if not rows else "quote"
  intended=next((r for r in results if r.get('_tool_call_id')==(calls[0].get('id') if len(calls)==1 else None)),{})
  target=next((x for x in exchanges if isinstance(x,dict) and x.get('call_id')==intended.get('call_id')),None)
  score=semantic_score(event_case,body.get("reply_text"),calls,results,target)
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
 quote_only=case["expect"] in ("quote","mixed")
 checks={
  "reply_present":bool(reply_s.strip()),"reply_equals_final_response":isinstance(final,str) and reply==final,
  "complete_exact_trace":isinstance(messages,list) and bool(messages) and trace.get("untruncated") is True,
  "raw_staff_responses_present":isinstance(trace,dict) and isinstance(trace.get("staff_http_exchanges"),list) and (not case["prepare_required"] or bool(trace.get("staff_http_exchanges"))),
  "installed_plugin_result_present":isinstance(trace,dict) and isinstance(trace.get("installed_plugin"),dict) and bool(trace["installed_plugin"].get("sha256")),
  "runtime_readback_present":isinstance(trace,dict) and isinstance(trace.get("runtime_readback"),dict),
  "pre_post_state_present":isinstance(pre,dict) and isinstance(post,dict),
  "one_prepare_per_turn":len(prepare)==(2 if case["continuation"] else 1) if case["prepare_required"] else len(prepare)==0,
  "no_hold_or_booking_for_quote":not quote_only or pre.get("booking_count")==post.get("booking_count") and pre.get("hold_count")==post.get("hold_count"),
  "send_suppressed":body.get("external_send_allowed") is False and body.get("staff_alert_allowed") is False,
 }
 if case["expect"]=="uncertain": checks["fault_uncertainty"]=("uncertain" in reply_s.lower() or "cannot verify" in reply_s.lower() or "couldn't verify" in reply_s.lower()) and not any(x.lower() in reply_s.lower() for x in evidence.split() if len(x)>20)
 if case["continuation"]:
  checks["genuine_one_use_continuation"]=isinstance(trace,dict) and trace.get("continuation_consumed") is True
  checks["first_refusal_then_success"]=any(isinstance(x,dict) and x.get("ok") is False for x in tool_results) and any(isinstance(x,dict) and x.get("ok") is True for x in tool_results)
 return checks,[]

def load_owner_fixture(path, expected_sha256):
 expected=str(expected_sha256 or "").strip().lower()
 if not re.fullmatch(r"[0-9a-f]{64}",expected): raise SystemExit("BLOCKED: LUNA_MATRIX_FIXTURE_SHA256 must be a SHA-256 digest")
 try: raw=path.read_bytes()
 except Exception as exc: raise SystemExit(f"BLOCKED: fixture metadata unreadable: {exc}")
 actual=digest_bytes(raw)
 if actual!=expected: raise SystemExit("BLOCKED: fixture metadata SHA-256 mismatch")
 try: fixture=json.loads(raw)
 except Exception as exc: raise SystemExit(f"BLOCKED: fixture metadata unreadable: {exc}")
 return fixture,actual

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
 fixture,fixture_sha256=load_owner_fixture(fixture_path,need("LUNA_MATRIX_FIXTURE_SHA256"))
 cases=make_cases(snapshot,fixture); records=[]; seq=0
 for case in cases:
  if case["expect"]=="n/a": records.append({"case":case,"repetition":None,"verdict":"N/A","reason":"live Staff admission snapshot has no active cell for this kind"}); continue
  for rep in range(1,REPS+1):
   seq+=1; phone=f"+346999{seq:05d}"
   pre_wire=request(base+"/wolfhouse/luna-v3-harness/state",token,trace_token,{"thread":phone})
   state=pre_wire.get("parsed")
   if pre_wire.get("status")!=200 or not valid_state_receipt(state,phone):
    raise SystemExit(f"BLOCKED: valid authenticated pre-state unavailable for {case['id']} repetition {rep}")
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
    correction=case.get("correction_prompt")
    if not isinstance(correction,str) or not correction.strip(): raise SystemExit(f"BLOCKED: continuation correction prompt missing: {case['id']}")
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
 manifest={"schema":"luna-v3-cap-authentic-matrix/v2","candidate_sha":head,"repetitions":REPS,"no_retries":True,"generated_from_staff_admission_revision":snapshot["revision"],"owner_fixture_sha256":fixture_sha256,"owner_fixture_provenance":fixture["owner_provenance"],"cases":cases,"pins":pf.get("pins"),"redacted_settings":redact(settings)}
 result={"schema":"luna-v3-cap-authentic-results/v2","manifest_sha256":digest(manifest),"records":records,"pass":all(r.get("verdict") in ("PASS","N/A") for r in records)}
 (out/"manifest.json").write_bytes(canon(manifest)+b"\n"); (out/"results.json").write_bytes(canon(result)+b"\n")
 files=sorted(p for p in out.rglob("*") if p.is_file()); (out/"SHA256SUMS").write_text("".join(f"{digest_bytes(p.read_bytes())}  {p.relative_to(out)}\n" for p in files))
 print(json.dumps({"output":str(out),"cases":len(cases),"executed":sum(r.get("repetition") is not None for r in records),"pass":result["pass"]}))
 return 0 if result["pass"] else 1
if __name__=="__main__": raise SystemExit(main())
