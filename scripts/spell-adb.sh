#!/usr/bin/env bash
# spell-adb.sh
#
# Set up ADB reverse port-forwarding so the Android Spell app can reach
# the coding-agent WebSocket server running on the dev machine.
#
# Usage:
#   ./scripts/spell-adb.sh [PORT]
#
# PORT defaults to 9473 (the default QmlRemoteServer port).
#
# For USB-tethered devices:
#   This uses `adb reverse` to forward device:PORT → host:PORT.
#   The app connects to ws://localhost:PORT/ws and reaches the server.
#
# For WiFi (no USB):
#   Run the server, find your machine's LAN IP, and point the app at:
#     ws://<LAN_IP>:PORT/ws
#   via: adb shell am start -a android.intent.action.MAIN \
#           -n io.ohmypi.spell/.MainActivity \
#           --es url ws://192.168.x.x:9473/ws

set -euo pipefail

PORT="${1:-9473}"

if ! command -v adb &>/dev/null; then
    echo "error: adb not found in PATH" >&2
    exit 1
fi

DEVICES=$(adb devices | tail -n +2 | grep -v '^$' | grep -v 'offline')
if [ -z "$DEVICES" ]; then
    echo "error: no ADB devices connected" >&2
    exit 1
fi

echo "Setting up reverse port-forward: device:${PORT} -> host:${PORT}"
adb reverse "tcp:${PORT}" "tcp:${PORT}"
echo "Done. Start the Spell app — it will connect to ws://localhost:${PORT}/ws"
