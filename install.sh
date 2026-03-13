#!/usr/bin/env bash
# install.sh — Spell coding agent installer
# Usage: curl -fsSL https://raw.githubusercontent.com/timinou/spell/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/timinou/spell"
DEST="$HOME/.local/spell"

# ── Colors ────────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

header()  { echo -e "\n${CYAN}${BOLD}==> $*${RESET}"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $*"; }
die()     { echo -e "  ${RED}✗ $*${RESET}" >&2; exit 1; }

# ── 1. Detect OS ──────────────────────────────────────────────────────────────
header "Detecting platform"

OS=""
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)
    if [ -f /etc/os-release ]; then
      # shellcheck source=/dev/null
      . /etc/os-release
      case "${ID:-}" in
        arch|manjaro|endeavouros) OS="arch" ;;
        ubuntu|debian|linuxmint|pop)  OS="ubuntu" ;;
        *) die "Unsupported Linux distro: ${ID:-unknown}. Supported: Arch, Ubuntu/Debian." ;;
      esac
    else
      die "Cannot detect Linux distro (/etc/os-release missing)."
    fi
    ;;
  *) die "Unsupported OS: $(uname -s). Supported: macOS, Arch Linux, Ubuntu/Debian." ;;
esac

ARCH="$(uname -m)"
ok "OS: $OS  arch: $ARCH"

# ── 2. System dependencies ────────────────────────────────────────────────────
header "Checking system dependencies"

install_system_deps() {
  case "$OS" in
    arch)
      ok "Installing base-devel git curl via pacman (sudo required)"
      sudo pacman -S --needed --noconfirm base-devel git curl
      ;;
    ubuntu)
      ok "Installing build-essential git curl via apt (sudo required)"
      sudo apt-get update -qq
      sudo apt-get install -y build-essential git curl pkg-config libssl-dev
      ;;
    macos)
      if ! xcode-select -p &>/dev/null; then
        die "Xcode Command Line Tools required. Run: xcode-select --install  then re-run this script."
      fi
      ok "Xcode CLT present"
      ;;
  esac
}

need_sys_deps=false
command -v git  &>/dev/null || need_sys_deps=true
command -v curl &>/dev/null || need_sys_deps=true
if [ "$OS" = "ubuntu" ]; then
  command -v pkg-config &>/dev/null || need_sys_deps=true
fi

if $need_sys_deps; then
  install_system_deps
else
  ok "System deps already present"
fi

# ── 3. Bun ────────────────────────────────────────────────────────────────────
header "Checking Bun"

if ! command -v bun &>/dev/null; then
  ok "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  # Source the env injected by the Bun installer
  BUN_ENV="$HOME/.bun/env"
  [ -f "$BUN_ENV" ] && source "$BUN_ENV"
  export PATH="$HOME/.bun/bin:$PATH"
else
  ok "Bun $(bun --version) already installed"
fi

command -v bun &>/dev/null || die "Bun not found on PATH after install. Open a new shell and re-run."

# ── 4. Rust ───────────────────────────────────────────────────────────────────
header "Checking Rust"

if ! command -v cargo &>/dev/null; then
  ok "Installing Rust via rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  source "$HOME/.cargo/env"
  export PATH="$HOME/.cargo/bin:$PATH"
else
  ok "Rust $(rustc --version) already installed"
fi

command -v cargo &>/dev/null || die "cargo not found on PATH after install. Open a new shell and re-run."

# ── 5. Clone or update repo ───────────────────────────────────────────────────
header "Fetching Spell source"

if [ -d "$DEST/.git" ]; then
  ok "Repo exists — pulling latest"
  git -C "$DEST" pull --ff-only
else
  ok "Cloning $REPO → $DEST"
  git clone "$REPO" "$DEST"
fi

# ── 6. Build ──────────────────────────────────────────────────────────────────
header "Building Spell"

cd "$DEST"

ok "Installing JS dependencies"
bun install --frozen-lockfile

ok "Building native extensions (Rust)"
bun run build:native

ok "Linking spell CLI"
bun run install:dev

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Spell installed successfully.${RESET}"
echo ""
echo -e "  Run ${CYAN}spell --help${RESET} to get started."
echo -e "  Source your shell rc or open a new terminal if 'spell' is not found."
echo ""
