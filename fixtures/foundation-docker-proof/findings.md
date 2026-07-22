# FOUNDATION Docker fresh-db replacement — compact Lunabox evidence

**Status:** evidence package only (offline verifier).
**Candidate:** `1f89bbfe1c62b150926feabe00ff687001b014ca`
**Gate:** `G_DOCKER_FRESH_DB_REPLACEMENT` — **not reclassified** (FOUNDATION 1B still `absent`).

## Observed (Lunabox disposable Docker)

| Fact | Value |
|------|-------|
| backend | docker Postgres 15 |
| phase | compared |
| forwardCount | 41 |
| appliedCount (both cycles) | 41 |
| schema fingerprint (both) | `f0f54df09712ef93ea267f5bd35c4567b4b81acb37da025242b1ec85ba0e9496` |
| schema_migrations hash (both) | `aa473862a62d3a963934e654f5d21cf0e5c9f50f3f4ef652603c9dc9065de4d8` |
| volumes distinct | true |
| ledger/schema equality | true |
| cleanup | both `cleanup_verified`; `cleanup_ok` true |
| raw evidence sha256 | `3ca4eecbd0fd9d6ff4186a0bd542d69aff36b4d52f279ec2f3cd61febeb9f13c` |

Compact fixture omits full ledger rows; binds proof script, harness, and canonical
manifest/checksums. No live rerun. No certificate architecture. MESSI untouched.

## Verify

```bash
npm run verify:foundation-docker-fresh-db-replacement-evidence
node scripts/prove-foundation-docker-fresh-db-replacement.js --offline
```
