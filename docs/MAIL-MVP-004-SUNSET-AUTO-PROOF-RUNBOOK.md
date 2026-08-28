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
6. Independent preflight then shows current selected-operation approval/journal/provider counts at **zero/new**, flags currently false, and channel automation not already `auto`. Booking side-effect snapshot counts only bookings linked to the exact conversation's guest in the same client (`conversations` client/id join `bookings` client/guest_id). Sunset has no `bookings.conversation_id`. Missing conversation/guest or an ambiguous relation fails closed without exposing rows.

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

`execute-once` requires the exact typed phrase, the Sunset target pins, the **current 100% Healthy** serving revision + image tag/digest from revision show, a fresh 64-hex nonce, and a 15-minute `--confirm-issued-at` freshness window evaluated **once at execute-once start** (target and scope unchanged). Traffic is parsed from actual ACA ingress: exactly one explicit weight-100 revision equal to `latestReady`/`latest`, then revision-show Healthy, Provisioned/Succeeded, and a documented serving running state (`Running`, or `RunningAtMaxScale` only with at least one running replica). Replica process env is attested with `printenv` or `/proc/1/environ` (never template env). Flag updates create a new ACA revision that can take more than 3 minutes (observed ~6 minutes even when health endpoints already 200) to become `latestReady`/100%. Graph preflight already uses one ACA `exec` at t0; the first process-env `printenv` after the successor is ready can therefore receive WebSocket HTTP 429 Retry-After=600. The supervisor waits up to **20 minutes per successor** (2s poll) with the same-image/digest/100%/replica-process flag gates; identity may poll at that interval, but ACA `exec` `printenv` attestation is at most once per 10 minutes (trusted 429 Retry-After=600 is parsed and capped at 10 minutes, then a 30s safety slack is applied so the retry wait is 630s and is never the exact 600s boundary). Observed ~6 minutes + 630s is ~16.5 minutes, which exceeds a 15-minute stage and fits in 20 minutes with initial + one cooldown retry; never reuse attestation across revision/replica or desired enabled state; exact replica-process proof returns immediately; timeout fail-closes (`enabled_revision_unproven`) without invoking the owner. Original authorization remains valid across that wait: the supervisor stamps its own issued-at onto a one-use expiry-bound inner capability **after** the enabled successor is attested, so the caller timestamp is not capability identity and the 15-minute operator window is not widened. After a real 003 `{status:'sent'}` the harness reads selected-operation durable approval `message_text` plus Create Draft author evidence HMAC-bound to draft body hash + request/source operation + tenant/location/conversation — conversation metadata booleans are not proof. Missing synthetic return fields must not classify a successful send as leftover.

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

Default Graph arrival proof, Sol HMAC recomputation, and kill-switch probes run **inside the Staff replica** via image-owned `execInner`. The host authorized CLI must not supply mailbox tokens, `getAccessToken`, or the Staff HMAC secret. Unavailable replica Graph/custody or evidence-snapshot capability fails closed **before** flags are enabled. Replica exec JSON that is missing, malformed, or nonzero fails closed; host-env 003/HMAC/Graph fallbacks are not proof. ACA `exec --command` is one string: Azure logs it as a JSON array, and the cluster whitespace-splits or wraps `sh -c '<command>'`. Nested `sh -c 'printf %s …'` becomes argv `sh -c 'printf` with `$0=%s` and dies (`%s: line 0: syntax error: unterminated quoted string`). The legal command is quote-free `/usr/bin/env KEY=value … node scripts/prove-mail-mvp-004-auto-create-send.js` with controlled assignments. Host `/usr/bin/script` status 0 is not success when output contains `ClusterExecFailure` or a remote nonzero.

After exact-master deploy and typed authorization, the supervisor may temporarily set **only**:

- `LUNA_AUTO_SEND_ENABLED=true`
- `LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true`
- email endpoint channel mode `auto`

Then:

1. Independently re-read serving identity from explicit 100% traffic + revision-show health. Kill-switch probe the attested-false replica first (`emergency_flags_off`, zero author/journal/provider). Flag updates create a new ACA revision; do not pin the original revision name. Accept only a successor (or same-image) revision with the authorized image tag+digest, 100% Healthy traffic, and both approved flags literal `true` from replica-process `printenv` (never template env, never nested `sh -c`). Wait up to 20 minutes per revision (2s poll; ACA exec attestation at most once per 10 minutes, including after a trusted 429 Retry-After=600 plus 30s slack / 630s wait; never retry at the exact 600s boundary) for that proof; a 15-minute bound times out around the observed 6-minute successor plus 429 cooldown. A 3-minute bound times out before a legitimate successor can be attested. No other flag changes. Invoke the owner only after that proof.
2. Invoke the canonical 003 production auto owner **exactly once** via image-owned `scripts/prove-mail-mvp-004-auto-create-send.js` (`MAIL_MVP_004_STAFF_OWNER_PROOF=1`). The dispatch marker is emitted from inner only after 003 handle starts. Empty Create Draft context. Staff API remains the only price/availability/booking authority.
3. Reconcile durable approval/journal/provider state. Classified inner JSON is preserved even if exec status is nonzero. If exec disconnects after the issued marker with no classified JSON, **do not retry**; reconcile only.
4. **Always** restore both flags to `false` and endpoint automation `off` in supervisor `finally`. Restore must similarly accept only a same-image successor with 100% Healthy traffic, replica-process flags literal `false`, and final channel mode `off`. Restore uses the same 20-minute per-successor wait and 630s trusted-429 slack as enable.
5. Verify safe serving revision, kill-switch refusal (`emergency_flags_off`) on the attested-false replica, exact selected-operation journal/provider counts (1/1), Graph arrival on the same thread (`$select` without body/bodyPreview), and no duplicate. `--database sunset_staging` is enforced against `current_database()`, not a string pin.

Do not alter Microsoft/Graph custody, IMAP/SMTP, 005/006/008, booking, broadcast, or any other guest.

## Non-goals

- No production
- No merge/deploy/PR from this slice
- No gateway/Hermes restart, `/sethome`, Salt, Deckhand, Full Sail 4J
- No staff-staging, new mailbox, or other guest
- No rebuild of MAIL-MVP-003
