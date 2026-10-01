#!/usr/bin/env bash
set -euo pipefail

cd /home/runner
rm -rf .runner .credentials .credentials_rsaparams _work _diag

exec ./run.sh --jitconfig "${JITCONFIG:?JITCONFIG is required}"
