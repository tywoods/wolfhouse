# Package Pricing Rules

**Source:** Wolfhouse website (Ale/Cami).  
**Unit:** EUR **per person per week** (shared room).  
**Shorter stays:** Prorate, then **round up to the nearest €5** (per person).

## Weekly rates (shared)

| Season (check-in month) | Malibu | Uluwatu | Waimea |
|-------------------------|--------|---------|--------|
| April, May, June, October | €249/wk | €349/wk | €499/wk |
| July, September | €299/wk | €399/wk | €549/wk |
| August | €349/wk | €449/wk | €599/wk |

August rules override July/September when check-in is in August (`priority` in `package_price_rules`).

## Proration formula

```text
nights = check_out - check_in   (calendar nights)

per_person_total_eur = CEIL_TO_5( weekly_price_eur × nights / 7 )

booking_shared_total = per_person_total_eur × guest_count
```

**CEIL_TO_5(x)** = round up to nearest 5 euros: `Math.ceil(x / 5) * 5`

### Examples (Malibu €249/week, shared)

| Nights | Raw prorate | After CEIL_TO_5 (per person) |
|--------|-------------|------------------------------|
| 7 | €249.00 | €249 |
| 3 | €106.71 | **€110** |
| 1 | €35.57 | **€40** (if quoting per-night display: CEIL_TO_5(249/7) = €40/night) |

| Stay | Calculation | 2 guests |
|------|-------------|----------|
| 3 nights Malibu spring | €110 × 2 | **€220** shared |

## Double / private room

**+€10 per person per night** on top of the prorated shared package total:

```text
double_extra = 10 × guest_count × nights

total = booking_shared_total + double_extra
```

## Postgres helpers

In `database/migrations/002_package_pricing.sql`:

- `ceil_eur_to_nearest_5(amount_eur)`
- `package_stay_total_per_person_eur(weekly_price_eur, nights)`
- `package_display_nightly_per_person_eur(weekly_price_eur)` — for WhatsApp quotes only

Example query:

```sql
SELECT package_stay_total_per_person_eur(249, 3);  -- returns 110
```

## n8n / Stripe (implementation note)

1. Resolve `package_price_rules` row from `check_in` month + package code.  
2. `weekly_eur = price_per_person_per_week_cents / 100`  
3. `per_person = ceilToNearest5(weekly_eur * nights / 7)`  
4. `total_cents = (per_person * guest_count + double_extra) * 100`  
5. Stripe Checkout line item description: package name + dates + guest count.

Deposit (€200 in manual sheet) is separate until owners confirm deposit vs full prepay.

## JavaScript (for n8n Code nodes)

```javascript
function ceilToNearest5(eur) {
  return Math.ceil(eur / 5) * 5;
}

function packageStayPerPersonEur(weeklyEur, nights) {
  return ceilToNearest5((weeklyEur * Math.max(nights, 1)) / 7);
}
```
