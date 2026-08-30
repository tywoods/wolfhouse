# SUNSET-TODO — active Sunset product backlog

This is the current working backlog for the Sunset staff portal and Sunset Luna. It intentionally separates active work from shipped history so operators can see the next product decisions without reading the release ledger.

**Tags:** `[BUG]` broken behavior · `[FEAT]` capability · `[LUNA]` guest brain/wiring · `[UI]` interface · `[I18N]` localization · `[SAFETY]` authority/truth boundary.

**Environment boundary:** Sunset staging by default. Production, real-customer outreach, OAuth/grant mutations, and automatic outbound activation require separate approval.

**Current journey contract:** [docs/sunset/SUNSET-GUEST-JOURNEY-DRAFT.md](docs/sunset/SUNSET-GUEST-JOURNEY-DRAFT.md)

---

## Now — close the guest journey

### Same Desk — recommended next slices

Guest WhatsApp and email share one grounded Sunset desk. **002 is this job.** Do not implement 003–005 here. Auto-send stays off; no outreach; staging only.

- **001** Luna uses live Admin catalog; never offer/quote disabled rentals/courses; same names/prices staff see; no hardcoded public-site bundles
- **002** email replies: same grounded brain as WhatsApp, email-shaped (structured quote, one/two asks), still Approve & send
- **003** email booking adapted from WhatsApp: Staff API hold 24h, booking placed when guest pays, unpaid hold expires; email carries quote block + payment link, not chat ping-pong
- **004** email auto like WhatsApp when Luna On / not needs_human / pause off — staging proof only; do not activate
- **005** journey regression pack

### N1 — `[LUNA][BUG][SAFETY]` Live Admin catalog parity

Prove that Luna reads the same enabled offerings, course names, rental tiers, stock/capacity, equipment, add-ons, and accommodation packages that staff see.

Acceptance:

- Disabled rentals/courses are never offered or quoted.
- No hardcoded public-site catalog or stale bundle survives in Luna's path.
- Rental daily/hourly tier selection follows the canonical quote owner.
- Staff portal and Luna resolve the same display names and prices.
- Tenant-isolation and no-invented-price regressions stay green.

This absorbs the old **L2** and begins **W1**.

### N2 — `[LUNA][FEAT]` Sunset journey regression pack

Turn the acceptance journeys in `docs/sunset/SUNSET-GUEST-JOURNEY-DRAFT.md` into maintained deterministic fixtures/probes:

- rental quote/payment/confirmation;
- disabled offering rejection;
- group/private lesson capacity and season coverage;
- accommodation full-coverage versus manual confirmation;
- email reviewed-draft journey;
- autonomy controls and tenant isolation.

### N3 — `[BUG][SAFETY]` Create-as-Paid canonical ledger truth

Creating a booking as Paid must record the canonical collection/payment state consumed by invoice, booking balance, Reservas, and Finanzas. Do not infer payment from a display status.

Acceptance:

- Real create → invoice → Finance regression.
- Correct amount and effective-date attribution.
- Retry does not create duplicate collections.
- Unpaid creation remains unpaid.

Former item: **D5**.

### N4 — `[BUG]` Re-verify and close remaining current P1/P2 defects

The August audit is historical evidence, not proof that every item still reproduces. Re-test before implementation and create one bounded fix per confirmed authority surface.

Priority rechecks:

- Booking drawer/backdrop/scroll-lock behavior.
- Schedule overlap and month navigation.
- Reservas date-filter/search consistency.
- Finance period and pending/gross consistency.
- Inbox stale-detail/wrong-guest risk.
- Remaining create-booking capacity and validation failures.

Do not batch money, inventory, stale-selection, and visual polish into one change.

---

## Next — configuration and staff control

### X1 — `[FEAT][LUNA]` Admin-setting-to-Luna wiring audit

Inventory every Sunset Admin setting and record whether Luna consumes it, intentionally ignores it, or still needs wiring. Keep one canonical owner per setting.

Former items: **W1–W4**.

### X2 — `[FEAT][LUNA]` Beaches and meeting-point configuration

Remove hardcoded beach choices, allow Admin-managed beaches/meeting points, and make Luna consume the same configured values. Preserve historical booking labels when configuration changes.

Former item: **A3**.

### X3 — `[FEAT][SAFETY]` Staff versus Admin/Owner roles

Only Admin/Owner sees and changes Admin configuration. Credential/user lifecycle remains owned by Crowsnest; the portal consumes authoritative role claims.

Former item: **R1**.

### X4 — `[UI]` Four-tab navigation reconciliation

Confirm the intended top-level information architecture against the portal now deployed before changing it:

- Schedule
- Inbox (including people/customer views)
- Bookings
- Admin (including Finance and configuration)

Admin visibility is gated by X3. Do not infer a visual redesign without a current authenticated screenshot/spec.

Former item: **T1**.

### X5 — `[I18N]` Current EN/ES parity pass

Run a fresh authenticated audit after the Inbox and Admin changes. Fix static copy separately from dynamic locale/state bugs. Preserve approved product terms such as Auto/Off/On where intentionally international.

### X6 — `[UI]` Cockpit selector placement

Produce a current mock/spec before implementation. The old note does not define an unambiguous target layout.

Former item: **C1**.

---

## Later — after the desktop journey is stable

### L1 — Mobile, screen by screen

Mobile remains deliberately last. Start only after desktop navigation, Inbox, Bookings, Finance, and Admin controls settle. Track each screen as its own acceptance slice.

### L2 — Automatic outbound activation

Email and WhatsApp automatic sending are separate activation projects, not a consequence of the channel plumbing being built. Require:

- reviewed provider/runtime path;
- tenant-global control readback;
- fail-closed send authority;
- Sunset-only staging proof;
- explicit approval before any real contact.

### L3 — Campaigns and customer outreach

Deferred. Requires explicit outreach approval and the existing customer-outreach kill switches. No backlog item here authorizes a campaign.

### L4 — Broader partner accommodation integrations

Add only when a real partner/source contract exists. Define source authority, availability semantics, conflict handling, and stale-source behavior before implementation.

---

## Open product decisions

1. **Sunset voice:** named Sunset persona or neutral Sunset-branded Luna?
2. **Age/guardian policy:** exact owner-approved eligibility and safeguarding copy per lesson type.
3. **Custom course-name translation:** translated aliases versus staff-entered canonical names.
4. **Roles:** exact Staff versus Admin/Owner permission matrix supplied by Crowsnest.
5. **Accommodation:** which packages are direct inventory versus partner/manual confirmation.

Do not invent these semantics in implementation.

---

## Shipped / established baseline

The following capabilities are already part of the current Sunset staging baseline and should not remain mixed into the active backlog:

- Sunset tenant isolation, dedicated Staff API/database/runtime, and tenant-scoped portal.
- Schedule, Inbox, Reservas/Bookings, Finance, Admin pricing/configuration, rental editor, and course cards.
- Booking cancellation/hide/restore and refund-aware Finance foundations.
- Clickable booking navigation and shared item-name resolution.
- Rental/course/accommodation quoting improvements, including private-lesson and season/inventory guards.
- Inbox customer/guest views, channel autonomy controls, guest context, and reviewed reply workflows.
- Email channel foundations and Inbox integration, including system/noreply sender suppression.
- EN/ES localization improvements, including localized payment labels and Reservas dates.
- Current Sunset Staff staging baseline at master `9dea2acbb0f4f54f14dbb3ac81e9e8099fa6703d`, revision `luna-sunset-staging-staff-api--p2811-9dea2acb`, verified Healthy/Running at 100% traffic on 2026-08-29.

Automatic outbound behavior remains off. A healthy deployed feature is not proof that every guest journey above has end-to-end acceptance coverage.

Historical implementation details remain available in Git history and merged PRs; they should not be reintroduced into this active TODO unless a fresh reproduction shows unfinished behavior.
