# PASS4 independent BLOCK repairs — source only, NOT accepted/tested

Scope: Hermes staging/8090. Sole writer worktree `WH-pass4-issues-001`. Staff issues 6/8, live guest simulation, business writes, sends, deployment, merge, prod/8094/Oracle/WABA/L8 excluded.

Read first: `/opt/data/pass4-evidence/independent-review-BLOCK-004.md`. Also inspected the original PASS4 packet, current candidate source, `/opt/hermes/gateway/session_context.py`, `gateway/run.py` and `hermes_state.py`. No installed Hermes source was modified.

## Changes in this repair round

- `wolfhouse/accepted_quote.py`: shared mutable turn capability with a revocation lock; `close_turn()` revokes copied contexts, not only the parent ContextVar. Every ledger operation checks closed capability, real identity, active incarnation and current ledger epoch.
- Pending commercial revisions preserve all omitted existing fields. Only complete named Yoga/Drone removal authorizes a specific selection/add-on delta; unrelated date/package/count changes fail. Contact additions cannot authorize commercial replacement. Unsupported commercial changes remain unresolved across neutral turns and cannot quote/create. This is deliberately a narrow grammar, not arbitrary natural-language change support.
- Refusal/deferral (`No thanks`, `Not yet`, `Wait`, related explicit cancellation phrases) removes accepted authority.
- Preview preparation returns an internal capability/epoch ticket. Publication compares the initiating epoch; newer intent or offer prevents a late response overwriting the ledger.
- Create preparation returns an internal ticket passed task-locally to the real `/booking-create-from-plan` call in the plugin. Actual transport rechecks capability, epoch, acceptance and session incarnation while holding the SessionDB SQLite writer transaction. Post-create payment/name/transfer work remains outside that transaction. SQLite writer retries cannot repeat an already-invoked transport callback.
- Retained original tests are unchanged in assertions. Added hostile tests cover contact omissions, constrained removal, refusal zero transport, independent-context late quote CAS, prepare/reset and prepare/revision barriers, actual plugin transport-boundary reset, dispatch-first ordering with a second SessionDB connection, copied-context and async late-child revocation, and actual gateway observed-context composition + real AIAgent ingress rejection.

## Historical trusted-ingress blocker (superseded by current source)

The paragraphs below describe the earlier repair state, NOT the current implemented
source. Current source adds `original_inbound.py`, actual gateway event/run-owner
patches and pre-enrichment session binding, plus the authenticated API synthetic
principal worker path. The installed loop consumes that one-use original-text
capability only; model input/history/persist kwargs cannot supply consent. Revocation
covers copied contexts and cancellation of an active executor. The disposable
real-gateway harness and API worker tests retain positive ingress assertions.
Prior writer reported owner37 GREEN and initial ingress6 GREEN. Three later ingress
additions and the completed explicit `persist_user_message` negative assertion are
not yet verified against the final source. Final frozen owner/ingress gates: UNKNOWN.
Independent exact-frozen-source review remains required.

### Earlier blocker diagnosis (historical)

`gateway/run.py:8572` starts from `event.text`. By 8588–8595 it may include sender/channel history, 8779–8793 adds quoted replies, and 9592–9597 adds timestamps. The API worker at 16166–16180 also wraps observed context and multimodal text. `gateway/session_context.py` binds identity but no independent original inbound text. `persist_user_message` is not raw-consent authority either.

The former hook treating `run_conversation(user_message)` as raw consent has been removed. The installed hook now clears/revokes capabilities and runs ordinary conversation WITHOUT invoking the consent observer. Consequently real ingress quote persistence/create FAIL CLOSED until gateway-owner integration is provided. This is not a working positive booking path and MUST NOT be represented as all five repairs completed or frozen approval.

Required owner integration: capture the original triggering event text before any enrichment, bind it separately with matching tenant/session/incarnation/message identity in the actual gateway worker context, propagate through executor/copy-context boundaries, clear/revoke in finally, and explicitly handle absent text/multimodal/API ingress without transcript recovery, model kwargs, ambient env, or fabricated trust. Then call the observer from the installed hook using that binding only. This needs approved gateway-source/patch ownership beyond this candidate's currently implemented consent seam; no unsupported `/opt/hermes` edits were made.

The retained positive installed-loop tests expecting enriched `user_message` to confer consent now have an unresolved ingress dependency; do NOT change their assertions to accept failure. Direct fixture calls to the observer do not establish runtime ingress authority. Some existing direct `record_quote` fixtures also inject a different/additional commercial plan after an earlier offer; strict revalidation may expose those dependencies. Do not bypass the boundary or weaken those tests to turn this candidate green.

## Ordering contract and limitations

Reset/revision committed before the dispatch writer transaction means zero create transport. Dispatch acquiring the SQLite writer lock first means transport starts before reset/revision can commit. Reset cannot retroactively cancel an already-started external call. Holding a writer transaction across transport has contention/latency implications that require fresh offline barrier testing and independent review. The guarantee assumes session termination and ledger mutation continue to use the inspected SessionDB transactional writer API; no claim is made for out-of-band file replacement or nontransactional reset implementations.

## Final gate status: UNKNOWN pending fresh frozen host-origin execution

Chief externally confirmed `candidate-owner-008.log`: GREEN23, exit 0. That clears
verification of snapshot008 only; it does not certify later source or independent
review repairs. The denied008 command is not retried. No guard bypass, gateway
stop/start/restart, merge, deployment, business write/send or tested commit is
permitted by this closeout.

A NEW immutable source archive, per-file SHA256 manifest, source diff and executable
external host-shell runner are prepared under `/opt/data/pass4-evidence`. The runner
pins `sha256:cb7f496ddae204b3d7fa009b420deda5353082814109d39c6d8e2d94e3b6f688`,
uses fresh network-none Docker processes, read-only frozen source and retained
`/tmp/pass4-offline-hermes-001` / dependency mounts, and runs ONLY owner and original
ingress suites. It records full logs and individual exits. If the new authorized SSH
invocation is denied, stop immediately and give Chief the exact runner command.

Remaining: final frozen owner/ingress gate results, separate existing regression
acceptance as required by the parent, and a fresh independent review of the exact
frozen source. Preserve prior evidence unchanged. No merge/deploy or live simulation.
