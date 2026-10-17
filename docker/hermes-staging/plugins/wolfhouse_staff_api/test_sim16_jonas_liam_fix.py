"""S1357 R1-R3 behavioral evidence at the registered Wolfhouse boundary.

The ``DeterministicRegisteredLoop`` cases are explicitly a stubbed-model loop: the
model's semantic tool calls are fixtures, while registration, handlers, owner
SessionDB, quote presentation and create boundary are production code.  Raw Staff
receipts and every tool result are retained in ``trace`` for assertion/debugging.
No test attempts to recognize consent by matching phrases.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

STAGING = Path(__file__).resolve().parents[2]
ROOT = STAGING.parents[1]
sys.path[:0] = [str(STAGING), str(STAGING / "plugins")]
from gateway.session_context import clear_session_vars, set_session_vars
from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools, self.hooks = {}, {}
    def register_tool(self, **kw):
        self.tools[kw["name"]] = kw
    def register_hook(self, name, fn):
        self.hooks[name] = fn


def checked_staff_quote(plan, beds, *, total=48000, deposit=20000,
                        full_payment_only=False):
    """Build the raw Staff-shaped response with the production JS offer builder."""
    payment = plan.get("payment_choice") or ("full" if full_payment_only else "deposit")
    quote = {"success": True, "total_cents": total,
             "quote_total_cents": total, "deposit_required_cents": deposit,
             "balance_due_cents": total - deposit,
             "payment_link_amount_cents": total if payment == "full" else deposit,
             "currency": "EUR", "package_code": plan.get("package_code", "package_none"),
             "full_payment_only": full_payment_only}
    source = ("const {buildCheckedWolfhousePreviewOffer:b}=require("
              "'./scripts/lib/luna-front-desk-accommodation-availability-service');"
              "console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));")
    payload = {**{k: v for k, v in plan.items() if k not in ("guests", "payment_choice")},
               "client_slug": "wolfhouse-somo", "quote": quote,
               "guests": plan.get("guests", []), "payment_choice": payment,
               "availability": {**plan, "status": "checked",
                                "availability_status": "available",
                                "availability_checked": True,
                                "selected_bed_codes": [b["bed_code"] for b in beds]},
               "room_rows": beds}
    built = json.loads(subprocess.check_output(
        ["node", "-e", source, json.dumps(payload)], cwd=ROOT))
    return {**quote, **built, "payment_choice_needed": not full_payment_only and not plan.get("payment_choice")}


def availability_receipt(beds, *, enough=True):
    return {"success": True, "has_enough_beds": enough,
            "availability_status": "available" if enough else "unavailable",
            "next_action": "ready_for_bot_create" if enough else "offer_accommodation_or_change_dates",
            "selected_room_code": beds[0]["room_code"] if enough and beds else None,
            "selected_bed_codes": [b["bed_code"] for b in beds] if enough else [],
            "available_count": len(beds), "available_beds": deepcopy(beds)}


def create_recheck_receipt(beds, body=None):
    """Raw Staff exact person/bed eligibility receipt used by create recheck."""
    codes = [b["bed_code"] for b in beds]
    guests = (body or {}).get("guests") or []
    return {"success": True, "has_enough_beds": True,
            "available_beds": [{"bed_code": b["bed_code"],
                                "room_type": b["room_type"]} for b in beds],
            "exact_bed_eligibility": {"eligible": True,
                "selected_bed_codes": codes,
                "guest_bed_assignments": [
                    {"guest_index": i, "guest_name": guests[i].get("name", ""),
                     "bed_code": code} for i, code in enumerate(codes)]}}


class DeterministicRegisteredLoop:
    """Stubbed model, genuine registered tools + owner SessionDB/create boundary."""
    def __init__(self, testcase, session="sim16"):
        self.case = testcase
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / "state.db")
        self.db.create_session(session, source="whatsapp")
        self.agent = SimpleNamespace(_session_db=self.db, session_id=session,
                                     model="deterministic-stub", platform="whatsapp",
                                     _user_id="sim16-user")
        self.registry = Registry()
        self.env = patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"})
        self.env.start()
        plugin.register(self.registry)
        self.tokens = None
        self.trace = []
        self.staff = []
        self.create_dispatches = []

    def close(self):
        owner.close_turn()
        if self.tokens:
            clear_session_vars(self.tokens)
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def turn(self, message_id, raw):
        if self.tokens:
            clear_session_vars(self.tokens)
        self.tokens = set_session_vars(platform="whatsapp", source="whatsapp",
            chat_id="sim16-chat", user_id="sim16-user", session_key="sim16-key",
            session_id=self.agent.session_id, message_id=message_id)
        owner.observe_owner_turn(self.agent, raw)
        self.trace.append({"kind": "raw_user", "text": raw})

    def call(self, name, args, responses):
        def post(route, body):
            self.staff.append({"route": route, "body": deepcopy(body)})
            response = responses(route, body) if callable(responses) else responses[route]
            if route == "/booking-create-from-plan":
                self.create_dispatches.append(deepcopy(body))
            self.trace.append({"kind": "raw_staff", "route": route,
                               "response": deepcopy(response)})
            return deepcopy(response)
        with patch.object(plugin, "_post_bot", side_effect=post):
            # PreparedPlan carries the real, deliberately non-copyable dispatch capability.
            supplied = args if isinstance(args, owner.PreparedPlan) else deepcopy(args)
            raw = self.registry.tools[name]["handler"](supplied)
        result = json.loads(raw)
        self.trace.append({"kind": "tool_result", "tool": name, "result": result})
        return result

    def interpret(self, action, raw, *, completions=None, changes=None,
                  ambiguous=False, conditional=False):
        # This object is the clearly-labelled stubbed model output. Production
        # owner code, not this harness, decides whether it authorizes create.
        semantic = {"action": action, "action_evidence": raw,
                    "ambiguous": ambiguous, "negated": False,
                    "conditional": conditional,
                    "material_changes": changes or [],
                    "completions": completions or {}}
        self.trace.append({"kind": "stubbed_model_output", "output": deepcopy(semantic)})
        return owner.interpret_owner_turn(semantic)

    def present(self):
        rendered = owner.finalize_offer_response({"completed": True,
            "final_response": "UNCOACHED MODEL DRAFT",
            "messages": [{"role": "assistant", "content": "UNCOACHED MODEL DRAFT"}]})
        self.trace.append({"kind": "rendered_reply", "text": rendered["final_response"]})
        return rendered["final_response"]


class RegisteredBoundaryEvidence(unittest.TestCase):
    def setUp(self):
        self.loop = DeterministicRegisteredLoop(self)
    def tearDown(self):
        self.loop.close()

    @staticmethod
    def beds(count, strategy="mixed", room="R4"):
        return [{"bed_code": f"{room}-B{i}", "room_code": room,
                 "room_type": strategy, "gender_strategy": strategy,
                 "selected_selling_mode": "bed"} for i in range(1, count + 1)]

    def test_r1_jonas_eur480_names_on_first_yes_dispatches_once_without_reconfirm(self):
        """Shown €480/full 4-bed offer survives name completion on the first yes."""
        beds = self.beds(4)
        quoted = {"check_in": "2026-10-25", "check_out": "2026-10-27",
                  "guest_count": 4, "room_type": "shared", "room_preference": "mixed",
                  "package_code": "package_none", "payment_choice": "full", "guests": []}
        raw_quote = checked_staff_quote(quoted, beds, total=48000, deposit=48000,
                                        full_payment_only=True)
        self.loop.turn("jonas-quote", "Four beds please; show me the full-payment total")
        result = self.loop.call("quote_booking", quoted,
            {"/availability-check": availability_receipt(beds),
             "/booking-preview": raw_quote})
        self.assertEqual(result["total_cents"], 48000)
        self.assertTrue(result["full_payment_only"])
        rendered = self.loop.present()
        self.assertIn("480.00 EUR", rendered)
        self.assertIn("full", rendered.lower())
        self.assertTrue(rendered.endswith("Shall I check this exact offer for booking?"), rendered)

        yes = "Yes — book it for Jonas Bergström, Mia Chen, Noor Ali and Leo Costa."
        self.loop.turn("jonas-first-yes", yes)
        decision = self.loop.interpret("accept", yes, completions={"guests": [
            {"guest_index": i, "name": name, "evidence": name}
            for i, name in enumerate(("Jonas Bergström", "Mia Chen", "Noor Ali", "Leo Costa"))]})
        self.assertFalse(decision["create_ready"], decision)
        names = [{"name": n} for n in
                 ("Jonas Bergström", "Mia Chen", "Noor Ali", "Leo Costa")]
        refreshed_plan = {**quoted, "guests": names}
        refreshed = checked_staff_quote(refreshed_plan, beds, total=48000,
                                        deposit=48000, full_payment_only=True)
        def responses(route, body):
            if route == "/booking-preview":
                return refreshed
            if route == "/availability-check":
                return create_recheck_receipt(beds, body)
            return {"success": True, "created": True, "write_performed": True,
                    "booking_id": "jonas-one", "booking_code": "WH-JONAS"}
        created = self.loop.call("create_booking_from_plan", {"guests": names}, responses)
        self.assertTrue(created["success"], created)
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)
        sent = self.loop.create_dispatches[0]
        self.assertEqual(sent["payment_choice"], "full")
        self.assertEqual(sent["selected_bed_codes"], [b["bed_code"] for b in beds])
        self.assertEqual(sent["guests"], names)
        self.assertEqual([t for t in self.loop.trace if t["kind"] == "rendered_reply"],
                         [{"kind": "rendered_reply", "text": rendered}],
                         "no second confirmation was rendered")

    def test_r1_changed_person_and_material_terms_refuse_while_unchanged_replay_survives(self):
        beds = self.beds(2)
        plan = {"check_in": "2026-11-01", "check_out": "2026-11-03", "guest_count": 2,
                "room_type": "shared", "room_preference": "mixed", "package_code": "package_none",
                "payment_choice": "full", "guests": [{"name": "Jonas"}, {"name": "Mia"}]}
        quote = checked_staff_quote(plan, beds, total=24000, deposit=24000, full_payment_only=True)
        self.loop.turn("control-q", "quote")
        quote_responses = {"/availability-check": availability_receipt(beds),
                           "/booking-preview": quote}
        self.loop.call("quote_booking", plan, quote_responses)
        self.loop.present()
        for n, (raw, changes) in enumerate((("Replace Mia with Karl", []),
                ("Yes, but move checkout to 2026-11-04", [{"field": "check_out",
                 "value": "2026-11-04", "evidence": "2026-11-04"}]))):
            self.loop.turn(f"changed-{n}", raw)
            completions = {"guests": [{"guest_index": 1, "name": "Karl", "evidence": "Karl"}]} if n == 0 else {}
            outcome = self.loop.interpret("revise", raw, completions=completions, changes=changes)
            self.assertFalse(outcome.get("create_ready", False), outcome)
            self.assertEqual(len(self.loop.create_dispatches), 0)
        # Fresh unchanged control remains accepted and retains Jonas terms.
        self.loop.turn("control-q2", "show the original again")
        self.loop.call("quote_booking", plan, quote_responses)
        self.loop.present()
        self.loop.turn("control-yes", "Yes, create that exact offer")
        self.loop.interpret("accept", "Yes, create that exact offer")
        prepared = owner.prepare_create({})
        self.assertEqual(prepared["guests"], plan["guests"])
        self.assertEqual(prepared["check_out"], "2026-11-03")

    def test_r2_tom_liam_unavailable_to_agreed_mixed_truthful_quote_and_create(self):
        male, mixed = self.beds(2, "male_only", "M"), self.beds(2, "mixed", "X")
        base = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 2,
                "room_type": "shared", "room_preference": "male_only",
                "gender_preference": "male", "package_code": "package_none",
                "guests": [{"name": "Tom Wood", "explicit_gender": "male"},
                           {"name": "Liam Wernike", "explicit_gender": "male"}]}
        self.loop.turn("tl-a", "Tom and Liam need the male dorm")
        unavailable = self.loop.call("check_availability", base,
            {"/availability-check": availability_receipt([], enough=False)})
        self.assertTrue(unavailable["unavailable"], unavailable)
        # Diversion then recovery: no quote/create while answering an unrelated question.
        self.loop.turn("tl-diversion", "Before that, what time is check-in?")
        self.loop.trace.append({"kind": "stubbed_model_output",
                                "output": {"action": "answer_house_question", "tools": []}})
        self.assertEqual(len(self.loop.create_dispatches), 0)
        mixed_plan = {**base, "room_preference": "mixed", "payment_choice": "full"}
        self.loop.turn("tl-mixed", "Mixed is fine for both of us; please quote it")
        available = self.loop.call("check_availability", mixed_plan,
            {"/availability-check": availability_receipt(mixed)})
        self.assertTrue(available["available"], available)
        raw_quote = checked_staff_quote(mixed_plan, mixed, total=36000, deposit=20000)
        quote = self.loop.call("quote_booking", mixed_plan,
            {"/availability-check": availability_receipt(mixed),
             "/booking-preview": raw_quote})
        self.assertEqual(quote["total_cents"], 36000)
        reply = self.loop.present()
        self.assertIn("360.00 EUR", reply)
        self.loop.turn("tl-yes", "Yes, book that mixed room for Tom Wood and Liam Wernike")
        self.loop.interpret("accept", "Yes, book that mixed room for Tom Wood and Liam Wernike")
        prepared = owner.prepare_create({})
        self.assertEqual(prepared["room_preference"], "mixed")
        responses = lambda route, body: create_recheck_receipt(mixed, body) if route == "/availability-check" else {
            "success": True, "created": True, "write_performed": True, "booking_id": "tl-1"}
        self.loop.call("create_booking_from_plan", prepared, responses)
        self.assertEqual(len(self.loop.create_dispatches), 1)

    def test_r2_kenji_original_dates_male_to_mixed_after_package_preview_failure(self):
        mixed = self.beds(1, "mixed", "X")
        plan = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 1,
                "room_type": "shared", "room_preference": "mixed", "gender_preference": "male",
                "package_code": "package_none", "payment_choice": "full",
                "guests": [{"name": "Kenji", "explicit_gender": "male"}]}
        self.loop.turn("kenji-pkg", "Kenji, male, 18 to 21 November; show package prices")
        failed = self.loop.call("preview_package_prices", {"check_in": "2026-11-18",
            "check_out": "2026-11-21", "guest_count": 1, "room_type": "shared"},
            {"/package-price-preview": {"success": False, "error": "package preview unavailable",
                                  "write_performed": False}})
        self.assertFalse(failed["success"])
        self.assertEqual(len(self.loop.create_dispatches), 0)
        self.loop.turn("kenji-mixed", "Accommodation-only in mixed is fine; quote it")
        self.loop.call("check_availability", plan, {"/availability-check": availability_receipt(mixed)})
        quote = checked_staff_quote(plan, mixed, total=18000, deposit=10000)
        self.loop.call("quote_booking", plan,
            {"/availability-check": availability_receipt(mixed),
             "/booking-preview": quote})
        self.assertIn("180.00 EUR", self.loop.present())
        self.loop.turn("kenji-yes", "Yes, create that accommodation-only booking")
        self.loop.interpret("accept", "Yes, create that accommodation-only booking")
        prepared = owner.prepare_create({})
        self.assertEqual((prepared["check_in"], prepared["check_out"]),
                         ("2026-11-18", "2026-11-21"))
        self.assertEqual(prepared["guests"][0]["explicit_gender"], "male")
        responses = lambda route, body: create_recheck_receipt(mixed, body) if route == "/availability-check" else {
            "success": True, "created": True, "write_performed": True,
            "booking_id": "kenji-original-dates"}
        created = self.loop.call("create_booking_from_plan", prepared, responses)
        self.assertTrue(created["success"], created)
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)

    def test_r2_missing_eligibility_differs_from_real_unavailable_and_explicit_male_control(self):
        bed = self.beds(1, "male_only", "M")
        common = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 1,
                  "room_type": "shared", "room_preference": "male_only"}
        missing = self.loop.call("check_availability", common,
            {"/availability-check": availability_receipt(bed)})
        self.assertEqual(missing["availability_status"], "eligibility_required", missing)
        self.assertFalse(missing["unavailable"])
        real = self.loop.call("check_availability", {**common, "gender_preference": "male"},
            {"/availability-check": availability_receipt([], enough=False)})
        self.assertTrue(real["unavailable"], real)
        positive = self.loop.call("check_availability", {**common, "gender_preference": "male"},
            {"/availability-check": availability_receipt(bed)})
        self.assertTrue(positive["available"], positive)
        self.assertEqual(positive["selected_bed_codes"], ["M-B1"])


class OrdinaryCurrentPromptAcceptanceEvidence(unittest.TestCase):
    """R3 deterministic registered-loop tests; model output is retained and labelled."""
    def setUp(self):
        self.loop = DeterministicRegisteredLoop(self, "r3-payment")
        self.bed = [{"bed_code": "X-B1", "room_code": "X", "room_type": "mixed",
                     "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
        self.plan = {"check_in": "2026-12-01", "check_out": "2026-12-03", "guest_count": 1,
                     "room_type": "shared", "room_preference": "mixed",
                     "package_code": "package_none", "payment_choice": "full",
                     "guests": [{"name": "Hugo Laurent"}]}
        self.loop.turn("hugo-q", "Quote Hugo for a mixed bed")
        quote = checked_staff_quote(self.plan, self.bed, total=12000, deposit=6000)
        self.loop.call("quote_booking", self.plan,
            {"/availability-check": availability_receipt(self.bed),
             "/booking-preview": quote})
        self.loop.present()
    def tearDown(self):
        self.loop.close()

    def create(self):
        prepared = owner.prepare_create({})
        responses = lambda route, body: create_recheck_receipt(self.bed, body) if route == "/availability-check" else {
            "success": True, "created": True, "write_performed": True, "booking_id": "hugo-1"}
        return self.loop.call("create_booking_from_plan", prepared, responses)

    def test_hugo_payment_option_question_zero_then_contextual_yes_exactly_one(self):
        question = "Can I pay everything now?"
        self.loop.turn("hugo-payment-question", question)
        decision = self.loop.interpret("clarify", question)
        self.assertFalse(decision.get("create_ready", False), decision)
        self.assertEqual(len(self.loop.create_dispatches), 0)
        # A clarification can retain a revalidation-only preparation ticket, but
        # it cannot dispatch create without semantic booking acceptance.
        self.assertEqual(len(self.loop.create_dispatches), 0)
        yes = "Yes, please create the Hugo booking you just quoted."
        self.loop.turn("hugo-real-yes", yes)
        self.loop.interpret("accept", yes)
        self.create()
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)

    def test_ambiguous_payment_question_zero_create(self):
        raw = "Full payment?"
        self.loop.turn("ambiguous", raw)
        outcome = self.loop.interpret("clarify", raw, ambiguous=True)
        self.assertFalse(outcome.get("create_ready", False))
        self.assertEqual(self.loop.create_dispatches, [])

    def test_payment_plus_booking_acceptance_creates_once(self):
        raw = "Yes, book that exact offer and charge the full payment now."
        self.loop.turn("combined", raw)
        outcome = self.loop.interpret("accept", raw,
            completions={"payment_choice": {"value": "full", "evidence": "full payment"}})
        self.assertTrue(outcome["create_ready"], outcome)
        self.create()
        self.assertEqual(len(self.loop.create_dispatches), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
