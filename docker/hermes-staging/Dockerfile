# Back on latest (v2026.6.5 was too old for our gateway patches → container
# wouldn't start). The 2026-06-15 latest ships gpt-5.5 auto-compaction; we disable
# it via config (compression.codex_gpt55_autoraise: false) instead of downgrading.
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
COPY plugins /etc/hermes-staging/plugins
COPY wolfhouse_whatsapp_mirror.py /etc/hermes-staging/wolfhouse_whatsapp_mirror.py
COPY wolfhouse_guest_fresh_start.py /etc/hermes-staging/wolfhouse_guest_fresh_start.py
COPY wolfhouse /etc/hermes-staging/wolfhouse
COPY apply_gateway_patches.py /etc/hermes-staging/apply_gateway_patches.py
COPY verify_plain_reply_patches.py /etc/hermes-staging/verify_plain_reply_patches.py
COPY apply_whatsapp_fresh_start_route.py /etc/hermes-staging/apply_whatsapp_fresh_start_route.py
COPY apply_whatsapp_simulate_route.py /etc/hermes-staging/apply_whatsapp_simulate_route.py
COPY apply_stt_patches.py /etc/hermes-staging/apply_stt_patches.py
COPY apply_guest_send_guard_patches.py /etc/hermes-staging/apply_guest_send_guard_patches.py
COPY verify_stt_patches.py /etc/hermes-staging/verify_stt_patches.py
COPY verify_guest_send_guard_patches.py /etc/hermes-staging/verify_guest_send_guard_patches.py
COPY bootstrap.sh /etc/hermes-staging/bootstrap.sh
COPY bootstrap.sh /etc/cont-init.d/99-wh-staging-bootstrap
RUN sed -i 's/\r$//' /etc/cont-init.d/99-wh-staging-bootstrap \
 && chmod +x /etc/cont-init.d/99-wh-staging-bootstrap \
 && python /etc/hermes-staging/apply_stt_patches.py \
 && python /etc/hermes-staging/apply_gateway_patches.py \
 && python /etc/hermes-staging/apply_guest_send_guard_patches.py \
 && python /etc/hermes-staging/verify_stt_patches.py \
 && python /etc/hermes-staging/verify_guest_send_guard_patches.py \
 && python /etc/hermes-staging/verify_plain_reply_patches.py
