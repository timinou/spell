#!/usr/bin/env bash
# Build the Spell Android APK and place it at ~/.spell/tools/spell.apk
# so the spell agent can deploy it automatically via `qml launch`.
#
# Run with no arguments for an interactive setup wizard.
# All paths are overridable via environment variables:
#   ANDROID_SDK_ROOT   default: ~/Android/Sdk
#   ANDROID_NDK_ROOT   default: auto-detected from SDK
#   QT_ANDROID_ROOT    default: auto-detected from ~/Qt
#   QT_VERSION         default: 6.8.3
#   BUILD_TYPE         default: Debug
#   OUTPUT_APK         default: ~/.spell/tools/spell.apk

set -euo pipefail

# ── colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YEL='\033[0;33m'; GRN='\033[0;32m'
BLU='\033[0;34m'; CYN='\033[0;36m'; DIM='\033[2m'; RST='\033[0m'
BOLD='\033[1m'

ok()   { echo -e "  ${GRN}✓${RST} $*"; }
fail() { echo -e "  ${RED}✗${RST} $*"; }
info() { echo -e "  ${BLU}·${RST} $*"; }
warn() { echo -e "  ${YEL}!${RST} $*"; }
die()  { echo -e "\n${RED}${BOLD}error:${RST} $*\n" >&2; exit 1; }
hdr()  { echo -e "\n${BOLD}${CYN}$*${RST}"; }
ask()  {
  local prompt="$1" default="${2:-}"
  local hint=""
  [[ -n "$default" ]] && hint=" ${DIM}[$default]${RST}"
  echo -en "  ${YEL}?${RST} ${prompt}${hint} "
  REPLY=""
  read -r REPLY || true
  [[ -z "$REPLY" ]] && REPLY="$default"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/spell"
QT_VERSION="${QT_VERSION:-6.8.3}"
BUILD_TYPE="${BUILD_TYPE:-Debug}"
OUTPUT_APK="${OUTPUT_APK:-$HOME/.spell/tools/spell.apk}"

echo -e "\n${BOLD}Spell APK build wizard${RST}"
echo -e "${DIM}Builds apps/spell for Android arm64-v8a and installs to${RST}"
echo -e "${DIM}  $OUTPUT_APK${RST}\n"

# ── 1. Android SDK ────────────────────────────────────────────────────────────
hdr "1/4  Android SDK"

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
if [[ -d "$ANDROID_SDK_ROOT/platform-tools" ]]; then
  ok "SDK found: $ANDROID_SDK_ROOT"
else
  fail "SDK not found at $ANDROID_SDK_ROOT"
  echo
  echo -e "  Install Android Studio from ${BLU}https://developer.android.com/studio${RST}"
  echo -e "  or set ${CYN}ANDROID_SDK_ROOT${RST} to an existing SDK path."
  ask "Path to Android SDK:" "$HOME/Android/Sdk"
  ANDROID_SDK_ROOT="$REPLY"
  [[ -d "$ANDROID_SDK_ROOT/platform-tools" ]] \
    || die "Still not found at $ANDROID_SDK_ROOT. Install Android Studio first."
  ok "SDK found: $ANDROID_SDK_ROOT"
fi

# ── 2. Android NDK ────────────────────────────────────────────────────────────
hdr "2/4  Android NDK"

if [[ -z "${ANDROID_NDK_ROOT:-}" ]]; then
  NDK_BASE="$ANDROID_SDK_ROOT/ndk"
  ANDROID_NDK_ROOT="$(ls -d "$NDK_BASE"/*/ 2>/dev/null | sort -V | tail -1)"
  ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT%/}"
fi

if [[ -f "${ANDROID_NDK_ROOT:-}/source.properties" ]]; then
  NDK_VER="$(grep "Pkg.Revision" "$ANDROID_NDK_ROOT/source.properties" | cut -d= -f2 | tr -d ' ')"
  ok "NDK $NDK_VER: $ANDROID_NDK_ROOT"
else
  fail "NDK not found"
  echo
  echo -e "  Install NDK 27+ via Android Studio:"
  echo -e "    ${DIM}Settings → SDK Manager → SDK Tools → NDK (Side by side)${RST}"
  echo
  echo -e "  Or via sdkmanager on the command line:"
  echo -e "    ${DIM}$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager \"ndk;27.0.12077973\"${RST}"
  echo
  ask "Path to NDK directory (leave blank to abort):" ""
  [[ -n "$REPLY" ]] || die "NDK is required to build for Android."
  ANDROID_NDK_ROOT="$REPLY"
  [[ -f "$ANDROID_NDK_ROOT/source.properties" ]] \
    || die "NDK not found at $ANDROID_NDK_ROOT"
  NDK_VER="$(grep "Pkg.Revision" "$ANDROID_NDK_ROOT/source.properties" | cut -d= -f2 | tr -d ' ')"
  ok "NDK $NDK_VER: $ANDROID_NDK_ROOT"
fi

# ── 3. Qt 6 for Android (arm64-v8a) ──────────────────────────────────────────
hdr "3/4  Qt $QT_VERSION for Android arm64-v8a"

locate_qt() {
  [[ -d "$HOME/Qt" ]] || return 0
  find "$HOME/Qt" -maxdepth 2 -type d -name "android_arm64_v8a" 2>/dev/null \
    | sort -V | tail -1
}

if [[ -z "${QT_ANDROID_ROOT:-}" ]]; then
  QT_ANDROID_ROOT="$(locate_qt || true)"
fi

if [[ -n "$QT_ANDROID_ROOT" && -f "$QT_ANDROID_ROOT/bin/qt-cmake" ]]; then
  QT_VER_FOUND="$(basename "$(dirname "$QT_ANDROID_ROOT")")"
  ok "Qt $QT_VER_FOUND arm64-v8a: $QT_ANDROID_ROOT"
else
  fail "Qt for Android arm64-v8a not found"
  echo
  echo -e "  The easiest way to install it is via ${CYN}aqtinstall${RST} — a Python tool"
  echo -e "  that downloads Qt without needing the official installer or a Qt account."
  echo

  # Check / install aqtinstall
  if python3 -c "import aqt" 2>/dev/null; then
    ok "aqtinstall already installed"
  else
    info "aqtinstall not found"
    ask "Install aqtinstall via pip? (y/n)" "y"
    if [[ "$REPLY" =~ ^[Yy] ]]; then
      echo
      pip3 install aqtinstall --quiet
      ok "aqtinstall installed"
    else
      echo
      echo -e "  Alternative: use the Qt Online Installer:"
      echo -e "    ${BLU}https://download.qt.io/official_releases/online_installers/${RST}"
      echo -e "  Select: Qt $QT_VERSION → Android ARM64-v8a"
      echo -e "  Then re-run this script."
      die "Qt for Android is required."
    fi
  fi

  # Find a suitable Qt version with aqt
  echo
  info "Finding available Qt versions for Android..."
  BEST_VER="$(python3 -m aqt list-qt linux android 2>/dev/null \
    | tr ' ' '\n' | grep "^6\." | sort -V | tail -1)"
  if [[ -z "$BEST_VER" ]]; then
    BEST_VER="$QT_VERSION"
    warn "Could not fetch version list; will try $BEST_VER"
  else
    info "Latest available: $BEST_VER"
  fi

  ask "Qt version to install:" "$BEST_VER"
  QT_VERSION="$REPLY"

  info "Checking available architectures for Qt $QT_VERSION..."
  ARCHES="$(python3 -m aqt list-qt linux android --arch "$QT_VERSION" 2>/dev/null || true)"
  if echo "$ARCHES" | grep -q "android_arm64_v8a"; then
    ok "android_arm64_v8a available"
  else
    warn "Arch list: ${ARCHES:-unknown}"
  fi

  QT_INSTALL_DIR="${QT_INSTALL_DIR:-$HOME/Qt}"
  ask "Install Qt to:" "$QT_INSTALL_DIR"
  QT_INSTALL_DIR="$REPLY"

  echo
  echo -e "  ${DIM}Running: python3 -m aqt install-qt linux android $QT_VERSION android_arm64_v8a -O $QT_INSTALL_DIR${RST}"
  echo -e "  ${DIM}(This downloads ~800 MB on first install — grab a coffee)${RST}"
  echo
  python3 -m aqt install-qt linux android "$QT_VERSION" android_arm64_v8a \
    -O "$QT_INSTALL_DIR"

  QT_ANDROID_ROOT="$(locate_qt)"
  [[ -n "$QT_ANDROID_ROOT" && -f "$QT_ANDROID_ROOT/bin/qt-cmake" ]] \
    || die "Qt installation succeeded but qt-cmake not found. Check $QT_INSTALL_DIR"
  QT_VER_FOUND="$(basename "$(dirname "$QT_ANDROID_ROOT")")"
  ok "Qt $QT_VER_FOUND arm64-v8a installed: $QT_ANDROID_ROOT"
fi

# ── 4. Build tools sanity check ───────────────────────────────────────────────
hdr "4/4  Build tools"

ALL_OK=1
for tool in cmake ninja java; do
  if which "$tool" &>/dev/null; then
    ok "$tool: $(which "$tool")"
  else
    fail "$tool not found in PATH"
    ALL_OK=0
  fi
done
[[ $ALL_OK -eq 1 ]] || die "Install missing tools above and re-run."

# ── Build ─────────────────────────────────────────────────────────────────────
hdr "Building"

BUILD_DIR="$APP_DIR/build-android"
echo -e "  ${DIM}Source:  $APP_DIR${RST}"
echo -e "  ${DIM}Output:  $BUILD_DIR${RST}"
echo -e "  ${DIM}APK:     $OUTPUT_APK${RST}"
echo

info "Configuring with qt-cmake..."
"$QT_ANDROID_ROOT/bin/qt-cmake" \
  -S "$APP_DIR" \
  -B "$BUILD_DIR" \
  -DANDROID_SDK_ROOT="$ANDROID_SDK_ROOT" \
  -DANDROID_NDK_ROOT="$ANDROID_NDK_ROOT" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -G Ninja \
  2>&1 | sed 's/^/    /'
ok "Configured"

echo
info "Building APK (slow on first run — compiling Qt deps)..."
cmake --build "$BUILD_DIR" --target apk 2>&1 | sed 's/^/    /'

APK_PATH="$(find "$BUILD_DIR" -name "*.apk" -not -path "*unaligned*" \
  | sort -V | tail -1)"
[[ -n "$APK_PATH" ]] || die "APK not found under $BUILD_DIR after build."

mkdir -p "$(dirname "$OUTPUT_APK")"
cp "$APK_PATH" "$OUTPUT_APK"

echo
echo -e "${BOLD}${GRN}Done.${RST}"
echo -e "  APK: ${CYN}$OUTPUT_APK${RST}"
echo -e "  Run ${CYN}qml launch${RST} in the agent to deploy it to your phone."
echo
