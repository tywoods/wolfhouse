# SIM15 REPAIR4 evidence-only repair

This directory repairs only the replay and assessment evidence for S15-R3-1/2/3. It does not change product code or claim exact historical reproduction.

## What is proved

- `replay.py` independently extracts baseline `d1d42d5b45c42173848ac8ff29f272489cd3768f` and candidate `d468622fde32f2d0adae17247bc8de91bb63ca88` trees.
- `variant_probe.py` runs in a fresh process per variant, asserts the imported plugin/personality paths, registers that tree's tools, assembles that tree's SOUL/personality context, and records source/context hashes.
- Raw inert Staff fixtures are injected only beneath registered read-only callbacks. The receipt retains callback return bodies, not authored model-visible substitutes.
- Availability is the source-supported current-date authority. Ineligible/unavailable package pricing is a separate callback result. Genuine closure comes from the registered `quote_booking` callback, and missing-authority is a separate control.
- Histories use ordinary `user`, assistant `tool_calls`, and matched `tool` messages with call IDs and JSON callback bodies.
- `assess.py` corrects the assessment of retained REPAIR3 emissions: season wording, one-question, and room-choice-first/sister-night deferral are independent criteria.

## Important limitation

No model generation is performed by REPAIR4. The old REPAIR3 receipt is preserved and explicitly labeled a mixed-context diagnostic. Its observed replies are reused only for corrected assessment, never represented as outputs generated from the repaired histories. Historical season causality remains uncertain.

## Offline commands

```sh
python3 artifacts/sim15-season-oneq-repair4/replay.py
python3 artifacts/sim15-season-oneq-repair4/assess.py
python3 artifacts/sim15-season-oneq-repair4/audit.py
python3 artifacts/sim15-season-oneq-repair3/run-gates.py
```

All scripts deny or avoid Staff/model network calls and perform no guest sends, product writes, deployment, restart, or configuration operation.
