#!/usr/bin/env python3
"""Deterministic integrity/shape audit for REPAIR4; no imports or network."""
import hashlib, json, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/"artifacts/sim15-season-oneq-repair4"
R=json.loads((OUT/"replay-receipt.json").read_text())
BASE=R["baseline_ref"]; CAND=R["candidate_head"]
paths={"plugin":"docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py","personality":"docker/hermes-staging/wolfhouse/luna_personality.py","soul":"docker/hermes-staging/SOUL.md"}
def git_bytes(ref,path):
 return subprocess.run(["git","show",f"{ref}:{path}"],cwd=ROOT,check=True,stdout=subprocess.PIPE).stdout
def sha(b): return hashlib.sha256(b).hexdigest()
assert R["repair3_mixed_context_diagnostic"]["sha256"]==sha((ROOT/R["repair3_mixed_context_diagnostic"]["path"]).read_bytes())
checks=[]
for run in R["runs"]:
 ref=BASE if run["variant"]=="baseline" else CAND
 assert run["ref"]==ref
 for key,path in paths.items():
  assert run["consumed_module_paths"][key].endswith(path)
  assert run["consumed_module_sha256"][key]==sha(git_bytes(ref,path))
 msgs=run["message_history"]
 assert msgs[0]["role"]=="user" and msgs[1]["role"]=="assistant" and msgs[1]["tool_calls"]
 tools=msgs[2:]; assert tools and all(m["role"]=="tool" and m.get("tool_call_id") for m in tools)
 declared=[c["id"] for c in msgs[1]["tool_calls"]]; returned=[m["tool_call_id"] for m in tools]
 assert declared==returned
 params={o["tool_call_id"]:o["params"] for o in run["actual_callback_outputs"]}
 assert all(json.loads(c["function"]["arguments"])==params[c["id"]] for c in msgs[1]["tool_calls"])
 assert all(isinstance(json.loads(m["content"]),dict) for m in tools)
 outputs={o["tool_call_id"]:o["actual_callback_output"] for o in run["actual_callback_outputs"]}
 assert all(json.loads(m["content"])==outputs[m["tool_call_id"]] for m in tools)
 if "pricing_unavailable" in run["case"]:
  price=next(o["actual_callback_output"] for o in run["actual_callback_outputs"] if o["tool"]=="preview_package_prices")
  avail=next(o["actual_callback_output"] for o in run["actual_callback_outputs"] if o["tool"]=="check_availability")
  assert price["success"] is False and price["next_action"]=="offer_accommodation_or_change_dates"
  assert "dates_approved" not in price and "accommodation_only_available" not in price
  assert avail["success"] is True and avail["availability_status"]=="available"
 if run["case"]=="genuine_closure":
  close=next(o["actual_callback_output"] for o in run["actual_callback_outputs"] if o["tool"]=="quote_booking")
  assert close["success"] is False and close["quote_status"]=="closed_season"
  assert close["guest_safe_next_action"]=="We’re closed for those dates."
 if run["case"]=="missing_date_authority": assert len(run["actual_callback_outputs"])==1
 checks.append({"variant":run["variant"],"case":run["case"],"pass":True})
a=json.loads((OUT/"replay-assessment.json").read_text())
failed=next(x for x in a["runs"] if x["variant"]=="baseline" and x["case"]=="g3_failed_preview")
assert failed["criteria"]["one_question"]["pass"] is False
for x in a["runs"]:
 if x["variant"]=="candidate": assert x["criteria"]["one_question"]["pass"] is True
 assert x["criteria"]["room_choice_first_with_sister_night_deferred"]["pass"] is False
result={"schema":"sim15-repair4-audit-v1","passed":len(checks),"failed":0,"checks":checks,"boundary":"offline; no Staff/model network, sends, writes, deploys, restarts, or config"}
(OUT/"audit-result.json").write_text(json.dumps(result,indent=2)+"\n")
print(json.dumps({"verdict":"PASS","checks":len(checks),"result":str((OUT/"audit-result.json").relative_to(ROOT))}))
