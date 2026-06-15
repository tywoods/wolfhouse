# Pinned to the last stable release (2026-06-06). The `latest`/`main` tag was
# republished 2026-06-15 with a gpt-5.5 auto-compaction change that summarized
# Luna's SOUL out of context (terse, personality-stripped, rule-ignoring). Pinning
# keeps the engine reproducible so a moving `latest` can't silently swap it under
# us. Bump this deliberately after testing a newer release.
FROM docker.io/nousresearch/hermes-agent:v2026.6.5
COPY SOUL.md /etc/hermes-staging/SOUL.md
COPY orchestrator-SOUL.md /etc/hermes-staging/orchestrator-SOUL.md
COPY plugins /etc/hermes-staging/plugins
COPY wolfhouse_whatsapp_mirror.py /etc/hermes-staging/wolfhouse_whatsapp_mirror.py
COPY wolfhouse_guest_fresh_start.py /etc/hermes-staging/wolfhouse_guest_fresh_start.py
COPY apply_gateway_patches.py /etc/hermes-staging/apply_gateway_patches.py
COPY apply_whatsapp_fresh_start_route.py /etc/hermes-staging/apply_whatsapp_fresh_start_route.py
COPY bootstrap.sh /etc/cont-init.d/99-wh-staging-bootstrap
RUN sed -i 's/\r$//' /etc/cont-init.d/99-wh-staging-bootstrap \
 && chmod +x /etc/cont-init.d/99-wh-staging-bootstrap
