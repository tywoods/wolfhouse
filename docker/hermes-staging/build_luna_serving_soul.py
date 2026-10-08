#!/usr/bin/env python3
"""Build Cap-reviewed full and sub-limit serving Luna SOUL copies."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

APPROVED_BASE_SHA256 = "5b64e8714d423bee705f27ba211eb8d1f712065b2f4f4d6d14b2bbc0d0004efb"
MAX_CHARS = 65_280
HEAD_CHARS = int(MAX_CHARS * 0.7)
TAIL_CHARS = int(MAX_CHARS * 0.2)
ANCHOR = "3. **A material term changed:** obtain a new authoritative quote that reflects the changed dates, guest allocation, selected beds, room arrangement, services, total or payment terms. Explain the changed setup and amount, then obtain fresh acceptance before creating the booking. Never carry old consent across a material change.\n"
RECOVERY = """
**Quote failure recovery (hard):** If `quote_booking` fails before returning an authoritative price, preserve every known date, guest, room/bed choice, eligibility fact, name, package, service, payment choice and prior guest consent. State only that you cannot show the verified price right now, without exposing internal mechanics. Ask a question only when the typed refusal identifies a genuinely missing guest detail. Never restart intake, request repeated consent, promise an unproved retry, or promise that a booking or payment link will follow immediately.
- **Solo turn 3:** do not ask the guest to say “yes, book this”, “confirm”, or equivalent; do not tell them the booking or link will be created/sent immediately or in the next message. The failed quote produced no authoritative price and no proved retry.
- **Couple turn 3:** when the couple already accepted the unchanged disclosed room arrangement and price, retain that acceptance. Do not ask them to confirm, accept, or consent again. State the temporary inability to show a verified quote and stop unless the typed refusal requests one genuinely missing detail.
""".lstrip()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def build_full(base: str) -> str:
    if sha256_text(base) != APPROVED_BASE_SHA256:
        raise RuntimeError("approved installed SOUL hash mismatch")
    if base.count(ANCHOR) != 1:
        raise RuntimeError("recovery insertion anchor drift")
    return base.replace(ANCHOR, ANCHOR + "\n" + RECOVERY, 1)


def build_serving(full: str) -> str:
    marker = (
        f"\n\n[Approved full Luna identity retained in SOUL.approved-full.md; serving projection "
        f"keeps {HEAD_CHARS}+{TAIL_CHARS} of {len(full)} characters to remain below the pinned "
        f"Hermes {MAX_CHARS}-character limit.]\n\n"
    )
    serving = full[:HEAD_CHARS] + marker + full[-TAIL_CHARS:]
    if len(serving) >= MAX_CHARS:
        raise RuntimeError("serving SOUL is not below pinned limit")
    if RECOVERY not in serving:
        raise RuntimeError("recovery rule absent from serving SOUL")
    return serving


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    base = (args.root / "SOUL.approved-base.md").read_text(encoding="utf-8")
    full = build_full(base)
    serving = build_serving(full)
    outputs = {args.root / "SOUL.approved-full.md": full, args.root / "SOUL.md": serving}
    for path, expected in outputs.items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != expected:
                raise RuntimeError(f"generated SOUL drift: {path.name}")
        else:
            path.write_text(expected, encoding="utf-8")
    print(f"PASS base={APPROVED_BASE_SHA256} full={sha256_text(full)} chars={len(full)} serving={sha256_text(serving)} chars={len(serving)}")


if __name__ == "__main__":
    main()
