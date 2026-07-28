"""Real plugin -> real offering_id quote runtime -> exact create bridge regression."""
import copy, json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wolfhouse_staff_api as mod

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
COURSE = "a5aef000-0000-4000-8000-000000000000"
ITEM = f"surf_pack_{COURSE}__1_day"
SELECTION = {"mode": "during_course", "quantity": 2}
NODE_QUOTE = r"""
const fs=require('fs');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const q=require('./scripts/lib/luna-front-desk-quote-service');
const cfg={ok:true,source:'db',surf_packs:[{pack_id:input.course,label:'Admin course',active:true,
 equipment_included:true,group_size:8,weekly:'daily',schedules:['0930_1130'],
 price_tiers:[{key:'1_day',label:'One day',hours:2}]}],prices:[{id:'price-e2e',category:'package',
 offering_key:input.item,item_code:input.item,amount_cents:4000,unit:'day',active:true,currency:'EUR'}]};
const built=q.buildSunsetQuoteCommand({channel:q.QUOTE_CHANNELS.LUNA_WHATSAPP,transportBody:input.body,
 trustedLocationId:'sunset-somo',now:new Date('2026-07-28T12:00:00Z')});
(async()=>{const out=built.ok?await q.executeSunsetQuote(null,built.command,{adminCfg:cfg}):built;
process.stdout.write(JSON.stringify(out.body));})().catch(e=>{console.error(e);process.exit(1)});
"""

class RuntimeTransport:
    def __init__(self):
        self.calls = []
    def __call__(self, path, body):
        self.calls.append((path, copy.deepcopy(body)))
        if "offering-quote" in path:
            proc = subprocess.run(["node", "-e", NODE_QUOTE], cwd=ROOT,
                input=json.dumps({"course": COURSE, "item": ITEM, "body": body}),
                text=True, capture_output=True, check=True)
            return json.loads(proc.stdout)
        return {"success": True, "booking_id": "b1", "total_cents": 8000}

def base(**kw):
    payload={"guest_confirmed_booking":True,"guest_name":"Test","service_dates":["2026-09-01"],
       "components":{"course":{"course_id":COURSE,"tier_key":"1_day","offering_id":ITEM,"quantity":2}}}
    payload.update(kw)
    return payload

transport=RuntimeTransport()
mod._post_bot=transport
quote=json.loads(mod.get_sunset_offering_quote({"offering_id":ITEM,"course_id":COURSE,"quantity":2,
    "service_dates":["2026-09-01"],"course_equipment":SELECTION}))
assert transport.calls[0][1]["course_equipment"] == SELECTION
assert quote["success"] is True and quote["course_equipment"] == SELECTION
assert quote["total_cents"] == 8000
gear=[line for line in quote["line_items"] if line.get("course_equipment")]
assert [line["component"] for line in gear] == ["surfboard", "wetsuit"]
assert all(line["quantity"] == 2 for line in gear)
assert quote["quote_provenance"]["course_equipment"] == SELECTION
assert len(quote["quote_provenance"]["quote_fingerprint"]) == 64

out=json.loads(mod.create_sunset_booking(base(course_equipment=quote["course_equipment"],
    quote_provenance=quote["quote_provenance"])))
assert out["success"] is True
posted=transport.calls[-1]
assert posted[0].endswith("/sunset/booking-create")
assert posted[1]["course_equipment"] == SELECTION
assert posted[1]["quote_provenance"] == quote["quote_provenance"]

before=len(transport.calls)
changed_price=copy.deepcopy(quote["quote_provenance"])
changed_price["line_items"][1]["unit_amount_cents"] = 1
changed_price["line_items"][1]["total_cents"] = 2
changed_mode=copy.deepcopy(quote["quote_provenance"])
changed_mode["line_items"][1]["course_equipment_mode"] = "all_day"
bad_cases=[
 {"course_equipment":{"mode":"during_course"},"quote_provenance":quote["quote_provenance"]},
 {"course_equipment":{"mode":"during_course","quantity":2,"total_cents":0},"quote_provenance":quote["quote_provenance"]},
 {"course_equipment":{"mode":"during_course","quantity":3},"quote_provenance":quote["quote_provenance"]},
 {"course_equipment":{"mode":"all_day","quantity":2},"quote_provenance":changed_mode},
 {"course_equipment":SELECTION,"quote_provenance":changed_price},
 {"quote_provenance":quote["quote_provenance"]},
]
for index, case in enumerate(bad_cases):
    result=json.loads(mod.create_sunset_booking(base(**case)))
    assert result["success"] is False, (index, result)
assert len(transport.calls) == before, transport.calls[before:]
print("test_sunset_course_equipment_e2e: PASS (real offering quote runtime)")
