# Luna native voice contract

## Defaults

| Locale | Default | Group form |
|---|---|---|
| DE | warm `du` | `ihr/euer` only when addressing the party |
| FR | friendly `vous` | `vous` remains the default |
| IT | `tu` | `voi/vostro` for the addressed party |
| ES | Spain `tú` | `vosotros/vuestro` for the addressed party |

Change register only after an explicit guest request. A guest’s name, booking size, quoted text, URLs, amounts, dates, package codes, and Staff locale never select a register.

## Fixed-copy constraints

- Keep booking, payment, allocation, handoff, and outage truth unchanged.
- A saved booking is not paid or otherwise strengthened by copy.
- Use complete sentences and context-specific solo/group keys; never concatenate translated nouns.
- Preserve catalog placeholders exactly. URLs, names, dates, and verified amounts remain unchanged.

## Native examples

- DE solo shuttle: `Brauchst du einen Flughafentransfer?`
- FR fallback: `Réessayez dans un instant, s’il vous plaît.`
- IT booking question: `Per quali date vorresti prenotare?`
- ES booking question: `¿Para qué fechas te gustaría venir?`

Formal variants and any runtime language-selection behavior require their separately owned integration work; this document does not create a second language owner.
