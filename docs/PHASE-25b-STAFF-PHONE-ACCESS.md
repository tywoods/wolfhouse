# Phase 25b — Staff phone access foundation

**Status:** IMPLEMENTED (foundation only — no WhatsApp routing yet)  
**Design lock:** `docs/PHASE-25-OWNER-ASK-LUNA-DESIGN.md` (commit `d45e920`)  
**Slice:** 25b — table + helper + generic upsert CLI

## Multi-client rule

**Only rows change per client.** Runtime logic in `scripts/lib/staff-phone-access.js` is generic.

| client_slug | display_name | phone_e164 | role |
|-------------|--------------|------------|------|
| `wolfhouse-somo` | Ty | `+491726422307` | owner |
| `wolfhouse-somo` | Ale | *(add when known)* | owner |
| `wolfhouse-somo` | Cami | *(add when known)* | owner |
| `sunset-surf-shop` | Owner Name | `+34…` | owner |
| `sunset-surf-shop` | Staff Name | `+34…` | operator |

No Wolfhouse/Ty/Ale/Cami hard-coding in runtime code.

### Wolfhouse policy (data only)

- **Ty, Ale, Cami** — all **owner** for `wolfhouse-somo`
- **Ty phone known:** `+491726422307`
- **Ale / Cami phones:** not invented — add rows via generic upsert when numbers are provided

## Table: `staff_phone_access`

Migration: `database/migrations/016_staff_phone_access.sql`

| Column | Purpose |
|--------|---------|
| `client_slug` | Tenant scope (required on every lookup) |
| `phone_e164` | Display/storage `+digits` |
| `phone_normalized` | Digits-only match key |
| `display_name` | Staff/owner label |
| `role` | `operator` \| `owner` |
| `channel` | Default `whatsapp` |
| `is_active` | Only active rows route in **25c** |
| `notes` | Optional admin notes |

**Unique:** `(client_slug, phone_normalized, channel)`

## Phone normalization

| Input | `phone_normalized` | `phone_e164` |
|-------|-------------------|--------------|
| `+491726422307` | `491726422307` | `+491726422307` |
| `491726422307` | `491726422307` | `+491726422307` |
| `49 172 6422307` | `491726422307` | `+491726422307` |
| `(49)172-6422307` | `491726422307` | `+491726422307` |

Matching uses **digits only** + **client_slug** + **channel**.

## Helper API

Module: `scripts/lib/staff-phone-access.js`

- `normalizeStaffPhone(phone)` → digits only
- `formatStaffPhoneE164(phone)` → `+digits`
- `lookupStaffPhoneAccess(pg, { client_slug, phone, channel })`
- `upsertStaffPhoneAccess(pg, { client_slug, phone, display_name, role, … })`

## Generic upsert CLI

```bash
node scripts/upsert-staff-phone-access.js \
  --client wolfhouse-somo \
  --phone +491726422307 \
  --name Ty \
  --role owner
```

Future clients: change `--client` and `--phone` only.

## Out of scope (25b)

- **No WhatsApp routing** — Stage **25c**
- Non-allowlisted phones remain **guest flow** (unchanged until 25c fork)
- No shadow-mode-only behavior — table/helper are real and testable once migration applied
- No Staff API admin routes (deferred if needed)
- No audit log

## Staging apply (when requested)

1. Apply migration `016_staff_phone_access.sql` to staging DB
2. Upsert Ty: `node scripts/upsert-staff-phone-access.js --client wolfhouse-somo --phone +491726422307 --name Ty --role owner`
3. When Ale/Cami numbers are known, same command with their phones
4. Verify: `SELECT * FROM staff_phone_access WHERE client_slug = 'wolfhouse-somo';`
5. Prove lookup: `lookupStaffPhoneAccess` with `491726422307` variants matches Ty row
6. **No WhatsApp sends** in 25b

## Verifier

`npm run verify:luna-agent-phase25-staff-phone-access`
