# LUNA-PAYMENT-FAIL-HUMAN-HANDOFF-001 — L2 implementation plan

**Goal:** A genuine failed payment operation gives an honest response and attempts the existing tenant/session-scoped human handoff, never fabricated payment success or a silent dead end.
**Authority:** Chief PLAN+BUILD → LOCAL CLEAN only. No push/land/deploy, production, 8094, WABA, Staff UI, Transfer/Yoga reopen, L3/L4 or Owner Lab work.
**Base:** GitHub master 3357e06cc6aade307ef21c770840a790a8e47ade. Independent worktree `worktrees/luna-payment-fail-human-handoff-001`; parent dirty checkout untouched. Accepted L1 is a separate unlanded packet, not included here.
**Architecture:** Reuse Hermes Staff plugin payment wrappers and existing `flag_needs_human` / ordinary handoff lifecycle. Staff API remains financial and handoff persistence authority. No new service, routing change, queue, payment retry, UI or payment ledger write.
**Tech:** Python plugin/unittest, Markdown SOUL instructions, Node offline gates and existing Staff persistence SQL.

## Inventory and observed repro
- Shared owner: `docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py` (both tenants).
- Existing payment tools: create_payment_link, create_balance_payment_link, create_guest_payment_link, create_sunset_payment_link; booking-create also requests whole/per-guest links. Payment status tools already exist.
- Existing handoff: flag_needs_human binds runtime tenant and session phone and uses `wolfhouse/explicit_human_handoff.py`; request-scoped send/isolation controls remain unchanged. Staff `luna-guest-handoff-persist.js` owns durable Needs Human.
- SOULs already prohibit invented payment truth and promise-without-handoff. Preserve and strengthen these, do not invent a second handoff mechanism.
- Offline reproduction (real wrappers, injected Staff transport failure): Sunset returns `Let me sort the payment link with the team` with no handoff request; Wolfhouse returns `next_action=send_secure_payment_link` with no URL. Exactly two payment requests, zero Needs Human requests; assertion fails. This is source/offline evidence, not a claim about a captured live conversation.
- Inline booking-create explicitly sets needs_human false; per-guest failures can be ignored when another link succeeds. Inspect and cover these within payment handling only.

## Ordered work
1. Add a focused offline unittest in `docker/hermes-staging/plugins/wolfhouse_staff_api/test_payment_failure_handoff.py`. Exercise real wrappers with blocked network / controlled urllib responses. Record RED before production edits.
2. Repair only payment result handling in `__init__.py`: reuse flag_needs_human with explicit `business_tool_error` context; require confirmed handoff before promising team follow-up. Preserve booking write truth separately from checkout failure. Remove failed/stale URL or success-next-action signals. Keep partial group-link success identifiable and do not recreate booking or retry financial writes.
3. Preserve recoverable guards: missing details/identifiers, wrong payment ID recovery, no amount due/already-paid, intentional simulator denial and successful links. Failed handoff must report unconfirmed and give a direct human-contact next step, not an empty answer or a false promise. Verify trusted tenant/phone binding and no pause changes.
4. Add tests per behavior slice: whole/deposit, balance, guest, Sunset, booking inline single/partial/all failure; actual HTTP error/timeout/malformed success; handoff failure; successful/no-due/recoverable/intentional-denial negatives. Guard status-read errors from false paid claims, and cover failed provider status if supported by current owner contracts. Record payment and handoff outcomes separately.
5. Update only payment-failure clauses in `docker/hermes-staging/SOUL.md` and `docker/hermes-sunset/SOUL.md`: explicit payment-failed guest report is not payment truth, use status authority, honest human follow-up; no automatic checkout retries, no denial of a saved booking, no success claim and no handoff promise before receipt. Clarify successful tool-managed handoff needs no duplicate call.
6. Reuse ordinary Staff handoff persistence in a bounded offline proof where feasible, not only a mocked success counter. No live services/provider/model calls. Add gate registration only if required for repeatability.
7. Run focused and nearby guards, send flags, handoff/no-pause/isolation checks and full offline Luna gate. Compare any existing red gates against the same pinned base. Document proof limits (no live model, webhook delivery, provider checkout or staged deployment).
8. Stage explicit files; security scan and independent exact-diff review. Fix blockers and rerun. Commit only on PASS, then read back clean status and reviewed blob identity.
9. Seal artifact with plan, tests/red-green/gate receipts, review, diff/patch, bundle and handoff. Verify SHA-256 and archive contents/import tip. Return LOCAL CLEAN tip/base/package/hash for separately authorized Skipper landing.

## Post-FAIL continuation (Chief-approved)
- Preserve actual Staff policy-denial contracts through the payment transport boundary: Wolfhouse Stripe/booking disabled flags and Sunset staff/provider restrictions must not flag Needs Human. Unknown authorization failures remain operational failures; do not exempt every HTTP 403.
- Close the reproduced ordinary-turn acknowledgement/receipt gaps in the existing handoff owner only: name the failed payment step before persistence without promising takeover, require literal true receipt fields, and correct an unconfirmed handoff before suppressing the ordinary final reply. Keep cancellation, trusted identity, isolation and pause behavior unchanged.
- Include the previously untracked ordinary-payment regression in the registered gate, staged manifest and fresh independent review. The prior staged-candidate review does not cover it.
- Compare `hermes-tool-guards`, `ordinary-handoff` and `luna-all` against untouched pinned base, failure by failure. Existing reds are qualifications, not a green full-suite claim.
- Freeze all candidate files before final gates/review; commit and seal only the reviewed tree. Prior FAIL remains evidence, never acceptance.

## Risks / stop conditions
- Existing ordinary handoff may send its own deterministic acknowledgement; reuse it rather than adding another sender. Tool/offline tests cannot establish actual generated guest copy.
- A failed checkout can coexist with a saved booking, earlier payment receipts or successful links for other guests. Never erase those facts or claim all group links succeeded.
- Intentional simulator blocks are not failures; do not bypass capability or tenant guards to get a green test.
- Missing trusted identity / handoff persistence outage cannot honestly claim a human is notified. Make that limitation explicit with a safe human-contact fallback.
- Scope expansion into gateway send-policy repair, Staff UI, payment reconciliation/ledger repair or deployments requires a new approval.
