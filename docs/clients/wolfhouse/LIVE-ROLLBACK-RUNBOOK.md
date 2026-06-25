# Wolfhouse — Live Rollback Runbook

Client: `wolfhouse` · Location: `wolfhouse-somo`

> How to safely revert a Wolfhouse live cutover. Goal: restore the prior known-
> good guest path quickly **without destroying data or money state**. Companion
> docs: `LIVE-CUTOVER-RUNBOOK.md`, `LIVE-ENV-INVENTORY.md`,
> `docs/MULTICLIENT-ARCHITECTURE.md`.

---

## 1. Rollback principles

- Roll back by **immutable image tag** — repoint the runtime at the previous
  known-good tag; no rebuild required.
- **No dirty-tree deploys**, even during rollback — only previously built,
  committed tags.
- **Preserve the database.** Rollback is a runtime/routing revert, never a data
  wipe. Schema changes are forward-only; do not run destructive migrations to
  "undo".
- **Never manually mutate payments or bookings** to recover. Money/booking state
  is reconciled through the normal system, not hand-edited.
- Keep the prior healthy revision available until the new one is proven.
- Never roll *forward* through a red verifier gate.

## 2. Restore previous Meta webhook target

> Requires the same approval discipline as the cutover.

- [ ] Point the Wolfhouse Meta `phone_number_id` webhook back to its **previous**
      target (prior staging/legacy webhook URL recorded during cutover).
- [ ] Confirm Meta accepts the verify token and the webhook validates.
- [ ] Record who reverted it and when.

## 3. Scale down / restart the new runtime

- [ ] Repoint `wolfhouse-prod-staff-api` to the prior known-good image tag
      (or scale the new revision to 0 and activate the prior revision).
- [ ] Repoint `wolfhouse-prod-hermes` to its prior known-good tag (or stop it).
- [ ] Set `live_enabled: false` for `wolfhouse` in `config/clients/clients.json`.

## 4. Preserve DB; do not mutate payments/bookings

- [ ] Leave `wolfhouse_prod` Postgres intact — no manual deletes/edits.
- [ ] Do **not** issue refunds, cancel charges, or alter booking rows by hand as
      part of rollback. Flag any in-flight payment for normal reconciliation.

## 5. Collect logs

- [ ] Capture Staff API + Hermes logs covering the failure window.
- [ ] Capture Meta webhook + Stripe webhook delivery logs/errors.
- [ ] Save the failing image tag/SHA and verifier output for the postmortem.

## 6. Notify operator

- [ ] Notify the named on-call operator/approver that rollback executed.
- [ ] State: what failed, what was reverted, current live state
      (`live_enabled=false`), and whether guests are on the prior path.

## 7. Verify old path responds

- [ ] Confirm the restored webhook target receives and handles a test message.
- [ ] Confirm the prior Staff API revision is healthy (`GET /` 200).
- [ ] Confirm no Wolfhouse guest message is black-holed (prior path replies).
- [ ] Record rollback complete + time; schedule postmortem before re-attempt.
