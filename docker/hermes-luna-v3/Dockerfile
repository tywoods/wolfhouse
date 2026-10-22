FROM docker.io/nousresearch/hermes-agent@sha256:7ad6ac6479ca777f2b44c2f703f74dcf3468d913a5b3aa174746a3260e18cc31

ENV PYTHONPATH=/etc/hermes-luna-v3/plugins \
    HERMES_HOME=/opt/data \
    HERMES_ROLE=luna-v3 \
    HERMES_DASHBOARD=0

COPY SOUL.md /etc/hermes-luna-v3/SOUL.md
COPY plugins /etc/hermes-luna-v3/plugins
COPY bootstrap.py /etc/hermes-luna-v3/bootstrap.py
COPY bootstrap.sh /etc/cont-init.d/99-luna-v3-bootstrap
COPY runtime /etc/hermes-luna-v3/runtime
COPY install_simulator_route.py /etc/hermes-luna-v3/install_simulator_route.py
COPY tests /etc/hermes-luna-v3/tests

RUN chmod +x /etc/cont-init.d/99-luna-v3-bootstrap \
 && python /etc/hermes-luna-v3/install_simulator_route.py \
 && python /etc/hermes-luna-v3/install_simulator_route.py \
 && python /etc/hermes-luna-v3/plugins/luna_v3_staff_api/test_plugin.py -v \
 && python /etc/hermes-luna-v3/tests/test_install_simulator_route.py -v \
 && python /etc/hermes-luna-v3/tests/test_simulator_route.py -v

CMD ["gateway", "run"]
