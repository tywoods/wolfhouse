FROM docker.io/nousresearch/hermes-agent:latest
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
