# PASS4 live-admission safety — source candidate, NOT live acceptance

Fresh fetched origin/master base: `891c49a6c62b942d93b31ad1d84e70237098b59c`.
Branch: `fix/pass4-liveadmission-safe-20260930`.
PASS4 `cc37fc2f9a3239c525e041a0c5da8fd53f6c92a4` is an ancestor. The original dirty checkout was left untouched.

## Actual source findings and correction

* Golden runner called guest-fresh-start with hard_delete and swallowed teardown errors; it could cancel business bookings.
* Simulate HTTP owner passed allow_writes=False, but the permanent Crows Nest Staff wrapper independently enabled Sunset or admitted Wolfhouse staging writes. A runner flag alone was insufficient.
* Missing installed internal token did not fail closed at simulator admission.
* Golden string threads were incompatible with the phone-only Crows Nest entry.

Candidate authenticates the route, derives a non-routable golden identity, issues private request-owned provenance at the golden owner, pins exact read paths at the actual permanent Staff wrapper, and uses a no-op business Inbox mirror. The existing permanent external-send interception is retained. Caller allow_writes/trusted booleans cannot grant golden write authority. Ordinary Crows Nest behavior is intentionally unchanged.

Cleanup only rotates the exact derived crowsnest-sim routing entry under its existing lock. It rejects arbitrary phone/WhatsApp/session-key inputs and tainted late-worker sessions; errors propagate to the fixture. It does NOT delete historical SQLite rows, shared USER.md/MEMORY.md, business rows, or ordinary guest sessions. Rotation, not historical erasure, is the cleanup contract.

Mutation fixtures SKIP before any invocation. Exit 0 means complete PASS; exit 3 means incomplete SKIP/XFAIL; XPASS and infrastructure/teardown failures exit 1. A teardown failure cannot be hidden by expect_fail.

NLContractA owners preserved unchanged: accepted_quote.py, original_inbound.py, plugin __init__.py, apply_gateway_patches.py, SOUL.md.

## Executed evidence

* Initial missing-owner API tests exited 1 (missing seams; not a behavioral RED claim).
* Once namespace owner existed, real permanent Staff boundary regression exited 1 with `True is not false`: runtime capability forwarded a mutation. After the boundary repair it passed.
* Registered-handler tests exited 1 before correction (golden dispatch absent; missing token did not return 401).
* Node runner regression exited 1 before correction: `must clean synthetic thread, not guest phone`; after correction it passed.
* Focused final commands are below. No live golden turns were spent.

## Exact blockers / acceptance gates

Local full gateway tests are NOT green: gateway package is absent (13 Crows Nest tests: 5 errors); accepted-quote/original-inbound tests cannot import hermes_state. aiohttp is also absent. Focused route tests execute the registered handler with only the HTTP response DTO mocked; transport tests execute permanent wrappers with external I/O counters, not a resident real GatewayRunner.

Read-only installed-container discovery `docker ps --format '{{.Names}} {{.Image}}'` exited 1: Cannot connect to Docker daemon at unix:///var/run/docker.sock. No daemon startup, lifecycle retry, sudo workaround, gateway restart/stop, deployment, or alternative host access was attempted. Installed send/tool/tenant admission remains UNVERIFIED. Live admission is BLOCKED, not PASS.

Independent exact-freeze review is still REQUIRED. This candidate is not approval to merge, deploy, run live, or touch prod8094/Oracle/WABA/L8/Staff6/8 paired deployment.

## Runnable offline verification

From the extracted candidate root:

```sh
node scripts/verify-golden-admission-safety.js
(cd docker/hermes-staging && python3 -m unittest wolfhouse.test_golden_admission_safety -v)
git diff --check
```

For an authorized external host with an independently pinned existing Hermes image (no build/install/network and no running service mounts):

```sh
# Set IMAGE to the reviewer-approved immutable sha256 digest, not a floating tag.
# Set CANDIDATE to the extracted frozen artifact root.
: "${IMAGE:?approved immutable image digest required}" "${CANDIDATE:?extracted candidate required}"
timeout 120s docker run --rm --network none --read-only \
  --memory 1g --cpus 1 --pids-limit 128 --tmpfs /tmp:rw,size=128m \
  -v "$CANDIDATE:/candidate:ro" -w /candidate/docker/hermes-staging \
  -e PYTHONDONTWRITEBYTECODE=1 -e HERMES_HOME=/tmp/golden-home \
  -e PYTHONPATH=/candidate/docker/hermes-staging:/opt/hermes \
  --entrypoint python3 "$IMAGE" -m unittest \
  wolfhouse.test_golden_admission_safety wolfhouse.test_crowsnest_guest_door \
  wolfhouse.test_accepted_quote wolfhouse.test_original_inbound -v
```

This external command is supplied, NOT executed here. Capture its actual exit; absent dependencies/errors/SKIP are not PASS. Complete reviewed offline evidence and read-only installed provenance/send/tool/tenant inspection must establish SAFE before any separately admitted live case.
