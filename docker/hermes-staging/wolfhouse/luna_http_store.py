"""Postgres durability for Sunset Luna inbound, conversation state, and outbox."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from typing import Any


def database_url() -> str:
    value = (os.getenv("LUNA_HTTP_DATABASE_URL") or "").strip()
    if not value:
        raise RuntimeError("luna_http_database_url_missing")
    return value


class PostgresLunaStore:
    """Small synchronous facade; asyncpg is imported only in deployed execution."""

    def __init__(self, dsn: str | None = None):
        self.dsn = dsn or database_url()

    def persist_and_enqueue(self, req: dict[str, Any]) -> dict[str, Any]:
        return asyncio.run(self._persist_and_enqueue(req))

    async def _persist_and_enqueue(self, req: dict[str, Any]) -> dict[str, Any]:
        import asyncpg

        canonical = json.dumps(req, sort_keys=True, separators=(",", ":"))
        payload_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

        conn = await asyncpg.connect(self.dsn)
        try:
            async with conn.transaction():
                # Serialize one tenant/request id across replicas before the
                # read-before-insert idempotency decision. The transaction-scoped
                # lock is released automatically on commit/rollback.
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
                    req["tenant_id"], req["request_id"],
                )
                prior = await conn.fetchrow(
                    "SELECT id::text AS inbound_event_id, conversation_id::text AS conversation_id, request_payload_hash "
                    "FROM luna_guest_inbound_events WHERE tenant_id=$1 AND request_id=$2",
                    req["tenant_id"], req["request_id"],
                )
                if prior:
                    if prior["request_payload_hash"] != payload_hash:
                        raise ValueError("idempotency_conflict")
                    return {**dict(prior), "duplicate": True}
                thread_key = req.get("thread_key") or req.get("conversation_id") or req["request_id"]
                conversation = await conn.fetchrow(
                    """
                    INSERT INTO luna_guest_conversations
                      (tenant_id, location_key, channel, thread_key, external_conversation_id,
                       language, state, last_inbound_at)
                    VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,NOW())
                    ON CONFLICT (tenant_id, location_key, channel, thread_key)
                    DO UPDATE SET external_conversation_id=COALESCE(EXCLUDED.external_conversation_id,
                                      luna_guest_conversations.external_conversation_id),
                                  language=EXCLUDED.language, last_inbound_at=NOW(), updated_at=NOW()
                    RETURNING id::text AS conversation_id
                    """,
                    req["tenant_id"], req["location_key"], req["channel"], thread_key,
                    req.get("conversation_id"), req.get("language") or "en",
                )
                event = await conn.fetchrow(
                    """
                    INSERT INTO luna_guest_inbound_events
                      (tenant_id, conversation_id, request_id, request_payload_hash, channel, body, status)
                    VALUES ($1,$2::uuid,$3,$4,$5,$6::jsonb,'queued')
                    RETURNING id::text AS inbound_event_id
                    """,
                    req["tenant_id"], conversation["conversation_id"], req["request_id"],
                    payload_hash, req["channel"], canonical,
                )
                await conn.execute(
                    "INSERT INTO luna_guest_work_queue (tenant_id, inbound_event_id, status) "
                    "VALUES ($1,$2::uuid,'queued')",
                    req["tenant_id"], event["inbound_event_id"],
                )
                return {
                    "duplicate": False,
                    "inbound_event_id": event["inbound_event_id"],
                    "conversation_id": conversation["conversation_id"],
                }
        finally:
            await conn.close()

    def complete_turn(self, context: dict[str, Any], payload: dict[str, Any],
                      gate_snapshot: dict[str, Any]) -> dict[str, Any]:
        return asyncio.run(self._complete_turn(context, payload, gate_snapshot))

    async def _complete_turn(self, context, payload, gate_snapshot):
        import asyncpg

        key = f"sunset-luna-http:{payload['request_id']}:reply:v1"
        status = "blocked" if gate_snapshot["live_send_blocked"] else "pending"
        conn = await asyncpg.connect(self.dsn)
        try:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE luna_guest_inbound_events
                       SET status='processed', gate_snapshot=$2::jsonb,
                           result=$3::jsonb, processed_at=NOW(), updated_at=NOW()
                     WHERE id=$1::uuid
                    """,
                    context["inbound_event_id"], json.dumps(gate_snapshot), json.dumps(payload),
                )
                await conn.execute(
                    "UPDATE luna_guest_work_queue SET status='completed', completed_at=NOW(), "
                    "updated_at=NOW() WHERE inbound_event_id=$1::uuid",
                    context["inbound_event_id"],
                )
                row = await conn.fetchrow(
                    """
                    INSERT INTO luna_guest_reply_outbox
                      (tenant_id, conversation_id, inbound_event_id, idempotency_key,
                       intended_reply, gate_snapshot, status, send_enabled)
                    VALUES ('sunset',$1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb,$6,FALSE)
                    ON CONFLICT (tenant_id, idempotency_key)
                    DO UPDATE SET updated_at=luna_guest_reply_outbox.updated_at
                    RETURNING id::text AS outbox_id, idempotency_key, status, send_enabled
                    """,
                    context["conversation_id"], context["inbound_event_id"], key,
                    json.dumps(payload), json.dumps(gate_snapshot), status,
                )
                await conn.execute(
                    "UPDATE luna_guest_conversations SET state=$2::jsonb, gate_snapshot=$3::jsonb, "
                    "updated_at=NOW() WHERE id=$1::uuid",
                    context["conversation_id"],
                    json.dumps({"last_request_id": payload["request_id"], "last_result": payload}),
                    json.dumps(gate_snapshot),
                )
                return dict(row)
        finally:
            await conn.close()
