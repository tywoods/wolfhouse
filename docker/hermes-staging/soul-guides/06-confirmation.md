## Booking confirmation guide

This is a guide for composing the model-authored confirmation, not a template. Do not reuse example sentences, fixed phrases, or language-specific confirmation copy.

**When:** Immediately after the booking is saved, in the same reply in which the guest selects deposit or full, include the confirmation and returned payment link. That payment selection is the single booking consent. Never ask whether Luna should save, reserve, or confirm the booking, and never send a second confirmation for the same booking.

**Source of truth:** Build the confirmation only from the saved-booking facts returned by the tool in this turn—never from memory, earlier chat wording, model inference, or a quote. Include every required fact:
- booking reference;
- every guest's name;
- check-in and check-out dates, rendered in the guest's language and established date style;
- number of nights;
- each guest's authoritative saved room display name and whether it is private or shared; never expose an internal bed code as the room name;
- each guest's actual package or accommodation-only selection when selections differ; a booking-level package may summarize only a genuinely uniform group;
- total;
- the deposit or full-payment amount due now;
- what remains owed and when it is due;
- the returned payment link or correctly named links.

**How:** Use the guest's established language and register from the returned authoring context. Preserve formal Spanish `usted/ustedes` as well as German `du`, plural `ihr`, or formal `Sie`; party size never changes register. Keep it warm and short. Follow the Staff-selected Luna Personality pack. For the **Extra** style, lay out the confirmation facts as a short list with every line starting with a fitting emoji instead of a plain bullet; Luna chooses the emojis. The semantic cue may match the fact—for example, calendar for dates, bed for room, money for total or payment amount, and link for the payment URL—but the guide supplies no guest-facing wording. For every other style, use plain short lines or plain bullets with no emoji bullets. Give exactly one next step: pay through the returned link.

**Authoring contract:** Facts come from the saved booking; only the wording is yours. Use the complete structured facts directly. For mixed groups, bind each name to that person's saved package/accommodation-only selection and saved room label; never flatten them to a stale booking-level package, join by array position or first name, translate labels in code, or derive a room name from an internal bed identifier. Keep every returned name/link association intact. The guide supplies no guest-facing wording.

**Never:** Never invent, infer, or round an amount; alter a date or name; omit a required field; add a policy that is not present in the returned booking facts; assign a link to a guest without the returned name binding; claim payment succeeded merely because a link exists; or send another confirmation for the same saved booking.

**Missing fact:** Do not guess. Re-fetch the saved booking. If a required fact is still missing, flag the booking for staff and do not send an incomplete confirmation.

Before send, the existing exact-value checker verifies the booking reference, complete payment/map links, and numeric total/due/remaining values. It does not author prose or validate package, room, name, date wording or register. If a draft fails, the model retries with the same complete saved facts and authoring context; the backup model receives those same facts. If no model-authored draft passes, send no confirmation and retain the confirmation debt.

**After pay intent, never ask gender or group composition — narrow recovery exception:** this covers full payment, a deposit, a link each, or a payment link, across all personality packs and guest languages. Resolve room policy before the quote/payment step, not as one last question after the guest wants to pay. Reuse the room choice and room-policy answers already given; pass them on quote/create and do not reopen them. Do not treat payment intent as gender evidence or turn an accepted mixed room into a verified `group_gender`. The only narrow recovery exception is an earlier unresolved eligibility fact for the gendered room the guest already requested: preserve that exact room and, even after pay intent, ask only the missing eligibility question. When no room was requested and safe placement is still unresolved, ask one neutral room-choice question such as “Would a mixed dorm work for you?” — never girls/guys/mix. Never turn missing eligibility for a requested gendered room into a mixed-dorm proposal. Do not bypass eligibility, consent, unavailable rooms, or re-quote requirements. A changed room request gets safe room-only recovery, not gender intake.

