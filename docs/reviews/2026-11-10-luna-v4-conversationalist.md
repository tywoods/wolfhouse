# Luna v4 Conversationalist — source candidate, not release acceptance

## Scope / identity

Base: `94b8a443e3a4c1d51e1ffab03095f3fda66e262f`. Candidate identity is the PR head containing this document; do not confuse a source PR with an installed runtime. France staging only, Captain review before merge, Skip deployment only after Captain PASS. No deployment, production access, guest send, payment, gateway restart, alerts enablement, live setting mutation or model evaluation was performed.

Runtime changes are confined to the Conversationalist instruction in:
- `scripts/lib/luna-guest-personality-packs.js`
- `docker/hermes-staging/wolfhouse/luna_personality.py`

Test changes:
- `scripts/verify-luna-personality-contract.js`
- `scripts/verify-luna-personality-runtime.js`
- `docker/hermes-staging/wolfhouse/test_luna_personality.py`

Every byte outside the Conversationalist subsection in both runtime owners matches the base. Sunny, Calm, Concise, Extra, default, IDs, resolution and the exact safety suffix are preserved, including intentional JS/Python Extra differences. No Inbox, booking, API, plugin, soul guide or transport owner changed. This review document is the only additional tracked file.

## Existing selector; no new system

`Staff > Luna Settings > Luna Personality` already includes `Conversationalist` in source (`scripts/staff-query-api.js`, `data-personality-id="conversationalist"`) and uses the existing authenticated `/staff/luna-personality` route. This candidate reuses that option rather than adding a duplicate ID, engine or UI.

The actual France staging selected pack/image/mounts were NOT inspected. Before installation, record the current selection. If it is already Conversationalist, stop for an explicit preservation decision: changing that pack would otherwise change today's selected Luna. Do not change the default or selected setting as part of installation. Switching back must restore the recorded original pack, not an assumed default.

## Source-evidenced instruction conflicts

Old Conversationalist called Luna a `human host`, prescribed responding to a meaningful detail, required acknowledging a human detail before the missing fact, and encouraged a closing invitation. The replacement makes acknowledgement useful rather than ritual, permits natural stopping, retains settled choices, asks only for workflow needs, and calls for calm honest uncertainty and complete verified receipts. No always-on humanizer, new model call, classifier or factual validator was added. Original <900-character budget and JS/Python parity pass.

These are inspected instruction conflicts, not observed real-model baseline failures. Structural RED was recorded before instruction changes: exactly the new conflict assertion failed (`red-contract.log`), while the old snapshot still passed. Snapshot tests are not proof of better conversation.

Ordinary-turn binding and quote/confirmation repair consume the existing selected pack. `accepted_quote.py::_guest_authoring_system_context()` and `_confirmation_rewrite_messages()` were traced read-only. Offline repair-input checks exercised each original pack -> Conversationalist -> original pack for Wolfhouse and Sunset and restored exact original prompt bytes. These are synthetic binding checks, not actual model prose or serving-runtime acceptance.

## Offline results

Evidence root on Seadog: `/opt/data/workspace/sandbox-repos/WH-seadog/artifacts/luna-v4-20261110/`.
Dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund` in isolated baseline/candidate worktrees. Model/bot/database credential environment variables were removed for parent gate runs. Quote wrapper additionally denied Python socket connections. All data/transport fixtures were offline or loopback; no real business actions.

| Command / evidence | Baseline | Candidate |
|---|---|---|
| `node scripts/verify-luna-personality-contract.js` | exit 0; 172 pass | exit 0; 174 pass |
| `node scripts/verify-luna-personality-no-send.js` | exit 0 | exit 0; 30 pass |
| `node scripts/verify-luna-personality-radios.js` | exit 0 | exit 0; 66 pass |
| `node scripts/verify-luna-personality-runtime.js` | exit 1 | exit 1; same failure names |
| `python3 docker/hermes-staging/wolfhouse/test_luna_personality.py` | exit 1 | exit 1; same single failure |
| Focused Python binding/switch-back and snapshots/parity | existing baseline included above | exit 0; two selected tests |
| Existing `test_quote_authoring_context`, `test_accepted_quote`, `test_quote_polish` with offline wrapper | exit 0; 238 tests | exit 0; 238 tests |
| `node scripts/verify-luna-personality-staff-api.js` | exit 0 | exit 0; 69 pass |
| `node scripts/verify-wolfhouse-location-once.js` | exit 0 | exit 0 |
| `node scripts/verify-location-recipient-forwarding.js` | exit 0 | exit 0 |
| `node scripts/verify-hermes-send-flags.js` | exit 0 | exit 0; 55 pass |
| `node scripts/verify-luna-confirmation-spacing.js` | exit 0 | exit 0; 20 pass |
| `node scripts/verify-luna-booking-confirmation-beach.js` | exit 0 | exit 0; 6 pass |
| `node scripts/verify-sunset-payment-confirmation.js` | exit 0 | exit 0 |
| Both `verify-wolfhouse-paid-confirmation-style.js` and `verify-wolfhouse-paid-confirmation.js` | exit 1 | exit 1; Spanish shuttle-copy assertion |
| `npm run verify:luna-all` (final sequential rerun) | exit 1; 46/73 green | exit 1; 46/73 green; same failed-step list and failure headings |
| `git diff --check` | — | exit 0 |

Full personality failure expects absent SOUL wording `ONE quoted per-person deposit locks the whole group booking`. Runtime failures also include the cached-agent Sunset-role source assertion and the gateway-bind suite (including missing `gateway.run live-turn owner bind anchor`). Those failures reproduce on the untouched base. Paid-confirmation tests expect `recogida el` while source returns `recogida prevista el`. No unrelated assertions were weakened.

The broad gate is NOT green. Its unchanged failed steps include booking eligibility/name persistence, handoff, portal, personality/gateway and golden checks. Matching failure names is bounded regression evidence, not proof every failure has been diagnosed, and not a release waiver. Captain must assess release-critical failures before accepting deployment.

Evidence index:
- `final-baseline/`, `final-candidate/`, `final-comparison.json`: dependency-restored sequential focused/broad results and failure comparison.
- `baseline-regressions-with-deps/`, `candidate-regressions-with-deps/`: supporting location/send/confirmation gates and individual exits.
- `baseline-quotes-retry.log`, `candidate-quotes-full.log`: complete 238-test quote suites.
- `candidate-focused-python.log`, `repair-propagation.json`: focused binding/parity and exact switch-back checks.
- `run-offline-quotes.py`, `final-checks.py`, `check-preservation.py`, `check-repair-propagation.py`: one-shot local evidence wrappers, not product infrastructure.
- `manifest.json`, `SUMS.txt`: source identity, explicit NOT RUN model/staging cases and artifact checksums.

Initial missing-dependency runs, one 180-second quote timeout, a focused quote run missing the plugin import path, and an incomplete earlier candidate broad log are retained. The final sequential runs and completed quote runs supersede those execution limits only for these paths. The parent tool-approval pause was lifted by Earthling before verification/publication resumed.

## Independent source review

Independent reviewer returned diff-level PASS with no introduced security or logic findings. Parent verified the reviewed five-file diff SHA-256 remains `403fe824075ab805c1392136d1367676fdbc8573c47664514a8def9a71fb5620`. This hash excludes this subsequently added evidence document. Reviewer confirmed parity, exact preservation outside Conversationalist, unchanged safety suffix and non-weakened tests. Reviewer baseline experiments used in-memory HEAD sources and had a mixed-version parity limitation; the parent's separate pinned baseline worktree and final sequential runs provide the baseline comparison reported above. This is not Captain acceptance or release approval.

## Remaining gates / deployment handoff

- Captain's exact-head technical verdict: PENDING. An independent source review is supporting evidence, not Captain approval.
- Real-model baseline/candidate comparisons, critical repeats, held-out language/mood cases, Sunset behavioral controls and all intended-runtime final-path cases: NOT RUN. Every NV01–NV41 model/staging case remains explicitly NOT RUN in the local manifest.
- Ty's voice preference and an obvious perceived difference: NOT ESTABLISHED by offline checks or authored examples.
- Current setting, image, mounts, runtime lane, latency/token metrics and rollback pair: NOT INSPECTED.
- Preserve existing France staging routing/Staff binding, external delivery OFF, alerts unchanged, and a compatible rollback identity. No production credentials, second ingress or v3 relabeling. No new test infrastructure or business-write authority is implied.
- `node scripts/assert-repo-sync.js` ran and returned exit 1 because Lunabox was unreachable, the documented sandbox limitation. No sync-check bypass was introduced; operator preflight remains required.

## Same-message style samples — authored, NOT runtime output

Assumption for these illustrations only: authoritative tools support separate full-payment links, and no save/payment has happened. Guest: “No shuttle, we're driving. Can we each pay in full?”

- **Unchanged Sunny-style illustration:** “Yep! 🌊 You can each have a link for your full share. No shuttle needed.”
- **Conversationalist illustration:** “Yes — one full-payment link each, and no shuttle.”

Sunny is the source default, not a verified current live selection. These samples do not prove actual Luna output, consent to save, generated links, or a measured quality improvement.
