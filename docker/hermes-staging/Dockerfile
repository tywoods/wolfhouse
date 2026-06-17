# Back on latest (v2026.6.5 was too old for our gateway patches → container
# wouldn't start). The 2026-06-15 latest ships gpt-5.5 auto-compaction; we disable
# it via config (compression.codex_gpt55_autoraise: false) instead of downgrading.
FROM docker.io/nousresearch/hermes-agent:latest
ENV PYTHONPATH=/etc/hermes-staging
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
COPY bootstrap.sh /etc/cont-init.d/99-wh-staging-bootstrap
RUN sed -i 's/\r$//' /etc/cont-init.d/99-wh-staging-bootstrap \
 && chmod +x /etc/cont-init.d/99-wh-staging-bootstrap
