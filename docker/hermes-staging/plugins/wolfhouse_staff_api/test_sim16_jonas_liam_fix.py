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
        self.trace.append({"kind": "tool_call", "tool": name})
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

    def present(self, model_result=None):
        """Finalize explicit model input unchanged, or build the default priced fixture."""
        if model_result is None:
            from wolfhouse.test_first_yes_owner import offline_quote_result
            rendered = offline_quote_result({"completed": True,
                "final_response": "UNCOACHED MODEL DRAFT",
                "messages": [{"role": "assistant", "content": "UNCOACHED MODEL DRAFT"}]})
        else:
            rendered = owner.finalize_offer_response(deepcopy(model_result))
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
        authored = ("25 to 27 October — four guests.\n"
                    "Four beds in the same mixed room.\n"
                    "Total and full payment: €480.\n"
                    "Shall I save this booking?")
        rendered = self.loop.present({"completed": True, "final_response": authored,
            "messages": [{"role": "tool", "content": json.dumps(result)},
                         {"role": "assistant", "content": authored}]})
        self.assertEqual(owner._transaction(lambda state, _ingress:
            state["presentation"]["displayed_text"]), authored)
        self.assertIn("€480", rendered)
        self.assertIn("full", rendered.lower())
        self.assertTrue(rendered.endswith("Shall I save this booking?"), rendered)

        yes = "Yes — book it for Jonas Bergström, Mia Chen, Noor Ali and Leo Costa."
        self.loop.turn("jonas-first-yes", yes)
        before_diagnostic = owner._read_owner_state(lambda state, _ingress: deepcopy(state))
        decision = self.loop.interpret("accept", yes, completions={"guests": [
            {"guest_index": i, "name": name, "evidence": name}
            for i, name in enumerate(("Jonas Bergström", "Mia Chen", "Noor Ali", "Leo Costa"))]})
        self.assertTrue(decision["diagnostic_only"], decision)
        self.assertNotIn("create_ready", decision)
        self.assertEqual(owner._read_owner_state(lambda state, _ingress: deepcopy(state)),
                         before_diagnostic, "diagnostic cannot complete names or authorize create")
        self.assertEqual(self.loop.create_dispatches, [])
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

    def test_sim22_becker_captured_registered_sequence_reaches_create(self):
        """Replay captured G3 check/quote/check/create args through registered tools."""
        # Committed R4 inventory stores the eligibility label as ``male preferred``;
        # the guest-facing request remains the canonical ``male_only`` preference.
        beds = self.beds(2, "male preferred")
        for row in beds:
            row["room_type"] = "shared"
        offered = {"check_in": "2026-11-11", "check_out": "2026-11-14",
                   "guest_count": 2, "room_type": "shared",
                   "room_preference": "male_only", "group_gender": "male"}
        availability = availability_receipt(beds)
        availability["selected_bed_codes"] = ["R4-B1", "R4-B2"]
        first_quote = {**offered, "package_code": "package_none",
                       "source": "agent_luna_whatsapp",
                       "selected_bed_codes": ["R4-B1", "R4-B2"]}
        first = checked_staff_quote(first_quote, beds, total=24000, deposit=20000)
        self.loop.turn("g3-quote", "Zwei Betten im Männerschlafsaal. Was kostet das?")
        self.loop.call("check_availability", {
            "client_slug": None, "check_in": "2026-11-11", "check_out": "2026-11-14",
            "guest_count": 2, "room_type": "shared", "room_preference": "male dorm",
        }, {"/availability-check": availability})
        self.loop.call("check_availability", offered, {"/availability-check": availability})
        self.loop.call("quote_booking", first_quote, {"/booking-preview": first})
        self.loop.present()

        names = [{"name": "Jonas Becker", "explicit_gender": "male"},
                 {"name": "Felix Becker", "explicit_gender": "male"}]
        accepted = {"check_in": "2026-11-11", "check_out": "2026-11-14",
                    "guest_count": 2, "package_code": "package_none",
                    "room_preference": "male_only", "room_type": "shared",
                    "guests": names, "payment_choice": "deposit", "language": "de",
                    "source": "agent_luna_whatsapp", "guest_name": "Jonas Becker",
                    "room_name_hints": names,
                    "selected_bed_codes": ["R4-B1", "R4-B2"]}
        second = checked_staff_quote(accepted, beds, total=24000, deposit=20000)
        acceptance_text = "Jonas Becker und Felix Becker. Anzahlung. Ja, bitte buchen."
        self.loop.turn("g3-accept", acceptance_text)
        semantic = {"action": "accept", "action_evidence": acceptance_text,
                    "ambiguous": False, "negated": False, "conditional": False,
                    "material_changes": [], "completions": {
                        "guests": [{"guest_index": i, "name": guest["name"],
                                    "evidence": guest["name"]}
                                   for i, guest in enumerate(names)]}}
        # Explicit deterministic model stand-in through the registered tool. This
        # is the normal runtime boundary, not the harness interpret/state injector.
        interpreted = self.loop.call("interpret_booking_turn", semantic, {})
        self.assertTrue(interpreted["success"], interpreted)
        self.loop.call("check_availability", {
            "check_in": "2026-11-11", "check_out": "2026-11-14", "guest_count": 2,
            "room_type": "shared", "room_preference": "male_only", "guests": names,
            "room_name_hints": names}, {"/availability-check": availability})
        self.loop.call("quote_booking", accepted, {"/booking-preview": second})
        recheck = {**accepted, "client_slug": None}
        self.loop.call("check_availability", recheck, {"/availability-check": availability})

        create_args = {"add_ons": [], "check_in": "2026-11-11",
            "check_out": "2026-11-14", "gender_preference": None,
            "group_gender": "male", "guest_count": 2, "guest_packages": [],
            "guests": names, "language": "de", "package_code": "package_none",
            "payment_choice": "deposit", "per_guest_payment_links": False,
            "room_name_hints": names, "room_preference": "male_only",
            "room_type": "shared", "selected_bed_codes": ["R4-B1", "R4-B2"],
            "source": "agent_luna_whatsapp", "confirm": True,
            "phone": "+99900002399", "guest_phone": "+99900002399",
            "guest_name": "Jonas Becker", "idempotency_key": "luna-66d43aca141f6dff"}
        sql_proofs = []
        def responses(route, body):
            if route == "/booking-preview":
                return second
            if route == "/availability-check":
                return create_recheck_receipt(beds, body)
            if route == "/booking-create-from-plan":
                run = subprocess.run(
                    ["node", "scripts/verify-luna-create-booking-occupants.js", "--payload"],
                    input=json.dumps(body), text=True, cwd=ROOT,
                    capture_output=True, timeout=90)
                self.assertTrue(run.stdout.strip(), {"returncode": run.returncode, "stderr": run.stderr})
                proof = json.loads(run.stdout)
                self.assertEqual(run.returncode, 0, {"proof": proof, "stderr": run.stderr})
                sql_proofs.append(proof)
                raise RuntimeError("isolated Staff SQL create/readback complete")
            self.fail(f"unexpected route {route}")
        with self.assertRaisesRegex(RuntimeError, "isolated Staff SQL create/readback complete"):
            self.loop.call("create_booking_from_plan", create_args, responses)
        self.assertEqual(len(sql_proofs), 1)
        self.assertTrue(sql_proofs[0]["ok"], sql_proofs[0])
        self.assertEqual(len(sql_proofs[0]["bookings"]), 1, sql_proofs[0])
        self.assertEqual([row["guest_name"] for row in sql_proofs[0]["occupants"]],
                         ["Jonas Becker", "Felix Becker"])
        self.assertEqual(sum(call["kind"] == "booking_create"
                             for call in sql_proofs[0]["sql_calls"]), 1)
        self.assertEqual(sql_proofs[0]["network_attempts"], [])
        self.assertEqual([row["tool"] for row in self.loop.trace
                          if row["kind"] == "tool_call"], [
            "check_availability", "check_availability", "quote_booking",
            "interpret_booking_turn", "check_availability", "quote_booking",
            "check_availability", "create_booking_from_plan",
        ])

    def test_fact_equivalent_second_staff_revision_promotes_checked_authority(self):
        """A checked payment completion advances Staff authority without minting consent."""
        beds = self.beds(2)
        names = [{"name": "Jonas Becker"}, {"name": "Felix Becker"}]
        offered = {"check_in": "2026-11-11", "check_out": "2026-11-14",
                   "guest_count": 2, "room_type": "shared", "room_preference": "mixed",
                   "package_code": "package_none",
                   "selected_bed_codes": [row["bed_code"] for row in beds],
                   "guests": names}
        first = checked_staff_quote(offered, beds, total=24000, deposit=20000)
        self.loop.turn("authority-q", "Quote this exact stay for Jonas Becker and Felix Becker")
        self.loop.call("quote_booking", offered, {"/booking-preview": first})
        self.loop.present()
        self.loop.turn("authority-accept", "Yes, please book that exact offer.")
        # The model completes payment through typed quote input, not a mutating
        # interpreter. Neither the guest turn nor the quote dispatches a create.
        self.assertEqual(self.loop.create_dispatches, [])

        completed = {**offered, "payment_choice": "deposit"}
        second = checked_staff_quote(completed, beds, total=24000, deposit=20000)
        second_result = self.loop.call("quote_booking", completed, {"/booking-preview": second})
        self.assertTrue(second_result.get("success"), second_result)
        authority = owner._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual((authority.get("presentation") or {}).get("quote_revision"),
                         authority.get("checked_offer"), authority)
        self.assertEqual(authority["checked_offer"], second["offer_revision"])
        self.assertEqual(authority["checked_offer"]["offer_fingerprint"],
                         second["offer_revision"]["offer_fingerprint"])
        self.assertEqual(authority["checked_offer"]["guest_bed_assignments"],
                         first["offer_revision"]["guest_bed_assignments"])
        self.assertEqual(self.loop.create_dispatches, [], self.loop.trace)

        def responses(route, body):
            if route == "/booking-preview":
                return second
            if route == "/availability-check":
                return create_recheck_receipt(beds, body)
            if route == "/booking-create-from-plan":
                self.assertEqual(body["accepted_offer"], second["offer_revision"])
                return {"success": True, "created": True, "write_performed": True,
                        "booking_id": "authority-one", "booking_code": "WH-AUTH"}
            self.fail(f"unexpected route {route}")

        created = self.loop.call("create_booking_from_plan", completed, responses)
        self.assertTrue(created["success"], created)
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)
        sent = self.loop.create_dispatches[0]
        self.assertEqual(sent["guests"], names)
        self.assertEqual(sent["selected_bed_codes"], offered["selected_bed_codes"])
        self.assertEqual(sent["payment_choice"], "deposit")
        replay = self.loop.call("create_booking_from_plan", completed, responses)
        self.assertTrue(replay.get("idempotent"), replay)
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)
        self.assertEqual(self.loop.create_dispatches[0]["idempotency_key"],
                         sent["idempotency_key"])
        from wolfhouse.test_first_yes_owner import offline_saved_confirmation
        rendered = owner.finalize_offer_response({"completed": True,
            "final_response": "UNCOACHED MODEL DRAFT",
            "messages": [{"role": "tool", "content": json.dumps(created)},
                         {"role": "assistant", "content": "UNCOACHED MODEL DRAFT"}]},
            rewrite_callback=offline_saved_confirmation)
        self.assertIn("WH-AUTH", rendered["final_response"])
        self.assertEqual(rendered["messages"][-1]["content"], rendered["final_response"])

    def test_sim22_becker_second_good_quote_carries_offer_into_registered_create(self):
        """Replay G3: quote -> accepted completion quote -> omitted-identity create."""
        beds = self.beds(2, "male_only", "R4")
        offered = {"check_in": "2026-11-11", "check_out": "2026-11-14",
                   "guest_count": 2, "room_type": "shared",
                   "room_preference": "male_only", "group_gender": "male",
                   "package_code": "package_none", "selected_bed_codes": ["R4-B1", "R4-B2"]}
        first = checked_staff_quote(offered, beds, total=24000, deposit=20000)
        self.loop.turn("g3-quote", "Zwei Betten im Männerschlafsaal. Was kostet das?")
        self.loop.call("quote_booking", offered, {"/booking-preview": first})
        self.loop.present()

        names = [{"name": "Jonas Becker", "explicit_gender": "male"},
                 {"name": "Felix Becker", "explicit_gender": "male"}]
        accepted = {**offered, "guest_name": "Jonas Becker", "guests": names,
                    "payment_choice": "deposit", "language": "de"}
        second = checked_staff_quote(accepted, beds, total=24000, deposit=20000)
        self.loop.turn("g3-accept", "Jonas Becker und Felix Becker. Anzahlung. Ja, bitte buchen.")
        self.loop.call("quote_booking", accepted, {"/booking-preview": second})

        def responses(route, body):
            if route == "/booking-preview":
                return second
            if route == "/availability-check":
                return create_recheck_receipt(beds, body)
            if route == "/booking-create-from-plan":
                self.assertEqual(body["accepted_offer"], second["offer_revision"])
                self.assertIs(body["require_offer_identity"], True)
                return {"success": True, "created": True, "write_performed": True,
                        "booking_id": "g3-one", "booking_code": "WH-G3"}
            self.fail(f"unexpected route {route}")

        # Exact captured failure shape: the model omits both owner-only fields.
        created = self.loop.call("create_booking_from_plan", accepted, responses)
        self.assertTrue(created["success"], created)
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)
        first_key = self.loop.create_dispatches[0]["idempotency_key"]
        replay = self.loop.call("create_booking_from_plan", accepted, responses)
        self.assertTrue(replay.get("idempotent"), replay)
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)
        self.assertEqual(self.loop.create_dispatches[0]["idempotency_key"], first_key)

        changed_cases = {
            "checkout": {**accepted, "check_out": "2026-11-15"},
            "payment": {**accepted, "payment_choice": "full"},
            "occupant": {**accepted, "guests": [names[0],
                {"name": "Karl Becker", "explicit_gender": "male"}]},
            "occupant_order": {**accepted, "guests": list(reversed(names))},
        }
        for label, changed in changed_cases.items():
            with self.subTest(label=label):
                refused = self.loop.call("create_booking_from_plan", changed, responses)
                self.assertFalse(refused["success"], refused)
                self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)

    def test_r1_names_after_quote_with_chosen_full_payment_dispatches_once(self):
        """Chosen full payment survives late name completion, not only full-only tariffs."""
        beds = self.beds(2)
        quoted = {"check_in": "2026-10-25", "check_out": "2026-10-27",
                  "guest_count": 2, "room_type": "shared", "room_preference": "mixed",
                  "package_code": "package_none", "payment_choice": "full", "guests": []}
        raw_quote = checked_staff_quote(quoted, beds, total=24000, deposit=10000,
                                        full_payment_only=False)
        self.loop.turn("chosen-full-quote", "Show me the full-payment total for two beds")
        result = self.loop.call("quote_booking", quoted,
            {"/availability-check": availability_receipt(beds),
             "/booking-preview": raw_quote})
        self.assertEqual(result["total_cents"], 24000)
        self.assertFalse(result["full_payment_only"])
        authored = ("Sun 25 Oct to Tue 27 Oct — 2 guests.\n"
                    "Total: €240.\nFull payment: €240.\n"
                    "Two beds in the same mixed room.\n"
                    "What are the guests' full names?")
        rendered = self.loop.present({"completed": True, "final_response": authored,
            "messages": [{"role": "tool", "content": json.dumps(result)},
                         {"role": "assistant", "content": authored}]})
        self.assertEqual(owner._transaction(lambda state, _ingress:
            state["presentation"]["displayed_text"]), authored)
        self.assertEqual(rendered,
            "Sun 25 Oct to Tue 27 Oct — 2 guests.\n"
            "Total: €240.\n"
            "Full payment: €240.\n"
            "Two beds in the same mixed room.\n"
            "What are the guests' full names?")

        yes = "Yes — book that exact offer for Jonas Bergström and Mia Chen."
        self.loop.turn("chosen-full-names", yes)
        before_diagnostic = owner._read_owner_state(lambda state, _ingress: deepcopy(state))
        decision = self.loop.interpret("accept", yes, completions={"guests": [
            {"guest_index": 0, "name": "Jonas Bergström", "evidence": "Jonas Bergström"},
            {"guest_index": 1, "name": "Mia Chen", "evidence": "Mia Chen"}]})
        self.assertTrue(decision["diagnostic_only"], decision)
        self.assertNotIn("create_ready", decision)
        self.assertEqual(owner._read_owner_state(lambda state, _ingress: deepcopy(state)),
                         before_diagnostic, "diagnostic cannot complete names or authorize create")
        self.assertEqual(self.loop.create_dispatches, [])
        names = [{"name": "Jonas Bergström"}, {"name": "Mia Chen"}]
        refreshed_plan = {**quoted, "guests": names}
        refreshed = checked_staff_quote(refreshed_plan, beds, total=24000, deposit=10000,
                                        full_payment_only=False)
        def responses(route, body):
            if route == "/booking-preview":
                return refreshed
            if route == "/availability-check":
                return create_recheck_receipt(beds, body)
            return {"success": True, "created": True, "write_performed": True,
                    "booking_id": "chosen-full-one", "booking_code": "WH-CHOSEN-FULL"}
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

    def test_r4_chosen_full_incomplete_unnamed_refresh_never_dispatches_create(self):
        """Late names cannot turn an incomplete Staff refresh into create authority."""
        beds = self.beds(2)
        quoted = {"check_in": "2026-11-23", "check_out": "2026-11-26",
                  "guest_count": 2, "room_type": "shared", "room_preference": "mixed",
                  "package_code": "package_none", "payment_choice": "full", "guests": []}
        raw_quote = checked_staff_quote(quoted, beds, total=24000, deposit=10000,
                                        full_payment_only=False)
        self.loop.turn("r4-quote", "Two mixed beds; I choose full payment. Please quote.")
        result = self.loop.call("quote_booking", quoted,
            {"/availability-check": availability_receipt(beds),
             "/booking-preview": raw_quote})
        authored = ("Mon 23 Nov to Thu 26 Nov — 2 guests.\n"
                    "Total: €240.\nFull payment: €240.\n"
                    "Two beds in the same mixed room.\n"
                    "What are the guests' full names?")
        rendered = self.loop.present({"completed": True, "final_response": authored,
            "messages": [{"role": "tool", "content": json.dumps(result)},
                         {"role": "assistant", "content": authored}]})
        self.assertEqual(owner._transaction(lambda state, _ingress:
            state["presentation"]["displayed_text"]), authored)
        self.assertEqual(rendered,
            "Mon 23 Nov to Thu 26 Nov — 2 guests.\n"
            "Total: €240.\n"
            "Full payment: €240.\n"
            "Two beds in the same mixed room.\n"
            "What are the guests' full names?")

        names = [{"name": "Aoife Byrne"}, {"name": "Ciara Walsh"}]
        self.loop.turn("r4-names", "Yes, book it for Aoife Byrne and Ciara Walsh.")
        incomplete_refresh = checked_staff_quote(
            {**quoted, "guests": []}, beds, total=24000, deposit=10000,
            full_payment_only=False)
        def responses(route, body):
            if route == "/booking-preview":
                return incomplete_refresh
            if route == "/availability-check":
                return create_recheck_receipt(beds, body)
            return {"success": True, "created": True, "write_performed": True,
                    "booking_id": "must-not-dispatch"}
        result = self.loop.call("create_booking_from_plan", {"guests": names}, responses)

        self.assertFalse(result.get("success"), result)
        self.assertEqual(self.loop.create_dispatches, [], self.loop.trace)

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
        self.assertIn("€360", reply)
        self.loop.turn("tl-yes", "Yes, book that mixed room for Tom Wood and Liam Wernike")
        self.loop.interpret("accept", "Yes, book that mixed room for Tom Wood and Liam Wernike")
        # Read-only observation: invoking prepare_create here would consume the
        # first refresh transition before the registered handler can perform it.
        prepared = owner._transaction(lambda state, _ingress: deepcopy(state["plan"]))
        self.assertEqual(prepared["room_preference"], "mixed")
        def responses(route, body):
            if route == "/booking-preview":
                return raw_quote
            if route == "/availability-check":
                return create_recheck_receipt(mixed, body)
            if route == "/booking-create-from-plan":
                self.assertEqual(body["accepted_offer"], raw_quote["offer_revision"])
                return {"success": True, "created": True, "write_performed": True,
                        "booking_id": "tl-1"}
            self.fail(f"unexpected route {route}")
        created = self.loop.call("create_booking_from_plan", prepared, responses)
        self.assertTrue(created["success"], created)
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
        self.assertIn("€180", self.loop.present())
        self.loop.turn("kenji-yes", "Yes, create that accommodation-only booking")
        self.loop.interpret("accept", "Yes, create that accommodation-only booking")
        prepared = owner._transaction(lambda state, _ingress: deepcopy(state["plan"]))
        self.assertEqual((prepared["check_in"], prepared["check_out"]),
                         ("2026-11-18", "2026-11-21"))
        self.assertEqual(prepared["guests"][0]["explicit_gender"], "male")
        def responses(route, body):
            if route == "/booking-preview":
                return quote
            if route == "/availability-check":
                return create_recheck_receipt(mixed, body)
            if route == "/booking-create-from-plan":
                self.assertEqual(body["accepted_offer"], quote["offer_revision"])
                return {"success": True, "created": True, "write_performed": True,
                        "booking_id": "kenji-original-dates"}
            self.fail(f"unexpected route {route}")
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

    def test_sim22_emma_structured_unsure_and_no_preserve_women_stock(self):
        bed = self.beds(1, "female_only", "F")
        common = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 1,
                  "room_type": "shared", "room_preference": "female_only",
                  "package_code": "package_none", "guests": [{"name": "Emma"}]}
        for status, reason in (("unsure", "room_eligibility_unknown"),
                               ("no", "room_eligibility_incompatible")):
            receipt = {**availability_receipt(bed), "girls_room_available": True,
                       "room_options": {"girls_room_available": True},
                       "room_eligibility": {"status": status,
                           "requested_room_preference": "female_only",
                           "affected_guest_indices": [0], "reason_code": reason,
                           "question_kind": ("confirm_room_eligibility" if status == "unsure" else None)}}
            with self.subTest(status=status):
                result = self.loop.call("check_availability", common,
                    {"/availability-check": deepcopy(receipt)})
                self.assertEqual(result["availability_status"], "eligibility_required", result)
                self.assertIs(result["girls_room_available"], True, result)
                self.assertIs(result["room_options"]["girls_room_available"], True, result)
                self.assertEqual(result["room_eligibility"]["status"], status)
                self.assertEqual(result["next_action"], "ask_room_eligibility")
                quote_calls = []
                self.loop.turn(f"emma-{status}-quote", "Please quote the requested women-only room")
                def quote_responses(route, body):
                    quote_calls.append(route)
                    if route == "/availability-check":
                        return deepcopy(receipt)
                    self.fail(f"structured {status} reached {route}")
                quoted = self.loop.call("quote_booking", common, quote_responses)
                self.assertFalse(quoted["success"], quoted)
                self.assertEqual(quote_calls, ["/availability-check"])
                self.assertEqual(quoted["room_eligibility"]["status"], status)
                self.assertEqual(quoted["availability_status"], "eligibility_required", quoted)
                self.assertFalse(quoted["available"], quoted)
                self.assertFalse(quoted["unavailable"], quoted)

    def test_r5_zero_stock_remains_unavailable_with_structured_unsure_or_no(self):
        openings = {"en": "Please quote the requested room",
                    "es": "Quiero reservar la habitación solicitada",
                    "fr": "Je voudrais réserver la chambre demandée",
                    "de": "Ich möchte das gewünschte Zimmer buchen"}
        # Explicit offline model-authored replies: the production finalizer must
        # preserve unavailable truth, not generate legacy refusal/eligibility copy.
        replies = {"en": "There are no beds available for those dates.",
                   "es": "No hay camas disponibles para esas fechas.",
                   "fr": "Il n’y a pas de lits disponibles pour ces dates.",
                   "de": "Für diese Daten sind keine Betten verfügbar."}
        for language, opening in openings.items():
            for status, question_kind in (("unsure", "confirm_room_eligibility"), ("no", None)):
                for with_tool_message in (False, True):
                    with self.subTest(language=language, status=status,
                                      with_tool_message=with_tool_message):
                        loop = DeterministicRegisteredLoop(
                            self, f"zero-stock-{language}-{status}-{with_tool_message}")
                        try:
                            common = {"check_in": "2026-11-18", "check_out": "2026-11-21",
                                      "guest_count": 1, "room_type": "shared",
                                      "room_preference": "female_only",
                                      "package_code": "package_none", "language": language,
                                      "guests": [{"name": "Emma"}]}
                            receipt = {**availability_receipt([], enough=False),
                                       "room_eligibility": {"status": status,
                                           "requested_room_preference": "female_only",
                                           "affected_guest_indices": [0],
                                           "reason_code": ("room_eligibility_unknown"
                                                           if status == "unsure"
                                                           else "room_eligibility_incompatible"),
                                           "question_kind": question_kind}}
                            loop.turn(f"zero-stock-{language}-{status}", opening)
                            quoted = loop.call("quote_booking", common,
                                {"/availability-check": receipt})
                            self.assertEqual(quoted["availability_status"], "unavailable", quoted)
                            self.assertTrue(quoted["unavailable"], quoted)
                            self.assertFalse(quoted["success"], quoted)
                            self.assertFalse(quoted["available"], quoted)
                            self.assertEqual([row["route"] for row in loop.staff],
                                             ["/availability-check"])
                            expected = replies[language]
                            messages = [{"role": "assistant",
                                         "content": expected}]
                            if with_tool_message:
                                messages.insert(0, {"role": "tool", "content": json.dumps(quoted)})
                            rendered = owner.finalize_offer_response({
                                "completed": True,
                                "final_response": expected,
                                "messages": messages})
                            self.assertEqual(rendered["final_response"], expected)
                            self.assertEqual(rendered["messages"][-1]["content"], expected)
                            self.assertEqual(rendered["response_intent"]["kind"], "offer_unavailable")
                            self.assertEqual(rendered["response_intent"]["facts"]["availability_status"],
                                             "unavailable")
                            state = owner._transaction(lambda state, _ingress: deepcopy(state))
                            self.assertFalse(state.get("checked_offer"), state)
                            self.assertFalse(state.get("presentation"), state)
                            refused = loop.call("create_booking_from_plan", common, {})
                            self.assertFalse(refused["success"], refused)
                            self.assertEqual(loop.create_dispatches, [], loop.trace)
                            self.assertEqual([row["route"] for row in loop.staff],
                                             ["/availability-check"])
                            # A routing contradiction is a product failure, not a
                            # reason to weaken unavailable/no-dispatch assertions.
                            self.assertNotEqual(quoted.get("next_action"), "ask_room_eligibility", quoted)
                        finally:
                            loop.close()

    def test_r5_successful_quote_carries_structured_yes_from_staff(self):
        bed = self.beds(1, "female_only", "F")
        plan = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 1,
                "room_type": "shared", "room_preference": "female_only",
                "package_code": "package_none", "guests": [{"name": "Emma", "explicit_gender": "female"}]}
        eligibility = {"status": "yes", "requested_room_preference": "female_only",
                       "affected_guest_indices": [], "reason_code": "room_eligibility_confirmed",
                       "question_kind": None}
        receipt = {**availability_receipt(bed), "room_eligibility": eligibility}
        quote = checked_staff_quote(plan, bed)
        self.loop.turn("structured-yes-quote", "Please quote the requested room")
        quoted = self.loop.call("quote_booking", plan,
            {"/availability-check": receipt, "/booking-preview": quote})
        self.assertTrue(quoted["success"], quoted)
        self.assertEqual(quoted["room_eligibility"], eligibility)
        self.assertEqual(quoted["room_decision"], {"structured": True, **eligibility})

    def test_r5_finalizer_skips_non_object_json_tool_results(self):
        self.loop.turn("non-object-tools", "Continue")
        for value in ([], None, 7, "text"):
            with self.subTest(value=value):
                result = owner.finalize_offer_response({"completed": True,
                    "final_response": "UNCHANGED",
                    "messages": [{"role": "user", "content": "Continue"},
                                 {"role": "tool", "content": json.dumps(value)},
                                 {"role": "assistant", "content": "UNCHANGED"}]})
                self.assertEqual(result["final_response"], "UNCHANGED")

    def test_r5_offline_ingress_installed_owner_hook_skips_non_object_tool_results(self):
        from agent import conversation_loop
        from wolfhouse.offline_ingress_harness import gateway_ingress
        installed = conversation_loop.run_conversation
        captured = []
        try:
            for index, value in enumerate(([], None, 7, "text")):
                with self.subTest(value=value):
                    def model(agent, text, *args, _value=value, **kwargs):
                        return {"completed": True, "final_response": "UNCHANGED",
                                "messages": [{"role": "user", "content": text},
                                             {"role": "tool", "content": json.dumps(_value)},
                                             {"role": "assistant", "content": "UNCHANGED"}]}
                    conversation_loop.run_conversation = model
                    owner.install_owner_hook()
                    def call(text):
                        result = conversation_loop.run_conversation(self.loop.agent, text)
                        captured.append(result)
                        return result
                    gateway_ingress(self.loop.agent, "Continue", f"non-object-ingress-{index}", call)
                    self.assertEqual(captured[-1]["final_response"], "UNCHANGED")
                    self.assertTrue(owner.quote_owner_hook_ready(conversation_loop.run_conversation))
        finally:
            conversation_loop.run_conversation = installed

    def test_r4_structured_eligibility_renders_from_status_room_and_affected_people(self):
        expected = {
            "en": ("Is Bea eligible for the requested women-only room?",
                   "The requested women-only room is not compatible with Bea's guest details. Would you like to see other room options?"),
            "es": ("¿Puede Bea alojarse en la habitación solicitada solo para mujeres?",
                   "La habitación solicitada solo para mujeres no es compatible con los datos de Bea. ¿Quieres ver otras opciones de habitación?"),
            "fr": ("Est-ce que Bea peut séjourner dans la chambre demandée réservée aux femmes ?",
                   "La chambre demandée réservée aux femmes n’est pas compatible avec les informations de Bea. Voulez-vous voir d’autres options de chambre ?"),
            "de": ("Kann Bea im gewünschten Frauenzimmer übernachten?",
                   "Das gewünschte Frauenzimmer ist mit den Angaben zu Bea nicht vereinbar. Möchten Sie andere Zimmeroptionen sehen?"),
        }
        openings = {"en": "Please quote this room", "es": "Quiero reservar esta habitación",
                    "fr": "Je voudrais réserver cette chambre", "de": "Ich möchte dieses Zimmer buchen"}
        for language, copies in expected.items():
            for status, expected_copy in zip(("unsure", "no"), copies):
                with self.subTest(language=language, status=status):
                    loop = DeterministicRegisteredLoop(self, f"structured-{language}-{status}")
                    try:
                        beds = self.beds(2, "female_only", "F")
                        plan = {"check_in": "2026-11-18", "check_out": "2026-11-21",
                                "guest_count": 2, "room_type": "shared",
                                "room_preference": "female_only", "package_code": "package_none",
                                "language": language, "guests": [{"name": "Ana"}, {"name": "Bea"}]}
                        receipt = {**availability_receipt(beds), "girls_room_available": True,
                                   "room_eligibility": {"status": status,
                                       "requested_room_preference": "female_only",
                                       "affected_guest_indices": [1],
                                       "reason_code": ("room_eligibility_unknown" if status == "unsure"
                                                       else "room_eligibility_incompatible"),
                                       "question_kind": ("confirm_room_eligibility" if status == "unsure" else None)}}
                        loop.turn(f"structured-{language}-{status}", openings[language])
                        quoted = loop.call("quote_booking", plan, {"/availability-check": receipt})
                        self.assertEqual(quoted["room_decision"]["affected_guest_indices"], [1])
                        # Scripted model prose, not production-owned eligibility copy.
                        model_result = {"completed": True, "final_response": expected_copy,
                            "messages": [{"role": "tool", "content": json.dumps(quoted)},
                                         {"role": "assistant", "content": expected_copy}]}
                        before = owner._transaction(lambda state, _ingress: deepcopy(state))
                        self.assertEqual(loop.present(model_result), expected_copy)
                        self.assertEqual(owner._transaction(lambda state, _ingress: deepcopy(state)), before)
                        refused = loop.call("create_booking_from_plan", plan, {})
                        self.assertFalse(refused["success"], refused)
                        self.assertEqual(loop.create_dispatches, [])
                    finally:
                        loop.close()

    def test_r4_real_no_stock_is_not_overwritten_by_eligibility_copy(self):
        plan = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 1,
                "room_type": "shared", "room_preference": "female_only",
                "package_code": "package_none", "language": "en", "guests": [{"name": "Emma"}]}
        self.loop.turn("no-stock", "Please check the women-only room")
        quoted = self.loop.call("quote_booking", plan,
            {"/availability-check": availability_receipt([], enough=False)})
        self.assertEqual(quoted["availability_status"], "unavailable")
        self.assertNotEqual(quoted.get("next_action"), "ask_room_eligibility")
        # Explicit offline authoring fixture; the real finalizer owns intent and authority.
        expected = 'There are no beds available for those dates.'
        rendered = owner.finalize_offer_response({'completed': True,
            'final_response': expected,
            'messages': [{'role': 'tool', 'content': json.dumps(quoted)},
                         {'role': 'assistant', 'content': expected}]})
        self.assertEqual(rendered['final_response'], expected)
        self.assertEqual(rendered['messages'][-1]['content'], expected)
        self.assertEqual(rendered['response_intent']['kind'], 'offer_unavailable')
        self.assertEqual(rendered['response_intent']['facts']['availability_status'], 'unavailable')
        state = owner._transaction(lambda state, _ingress: deepcopy(state))
        self.assertIsNone(state.get('checked_offer'), state)
        self.assertIsNone(state.get('presentation'), state)
        refused = self.loop.call('create_booking_from_plan', plan, {})
        self.assertFalse(refused['success'], refused)
        self.assertEqual(self.loop.create_dispatches, [])
        self.assertEqual([row['route'] for row in self.loop.staff], ['/availability-check'])

    def test_r4_german_equal_total_uses_noun_capitalization_in_both_render_branches(self):
        for complete in (False, True):
            with self.subTest(complete=complete):
                loop = DeterministicRegisteredLoop(self, f"german-equality-{complete}")
                try:
                    beds = self.beds(1)
                    guests = [{"name": "Raj"}] if complete else []
                    plan = {"check_in": "2026-11-18", "check_out": "2026-11-21",
                            "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                            "package_code": "package_none", "payment_choice": "full",
                            "language": "de", "guests": guests}
                    quote = checked_staff_quote(plan, beds, total=8000, deposit=8000,
                                                full_payment_only=True)
                    loop.turn(f"german-equality-{complete}", "Vollständige Zahlung, bitte")
                    quoted = loop.call("quote_booking", plan,
                        {"/availability-check": availability_receipt(beds), "/booking-preview": quote})
                    # Scripted model copy; exercise both real presentation branches.
                    question = ("Soll ich diese Buchung speichern?" if complete
                                else "Wie lautet dein vollständiger Name?")
                    authored = ("18. bis 21. November — eine Person.\n"
                                "Ein Bett im gemischten Zimmer.\n"
                                "Gesamt und jetzt fällig: €80 (vollständige Zahlung).\n" + question)
                    rendered = loop.present({"completed": True, "final_response": authored,
                        "messages": [{"role": "tool", "content": json.dumps(quoted)},
                                     {"role": "assistant", "content": authored}]})
                    state = owner._transaction(lambda state, _ingress: deepcopy(state))
                    self.assertEqual(state["presentation"]["displayed_text"], authored)
                    self.assertEqual(bool(state.get("checked_offer")), complete)
                    self.assertEqual(quoted["total_cents"], 8000)
                    self.assertEqual(loop.create_dispatches, [])
                    self.assertIn("(vollständige Zahlung).", rendered)
                    self.assertNotIn("vollständige zahlung", rendered)
                    self.assertEqual(rendered.count("€80"), 1, rendered)
                finally:
                    loop.close()

    def test_sim22_emma_yes_registered_quote_render_and_isolated_persistence(self):
        bed = self.beds(1, "female preferred", "R5")
        bed[0]["room_type"] = "shared"
        plan = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 1,
                "room_type": "shared", "room_preference": "female_only", "package_code": "package_none",
                "payment_choice": "full", "language": "en",
                "guests": [{"name": "Emma", "explicit_gender": "female"}]}
        receipt = {**availability_receipt(bed), "girls_room_available": True,
                   "room_eligibility": {"status": "yes", "requested_room_preference": "female_only",
                       "affected_guest_indices": [], "reason_code": "room_eligibility_confirmed",
                       "question_kind": None}}
        quote = checked_staff_quote(plan, bed, total=12000, deposit=10000)
        quote["room_eligibility"] = receipt["room_eligibility"]
        self.loop.turn("emma-yes-quote", "I am eligible for the women-only room; quote it")
        quoted = self.loop.call("quote_booking", plan,
            {"/availability-check": receipt, "/booking-preview": quote})
        self.assertTrue(quoted["success"], quoted)
        authored = ("18 to 21 November — one guest.\n"
                    "One bed in a shared room for Emma.\n"
                    "Total and full payment: €120.\n"
                    "Shall I save this booking?")
        rendered = self.loop.present({"completed": True, "final_response": authored,
            "messages": [{"role": "tool", "content": json.dumps(quoted)},
                         {"role": "assistant", "content": authored}]}).casefold()
        state = owner._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual(state["presentation"]["displayed_text"], authored)
        self.assertEqual(state["checked_offer"], quoted["offer_revision"])
        self.assertEqual(self.loop.create_dispatches, [])
        self.assertIn("one bed in a shared room for emma.", rendered)
        self.assertNotIn("emma:", rendered)
        accepted = "Yes, create that exact booking for Emma."
        self.loop.turn("emma-yes-accept", accepted)
        interpreted = self.loop.call("interpret_booking_turn", {
            "action": "accept", "action_evidence": accepted, "ambiguous": False,
            "negated": False, "conditional": False, "material_changes": [], "completions": {}}, {})
        self.assertTrue(interpreted["success"], interpreted)
        proofs = []
        def responses(route, body):
            if route == "/booking-preview":
                return quote
            if route == "/availability-check":
                return {**create_recheck_receipt(bed, body), "room_eligibility": receipt["room_eligibility"]}
            if route == "/booking-create-from-plan":
                run = subprocess.run(["node", "scripts/verify-luna-create-booking-occupants.js", "--payload"],
                    input=json.dumps(body), text=True, cwd=ROOT, capture_output=True, timeout=90)
                self.assertEqual(run.returncode, 0, {"stdout": run.stdout, "stderr": run.stderr})
                proofs.append(json.loads(run.stdout))
                raise RuntimeError("isolated Emma Staff SQL create/readback complete")
            self.fail(f"unexpected route {route}")
        with self.assertRaisesRegex(RuntimeError, "isolated Emma Staff SQL create/readback complete"):
            self.loop.call("create_booking_from_plan", {}, responses)
        self.assertEqual(len(proofs), 1)
        self.assertEqual(len(proofs[0]["bookings"]), 1)
        self.assertEqual(proofs[0]["occupants"][0]["guest_name"], "Emma")
        self.assertEqual(proofs[0]["occupants"][0]["assigned_bed_code"], "R5-B1")
        self.assertEqual(proofs[0]["network_attempts"], [])

    def test_sim22_complete_offer_equal_total_has_one_payment_line(self):
        bed = self.beds(1, "mixed", "R9")
        plan = {"check_in": "2026-11-18", "check_out": "2026-11-21", "guest_count": 1,
                "room_type": "shared", "room_preference": "mixed", "package_code": "package_none",
                "payment_choice": "full", "language": "en", "guests": [{"name": "Raj"}]}
        quote = checked_staff_quote(plan, bed, total=8000, deposit=8000, full_payment_only=True)
        self.loop.turn("raj-equal", "Raj, full payment please")
        quoted = self.loop.call("quote_booking", plan,
            {"/availability-check": availability_receipt(bed), "/booking-preview": quote})
        # Scripted model wording, not a production canned-copy or model-quality test.
        authored = ("Wed 18 Nov to Sat 21 Nov — one guest, Raj.\n"
                    "One bed in a mixed shared room.\n"
                    "Total and due now: €80 (full payment).\n"
                    "Shall I save this booking?")
        rendered = self.loop.present({"completed": True, "final_response": authored,
            "messages": [{"role": "tool", "content": json.dumps(quoted)},
                         {"role": "assistant", "content": authored}]})
        state = owner._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual(state["presentation"]["displayed_text"], authored)
        self.assertEqual(state["checked_offer"], quoted["offer_revision"])
        self.assertEqual(quoted["total_cents"], 8000)
        self.assertEqual(quoted["payment_link_amount_cents"], 8000)
        self.assertEqual(self.loop.create_dispatches, [])
        self.assertEqual(rendered.count("€80"), 1, rendered)
        self.assertIn("Total and due now: €80 (full payment).", rendered)
        self.assertNotIn("deposit", rendered.casefold())

    def test_sim22_german_actual_male_preferred_label_is_localized(self):
        beds = self.beds(2, "male preferred", "R4")
        for row in beds:
            row["room_type"] = "shared"
        plan = {"check_in": "2026-11-11", "check_out": "2026-11-14", "guest_count": 2,
                "room_type": "shared", "room_preference": "male_only", "package_code": "package_none",
                "payment_choice": "deposit", "language": "de",
                "guests": [{"name": "Jonas Becker", "explicit_gender": "male"},
                           {"name": "Felix Becker", "explicit_gender": "male"}]}
        quote = checked_staff_quote(plan, beds, total=24000, deposit=20000)
        self.loop.turn("becker-de-copy", "Bitte zeigt das Angebot auf Deutsch")
        self.loop.call("quote_booking", plan, {"/availability-check": availability_receipt(beds),
                                               "/booking-preview": quote})
        rendered = self.loop.present()
        self.assertIn("im selben Mehrbettzimmer", rendered)
        self.assertNotIn("im selben room", rendered)
        self.assertNotIn("Männerzimmer", rendered)


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
        # The registered create owns prepare -> Staff refresh -> dispatch; a
        # separate test-side prepare would consume that transition prematurely.
        refreshed = checked_staff_quote(self.plan, self.bed, total=12000, deposit=6000)
        def responses(route, body):
            if route == "/booking-preview":
                return refreshed
            if route == "/availability-check":
                return create_recheck_receipt(self.bed, body)
            if route == "/booking-create-from-plan":
                self.assertEqual(body["accepted_offer"], refreshed["offer_revision"])
                return {"success": True, "created": True, "write_performed": True,
                        "booking_id": "hugo-1"}
            self.fail(f"unexpected route {route}")
        result = self.loop.call("create_booking_from_plan", {}, responses)
        self.assertTrue(result["success"], result)
        return result

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
        refreshed = checked_staff_quote(self.plan, self.bed, total=12000, deposit=6000)
        def responses(route, body):
            if route == "/booking-preview":
                return refreshed
            if route == "/availability-check":
                return create_recheck_receipt(self.bed, body)
            if route == "/booking-create-from-plan":
                return {"success": True, "created": True, "write_performed": True,
                        "booking_id": "hugo-1", "booking_code": "WH-HUGO"}
            self.fail(f"unexpected route {route}")
        created = self.loop.call("create_booking_from_plan", {"payment_choice": "full"}, responses)
        self.assertTrue(created["success"], created)
        self.assertEqual(len(self.loop.create_dispatches), 1)
        sent = self.loop.create_dispatches[0]
        self.assertEqual(sent["payment_choice"], "full")
        self.assertEqual(sent["guests"], self.plan["guests"])
        self.assertEqual(sent["selected_bed_codes"], ["X-B1"])
        self.assertEqual(sent["accepted_offer"], refreshed["offer_revision"])
        self.assertEqual(sent["accepted_offer"]["offer_fingerprint"],
                         refreshed["offer_revision"]["offer_fingerprint"])
        self.assertEqual([row["route"] for row in self.loop.staff
                          if row["route"] == "/booking-preview"],
                         ["/booking-preview", "/booking-preview"])
        replay = self.loop.call("create_booking_from_plan", {"payment_choice": "full"}, responses)
        self.assertTrue(replay.get("idempotent"), replay)
        self.assertEqual(len(self.loop.create_dispatches), 1, self.loop.trace)
        self.assertEqual(self.loop.create_dispatches[0]["idempotency_key"], sent["idempotency_key"])
        self.assertEqual(sum(row["kind"] == "rendered_reply" for row in self.loop.trace), 1,
                         "no second confirmation question was rendered")
        from wolfhouse.test_first_yes_owner import offline_saved_confirmation
        rendered = owner.finalize_offer_response({"completed": True,
            "final_response": "UNCOACHED MODEL DRAFT",
            "messages": [{"role": "tool", "content": json.dumps(created)},
                         {"role": "assistant", "content": "UNCOACHED MODEL DRAFT"}]},
            rewrite_callback=offline_saved_confirmation)
        self.assertIn("WH-HUGO", rendered["final_response"])
        self.assertEqual(rendered["messages"][-1]["content"], rendered["final_response"])


class StockPrecedenceBoundaryTests(unittest.TestCase):
    """Registered quote controls: stock truth and eligibility remain distinct."""

    def test_registered_stock_and_eligibility_precedence(self):
        beds = RegisteredBoundaryEvidence.beds(1, 'female_only', 'F')
        plan = {'check_in': '2026-11-18', 'check_out': '2026-11-21',
                'guest_count': 1, 'room_type': 'shared', 'room_preference': 'female_only',
                'package_code': 'package_none', 'guests': [{'name': 'Emma'}]}
        yes = {'status': 'yes', 'requested_room_preference': 'female_only',
               'affected_guest_indices': [], 'reason_code': 'room_eligibility_confirmed',
               'question_kind': None}
        unsure = {**yes, 'status': 'unsure', 'affected_guest_indices': [0],
                  'reason_code': 'room_eligibility_unknown', 'question_kind': 'confirm_room_eligibility'}
        no = {**yes, 'status': 'no', 'affected_guest_indices': [0],
              'reason_code': 'room_eligibility_incompatible'}
        positive = availability_receipt(beds)
        no_stock = {**availability_receipt([], enough=False), 'reply_draft': 'Staff stock fact'}
        cases = [
            ('local-no-stock', no_stock, {}, 'unavailable', False),
            ('local-conflict-no-stock', no_stock,
             {'guests': [{'name': 'Emma', 'explicit_gender': 'male'}]}, 'unavailable', False),
            ('explicit-unavailable', {'success': True, 'availability_status': 'unavailable',
                 'next_action': 'offer_accommodation_or_change_dates', 'reply_draft': 'Staff stock fact'},
             {}, 'unavailable', False),
            ('positive-missing-eligibility', positive, {}, 'eligibility_required', False),
            ('positive-structured-yes', {**positive, 'room_eligibility': yes},
             {}, 'available', True),
            ('positive-local-yes', positive,
             {'guests': [{'name': 'Emma', 'explicit_gender': 'female'}]}, 'available', True),
            ('positive-structured-no', {**positive, 'room_eligibility': no},
             {}, 'eligibility_required', False),
            ('positive-structured-unsure', {**positive, 'room_eligibility': unsure},
             {}, 'eligibility_required', False),
            ('needs-clarification-false-stock', {**no_stock, 'needs_clarification': True,
                 'room_eligibility': unsure}, {}, 'eligibility_required', False),
            ('needs-clarification-local-false-stock', {**no_stock, 'needs_clarification': True},
             {}, 'eligibility_required', False),
            ('failed-staff', {'success': False, 'has_enough_beds': False,
                 'error': 'offline_lookup_failed', 'room_eligibility': yes}, {}, 'unclear', False),
            ('failed-staff-local-unresolved', {'success': False, 'has_enough_beds': False,
                 'error': 'offline_lookup_failed'}, {}, 'eligibility_required', False),
        ]
        for label, receipt, changes, expected, priced in cases:
            with self.subTest(case=label):
                loop = DeterministicRegisteredLoop(self, label)
                try:
                    args = {**deepcopy(plan), **changes}
                    raw = deepcopy(receipt)
                    loop.turn(label, 'Please quote the women-only room')
                    responses = {'/availability-check': receipt}
                    if priced:
                        responses['/booking-preview'] = checked_staff_quote(args, beds)
                    quoted = loop.call('quote_booking', args, responses)
                    self.assertEqual(receipt, raw)
                    self.assertEqual(quoted['success'], priced, quoted)
                    if priced:
                        self.assertEqual(quoted['availability']['status'], 'checked', quoted)
                        self.assertTrue(quoted['offer_revision']['availability_checked'])
                        self.assertEqual(quoted['total_cents'], 48000)
                    else:
                        self.assertEqual(quoted['availability_status'], expected, quoted)
                        self.assertEqual(quoted['unavailable'], expected == 'unavailable', quoted)
                    self.assertEqual([row['route'] for row in loop.staff],
                        ['/availability-check', '/booking-preview'] if priced else ['/availability-check'])
                    if isinstance(receipt.get('room_eligibility'), dict):
                        self.assertEqual(quoted['room_eligibility'], receipt['room_eligibility'])
                    if not priced:
                        for key in ('offer_revision', 'total_cents', 'deposit_required_cents'):
                            self.assertIsNone(quoted[key], quoted)
                        self.assertFalse(quoted['write_performed'])
                        state = owner._transaction(lambda state, _ingress: deepcopy(state))
                        self.assertIsNone(state.get('checked_offer'), state)
                        self.assertIsNone(state.get('presentation'), state)
                        refused = loop.call('create_booking_from_plan', args, {})
                        self.assertFalse(refused['success'], refused)
                        self.assertEqual([row['route'] for row in loop.staff], ['/availability-check'])
                    if expected == 'unavailable':
                        self.assertEqual(quoted['next_action'], receipt['next_action'])
                        self.assertEqual(quoted['reply_draft'], receipt['reply_draft'])
                        self.assertTrue(quoted['room_decision'].get('clarification_needed')
                                        or quoted['room_decision'].get('conflict'))
                    if label in ('positive-missing-eligibility',
                                 'needs-clarification-local-false-stock'):
                        self.assertEqual(quoted['next_action'], 'ask_room_eligibility')
                    self.assertEqual(loop.create_dispatches, [])
                finally:
                    loop.close()


class AnonymousSlotControls(unittest.TestCase):
    """Anonymous-slot controls retained from the independent Sim16 safety review.

    Use the real registered tools, owner SessionDB and checked-offer builder.
    Only external Staff transport is intercepted. A positive dispatch deliberately
    returns unsuccessful offline interception: it is not evidence of persistence.
    """

    def probe(self, label, old, new, *, mode='normal', plan_extra=None,
              expect_dispatch=False, pre_refresh_refusal=False,
              require_no_inherited_facts=False):
        loop = DeterministicRegisteredLoop(self, 'anonymous-slot-' + label)
        try:
            beds = RegisteredBoundaryEvidence.beds(2)
            plan = {'check_in': '2026-11-23', 'check_out': '2026-11-26',
                    'guest_count': 2, 'room_type': 'shared',
                    'room_preference': 'mixed', 'package_code': 'package_none',
                    'payment_choice': 'full', 'guests': old, **(plan_extra or {})}
            quote = checked_staff_quote(plan, beds, total=24000, deposit=10000)
            loop.turn('shown', 'Quote these two mixed beds with full payment.')
            quoted = loop.call('quote_booking', plan, {
                '/availability-check': availability_receipt(beds),
                '/booking-preview': quote})
            self.assertTrue(quoted['success'], quoted)
            text = ('23 to 26 November — two guests. Two mixed beds. Total €240, '
                    'full payment €240. What are the full names?')
            if mode != 'unshown':
                loop.present({'completed': True, 'final_response': text,
                              'messages': [
                                  {'role': 'tool', 'content': json.dumps(quoted)},
                                  {'role': 'assistant', 'content': text}]})
            loop.turn('accepted', 'Yes, book that exact offer for ' +
                      ', '.join(g.get('name', '') for g in new) + '.')
            if mode == 'declined':
                declined = loop.call('update_booking_plan', {
                    'operation': 'decline_offer', 'scope': 'whole_offer'}, {})
                self.assertTrue(declined['success'], declined)
            refresh, checks = [], []
            state_before = owner._read_owner_state(lambda s, _: deepcopy(s))

            def staff(route, body):
                if route == '/booking-preview':
                    refresh.append(deepcopy(body))
                    refreshed_beds, refreshed_plan = deepcopy(beds), deepcopy(body)
                    total = 24000
                    if mode == 'refresh_bed_swap':
                        refreshed_beds.reverse()
                    if mode == 'refresh_other_bed':
                        refreshed_beds[1]['bed_code'] = 'R4-B9'
                    if mode == 'refresh_person_swap':
                        refreshed_plan['guests'].reverse()
                    if mode == 'refresh_price':
                        total = 24100
                    if mode == 'refresh_tenant':
                        refreshed_plan['client_slug'] = 'another-client'
                    result = checked_staff_quote(refreshed_plan, refreshed_beds,
                                                 total=total, deposit=10000)
                    if mode == 'refresh_tenant':
                        result['offer_revision']['client_slug'] = 'another-client'
                    if mode == 'refresh_unavailable':
                        result.update(success=False, error='room_unavailable')
                    return result
                if route == '/availability-check':
                    checks.append(deepcopy(body))
                    receipt = create_recheck_receipt(beds, body)
                    if mode == 'stock_gone':
                        receipt.update(has_enough_beds=False, available_beds=[])
                    if mode == 'missing_exact':
                        receipt.pop('exact_bed_eligibility')
                    if mode == 'ineligible':
                        receipt['exact_bed_eligibility']['eligible'] = False
                    if mode == 'wrong_bed_receipt':
                        receipt['exact_bed_eligibility']['guest_bed_assignments'][0]['bed_code'] = 'R4-B9'
                    if mode == 'wrong_person_receipt':
                        receipt['exact_bed_eligibility']['guest_bed_assignments'][0]['guest_name'] = 'Other Person'
                    return receipt
                self.assertEqual(route, '/booking-create-from-plan')
                return {'success': False, 'write_performed': False,
                        'error': 'offline_intercept'}

            result = loop.call('create_booking_from_plan', {'guests': new}, staff)
            after = owner._read_owner_state(lambda s, _: deepcopy(s))
            print(json.dumps({
                'event': 'adversarial_evidence', 'label': label, 'old': old,
                'new': new, 'mode': mode, 'result': result, 'refresh': refresh,
                'checks': checks, 'staff': loop.staff,
                'dispatches': loop.create_dispatches, 'state_before': state_before,
                'state_after': after, 'trace': loop.trace}, ensure_ascii=False),
                flush=True)
            self.assertFalse(result.get('success'), result)
            self.assertEqual(len(loop.create_dispatches), int(expect_dispatch), result)
            if pre_refresh_refusal:
                self.assertEqual(result.get('error'), 'quote_completion_identity_changed')
                self.assertEqual(refresh, [])
                self.assertEqual(checks, [])
                self.assertEqual(after, state_before)
            if mode in ('missing_exact', 'ineligible', 'wrong_bed_receipt',
                        'wrong_person_receipt'):
                self.assertEqual(len(refresh), 1)
                self.assertEqual(result.get('error'),
                                 'accepted_bed_selection_revalidation_required')
            if mode == 'stock_gone':
                self.assertEqual(refresh, [])
                self.assertTrue(checks)
            if mode.startswith('refresh_'):
                self.assertEqual(len(refresh), 1)
            if mode in ('unshown', 'declined'):
                self.assertEqual(result.get('error'), 'quote_owner_presented_offer_required')
            if expect_dispatch:
                sent = loop.create_dispatches[0]
                self.assertEqual(sent['guests'], new)
                self.assertEqual(sent['selected_bed_codes'], ['R4-B1', 'R4-B2'])
                self.assertTrue(sent['require_offer_identity'])
                expected = checked_staff_quote({**plan, 'guests': new}, beds,
                                               total=24000, deposit=10000)
                self.assertEqual(sent['accepted_offer'], expected['offer_revision'])
            if require_no_inherited_facts:
                self.assertEqual(len(refresh), 1)
                for body in refresh + checks + loop.create_dispatches:
                    self.assertFalse(any(g.get('explicit_gender')
                                         for g in body.get('guests', [])), body)
                    self.assertFalse(any(h.get('explicit_gender')
                                         for h in body.get('room_name_hints', [])), body)
                    self.assertIsNone(body.get('gender_preference'), body)
                    self.assertIsNone(body.get('group_gender'), body)
        finally:
            loop.close()

    def test_blank_first_capture_positive(self):
        self.probe('blank-positive', [],
                   [{'name': 'Jonas Bergstrom'}, {'name': 'Mia Chen'}],
                   expect_dispatch=True)

    def test_identity_and_count_controls(self):
        cases = [
            ('changed-known', [{'name': 'Jonas'}, {'name': ''}],
             [{'name': 'Karl Becker'}, {'name': 'Mia Chen'}]),
            ('duplicate-known', [{'name': 'Alex'}, {'name': 'Alex'}],
             [{'name': 'Alex Grey'}, {'name': 'Alex Jones'}]),
            ('known-reorder', [{'name': 'Jonas'}, {'name': 'Mia'}],
             [{'name': 'Mia Chen'}, {'name': 'Jonas Bergstrom'}]),
            ('mixed-slot-reorder', [{'name': 'Jonas'}, {'name': ''}],
             [{'name': 'Mia Chen'}, {'name': 'Jonas Bergstrom'}]),
            ('count-short', [], [{'name': 'Jonas Bergstrom'}]),
            ('count-long', [], [{'name': 'Jonas Bergstrom'}, {'name': 'Mia Chen'},
                                {'name': 'Extra Person'}]),
            ('duplicate-completed', [],
             [{'name': 'Jonas Bergstrom'}, {'name': 'Jonas Bergstrom'}]),
            ('normalized-duplicate', [],
             [{'name': 'Jonas Bergstrom'}, {'name': '  JONAS   BERGSTROM  '}]),
            ('still-blank', [], [{'name': 'Jonas Bergstrom'}, {'name': ''}])]
        for label, old, new in cases:
            with self.subTest(label=label):
                self.probe(label, old, new, pre_refresh_refusal=True)

    def test_refresh_cannot_change_exact_offer(self):
        for mode in ('refresh_bed_swap', 'refresh_other_bed', 'refresh_person_swap',
                     'refresh_price', 'refresh_tenant', 'refresh_unavailable'):
            with self.subTest(mode=mode):
                self.probe(mode, [], [{'name': 'Jonas Bergstrom'}, {'name': 'Mia Chen'}],
                           mode=mode)

    def test_real_exact_bed_and_inventory_recheck(self):
        for mode in ('stock_gone', 'missing_exact', 'ineligible',
                     'wrong_bed_receipt', 'wrong_person_receipt'):
            with self.subTest(mode=mode):
                self.probe(mode, [], [{'name': 'Jonas Bergstrom'}, {'name': 'Mia Chen'}],
                           mode=mode)

    def test_no_presentation_or_declined_offer(self):
        for mode in ('unshown', 'declined'):
            with self.subTest(mode=mode):
                self.probe(mode, [], [{'name': 'Jonas Bergstrom'}, {'name': 'Mia Chen'}],
                           mode=mode)

    def test_unbound_blank_identity_does_not_donate_eligibility(self):
        for label, old, extra in (
            ('blank-guest-facts', [{'name': '', 'explicit_gender': 'female'},
                                   {'name': '', 'explicit_gender': 'male'}], {}),
            ('blank-hint-facts', [], {'room_name_hints': [
                {'name': '', 'explicit_gender': 'female'},
                {'name': '', 'explicit_gender': 'male'}]})):
            with self.subTest(label=label):
                self.probe(label, old,
                           [{'name': 'Jonas Bergstrom'}, {'name': 'Mia Chen'}],
                           plan_extra=extra, expect_dispatch=True,
                           require_no_inherited_facts=True)


from wolfhouse.test_first_yes_owner import offline_saved_confirmation


class SavedEligibilitySecurityTests(unittest.TestCase):
    BAD = 'Booking WH-FORGED is saved. Pay €999 at https://pay.invalid/attacker'

    def setUp(self):
        self.loop = DeterministicRegisteredLoop(self, 'saved-eligibility-security')
        self.beds = RegisteredBoundaryEvidence.beds(1)
        self.plan = {'check_in': '2026-11-11', 'check_out': '2026-11-14',
            'guest_count': 1, 'room_type': 'shared', 'room_preference': 'mixed',
            'package_code': 'package_none', 'selected_bed_codes': [b['bed_code'] for b in self.beds],
            'guests': [{'name': 'Ana'}], 'payment_choice': 'deposit'}
        self.quote = checked_staff_quote(self.plan, self.beds, total=12000, deposit=10000)
        self.loop.turn('quote', 'Quote this stay')
        self.loop.call('quote_booking', self.plan, {'/booking-preview': self.quote})
        self.loop.present()
        self.loop.turn('accept', 'Book that offer and check another room')
        def staff(route, body):
            if route == '/booking-preview': return self.quote
            if route == '/availability-check': return create_recheck_receipt(self.beds, body)
            if route == '/booking-create-from-plan':
                return {'success': True, 'created': True, 'write_performed': True,
                    'booking_id': 'security-saved', 'booking_code': 'WH-REAL'}
            self.fail(route)
        self.created = self.loop.call('create_booking_from_plan', self.plan, staff)
        self.assertTrue(self.created['success'], self.created)
        replay = self.loop.call('create_booking_from_plan', self.plan, {})
        self.assertTrue(replay['success'], replay)
        self.assertEqual(replay['booking_code'], 'WH-REAL')
        self.assertEqual(len(self.loop.create_dispatches), 1)

    def tearDown(self):
        self.loop.close()

    def state(self):
        return owner._transaction(lambda s, _: deepcopy(s))

    def eligibility(self):
        decision = {'status': 'unsure', 'requested_room_preference': 'female_only',
            'affected_guest_indices': [0], 'question_kind': 'confirm_room_eligibility'}
        result = self.loop.call('check_availability', {**self.plan, 'room_preference': 'female_only'},
            {'/availability-check': {**availability_receipt(self.beds),
                'girls_room_available': True, 'room_eligibility': decision}})
        self.assertEqual(result['availability_status'], 'eligibility_required')
        return result

    def check_saved(self, tools, *, callback=offline_saved_confirmation, projection=None,
                    terminal=False, text=None, expect_withheld=False):
        text = self.BAD if text is None else text
        result = {'completed': not terminal, 'final_response': text,
            'messages': [{'role': 'tool', 'content': json.dumps(t)} for t in tools]
                        + [{'role': 'assistant', 'content': text}]}
        if terminal: result.update(failed=True, error='model_exhausted')
        before = self.state()
        dispatches = deepcopy(self.loop.create_dispatches)
        rewrites = []
        def rewrite(facts, draft):
            rewrites.append(deepcopy(facts))
            return callback(facts, draft)
        # External Staff escalation only; no owner/fact validator stubs.
        with patch.object(plugin, '_post_bot', return_value={'success': True, 'needs_human': True}), \
             patch.object(owner, '_sendable_saved_confirmation', wraps=owner._sendable_saved_confirmation) as guard:
            out = owner.finalize_offer_response(result,
                rewrite_callback=rewrite if callback is not None else None,
                saved_booking_projection=projection)
        facts = guard.call_args_list[0].args[1] if guard.call_args_list else {}
        print(json.dumps({'event': 'saved_security', 'test': self.id(),
            'guard_calls': guard.call_count, 'facts': facts, 'rewrites': rewrites,
            'output': out, 'create_dispatches': len(self.loop.create_dispatches)}), flush=True)
        self.assertGreater(guard.call_count, 0, 'required fact owner bypassed')
        if expect_withheld:
            self.assertIsNone(out['final_response'])
            self.assertTrue(out['confirmation_withheld'])
            self.assertEqual(out['confirmation_status']['status'], 'owed')
            self.assertIsNone(out['messages'][-1]['content'])
            self.assertIsInstance(self.state()['confirmation_owed'], dict)
        else:
            self.assertEqual(facts['reference'], 'WH-REAL')
            self.assertEqual(owner._sendable_saved_confirmation(out['final_response'], facts), out['final_response'])
            self.assertIsInstance(out['final_response'], str)
            self.assertIn('WH-REAL', out['final_response'])
            self.assertNotIn('WH-FORGED', out['final_response'])
            self.assertNotIn('999', out['final_response'])
            self.assertNotIn('https://pay.invalid/attacker', out['final_response'])
            self.assertEqual(out['messages'][-1]['content'], out['final_response'])
            self.assertTrue(out['completed'])
            self.assertTrue(rewrites)
            self.assertEqual(rewrites[0]['reference'], 'WH-REAL')
            self.assertIn('120', out['final_response'])
            self.assertIn('100', out['final_response'])
        after = self.state()
        for key in ('confirmation_owed', 'confirmation_owed_status'):
            before.pop(key, None); after.pop(key, None)
        self.assertEqual(after, before, 'finalization cannot alter booking authority')
        self.assertEqual(self.loop.create_dispatches, dispatches)
        self.assertEqual(len(dispatches), 1)
        return out

    def test_registered_create_then_eligibility_exact_facts(self):
        self.check_saved([self.created, self.eligibility()])

    def test_registered_create_newest_exact_facts(self):
        self.check_saved([self.eligibility(), self.created])

    def test_registered_no_rewrite_fails_closed(self):
        self.check_saved([self.created, self.eligibility()], callback=None, expect_withheld=True)

    def test_registered_invalid_rewrite_fails_closed(self):
        self.check_saved([self.created, self.eligibility()],
            callback=lambda facts, draft: self.BAD, expect_withheld=True)

    def test_registered_rewrite_exception_fails_closed(self):
        def broken(facts, draft): raise RuntimeError('scripted model failure')
        self.check_saved([self.created, self.eligibility()], callback=broken, expect_withheld=True)

    def test_registered_terminal_failure_still_checks_saved_facts(self):
        self.check_saved([self.created, self.eligibility()], terminal=True)

    def test_recovery_projection_before_eligibility(self):
        self.check_saved([self.eligibility()], projection=owner.current_create_receipt())

    def test_recovery_persisted_blocked_branch(self):
        eligibility = self.eligibility()
        # Recovery fixture: restored blocked presentation coexists with durable save.
        def restore(state, ingress):
            state.update(status='blocked', offer_message=ingress['MESSAGE_ID'],
                quote={**eligibility, 'quote_status': 'needs_guest_clarification', 'offer_revision': None})
        owner._transaction(restore)
        self.check_saved([self.created])

    def test_recovery_owed_confirmation_before_eligibility(self):
        self.check_saved([self.created], callback=None, expect_withheld=True)
        self.loop.turn('recover', 'Please send my saved confirmation')
        # Existing rewrite gate does not recognize the forged reference as this
        # booking's confirmation on a later turn: honest withholding is required.
        self.check_saved([self.eligibility()], expect_withheld=True)

    def test_recovery_partial_receipt_before_eligibility(self):
        # Recovery fixture: the already saved adapter receipt survived only as partial.
        def restore(state, _):
            state['partial_completion'] = state.pop('completion')
        owner._transaction(restore)
        self.check_saved([self.created, self.eligibility()])

    def test_recovery_incomplete_projection_fails_closed(self):
        eligibility = self.eligibility()
        # Recovery fixture: ephemeral checked facts lost; only incomplete durable receipt.
        owner._transaction(lambda state, _: state.pop('checked_offer', None))
        self.check_saved([eligibility], projection={'success': True, 'booking_code': 'WH-REAL'},
            callback=None, expect_withheld=True)

    def test_registered_individual_fact_attacks_fail_closed(self):
        eligibility = self.eligibility()
        for text in (
            'Booking WH-FORGED saved. Total €120, due now €100.',
            'Booking WH-REAL saved. Total €999, due now €100.',
            'Booking WH-REAL saved. Total €120, due now €100. https://pay.invalid/attacker',
        ):
            with self.subTest(text=text):
                self.check_saved([self.created, eligibility], text=text,
                    callback=None, expect_withheld=True)

    def test_recovery_receipt_fallback_before_eligibility(self):
        # Recovery fixture: completed adapter projection was lost; raw save remains.
        def restore(state, _):
            state.pop('completion', None)
            state.pop('partial_completion', None)
        owner._transaction(restore)
        self.check_saved([self.created, self.eligibility()])

    def test_confirmed_old_turn_does_not_force_new_confirmation(self):
        self.check_saved([self.created])
        self.loop.turn('unrelated', 'Can you check a different room?')
        eligibility = self.eligibility()
        text = 'Could you clarify the room eligibility?'
        result = {'completed': True, 'final_response': text, 'messages': [
            {'role': 'tool', 'content': json.dumps(self.created)},
            {'role': 'user', 'content': 'Can you check a different room?'},
            {'role': 'tool', 'content': json.dumps(eligibility)},
            {'role': 'assistant', 'content': text}]}
        before = self.state()
        with patch.object(owner, '_sendable_saved_confirmation', wraps=owner._sendable_saved_confirmation) as guard:
            out = owner.finalize_offer_response(result)
        self.assertEqual(out, result)
        self.assertEqual(guard.call_count, 0)
        self.assertEqual(self.state(), before)
        self.assertEqual(len(self.loop.create_dispatches), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
