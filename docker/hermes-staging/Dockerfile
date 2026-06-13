FROM docker.io/nousresearch/hermes-agent:latest
COPY bootstrap.sh /etc/cont-init.d/99-wh-staging-bootstrap
RUN sed -i 's/\r$//' /etc/cont-init.d/99-wh-staging-bootstrap \
 && chmod +x /etc/cont-init.d/99-wh-staging-bootstrap
