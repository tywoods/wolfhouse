#!/usr/bin/env python3
"""Cap authentic rendered-reply matrix.

This runner has no fixture/model-output mode. Inventory and expected facts are obtained
from authenticated Staff admission, every case gets three fresh TEST sessions, and any
missing evidence fails closed. HTTP bytes are retained before parsing.
"""
from __future__ import annotations
import datetime, hashlib, json, os, pathlib, re, subprocess, sys, time, urllib.error, urllib.request

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent / "lib"))
from luna_v3_receipt_binding import boundary_consistent as _boundary_consistent, valid_staff_exchange as _valid_staff_exchange
from luna_v3_rendered_claims import reply_truth

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

def owner_normalize(request_value,choices):
 """Execute Staff's ONE exported normalizer; never duplicate it in Python."""
 cli=pathlib.Path(__file__).resolve().parent/'lib/model-led-luna/staff-request-normalize-cli.js'
 payload={"command":"normalize","input":request_value,"choices":choices,"turn_id":"matrix-control"}
 try:
  run=subprocess.run(["node",str(cli)],input=canon(payload),capture_output=True,check=True)
  return json.loads(run.stdout)
 except (OSError,subprocess.CalledProcessError,json.JSONDecodeError) as exc:
  raise SystemExit(f"BLOCKED: Staff request normalizer unavailable: {exc}")

class OwnerExecutionAdapter:
 """Admission-only verifier. It cannot mint or re-sign fixture evidence."""
 def __init__(self,verifier_key=None):
  cli=pathlib.Path(__file__).resolve().parent/'lib/model-led-luna/staff-request-normalize-cli.js'
  key=verifier_key or os.environ.get("LUNA_OWNER_RECEIPT_VERIFIER_KEY","")
  if len(key)<32: raise SystemExit("BLOCKED: LUNA_OWNER_RECEIPT_VERIFIER_KEY is required")
  env={**os.environ,"LUNA_OWNER_RECEIPT_VERIFIER_KEY":key}; env.pop("LUNA_OWNER_RECEIPT_ISSUER_KEY",None)
  self.proc=subprocess.Popen(["node",str(cli),"--server"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1,env=env)
 def call(self,payload):
  if self.proc.poll() is not None: raise SystemExit("BLOCKED: owner execution adapter exited")
  self.proc.stdin.write(json.dumps(payload,separators=(",",":"),ensure_ascii=False)+"\n"); self.proc.stdin.flush()
  line=self.proc.stdout.readline()
  try: return json.loads(line)
  except json.JSONDecodeError: raise SystemExit("BLOCKED: invalid owner execution adapter response")
 def admit(self,case,revision,choices,input_value):
  proposition={"revision":revision,"case_id":case.get("id"),"category":case.get("category"),"fault":case.get("fault"),"prompt":case.get("prompt"),"control":case.get("control"),"outcome":case.get("intended_owner_outcome"),"correction_prompt":case.get("correction_prompt"),"corrected_control":case.get("corrected_control"),"corrected_outcome":case.get("corrected_owner_outcome"),"input":input_value,"choices":choices,"turn_id":"fixture-admission"}
  receipt=case.get("owner_execution_receipt")
  if not isinstance(receipt,dict): raise SystemExit(f"BLOCKED: owner execution receipt missing: {case.get('id')}")
  verified=self.call({"command":"verify","receipt":receipt,**proposition})
  if verified.get("ok") is not True: raise SystemExit(f"BLOCKED: owner execution receipt rejected: {case.get('id')} ({verified.get('code')})")
  admitted=verified.get("result")
  if not isinstance(admitted,dict): raise SystemExit("BLOCKED: owner normalization missing from verified HTTP receipt")
  return {**admitted,"_corrected_owner_result":verified.get("corrected_result"),
          "_owner_response":verified.get("owner_response"),"_owner_provenance":verified.get("provenance"),
          "_baseline_outcome":verified.get("baseline_outcome")}
 def close(self):
  if self.proc.poll() is None: self.proc.terminate(); self.proc.wait(timeout=5)
  if self.proc.stdin: self.proc.stdin.close()
  if self.proc.stdout: self.proc.stdout.close()
 def __del__(self):
  try: self.close()
  except Exception: pass

def _public_prepare(control):
 value=json.loads(json.dumps(control)); value={"action":"prepare","purpose":"quote",**value}
 if isinstance(value.get("package"),str): value["package"]={"code":value["package"]}
 return value

def _normalized_prepare(value,choices):
 result=owner_normalize(value,choices)
 if not isinstance(result,dict) or result.get("ok") is not True or not isinstance(result.get("value"),dict): return None
 normalized=json.loads(json.dumps(result["value"])); normalized.pop("operation_key",None)
 # These owner fields are sets of selections, not an execution sequence.
 # Guest positions and explicit beds deliberately retain their owner ordering.
 for addon in normalized.get("add_ons",[]):
  for field in ("dates","requested_dates","people","participants"):
   if isinstance(addon.get(field),list): addon[field]=sorted(addon[field])
 if isinstance(normalized.get("add_ons"),list): normalized["add_ons"].sort(key=canon)
 return normalized
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

def _sha256_json(value): return digest(value)
def _valid_sha256(value): return isinstance(value,str) and re.fullmatch(r"[0-9a-f]{64}",value) is not None

def _owner_canary_valid(case,revision):
 canary=case.get("owner_canary")
 if not isinstance(canary,dict) or set(canary)!={"receipt_id","executed_at","capability_revision","prompt_sha256","correction_prompt_sha256","control_sha256","outcome_sha256","corrected_control_sha256","corrected_outcome_sha256"}: return False
 if not isinstance(canary.get("receipt_id"),str) or not canary["receipt_id"].strip() or canary.get("capability_revision")!=revision: return False
 try: datetime.datetime.fromisoformat(canary.get("executed_at","").replace("Z","+00:00"))
 except (TypeError,ValueError): return False
 expected={"prompt_sha256":digest_bytes(case.get("prompt","").encode()),"correction_prompt_sha256":digest_bytes(str(case.get("correction_prompt") or "").encode()),"control_sha256":_sha256_json(case.get("control")),"outcome_sha256":_sha256_json(case.get("intended_owner_outcome")),"corrected_control_sha256":_sha256_json(case.get("corrected_control")),"corrected_outcome_sha256":_sha256_json(case.get("corrected_owner_outcome"))}
 return all(_valid_sha256(canary.get(k)) and canary[k]==v for k,v in expected.items())

def _selection_kinds(control,active):
 package=control.get("package") if isinstance(control,dict) else None
 package_codes=[package] if isinstance(package,str) else [p.get("code") or p.get("name") for p in package.get("per_guest",[]) if isinstance(p,dict)] if isinstance(package,dict) else []
 addon_codes=[a.get("code") or a.get("name") for a in control.get("add_ons",[]) if isinstance(a,dict)] if isinstance(control,dict) else []
 return [active.get(code,{}).get("kind") for code in package_codes],[active.get(code,{}).get("kind") for code in addon_codes],addon_codes

def _category_matches_selection(category,control,choices):
 active={c.get("code"):c for c in choices if isinstance(c,dict) and c.get("active") is True}
 package_kinds,addon_kinds,_=_selection_kinds(control,active)
 if category=="accommodation": return package_kinds and set(package_kinds)=={"accommodation"} and not addon_kinds
 if category=="package": return "package" in package_kinds and not addon_kinds
 if category=="rental": return package_kinds and set(package_kinds)=={"accommodation"} and bool(addon_kinds) and set(addon_kinds)=={"rental"}
 if category.startswith("service:"): return package_kinds and set(package_kinds)=={"accommodation"} and bool(addon_kinds) and set(addon_kinds)=={"service"}
 if category=="mixed": return "package" in package_kinds and "rental" in addon_kinds and "service" in addon_kinds
 return True

def _is_lesson_code(code,choices):
 row=next((x for x in choices if isinstance(x,dict) and x.get('code')==code and x.get('active') is True),{})
 metadata=row.get('metadata') if isinstance(row.get('metadata'),dict) else {}
 subtype=str(metadata.get('service_type') or metadata.get('subtype') or '').lower()
 return row.get('kind')=='lesson' or subtype in {'lesson','surf_lesson'} or 'lesson' in str(row.get('code','')).lower()

def make_cases(snapshot,fixture,owner_adapter=None):
 """Admit only real-owner receipts; always retire the verifier child."""
 adapter=owner_adapter or OwnerExecutionAdapter()
 try: return _make_cases(snapshot,fixture,adapter)
 finally:
  if owner_adapter is None: adapter.close()

def _make_cases(snapshot,fixture,owner_adapter):
 """Fail closed unless cases are explicitly authored and proven by the Staff owner."""
 choices=snapshot.get("choices") if isinstance(snapshot,dict) else None
 if not isinstance(snapshot,dict) or snapshot.get("ok") is not True or not snapshot.get("revision") or not isinstance(choices,list): raise SystemExit("BLOCKED: malformed live Staff capability snapshot")
 # Actual Staff admission nests activity under configuration. Preserve every
 # catalog fact in the signed comparison, adding only its documented projection.
 choices=[{**c,"active":c["configuration"].get("active") is True if isinstance(c.get("configuration"),dict) else c.get("active") is True} for c in choices if isinstance(c,dict)]
 if not isinstance(fixture,dict) or fixture.get("schema")!="luna-matrix-fixture/v2" or fixture.get("tenant")!="wolfhouse-somo": raise SystemExit("BLOCKED: malformed fixture schema")
 owner=fixture.get("owner_provenance")
 if not isinstance(owner,dict) or owner.get("authority")!="staff-owner" or not all(isinstance(owner.get(k),str) and owner[k].strip() for k in ("fixture_id","approved_by","approved_at","owner_revision_or_receipt_id")): raise SystemExit("BLOCKED: fixture lacks owner provenance")
 if fixture.get("capability_revision")!=snapshot["revision"]: raise SystemExit("BLOCKED: fixture capability revision mismatch")
 if not isinstance(fixture.get("unsupported_declaration"),dict) or fixture["unsupported_declaration"].get("standalone") is not True or not isinstance(fixture["unsupported_declaration"].get("policy"),str): raise SystemExit("BLOCKED: fixture lacks standalone unsupported declaration")
 cases=fixture.get("cases"); allowed={"accommodation","package","rental","service:lesson_a","service:lesson_b","mixed","multi_guest","continuation","clarification","fault"}
 if not isinstance(cases,list) or not cases: raise SystemExit("BLOCKED: fixture has no explicit cases")
 ids=set(); categories=set(); out=[]; adapter=owner_adapter or OwnerExecutionAdapter()
 for source in cases:
  if not isinstance(source,dict): raise SystemExit("BLOCKED: malformed fixture case")
  case=json.loads(json.dumps(source)); cid=case.get("id"); category=case.get("category"); outcome=case.get("intended_owner_outcome")
  if not isinstance(cid,str) or not cid.strip() or cid in ids or category not in allowed or not isinstance(case.get("prompt"),str) or not case["prompt"].strip() or not isinstance(outcome,dict): raise SystemExit("BLOCKED: malformed explicit fixture case")
  ids.add(cid); categories.add(category); case["prepare_required"]=category!="clarification"; case["continuation"]=category=="continuation"; case["expect"]=outcome.get("expect")
  # Bind closed-world product-claim checks to the same owner admission snapshot.
  # Labels are presentation aliases for codes, never independent model facts.
  case["_catalog_claim_terms"]=[{"code":c.get("code"),"terms":sorted({str(c.get("code") or "").lower(),str(c.get("label") or "").lower(),str(c.get("name") or "").lower()}-{""})} for c in choices if isinstance(c,dict) and isinstance(c.get("code"),str)]
  if case["expect"] not in {"quote","mixed","refusal","clarification","uncertain"} or not validate_outcome(outcome,control=case.get("control")): raise SystemExit(f"BLOCKED: invalid intended owner outcome: {cid}")
  if category=="fault" and case.get("fault") not in {"non-json","malformed","http-422","exception","timeout"}: raise SystemExit(f"BLOCKED: invalid fault case: {cid}")
  if category=="mixed" and outcome.get("compatibility_proven") is not True: raise SystemExit("BLOCKED: mixed case lacks owner compatibility proof")
  if category=="clarification" and case["expect"]!="clarification": raise SystemExit("BLOCKED: clarification outcome mismatch")
  if category=="fault" and case["expect"]!="uncertain": raise SystemExit("BLOCKED: fault outcome mismatch")
  # Even zero-tool clarification needs real owner evidence for missing input.
  control_request=_public_prepare(case.get("control",{}))
  owner_result=adapter.admit(case,snapshot["revision"],choices,control_request)
  normalized=json.loads(json.dumps(owner_result.get("value"))) if owner_result.get("ok") is True and isinstance(owner_result.get("value"),dict) else None
  if normalized is not None: normalized.pop("operation_key",None)
  baseline=owner_result.get("_baseline_outcome") or {}
  if case["expect"]=="refusal":
   # A real refusal may be precisely a request the normalizer rejects. Do not
   # require successful normalization (nor manufacture a refusal from it).
   if baseline.get("expect")!="refusal": raise SystemExit(f"BLOCKED: refusal lacks owner HTTP refusal: {cid}")
  elif category!="clarification":
   if not validate_control(case,choices) or normalized is None: raise SystemExit(f"BLOCKED: owner-invalid complete control: {cid}")
  if not _category_matches_selection(category,case.get("control"),choices): raise SystemExit(f"BLOCKED: owner control category mismatch: {cid}")
  case["_owner_normalized_control"]=normalized; case["_owner_choices"]=choices
  case["_owner_http_provenance"]=owner_result.get("_owner_provenance")
  if case["continuation"]:
   corrected_result=owner_result.get("_corrected_owner_result") if isinstance(owner_result,dict) else None
   if (not isinstance(case.get("correction_prompt"),str) or not case["correction_prompt"].strip() or not validate_control({"control":case.get("corrected_control")},choices) or not validate_outcome(case.get("corrected_owner_outcome"),success_only=True,control=case.get("corrected_control")) or not isinstance(corrected_result,dict) or corrected_result.get("ok") is not True): raise SystemExit(f"BLOCKED: continuation lacks independently executed corrected control/outcome: {cid}")

  out.append(case)
 required=set(allowed)
 if not required.issubset(categories): raise SystemExit(f"BLOCKED: fixture coverage missing: {sorted(required-categories)}")
 for category in ("accommodation","package","rental","service:lesson_a","service:lesson_b","mixed","multi_guest"):
  if not any(c["category"]==category and c["expect"] in {"quote","mixed"} for c in out): raise SystemExit(f"BLOCKED: successful coverage missing: {category}")
 if not any(c["expect"]=="refusal" for c in out): raise SystemExit("BLOCKED: genuine refusal coverage missing")
 faults=[c.get("fault") for c in out if c["category"]=="fault"]
 required_faults={"non-json","malformed","http-422","exception","timeout"}
 if set(faults)!=required_faults or len(faults)!=len(required_faults): raise SystemExit("BLOCKED: fixture must cover each distinct fault mode exactly once")
 lesson_codes=[]
 for category in ("service:lesson_a","service:lesson_b"):
  lesson=next(c for c in out if c["category"]==category)
  active={c.get("code"):c for c in choices if isinstance(c,dict) and c.get("active") is True}
  _pk,_ak,codes=_selection_kinds(lesson["control"],active); lesson_codes.append(tuple(sorted(code for code in codes if _is_lesson_code(code,choices))))
 if not all(lesson_codes) or lesson_codes[0]==lesson_codes[1]: raise SystemExit("BLOCKED: lesson categories do not prove distinct owner products")
 group=next(c for c in out if c["category"]=="multi_guest")["control"]; package=group.get("package")
 packages=package.get("per_guest") if isinstance(package,dict) else None
 addon_assignments={(a.get("code") or a.get("name"),tuple(sorted(a.get("people",[])))) for a in group.get("add_ons",[]) if isinstance(a,dict)}
 normalized_group=next(c for c in out if c["category"]=="multi_guest").get("_owner_normalized_control",{})
 normalized_codes={p.get("package_code") for p in normalized_group.get("guest_packages",[]) if isinstance(p,dict)}
 if not isinstance(packages,list) or len(packages)!=len(group["guests"]) or len(normalized_codes)<2 or len(addon_assignments)<2 or len({people for _,people in addon_assignments})<2: raise SystemExit("BLOCKED: multi-guest case lacks differentiated normalized per-guest package/add-on codes")
 if owner_adapter is None: adapter.close()
 return out

def _iso_date(value):
 try: return datetime.date.fromisoformat(value) if isinstance(value,str) else None
 except ValueError: return None

def _code(value):
 if isinstance(value,str): return value
 if isinstance(value,dict): return value.get("code") or value.get("name")
 return None

def canonical_package(value,guests=None):
 if isinstance(value,str) and value: return {"code":value}
 if isinstance(value,dict) and _code(value) and "per_guest" not in value: return {"code":_code(value)}
 bindings=value.get("per_guest") if isinstance(value,dict) else None
 if not isinstance(bindings,list) or not bindings: return None
 out=[]
 for row in bindings:
  if not isinstance(row,dict) or not isinstance(_code(row),str): return None
  index=row.get("guest",row.get("guest_index",row.get("guestIndex")))
  name=row.get("guest_name",row.get("guestName"))
  if isinstance(index,str) and index.isdigit(): index=int(index)
  if name is None and isinstance(index,int) and isinstance(guests,list) and 1<=index<=len(guests): name=guests[index-1].get("name")
  if index is None and isinstance(name,str) and isinstance(guests,list):
   matches=[i+1 for i,g in enumerate(guests) if g.get("name")==name]; index=matches[0] if len(matches)==1 else None
  if type(index) is not int or not isinstance(name,str) or not name: return None
  out.append({"guest":index,"name":name,"code":_code(row)})
 out.sort(key=lambda x:x["guest"])
 return {"per_guest":out}

def canonical_add_ons(value):
 if not isinstance(value,list): return None
 out=[]
 for row in value:
  if not isinstance(row,dict) or not isinstance(_code(row),str) or type(row.get("quantity")) is not int or row["quantity"]<1: return None
  dates=row.get("dates",row.get("requested_dates",row.get("requestedDates",[]))); people=row.get("people",row.get("participants",[]))
  if not isinstance(dates,list) or not isinstance(people,list) or any(_iso_date(x) is None for x in dates) or any(not isinstance(x,str) or not x for x in people): return None
  item={"code":_code(row),"quantity":row["quantity"],"dates":sorted(dates),"people":sorted(people)}
  if "days" in row:
   if type(row["days"]) is not int or row["days"]<1: return None
   item["days"]=row["days"]
  out.append(item)
 return sorted(out,key=lambda x:(x["code"],x["quantity"],x["dates"],x["people"],x.get("days",0)))

def validate_outcome(outcome,success_only=False,control=None):
 if not isinstance(outcome,dict): return False
 expect=outcome.get("expect")
 if success_only and expect not in ("quote","mixed"): return False
 if expect in ("quote","mixed"):
  facts=outcome.get("facts"); required={"currency","total_cents","deposit_cents","remaining_cents","check_in","check_out","package","add_ons","inclusions","terms"}
  valid=isinstance(facts,dict) and set(facts)==required and isinstance(facts["currency"],str) and bool(facts["currency"]) and all(type(facts[k]) is int and facts[k]>=0 for k in ("total_cents","deposit_cents","remaining_cents")) and facts["total_cents"]==facts["deposit_cents"]+facts["remaining_cents"] and _iso_date(facts["check_in"]) is not None and _iso_date(facts["check_out"]) is not None and facts["check_out"]>facts["check_in"] and canonical_package(facts["package"],control.get("guests") if isinstance(control,dict) else None) is not None and canonical_add_ons(facts["add_ons"]) is not None and all(isinstance(facts[k],list) and all(isinstance(x,str) and x for x in facts[k]) for k in ("inclusions","terms"))
  if not valid or control is None: return valid
  guests=control.get("guests") or []
  expected_package=canonical_package(control.get("package"),guests); actual_package=canonical_package(facts["package"],guests)
  if len(guests)>1 and isinstance(expected_package,dict) and "per_guest" in expected_package and "per_guest" not in actual_package: return False
  return facts["check_in"]==control.get("check_in") and facts["check_out"]==control.get("check_out") and expected_package==actual_package and canonical_add_ons(control.get("add_ons"))==canonical_add_ons(facts["add_ons"])
 if expect=="refusal":
  return isinstance(outcome.get("classification"),str) and bool(outcome["classification"]) and isinstance(outcome.get("allowed_reasons"),list) and bool(outcome["allowed_reasons"]) and all(isinstance(x,str) and x for x in outcome["allowed_reasons"]) and ("next_step" not in outcome or isinstance(outcome["next_step"],str))
 return expect in ("clarification","uncertain") and set(outcome).issubset({"expect"})

def validate_control(case,choices):
 control=case.get("control")
 if not isinstance(control,dict) or set(control)!={"check_in","check_out","guests","room","package","add_ons"} or not isinstance(control.get("add_ons"),list): return False
 check_in=_iso_date(control.get("check_in")); check_out=_iso_date(control.get("check_out")); guests=control.get("guests"); room=control.get("room")
 if not check_in or not check_out or check_out<=check_in or not isinstance(guests,list) or not guests or any(not isinstance(g,dict) or not set(g).issubset({"name","explicit_gender","gender"}) or not isinstance(g.get("name"),str) or not g["name"].strip() or any(not isinstance(v,str) or not v for v in g.values()) for g in guests): return False
 names=[g["name"] for g in guests]
 if len(names)!=len(set(names)) or not isinstance(room,dict) or set(room)-{"kind","name","beds","together"} or room.get("kind") not in {"exact","private","shared","women_only","auto"}: return False
 if "name" in room and (not isinstance(room["name"],str) or not room["name"]): return False
 if "beds" in room and (not isinstance(room["beds"],list) or len(room["beds"])!=len(set(room["beds"])) or any(not isinstance(x,str) or not x for x in room["beds"])): return False
 if "together" in room and room["together"] not in {"required","preferred","not_required"}: return False
 active={c.get("code"):c for c in choices if isinstance(c,dict) and c.get("active") is True}
 package=control["package"]
 package_codes=[package] if isinstance(package,str) else [p.get("code") or p.get("name") for p in package.get("per_guest",[]) if isinstance(p,dict)] if isinstance(package,dict) else []
 if isinstance(package,dict):
  bindings=package.get("per_guest")
  if not isinstance(bindings,list) or len(bindings)!=len(guests) or {p.get("guest") for p in bindings if isinstance(p,dict)}!=set(range(1,len(guests)+1)) or any(not isinstance(p,dict) or set(p)-{"guest","code","name"} or bool(p.get("code"))==bool(p.get("name")) for p in bindings): return False
 if not package_codes or any(code not in active or active[code].get("kind") not in ("package","accommodation") for code in package_codes): return False
 for addon in control["add_ons"]:
  if not isinstance(addon,dict) or set(addon)-{"code","name","quantity","days","people","dates","requested_dates"} or bool(addon.get("code"))==bool(addon.get("name")) or (addon.get("code") or addon.get("name")) not in active or type(addon.get("quantity")) is not int or addon["quantity"]<1: return False
  addon_code=addon.get("code") or addon.get("name"); people=addon.get("people",[]); dates=addon.get("dates",addon.get("requested_dates",[]))
  if people and (not isinstance(people,list) or len(people)!=len(set(people)) or any(not isinstance(x,str) or not x for x in people)): return False
  if dates and (not isinstance(dates,list) or len(dates)!=len(set(dates)) or any(_iso_date(x) is None for x in dates)): return False
  if "days" in addon and (type(addon["days"]) is not int or addon["days"]<1 or addon["days"]!=len(dates)): return False
  requirements=active[addon_code].get("requirements") or {}
  if requirements.get("dates") and not dates: return False
  if requirements.get("participants") and not people: return False
  if any(person not in names for person in people): return False
  if any(date<control["check_in"] or date>=control["check_out"] for date in dates): return False
 return True

def control_matches_prepare(control,args,choices=None):
 if not isinstance(control,dict) or not isinstance(args,dict): return False
 # Transaction intent is part of equivalence and must not be erased by the
 # downstream owner normalization projection.
 if args.get('action')!='prepare' or args.get('purpose')!='quote' or 'payment' in args or args.get('room')!=control.get('room'): return False
 if choices is not None:
  expected=_normalized_prepare(_public_prepare(control),choices)
  actual=_normalized_prepare(args,choices)
  if expected is not None: return expected==actual
  if actual is not None: return False
  # Both refused normalization: compare the complete requested operation, not
  # just equal error codes. Refused quantities must not be repaired by grading.
  if set(args)-set(control)-{"action","purpose"}: return False
 if args.get("action")!="prepare" or args.get("purpose")!="quote" or "payment" in args: return False
 if any(args.get(k)!=control.get(k) for k in ("check_in","check_out")): return False
 guest_rows=args.get("guests") or []; expected_guests=control.get("guests") or []
 def canonical_guest(row):
  if isinstance(row,str): return {"name":row}
  if not isinstance(row,dict) or not isinstance(row.get("name"),str): return None
  normalized=json.loads(json.dumps(row))
  if "explicit_gender" not in normalized and "gender" in normalized: normalized["explicit_gender"]=normalized["gender"]
  normalized.pop("gender",None)
  return normalized
 if [canonical_guest(g) for g in guest_rows]!=[canonical_guest(g) for g in expected_guests]: return False
 if args.get("room")!=control.get("room"): return False
 def canonical_package(value):
  if isinstance(value,str): return {"code":value}
  if not isinstance(value,dict): return None
  normalized=json.loads(json.dumps(value))
  if "per_guest" in normalized:
   bindings=[]
   for binding in normalized["per_guest"]:
    if not isinstance(binding,dict): return None
    row=dict(binding); code=row.pop("code",None) or row.pop("name",None); row.pop("name",None); row["code"]=code; bindings.append(row)
   normalized["per_guest"]=sorted(bindings,key=lambda row:row.get("guest",0))
  else:
   code=normalized.pop("code",None) or normalized.pop("name",None); normalized.pop("name",None); normalized["code"]=code
  return normalized
 if canonical_package(args.get("package"))!=canonical_package(control.get("package")): return False
 def canonical_addon(row):
  if not isinstance(row,dict): return None
  normalized=json.loads(json.dumps(row)); code=normalized.pop("code",None) or normalized.pop("name",None)
  normalized.pop("name",None); normalized["code"]=code
  dates=normalized.pop("dates",None)
  requested=normalized.pop("requested_dates",None)
  if dates is not None and requested is not None and sorted(dates)!=sorted(requested): return None
  if dates is not None or requested is not None:
   selected_dates=dates if dates is not None else requested
   normalized["dates"]=sorted(selected_dates or [])
  if "people" in normalized: normalized["people"]=sorted(normalized["people"])
  return normalized
 actual_addons=[canonical_addon(x) for x in args.get("add_ons") or []]; expected_addons=[canonical_addon(x) for x in control.get("add_ons") or []]
 return None not in actual_addons and None not in expected_addons and sorted(json.dumps(x,sort_keys=True,separators=(',',':')) for x in actual_addons)==sorted(json.dumps(x,sort_keys=True,separators=(',',':')) for x in expected_addons)

STATE_FIELDS={"booking_count","hold_count","payment_count","external_send_count","staff_alert_count"}
def valid_state_receipt(value,thread):
 return isinstance(value,dict) and value.get("ok") is True and value.get("schema")=="luna-v3-test-state/v1" and value.get("authenticated") is True and value.get("tenant")=="wolfhouse-somo" and value.get("thread")==thread and all(type(value.get(k)) is int and value[k]>=0 for k in STATE_FIELDS)

def _field(row,*names):
 for name in names:
  if name in row: return row[name]
 return None

def canonical_facts(value):
 """Project only documented quote/facts shapes; never flatten arbitrary scalars."""
 if not isinstance(value,dict): return None
 # Successful check_quote_book prepares return this guest-safe publicQuote shape.
 quote=value.get("quote"); guests=value.get("guests"); details=value.get("package_details")
 if isinstance(quote,dict) and isinstance(guests,list) and guests:
  package_rows=[]
  for guest in guests:
   if not isinstance(guest,dict) or type(guest.get("position")) is not int or not isinstance(guest.get("package"),str): return None
   name=guest.get("name")
   if not isinstance(name,str) or not name: return None
   package_rows.append({"guest":guest["position"],"guest_name":name,"code":guest["package"]})
  package={"code":package_rows[0]["code"]} if len(package_rows)==1 else {"per_guest":package_rows}
  detail_rows=details if isinstance(details,list) else [details] if isinstance(details,dict) else []
  if any(not isinstance(row.get("includes",[]),list) or not isinstance(row.get("terms",[]),list) for row in detail_rows): return None
  projected={"currency":quote.get("currency"),"total_cents":quote.get("totalCents"),"deposit_cents":quote.get("depositCents"),
   "remaining_cents":quote.get("remainingCents"),"check_in":value.get("check_in"),"check_out":value.get("check_out"),
   "package":package,"add_ons":value.get("add_ons"),
   "inclusions":[x for row in detail_rows for x in row.get("includes",[])],"terms":[x for row in detail_rows for x in row.get("terms",[])]}
  cp=canonical_package(projected["package"]); ca=canonical_add_ons(projected["add_ons"])
  if cp is not None and ca is not None and all(projected[k] is not None for k in ("currency","total_cents","deposit_cents","remaining_cents","check_in","check_out")):
   projected["package"]=cp; projected["add_ons"]=ca; return projected
 candidates=[value]
 for key in ("facts","quote","quote_facts","quoteFacts","data"):
  child=value.get(key)
  if isinstance(child,dict):
   candidates.append(child)
   for nested in ("facts","quote","quote_facts","quoteFacts"):
    if isinstance(child.get(nested),dict): candidates.append(child[nested])
 for row in candidates:
  total=_field(row,"total_cents","totalCents"); deposit=_field(row,"deposit_cents","depositCents"); remaining=_field(row,"remaining_cents","remainingCents","remainder_cents","remainderCents")
  package=_field(row,"package","package_selection","packageSelection","packages")
  addons=_field(row,"add_ons","addOns","addons")
  inclusions=_field(row,"inclusions"); terms=_field(row,"terms")
  check_in=_field(row,"check_in","checkIn"); check_out=_field(row,"check_out","checkOut")
  currency=_field(row,"currency")
  if all(x is not None for x in (currency,total,deposit,remaining,check_in,check_out,package,addons,inclusions,terms)):
   cp=canonical_package(package); ca=canonical_add_ons(addons)
   if cp is None or ca is None or not isinstance(inclusions,list) or not isinstance(terms,list): return None
   return {"currency":currency,"total_cents":total,"deposit_cents":deposit,"remaining_cents":remaining,"check_in":check_in,"check_out":check_out,"package":cp,"add_ons":ca,"inclusions":inclusions,"terms":terms}
 return None

def semantic_score(case,reply,calls,results,fault_exchange,current_event_id=None,*,expected_authority=None):
 """Grade prepared results only against independently retained request authority.

 Callers must supply expected_authority from their request/runtime context, never
 from the result, receipt, response or case being graded. Missing context fails
 fidelity closed; clarification needs no Staff authority. The imported boundary
 checker alone checks relations and is not an independent fidelity verdict.
 """
 clarification=case.get("expect")=="clarification"
 progress=len(calls)==(1 if case.get("prepare_required") else 0)
 outcome=case.get("intended_owner_outcome") or {"expect":case.get("expect")}
 if clarification:
  truthful=reply_truth(reply,outcome,None,None,case.get("_catalog_claim_terms",()))
  return {"clarification":bool(truthful and not calls),"progress":progress,"fidelity":None if truthful else False}
 call=calls[0] if len(calls)==1 else {}
 tool_call_id=call.get("id")
 paired=[r for r in results if isinstance(r,dict) and isinstance(tool_call_id,str) and tool_call_id and r.get("_tool_call_id")==tool_call_id]
 result=paired[0] if len(paired)==1 else {}
 bound=isinstance(expected_authority,dict) and _boundary_consistent(call,result,fault_exchange,current_event_id,expected_authority)
 facts=canonical_facts(outcome.get("facts"))
 if case.get("expect") in {"quote","mixed"}:
  exact=validate_outcome(outcome) and facts is not None and facts==canonical_facts(result)
 else:
  exact=validate_outcome(outcome) and result.get("ok") is False
 if case.get("fault"):
  # The verifier already checks bytes, status, exception and exact plugin result.
  # The scenario must additionally be the fault actually exercised this turn.
  exact=exact and isinstance(fault_exchange,dict) and fault_exchange.get("fault_requested")==case["fault"] and fault_exchange.get("fault_applied")==case["fault"]
 fidelity=bool(bound and exact and reply_truth(reply,outcome,facts,result,case.get("_catalog_claim_terms",())))
 return {"clarification":False,"progress":progress,"fidelity":fidelity}

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
 """Grade retained events; request.thread must come from the caller's request.

 Response/receipt/case session claims are never a substitute for missing request
 context. Historical records without that context cannot prove fidelity. A
 correction also requires a verified refusal in the same session and a new event.
 """
 rows=[]; first_authority=None
 for event in events:
  body=event.get("response") or {}; calls,results,exchanges=_event_parts(body); event_case=dict(case)
  request_context=event.get("request")
  thread=request_context.get("thread") if isinstance(request_context,dict) else None
  expected_authority=None
  if isinstance(thread,str) and thread.strip():
   expected_authority={"tenant_id":"wolfhouse-somo","session_id":"luna-v3:"+digest_bytes(thread.encode())[:24],"external_send_allowed":False,"staff_alert_allowed":False}
  if not rows: first_authority=expected_authority
  if case.get("continuation"):
   event_case["expect"]="refusal" if not rows else "quote"
   event_case["intended_owner_outcome"]=case.get("intended_owner_outcome") if not rows else case.get("corrected_owner_outcome")
  intended=next((r for r in results if r.get('_tool_call_id')==(calls[0].get('id') if len(calls)==1 else None)),{})
  matching=[x for x in exchanges if isinstance(x,dict) and x.get('call_id')==intended.get('call_id')]
  target=matching[0] if len(matching)==1 else None
  score=semantic_score(event_case,body.get("reply_text"),calls,results,target,current_event_id=event.get("event_id"),expected_authority=expected_authority)
  if case.get("continuation") and rows:
   same_session_correction=(len(rows)==1 and first_authority is not None and expected_authority==first_authority
    and rows[0]["semantic"]["fidelity"] is True and event.get("event_id")!=rows[0]["event_id"])
   score["fidelity"]=bool(score["fidelity"] and same_session_correction)
  expected_control=case.get("corrected_control") if rows and case.get("continuation") else case.get("control")
  function=(calls[0].get("function") or {}) if len(calls)==1 else {}
  arguments=function.get("arguments_parsed") or calls[0].get("arguments_parsed") if len(calls)==1 else None
  rows.append({"event_id":event.get("event_id"),"prepare_count":len(calls),"owner_control_matches":control_matches_prepare(expected_control,arguments,case.get("_owner_choices")) if event_case.get("prepare_required") and expected_control else None,"semantic":score})
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
  "raw_staff_responses_present":isinstance(trace,dict) and isinstance(trace.get("staff_http_exchanges"),list) and (not case["prepare_required"] or bool(trace.get("staff_http_exchanges")) and all(_valid_staff_exchange(x) for x in trace["staff_http_exchanges"])),
  "installed_plugin_result_present":isinstance(trace,dict) and isinstance(trace.get("installed_plugin"),dict) and bool(trace["installed_plugin"].get("sha256")),
  "runtime_readback_present":isinstance(trace,dict) and isinstance(trace.get("runtime_readback"),dict),
  "pre_post_state_present":isinstance(pre,dict) and isinstance(post,dict),
  "one_prepare_per_turn":len(prepare)==(2 if case["continuation"] else 1) if case["prepare_required"] else len(prepare)==0,
  "no_hold_or_booking_for_quote":not quote_only or pre.get("booking_count")==post.get("booking_count") and pre.get("hold_count")==post.get("hold_count"),
  "send_suppressed":body.get("external_send_allowed") is False and body.get("staff_alert_allowed") is False,
 }
 if case["continuation"]:
  checks["genuine_one_use_continuation"]=isinstance(trace,dict) and trace.get("continuation_consumed") is True
  checks["first_refusal_then_success"]=any(isinstance(x,dict) and x.get("ok") is False for x in tool_results) and any(isinstance(x,dict) and x.get("ok") is True for x in tool_results)
 return checks,[]

def load_owner_fixture(path, expected_sha256):
 """Verify byte custody/integrity only; provenance is not cryptographic authentication."""
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
   wire=request(base+"/wolfhouse/simulate-guest-turn",token,trace_token,payload,fault=case.get("fault"))
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
   checks["simulate_http_success"]=all(event.get("http",{}).get("status")==200 for event in event_receipts)
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
 manifest={"schema":"luna-v3-cap-authentic-matrix/v2","candidate_sha":head,"repetitions":REPS,"no_retries":True,"generated_from_staff_admission_revision":snapshot["revision"],"owner_fixture_custody_sha256":fixture_sha256,"owner_fixture_provenance_unverified":fixture["owner_provenance"],"cases":cases,"pins":pf.get("pins"),"redacted_settings":redact(settings)}
 result={"schema":"luna-v3-cap-authentic-results/v2","manifest_sha256":digest(manifest),"records":records,"pass":all(r.get("verdict") in ("PASS","N/A") for r in records)}
 (out/"manifest.json").write_bytes(canon(manifest)+b"\n"); (out/"results.json").write_bytes(canon(result)+b"\n")
 files=sorted(p for p in out.rglob("*") if p.is_file()); (out/"SHA256SUMS").write_text("".join(f"{digest_bytes(p.read_bytes())}  {p.relative_to(out)}\n" for p in files))
 print(json.dumps({"output":str(out),"cases":len(cases),"executed":sum(r.get("repetition") is not None for r in records),"pass":result["pass"]}))
 return 0 if result["pass"] else 1
if __name__=="__main__": raise SystemExit(main())
