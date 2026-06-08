# Phase 26g.2 — Drawer File-Tab Polish + Transfer Breathing Room

**Status:** IMPLEMENTED

## File-folder tabs

Drawer tabs use connected file-folder styling:

- Rounded top corners on each tab
- Active tab shares background with the content panel (`--surface-soft`)
- Active tab bottom edge blends into the panel (no gap)
- Inactive tabs sit slightly behind with soft `#F3EBE0` background
- Larger 14px labels, obvious click targets

## Unified content panel

All tab bodies render inside `bc-drawer-tab-content-panel` with one soft cream/beige background matching Services.

Overview cards use lighter cream (`var(--surface)`) on the shared panel — not dark tan.

## Duplicate titles removed

Tab labels are the section titles. Removed from tab bodies:

- Services tab: duplicate `<h3>Services</h3>` (add/remove header relabeled “Add or remove”)
- Transfers tab: “Flight / Transfer Details” and lookup helper sentence
- Payments tab: duplicate `<h3>Payment</h3>`

Kept: Arrival/Departure transfer headings, Package/Service schedule/Unscheduled labels, Payment history subsections.

## Transfers tab breathing room

`bc-transfer-tab-spacer` (280px, transparent) sits below transfer cards inside the transfers panel so the tab keeps substantial beige/cream area below the controls when switching tabs.

Content panel `min-height: 680px` reduces drawer collapse when moving between tabs of different heights.

## Tab switching

Preserves 26g.1 behavior: button tabs, preventDefault, scroll preservation — no page jump.

## Safety

- UI/CSS/markup only
- No backend routes, DB writes, Stripe, WhatsApp, Meta, n8n, or guest AI intake
