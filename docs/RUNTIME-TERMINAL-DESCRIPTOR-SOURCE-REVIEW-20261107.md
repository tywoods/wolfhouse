# Resident terminal descriptor grammar — source review only

## Authority and purpose

Ty's authorization relayed by Chief on 2026-11-07: “Captain may prepare and test the source fix, preserving all restart protection. I will approve any installation separately.” Captain is the sole implementation owner. Independent reviewers are read-only. Ty is the installation decision owner; that does not attest historical build provenance.

Practical use: an ordinary diagnostic command may combine its error output with normal output using literal `2>&1`. The resident classifier rejects that syntax before it establishes a lifecycle action, then reports the wrong reason. This candidate fixes the parser's bounded syntax support, not a command-specific exemption or caller rewrite. It is a runtime-maintenance candidate, not arrival wording.

**Arrival wording on France Wolfhouse staging remains the actual deliverable. There is no demonstrated dependency on this runtime repair.** Per Chief, the private-booking proof has already passed, and Skip's existing France SSH alias and owned sandbox are verified working. Skip's read-only ARRIVAL-RELEASE-PACKET continues independently. Do not repeat that proof or demand a runtime installation to assemble the packet. S1b remains sealed/held; S2/S4 held. This work grants no merge, release or deployment authority to any of those tracks.

## Pinned source and provenance

- Source of truth: `tywoods/wolfhouse`, not the obsolete repository name appearing in the incident string.
- Diagnostic-only parent: PR #1579, commit `910d3741d4379d46c9e7433179a24184c2189cf0`; GitHub readback showed open, not merged. Its original 12 tests pass. They never constituted a functional unblock.
- Recovered resident fixture: `fixtures/hermes-resident-terminal-tool/terminal_tool.py`, 129880 bytes, SHA256 `01fde249886999f2ed7de936ac610221214572abf8d0baaff008670d59be7dc1`. The fixture is unchanged. It matches Chief's recovered attachment.
- Pinned upstream terminal source at `NousResearch/hermes-agent@64131bf975d084b51270fbfce51bfd3d14e8377b`: fetched HTTP 200, SHA256 `7fa41f3968e6967c1c811f31d1c5179c0ea0b9f1d426156817826cea09f17fb2`. It does not contain the custom lifecycle classifier. This is not an established upstream defect.
- The handoff reports image `hermes-orchestrator-migrated:20261010`, image ID `sha256:f149aadabcc913a382acb760c61108e0cc06c169fe3634c5bcc8e3fc1bba9c5a`, and guard label `simulate-guest-guard-frozen-002` / commit label `64d597141325785e586b70a444d16d309a899db7`. Those are reported image metadata, not locally verified build lineage.
- The GitHub commit endpoint for that guard-label SHA in **tywoods/wolfhouse** returned HTTP 422, “No commit found for SHA”. No build recipe for this image was located in the candidate checkout; the label appears only in the supplied fixture provenance. This does not prove the commit never existed elsewhere. **Historical source-to-image provenance remains unresolved, not invented.**
- `artifacts/terminal-descriptor-20261107/provenance-checks.json` in Captain's parent clone contains dated public-source receipts. No runtime inspection or image build was performed during source preparation.

## Exact supported grammar and unchanged controls

Candidate owner files retain their PR #1579 names to make review against that diagnostic work direct:

1. `docker/hermes-staging/terminal_gateway_lifecycle_diagnostic.py`
2. `docker/hermes-staging/apply_terminal_lifecycle_diagnostic_patch.py`
3. `docker/hermes-staging/test_terminal_lifecycle_diagnostic.py`
4. `docker/hermes-staging/test_terminal_descriptor_grammar.py`
5. `docker/hermes-staging/test_terminal_patch_bytes.py`

The only intended new acceptance is **adjacent literal output duplication `[12]>&[12]`**, followed by end-of-input, ASCII space/tab/newline or a recognized shell operator. No stdin duplication, arbitrary descriptors, implicit descriptors, descriptor close/move, quoted/expanded destinations, digit suffixes or escaped continuations. Redirections are parsed in place; executable words, command-chain members and nested shell bodies are still classified. No `gh`, repository or executable allowlist was added. No `2>&1` stripping or rewriting occurs.

Malformed simple lists now fail closed: missing operands, repeated operators, grouping and non-shell whitespace are rejected. This intentionally tightens some old permissive allows; it is not strict allow-bit parity with the old classifier. Existing named normal-operation fixtures continue to pass. Combined output-to-file redirection (`&>`/`&>>`) remains a redirection within a command, not a spurious command separator. To avoid opening old denials unrelated to the descriptor fix, argv words after a combined output-to-file redirect are unsupported; terminal redirections and subsequent simple-list commands remain supported. A new harmless-tail test was observed RED, then GREEN after this conservative parser correction.

Lifecycle matching, known-wrapper policy and recursion/length bounds are retained. The source-generation marker is `wolfhouse_terminal_descriptor_grammar_v2`. The patcher pins the recovered SHA; a marker alone cannot authenticate a modified candidate. It compares the complete generated source to the exact rendering of the pinned fixture. The patcher refuses live paths/evidence fixture; the output artifact is inert text only.

Source-splice tests reverse both replacements and the added `shlex` import, proving every other recovered-source byte is unchanged. This includes the simulation/send guard, normal approval checks, backend code and resident token helper. Source preservation does not prove a future replacement image preserves all other image files/configuration.

The generated classifier's `_KINDS` dependency was absent from the diagnostic patcher's output; an observed failing test exposed that `NameError`. The candidate now emits the constant. This is why testing the module alone was insufficient.

## Offline acceptance evidence

Run from `docker/hermes-staging`:

```text
python3 -B -m unittest test_terminal_lifecycle_diagnostic test_terminal_descriptor_grammar test_terminal_patch_bytes -v
```

At revised source preparation: 31 tests pass. The earlier evidence runner reconstructed the diagnostic base from GitHub-pinned Git objects; those historical receipts remain credited, not rerun or mistaken for new acceptance:

- Original diagnostic suite: 12 pass (baseline credited).
- New descriptor suite against that base: nonzero/RED, as expected.
- Revised candidate suites together: 31 pass/GREEN, including five byte-authentication tests.
- Newline-changed target regression: observed 24 subcase failures before the fix (original/candidate, CRLF/CR, one/all newlines, patch/CLI-check/CLI-write); now all reject without modifying the target.
- Newline-changed temporary reference fixture: observed four failures before the fixture-read fix; now rejected by raw SHA256.
- Extra-source/marker/approval-block tampering, invalid UTF-8, exact byte output and idempotent no-write behavior are covered.
- `git diff --check`: exit 0.
- Descriptor/security corpus run again against extracted generated-source guard definitions: 10 pass (same corpus, not additional unique tests).

Coverage includes literal descriptor positions, exact original input, malformed/dynamic descriptors, quoted data, chains, nested shells, known lifecycle commands and wrappers, depth/length bounds, unknown wrapper modes, 2000 deterministic generated non-descriptor inputs and the retained baseline randomized corpus. These are classification/security regression corpora, not a proof of all shell semantics or a general-purpose sandbox.

The exact recorded incident string is retained unchanged, including its obsolete repository name, as **test data only**. It is never sent to any shell, real terminal backend or GitHub CLI. Pure guard functions are extracted by AST; the resident module is never imported or executed. The real hard-guard and normal-approval source blocks are exercised with an inert mocked executor: both force settings deny lifecycle/unknown syntax before approval/backend calls; ordinary approval denial is still honored on an allowed synthetic input. This is a scoped guard-region integration test, not a full gateway end-to-end run.

Static added-code scan: no credential literals, shell=True/os.system or pickle found. Two test-only `exec` calls load trusted extracted source/guard blocks; they do not execute input strings. Independent read-only review verdicts and exact file hashes are delivered with the evidence packet, not inferred from test success.

## Newline byte-authentication revision

Chief explicitly commissioned this correction within Ty's source-preparation approval after receiving the original archive (`ef951f0925b5668d8bac9abc2fe0341c26d97606e373d2af3a499ff67a7f739f`). That archive remains unchanged. New evidence is in `artifacts/terminal-descriptor-byteauth-20261107/` in Captain's parent clone.

Root cause: `Path.read_text()` normalized CRLF/CR before SHA256/comparison, and text writes could translate newlines. All patcher file entrypoints now read raw bytes. Unpatched input and reference fixture bytes are SHA256-authenticated before UTF-8 decoding. Marker-bearing candidates must match the complete regenerated UTF-8 byte sequence before structural parsing; a marker is not authentication. `patch_file` writes bytes; `--check` uses the same byte validation and never writes. The compatibility text API cannot recover bytes already discarded by an external caller; use `patch_bytes` or the file/CLI APIs for file authentication.

This revision changes only the patcher, adds byte-authentication tests and updates this document. The classifier and existing two test modules are unchanged from the received candidate. Generated runtime source is byte-identical: SHA256 `27eda3646d8e7c2a3198db270ce227c9caed0fd9a63590c29b1e487c0d675057`. Known inherited opaque-program, PID-resolution and argument-globbing limits are not presented as solved; this is not a shell sandbox.

## Installation hold and exact owner steps

**Nothing was installed or deployed. No gateway restart, live edit, replacement-image build, production change or guest send. Captain did not retry/repackage denied commands.** An earlier reviewer reported constructing probes after tool refusals; those probes are excluded from acceptance evidence. This revision uses only the approved existing offline suite plus the new byte-authentication tests. Fresh reviewers may inspect source and run that named suite, not reconstruct or retry probes.

1. **Chief:** review the source/evidence packet while Skip independently finishes ARRIVAL-RELEASE-PACKET. Do not make runtime repair a release prerequisite without an actual demonstrated dependency.
2. **Ty, installation decision owner:** before considering a runtime installation, supply the archived Dockerfile/build invocation or CI build record and retained downstream patch/source for the reported image/guard label. If the original recipe is unavailable, explicitly record unknown historical lineage and commission an inspectable, digest-pinned preservation inventory/reconstruction; do not describe it as verified historical provenance. This is a precise evidence requirement, not another generic ownership question.
3. **Captain:** reconcile that provenance/preservation evidence into the later candidate-image and rollback packet when specifically commissioned. Current authorization is source preparation/testing only; no image was built here.
4. **Ty:** installation remains a separate decision on an exact reviewed source/image identity, preserved downstream protections/config/state, downtime, backups, and rollback image. Source acceptance cannot substitute for that decision.

Official Docker documentation was fetched successfully: `/opt/hermes` is immutable application code; core changes go through reviewed source and image replacement, not live edits or `hermes update`. Its general upstream-latest example is **not** a safe recipe for replacing this custom downstream image.

Links:
- https://github.com/tywoods/wolfhouse/pull/1579
- https://hermes-agent.nousresearch.com/docs/user-guide/docker#immutable-install-tree
- https://hermes-agent.nousresearch.com/docs/user-guide/docker#upgrading
