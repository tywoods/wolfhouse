BEGIN;

-- FLAG ONLY. Do not apply on staging or prod from this PR.
-- Settings-only: hide the extra Double supplement catalog/price rows.
-- Quotes already treat double as Private; this stops the duplicate Staff card.
-- Before: wh_pricing_items/rules may have item_code 'double' (supplement).
-- After: those rows inactive. Private unchanged. No booking rewrite.

UPDATE wh_pricing_items
   SET active = false, updated_at = NOW()
 WHERE item_type = 'supplement' AND item_code = 'double' AND active = true;

UPDATE wh_pricing_rules
   SET active = false, updated_at = NOW()
 WHERE item_type = 'supplement' AND item_code = 'double' AND active = true;

COMMIT;
