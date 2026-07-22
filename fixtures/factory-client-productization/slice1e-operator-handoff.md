# FACTORY 1E — operator handoff

Finite FACTORY stages **1A–1E** are closed for **offline dry-run packaging only**.

## What you have

- One committed synthetic third-tenant stdout artifact: `zyx-null-beacon` (`surf_house`)
- Exact regenerable bytes + manifest hashes under `fixtures/factory-client-productization/slice1e-*`
- Verifier: `npm run verify:factory-slice1e-finite-closeout`

## Operating rules (this milestone)

1. **Stdout preview only** — inspect the JSON envelope; do not treat it as a registered client.
2. **Disk / apply unsupported** — no `--output-dir`, no `--apply`, no publish into `config/clients/` or registries.
3. **No production / staging / deploy** in this milestone — do not build images, push ACA, or enable WhatsApp for this slug.
4. **Manual future review steps** (before any real third tenant):
   - Human review of archetype fit + substitutions
   - Explicit **RADAR reopen** `third_tenant_factory` and security review
   - Separate enablement gate for `live_enabled` / channels
   - Separate apply/materialization design (not delivered here)
5. **Retained REDs stay RED** — staff-tenant-scope H3 and tenant-business-config DB-prices merge are pre-existing; FACTORY does not claim them fixed.

## What FACTORY does / does not prove

**Proves:** deterministic disabled dry-run packaging + verifier gates for a clearly fake tenant.  
**Does not prove:** live third-tenant readiness, apply safety, or deploy authority.
