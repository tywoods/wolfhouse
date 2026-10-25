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
 out=[]
 def add(cid,prompt,expect,choice=None,prepare=True,continuation=False,fault=None):
  out.append({"id":cid,"prompt":prompt,"expect":expect,"choice":choice,"prepare_required":prepare,"continuation":continuation,"fault":fault})
 good=fixture["valid_dates"]; bad=fixture["invalid_dates"]
 gd=f'{good["check_in"]} to {good["check_out"]}'; bd=f'{bad["check_in"]} to {bad["check_out"]}'
 add("stay-only-refusal",f"Quote accommodation only for Alex, one guest, shared room, {bd}. Repeat Staff's exact reason, facts, path and next step if refused.","refusal")
 add("stay-only-success-control",f"Quote accommodation only for Alex, one guest, shared room, {gd}. Do not hold or book.","quote")
 for kind in ("package","rental","service","lesson"):
  rows=by_kind.get(kind,[])
  if not rows: add(f"{kind}-n-a",f"No active {kind} exists in Staff snapshot.","n/a",prepare=False)
  for c in rows:
   label=c.get("label") or c["code"]
   add(f"{kind}-{c['code']}-success",f"Quote active {kind} {label} ({c['code']}) for Alex, {gd}. Use exact Staff amount and terms; do not hold or book.","quote",c)
   add(f"{kind}-{c['code']}-refusal",f"Quote active {kind} {label} ({c['code']}) for Alex, {bd}. Repeat Staff's exact refusal and correction path.","refusal",c)
 add("mixed",f"Quote accommodation and every compatible active package, rental, service and lesson for Alex, {gd}. Preserve exact Staff facts and terms; do not hold or book.","mixed")
 add("multi-guest",f"Quote shared accommodation for Alex, Sam and Jo, {gd}. Preserve exact Staff amounts and terms; do not hold or book.","quote")
 add("genuine-continuation",f"Quote Cap Week for Alex for {bd}. If Staff refuses, explain its exact correction path.","quote",continuation=True)
 for fault in ("non-json","malformed","timeout"): add(f"staff-boundary-{fault}",f"Quote shared accommodation for Alex, {gd}. If Staff cannot verify, clearly state uncertainty and do not invent facts.","uncertain",fault=fault)
 return out

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
   state=request(base+"/wolfhouse/luna-v3-harness/state",token,trace_token,{"thread":phone})["parsed"] or {}
   payload={"thread":phone,"text":case["prompt"],"external_send_allowed":False,"capture_continuation":case["continuation"]}
   wire=request(base+"/wolfhouse/simulate-guest-turn",token,trace_token,payload,fault=case["fault"])
   body=wire["parsed"] or {}
   if case["continuation"] and body.get("continuation_ref"):
    wire=request(base+"/wolfhouse/simulate-guest-turn",token,trace_token,{"thread":phone,"text":f"Correct the dates to {fixture['valid_dates']['check_in']} through {fixture['valid_dates']['check_out']} and quote the same selection.","continuation_ref":body["continuation_ref"],"external_send_allowed":False})
    body=wire["parsed"] or {}
   post=request(base+"/wolfhouse/luna-v3-harness/state",token,trace_token,{"thread":phone})["parsed"] or {}
   checks,fields=judge(case,body,state,post); passed=all(checks.values())
   raw_name=f"raw/{seq:04d}.bin"; (out/raw_name).parent.mkdir(exist_ok=True); (out/raw_name).write_bytes(wire["raw"])
   rec={"case":case,"repetition":rep,"thread":phone,"http":{"status":wire["status"],"elapsed_ms":wire["elapsed_ms"],"transport_error":wire.get("transport_error"),"raw_file":raw_name,"raw_sha256":digest_bytes(wire["raw"])},"response":redact(body),"pre_staff_state":redact(state),"post_staff_state":redact(post),"compared_staff_fields":fields,"checks":checks,"verdict":"PASS" if passed else "FAIL"}; rec["sha256"]=digest(rec); records.append(rec)
 manifest={"schema":"luna-v3-cap-authentic-matrix/v2","candidate_sha":head,"repetitions":REPS,"no_retries":True,"generated_from_staff_admission_revision":snapshot["revision"],"cases":cases,"pins":pf.get("pins"),"redacted_settings":redact(settings)}
 result={"schema":"luna-v3-cap-authentic-results/v2","manifest_sha256":digest(manifest),"records":records,"pass":all(r.get("verdict") in ("PASS","N/A") for r in records)}
 (out/"manifest.json").write_bytes(canon(manifest)+b"\n"); (out/"results.json").write_bytes(canon(result)+b"\n")
 files=sorted(p for p in out.rglob("*") if p.is_file()); (out/"SHA256SUMS").write_text("".join(f"{digest_bytes(p.read_bytes())}  {p.relative_to(out)}\n" for p in files))
 print(json.dumps({"output":str(out),"cases":len(cases),"executed":sum(r.get("repetition") is not None for r in records),"pass":result["pass"]}))
 return 0 if result["pass"] else 1
if __name__=="__main__": raise SystemExit(main())
