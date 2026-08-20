-- Durable SMTP health fact only; does not activate endpoint capabilities.
BEGIN;

ALTER TABLE tenant_channel_endpoints
  ADD COLUMN smtp_health_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN tenant_channel_endpoints.smtp_health_verified_at IS
  'Last successful SMTP STARTTLS AUTH+QUIT health verification; never implies inbound/outbound activation.';

COMMIT;
