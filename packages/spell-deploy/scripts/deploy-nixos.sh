#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${1:?Usage: deploy-nixos.sh <host> [user]}"
REMOTE_USER="${2:-root}"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
NIX_CONFIG_DIR="${SCRIPT_DIR}/../nix"
REMOTE_NIX_DIR="/etc/nixos/spell-server"

echo "Deploying NixOS config to ${REMOTE_USER}@${REMOTE_HOST}..."

ssh "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${REMOTE_NIX_DIR}"
scp "${NIX_CONFIG_DIR}/module.nix" "${NIX_CONFIG_DIR}/example-configuration.nix" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_NIX_DIR}/"

ssh "${REMOTE_USER}@${REMOTE_HOST}" 'sudo nixos-rebuild switch'

echo "Done. Import ${REMOTE_NIX_DIR}/example-configuration.nix from configuration.nix if not already configured."
echo "Verify with: ssh ${REMOTE_USER}@${REMOTE_HOST} systemctl status spell-*"
