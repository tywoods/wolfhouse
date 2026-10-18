"""One-shot extractor for the approved Sim13--20 decision replay table."""
import json
import re
import sys
from pathlib import Path

TOOLS = {"check_availability", "quote_booking", "create_booking_from_plan"}

def total_cents(text):
    patterns = (r"Total:\s*\*{0,2}€?([0-9]+(?:[.,][0-9]{2})?)", r"\*{0,2}€([0-9]+(?:[.,][0-9]{2})?)\*{0,2}\s+(?:in total|total)")
    for pattern in patterns:
        match = re.search(pattern, text or "", re.I)
        if match:
            return int(round(float(match.group(1).replace(",", ".")) * 100))
    return None

def main():
    corpus = Path(sys.argv[1])
    rows = []
    for path in sorted(corpus.glob("**/guest*.jsonl")):
        relative = path.relative_to(corpus).as_posix()
        checks, quotes, creates, shown = [], [], [], []
        for line_number, line in enumerate(path.read_text().splitlines(), 1):
            turn = json.loads(line); response = turn["resp"]
            calls = response.get("tool_calls", [])
            for call in calls:
                if call.get("name") == "check_availability": checks.append(call.get("args", {}))
                elif call.get("name") == "quote_booking":
                    quotes.append(call.get("args", {})); shown.append(response.get("reply_text", ""))
                elif call.get("name") == "create_booking_from_plan": creates.append(call.get("args", {}))
        case = {"case": relative[:-6], "capture": relative, "check_availability_args": checks[-1] if checks else None,
                "quote_args": quotes[-1] if quotes else None, "create_args": creates[-1] if creates else None,
                "shown_offer_text": shown[-1] if shown else None}
        if not quotes or not creates:
            missing = [name for name, values in (("quote_booking", quotes), ("create_booking_from_plan", creates)) if not values]
            case.update(expected="not_replayable", reason="missing recorded " + " and ".join(missing) + " args")
        else:
            accepted = creates[-1].get("accepted_offer")
            beds = (accepted or {}).get("room_arrangement") or [
                {"bed_code": code, "room_code": code.split("-")[0], "gender_strategy": quotes[-1].get("room_preference", "flexible")}
                for code in quotes[-1].get("selected_bed_codes", [])]
            price = (accepted or {}).get("total_cents") or total_cents(shown[-1])
            if not beds or price is None:
                case.update(expected="not_replayable", reason="recorded quote lacks frozen beds or shown total")
            else:
                case.update(expected="booked", frozen_staff={"beds": beds, "total_cents": price, "currency": (accepted or {}).get("currency", "EUR")})
        rows.append(case)
    output = Path(__file__).with_name("expected_cases.json")
    output.write_text(json.dumps({"schema": 1, "ruling": "JW1628 decision-only", "cases": rows}, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {len(rows)} cases to {output}")
if __name__ == "__main__": main()
