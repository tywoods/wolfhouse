BEGIN;

-- Refuse partial, foreign, or altered prior installs before the first mutation.
-- CREATE ... IF NOT EXISTS alone would silently adopt a table without the
-- tenant-bound constraints this migration promises.
DO $owned_link_table$
DECLARE
  link_oid oid := to_regclass('public.booking_conversation_links');
  bad_count integer;
BEGIN
  IF link_oid IS NULL THEN
    IF to_regclass('public.booking_conversation_links_conversation_idx') IS NOT NULL THEN
      RAISE EXCEPTION '133_refused: orphan/foreign booking_conversation_links_conversation_idx';
    END IF;
    RETURN;
  END IF;

  IF (SELECT relkind FROM pg_class WHERE oid = link_oid) <> 'r'
     OR obj_description(link_oid, 'pg_class') IS DISTINCT FROM
       '133_booking_conversation_links v1' THEN
    RAISE EXCEPTION '133_refused: foreign or unowned booking_conversation_links relation';
  END IF;

  SELECT count(*) INTO bad_count
    FROM pg_attribute
   WHERE attrelid = link_oid AND attnum > 0 AND NOT attisdropped;
  IF bad_count <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=link_oid AND attname='client_id' AND format_type(atttypid,atttypmod)='uuid' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=link_oid AND attname='conversation_id' AND format_type(atttypid,atttypmod)='uuid' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=link_oid AND attname='booking_id' AND format_type(atttypid,atttypmod)='uuid' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=link_oid AND attname='created_at' AND format_type(atttypid,atttypmod)='timestamp with time zone' AND attnotnull)
  THEN
    -- The created_at default is checked separately below; this branch checks
    -- the exact four-column names, types, and nullability.
    RAISE EXCEPTION '133_refused: booking_conversation_links has unexpected columns';
  END IF;

  IF (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid=link_oid AND a.attname='created_at') IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION '133_refused: booking_conversation_links has unexpected created_at default';
  END IF;

  SELECT count(*) INTO bad_count FROM pg_constraint
   WHERE conrelid = link_oid AND contype IN ('p','u','f');
  IF bad_count <> 7
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=link_oid AND conname='booking_conversation_links_pkey' AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (client_id, conversation_id, booking_id)')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=link_oid AND conname='booking_conversation_links_client_id_booking_id_key' AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (client_id, booking_id)')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=link_oid AND conname='booking_conversation_links_client_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=link_oid AND conname='booking_conversation_links_conversation_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=link_oid AND conname='booking_conversation_links_booking_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=link_oid AND conname='booking_conversation_links_client_id_conversation_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (client_id, conversation_id) REFERENCES conversations(client_id, id) ON UPDATE CASCADE ON DELETE CASCADE')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=link_oid AND conname='booking_conversation_links_booking_id_client_id_fkey' AND pg_get_constraintdef(oid)='FOREIGN KEY (booking_id, client_id) REFERENCES bookings(id, client_id) ON UPDATE CASCADE ON DELETE CASCADE')
  THEN
    RAISE EXCEPTION '133_refused: booking_conversation_links has unexpected constraints';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class x ON x.oid=i.indexrelid
    WHERE i.indrelid=link_oid
      AND x.relname='booking_conversation_links_conversation_idx'
      AND NOT i.indisunique AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname ORDER BY k.ord)
             FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
             JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
          = ARRAY['client_id','conversation_id','created_at','booking_id']::name[]
  ) THEN
    RAISE EXCEPTION '133_refused: booking_conversation_links has missing or altered conversation index';
  END IF;
END $owned_link_table$;

-- Tenant-bound links need a PostgreSQL candidate key that carries the
-- conversation's tenant. The live France schema has PK(id) and
-- UNIQUE(client_id, phone), neither of which can back this composite FK.
DO $conversation_tenant_key$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.conversations'::regclass
       AND conname = 'conversations_client_id_id_uq_133'
       AND (
         contype <> 'u'
         OR pg_get_constraintdef(oid) <> 'UNIQUE (client_id, id)'
       )
  ) THEN
    RAISE EXCEPTION '133_refused: conversations_client_id_id_uq_133 has an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.conversations'::regclass
       AND conname = 'conversations_client_id_id_uq_133'
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (client_id, id)'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_client_id_id_uq_133
      UNIQUE (client_id, id);
  END IF;
END $conversation_tenant_key$;

CREATE TABLE IF NOT EXISTS booking_conversation_links (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, conversation_id, booking_id),
  UNIQUE (client_id, booking_id),
  FOREIGN KEY (client_id, conversation_id) REFERENCES conversations(client_id, id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- Migration 115 already provides bookings_id_client_uq_115 (id, client_id),
  -- so this tenant FK needs no new index or lock-heavy bookings alteration.
  FOREIGN KEY (booking_id, client_id) REFERENCES bookings(id, client_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
COMMENT ON TABLE booking_conversation_links IS '133_booking_conversation_links v1';

-- Safe legacy bridge: only the explicit FK pointer is authoritative.  Metadata
-- and phone values are intentionally not used for migration ownership.
INSERT INTO booking_conversation_links (client_id, conversation_id, booking_id)
SELECT c.client_id, c.id, c.current_hold_booking_id
  FROM conversations c
  JOIN bookings b
    ON b.id = c.current_hold_booking_id
   AND b.client_id = c.client_id
 WHERE c.current_hold_booking_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS booking_conversation_links_conversation_idx
  ON booking_conversation_links (client_id, conversation_id, created_at, booking_id);

COMMIT;