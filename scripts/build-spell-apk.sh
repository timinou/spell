#!/usr/bin/env bash
# Build the Spell Android APK and install it to ~/.omp/tools/spell.apk
# so that the omp agent can deploy it automatically via `qml launch`.
#
# Requirements (one-time setup):
#   1. Android SDK — already present if you have Android Studio.
#      Default location: ~/Android/Sdk
#   2. Android NDK 27+ — install from Android Studio → SDK Manager → SDK Tools.
#   3. Qt 6 for Android (arm64-v8a) — from Qt Online Installer:
#      https://download.qt.io/official_releases/online_installers/
#      Select: Qt 6.8 → Android ARM64-v8a (untick everything else)
#      Default install location: ~/Qt
#
# Environment overrides:
#   ANDROID_SDK_ROOT   — path to Android SDK      (default: ~/Android/Sdk)
#   ANDROID_NDK_ROOT   — path to Android NDK dir  (auto-detected from SDK)
#   QT_ANDROID_ROOT    — path to Qt arm64-v8a dir  (auto-detected from ~/Qt)
#   BUILD_TYPE         — Debug or Release          (default: Debug)
#   OUTPUT_APK         — destination path          (default: ~/.omp/tools/spell.apk)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/spell"
BUILD_TYPE="${BUILD_TYPE:-Debug}"
OUTPUT_APK="${OUTPUT_APK:-$HOME/.omp/tools/spell.apk}"

# ── Locate Android SDK ────────────────────────────────────────────────────────

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
if [[ ! -d "$ANDROID_SDK_ROOT" ]]; then
  echo "error: Android SDK not found at $ANDROID_SDK_ROOT"
  echo "  Install Android Studio or set ANDROID_SDK_ROOT"
  exit 1
fi

# ── Locate Android NDK ────────────────────────────────────────────────────────

if [[ -z "${ANDROID_NDK_ROOT:-}" ]]; then
  # Pick the highest available NDK version
  NDK_BASE="$ANDROID_SDK_ROOT/ndk"
  if [[ ! -d "$NDK_BASE" ]]; then
    echo "error: No NDK found under $NDK_BASE"
    echo "  Install NDK 27+ via Android Studio → SDK Manager → SDK Tools"
    exit 1
  fi
  ANDROID_NDK_ROOT="$(ls -d "$NDK_BASE"/*/ 2>/dev/null | sort -V | tail -1)"
  ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT%/}"
fi
if [[ ! -f "$ANDROID_NDK_ROOT/source.properties" ]]; then
  echo "error: NDK not found at $ANDROID_NDK_ROOT"
  exit 1
fi
NDK_VER="$(grep "Pkg.Revision" "$ANDROID_NDK_ROOT/source.properties" | cut -d= -f2 | tr -d ' ')"
echo "NDK: $ANDROID_NDK_ROOT  ($NDK_VER)"

# ── Locate Qt for Android arm64-v8a ───────────────────────────────────────────

if [[ -z "${QT_ANDROID_ROOT:-}" ]]; then
  # Walk ~/Qt/<version>/android_arm64_v8a
  QT_ANDROID_ROOT="$(find "$HOME/Qt" -maxdepth 2 -type d -name "android_arm64_v8a" 2>/dev/null \
    | sort -V | tail -1)"
fi
if [[ -z "$QT_ANDROID_ROOT" || ! -f "$QT_ANDROID_ROOT/bin/qt-cmake" ]]; then
  echo "error: Qt 6 for Android (arm64-v8a) not found"
  echo
  echo "  Install via Qt Online Installer:"
  echo "    https://download.qt.io/official_releases/online_installers/qt-online-installer-linux-x64-online.run"
  echo "  Select: Qt 6.8 → Android ARM64-v8a"
  echo "  Then re-run this script, or set QT_ANDROID_ROOT explicitly."
  exit 1
fi
QT_VER="$(basename "$(dirname "$QT_ANDROID_ROOT")")"
echo "Qt:  $QT_ANDROID_ROOT  ($QT_VER)"
echo "SDK: $ANDROID_SDK_ROOT"
echo

# ── Configure ─────────────────────────────────────────────────────────────────

BUILD_DIR="$APP_DIR/build-android"
echo "Configuring in $BUILD_DIR ..."
"$QT_ANDROID_ROOT/bin/qt-cmake" \
  -S "$APP_DIR" \
  -B "$BUILD_DIR" \
  -DANDROID_SDK_ROOT="$ANDROID_SDK_ROOT" \
  -DANDROID_NDK_ROOT="$ANDROID_NDK_ROOT" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -G Ninja

# ── Build ─────────────────────────────────────────────────────────────────────

echo
echo "Building APK (this takes a minute on first run)..."
cmake --build "$BUILD_DIR" --target apk

# ── Find and copy the APK ──────────────────────────────────────────────────────

APK_PATH="$(find "$BUILD_DIR" -name "*.apk" -not -path "*unaligned*" \
  | sort -V | tail -1)"
if [[ -z "$APK_PATH" ]]; then
  echo "error: APK not found under $BUILD_DIR after build"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_APK")"
cp "$APK_PATH" "$OUTPUT_APK"
echo
echo "APK installed to: $OUTPUT_APK"
echo "Run 'qml launch' in the agent to deploy it to your phone."
