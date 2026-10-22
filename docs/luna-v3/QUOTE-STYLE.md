# Booking quote message style

Approved by Ty on 2026-10-20.

## Required layout

```text
Here's your stay 🌊
📅 Sun 1 Nov – Mon 9 Nov · 1 guest
🛏️ A bed in a shared room
💶 Total: €400

You can pay a €200 deposit now or the full €400. Which would you like?
```

## Rules

- Put `€` before the amount.
- Omit only a trailing `.00`; preserve real cents (for example, `€400.50`).
- For one guest, do not add a `name:` label.
- For multiple guests, list guests naturally by name with their room/package details.
- Do not say “check for this booking.”
- Good formatting matters more than making the message artificially short.
- Keep the dates, party size, room or bed selection, package/add-ons, total, deposit, and remaining amount exactly aligned with the latest Staff result.
- Ask one clear next question.
