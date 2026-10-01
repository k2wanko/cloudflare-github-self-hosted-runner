FROM ghcr.io/actions/actions-runner:2.337.0

ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache
ENV AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache

RUN sudo mkdir -p /opt/hostedtoolcache && sudo chown runner:runner /opt/hostedtoolcache

RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends iptables && sudo rm -rf /var/lib/apt/lists/*

COPY --chown=runner:runner start.sh /home/runner/start.sh
RUN chmod +x /home/runner/start.sh

ENTRYPOINT ["/home/runner/start.sh"]
