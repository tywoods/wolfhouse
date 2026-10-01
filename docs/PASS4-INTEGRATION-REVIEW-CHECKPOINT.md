# PASS4 integration review checkpoint

Scope: GUEST-SIM-PASS4-ISSUES-001 approved eight-issue release, hermes-luna port 8090 only. No Staff6/8 attribution, Staff deployment, guest simulation, outbound business send, or protected gateway/orchestrator lifecycle.

## Provenance

Current fetched master base: 3af03671945bccc4aab4d9c201f9eedb433a7343.
Original halted candidate HEAD: 29b4a20e0078eceae91b3efb966e1e4e65d19820 plus approved dirty runtime repairs.
Separate integration branch: release/pass4-integrate-3af03671-20261001.
Original candidate remains untouched. Candidate commit cherry-picked cleanly; approved three-file runtime/test dirty delta passed git apply --check and applied. Six regression suites and external/installed runner tooling copied separately. Unmanaged diagnostic suites/runners excluded: no concrete installed arbitrary-propagation producer requirement established. This is NEW integration, not the c34ec406 freeze or prior immutable source acceptance.

## Actual verification

From clean base worktree, node scripts/assert-repo-sync.js EXIT0 using actual SSH; node scripts/assert-deploy-from-master.js EXIT0. Sync reports old dirty VM checkout e6b44e7ae146 as benign ahead-of-VM, not VM source synchronization. Earlier absolute-script call from default checkout ran preflight against that dirty default root and failed; rerun from actual integration cwd passed without bypass or source reset.

Integrated bytes: PYTHONPATH=docker/hermes-staging/plugins:docker/hermes-staging /opt/hermes/.venv/bin/python -m unittest wolfhouse.test_golden_admission_safety wolfhouse.test_golden_real_storage wolfhouse.test_newir_repairs wolfhouse.test_owned_worker_lifetime wolfhouse.test_pass4_ingress_matrix wolfhouse.test_registered_golden_transport: EXIT0, 27 tests OK. node scripts/verify-golden-admission-safety.js EXIT0, PASS golden runner safety (offline). git diff --check EXIT0.

Parent externally verified installed composition: /var/tmp/pass4-installed-composition-permfix.ldInok/results/results.json EXIT0, complete true, exact five inventory/executed, cleanup true; immutable_source_verified=false/liveauthorized=false. Retained twelve runtime checks and tooling four PASS apply to previous candidate, not automatically this integration. No repeat of those original already-green gates.

## Read-only live facts

Actual hermes-luna Compose labels confirm /home/azureuser/WH-release-land6da1aa/docker/hermes-staging/docker-compose.land001.yml, project hermes-staging, service hermes-luna, port8090 ->8090. Resident image whstagingacr.azurecr.io/wh-hermes-staging@sha256:cb7f496ddae204b3d7fa009b420deda5353082814109d39c6d8e2d94e3b6f688 remains expected old runtime. No recreation performed.
Effective environment: WOLFHOUSE_STAFF_API_BASE_URL=https://staff-staging.lunafrontdesk.com; HERMES_ROLE=luna; WHATSAPP_DRY_RUN=false; LUNA_AUTO_SEND_ENABLED=true. These open live controls were observed, not changed; offline tests sent no messages and do not prove global dry-run.

## Concrete remaining gates

1. Independent review naming exact integration commit/base and diff, before merge/build. Parent must dispatch reviewer; no independent-review tool is available in this subagent.
2. Retained Staff route serving-source/auth/read-only equivalence. Current master staff-query-api.js routes booking-preview:54513 and availability-check:54957 requireBotAuth then dispatchBotRouteBoundToPrincipalTenant. Availability handler:10215 passes assignmentMode:false to read service. Quote overlay:10004 reads loadRules/loadItems without schema initialization. Requirement is serving staging owner equivalence for these TWO routes and auth/tenant binding, not seven-route audit or a Staff deployment. Current live Luna base URL above identifies endpoint; serving Staff image/source/auth equivalence not yet established. Installed five-case HTTP gate proves rejection only, not authorized full model dispatch.
3. After accepted exact integration: GitHub PR merge with matched head, clean full landed master SHA worktree, actual sync/preflight and applicable bounded mandatory gates; conventional full Docker build only, registry digest readback; fresh preactivation refs/preflight.
4. Scoped Compose hermes-luna up -d --no-deps --force-recreate ONLY after review/merge/build gates. Capture before/after siblings, effective runtime hashes, health and flags. No gateway/orchestrator stop/restart, no8094/Oracle/WABA/L8.
5. AFTER land only, parent prepares exact five-case CaptainCheese+Batch5 draft packet; no simulations by release worker.

Preserved identities: PASS1 MB-WOLFHO-20261014-c79264; PASS3 MB-WOLFHO-20261021-98e488; PASS4 MB-WOLFHO-20261026-ce43e2; PASS5 MB-WOLFHO-20261016-509d73.
