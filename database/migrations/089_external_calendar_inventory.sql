-- 089_external_calendar_inventory.sql
-- Calendar Inventory Bridge Slice 1: tenant-scoped Google Sheet connections,
-- bed-only maps, and feed-side event identity. Occupancy still lives on
-- bookings + booking_beds. This migration does not write blocks.
--
-- Owned occupancy rows (later slices) MUST use:
--   booking_beds.assignment_type = 'external_inventory_block'
--   bookings.metadata.external_calendar.connection_id = this connection
-- Sync may mutate only those rows. Guest / staff_block / operator_block /
-- private_room_block are never updated by this programme.

BEGIN;

CREATE TABLE IF NOT EXISTS public.external_calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  location_id uuid NULL,
  kind text NOT NULL DEFAULT 'gsheet',
  name text NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  spreadsheet_id text NOT NULL,
  sheet_name text NOT NULL DEFAULT 'inventory',
  poll_seconds integer NOT NULL DEFAULT 900,
  stale_after interval NOT NULL DEFAULT interval '6 hours',
  last_success_at timestamptz NULL,
  last_attempt_at timestamptz NULL,
  last_error text NULL,
  last_header_sha text NULL,
  last_content_sha256 text NULL,
  consecutive_empty_ok integer NOT NULL DEFAULT 0,
  created_by_staff_id text NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT external_calendar_connections_kind_chk
    CHECK (kind = 'gsheet'),
  CONSTRAINT external_calendar_connections_status_chk
    CHECK (status IN ('disabled', 'pending', 'healthy', 'stale', 'error')),
  CONSTRAINT external_calendar_connections_name_chk
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT external_calendar_connections_sheet_chk
    CHECK (char_length(btrim(spreadsheet_id)) BETWEEN 8 AND 120
       AND char_length(btrim(sheet_name)) BETWEEN 1 AND 80),
  CONSTRAINT external_calendar_connections_poll_chk
    CHECK (poll_seconds BETWEEN 60 AND 86400),
  CONSTRAINT external_calendar_connections_empty_ok_chk
    CHECK (consecutive_empty_ok >= 0)
);

CREATE INDEX IF NOT EXISTS idx_extcal_conn_client
  ON public.external_calendar_connections (client_id, status);

CREATE TABLE IF NOT EXISTS public.external_calendar_secrets (
  connection_id uuid PRIMARY KEY
    REFERENCES public.external_calendar_connections (id) ON DELETE CASCADE,
  secret_ref text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT external_calendar_secrets_ref_chk
    CHECK (char_length(btrim(secret_ref)) BETWEEN 3 AND 200
       AND secret_ref !~* '(BEGIN |PRIVATE KEY|eyJ|ya29\.|AIza)')
);

CREATE TABLE IF NOT EXISTS public.external_calendar_unit_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL
    REFERENCES public.external_calendar_connections (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  external_unit_key text NOT NULL,
  bed_id uuid NOT NULL REFERENCES public.beds (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT external_calendar_unit_maps_key_chk
    CHECK (char_length(btrim(external_unit_key)) BETWEEN 1 AND 80),
  CONSTRAINT external_calendar_unit_maps_conn_key_uq
    UNIQUE (connection_id, external_unit_key),
  CONSTRAINT external_calendar_unit_maps_conn_bed_uq
    UNIQUE (connection_id, bed_id)
);

CREATE INDEX IF NOT EXISTS idx_extcal_maps_client_bed
  ON public.external_calendar_unit_maps (client_id, bed_id);

CREATE TABLE IF NOT EXISTS public.external_inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL
    REFERENCES public.external_calendar_connections (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  external_uid text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  map_id uuid NULL
    REFERENCES public.external_calendar_unit_maps (id) ON DELETE SET NULL,
  booking_id uuid NULL REFERENCES public.bookings (id) ON DELETE SET NULL,
  status text NOT NULL,
  skip_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT external_inventory_events_uid_chk
    CHECK (char_length(btrim(external_uid)) BETWEEN 1 AND 160),
  CONSTRAINT external_inventory_events_period_chk
    CHECK (period_end > period_start),
  CONSTRAINT external_inventory_events_status_chk
    CHECK (status IN ('imported', 'skipped_unmapped', 'skipped_conflict', 'tombstoned')),
  CONSTRAINT external_inventory_events_conn_uid_uq
    UNIQUE (connection_id, external_uid)
);

CREATE INDEX IF NOT EXISTS idx_extcal_events_booking
  ON public.external_inventory_events (booking_id)
  WHERE booking_id IS NOT NULL;

COMMIT;
