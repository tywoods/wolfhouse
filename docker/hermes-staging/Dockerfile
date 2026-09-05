# Pinned to the 2026-06-15 latest digest (gpt-5.5 auto-compaction, disabled via
# config compression.codex_gpt55_autoraise:false). This is the digest commit 8d6bc81
# re-anchored the guard patches against; floating :latest drifted upstream and broke
# apply_guest_send_guard_patches (run.approval_guard anchor not found), so we pin it.
FROM docker.io/nousresearch/hermes-agent@sha256:7ad6ac6479ca777f2b44c2f703f74dcf3468d913a5b3aa174746a3260e18cc31
ENV PYTHONPATH=/etc/hermes-staging

# Slim inherited Hermes image: drop uv/pip caches and dev-only Node deps (~500MB+).
RUN rm -rf /root/.cache/uv /root/.cache/pip \
    /home/hermes/.cache/uv /home/hermes/.cache/pip 2>/dev/null || true \
 && cd /opt/hermes \
 && npm prune --omit=dev \
 && cd /opt/hermes/ui-tui \
 && npm prune --omit=dev

COPY SOUL.md /etc/hermes-staging/SOUL.md
COPY orchestrator-SOUL.md /etc/hermes-staging/orchestrator-SOUL.md
COPY deckhand-SOUL.md /etc/hermes-staging/deckhand-SOUL.md
COPY seadog-SOUL.md /etc/hermes-staging/seadog-SOUL.md
COPY plugins /etc/hermes-staging/plugins
COPY wolfhouse_whatsapp_mirror.py /etc/hermes-staging/wolfhouse_whatsapp_mirror.py
COPY wolfhouse_guest_fresh_start.py /etc/hermes-staging/wolfhouse_guest_fresh_start.py
COPY wolfhouse /etc/hermes-staging/wolfhouse
# Canonical bytes: fixtures/luna-personality-corpus.json. This context is
# docker/hermes-staging (not repo root). Keep the two files byte-identical.
COPY fixtures/luna-personality-corpus.json /etc/hermes-staging/fixtures/luna-personality-corpus.json
COPY apply_gateway_patches.py /etc/hermes-staging/apply_gateway_patches.py
COPY sunset_tenant_routing.py /etc/hermes-staging/sunset_tenant_routing.py
COPY verify_plain_reply_patches.py /etc/hermes-staging/verify_plain_reply_patches.py
COPY apply_whatsapp_fresh_start_route.py /etc/hermes-staging/apply_whatsapp_fresh_start_route.py
COPY apply_whatsapp_simulate_route.py /etc/hermes-staging/apply_whatsapp_simulate_route.py
COPY apply_stt_patches.py /etc/hermes-staging/apply_stt_patches.py
COPY apply_guest_send_guard_patches.py /etc/hermes-staging/apply_guest_send_guard_patches.py
COPY apply_crowsnest_ai_usage_patch.py /etc/hermes-staging/apply_crowsnest_ai_usage_patch.py
COPY apply_water_cooler_a2a_adapter_patch.py /etc/hermes-staging/apply_water_cooler_a2a_adapter_patch.py
COPY apply_discord_bot_wake_patch.py /etc/hermes-staging/apply_discord_bot_wake_patch.py
COPY test_crowsnest_ai_usage_patch.py /etc/hermes-staging/test_crowsnest_ai_usage_patch.py
COPY verify_stt_patches.py /etc/hermes-staging/verify_stt_patches.py
COPY verify_guest_send_guard_patches.py /etc/hermes-staging/verify_guest_send_guard_patches.py
COPY verify_gateway_patch_idempotency.py /etc/hermes-staging/verify_gateway_patch_idempotency.py
COPY verify_discord_session_continuity.py /etc/hermes-staging/verify_discord_session_continuity.py
COPY verify_wolfhouse_luna_instance.py /etc/hermes-staging/verify_wolfhouse_luna_instance.py
COPY verify_deckhand_instance.py /etc/hermes-staging/verify_deckhand_instance.py
COPY verify_water_cooler_a2a_pilot.py /etc/hermes-staging/verify_water_cooler_a2a_pilot.py
COPY docker-compose.vm.yml /etc/hermes-staging/docker-compose.vm.yml
COPY lunabox-caddyfile.reference /etc/hermes-staging/lunabox-caddyfile.reference
COPY bootstrap.sh /etc/hermes-staging/bootstrap.sh
COPY bootstrap.sh /etc/cont-init.d/99-wh-staging-bootstrap
RUN sed -i 's/\r$//' /etc/cont-init.d/99-wh-staging-bootstrap \
 && chmod +x /etc/cont-init.d/99-wh-staging-bootstrap \
 && python /etc/hermes-staging/apply_stt_patches.py \
 && python /etc/hermes-staging/apply_gateway_patches.py \
 && python /etc/hermes-staging/apply_guest_send_guard_patches.py \
 && python /etc/hermes-staging/verify_stt_patches.py \
 && python /etc/hermes-staging/verify_guest_send_guard_patches.py \
 && python /etc/hermes-staging/verify_plain_reply_patches.py \
 && python /etc/hermes-staging/verify_gateway_patch_idempotency.py \
 && python /etc/hermes-staging/verify_discord_session_continuity.py \
 && python -c "import asyncpg" \
 && python /etc/hermes-staging/verify_wolfhouse_luna_instance.py \
 && cd /etc/hermes-staging \
 && python -m unittest wolfhouse.test_crowsnest_ai_usage_reporter test_crowsnest_ai_usage_patch wolfhouse.test_discord_bot_wake wolfhouse.test_discord_bot_wake_patch -v \
 && python /etc/hermes-staging/apply_crowsnest_ai_usage_patch.py \
 && python /etc/hermes-staging/apply_crowsnest_ai_usage_patch.py
# NOTE: Water-cooler A2A adapter patch is intentionally NOT applied at image
# build. Bootstrap applies it only when HERMES_ROLE is seadog|deckhand and
# WATER_COOLER_A2A_ENABLED=true (fail-closed default off for all roles).
# Discord bot-wake watch-list patch is also NOT applied at image build — it
# mutates the same allow_bots admission seam A2A validates. Bootstrap applies
# it only for HERMES_ROLE=orchestrator (Skipper / Chief of Staff wake).
