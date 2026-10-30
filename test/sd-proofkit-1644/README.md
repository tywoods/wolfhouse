# SD-PROOFKIT-1644 — France TEST acceptance kit

**Scope:** Wolfhouse/Luna on France TEST only. This is a QA-only pack: it does not deploy, restart a gateway, send WhatsApp, alter Staff state, use credentials, or touch production/Sunset/Oracle/Lunabox.

## Closed matrix

`france-test-scenarios.json` contains exactly 18 booking journeys:

- languages: DE, ES, EN;
- party/room: solo/shared, couple/private, group/shared package;
- payment: deposit and full.

Every booking receipt must prove the TEST Staff read-back **inside the actual outgoing guest text**: reference, every name, Staff-authoritative room label, dates, total, deposit, and payment link. `fact_spans` are offsets into the captured outgoing messages; the verifier extracts those spans and compares them to Staff facts, so duplicate receipt metadata cannot pass. It also rejects a second acceptance/save prompt and requires a single-register German analyzer result plus `DD.MM.YYYY` evidence for each supplied German date.

No guest wording or guest-copy dependency is stored in this pack. Capture files remain outside Git and must contain no credentials.

## State proofs

The same receipt run has three additional must-pass cases:

1. **`SD1644-CLEAR-ATOMIC`** — Clear is one atomic outcome: `cleared_at` persisted, refresh is empty while history remains retained, Needs Human is false, hold is false, Luna toggle is on, and the next inbound obtains a reply.
2. **`SD1644-PAYLINK-FAIL-KEEPS-TALKING`** — a forced TEST payment-link failure leaves Needs Human/hold false, Luna on, and produces a retry/recovery reply.
3. **`SD1644-REAL-HANDOVER-SILENT`** — real handover visibly pauses Luna; an inbound while held has no generated reply and no suppressed-send log; both Resume and Clear lift the hold.

## Receipt collection contract

Bug Finder writes one private JSON receipt per case to a private absolute directory. Each receipt must identify `environment: "france-test"`, `tenant: "wolfhouse-somo"`, `production: false`, and `outbound_live_whatsapp: false`. The complete required field shape is in `receipt_contract` in `france-test-scenarios.json`.

The collector must capture dynamically sourced booking/payment facts from TEST Staff rather than freezing values into this repository. For outgoing messages, retain text only in the private receipt and include SHA-256 hashes; do not post messages or personally identifying payloads into Discord.

## Commands

```bash
# Offline syntax + deterministic verifier self-test; no network or mutation.
node --check test/sd-proofkit-1644/verify-france-test-proofkit.js
node test/sd-proofkit-1644/verify-france-test-proofkit.js --self-test

# After the separately authorized France TEST run:
node test/sd-proofkit-1644/verify-france-test-proofkit.js --receipts /absolute/private/receipt-dir
```

A non-zero result is a failed acceptance run; it must not be relabelled as PASS. `--receipts` is deliberately an offline receipt validator, not an execution launcher: France TEST endpoint, authentication seam, disposable identities, and the approved state-changing runner are not present in this worktree and must be supplied by the authorized Bug Finder run.

## Current source baseline observation

The current `origin/master` Clear owner (`scripts/lib/staff-inbox-clear-thread.js`) clears `needs_human` after the Hermes session reset but has no `cleared_at` persistence or conversation-pause/luna-toggle release contract. The historical Wolfhouse needs-human verifier also encodes `needs_human -> pause`. Therefore the new atomic Clear and single-hold state proof are expected to fail until the P1 implementation lands; this kit is ready to score that implementation, not evidence that it already exists.
