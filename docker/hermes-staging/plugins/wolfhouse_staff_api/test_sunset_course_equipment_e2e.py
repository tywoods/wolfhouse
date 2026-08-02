"""Plugin course equipment finalize — during_course drop + all_day wire provenance.

Design (staging-verified):
- Free during-course gear is server auto-attached from equipment_options.
  Plugin must NOT send course_equipment for mode=during_course (forks quote → 409).
- Paid all_day intent expands to site wire array [{offering_key, mode, quantity}]
  from /sunset/catalog equipment_options, and create posts that wire + provenance.
"""
import copy
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wolfhouse_staff_api as mod

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
COURSE = "a5aef000-0000-4000-8000-000000000000"
ITEM = f"surf_pack_{COURSE}__1_day"
GEAR_KEY = "board_and_suit_rental"
DURING = {"mode": "during_course", "quantity": 2}
ALL_DAY = {"mode": "all_day", "quantity": 2}
WIRE_ALL_DAY = [{"offering_key": GEAR_KEY, "mode": "all_day", "quantity": 2}]

NODE_QUOTE = r"""
const input=JSON.parse(require('fs').readFileSync(0,'utf8'));
const q=require('./scripts/lib/luna-front-desk-quote-service');
const cfg={
  ok:true, source:'db',
  surf_packs:[{
    pack_id:input.course, label:'Admin course', active:true,
    group_size:8, weekly:'daily', schedules:['0930_1130'],
    equipment_options:[{
      offering_key:input.gearKey,
      during_course_price_cents:0,
      all_day_price_cents:1000,
      label:'Board and wetsuit',
    }],
    price_tiers:[{key:'1_day', label:'One day', hours:2}],
  }],
  rental_offerings:[{
    offering_key:input.gearKey, label:'Board and wetsuit', active:true,
    client_slug:'sunset', location_id:'sunset-somo',
  }],
  prices:[{
    id:'price-e2e', category:'package', offering_key:input.item, item_code:input.item,
    amount_cents:4000, unit:'day', active:true, currency:'EUR',
  }],
};
const built=q.buildSunsetQuoteCommand({
  channel:q.QUOTE_CHANNELS.LUNA_WHATSAPP,
  transportBody:input.body,
  trustedLocationId:'sunset-somo',
  now:new Date('2026-07-28T12:00:00Z'),
});
(async()=>{
  const out=built.ok?await q.executeSunsetQuote(null,built.command,{adminCfg:cfg}):built;
  process.stdout.write(JSON.stringify(out.body));
})().catch(e=>{console.error(e); process.exit(1);});
"""


class RuntimeTransport:
    def __init__(self):
        self.calls = []

    def __call__(self, path, body):
        self.calls.append((path, copy.deepcopy(body)))
        if "catalog" in path:
            return {
                "ok": True,
                "offerings": [{
                    "offering_id": ITEM,
                    "course_id": COURSE,
                    "offering_item_code": ITEM,
                    "equipment_options": [{
                        "offering_key": GEAR_KEY,
                        "during_course_price_cents": 0,
                        "all_day_price_cents": 1000,
                        "label": "Board and wetsuit",
                    }],
                }],
            }
        if "offering-quote" in path:
            proc = subprocess.run(
                ["node", "-e", NODE_QUOTE],
                cwd=ROOT,
                input=json.dumps({
                    "course": COURSE,
                    "item": ITEM,
                    "gearKey": GEAR_KEY,
                    "body": body,
                }),
                text=True,
                capture_output=True,
                check=True,
            )
            return json.loads(proc.stdout)
        return {"success": True, "booking_id": "b1", "booking_code": "SUNSET-E2E", "total_cents": 8000}


def base(**kw):
    payload = {
        "guest_confirmed_booking": True,
        "guest_name": "Test",
        "service_dates": ["2026-09-01"],
        "components": {
            "course": {
                "course_id": COURSE,
                "tier_key": "1_day",
                "offering_id": ITEM,
                "quantity": 2,
            },
        },
    }
    payload.update(kw)
    return payload


transport = RuntimeTransport()
mod._post_bot = transport

# ── 1) During-course: drop from quote bot call (server auto-attach) ─────────
quote_during = json.loads(mod.get_sunset_offering_quote({
    "offering_id": ITEM,
    "course_id": COURSE,
    "quantity": 2,
    "service_dates": ["2026-09-01"],
    "course_equipment": DURING,
}))
assert transport.calls[0][0].endswith("/sunset/offering-quote") or "offering-quote" in transport.calls[0][0]
assert "course_equipment" not in transport.calls[0][1], transport.calls[0][1]
assert quote_during["success"] is True
assert quote_during.get("course_equipment") in (None, [], {}), quote_during.get("course_equipment")
assert quote_during["total_cents"] == 8000  # course only; free gear not on quote lines
assert quote_during["quote_provenance"]
assert len(quote_during["quote_provenance"]["quote_fingerprint"]) == 64
# No paid CE lines when during was dropped
gear_lines = [
    line for line in (quote_during.get("line_items") or [])
    if isinstance(line, dict) and line.get("course_equipment") is True
]
assert gear_lines == [], gear_lines

# Create with during_course intent → plugin drops CE; booking-create has no CE field
out_during = json.loads(mod.create_sunset_booking(base(
    course_equipment=DURING,
    quote_provenance=quote_during["quote_provenance"],
)))
assert out_during["success"] is True, out_during
posted_during = transport.calls[-1]
assert "booking-create" in posted_during[0]
assert "course_equipment" not in posted_during[1], posted_during[1]
# Free during-course create may still carry course quote provenance (no CE field).
assert isinstance(posted_during[1].get("quote_provenance"), dict) or posted_during[1].get("quote_provenance") is None

# Bare course create (no CE) still works — server auto-attach on staff-api
before = len(transport.calls)
out_plain = json.loads(mod.create_sunset_booking(base(
    quote_provenance=quote_during["quote_provenance"],
)))
assert out_plain["success"] is True, out_plain
assert "course_equipment" not in transport.calls[-1][1]

# ── 2) All-day paid: expand intent → wire + provenance passthrough ──────────
transport.calls.clear()
quote_all = json.loads(mod.get_sunset_offering_quote({
    "offering_id": ITEM,
    "course_id": COURSE,
    "quantity": 2,
    "service_dates": ["2026-09-01"],
    "course_equipment": ALL_DAY,
}))
# Catalog lookup for offering keys + offering-quote with wire
assert any("catalog" in p for p, _ in transport.calls), transport.calls
quote_call = next(b for p, b in transport.calls if "offering-quote" in p)
assert quote_call["course_equipment"] == WIRE_ALL_DAY, quote_call.get("course_equipment")
assert quote_all["success"] is True, quote_all
assert quote_all["quote_provenance"]["course_equipment"] == WIRE_ALL_DAY
assert quote_all.get("course_equipment") in (WIRE_ALL_DAY, quote_all["quote_provenance"].get("course_equipment"))
assert quote_all["total_cents"] >= 8000 + 2000  # course + all_day × qty (2 × 1000)

out_all = json.loads(mod.create_sunset_booking(base(
    course_equipment=ALL_DAY,
    quote_provenance=quote_all["quote_provenance"],
)))
assert out_all["success"] is True, out_all
posted_all = transport.calls[-1]
assert "booking-create" in posted_all[0]
assert posted_all[1]["course_equipment"] == WIRE_ALL_DAY, posted_all[1].get("course_equipment")
assert posted_all[1]["quote_provenance"] == quote_all["quote_provenance"]

# Already-wire list on quote path passes through
transport.calls.clear()
quote_wire = json.loads(mod.get_sunset_offering_quote({
    "offering_id": ITEM,
    "course_id": COURSE,
    "quantity": 2,
    "service_dates": ["2026-09-01"],
    "course_equipment": WIRE_ALL_DAY,
}))
qcall = next(b for p, b in transport.calls if "offering-quote" in p)
assert qcall["course_equipment"] == WIRE_ALL_DAY
assert quote_wire["success"] is True

# ── 3) Fail-closed negatives (paid path + invalid during leftovers) ─────────
before = len(transport.calls)
changed_price = copy.deepcopy(quote_all["quote_provenance"])
# bump a line total without matching provenance total
if changed_price.get("line_items"):
    changed_price["line_items"][0]["total_cents"] = int(changed_price["line_items"][0].get("total_cents") or 0) + 1

bad_prov = copy.deepcopy(quote_all["quote_provenance"])
bad_prov["course_equipment"] = [{"offering_key": GEAR_KEY, "mode": "during_course", "quantity": 2}]

bad_cases = [
    # invalid shape
    {"course_equipment": {"mode": "all_day"}, "quote_provenance": quote_all["quote_provenance"]},
    {"course_equipment": {"mode": "all_day", "quantity": 2, "total_cents": 0},
     "quote_provenance": quote_all["quote_provenance"]},
    # qty > course qty
    {"course_equipment": {"mode": "all_day", "quantity": 3},
     "quote_provenance": quote_all["quote_provenance"]},
    # mode mismatch vs provenance wire
    {"course_equipment": {"mode": "all_day", "quantity": 2}, "quote_provenance": bad_prov},
    # money mismatch
    {"course_equipment": ALL_DAY, "quote_provenance": changed_price},
    # all_day without provenance
    {"course_equipment": ALL_DAY},
    # empty create without course provenance when course present is still fail-closed
    # (quote_provenance_required on configured course)
    {},
]
for index, case in enumerate(bad_cases):
    result = json.loads(mod.create_sunset_booking(base(**case)))
    assert result["success"] is False, (index, result)

assert len(transport.calls) == before, transport.calls[before:]

# During-course with junk money fields is dropped (not invalid) — still no write if
# we only send during without a valid course provenance when required.
# Explicit: during alone must not hit booking-create with CE field.
transport.calls.clear()
_ = json.loads(mod.create_sunset_booking(base(
    course_equipment={"mode": "during_course", "quantity": 2, "total_cents": 0},
    quote_provenance=quote_during["quote_provenance"],
)))
# Either success (CE dropped) or fail provenance — never posts CE
create_posts = [b for p, b in transport.calls if "booking-create" in p]
if create_posts:
    assert "course_equipment" not in create_posts[-1], create_posts[-1]

print("test_sunset_course_equipment_e2e: PASS (during drop + all_day wire)")
