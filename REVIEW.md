# Chief Option A — live preservation review

## Scope and provenance

Base is exactly `6aba2a5d081af9a53d9b418ac05dd136c205c459` (`origin/master` at fetch time). Only the 12 direct unpacked documents named in the receipt were read; no archive was inspected. All 12 SHA-256 values matched the receipt.

## Hunk disposition

### SOUL (`doc_1e83cc295953`)

**Included, reconciled rather than copied:**
- past-date refusal, without the live instruction to run a shell command from the model prompt;
- per-guest link/name binding and preservation of full occupant names;
- accepted unchanged offer progression and revalidation-preserves-consent, tightened around authoritative owner success, material-term equality, exact beds/catalog selections, uncertain-write recovery, and fresh acceptance after any change.

**Rejected:**
- live replacements that delete canonical catalog atomicity, owner-led accepted-quote semantics, explicit split-payment choice, post-payment-intent room policy, handoff truth, and current package-minimum rules;
- unsafe create-first/attach-catalog-later behavior;
- fixed seven-night package policy;
- room wording that could override tool-authoritative eligibility or the one-question/owner flow;
- live rewrites to first reply, package text, surf lesson quantities, scheduling, room policy, and hard rules where master is newer or stricter.

**Needs ruling / intentionally not shipped:**
- broader live room-description/room-eligibility prose and email-after-create behavior. These may be valid product requirements, but they change policy beyond this preservation/security reconciliation and need canonical-spec/owner approval.

### Staff plugin (`doc_1fb28285418e`)

**Included:** none. The independently useful stable message identity is an ingress concern and was implemented at the simulator/crowsnest boundary instead.

**Rejected:** all stale live replacements/removals, especially removal or weakening of `staff_transport_denial`, typed 409 refusals, `offer_revision`/availability continuity, catalog selection atomicity, accepted-quote owner wrapper/hook, pending recovery, and explicit split choice. Also rejected live process-local quote/turn markers, guest-map fallbacks, response-shape edits, create-first/catalog-later instructions, and policy changes that would bypass authoritative owner state.

**Needs ruling:** live-only presentational fields such as selected-room prose, amount-paid display, and staff-review IDs were not copied because their provenance/contract is not demonstrated by focused owner-path tests in this receipt.

### Crowsnest (`doc_498cd15a8a3e`)

**Included, reconciled:** bounded stable simulator message identity (`message_id`/legacy `whatsapp_message_id`) threaded through existing request-owned execution. It does not become write authority or replace current owner fences.

**Rejected:** every removal of lifetime fences, sticky uncertainty, context ownership, golden namespace/cleanup/recovery safeguards, write guards, task ownership, late-worker quarantine, and current transport protections. Also rejected the live process-local `_SEEN_SIM_MESSAGE_IDS` dedupe/reply recovery because it is not durable, is not tenant/session scoped, and could mask missing authoritative output.

### Simulate core (`doc_6884e9564ecd`)

**Included, reconciled:** message identity forwarding while preserving `allow_writes=False`.

**Rejected:** removal of mandatory `LUNA_BOT_INTERNAL_TOKEN`, missing/invalid body checks, thread/text validation, golden authorization, and fail-closed error behavior. Endpoint authentication and body validation remain unchanged.

### Pass-4 source-only modules

Excluded all four direct modules:
- `admission_lock_owner.py`
- `identity_admission_owner.py`
- `terminal_operation_journal.py`
- `admission_lock_adapter.py`

Their docstrings identify them as proposed/source-only, and this repository has no explicit runtime owner path or tests proving these exact files are the intended packaged source. Existing `test_pass4_ingress_matrix.py` is an abstract matrix, not provenance for these modules. No integration was invented.

## Security regression pins

`test_live_preservation.py` checks:
- included SOUL rules and unchanged catalog/package/one-question safety;
- current plugin transport denial, typed refusal, offer revision, accepted-quote owner and pending recovery markers;
- authenticated simulator route still has mandatory token/body validation and forwards only message identity with `allow_writes=False`;
- proposed `/opt/hermes` pass-4 modules are not packaged into the repository;
- stable identities are bounded and malformed values fail closed.

## Test results

- compileall: PASS (3 changed Python files)
- focused preservation verifier: PASS, 5/5
- combined relevant suite: 58 discovered; 50 passed, 8 environment/import errors. The errors are from absent runtime-only dependencies (`gateway`, `hermes_state`, `yaml`) in this checkout and resulting crowsnest setup timeouts; no assertion regression was reported.
- `git diff --check`: PASS

No secrets, state files, logs, databases, Lunabox, deployment, merge, production, Sunset, guest, payment, or booking operations were touched.
