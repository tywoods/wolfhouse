# R6 offline runbook

From `/opt/data/workspace/sandbox-repos/WH-pr1426-r5` run:

```sh
python3 -B scripts/run-luna-v3-r6-offline-gates.py
sha256sum -c artifacts/SKIP-V3-PR1426-ROOTFIX-R6-20261026T051433Z/SHA256SUMS
```

The runner:
1. deletes and recreates only its generated `base-e0e9c38-source` subtree;
2. copies the exact matrix, normalizer CLI, contract and schema bytes from base using `git show`;
3. runs the R6 suite against that isolated source and requires a red result with 28 assertion failures and zero errors;
4. runs the same suite against the candidate and all eight existing offline non-regression gates;
5. writes logs, structured exits, and a SHA-256 manifest.

The runner must exit nonzero if base is not red, if base replay errors, or if any candidate gate fails. This is not the missing Dev-01 real-owner or live-model procedure.
