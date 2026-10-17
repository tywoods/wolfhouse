#!/usr/bin/env python3
"""Build the deterministic SIM15 REPAIR4 evidence receipt.

No Staff/model network call is made. Each exact tree is extracted independently;
its own plugin and personality modules are imported by a fresh subprocess. Inert
raw Staff responses are injected below registered read-only callbacks and only
actual callback return bodies are retained. Message histories use ordinary
user/assistant-tool-call/tool roles rather than embedding tool rows in prose.
"""
from __future__ import annotations
import hashlib, json, subprocess, sys, tarfile, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts/sim15-season-oneq-repair4"
BASE = "d1d42d5b45c42173848ac8ff29f272489cd3768f"
CANDIDATE = "d468622fde32f2d0adae17247bc8de91bb63ca88"
G3 = "hi! Aisha — me + 2 friends (all women, 22-24) want 3 nights Nov 3-6 (check-in Tue 3 Nov, out Fri 6 Nov 2026). Do you have a surf+stay package, or is bed-only cheaper? Also my 16yo sister might crash one night — is that allowed?"
HOLLY = "Hiya — Holly & Jake from Bristol (a couple, she/he). Private room if you have one, Nov 10-13 (3 nights). Can we rent boards there, what's parking like?"
NOTES = "Season normally runs Easter through Halloween. Guests aged 16 may stay without a parent, but every overnight guest needs a booked available bed. Free parking is inside the property."

def sha_bytes(value: bytes) -> str: return hashlib.sha256(value).hexdigest()
def stable(value) -> str: return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def call(tool, ident, route, params, staff_response):
    return {"tool": tool, "tool_call_id": ident, "fixture_id": "inert-" + ident, "route": route, "params": params, "staff_response": staff_response}

def cases():
    house = call("get_house_info", "house", "/house-info", {}, {"success": True, "has_notes": True, "notes": NOTES, "read_only": True})
    def available(prefix, guest, private=False):
        raw = {"success": True, "has_enough_beds": True, "availability_status": "available", "available_count": guest, "next_action": "ready_for_bot_create", "read_only": True}
        if private: raw["private_room_available"] = True
        return call("check_availability", prefix + "-availability", "/availability-check", {"check_in": "2026-11-10" if private else "2026-11-03", "check_out": "2026-11-13" if private else "2026-11-06", "guest_count": guest, "room_type": "private" if private else "shared"}, raw)
    def pricing(prefix, guest, private=False):
        return call("preview_package_prices", prefix + "-pricing", "/package-price-preview", {"check_in": "2026-11-10" if private else "2026-11-03", "check_out": "2026-11-13" if private else "2026-11-06", "guest_count": guest}, {"success": True, "package_min_nights": 7, "package_eligible": False, "nights": 3, "read_only": True})
    def catalog(prefix, text):
        return call("lookup_catalog_service", prefix + "-catalog", "/catalog-service-lookup", {"check_in": "2026-11-10", "check_out": "2026-11-13", "guest_count": 2, "message_text": text}, {"success": True, "matched": True, "service": {"name": "partner surfboard rental"}, "reply": "Board type and duration are still needed.", "facts": {"availability_confirmed": False, "price_confirmed": False}, "read_only": True})
    closed = call("quote_booking", "closed-quote", "/booking-preview", {"check_in": "2026-11-03", "check_out": "2026-11-06", "guest_count": 2, "room_type": "private", "package_code": "package_none", "selected_bed_codes": ["P1", "P2"]}, {"success": False, "offer_revision": "synthetic-closed-season", "next_action": "closed_season", "reply_draft": "We’re closed for those dates.", "guest_safe_next_action": "We’re closed for those dates.", "read_only": True})
    return [
      {"id":"g3_current_date_authority_pricing_unavailable","guest":G3,"calls":[house,available("g3",3),pricing("g3",3)]},
      {"id":"holly_current_date_authority_pricing_unavailable","guest":HOLLY,"calls":[house,available("holly",2,True),pricing("holly",2,True),catalog("holly",HOLLY)]},
      {"id":"genuine_closure","guest":"Can Holly and Jake stay in a private room from 3–6 November 2026?","calls":[house,closed]},
      {"id":"missing_date_authority","guest":"Can Holly and Jake stay in a private room from 3–6 November 2026?","calls":[house]},
    ]

def extract(ref: str, destination: Path):
    destination.mkdir(parents=True)
    archive = subprocess.run(["git","archive","--format=tar",ref], cwd=ROOT, check=True, stdout=subprocess.PIPE).stdout
    tar_path = destination / "tree.tar"
    tar_path.write_bytes(archive)
    tree = destination / "tree"; tree.mkdir()
    with tarfile.open(tar_path) as tf: tf.extractall(tree, filter="data")
    return tree

def probe(tree: Path, case):
    proc = subprocess.run([sys.executable, str(OUT / "variant_probe.py"), str(tree)], input=json.dumps({"calls":case["calls"]}), text=True, capture_output=True, check=True, env={"PYTHONDONTWRITEBYTECODE":"1","HOME":"/tmp"})
    result = json.loads(proc.stdout)
    # The probe asserted real runtime paths. Normalize the random extraction
    # prefix so the retained receipt is byte deterministic.
    result["loaded_paths"] = {
        key: "<isolated-tree>/" + str(Path(value).resolve().relative_to(tree.resolve()))
        for key, value in result["loaded_paths"].items()
    }
    return result

def history(guest, outputs):
    calls = [{"id":row["tool_call_id"],"type":"function","function":{"name":row["tool"],"arguments":stable(row["params"])}} for row in outputs]
    rows = [{"role":"user","content":guest},{"role":"assistant","content":None,"tool_calls":calls}]
    rows += [{"role":"tool","name":row["tool"],"tool_call_id":row["tool_call_id"],"content":json.dumps(row["actual_callback_output"],ensure_ascii=False)} for row in outputs]
    return rows

def main():
    old = ROOT / "artifacts/sim15-season-oneq-repair3/replay-receipt.json"
    receipt = {"schema":"sim15-offline-callback-and-message-evidence-v4","candidate_head":CANDIDATE,"baseline_ref":BASE,
      "deterministic":True,"model_generation_performed":False,"historical_reproduction_claimed":False,
      "repair3_mixed_context_diagnostic":{"path":str(old.relative_to(ROOT)),"sha256":sha_bytes(old.read_bytes()),"label":"MIXED-CONTEXT DIAGNOSTIC ONLY; baseline SOUL with candidate plugin context"},
      "safety":{"staff_network_calls":False,"guest_sends":False,"writes":False,"deploys":False,"restarts":False,"other_tenants":False},"runs":[]}
    with tempfile.TemporaryDirectory(prefix="sim15-r4-") as td:
      tmp=Path(td)
      trees={"baseline":extract(BASE,tmp/"base"),"candidate":extract(CANDIDATE,tmp/"candidate")}
      for variant,tree in trees.items():
        for case in cases():
          result=probe(tree,case); messages=history(case["guest"],result["outputs"])
          receipt["runs"].append({"variant":variant,"ref":BASE if variant=="baseline" else CANDIDATE,"case":case["id"],
            "consumed_module_paths":result["loaded_paths"],"consumed_module_sha256":result["loaded_sha256"],
            "descriptions":result["descriptions"],"descriptions_sha256":result["descriptions_sha256"],
            "assembled_personality_sha256":result["assembled_personality_sha256"],"callback_events":result["events"],
            "actual_callback_outputs":result["outputs"],"message_history":messages,"message_history_sha256":sha_bytes(stable(messages).encode())})
    OUT.mkdir(exist_ok=True)
    target=OUT/"replay-receipt.json"; target.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({"receipt":str(target.relative_to(ROOT)),"sha256":sha_bytes(target.read_bytes()),"runs":len(receipt["runs"])}))
if __name__ == "__main__": main()
