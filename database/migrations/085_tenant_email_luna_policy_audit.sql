-- 085_tenant_email_luna_policy_audit.sql
-- Bounded pre-send Luna policy audit journal. Empty on migrate. Send-inert.
-- Does not extend tenant_email_outbound_send_journal (send phases/approval/body).
-- Identity: caller operation_id UUID PK + canonical issuance_id unique surrogate.
-- Authority: tenant/location/location_key/endpoint/conversation composite FKs.
-- No guest content, fact values, credentials, provider bodies, prompts, or JSON.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_client_id_id_uq') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_locations_client_id_id_location_key_uq') THEN
    ALTER TABLE tenant_locations
      ADD CONSTRAINT tenant_locations_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_channel_endpoints_client_id_id_location_key_uq') THEN
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_client_id_id_location_key_uq UNIQUE (client_id, id, location_id);
  END IF;
END $$;

CREATE TABLE tenant_email_luna_policy_audit (
  operation_id UUID PRIMARY KEY,
  issuance_id UUID NOT NULL,
  client_id UUID NOT NULL,
  location_id UUID NOT NULL,
  location_key TEXT NOT NULL,
  endpoint_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  policy_version TEXT NOT NULL,
  eligibility_policy_version TEXT NOT NULL,
  canonical_status TEXT NOT NULL,
  canonical_reason TEXT NULL,
  eligibility_status TEXT NOT NULL,
  eligibility_reason TEXT NULL,
  fact_refs TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_email_luna_policy_audit_issuance_uq UNIQUE (issuance_id),
  CONSTRAINT tenant_email_luna_policy_audit_location_identity_fk
    FOREIGN KEY (client_id, location_id, location_key)
    REFERENCES tenant_locations (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_policy_audit_endpoint_location_fk
    FOREIGN KEY (client_id, endpoint_id, location_key)
    REFERENCES tenant_channel_endpoints (client_id, id, location_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_policy_audit_conversation_fk
    FOREIGN KEY (client_id, conversation_id) REFERENCES conversations (client_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_email_luna_policy_audit_location_key_shape
    CHECK (location_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(location_key) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_luna_policy_audit_policy_version_values
    CHECK (policy_version = 'email-luna-draft-policy.v1' AND char_length(policy_version) BETWEEN 1 AND 64),
  CONSTRAINT tenant_email_luna_policy_audit_eligibility_version_values
    CHECK (
      eligibility_policy_version = 'email-luna-autonomous-eligibility-policy.v1'
      AND char_length(eligibility_policy_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT tenant_email_luna_policy_audit_canonical_status_values
    CHECK (canonical_status IN ('draft_ready', 'handoff_required')),
  CONSTRAINT tenant_email_luna_policy_audit_eligibility_status_values
    CHECK (eligibility_status IN ('eligible', 'handoff_required')),
  CONSTRAINT tenant_email_luna_policy_audit_canonical_reason_values
    CHECK (
      canonical_reason IS NULL
      OR canonical_reason IN (
        'ambiguous_identity',
        'uncertain_intent',
        'unsupported_intent',
        'missing_required_facts',
        'tool_error',
        'authority_mismatch',
        'cross_location_request',
        'explicit_human_request',
        'prompt_injection_detected',
        'unsafe_transactional_request',
        'stale_evidence'
      )
    ),
  CONSTRAINT tenant_email_luna_policy_audit_eligibility_reason_values
    CHECK (
      eligibility_reason IS NULL
      OR eligibility_reason IN (
        'ambiguous_identity',
        'missing_required_facts',
        'unissued_evidence',
        'stale_evidence',
        'unsupported_intent',
        'sensitive_intent',
        'attachment_interpretation_required',
        'prompt_injection_detected',
        'explicit_human_request',
        'authority_mismatch'
      )
    ),
  CONSTRAINT tenant_email_luna_policy_audit_canonical_reason_coupling CHECK (
    (canonical_status = 'draft_ready' AND canonical_reason IS NULL)
    OR (canonical_status = 'handoff_required' AND canonical_reason IS NOT NULL)
  ),
  CONSTRAINT tenant_email_luna_policy_audit_eligibility_reason_coupling CHECK (
    (eligibility_status = 'eligible' AND eligibility_reason IS NULL AND canonical_status = 'draft_ready')
    OR (eligibility_status = 'handoff_required' AND eligibility_reason IS NOT NULL)
  ),
  CONSTRAINT tenant_email_luna_policy_audit_fact_refs_bounds CHECK (
    fact_refs IS NOT NULL
    AND array_position(fact_refs, NULL) IS NULL
    AND cardinality(fact_refs) BETWEEN 0 AND 5
    AND fact_refs IN (
      ARRAY[]::text[],
      ARRAY['catalog']::text[],
      ARRAY['availability']::text[],
      ARRAY['policy']::text[],
      ARRAY['booking']::text[],
      ARRAY['payment']::text[],
      ARRAY['catalog', 'availability']::text[],
      ARRAY['catalog', 'policy']::text[],
      ARRAY['catalog', 'booking']::text[],
      ARRAY['catalog', 'payment']::text[],
      ARRAY['availability', 'policy']::text[],
      ARRAY['availability', 'booking']::text[],
      ARRAY['availability', 'payment']::text[],
      ARRAY['policy', 'booking']::text[],
      ARRAY['policy', 'payment']::text[],
      ARRAY['booking', 'payment']::text[],
      ARRAY['catalog', 'availability', 'policy']::text[],
      ARRAY['catalog', 'availability', 'booking']::text[],
      ARRAY['catalog', 'availability', 'payment']::text[],
      ARRAY['catalog', 'policy', 'booking']::text[],
      ARRAY['catalog', 'policy', 'payment']::text[],
      ARRAY['catalog', 'booking', 'payment']::text[],
      ARRAY['availability', 'policy', 'booking']::text[],
      ARRAY['availability', 'policy', 'payment']::text[],
      ARRAY['availability', 'booking', 'payment']::text[],
      ARRAY['policy', 'booking', 'payment']::text[],
      ARRAY['catalog', 'availability', 'policy', 'booking']::text[],
      ARRAY['catalog', 'availability', 'policy', 'payment']::text[],
      ARRAY['catalog', 'availability', 'booking', 'payment']::text[],
      ARRAY['catalog', 'policy', 'booking', 'payment']::text[],
      ARRAY['availability', 'policy', 'booking', 'payment']::text[],
      ARRAY['catalog', 'availability', 'policy', 'booking', 'payment']::text[]
    )
  )
);

COMMENT ON TABLE tenant_email_luna_policy_audit IS
  'Pre-send Luna policy audit. Authority identifiers, bounded status/reason, policy versions, issuance surrogate, safe fact refs only.';

CREATE INDEX idx_tenant_email_luna_policy_audit_conversation
  ON tenant_email_luna_policy_audit (client_id, conversation_id, created_at DESC);
CREATE INDEX idx_tenant_email_luna_policy_audit_endpoint
  ON tenant_email_luna_policy_audit (client_id, endpoint_id, created_at DESC);

CREATE OR REPLACE FUNCTION tenant_email_luna_policy_audit_protect() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'tenant_email_luna_policy_audit: append-only mutation refused' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_email_luna_policy_audit_protect_update
  BEFORE UPDATE ON tenant_email_luna_policy_audit
  FOR EACH ROW EXECUTE FUNCTION tenant_email_luna_policy_audit_protect();
CREATE TRIGGER tenant_email_luna_policy_audit_protect_delete
  BEFORE DELETE ON tenant_email_luna_policy_audit
  FOR EACH ROW EXECUTE FUNCTION tenant_email_luna_policy_audit_protect();

COMMIT;
