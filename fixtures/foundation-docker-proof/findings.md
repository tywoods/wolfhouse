# FOUNDATION Docker fresh-db replacement — compact Lunabox evidence

**Status:** evidence package only (offline verifier).
**Candidate:** `6524df68e9f04364fc1f5e58d845c2aa6b344670` (merged master)
**Gate:** `G_DOCKER_FRESH_DB_REPLACEMENT` — **not reclassified** (FOUNDATION 1B still `absent`).

## Observed (Lunabox disposable Docker)

| Fact | Value |
|------|-------|
| backend | docker Postgres 15 |
| phase | compared |
| forwardCount | 43 |
| appliedCount (both cycles) | 43 |
| schema fingerprint (both) | `f0f54df09712ef93ea267f5bd35c4567b4b81acb37da025242b1ec85ba0e9496` |
| schema_migrations hash (both) | `f26b8ecfcca7609628948db8226ca420ad6815984d7135cd3871683ef2acae4b` |
| volumes distinct | true |
| ledger/schema equality | true |
| cleanup | both `cleanup_verified`; `cleanup_ok` true |
| raw evidence sha256 | `7208e815a017b095cca5ce19bc3df8815d6c9fcd888db83997a4a37f4c0b2efa` |

Compact fixture omits full ledger rows; binds proof script, harness, and canonical
manifest/checksums. No live rerun. No certificate architecture. MESSI untouched.

## Verify

```bash
npm run verify:foundation-docker-fresh-db-replacement-evidence
node scripts/prove-foundation-docker-fresh-db-replacement.js --offline
```
