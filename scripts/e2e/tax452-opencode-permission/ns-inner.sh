#!/usr/bin/env bash
# Runs as uid 0 of a fresh user namespace (no host privilege).
set -euo pipefail
ROOT=$1 OUT=$2 NODE_BIN=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ip link set lo up
# An OUT under /tmp (e.g. a run scratch dir) would be hidden by the private
# tmpfs below; carry it across through a namespace-local bind mount so the
# receipt survives on the host.
case "$OUT" in
  /tmp/*) mount --bind "$OUT" /mnt; KEEP_OUT=1 ;;
  *) KEEP_OUT=0 ;;
esac
mount -t tmpfs -o mode=1777,size=512m tmpfs /tmp
if [ "$KEEP_OUT" = 1 ]; then mkdir -p "$OUT"; mount --bind /mnt "$OUT"; fi
# Own PID namespace: when this tree exits the kernel kills every leftover
# (e.g. a durable runnerd kept alive for restart recovery).
mount -t proc proc /proc
# Embedded Postgres refuses uid 0: drop to an unprivileged uid in a nested
# user namespace that keeps the same net/mount namespaces.
exec unshare --user --map-user=1000 --map-group=1000 \
  env -i PATH="$NODE_BIN:/usr/bin:/bin" LANG=C.UTF-8 \
  node "$HERE/driver.mjs" "$ROOT" "$OUT"
