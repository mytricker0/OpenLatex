#!/usr/bin/env bash
# Install gVisor (runsc) and register it as a docker runtime.
# Run with: sudo bash develop/bin/install-gvisor.sh
# Idempotent-ish; restarts the docker daemon at the end.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (sudo bash $0)" >&2
  exit 1
fi

ARCH="$(uname -m)"
URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "==> downloading runsc + containerd shim for ${ARCH}"
wget -q "${URL}/runsc" "${URL}/runsc.sha512" \
        "${URL}/containerd-shim-runsc-v1" "${URL}/containerd-shim-runsc-v1.sha512"

echo "==> verifying checksums"
sha512sum -c runsc.sha512
sha512sum -c containerd-shim-runsc-v1.sha512

echo "==> installing to /usr/local/bin"
install -m 0755 -o root -g root runsc containerd-shim-runsc-v1 /usr/local/bin/

echo "==> registering runsc runtime with docker (runsc install)"
/usr/local/bin/runsc install

echo "==> restarting docker daemon"
systemctl restart docker

echo "==> done. Verify with: docker info | grep -iA3 Runtimes"
