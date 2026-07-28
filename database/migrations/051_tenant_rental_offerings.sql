-- Surf-school template Phase 2: rentable-item catalog as DATA (not a code enum).
--
-- Today the rental catalog is a closed code enum: RENTAL_GROUP_KEYS /
-- RENTAL_GROUP_OFFERING in scripts/lib/tenant-admin-writes.js, with the
-- board_and_suit vs board/wetsuit mutual-exclusion hardcoded across
-- scripts/staff-query-api.js. That blocks a school from adding/removing rentable
-- items and blocks templating.
--
-- This table makes each rentable item a client+location scoped row so the admin
-- panel can add / rename / delete items, and the booking-drawer exclusion logic
-- can read rules from data instead of `if (key === 'board_and_suit_rental')`.
--
-- ADDITIVE / UNWIRED: creating this table changes no behavior. The Phase 2 code
-- swap (admin CRUD + exclusion reads) and the Sunset seed (board/wetsuit/bundle/
-- sup -> rows, for parity) land in later commits behind the template smoke gate.
-- Pricing stays in tenant_price_rules keyed by the offering__duration item_code;
-- this table owns item identity/among/exclusion, NOT money.
--
-- Refs: docs/SURF-SCHOOL-TEMPLATE-PLAN.md Phase 2.

CREATE TABLE IF NOT EXISTS tenant_rental_offerings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug       TEXT NOT NULL,
  location_id       TEXT,
  offering_key      TEXT NOT NULL,           -- e.g. board_rental, wetsuit_rental, board_and_suit_rental, sup_rental, kayak_rental
  label             TEXT NOT NULL,           -- staff/guest display, e.g. 'Surfboard + Wetsuit'
  group_key         TEXT NOT NULL,           -- UI grouping, free-form per client (bundles|boards|wetsuits|sup|...)
  -- offering_keys that cannot be co-selected with this item (e.g. a bundle
  -- excludes its component board_rental + wetsuit_rental). Data replacement for
  -- the hardcoded mutual-exclusion logic. Empty = no exclusions.
  excludes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        UUID REFERENCES staff_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE tenant_rental_offerings IS
  'Surf-school template: rentable items as data (client+location scoped). Item identity/grouping/exclusion only; pricing stays in tenant_price_rules.';

CREATE INDEX IF NOT EXISTS idx_tenant_rental_offerings_client_active
  ON tenant_rental_offerings (client_slug, active);

CREATE INDEX IF NOT EXISTS idx_tenant_rental_offerings_client_loc
  ON tenant_rental_offerings (client_slug, location_id)
  WHERE active = true;

-- One active row per (client, location, offering_key). COALESCE so a NULL
-- location does not defeat the uniqueness guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_rental_offerings_active
  ON tenant_rental_offerings (client_slug, COALESCE(location_id, ''), offering_key)
  WHERE active = true;

CREATE TRIGGER tenant_rental_offerings_updated_at
  BEFORE UPDATE ON tenant_rental_offerings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
