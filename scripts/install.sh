#!/usr/bin/env bash
# Cloud Code CLI installer.
#
#   curl -fsSL https://raw.githubusercontent.com/cloud-teahouse/cloud-code/dev/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/cloud-teahouse/cloud-code/dev/scripts/install.sh | bash -s -- --channel=beta
#
# Channels:
#   release (default) — newest stable GitHub Release.
#   beta              — the rolling `beta` pre-release CI keeps current.
#   dev               — internal CI artifacts only; politely refused.
#
# The binary is verified against the release's sha256sums.txt and installed
# to ~/.local/bin (or /usr/local/bin when running as root) as `cloudcode`,
# with a `cloud-code` symlink next to it.
#
# Tests source this file with INSTALL_SH_SOURCE_ONLY=1 to exercise the pure
# functions (asset_name / release_base_url) without touching the network.
set -euo pipefail

REPO="cloud-teahouse/cloud-code"
APP_NAME="cloudcode"
ALIAS_NAME="cloud-code"

# Map `uname -s`/`uname -m` (lowercased by the caller) to a release asset name.
asset_name() {
  case "$1/$2" in
    linux/x86_64 | linux/amd64) echo "cloud-code-linux-x64" ;;
    linux/aarch64 | linux/arm64) echo "cloud-code-linux-arm64" ;;
    darwin/x86_64) echo "cloud-code-darwin-x64" ;;
    darwin/arm64 | darwin/aarch64) echo "cloud-code-darwin-arm64" ;;
    *) return 1 ;;
  esac
}

# Base URL holding the channel's assets. `latest/download` follows the newest
# stable release; the beta channel is one rolling pre-release under the fixed
# `beta` tag. dev has no published source — caller must refuse before this.
release_base_url() {
  case "$1" in
    release) echo "https://github.com/${REPO}/releases/latest/download" ;;
    beta) echo "https://github.com/${REPO}/releases/download/beta" ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<'EOF'
Usage: install.sh [--channel=release|beta]

  --channel=release   Install the newest stable release (default).
  --channel=beta      Install the rolling beta build.
  --channel=dev       Not supported: dev builds are internal CI artifacts.
  -h, --help          Show this help.
EOF
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "install.sh: need sha256sum or shasum to verify the download" >&2
    return 1
  fi
}

main() {
  local channel="release"
  while [ $# -gt 0 ]; do
    case "$1" in
      --channel=*) channel="${1#--channel=}" ;;
      --channel)
        shift
        [ $# -gt 0 ] || { echo "install.sh: --channel needs a value" >&2; usage >&2; exit 2; }
        channel="$1"
        ;;
      -h | --help) usage; exit 0 ;;
      *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done

  case "$channel" in
    release | beta) ;;
    dev)
      echo "install.sh: dev builds are internal CI artifacts and are not published." >&2
      echo "Grab the artifact from the CI run, or install the release/beta channel instead." >&2
      exit 1
      ;;
    *)
      echo "install.sh: unknown channel: $channel (expected release or beta)" >&2
      exit 2
      ;;
  esac

  local os arch asset
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m | tr '[:upper:]' '[:lower:]')"
  if ! asset="$(asset_name "$os" "$arch")"; then
    echo "install.sh: no prebuilt binary for ${os}/${arch} — build from source (on Windows, use WSL)." >&2
    exit 1
  fi

  local base tmp
  base="$(release_base_url "$channel")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "install.sh: downloading ${asset} (${channel} channel)…"
  curl -fsSL "${base}/sha256sums.txt" -o "${tmp}/sha256sums.txt"
  curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}"

  local expected actual
  expected="$(awk -v n="$asset" '$2 == n {print $1}' "${tmp}/sha256sums.txt")"
  [ -n "$expected" ] || {
    echo "install.sh: ${asset} missing from sha256sums.txt — the ${channel} release may still be uploading." >&2
    exit 1
  }
  actual="$(sha256_of "${tmp}/${asset}")"
  if [ "$actual" != "$expected" ]; then
    echo "install.sh: sha256 mismatch for ${asset} (expected ${expected}, got ${actual}) — refusing to install." >&2
    exit 1
  fi

  local dest
  if [ "$(id -u)" -eq 0 ]; then
    dest="/usr/local/bin"
  else
    dest="${HOME}/.local/bin"
  fi
  mkdir -p "$dest"
  mv "${tmp}/${asset}" "${dest}/${APP_NAME}"
  chmod 0755 "${dest}/${APP_NAME}"
  ln -sf "${APP_NAME}" "${dest}/${ALIAS_NAME}"

  echo "install.sh: installed ${dest}/${APP_NAME} (sha256 verified, ${channel} channel)."
  case ":${PATH}:" in
    *":${dest}:"*) ;;
    *) echo "install.sh: note — ${dest} is not on your PATH; add it to use ${APP_NAME}." ;;
  esac
  "${dest}/${APP_NAME}" --version || true
}

if [ "${INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
