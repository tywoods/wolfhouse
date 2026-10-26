# SKIP-V3-PR1426-ROOTFIX-R4-20261026T0352 proof map

Offline only; no model, live Staff, sends, deployment, gateway restart, or credentials.

| Requirement | Proof |
|---|---|
| Strict scorer regressions: polarity, amount roles/currency, truthful no-booking, person allocation, contradictory transaction claims | `scripts/test-luna-v3-rootfix-r4.py`; `red.log`; `green.log` |
| Current event and coherent Staff tool/request/result/byte boundary; unique exchange selection | R4 regression plus `scripts/run-luna-v3-rendered-reply-matrix.py::_boundary_consistent`; `green.log`; `harness.log` |
| Fault uncertainty rejects confirmation/payment/secured/infrastructure prose | R4 regression and `green.log` |
| True original/effective status custody for success 200/201 -> injected 422 | plugin boundary patch; `plugin.log` |
| Existing rendered suite | `harness.log` (26 tests) |
| Plugin suite | `plugin.log` (18 tests at the prior R4 head; 19 tests after the explicit 200/201 status regression was added—see exact command in the final commit message/review receipt) |
| ONE Staff request contract | `scripts/lib/model-led-luna/staff-request-normalize-cli.js` executes the exported `normalizeQuoteRequest`; `make_cases` and assembled control matching compare its canonical projection. |
| Owner-produced fixture receipts | CLI implements deterministic HMAC issue/verify operations, but fixture admission does not yet require/verify that receipt. **OPEN BLOCKER; legacy caller-hash canaries remain accepted.** |
| Semantic kind/outcome/all-five-fault/unsupported-standalone coverage | **OPEN BLOCKER; not yet enforced by this patch.** |
| Simulator/startup/routes | `simulator-startup.log`; `offline-gate-exits.json` |
| Staff contract/FIX1/public quote owner | `staff-contract.log`, `fix1.log`, `public-quote-owner.log` |
| Live three-repetition matrix | BLOCKED intentionally: sanctioned model access and live TEST runtime/token/fixture receipt are not available; no live/model call attempted. |

The generic legacy `verify-luna-v3-contracts.js` was also inspected/run but exits nonzero on its documented TODO/skipped trusted-context integration cells; it is not represented as an acceptance pass.
