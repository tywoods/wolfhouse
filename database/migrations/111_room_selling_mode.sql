-- Room Placement 008: independent selling policy; never rewrite legacy room types.
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS selling_mode text NOT NULL DEFAULT 'shared';

DO $selling_mode_contract$
DECLARE
  column_type text;
  column_not_null boolean;
  column_default text;
  constraint_def text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull,
         pg_get_expr(d.adbin, d.adrelid)
    INTO column_type, column_not_null, column_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.rooms'::regclass
     AND a.attname='selling_mode' AND a.attnum>0 AND NOT a.attisdropped;
  IF column_type IS DISTINCT FROM 'text'
     OR column_not_null IS DISTINCT FROM true
     OR column_default IS DISTINCT FROM '''shared''::text' THEN
    RAISE EXCEPTION '111 incompatible rooms.selling_mode contract: type=%, not_null=%, default=%',
      column_type, column_not_null, column_default USING ERRCODE='55000';
  END IF;

  SELECT pg_get_constraintdef(oid, false) INTO constraint_def
    FROM pg_constraint
   WHERE conrelid='public.rooms'::regclass AND conname='rooms_selling_mode_check';
  IF constraint_def IS NULL THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_selling_mode_check
      CHECK (selling_mode IN ('shared', 'private', 'private_optional'));
  ELSIF constraint_def IS DISTINCT FROM
      'CHECK ((selling_mode = ANY (ARRAY[''shared''::text, ''private''::text, ''private_optional''::text])))' THEN
    RAISE EXCEPTION '111 incompatible rooms_selling_mode_check: %', constraint_def
      USING ERRCODE='55000';
  END IF;
END $selling_mode_contract$;

COMMENT ON COLUMN rooms.selling_mode IS 'Ordinary-room selling policy. Legacy couple/operator protections take precedence.';
COMMIT;
