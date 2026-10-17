#!/usr/bin/env python3
"""Separately score the three G3 criteria on retained observed emissions."""
import hashlib, json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/"artifacts/sim15-season-oneq-repair4"
OLD=json.loads((ROOT/"artifacts/sim15-season-oneq-repair3/replay-receipt.json").read_text())

def one_question(text):
    low=text.lower()
    compound=bool(re.search(r"would you like me to include her.{0,80}\band\b.{0,40}(?:which|what) night",low,re.S))
    return not compound

def room_first_deferral(text):
    low=text.lower()
    room_choice=bool(re.search(r"women.{0,30}(?:or|versus).{0,30}mixed|mixed.{0,30}(?:or|versus).{0,30}women",low,re.S) and "?" in text)
    sister_deferred=bool(re.search(r"sister.{0,80}(?:later|after|once|then)",low,re.S))
    return room_choice and sister_deferred

rows=[]
for run in OLD["runs"]:
    if not run["case"].startswith("g3_"): continue
    text=run["actual_emitted_reply"] or ""
    checks={
      "season_no_stale_caveat":{"pass":not bool(re.search(r"easter|halloween|usual season|season caveat",text,re.I)),"scope":"season wording only"},
      "one_question":{"pass":one_question(text),"scope":"one requested decision; semantic, not punctuation count"},
      "room_choice_first_with_sister_night_deferred":{"pass":room_first_deferral(text),"scope":"retained G3 example prioritization; independent of one-question"},
    }
    rows.append({"variant":run["variant"],"case":run["case"],"repair3_run_id":run["run_id"],"observed_reply":text,"criteria":checks,
      "overall_full_g3_pass":all(v["pass"] for v in checks.values())})
assessment={"schema":"sim15-g3-separate-criteria-v4","source":"repair3 observed emissions, retained only for corrected assessment",
 "not_a_repaired_context_generation":True,"runs":rows,
 "interpretation":"Baseline g3_failed_preview fails one-question. Candidate G3 emissions pass the narrow one-question check. No retained generated G3 emission demonstrates room-choice-first with sister-night deferral. Season causality remains uncertain."}
raw=json.dumps(assessment,ensure_ascii=False,indent=2)+"\n"
(OUT/"replay-assessment.json").write_text(raw)
print(json.dumps({"assessment":str((OUT/"replay-assessment.json").relative_to(ROOT)),"sha256":hashlib.sha256(raw.encode()).hexdigest(),"rows":len(rows)}))
