# GUEST-SIM-AUDIT-FIX-001 — WH staging guest-door repair

## Scope and evidence boundary

Local repair only. No deployment, production, Sunset/8094, WABA or live guest action.
Deposit-admin amounts and Sunset chrome are separate queued jobs; no admin UI or
pricing-engine change is included here. Ty's deposit rule remains €100/person for
≤5 nights and €200/person for ≥6 nights, with tool-returned full-payment-only truth.

The codebase already has a real shared-runner guest door, synthetic Inbox mirror,
booking/test-link capability, Staff-side effect budget, room policy, property notes,
transfer-price lookup and payment-failure handoff. This packet repairs their wiring;
it does not introduce a simulator twin, new booking brain or cancellation API.

## Reproduced causes

1. Evaluating the **tracked `hermes-luna` environment** in
   `docker/hermes-staging/docker-compose.vm.yml` failed with
   `wolfhouse_tenant_mismatch`, `public_pay_origin_missing`,
   `bot_booking_disabled`, `test_payment_config_missing`. Supply those explicit
   non-secret settings only to that WH staging service. Crow's Nest's default WH
   destination is this service on 8090. No other service/routing change is made.
   This is a source-config reproduction, not a readback of deployed environment.
2. No-tool guest turns returned a null capability, making the caller display the
   default `writes_and_external_sends_disabled` even if runtime admission passed.
   Admission is now reported before author execution; each Staff call still
   reevaluates it and rejects revoked work.
3. With admission enabled, the closed route set rejected property notes,
   package-price preview, transfer-price reads, and the existing Needs Human
   cancellation/help path. Add exact read paths. The first handoff admission
   failed independent review: Staff's last-nine-digit fallback could select a
   newer ordinary conversation, and suppression metadata was discarded. The
   revised packet requires downstream exact synthetic identity enforcement and
   preserved notification suppression, not just a rewritten outgoing phone.
   Missing capability and malformed synthetic identities stay blocked before
   transport. Never land the Python admission without the matching Staff repair.
4. The installed request guard discarded `_post_bot` keyword arguments; the real
   `get_transfer_prices` tool passes `require_explicit_success=True`. Forward those
   keywords without changing ordinary WhatsApp calls or bypassing any guard.
5. The plugin overwrote Staff's payment-choice-needed result even after a
   recognized deposit/full/split choice. Keep recognized choices through quote;
   blank or unknown input is not consent, and must not manufacture
   `full_payment_only`.
6. Staff already returns `available_beds` and `selected_room_code`; the guest
   projection discarded them. Expose only safe room/bed fields, not raw customer,
   booking, payment or internal metadata. Availability is not a bed assignment.

## Conversation corrections

The existing WH SOUL now makes explicit: preserve an already chosen deposit across
side questions; no claim of creation from a preview or blocked action; consult
notes/current permitted evidence for location/travel; answer requested compatible
room options rather than merely confirming space; resolve cancellation via the
existing verified handoff (never claim the booking is already cancelled).

Remove the incorrect blanket €100 instruction from the under-seven-night flow:
six nights is accommodation-only but has the higher deposit tier. Keep one
person's qualifying deposit distinct from the combined group deposits and from
an actual paid balance. All displayed money still comes from Staff tools.

These are prompt-contract corrections, not evidence that a live model now passes
the original conversation audit. No new phrase matching/state machine was added.

## Offline verification

Use the Hermes Python environment (gateway dependencies and PyYAML required):

```sh
PYTHONPATH=docker/hermes-staging /opt/hermes/.venv/bin/python -m unittest \
  wolfhouse.test_guest_sim_audit \
  wolfhouse.test_simulate_write_guards \
  wolfhouse.test_crowsnest_guest_door
node scripts/verify-wolfhouse-live-sim-booking-gender-001.js
node scripts/verify-hermes-send-flags.js
PYTHONPATH=docker/hermes-staging:docker/hermes-staging/plugins \
  /opt/hermes/.venv/bin/python -m unittest \
  wolfhouse_staff_api.test_guest_sim_quote_availability
node scripts/verify-guest-sim-needs-human-isolation-sql.js
node scripts/verify-luna-needs-human-no-pause.js
```

The handoff regression invokes the verbatim Staff handler and real resolver,
Needs Human update, pause and handoff SQL against isolated PGlite. The HTTP server,
auth bootstrap and real notification transport are not exercised. A notification
spy and network tripwires check suppression; ordinary/synthetic collision rows
and tenant/identity refusals check that no ordinary row changes. This is bounded
offline persistence proof, not a deployed-environment readback.

`test_guest_sim_audit.py` exercises real guest-door/Staff-plugin functions and
mirroring with an explicitly synthetic HTTP/author fixture and socket tripwires.
It checks booking ID + owned payment URL propagation, preserved deposit choice,
matching booking/Inbox/handoff identity and zero external transport. It does **not**
write a database, run a real model or create a staging booking. Existing guard
tests cover denied production/live mode, foreign payment UUIDs, timeout/revocation
and ordinary-traffic isolation. Gate logs and independent review travel in the
local evidence package, including any baseline-only failures.

## Landing handoff — Skipper/Deckhand

1. Land the reviewed local commit through the approved GitHub workflow; do not
   overwrite newer master or deploy a stale branch. No Captain push is authorized.
2. Separately authorized operator: verify Crow's Nest WH destination really points
   at `hermes-luna` (8090), not the sibling 8091 service or Sunset. If deployment
   routing differs, reconcile that finding before rollout; do not change it blindly.
3. Roll out the landed WH files + WH SOUL and the **WH service environment only**.
   A code/image-only rollout does not activate changed Compose environment. Do not
   use a broad compose-up/deploy that also restarts Sunset or crew services.
4. Verify Staff staging independently admits booking writes and test links:
   `BOT_BOOKING_ENABLED`, `STRIPE_LINKS_ENABLED`, approved staging public-payment
   origin, and actual test-mode Stripe configuration. Hermes' `test` marker is not
   proof of the downstream Stripe credential. Never weaken the Staff-side gate or
   send kill switches; never expose keys in evidence.
5. After separately authorized WH-only rollout, re-run the original guest audit
   from Crow's Nest → WhatsApp → Wolfhouse with a fresh synthetic phone. Required
   evidence: non-null admitted capability on greetings; actual booking ID and
   returned test-payment link; same synthetic identity visible in Schedule/Inbox;
   no duplicate deposit ask; grounded travel answer; compatible room options;
   cancellation request visible as Needs Human, not falsely cancelled.
6. Check the known-denied case too: failed admission must show concrete reasons
   and no booking/link claim. Verify zero external WhatsApp/SMS sends. Do not pay
   a link, contact a real guest, touch production/8094/WABA or declare live PASS
   from the offline fixture. No live Schedule/Inbox proof is supplied by this seal.
