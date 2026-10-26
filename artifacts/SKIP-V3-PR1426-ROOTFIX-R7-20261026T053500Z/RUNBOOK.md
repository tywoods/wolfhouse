# R7 owner-receipt replay

From `/opt/data/workspace/sandbox-repos/WH-pr1426-r5`, with the disposable PostgreSQL 17 server listening only on `127.0.0.1:55427` as the local `hermes` role:

```sh
node scripts/run-luna-v3-r7-real-owner.js
python3 -B scripts/run-luna-v3-r6-offline-gates.py
WOLFHOUSE_DATABASE_URL='postgresql://hermes@127.0.0.1:55427/luna_v3_r7_disposable_test' \
  node scripts/lib/model-led-luna/test-v3-postgres.js
sha256sum -c artifacts/SKIP-V3-PR1426-ROOTFIX-R7-20261026T053500Z/SHA256SUMS
```

The owner runner drops and recreates only `luna_v3_r7_disposable_test`, applies the repository-tested current Luna v3 lineage, starts Staff API as a localhost-only plain Node process, and executes authenticated prepare/quote HTTP requests. It covers successful accommodation, package, rental, two distinct lessons, mixed and differentiated multi-guest requests, plus a Staff refusal and corrected successor. It records each exact request, status, complete response body, parsed body, and SHA-256 pair.

Migrations 116 and 118 are intentionally absent from this fresh-current lineage: consolidated migration 114 v2 owns their final invariants, and the repository PostgreSQL suite asserts that replaying 116 after consolidated 114 must refuse.

The runner uses no model credential or external host. External sends and Staff alerts are false. Stop the disposable PostgreSQL process and remove its data directory after review if no further replay is needed.
