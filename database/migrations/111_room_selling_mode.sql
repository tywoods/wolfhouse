-- Room Placement 008: independent selling policy; never rewrite legacy room types.
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS selling_mode text NOT NULL DEFAULT 'shared';
ALTER TABLE rooms ADD CONSTRAINT rooms_selling_mode_check
  CHECK (selling_mode IN ('shared', 'private', 'private_optional'));
COMMENT ON COLUMN rooms.selling_mode IS 'Ordinary-room selling policy. Legacy couple/operator protections take precedence.';
COMMIT;
