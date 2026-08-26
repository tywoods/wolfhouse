# Project FULL SAIL — Revised Email Completion Plan

> **For Hermes:** Execute from fresh exact-`origin/master` worktrees. Use isolated implementation, exact-head review, serial integration, immutable deployment, and deployed behavioral proof.

**Goal:** Finish ordinary front-desk email through controlled drafting, production rollout, optional generic mailbox support, and Luna policy/training/acceptance while deferring campaigns and real outreach.

**Architecture:** Staff API/Postgres remains authority; provider adapters stay behind the shared mailbox boundary; outbound operations use the canonical journal; credentials remain in Key Vault. Code completion, deployment, live proof, policy configuration, and rollout acceptance are separate gates.

**Tech Stack:** Node.js, PostgreSQL, Azure Container Apps/Registry/Key Vault, Microsoft Graph, optional IMAP/SMTP, Staff Portal, Hermes/Luna behavior specs and regression fixtures.

---

## Denominator and sequence

The project follows this sequence:

1. Stage 2 — Controlled Drafting
2. Stage 3 — Signal Fleet campaigns: **deferred**
3. Stage 4 — Harbormaster production rollout without campaigns
4. Stage 5 — Open Channel generic IMAP/SMTP: required only for provider-neutral launch
5. Luna email policy, training, evaluation, and bounded activation

A Microsoft-only launch may close without Stage 5. No campaign or real-recipient outreach is authorized.

## Universal lifecycle gate for every applicable stage

A stage closes only after all applicable evidence exists:

1. **Source acceptance:** exact reviewed head, focused/composed gates, clean merge-tree, accepted PR.
2. **Immutable integration:** reviewed identity preserved and remote merge/ancestry verified.
3. **Deployment:** exact clean-master SHA/digest on the named target; schema/config compatible; protected features initially off.
4. **Live validation:** controlled end-to-end mailbox journey with real deployed code, correct threading, exactly-once behavior, and safe uncertainty handling.
5. **Policy configuration:** explicit intent/fact/freshness/handoff/rate/kill-switch/tenant/provider policy, independently read back.
6. **Rollout acceptance:** shadow and canary evidence, monitoring, cost, incident handling, rollback, and operator sign-off.

Source/tests establish implementation readiness only. They do not close operational capability.

---

# Stage 2 — CONTROLLED DRAFTING

**Outcome:** Sunset proves that draft-only authority lacks `Mail.Send` while the existing staff-send path retains required authority, with no Graph message operation or operational mutation.

## Chapter 4J — Bounded proof and audit

### Slice A — Current-state read-only preflight
- Verify exact source ancestry, app/revision/image/digest, traffic, replicas, health, eight false gates, database/login/grant state, and canonical receipt readiness.
- Stop on drift or another active mutation owner.

### Slice B — One-shot proof
- Run only the reviewed owner from the required clean detached checkout.
- Exactly two refreshes on success; zero Graph calls; no draft/send/consent/grant/flag/database mutation.
- Never retry `outcome_unknown`.

### Slice C — Independent post-proof audit
- Re-read deployment, gates, receipt state, counts, health, replicas, and cost-leak state.
- Close Stage 2 only when current readback and durable evidence agree.

---

# Stage 3 — SIGNAL FLEET

**Status:** Deferred.

Campaign audience selection, consent/suppression, bulk scheduling, broadcasts, and real outreach are outside the ordinary email launch path. Stage 4 must not depend on campaign canaries. `CUSTOMER_OUTREACH_EMAIL_ENABLED` remains off.

---

# Stage 4 — HARBORMASTER

**Outcome:** Ordinary front-desk email runs on one exact production tenant with staff-reviewed replies, narrow controlled Luna behavior, monitoring, cost controls, and proven rollback. Campaigns remain absent/off.

## Chapter 9 — Production authority and policy

### Slice A — Exact target inventory
- Name production tenant/app/DB/identity/vault/mailbox/provider and baseline spend.
- Abort on ambiguity, shared identity, or staging-secret reuse.

### Slice B — Production custody and configuration
- Provision or bind least-privilege production-specific custody.
- Create an explicit feature matrix with inbound/staff-send/Luna gates default off and all campaign/outreach gates absent or false.

### Slice C — Policy packet
- Define autonomous allowlist, draft-only classes, mandatory handoffs, fact/freshness requirements, caps, breakers, and kill switches.
- Version the policy and verify effective server-owned configuration.

## Chapter 10 — Deployment safety

### Slice A — Migration rehearsal and rollback
- Rehearse exact migrations against disposable/restored state and prove rollback/backup handling.

### Slice B — Immutable release
- Build only clean current master, tag full SHA, resolve digest, and record included PRs/un-PR'd commits.

### Slice C — Flags-off deployment
- Deploy with protected features off; prove health/readiness, schema compatibility, exact image, traffic, replica count, env/secret references, and no cost leak.

## Chapter 11 — Live validation

### Slice A — Controlled inbound and staff reply
- Use one named operator-controlled mailbox/recipient.
- Prove ingest once, correct conversation/thread, staff draft/approval, provider call once, Inbox projection, restart/replay safety, and uncertainty behavior.

### Slice B — Luna draft-only canary
- Luna produces grounded drafts; staff approves every send.
- Verify recipient/thread/tenant binding, language, facts, handoffs, and kill-switch refusal.

### Slice C — Monitoring and incident controls
- Verify queue age, errors, duplicate counters, provider uncertainty, breaker alerts, logs, and operator-visible pause controls without exposing guest/secrets.

## Chapter 12 — Rollout acceptance

### Slice A — Go/no-go packet
- Exact target, SHA/digest, migrations, flags, traffic, health, live canary deltas, policy version, cost delta, monitoring, known limits, and rollback target.

### Slice B — Bounded activation
- Activate only intended ordinary email features; campaign/outreach stays off.
- Observe a fixed canary window and stop on predefined factual, duplicate, policy, provider, or spend thresholds.

### Slice C — Rollback and sign-off
- Prove application rollback and kill switches while retaining journal evidence.
- Obtain explicit operator acceptance for the bounded production scope.

---

# Stage 5 — OPEN CHANNEL

**Applicability:** Required only when generic IMAP/SMTP mailbox support is part of launch. Skip for Microsoft-only completion.

**Outcome:** One controlled generic mailbox ingests and sends correctly threaded, staff-approved SMTP replies exactly once through the shared Inbox/journal architecture.

## Chapter 13 — Connector authority
- Exact endpoint/provider/capability identity, Key Vault custody/rotation, verified TLS, hostname validation, bounded timeouts, and no plaintext fallback.

## Chapter 14 — IMAP durability
- UIDVALIDITY/UID cursor generations, leases, bounded MIME/HTML/attachment handling, tenant isolation, and exactly-once Inbox projection.

## Chapter 15 — SMTP reply safety
- Server-owned recipients and headers, correct `Message-ID`/`In-Reply-To`/`References`, canonical journal integration, and post-DATA uncertainty handling without blind retry.

## Chapter 16 — Staging then production acceptance
- Controlled mailbox ingest/reply/replay/restart/uncertainty proof on Sunset.
- Repeat the universal immutable deployment, live validation, policy, monitoring, rollback, and sign-off gates for the exact production connector target.

---

# Luna Email Readiness Workstream

**Outcome:** Luna moves from offline behavior tests to staff-reviewed drafts and then narrowly bounded autonomous replies without treating prompt work as operational acceptance.

## Chapter 17 — Behavior and authority specification

### Slice A — Email voice
- Match guest language; use appropriate greeting/sign-off; concise but complete answer; one clear next step; no internal jargon.

### Slice B — Closed decision matrix
- Enumerate autonomous, draft-only, and mandatory-handoff intents.
- Require fresh Staff API/DB evidence for prices, availability, booking, payment, and policy claims.

### Slice C — Failure behavior
- Define safe behavior for missing/stale facts, ambiguous identity/location, attachments, quoted instructions, provider failure, and guest-requested human help.

## Chapter 18 — Golden and hostile evaluation

### Slice A — Corpus
- English/Spanish, dates, groups, existing bookings, cancellations/refunds, payments, attachments, quoted-thread injection, wrong tenant/location, stale facts, and dependency failures.

### Slice B — Deterministic assertions
- Assert action class, fact references, recipient/thread authority, forbidden claims, language/tone bounds, handoff reason, and zero send capability in authoring.

### Slice C — Regression gate
- Add focused and composed verification with mutation coverage for critical authority and factuality rules.

## Chapter 19 — Shadow and staff-reviewed rollout

### Slice A — Shadow
- Run decisions/drafts without sends and compare against expected outcomes.
- Track factual errors, action-policy disagreement, missed handoffs, and language/tone failure.

### Slice B — Staff-reviewed drafts
- Staff approves every send.
- Measure edit rate, factual correction rate, policy override rate, rejection rate, duplicate/uncertainty events, and handoff quality.

### Slice C — Acceptance thresholds
- Define and meet explicit thresholds per intent before autonomy; do not average unsafe intents into a global score.

## Chapter 20 — Bounded autonomy

### Slice A — One-intent canary
- Enable one proven low-risk intent for controlled recipients with strict caps and all kill switches available.

### Slice B — Observe and expand
- Audit deployed outcomes and expand one intent at a time only after its own acceptance evidence passes.

### Slice C — Ongoing operations
- Scheduled regression, sampled audits, provider/queue health, duplicate/uncertainty monitoring, spend review, rollback drills, and periodic operator re-approval of policy changes.

---

## Final milestones

| Milestone | Exit condition |
| --- | --- |
| Infrastructure complete | Applicable stages are merged, immutably deployed, and proven end to end. |
| Luna draft-ready | Golden/hostile gates pass and deployed Luna creates grounded drafts with staff approval required. |
| Luna production-ready | Controlled production inbound and staff-reviewed reply canaries pass with monitoring and rollback. |
| Luna autonomous-ready | Explicit low-risk intents meet shadow/staff-reviewed thresholds and pass bounded live canaries. |
| Campaign-ready | Deferred Stage 3 is separately completed; real outreach additionally has an approved audience/content/sender/schedule/cap packet. |

## Progress reporting

Every update reports:

- `ACTIVE STAGE` bar based on that stage's deployed exit gate.
- `WHOLE PROGRAM` applicable exits closed, explicitly stating whether Stage 5 is in the denominator.
- `Done / Now / Next`.
- Separate labels for source-ready, merged, deployed-off, live-proven, policy-configured, and rollout-accepted.
