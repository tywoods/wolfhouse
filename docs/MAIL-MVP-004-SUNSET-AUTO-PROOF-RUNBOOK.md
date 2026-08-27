# MAIL-MVP-004 — Sunset Microsoft auto create-and-send operator proof

Sunset staging only. **BUILD/TEST/PUSH ONLY in this slice.** Do not execute cloud, live Staff, Graph, or provider work from this builder.

This slice does **not** rebuild MAIL-MVP-003. It adds a fail-closed operator harness that may later invoke the canonical 003 production auto owner **exactly once** for the existing guest-linked thread:

- Subject: `Testing 8 26` (inbound; `Re:` prefix allowed; bind after stripping `Re:`/`Fw:`/`Fwd:`)
- Authoritative inbound sender: `twoods@xantrion.com` (UI may render `twoods`; never bind display name)
- Microsoft Graph mailbox only
- Luna On, `needs_human` false
- Staff API Create Draft + Approve & send owners
- Email Luna Hermes `openai-codex` / `gpt-5.6-sol` thread-specific draft (empty operator context)
- Exactly one approval, one journal, one provider send for that inbound operation
- Duplicate / idempotent outcomes must be reconciled before any retry

## Exact-master image requirement (hard)

Code running inside an **old Staff image cannot be copied as proof**.

Live proof is **blocked** until all of the following are true:

1. MAIL-MVP-004 is merged to `origin/master` with a true merge (operator does this later; this slice does not open a PR, merge, or deploy).
2. A clean laptop checkout at that `origin/master` SHA passes `node scripts/assert-deploy-from-master.js` (`npm run deploy:preflight`).
3. Staff image is built **from that exact master SHA** and tagged with that SHA:
   - repository `whstagingacr.azurecr.io/luna-sunset-staff-api`
   - tag = 40-hex `origin/master` SHA
4. Only `luna-sunset-staging-staff-api` in `luna-sunset-staging-rg` is updated to that image. No production, no `staff-staging`, no new mailbox, no gateway restart, no `/sethome`, Salt, Deckhand, or Full Sail 4J.
5. The serving revision runs that image. The inner entrypoint that exists **inside the image** is `scripts/prove-mail-mvp-004-auto-create-send.js`. Do not `cat`, `printf`, or copy a newer script into `/tmp` on an old replica and call that proof.
6. Independent preflight then shows current selected-operation approval/journal/provider counts at **zero/new**, flags currently false, and channel automation not already `auto`.

Until that image is serving, the harness must refuse `execute-once` with `exact_master_image_required` / `head_not_origin_master` / `proof_files_not_on_master`.

## Owners

| Piece | Path |
| --- | --- |
| Canonical auto owner (003, unchanged) | `scripts/lib/email-luna-microsoft-auto-create-send.js` |
| Proof harness | `scripts/lib/email-luna-microsoft-auto-create-send-live-proof.js` |
| CLI | `scripts/prove-mail-mvp-004-auto-create-send.js` |
| Offline verifier | `npm run verify:mail-mvp-004` |
| Adjacent 003 gate | `npm run verify:mail-mvp-003` |
| Adjacent 007 gates | `npm run verify:mail-mvp-007` and sol-empty gates |

## Default refuse / one-shot authorization

Caller-set `MAIL_MVP_004_LIVE_PROOF=1` is **not** authorization.

`execute-once` requires the exact typed phrase, the Sunset target pins, the **current 100% Healthy** serving revision + image tag/digest from revision show, a fresh 64-hex nonce, and a 15-minute `--confirm-issued-at` freshness window. The supervisor stamps its own issued-at onto a one-use expiry-bound inner capability; the caller timestamp is not capability identity. After a real 003 `{status:'sent'}` the harness reads selected-operation durable approval `message_text` plus Create Draft author marker/HMAC provenance — missing synthetic return fields must not classify a successful send as leftover.

```text
node scripts/prove-mail-mvp-004-auto-create-send.js preflight \
  --deployment sunset-staging \
  --tenant sunset \
  --database sunset_staging \
  --resource-group luna-sunset-staging-rg \
  --app luna-sunset-staging-staff-api \
  --revision <current-serving-revision> \
  --image-tag <origin/master-40-hex> \
  --digest sha256:<serving-digest>

node scripts/prove-mail-mvp-004-auto-create-send.js execute-once \
  --deployment sunset-staging \
  --tenant sunset \
  --database sunset_staging \
  --resource-group luna-sunset-staging-rg \
  --app luna-sunset-staging-staff-api \
  --revision <current-serving-revision> \
  --image-tag <origin/master-40-hex> \
  --digest sha256:<serving-digest> \
  --confirm I_UNDERSTAND_SUNSET_STAGING_MAIL_MVP_004_ONE_SHOT_AUTO_CREATE_AND_SEND \
  --operator-nonce <64-lowercase-hex> \
  --confirm-issued-at <ISO-8601 now>
```

Equals-form flags, `--target`, `--conversation-id`, production, Wolfhouse, proxies, replayed nonces, and stale windows fail closed. Conversation UUID is selected by subject + authoritative sender + guest link, never by a caller-supplied id.

`preflight` does not mutate flags, channel mode, Graph, or journal. `status=preflight_ok` is not live PASS.

## Bounded execution plan (later operator; not this builder)

After exact-master deploy and typed authorization, the supervisor may temporarily set **only**:

- `LUNA_AUTO_SEND_ENABLED=true`
- `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true`
- email endpoint channel mode `auto`

Then:

1. Independently re-read serving identity. Prove the enabled revision still has the authorized image and both flags literal `true` before dispatch.
2. Invoke the canonical 003 production auto owner **exactly once** via image-owned `scripts/prove-mail-mvp-004-auto-create-send.js` (`MAIL_MVP_004_STAFF_OWNER_PROOF=1`). Empty Create Draft context. Staff API remains the only price/availability/booking authority.
3. Reconcile durable approval/journal/provider state. If exec disconnects or the outcome is unknown, **do not retry**; reconcile only.
4. **Always** restore both flags to `false` and endpoint automation `off` in supervisor `finally`.
5. Verify safe serving revision, kill-switch refusal (`emergency_flags_off`), exact selected-operation journal/provider counts (1/1), Graph arrival on the same thread, and no duplicate.

Do not alter Microsoft/Graph custody, IMAP/SMTP, 005/006/008, booking, broadcast, or any other guest.

## Non-goals

- No production
- No merge/deploy/PR from this slice
- No gateway/Hermes restart, `/sethome`, Salt, Deckhand, Full Sail 4J
- No staff-staging, new mailbox, or other guest
- No rebuild of MAIL-MVP-003
