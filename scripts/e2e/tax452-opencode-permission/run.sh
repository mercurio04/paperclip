#!/usr/bin/env bash
# Isolated E2E for the TAX-452 OpenCode permission bridge.
#
# Runs a throwaway Paperclip (own HOME, PAPERCLIP_HOME, instance, embedded
# Postgres) + real OpenCode 1.18.29 (restricted_v1) + a deterministic
# OpenAI-compatible fixture provider, all inside new user/net/mount
# namespaces: loopback only (zero egress) and a private tmpfs /tmp so nothing
# can touch a Postgres socket or lock file of a real instance on the host.
#
# Usage: scripts/e2e/tax452-opencode-permission/run.sh [OUT_DIR]
# Requires: built paperclip-runnerd (runner/target/release), built runner
# dist, built plugin-sdk, util-linux unshare, iproute2.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
OUT=${1:-$ROOT/.e2e/runs/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
NODE_BIN=$(dirname "$(readlink -f "$(command -v node)")")
exec unshare --user --map-root-user --net --mount --pid --fork --propagation private \
  bash "$HERE/ns-inner.sh" "$ROOT" "$OUT" "$NODE_BIN"
