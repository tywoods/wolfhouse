# Room Placement 008 — approved BUILD continuation

Base fdd05ac70d6afaded285b63abfe6ef0c09442517; sole product writer in this worktree. Preserve independently approved metadata wrapper and prior evidence. No Finance, live services/migrations, sends, payments, deployment, commit, push or PR.

## Latest contract (supersedes previous hold)
One new per-room saved `shared | private | private_optional` value on existing Staff room write path. Ordinary rooms default shared. Legacy private/couple/operator categories remain protected and display Private without rewriting room_type/gender. Shared keeps existing gender/priority behavior. Private is exclusive to one booking group; gender irrelevant, greyed UI, no stranger splitting. Private optional is shared normally; explicit private request only with every bed empty across every requested night, then whole-room dated lock. Existing protections outrank this setting; unresolved conflicts fail closed and are named in SEAL.

## Inventory
Read AGENTS, guest behavior spec, Room Placement UI and Inbox spec. Existing owners: staff-room-fill browser; staff-room-fill-routes/inventory/policy for role/tenant/origin/JSON/CAS and authoritative room readback; luna-bed-allocator for automatic and ordered person-bound selections; main-availability-pg-sql and Staff API SQL bed catalogue/block readers; existing private_room_block booking_beds and assignment transactions. Parent independently audits consumers in integration-audit.md. No alternate backend or allocator.

## Vertical TDD / proof sequence
1. Existing room route accepts sellingMode under catalogue CAS, commits/reopens disk PGlite; fail test first, minimally extend existing persistence + migration + projection. Legacy types remain read-only; room_type/gender preserved for selling-only edits.
2. Native ordinary emitted Staff page dropdown/save/reopen against real route/PGlite; fail first then same room editor/save path extension; grey gender while private, retain priority and metadata.
3. Canonical availability/explicit selection and booking assignment enforce private exclusivity and optional explicit intent, all-night all-bed occupancy and existing locks; one behavior RED/GREEN at a time. Use parent audit to trace all canonical consumers. Preserve person-bound selections, never silently replace accepted beds.
4. Run preserved SQL/browser/allocator/send-safety gates; bind reports, command exits, source patch and changed-file hashes. Synthetic local proof only; no claim of deployment, live PostgreSQL contention or final independent acceptance.

Evidence: /opt/data/workspace/sandbox-repos/WH-captain/artifacts/room-placement-008/selling-mode. Prior metadata evidence immutable. SEAL will report exact completed proofs and unresolved limits, not a setting-only completion.
