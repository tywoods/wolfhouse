BEGIN;

-- FLAG ONLY. Do not apply on staging or prod from this PR.
-- Settings-only, Wolfhouse tenant only (wolfhouse-somo).
-- Hide the extra Double supplement catalog/price rows.
-- Quotes already treat double as Private; this stops the duplicate Staff card.
-- Before: wh_pricing_items/rules may have item_code 'double' (supplement).
-- After: those Wolfhouse rows inactive. Private unchanged. No booking rewrite.
-- Other tenants are not touched.

UPDATE wh_pricing_items
   SET active = false, updated_at = NOW()
 WHERE client_slug = 'wolfhouse-somo'
   AND item_type = 'supplement' AND item_code = 'double' AND active = true;

UPDATE wh_pricing_rules
   SET active = false, updated_at = NOW()
 WHERE client_slug = 'wolfhouse-somo'
   AND item_type = 'supplement' AND item_code = 'double' AND active = true;

COMMIT;
