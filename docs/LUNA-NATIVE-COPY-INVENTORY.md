# Luna native-copy inventory

| Consumer / family | Catalog authority | Locale/register status |
|---|---|---|
| Quote save and payment questions | `guest_copy.json` `quote_style_*` | DE/FR/IT/ES/EN present; solo/group keys where the renderer can select them |
| Paid confirmation rooms, arrival and methods | `confirmation_*` | DE/FR/IT/ES/EN present; renderer already wired |
| Accepted quote and pending question fixed output | existing quote/pending keys | already wired; reserved consumer files not changed by NL1 |
| Guard/outage fallback families | proposed catalog-ready only | runtime consumer wiring is reserved for NL3; do not claim live coverage |
| Inline saved-booking fallback | proposed catalog-ready only | reserved consumer integration required |

## Reviewed NL1 changes

- FR fixed copy uses consistent friendly `vous` in stay, room fallback, and retry copy.
- DE saved-booking wording uses `bei uns eingetragen`; it does not imply payment.
- DE solo shuttle question addresses a single guest with `du`.

This inventory records catalog status, not sticky-language runtime acceptance. Runtime selection, output guards, and persisted language ownership remain outside NL1.
