-- Explicit down for 100_tenant_email_reply_approvals_inbound_claim.
-- Drops the inbound-event unique claim index only. Does not delete approval rows.

BEGIN;

DROP INDEX IF EXISTS tenant_email_reply_approvals_inbound_claim_uq;

COMMIT;
