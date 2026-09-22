# LUNA-PERSONALITY-CONVERSATIONALIST-001

## Brief plan and implementation

Extend the existing closed personality packs, not the booking engine: select in Luna Staff, persist the tenant setting, bind one server-owned pack on the next supported WhatsApp turn, and pass it through existing authoring/admission. Keep Sunny default and all previous packs unchanged. No new bot, model, lookup tool, channel or free-form prompt editor.

Conversationalist is a warm, lightly playful receptionist: short spoken turns, acknowledge volunteered feelings, occasional grounded small talk, then naturally return to the planned next step. Ask one question; do not re-ask known details. No invented weather, personal experiences or booking facts. Payment/booking truth, language, identity, tool decisions and handoffs remain authoritative.

## Exact key mapping for publisher

- UI label: **Conversationalist** (ES Conversacional; IT Conversazionale).
- Existing selector: `#staff-luna-personality-radios [data-personality-id="conversationalist"]`.
- i18n: `lunaStaff.personality.conversationalist`.
- Existing Staff request: `PUT /staff/luna-personality`, JSON **`{"personality_id":"conversationalist"}`** only. Operator/session auth unchanged.
- Persistence: authenticated tenant's `clients.settings.luna_personality = "conversationalist"`; sibling JSON settings untouched.
- Existing read: `GET /staff/luna-personality`; runtime: `GET /staff/bot/luna-personality` through its authenticated tenant principal.
- JS `getPersonalityPack('conversationalist')`; Python `get_personality_pack('conversationalist')`: identical instructions.
- Existing WhatsApp coverage only: JS guest pipeline and Python `whatsapp`/`whatsapp_cloud`, guest roles `luna` and `sunset-luna`. This does not enable other channels or alter routing.

Deckhand preview tip `5080831b` could not be resolved locally or through GitHub (422). Current base lacks the option, so this patch adds only one button, two closed-ID arrays and translations; no preview redesign. When combining Deckhand's unpublished preview, preserve it and reconcile these key-only hunks. Do not apply an old whole-file Staff API version over newer work. The mapping above is verified against this patch, not against unavailable preview bytes.

## Offline evidence and limits

Red before green: Staff save/read/author-pack regression failed for both tenants before adding the JS pack; ordinary Python binding failed on all tenant/platform combinations before adding the Python pack; selector regression failed before key wiring.

Commands from repository root:

```sh
node scripts/verify-luna-personality-contract.js
node scripts/verify-luna-personality-staff-api.js
node scripts/verify-luna-personality-runtime.js
node scripts/verify-luna-personality-radios.js
node scripts/verify-luna-personality-no-send.js
node scripts/verify-hermes-send-flags.js
```

Results: contract 167/0; Staff API 69/0; runtime 66/0; radios 66/0; no-send 30/0; send flags 53/0 (passed/failed). Runtime also executes Python personality and gateway-bind unit tests. Python personality suite alone: 16 tests, OK.

Executed proof includes tenant-isolated selection and reload; authoritative next-turn changes; one injected server pack; JS/Python key/instruction parity; actual JS author callback plus admission on EN/ES small-talk/date candidates for both tenants; rejection of unsupported booking/payment/availability claims; byte-identical composer-owned payment copy. Postgres and model boundaries are test doubles, not live database/model proof. Corpus additions are authored acceptance examples, not captured Astra responses.

UI baseline was captured before editing for both tenants. Raw byte parity correctly reports a deliberate 422-character increase. Removing exactly the new button, two allowed-ID additions and three serialized locale strings makes each rendered document byte-identical to its baseline. No CSS, unrelated markup or browser module changes.

Broader Python admission/live-eval run: candidate 183 tests; untouched baseline 182 tests; identical failure signatures (29 failures, 7 errors) against the installed Hermes runtime. No guards or admission protections were relaxed. The aggregate gate also has existing Inbox and live-eval environment failures. Its theme gate additionally rejects any dirty Staff API, including these intended selector changes; this is not evidence of a CSS change. The previously stale Staff personality test now applies the same narrow DOM-only Admin regroup allowlist already used by the radios gate (network/radio ownership remains forbidden).

## Publication and staging proof boundary

Base: `d4585944c47fba057b62c1b0e5b734932e249f3d`. Isolated from the Schedule repair. Captain does not push, deploy or alter live tenant settings. Skipper publishes after review; current GitHub master must be checked before applying.

After separately authorized staging rollout: open Luna Staff for each tenant, choose Conversationalist and reload; confirm the other tenant is unchanged. On the existing authorized no-send guest path, check greeting, tired-traveller small talk, dates already supplied, bed/service selection, verified quote/link and confirmation in EN/ES. Inspect actual consumed pack and admitted model reply. Restore previous tenant selections afterward. No guest outbound until Chief authorizes it.

Offline success is not a claim that live Astra naturalness or a real booking has been proved. No production, Autonomy, Gina payment, Schedule, Crow's Nest, lookup tools, or live outbound changes are included.
