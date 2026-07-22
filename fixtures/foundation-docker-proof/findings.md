# FOUNDATION Docker fresh-db replacement — compact Lunabox evidence

**Status:** evidence package only (offline verifier).
**Candidate:** `4621353f16fc00783ae87b9391ca2c6578decd44` (merged master)
**Gate:** `G_DOCKER_FRESH_DB_REPLACEMENT` — **not reclassified** (FOUNDATION 1B still `absent`).

## Observed (Lunabox disposable Docker)

| Fact | Value |
|------|-------|
| backend | docker Postgres 15 |
| phase | compared |
| forwardCount | 44 |
| appliedCount (both cycles) | 44 |
| schema fingerprint (both) | `f0f54df09712ef93ea267f5bd35c4567b4b81acb37da025242b1ec85ba0e9496` |
| schema_migrations hash (both) | `8df9c24f07a29891bb4cd2d67796b1d163f7c1b3576b090a00c3d0145347f02e` |
| volumes distinct | true |
| ledger/schema equality | true |
| cleanup | both `cleanup_verified`; `cleanup_ok` true |
| raw evidence sha256 | `df988d93655ae0f31358f377bcbc349c4eacfa0689251945ac6d690a0a216df9` |

Compact fixture omits full ledger rows; binds proof script, harness, and canonical
manifest/checksums. No live rerun. No certificate architecture. MESSI untouched.

## Verify

```bash
npm run verify:foundation-docker-fresh-db-replacement-evidence
node scripts/prove-foundation-docker-fresh-db-replacement.js --offline
```
