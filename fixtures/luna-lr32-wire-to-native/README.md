# LR3.2 wire-to-native boundary fixtures (offline)

Redacted transport/provider-boundary records for Cap tip after #956.

**Purpose:** discriminate `native_empty` vs `adapter_drop` offline — capture labels
alone are insufficient. No credentials, guest payloads, or live traffic.

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
