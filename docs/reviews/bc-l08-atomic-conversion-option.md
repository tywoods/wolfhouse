# BC-L08-PREP — atomic conditional conversion option

**Decision packet only; do not merge.** Base:
`bd48250a3ce111a744fec28c5c939a451e3b5cac`. This base predates S14 (#1712,
`ab817aff26aae5e1f6d2ce3851918234076dc00e`): S14's API/tests are absent and
were not cherry-picked. Only this note and the new contract test are added.

## Cap's ruling

Choose **owner-owned atomic legacy adoption** below, or **retire conversion**
and let the later L08 facade use current owner facts only. Separate S14 reads
and unconditional applies cannot protect a concurrent fact/tombstone. A
facade-local lock does not cover other owner writers. No facade/private-owner
transaction, fallback, retry, prompt patch or save gate is proposed.

## Proposed producer API (name/DTO subject to the ruling)

```python
adopt_legacy_booking_identity(*, legacy_version: int, expected_revision: int)
# {'outcome': 'adopted' | 'not_adopted', 'reason': str,
#  'identity': {'revision': int, 'values': dict, 'tombstones': list}}
```

1. **Explicit opt-in, not fresh-turn prefill.** Accept no caller roster, source
   scope or session ID. Request fields are strict nonnegative ints, not bools;
   unsupported version -> `unsupported_version`. Invalid types -> bounded
   `booking_identity_legacy_request_invalid` diagnostic.
2. Reuse AQ's authenticated task/capability, tenant, database/session incarnation,
   lifecycle and epoch checks. In **one owner `BEGIN IMMEDIATE` transaction**, read
   current identity and compare the requested revision (`revision_changed` on
   mismatch). Any established revision/fact/tombstone -> `current_identity`;
   **only revision 0 with no values/tombstones is eligible**. Never partly fill a
   current record; malformed owner data is an error, not virgin state.
3. Within the same transaction, read **this session's committed v2 source and
   epoch witnesses**. Validate version, canonical identity, exact tenant/phone/
   supported location, session start, generation, epoch and live witnesses.
   Missing source -> `no_legacy`; invalid/unprovable -> `invalid_legacy`.
   Never borrow another session, infer ancestry, repair/revoke an epoch, or
   write legacy rows. All non-adoptions leave stored bytes unchanged.
4. Phone/location must use reviewed trusted-ingress bindings, never tool data.
   Tests use canonical WhatsApp chat/phone and empty Wolfhouse location. If the
   runtime cannot prove that mapping, decline adoption—not the booking save.
5. Apply identity through S14's canonical projection; advance its revision once
   and return detached data (`adopted`). Preserve clears as tombstones. Import
   no count, commercial/room, plan, consent, payment, delivery or save authority.
   Established owner state makes repetition harmless; no dual-write is needed.
6. SQL faults roll back optional adoption and propagate, as with S14. The later
   facade must retain the untouched explicit create request and continue its
   existing create path. **Conversion success must never be a save prerequisite.**
   No stale read repair, retry or replacement identity owner.

## Tests and actual execution

```sh
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH=/opt/hermes:docker/hermes-staging
/opt/hermes/.venv/bin/python -m unittest \
  wolfhouse.test_l08_atomic_conversion_contract.NativePreconditions -v
/opt/hermes/.venv/bin/python -m unittest \
  wolfhouse.test_l08_atomic_conversion_contract.AtomicConversionContract -v
```

Real SessionDB/SQLite fixture; network fenced; no mocked conversion function.
**3 native controls pass. 20 proposed contracts are intentionally RED at the
explicit missing-API assertion**, without import/runtime errors or skips. Their
behavior assertions await a producer implementation; no adoption/concurrency
success is claimed. This is not registered as a release gate.

Coverage: reopen/idempotence; unchanged non-identity state; legacy-write trigger;
versions/types; caller-scope rejection; current facts/tombstones, legacy clears
and malformed owner state; committed revision interleaving; invalid source/
witnesses; no cross-session borrowing; actual SQL-trigger rollback; and owner
lifecycle. The atomicity contract traces protected SELECTs and requires a second
SQLite connection to receive `SQLITE_BUSY` under one write transaction—rather
than accepting a facade lock or a read-then-unconditional-write substitute.

**Next:** Cap rules; Seadog owns producer/S14 composition. A separately authorized
L08 must then prove registered correction/reopen/sparse continuation and actual
saved occupants, including an optional-adoption-fault save control. These prep
tests do not invoke create or prove consumer handling. If conversion is retired,
discard the proposed contracts rather than implement an unwanted migration.
No production/stay-off edits or live booking, guest, payment, deploy, merge or
restart operations.
