-- Durable IMAP health fact + UID/UIDVALIDITY fetch cursor. Does not activate
-- outbound, automation, or auto-send. Inbound remains caller-gated after verify.
BEGIN;

ALTER TABLE tenant_channel_endpoints
  ADD COLUMN imap_health_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN tenant_channel_endpoints.imap_health_verified_at IS
  'Last successful IMAP implicit-TLS LOGIN+SELECT+LOGOUT health verification; never implies outbound/automation activation.';

CREATE TABLE tenant_email_imap_fetch_cursors (
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  mailbox TEXT NOT NULL DEFAULT 'INBOX',
  uidvalidity BIGINT NOT NULL,
  last_uid BIGINT NOT NULL,
  lease_owner TEXT NULL,
  lease_token UUID NULL,
  lease_until TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, endpoint_id, mailbox),
  CONSTRAINT tenant_email_imap_fetch_cursors_mailbox_inbox
    CHECK (mailbox = 'INBOX'),
  CONSTRAINT tenant_email_imap_fetch_cursors_uid_bounds
    CHECK (uidvalidity > 0 AND last_uid >= 0),
  CONSTRAINT tenant_email_imap_fetch_cursors_location_fk
    FOREIGN KEY (client_id, location_id)
    REFERENCES tenant_locations (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT tenant_email_imap_fetch_cursors_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMIT;
