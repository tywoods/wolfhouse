#!/usr/bin/env python3
"""Authentic rendered-reply evidence runner. Never substitutes/replays model output."""
from __future__ import annotations
import hashlib, json, os, pathlib, subprocess, sys, urllib.request, uuid

REPS = 3
EXPECTED_MODEL = "gpt-6.1-sol"
EXPECTED_PROVIDER = "openai-codex"

def need(name):
    value=os.environ.get(name,"").strip()
    if not value: raise SystemExit(f"BLOCKED: {name} is required")
    return value

def canonical(x): return json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
def sha(x): return hashlib.sha256(canonical(x)).hexdigest()

def cases(inv):
    out=[{"id":"stay-refusal","prompt":"Quote a one-night accommodation-only stay for Alex, 1 guest, shared room, 1-2 July 2027. Give the exact Staff reason if unavailable.","expect":"refusal"},
         {"id":"stay-control","prompt":"Quote an accommodation-only stay for Alex, 1 guest, shared room, 1-8 July 2027.","expect":"quote"},
         {"id":"mixed","prompt":"Quote Alex and Sam, shared accommodation 1-8 July 2027, plus each currently active add-on once. If Staff refuses anything, explain its exact reason.","expect":"mixed"},
         {"id":"multi-guest","prompt":"Quote shared accommodation for Alex, Sam and Jo from 1-8 July 2027. State only verified Staff facts.","expect":"quote"}]
    for kind in ("packages","add_ons","lesson_kinds"):
        for row in inv.get(kind,[]):
            code=row["code"] if isinstance(row,dict) else str(row)
            label=row.get("label",code) if isinstance(row,dict) else code
            out += [
              {"id":f"{kind}-{code}-refusal","prompt":f"Quote {label} ({code}) for Alex for 1-2 July 2027. If Staff refuses, state its exact reason.","expect":"refusal"},
              {"id":f"{kind}-{code}-control","prompt":f"Quote {label} ({code}) for Alex for 1-8 July 2027 with all required details. State only verified Staff facts.","expect":"quote"}]
    for fault in ("non-json","malformed","timeout"):
        out.append({"id":f"transport-{fault}","prompt":"Check and quote shared accommodation for Alex from 1-8 July 2027. If Staff cannot verify it, clearly say the outcome is uncertain.","expect":"uncertain","fault":fault})
    return out

def post(url, token, trace_token, payload, fault=None):
    headers={"Authorization":f"Bearer {token}","Content-Type":"application/json","X-Luna-V3-Harness-Trace":trace_token}
    if fault: headers["X-Luna-V3-Harness-Fault"]=fault
    req=urllib.request.Request(url.rstrip("/")+"/wolfhouse/simulate-guest-turn",canonical(payload),headers,method="POST")
    with urllib.request.urlopen(req,timeout=180) as r: return json.loads(r.read())

def verdict(case, body):
    reply=str(body.get("reply_text","")).strip(); calls=body.get("tool_calls",[]); trace=body.get("harness_trace")
    prepares=sum(1 for c in calls if c.get("name")=="check_quote_book" and c.get("args",{}).get("action")=="prepare")
    internal=any(x in reply.lower() for x in ("stack trace","tool_call","internal server","correlation_id"))
    question_count=reply.count("?")
    uncertain=("uncertain" in reply.lower() or "couldn't verify" in reply.lower() or "cannot verify" in reply.lower())
    checks={"reply_present":bool(reply),"full_trace_present":isinstance(trace,dict),"prepare_at_most_one":prepares<=1,
            "needed_questions_at_most_one":question_count<=1,"no_internal_leakage":not internal,
            "fault_uncertainty":case.get("expect")!="uncertain" or uncertain,
            "send_suppressed":body.get("external_send_allowed") is False and body.get("staff_alert_allowed") is False}
    return checks, all(checks.values())

def main():
    root=pathlib.Path(__file__).resolve().parents[1]; head=subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()
    pinned=need("LUNA_MATRIX_CANDIDATE_SHA")
    if head!=pinned: raise SystemExit(f"BLOCKED: checkout {head} != pinned {pinned}")
    settings={"provider":need("HERMES_MODEL_PROVIDER"),"model":need("HERMES_MODEL"),"reasoning":need("HERMES_REASONING_EFFORT"),
              "temperature":os.environ.get("HERMES_TEMPERATURE","provider-default"),"fallback":os.environ.get("HERMES_FALLBACK_MODEL","")}
    if settings!={"provider":EXPECTED_PROVIDER,"model":EXPECTED_MODEL,"reasoning":"low","temperature":"provider-default","fallback":""}:
        raise SystemExit(f"BLOCKED: effective model settings mismatch: {settings}")
    inventory=json.loads(pathlib.Path(need("LUNA_MATRIX_INVENTORY")).read_text())
    manifest=cases(inventory); base=need("LUNA_MATRIX_SIMULATOR_URL"); token=need("LUNA_MATRIX_SIMULATOR_TOKEN"); trace=need("LUNA_V3_HARNESS_TRACE_TOKEN")
    output=pathlib.Path(os.environ.get("LUNA_MATRIX_OUTPUT","artifacts/rendered-reply-matrix")); output.mkdir(parents=True,exist_ok=False)
    records=[]
    # Exactly one attempt for each repetition; fresh reserved phone means fresh TEST session.
    sequence=0
    for case in manifest:
      for rep in range(1,REPS+1):
        sequence+=1; phone=f"+346999{sequence:05d}"
        body=post(base,token,trace,{"thread":phone,"text":case["prompt"],"external_send_allowed":False},case.get("fault"))
        checks,passed=verdict(case,body); record={"case":case,"repetition":rep,"phone":phone,"response":body,"checks":checks,"pass":passed}
        record["sha256"]=sha(record); records.append(record)
    result={"schema":1,"candidate_sha":head,"settings":settings,"inventory":inventory,"manifest":manifest,"repetitions":REPS,"records":records}
    result["pass"]=all(x["pass"] for x in records); (output/"matrix.json").write_bytes(canonical(result)+b"\n")
    (output/"SHA256SUMS").write_text(f'{hashlib.sha256((output/"matrix.json").read_bytes()).hexdigest()}  matrix.json\n')
    print(json.dumps({"output":str(output),"cases":len(manifest),"runs":len(records),"pass":result["pass"]}))
    return 0 if result["pass"] else 1
if __name__=="__main__": raise SystemExit(main())
