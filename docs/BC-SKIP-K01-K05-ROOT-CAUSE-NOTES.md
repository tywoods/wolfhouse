# Banana Clean Skip prep — BC-K01 and BC-K05

Base: `1dc339b79555b5a06f11b83a27ebdec9c09f7ceb`. Prep is tests/fixtures/notes only. Production owners remain untouched until P1 heads are final.

## BC-K01 / C09 — lossless supported question context

**Root boundary:** `docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py::_pending_question_model_context` is the plugin adapter between the authoritative pending-question ledger and Hermes model context. Supported `names` descriptors must be deep-copied and serialized intact. No alias allowlist/filter may strip `supported_names[*].aliases` during read, context merge, JSON serialization, or reopen.

**Required behavior:**

- A supported names descriptor round-trips unchanged through both `pending_booking_question` and the serialized `context` payload.
- Repeated names, punctuation, Unicode, ordering, and aliases are data, not keys to normalize away.
- A question-context read failure returns only a sanitized `question_authority_read_failed` diagnostic with `reconciliation_needed=true`.
- That diagnostic is model context only. It must never become a booking-save refusal, retry, fallback, handoff, or fabricated question.

**P1 control:** compare final P1 against the current #1702 positive control `QuestionAuthorityFailureTests.test_names_question_is_carried_without_losing_authority`. If final P1 already satisfies the stronger alias round-trip test, K01 is control-only; do not reopen fixed production code.

## BC-K05 / C17 — one accepted commercial identity before persistence

**Observed split:** in `luna-front-desk-accommodation-booking-create-service.js`, transport-derived `storagePackageCode` feeds the booking scalar while `effectivePackageCode` and `pkgCtx.isNoPackage` feed current metadata. Those values can describe different commercial products in one saved booking. Lookout's observed Malibu case already writes the guest row correctly while the booking scalar is null and current metadata says `package_none` / accommodation-only.

**Root fix shape after P1/K04/L02 prerequisites:** resolve one immutable accepted commercial identity before any SQL or metadata construction. The identity owns package code, accommodation-only status, room type/preference, and guest package projection. Every booking scalar, current metadata field, and guest row must be derived from that identity. Do not add a guest-only repair.

**C17 controls:**

1. Explicit accepted Malibu plus stale request-body `package_none` persists Malibu consistently in booking scalar, current metadata, and guest projection.
2. Explicit accepted `package_none` plus shared-room selection remains plain/shared even if an older offer/body says Malibu/private at equal amounts.
3. Both controls still execute the save; identity reconciliation must never block or limit booking persistence.
4. Keep the Camila note and Needs human behavior for genuine post-save review conditions; do not create a fallback, retry, handoff, or prompt-copy workaround.

## Landing sequence

After final P1 heads: rebase/stack from the finalized P1 result, run K01 first, then K04, then K05. Keep each production change in a small PR with focused RED→GREEN evidence. This prep PR intentionally remains RED on master and contains no production edits.
