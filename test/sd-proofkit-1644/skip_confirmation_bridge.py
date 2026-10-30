#!/usr/bin/env python3
"""Bridge from the France TEST kit to the saved-confirmation slot checker.

Receives one JSON object on stdin:
{"message": str, "booking": object, "fill": optional bool}.

The checker lives in this checkout (override with WH_SKIP_ACCEPTED_QUOTE_ROOT).
HEAD must contain the confirmation-slot commit as an ancestor, so a later kit
commit still runs and a tree from before the slots does not.

Room text comes from booking.room_label, or from guest_rooms[].number when
Staff sent the Deckhand room payload (room_kind supplies private/shared when
room_type is absent). Facts are filled from the saved booking; the checker
rejects any other money amount, WH-digit ref, or room number.
"""
import importlib
import json
import os
import subprocess
import sys

# Slot implementation. Descendants (including this bridge commit) are accepted.
SLOT_COMMIT = "65a31209a3aebdb38df0d6a6cb2b81b746bcd343"
DEFAULT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _text(value):
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None


def _room_labels(booking):
    """Staff room label, or Deckhand guest_rooms number when no label was sent."""
    labels = []

    def add(value):
        text = _text(value)
        if text and text not in labels:
            labels.append(text)

    label = booking.get("room_label")
    if isinstance(label, list):
        for item in label:
            add(item)
    else:
        add(label)
    if labels:
        return labels
    rooms = booking.get("guest_rooms")
    if isinstance(rooms, list):
        for row in rooms:
            if not isinstance(row, dict):
                continue
            number = row.get("number")
            if number is None:
                number = row.get("room_number")
            add(number)
    if labels:
        return labels
    add(booking.get("number"))
    if not labels:
        raise KeyError("room_label")
    return labels


def _room_type(booking):
    kind = booking.get("room_type") or booking.get("room_kind")
    if kind in ("private", "shared"):
        return kind
    kinds = []
    for row in booking.get("guest_rooms") or []:
        if isinstance(row, dict) and row.get("room_kind") in ("private", "shared"):
            kinds.append(row["room_kind"])
    if kinds and all(item == kinds[0] for item in kinds):
        return kinds[0]
    return None


def _facts(booking):
    names = booking.get("names") if isinstance(booking.get("names"), list) else booking.get("guest_names")
    reference = _text(booking.get("reference")) or _text(booking.get("booking_code"))
    link = _text(booking.get("payment_link")) or _text(booking.get("secure_payment_url"))
    links = booking.get("payment_links")
    if link is None and isinstance(links, list) and links:
        link = _text(links[0])
    facts = {
        "reference": reference,
        "check_in": booking.get("check_in"),
        "check_out": booking.get("check_out"),
        "guest_names": names,
        "room": _room_labels(booking),
        "total_cents": booking.get("total_cents"),
        "deposit_cents": booking.get("deposit_cents"),
        "payment_links": [link] if link else [],
        "rewrite_context": {"language": str(booking.get("language") or "en")},
    }
    due = booking.get("balance_due_at")
    if isinstance(due, str) and due.strip():
        facts["balance_due_at"] = due.strip()
    room_type = _room_type(booking)
    if room_type:
        facts["room_type"] = room_type
    return facts


def _template_from_filled(message, values):
    """Put slot tokens back over each saved value so a filled message can be rechecked.

    Longest values win a non-overlapping span first, so a booking ref inside a
    payment URL and two equal money amounts each keep their own slot.
    """
    if not isinstance(message, str):
        return None
    occupied = []
    spans = []
    for name, value in sorted(values.items(), key=lambda item: len(item[1]), reverse=True):
        if not isinstance(value, str) or not value:
            return None
        start = 0
        found = None
        while True:
            index = message.find(value, start)
            if index < 0:
                break
            end = index + len(value)
            if all(end <= left or index >= right for left, right in occupied):
                found = (index, end)
                break
            start = index + 1
        if found is None:
            return None
        occupied.append(found)
        spans.append((found[0], found[1], name))
    spans.sort()
    cursor = 0
    parts = []
    for start, end, name in spans:
        parts.append(message[cursor:start])
        parts.append("{" + name + "}")
        cursor = end
    parts.append(message[cursor:])
    return "".join(parts)


def _accepts(message, facts, fill, values_for):
    direct = fill(message, facts)
    if direct is not None:
        return True, direct
    values = values_for(facts)
    template = _template_from_filled(message, values) if values else None
    if template is None:
        return False, None
    again = fill(template, facts)
    if again != message.strip():
        return False, None
    return True, again


def main():
    root = os.environ.get("WH_SKIP_ACCEPTED_QUOTE_ROOT", DEFAULT_ROOT)
    head = subprocess.check_output(
        ["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
    ancestor = subprocess.run(
        ["git", "-C", root, "merge-base", "--is-ancestor", SLOT_COMMIT, "HEAD"],
        check=False)
    if ancestor.returncode != 0:
        raise RuntimeError(
            f"Skip worktree {head} does not contain confirmation slot commit {SLOT_COMMIT}")
    sys.path.insert(0, os.path.join(root, "docker", "hermes-staging"))
    checker = importlib.import_module("wolfhouse.accepted_quote")
    payload = json.load(sys.stdin)
    facts = _facts(payload["booking"])
    ok, filled = _accepts(
        payload.get("message"), facts, checker._fill_confirmation_slots,
        checker._confirmation_slot_values)
    print(json.dumps({
        "ok": ok,
        "filled": filled,
        "values": checker._confirmation_slot_values(facts),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(2)
