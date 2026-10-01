#!/usr/bin/env bash
set -euo pipefail

cd /home/runner
rm -rf .runner .credentials .credentials_rsaparams _work _diag

if [ "${CFRUNNER_DOCKER:-false}" = "true" ]; then
  sudo mount -o remount,rw /proc/sys
  sudo sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  sudo rm -rf /var/run/docker.pid /var/run/docker.sock /var/run/docker /var/run/containerd
  sudo sh -c 'nohup dockerd > /var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

exec ./run.sh --jitconfig "${JITCONFIG:?JITCONFIG is required}"
