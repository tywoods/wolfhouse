#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
repo=$(cd -- "$here/../../.." && pwd)
(cd "$here" && sha256sum -c SUMS.txt)
for f in "$here"/*.cjs; do node --check "$f"; done
bash -n "$here/run-luna-routing-r4.sh" "$here/replay-r4.sh" "$repo/deploy/luna-routing/install-luna-routing.sh"
node "$repo/scripts/verify-router-corrected-source-r1.js"
node "$repo/scripts/verify-luna-routing-deployment.js"
node "$here/test-installer-cleanup.cjs"
node "$here/test-core.cjs"
node "$here/test-r4.cjs"
printf 'PASS exact R4 offline replay; no host/service/network mutation\n'
