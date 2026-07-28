"""Exact quote -> create course-equipment bridge regression."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wolfhouse_staff_api as mod

class Fake:
    def __init__(self): self.calls=[]
    def __call__(self,path,body):
        self.calls.append((path,dict(body)))
        if "offering-quote" in path:
            selection={"mode":"during_course","quantity":2}
            lines=[{"component":"surfboard","course_equipment":True,"course_equipment_mode":"during_course","quantity":2,"total_cents":0},
                   {"component":"wetsuit","course_equipment":True,"course_equipment_mode":"during_course","quantity":2,"total_cents":0}]
            return {"ok":True,"course_equipment":selection,"line_items":lines,"total_cents":8000,
                    "quote_provenance":{"quote_fingerprint":"fp-exact","line_items":lines}}
        return {"success":True,"booking_id":"b1","total_cents":8000}

def base(**kw):
    p={"guest_confirmed_booking":True,"guest_name":"Test","service_dates":["2026-09-01"],
       "components":{"course":{"course_id":"c1","tier_key":"1_day","quantity":2}}}
    p.update(kw); return p

fake=Fake(); mod._post_bot=fake
selection={"mode":"during_course","quantity":2}
quote=json.loads(mod.get_sunset_offering_quote({"offering_id":"surf_pack_c1__1_day","course_id":"c1","quantity":2,
                                                "service_dates":["2026-09-01"],"course_equipment":selection}))
assert fake.calls[0][1]["course_equipment"] == selection
assert quote["course_equipment"] == selection and quote["total_cents"] == 8000
assert len(quote["line_items"]) == 2 and quote["quote_provenance"]["quote_fingerprint"] == "fp-exact"
out=json.loads(mod.create_sunset_booking(base(course_equipment=quote["course_equipment"], quote_provenance=quote["quote_provenance"])))
assert out["success"] is True
posted=fake.calls[-1]
assert posted[0].endswith("/sunset/booking-create")
assert posted[1]["course_equipment"] == selection and posted[1]["quote_provenance"] == quote["quote_provenance"]

before=len(fake.calls)
bad_cases=[
 {"course_equipment":{"mode":"during_course"},"quote_provenance":quote["quote_provenance"]},
 {"course_equipment":{"mode":"during_course","quantity":2,"total_cents":0},"quote_provenance":quote["quote_provenance"]},
 {"course_equipment":{"mode":"during_course","quantity":3},"quote_provenance":quote["quote_provenance"]},
 {"course_equipment":{"mode":"all_day","quantity":2},"quote_provenance":{"quote_fingerprint":"fp"},
  "components":{"course":{"course_id":"c1","tier_key":"1_day","quantity":2},"full_day_equipment_addon":{"quantity":2}}},
 {"quote_provenance":quote["quote_provenance"]},
]
for case in bad_cases:
    result=json.loads(mod.create_sunset_booking(base(**case)))
    assert result["success"] is False, result
assert len(fake.calls) == before, fake.calls[before:]
print("test_sunset_course_equipment_e2e: PASS")
