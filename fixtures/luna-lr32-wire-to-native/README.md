# LR3.2 wire-to-native boundary fixtures (offline)

Redacted transport/provider-boundary records for Cap tip after #956.

**Purpose:** discriminate `native_empty` vs `adapter_drop` offline — capture labels
alone are insufficient. No credentials, guest payloads, or live traffic.

## Observer stale after promote

Cap tip `1547934800348975165` plus Skipper source-trace `1547935282974687245`
add a separate offline classification: `observer-stale-after-promote`. This names
live pairing where `tool_calls` exist but `executor.observed-none` may be stale
after empty-terminal observe → assembled promote. `BoundedMetadataCapture.observe_provider_result`
/ `observed_no_executor_calls()` can replace executor state/dispositions, while
`luna_personality_isolation.py` `_wrap_tool_dispatcher` records accepted /
dispatched / completed entries through `cap.metadata_capture`.

Keep call boundaries explicit:

- call1: `provider_empty_with_wire_ok` remains the native-empty/wire-OK boundary
  fixture class.
- call2: `observer-stale-after-promote` until independent handler/disposition
  evidence proves whether dispatch did or did not run.

Staff `read_tools_completed=[]` may share the same faulty observer path. Treat it
as **unproven until independent handler evidence**; do not turn it into a PASS or
no-dispatch claim while the Chief isolation harness is in flight.

## Cap A/B/C offline checklist stub

Do not invent PASS. For each Cap A/B/C artifact, capture or mark missing:

- `classification`
- `handler_entries`
- `record_disposition_entries`
- `history_before_call2`
- `final_capture`
- `first_divergent_*` fields

| Fixture | Expected verdict |
|---|---|
| `terminal-function-call-adapter-recovery.json` | `adapter_drop_recovered` |
| `native-empty-wire-ok.json` | `provider_empty_with_wire_ok` |
| `observation-incomplete-no-terminal.json` | `observation_incomplete` |
| `lost-normalization-native-present.json` | `lost_normalization` |

Replay:

```bash
PYTHONPATH=docker/hermes-staging python3 -c "
from pathlib import Path
from wolfhouse.luna_responses_provider import replay_boundary_fixture
root = Path('fixtures/luna-lr32-wire-to-native')
for path in sorted(root.glob('*.json')):
    result = replay_boundary_fixture(path)
    print(path.name, result['boundary_verdict'], result['matches_expected'])
"
```

Direct-compare probe (`LUNA_LR32_BOUNDARY_DIRECT_COMPARE=1`) is designed only when
boundary records still cannot discriminate; it stops at native response and never
dispatches tools.
