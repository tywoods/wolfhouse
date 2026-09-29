# Persist guest names across quote/pay — L4 Implementation Plan

**Goal:** Preserve guest-provided booking contact and ordered roster across ordinary turns, quote changes and payment intent; never re-ask known names or substitute numbered primary-name placeholders.

**Architecture:** Reuse existing Hermes SessionDB persistence and the registered Staff tool boundary. Structured capture and explicitly observed lifecycle transitions own identity; transcript content is not its source. Keep Staff API as booking/payment truth. Fix structured-name continuity, not a second CRM, global phone cache, demographic inference or generic reply filter.

**Tech stack:** Python Hermes integration and unittest; existing Node offline gates / embedded PostgreSQL create proof; tenant SOUL markdown.

## Authority and scope
Chief authorized PLAN + BUILD through LOCAL CLEAN only for LUNA-PERSIST-GUEST-NAMES-001. Fresh GitHub master base `987c36cae3d4e80e96cbcb4c2114d56ee1b4bea6`. Root checkout has unrelated changes, so use this isolated worktree and durable evidence under `/opt/data/workspace/sandbox-repos/WH-captain/artifacts/luna-persist-guest-names-001/`.
No push, PR, land, deploy, Staff UI, prod, 8094, WABA, live Staff/provider/guest traffic. Do not cherry-pick or reopen L1–L3; L1 is present in this GitHub base. No changes to Skipper/Deckhand/Seadog routing/config.

## Existing capabilities credited
- Wolfhouse SOUL collects ordered first names early (Step 1B) and already says reuse them at create, irrespective of full/split payment.
- `_normalize_guests_payload` preserves compound names, duplicates and unnamed slots; create blocks missing/incomplete roster rather than creating placeholders. Existing `test_create_booking_guest_names.py` exercises registered create and embedded SQL.
- Quote copies parameters to Staff preview, but registered `quote_booking` schema has only `guest_name`, **no `guests` field**. Its returned quote drops contact/roster entirely. Re-quote therefore has no durable structured roster contract even though create requires one.
- Tools are otherwise stateless; missing names on create unconditionally ask again. Existing Hermes session persistence is the continuity owner, not transcript heuristics or process-global name memory.
- Sunset SOUL mandates quote-before-requesting-name but then unconditionally instructs asking for the name, even if the guest volunteered it earlier. Its booking is contact-based, not Wolfhouse accommodation occupants.

## Initial hypotheses / falsifiers (history-only approach superseded below)
1. Quote schema/result drop the roster: registered quote with complete ordered names, then re-quote/payment create omitting names loses them. Test real handlers and captured transport; do not invent a successful booking.
2. Ordinary history is available but tool omission cannot recover its earlier structured names: inspect existing ordinary run-conversation/session owners and bind a narrowly scoped recovery only if demonstrated. Never recover by global phone map or untrusted cross-tenant inputs.
3. Sunset instructions force a repeat ask after a volunteered name: test actual loaded SOUL and registered quote/create guidance, with known vs missing-name controls. Quote-before-name rule applies to solicitation, not forgetting unsolicited information.

## Implementation sequence
1. Trace ordinary session/history boundary and existing tests; record exact bounded design and root cause before product edits. Write a minimal failing registered/ordinary-path regression and capture RED on untouched behavior.
2. Add one shared ordered-name shape to quote/create schema; preserve explicit roster/contact through quote results and re-quote. Do not alter amounts, add-ons, room/gender policy, consent or payment behavior.
3. If ordinary tool calls omit names already captured structurally in this same conversation, restore only from that trusted session's namespaced SessionDB identity record via the existing turn boundary and explicit capture tool. Explicit current names/corrections win; empty/partial explicit roster must not be silently filled from stale identities; party-count mismatch must clarify only the unresolved roster. Fresh session/reset, different phone, tenant and location must not inherit names. Missing/no context keeps existing fail-closed behavior. No parsing arbitrary free text into names.
4. Align both SOULs and tool descriptions: retain volunteered names through side questions and quote/payment; request only genuinely missing names. Preserve compound/duplicate names and ordering; do not infer demographics. Sunset remains service/contact-only; no new accommodation intake.
5. Exercise focused registered handlers, re-quote/full/deposit/per-guest paths, correction/partial roster/count changes, fresh reset/tenant/phone isolation, consent negative controls, and ordinary entrypoint loading/binding with scripted model boundary. For Wolfhouse run existing real local SQL occupant readback from captured create payload. Clearly label fixture interpretations and no live inference/payment certification.
6. Add focused `verify-luna-persist-guest-names.js` gate and wire into existing aggregate/package scripts. Run focused/nearby gates and send switches; compare aggregate failures individually against untouched pinned base. No unrelated baseline repairs.
7. Freeze exact candidate, explicit stage and integrity manifest; independent security/logic/scope review PASS, resolve findings and repeat review as needed. Commit locally only after acceptance gates.
8. Read back clean local tip, seal plan, patch, Git bundle, red/green evidence, gate baseline comparison and review in transfer archive. Verify patch applicability, bundle import/tree equality, member checksums and archive SHA-256. Report LOCAL CLEAN with base/tip/path/hash and proof limitations.

## Expected owners (confirm against trace)
- `docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py` (name schema, quote/create continuity only)
- Existing ordinary conversation lifecycle owner, plus small request-scoped name helper if needed; no generic state service
- `docker/hermes-staging/plugins/wolfhouse_staff_api/test_persist_guest_names.py` (new)
- `docker/hermes-staging/SOUL.md`, `docker/hermes-sunset/SOUL.md`
- `docs/LUNA-GUEST-BEHAVIOR-SPEC.md`
- `scripts/verify-luna-persist-guest-names.js`, `scripts/verify-luna-all.js`, `package.json`

## Approved design revision — Chief CONTINUE

The initial history-only candidate is superseded. Chief approved a narrowly scoped identity record in **existing Hermes session persistence**, plus structured capture/update and explicit reset/continuation handling. No new database, global phone cache, raw-text parser, or payment/consent changes.

- Use the actual ordinary agent's existing `SessionDB` and namespaced `state_meta` records; no separate file/database/table and no tool-selected session or path. ContextVars carry only a request-owned capability to this record.
- `capture_booking_names` records explicit structured guest identity on name-only turns without requiring a quote/create. Wolfhouse supports ordered occupants; Sunset supports contact only. Scope identity is trusted session/tenant/phone/location, not tool arguments.
- Do not restore identity from tool-result JSON or arbitrary transcript text. Forged-history input has no authority. Existing untagged/raw-text names require model extraction into the explicit capture tool; no heuristic parser.
- Preserve through same-session compaction and explicitly observed successful runtime compression transitions. Parent linkage, timestamps and `end_reason` do not authorize inheritance: a generic fork from an already compressed parent satisfies those heuristics. Install the observer before preflight, persist authorized transfers immediately, and load only each session's own record thereafter. Reset/fresh session/fork must not inherit.
- Revoke OLD identity at actual trusted reset/delete boundaries independently of worker ContextVars; gateway reset identifies NEW as `session_id` and OLD as `old_session_id`. Include Inbox Clear/legacy reset paths that bypass plugin reset callbacks. Preserve ordinary `agent_close` continuity. Missing persistence, malformed records, scope mismatch and deleted/revoked sessions fail closed; atomic incarnation/epoch checks must fence stale reads, writes and transfers.
- Required-runtime verification is `node scripts/verify-luna-persist-guest-names.js --require-runtime` with explicit pinned-runtime `PYTHON`/`PYTHONPATH`. It forbids skipped tests and includes core lifecycle tests. Default portable coverage and `--contract-only` are not full persistence acceptance.
- Repair the wrapper's invalid-count regression without changing L1's count guard. Complete Sunset contact continuity, ordinary zero-network fixture setup and adversarial controls.
- Preserve the measured untouched-base reds individually; no unrelated repairs. Freeze, gate, independent exact-candidate review, local commit and verified seal remain required. Earlier intermediate GREEN-method logs with network attempts are not acceptance.

## Approved post-review contract — Chief CONTINUE

Remembered identity and booking-payload eligibility are distinct. Partial structured capture updates only explicitly supplied fields. A contact correction preserves occupants; a roster correction preserves an independently supplied contact. Explicit empty contact remains empty. Count changes retain known names for targeted clarification, but incompatible/ambiguous remembered rosters cannot automatically fill a booking payload. Do not infer count, truncate names, or modify existing booking/money/consent validators.

Inventory supported runtime deletion/reset methods instead of assuming they all delegate to singular deletion. Bulk deletion must revoke the explicitly transferred identity family inside the successful transaction; no-op and failed transactions must preserve unrelated/current identity and truthful failure reporting. Keep existing observed compression authorization and atomic stale-worker checks. No new persistence schema, database, global cache or transcript parser.

Reproduce and fix the five independent review assertions through registered tools and actual runtime/temporary SQLite transactions. Retain RED evidence and separate fixture assumptions from runtime behavior. Update tests that previously endorsed destructive identity replacement, not other baseline expectations. Re-freeze, stage explicitly, rerun required-runtime/ordinary/SQL/prompt/guard and baseline comparisons, and obtain a new exact-candidate independent review before local commit/seal.

Chief's latest runtime-inventory retry approval explicitly keeps legacy Inbox Clear/false-success orchestration separate. Those three failed DELETE/END/CREATE diagnostic findings remain documented, unmodified known limitations—not safety passes or repaired behavior. No legacy expansion without renewed approval. This packet's acceptance requires the five identity/revocation assertions plus supported deletion boundaries, ordinary-runner proof, and independent review; existing Inbox Clear success-path integration remains required.

## Approved two-fix revision — Chief CONTINUE

The second independent review and parent reproduction both found two further blockers. Prior green gates are necessary but not sufficient for acceptance.

- Supported separate-process deletion/pruning must invalidate explicitly transferred identity even when the deleting process never loads the plugin. Enforce this through existing scoped identity persistence and observed transfer authority; no installed CLI/runtime/configuration or database-schema changes, no inferred ancestry. Cover reopened and stale/copied workers, reads/writes/transfers, unrelated families, failed/no-op operations and session-ID reincarnation.
- A create call omitting count/roster must still clarify a known incompatible or ambiguous remembered party. Do not let withholding the roster silently convert a group into contact-only create. Do not infer or inject count; retain existing booking, price and consent authority. Cover changed counts, partial/empty rosters, invalid aliases, compatible explicit rosters and genuine contact-only controls.
- Add the two independent assertions to frozen-candidate acceptance without replacing the prior five. Preserve RED evidence. Re-run all focused and baseline gates; obtain a new exact-candidate independent review before local commit/seal. Legacy Inbox false-success orchestration remains separate.

### Two-fix implementation and limits
Existing epoch metadata stores the session IDs and `started_at` incarnations added only by initial binding and observed compression. Revised consumers validate those witnesses before identity reads, writes and transfers; successful helper-unloaded deletion/pruning is detected durably. There is no parent-link inference and no CLI hook installation. Missing/reset/recreated witnesses invalidate the authority. Witness-less legacy authority fails closed; preflight may not rebind a blank continuation after a tracked transfer fails.

Registered create separately checks retained party compatibility before calling the existing booking handler, reusing its structured roster-clarification result without adding count to the payload. This is an identity veto, not booking authority.

Logical revocation is not physical erasure of every historical metadata value. Witness validation scales with explicitly observed family size. It requires revised workers and existing `started_at` incarnation semantics; it does not certify old deployed workers, arbitrary database tampering/restoration of identical historical incarnations, or external reset paths that do not change observed state. Legacy Inbox false-success orchestration remains expressly excluded. CLI evidence is unchanged handler/API execution, not full startup parsing. Final required-runtime verification must use the pre-import audit adapter as well as clean-HOME/native confinement.

## Approved round-3 design checkpoint and minimal repair — Chief CONTINUE

Chief approved this checkpoint **and** its minimal implementation; this is not authorization for a broader redesign. Round-3 evidence remains preserved under `failed-review-round3/` and `parent-third-review/`. No installed runtime, routing, schema or legacy Inbox orchestration changes.

### Contract / linearization point

The previous `apply_names → needs_party_clarification → remember_names → handler` create sequence is superseded. Its independent checks collapse read failures to payload/False/None and allow an earlier partial projection to escape. Replace the create path with **one names-only preparation decision** under the current turn lock and one existing SessionDB transaction:

1. Validate bound agent, session incarnation, scope, current record generation and family witnesses. A bound ordinary worker with missing/failed/revoked authority is **unavailable**, not a healthy contact-only party. An actually unbound standalone caller may preserve explicit-only legacy validation; it must never acquire remembered identity or conceal an ordinary binding failure.
2. From the same verified snapshot, merge explicit identity fields, evaluate party compatibility and derive an independent detached outgoing payload. Never invent or rewrite count, money, consent, room policy or booking truth. Known incompatible/partial parties yield clarification; unavailable identity yields a non-writing recovery result, never transport. Invalid explicit counts retain the existing validator's precedence.
3. Persist only caller-supplied identity changes within that transaction. Any read/write/commit failure aborts the decision and dispatch; update in-memory generation only after successful commit. A failed persist cannot approve an earlier projection. No dispatch on malformed/missing epoch data, failed ordinary binding, copied stale worker or revocation already visible at this transaction.
4. Return an explicit outcome (`ready`, `clarify`, `unavailable`, or narrowly defined explicit-only standalone), not a boolean with overloaded False. Only eligible outcomes may invoke the unchanged business handler. Avoid a separate read or later fallible save between decision and dispatch. Do not hold the SQLite transaction across backend I/O. The committed local decision is its linearization point; this does not claim distributed atomicity with Staff API or retroactive cancellation after that point.

### One contact precedence

Use the existing ordered aliases (`guest_name`, `name`, `booking_name`, `channel_guest_name`, `whatsapp_guest_name`) with **first present field wins**, not first truthy field. Apply the same rule to persisted identity and create's canonical contact normalization. Explicit empty canonical contact must stay empty and take the existing missing-name path; no alias, remembered contact or first-occupant fallback may overwrite it. Preserve existing handling when all contact fields are genuinely absent and preserve valid contact-only bookings. Conflicting explicit canonical/alias values must agree in persistence and outgoing contact. Do not alter non-identity payload fields.

### Bounded files and vertical proof sequence

One repair owner edits only:
- `docker/hermes-staging/wolfhouse/booking_names.py`
- `docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py`
- `docker/hermes-staging/wolfhouse/test_booking_names_persistence.py`
- `docker/hermes-staging/plugins/wolfhouse_staff_api/test_persist_guest_names.py`

Parent owns this plan and artifact-only gate/receipt work. No staging/commit by the repair owner.

1. Add registered-create denied-read reproduction first; run RED under the existing pre-import audit/native confinement, then implement the single-decision path and prove GREEN.
2. Exercise clarification-stage I/O failure semantically through actual read/transaction failure (not an obsolete hard-coded second-call ordinal), commit/write failure, missing/malformed authority and revocation visible before decision. Preserve the old reproduction verbatim as historical evidence and document changed transaction shape. Assert no transport and no false save/success. Include healthy contact-only and unchanged invalid-count controls.
3. Add explicit-empty/alias reproduction RED, repair presence-based create normalization, then prove GREEN for canonical empty/conflicting alias/empty alias/remembered contact/roster fallback. Preserve ordinary and Sunset behavior, including consent and optional quote contact.
4. Repair only the confounded lifecycle test setup: seed age/pruning eligibility **before capture**, assert live identity immediately before the mutation, then prove revocation. Keep separate-process CLI delete/prune/reincarnation coverage.
5. Parent independently runs round-3 contract assertions against rejected bytes (RED) and repaired bytes (GREEN), retaining prior five assertions, prior two contracts, ten cross-process scenarios, required-runtime/ordinary/real-SQL/prompt/guard checks and exact baseline comparison. Regenerate the stale consolidated baseline receipt against the new full manifest.
6. Freeze/stage exact bytes, fresh independent full-candidate review PASS, then separately finalize acceptance, commit/read back clean local tip, and seal/verify the transfer packet. No push/land/deploy/live guest action.

### Round-3 implementation and proof status

`create_decision` now performs live authority validation, explicit-field merge, compatibility decision, detached projection and identity persistence in one transaction under the bound turn lock. Worker state advances only after the transaction commits; unavailable identity has no eligible projection. Create no longer chains `apply_names` / `needs_party_clarification` / `remember_names`. Existing quote projection remains separate. Contact normalization uses first-present precedence at create and occupant normalization; Sunset consent remains independently enforced.

The owner added denied-read, semantic mid-read, SQLite persistence/COMMIT, malformed rebind, missing/revoked/closed context and contact-precedence regressions. The cross-handle age setup now establishes eligibility before capture and asserts identity is live immediately before deletion. Parent independently ran 14 registered-boundary tests against both preserved rejected bytes (RED failure paths, GREEN healthy controls) and repaired bytes (all GREEN); no test-child network/process attempts. That is deterministic code/handler proof, not model-behavior or live booking certification. The historical transaction-2 failure is superseded by semantic read-failure coverage and the exactly-one-transaction assertion, not counted as an exercised second transaction on the new path.

This document is frozen **before** final gates and independent review. Execution receipts, exact-manifest baseline comparison and review outside the repository determine acceptance. No pre-written PASS or LOCAL CLEAN claim is made here.

## Chief-approved round-4 repair — same L4 job

The preceding candidate failed independent review despite its focused gates passing. Rejected bytes, report and bounded evidence remain preserved under `artifacts/luna-persist-guest-names-001/failed-review-round4/`. Chief authorized one bounded cycle for **IR4-001, IR4-002 and IR4-003 only**, with one repair owner using the same four implementation/test paths above. Parent retains plan and artifact-only acceptance ownership. Installed runtime, routing, schema and legacy Inbox orchestration remain excluded.

### Required boundary outcomes

1. **IR4-001 — malformed incarnation:** Existing metadata missing `started_at` is not evidence of a fresh session. Reject malformed incarnation metadata before any fresh epoch/generation claim or dispatch. Exercise missing/wrong-type values through rebind and registered create; preserve healthy first binding and legitimate supported recreation behavior. This is malformed-record failure injection, not a claim of security against arbitrary malicious database rewriting.
2. **IR4-002 — helper unavailable:** Registration/setup failure cannot remove the ordinary create boundary. An ordinary AIAgent turn without identity authority must not reach transport even with complete explicit contact/occupants. Prove this through the actual installed AIAgent loop with scripted responses and intercepted unsuccessful transport, not a helper-only unit assertion. Preserve genuine explicit-only standalone compatibility where it is safely established; uncertainty is not proof of standalone execution.
3. **IR4-003 — invalid contact:** Persisted contact and outgoing contact must agree. Reject the 513-character boundary and wrong-type explicit values without dispatch or treating invalid input as an explicit clear of known identity. Prove 512-character and normal contact controls remain eligible and preserve explicit empty precedence. No truncation/invention of identity or nonidentity payload changes.

### Execution and acceptance

- Owner adds one boundary regression and runs RED before each minimal repair, then GREEN; preserves owner logs/receipts under `round4-repair/`. No owner staging/commit.
- Parent's independent `round4-acceptance` probes exercise eight registered-boundary tests plus a separate actual-AIAgent helper-unavailable scenario. On byte-verified rejected source, all three reported defects and related malformed-field boundaries are RED, while healthy bound, standalone and 512-character controls are GREEN. No child network/process attempts. These are contract assertions, not live booking/model certification.
- `round4_guard.py` requires matching source/harness/log/result hashes and genuine rejected-versus-repaired execution. The new contract is mandatory in focused acceptance, finalization, commit and sealing; missing or RED evidence fails closed.
- Keep the prior five assertions, two-fix contracts, round-3 boundary suite, separate-process lifecycle scenarios, required-runtime/ordinary/local SQL/prompt/send-switch gates and exact baseline comparison. Do not edit fixtures merely to obtain green counts or relax authority to preserve an unsafe old path.
- Once owner writes stop, verify hashes and scope, freeze and explicitly stage exact bytes. Rerun full gates and regenerate the exact-manifest baseline receipt; obtain fresh whole-candidate independent review. Only verified IR PASS plus all bound gates permits separate acceptance, local clean commit/readback and sealed transfer verification. No push, land, deploy, provider or live guest action.

This amendment records authorized contracts and observed rejected-source proofs, not a repaired-candidate PASS. Final status is determined by bound execution and independent-review receipts outside the repository.

## Runtime compatibility and proof limits
The revision inventories `end_session`, singular/conditional/bulk deletion, empty-session deletion, age pruning, ghost pruning, and actual delegate cascades in the tested runtime. Deletion observers compare session IDs before/after the owning transaction, then revoke only affected identity families. This adds a session-count-proportional scan to those deletion transactions. Process-local instrumentation alone is insufficient: supported CLI deletion/pruning can bypass plugin discovery. Chief's approved two-fix revision requires durable identity checks across those processes without changing the installed CLI/runtime or routing. The unchanged CLI handler must be exercised without plugin hooks; separate database handles within an instrumented process are not sufficient proof. Runtime API changes require a new inventory and gate run. Arbitrary external SQL is not a substitute for supported-entrypoint tests.

Ordinary-turn proof injects scripted model responses into the real AIAgent loop and invokes actual registered handlers against temporary SQLite. Local SQL occupant proof executes the existing verifier through a confined parent launcher; test children do not execute subprocesses. This is not live inference, successful payment, or production booking certification.

## Acceptance / risks
No names may leak between sessions or tenants. Stored names are guest-provided identity text, never price/payment/consent authority. An explicit correction replaces only its identity field; a new group or changed count must not silently recycle the old roster or erase still-known identity needed for clarification. Test absence of network and external writes. Offline assembled-prompt/structured-handler proof does not certify every live model utterance, and transport capture is not a real payment or deployed booking.
