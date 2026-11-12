BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SELECT json_build_object(
  'database', current_database(),
  'read_only', current_setting('transaction_read_only'),
  'standard_items', (SELECT count(*) FROM public.wh_pricing_items WHERE client_slug='wolfhouse-somo' AND item_type='deposit' AND item_code='standard_package' AND active),
  'threshold_present', (SELECT metadata ? 'nights_threshold' FROM public.wh_pricing_items WHERE client_slug='wolfhouse-somo' AND item_type='deposit' AND item_code='standard_package' AND active),
  'threshold', (SELECT metadata->'nights_threshold' FROM public.wh_pricing_items WHERE client_slug='wolfhouse-somo' AND item_type='deposit' AND item_code='standard_package' AND active),
  'rates', (SELECT json_agg(x ORDER BY item_code) FROM (SELECT item_code, amount_cents, unit, currency FROM public.wh_pricing_rules WHERE client_slug='wolfhouse-somo' AND item_type='deposit' AND active AND season_code IS NULL AND item_code IN ('standard_package','custom_or_short_stay')) x),
  'rules_hash', (SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'[]')) FROM public.wh_pricing_rules r WHERE client_slug='wolfhouse-somo' AND item_type='deposit'),
  'items_preserved_hash', (SELECT md5(coalesce(jsonb_agg(CASE WHEN item_code='standard_package' AND active THEN (to_jsonb(i)-'updated_at'-'metadata') || jsonb_build_object('metadata',metadata-'nights_threshold') ELSE to_jsonb(i) END ORDER BY id)::text,'[]')) FROM public.wh_pricing_items i WHERE client_slug='wolfhouse-somo' AND item_type='deposit'),
  'm132_relations_present', to_regclass('public.supervisor_events') IS NOT NULL AND to_regclass('public.supervisor_incidents') IS NOT NULL AND to_regclass('public.supervisor_catchup_checkpoints') IS NOT NULL AND to_regclass('public.supervisor_lifecycle') IS NOT NULL,
  'm133_owned_relation', obj_description(to_regclass('public.booking_conversation_links'),'pg_class')='133_booking_conversation_links v1',
  'm133_key_constraints', (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.booking_conversation_links') AND contype IN ('p','u','f')),
  'pricing_indexes_valid', (SELECT count(*)=2 AND bool_and(indisvalid AND indisready AND indisunique) FROM pg_index WHERE indexrelid IN (to_regclass('public.uq_wh_pricing_items_code'),to_regclass('public.uq_wh_pricing_rules_scope'))),
  'pricing_write_privileges', has_table_privilege(current_user,'public.wh_pricing_items','SELECT') AND has_table_privilege(current_user,'public.wh_pricing_items','INSERT') AND has_table_privilege(current_user,'public.wh_pricing_items','UPDATE') AND has_table_privilege(current_user,'public.wh_pricing_rules','SELECT') AND has_table_privilege(current_user,'public.wh_pricing_rules','INSERT'),
  'pricing_rls_off', (SELECT bool_and(NOT relrowsecurity AND NOT relforcerowsecurity) FROM pg_class WHERE oid IN ('public.wh_pricing_items'::regclass,'public.wh_pricing_rules'::regclass))
);
ROLLBACK;
