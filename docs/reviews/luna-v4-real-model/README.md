# Luna V4 real-model evidence — active bounded run

This directory contains actual direct Codex Responses captures, not authored example replies. Requested model: `gpt-6.1-sol`; the first six completed responses returned that same model identifier. This is synthetic prompt evaluation, **not staging/runtime/tool/write/transport acceptance**.

## Execution

- Runner: `artifacts/luna-v4-real-model/run.py` in this checkout.
- Background session: `proc_14f95963c04e`, PID `21084`; completion notification enabled.
- Bound: six hours; each HTTP operation has a 150-second timeout. Any HTTP failure, expiry, incomplete response, or malformed replay gate stops/branches rather than fabricating success. No retries or credential refresh.
- Token is read only in memory from the explicitly approved file. Existing credential is used as-is. No authentication material is written into requests or evidence.
- Catalog: `/opt/data/workspace/sandbox-repos/WH-seadog/artifacts/luna-v4-real-model/catalog.json`.
- All 41 cases / 78 variants are scheduled across three packs: source default Sunny, git HEAD Conversationalist, and working-tree 894-character Conversationalist.
- HEAD: `3012a6205043084e0ec117ef07c43598c24512cd`.

`manifest.json` preserves source prompts and packs. Each isolated conversation receives the tenant's unmodified SOUL, the unmodified shared core guide, the selected pack, and clearly labelled synthetic context. The shared prohibition against mentioning AI remains present, including for the candidate that explicitly requires honest AI disclosure. Sunset receives its tenant SOUL plus the shared core; this deliberately preserves the shared conflict, but duplicated/shared Wolf-House identity text is a harness limitation requiring consideration in Sunset review. No policy conflict is silently removed.

## Artifact layout

- `progress.json`: completed captured chat list, updated after each chat.
- `status.json`: final completion or STOPPED status (only created at exit).
- `chats/<NVxx>/<variant>/<pack>/transcript.json`: actual user/assistant conversation, or explicit skipped branch.
- `chats/.../turn-N/request.json`: actual request payload, no authorization headers.
- `chats/.../turn-N/events.json`, `response.json`: actual streamed events, completed response, returned model and usage.
- `chats/.../gate-N/`: model-assisted semantic precondition assessment before subsequent scripted turns.
- `scores/<NVxx>/<variant>/`: actual scoring requests/responses and `assessment.json`.
- `failure.json` under a call directory records any actual failed request.

## Review limitations / no premature approval

Scoring is same-model assistance, not independent human approval. Each scorer sees one variant's three captured chats and the catalog case; it does not see the full source SOUL. Catalog `NOT RUN` metadata reflects preparation-time status and is stale for actual captured transcripts. An initial NV01 score incorrectly describes a sibling variant as NOT RUN because only one variant is presented to that scorer; the actual capture files and progress, not that incidental scoring claim, determine coverage. Parent review must reconcile variant coverage and judge policy compliance against manifest source prompts.

Voice distinction must be evidenced beyond shorter answers: detail-specific response, cadence, warmth, natural stopping, and situational adaptation. Initial NV01 greetings are very similar; they alone do not demonstrate meaningful differentiation. Preserve negative evidence and any pack-strengthening recommendations. Consent dispatch, idempotency, real receipt authenticity, booking writes, finalizers, and delivery remain untested by design.

No repo source edits, commits, pushes, staging writes, settings changes, deployment, gateway operations, production access, or external contact were performed by this runner.
