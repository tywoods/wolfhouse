"""Deterministic decision-only replay through the real accepted-quote owner."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import os
import tempfile

os.environ.setdefault("LUNA_CLIENT_SLUG", "wolfhouse-somo")

from gateway.session_context import clear_session_vars, set_session_vars
from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner
from wolfhouse.test_first_yes_owner import FirstYesOwnerTests


def _plan(case):
    quote = deepcopy(case["quote_args"])
    quote.pop("client_slug", None)
    create = case["create_args"]
    quote.setdefault("package_code", "package_none")
    quote.setdefault("payment_choice", create.get("payment_choice", "deposit"))
    quote.setdefault("room_type", create.get("room_type", "shared"))
    quote.setdefault("room_preference", create.get("room_preference", "mixed"))
    quote.setdefault("guests", deepcopy(create.get("guests")) or [
        {"name": f"Guest {index + 1}"} for index in range(quote["guest_count"])])
    return quote


def _staff(case, plan):
    frozen = case["frozen_staff"]
    by_code = {row["bed_code"]: row for row in frozen["beds"]}
    beds = [by_code[code] for code in plan.get("selected_bed_codes", []) if code in by_code]
    if len(beds) != len(frozen["beds"]):
        beds = frozen["beds"]
    payment = plan.get("payment_choice", "deposit")
    total = frozen["total_cents"]
    deposit = min(total, 10000 * plan["guest_count"])
    amounts = {"total_cents": total, "deposit_required_cents": deposit,
               "payment_link_amount_cents": deposit if payment in ("deposit", "per_guest") else total,
               "currency": frozen["currency"]}
    return FirstYesOwnerTests._checked_offer(
        object.__new__(FirstYesOwnerTests), plan, beds, quote_overrides=amounts)


def _replay(case):
    if case["expected"] == "not_replayable":
        return {"case": case["case"], "expected": case["expected"],
                "actual": "not_replayable", "reason": case["reason"]}
    tokens = None
    with tempfile.TemporaryDirectory() as directory:
        db = SessionDB(Path(directory) / "state.db")
        session = "replay-" + case["case"].replace("/", "-")
        db.create_session(session, source="whatsapp")
        agent = SimpleNamespace(_session_db=db, session_id=session)
        def turn(message_id, text):
            nonlocal tokens
            if tokens: clear_session_vars(tokens)
            tokens = set_session_vars(platform="whatsapp", source="whatsapp", chat_id=session,
                user_id=session, session_key=session, session_id=session, message_id=message_id)
            owner.observe_owner_turn(agent, text)
        try:
            plan = _plan(case)
            turn("offer", "Recorded offer: " + (case.get("shown_offer_text") or ""))
            owner.record_quote(plan, _staff(case, plan))
            owner.finalize_offer_response({"completed": True, "final_response": case["shown_offer_text"]})
            turn("accept", "Yes, book the recorded offer")
            owner.interpret_owner_turn({"action": "accept", "action_evidence": "Yes, book the recorded offer",
                "ambiguous": False, "negated": False, "conditional": False,
                "material_changes": [], "completions": {}})
            args = {key: deepcopy(value) for key, value in case["create_args"].items()
                    if key not in ("accepted_offer", "idempotency_key", "phone", "guest_phone", "source")}
            stage = "initial_prepare"
            prepared = owner.prepare_create(args)
            if prepared.revalidation:
                refreshed = _staff(case, dict(prepared))
                stage = "record_revalidation"
                owner.record_quote(prepared, refreshed)
                stage = "final_prepare"
                prepared = owner.prepare_create(args)
            actual = "booked"
            detail = {"prepared_beds": prepared.get("selected_bed_codes"),
                      "prepared_total_cents": prepared.get("accepted_offer", {}).get("total_cents")}
        except owner.QuoteBoundaryError as error:
            actual = str(error)
            state = owner._transaction(lambda current, ingress: deepcopy(current))
            detail = {"stage": locals().get("stage", "presentation"),
                      "state_plan": state.get("plan"), "checked_offer": state.get("checked_offer")}
        finally:
            if tokens: clear_session_vars(tokens)
            owner._current.set(None)
            db.close()
    return {"case": case["case"], "expected": case["expected"], "actual": actual, **detail}


def replay_table(table, corpus):
    if not Path(corpus).is_dir(): raise FileNotFoundError(corpus)
    return [_replay(case) for case in table["cases"]]


def replay_synthetic_case(case):
    """Execute an explicitly synthetic Staff refresh through the real owner boundary."""
    tokens = None
    with tempfile.TemporaryDirectory() as directory:
        db = SessionDB(Path(directory) / "state.db")
        session = "synthetic-" + case["id"]
        db.create_session(session, source="whatsapp")
        agent = SimpleNamespace(_session_db=db, session_id=session)
        def turn(message_id, text):
            nonlocal tokens
            if tokens: clear_session_vars(tokens)
            tokens = set_session_vars(platform="whatsapp", source="whatsapp", chat_id=session,
                user_id=session, session_key=session, session_id=session, message_id=message_id)
            owner.observe_owner_turn(agent, text)
        try:
            plan = deepcopy(case["shown_plan"])
            plan.update(deepcopy(case.get("shown_plan_changes", {})))
            beds = deepcopy(case["shown_staff"]["beds"])
            amounts = {key: case["shown_staff"][key] for key in (
                "total_cents", "deposit_required_cents", "payment_link_amount_cents", "currency")}
            shown = FirstYesOwnerTests._checked_offer(
                object.__new__(FirstYesOwnerTests), plan, beds, quote_overrides=amounts)
            turn("offer", "Synthetic offer")
            owner.record_quote(plan, shown)
            owner.finalize_offer_response({"completed": True, "final_response": "Synthetic offer"})
            turn("accept", "Yes, book it")
            owner.interpret_owner_turn({"action": "accept", "action_evidence": "Yes, book it",
                "ambiguous": False, "negated": False, "conditional": False,
                "material_changes": [], "completions": {}})
            owner._transaction(lambda state, ingress: state.pop("checked_offer", None))
            requested = deepcopy(case.get("create_args", {}))
            prepared = owner.prepare_create(requested)
            refresh_plan = dict(prepared)
            refresh_plan.update(deepcopy(case.get("refresh_plan_changes", {})))
            refresh_beds = deepcopy(case.get("refresh_beds", beds))
            refresh_amounts = deepcopy(amounts)
            refresh_amounts.update(deepcopy(case.get("refresh_amount_changes", {})))
            refreshed = FirstYesOwnerTests._checked_offer(
                object.__new__(FirstYesOwnerTests), refresh_plan, refresh_beds,
                quote_overrides=refresh_amounts)
            if case.get("availability") == "unavailable":
                refreshed.update(success=False, error="room_unavailable")
                refreshed["availability"]["status"] = "unavailable"
            owner.record_quote(prepared, refreshed)
            owner.prepare_create(requested)
            actual = "allowed"
        except owner.QuoteBoundaryError as error:
            actual = str(error)
        finally:
            if tokens: clear_session_vars(tokens)
            owner._current.set(None)
            db.close()
    return {"id": case["id"], "expected": case["expected"], "actual": actual}
