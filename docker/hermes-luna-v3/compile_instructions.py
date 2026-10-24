#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARTS = ("personality.md", "conversation.md", "booking.md")
LIMITS = {"personality.md": 1800, "conversation.md": 2600, "booking.md": 4200}
TOTAL_LIMIT = 8000


def compile_instructions() -> str:
    sections = []
    for name in PARTS:
        text = (ROOT / "instructions" / name).read_text(encoding="utf-8").strip()
        if not text or len(text) > LIMITS[name]:
            raise SystemExit(f"instruction module {name} empty or over cap")
        sections.append(text)
    result = "\n\n".join(sections) + "\n"
    if len(result) > TOTAL_LIMIT:
        raise SystemExit("compiled instructions over cap")
    return result


if __name__ == "__main__":
    output = ROOT / "SOUL.md"
    output.write_text(compile_instructions(), encoding="utf-8")
    print(f"compiled {len(compile_instructions())} chars -> {output}")
