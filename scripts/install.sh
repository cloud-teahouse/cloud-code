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
# The release's sha256sums.txt must carry a valid minisign signature from the
# key below before any checksum in it is believed; the binary is then verified
# against that checksum and installed to ~/.local/bin (or /usr/local/bin when
# running as root) as `cloudcode`, with a `cloud-code` symlink next to it.
#
# Tests source this file with INSTALL_SH_SOURCE_ONLY=1 to exercise the pure
# functions (asset_name / release_base_url / verify_signature) without
# touching the network.
set -euo pipefail

REPO="cloud-teahouse/cloud-code"
APP_NAME="cloudcode"
ALIAS_NAME="cloud-code"

# Trust root for releases — the same Ed25519 key as
# apps/cloud-code/src/cli/update/release-keys.ts and npm/minisign.mjs.
# Deliberately a literal: a key read from the environment or fetched at run
# time would be a key an attacker can choose.
RELEASE_SIGNING_PUBLIC_KEY="RWRSCedfeEAUBWZPDn2NRhR1Wgb+c3PvDMQYZOKXwpK37dzjBK+XxeZ+"

# Download scratch directory, cleaned up on exit. It has to be global: the EXIT
# trap runs after main() returns, so a `local` here would already be out of
# scope and `set -u` would abort the trap — leaving the directory behind and
# turning a successful install into a non-zero exit.
tmp=""
cleanup() {
  # `if` rather than `[ … ] && …` so an empty tmp is not a non-zero return
  # from the trap.
  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

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

# Verify the detached minisign signature $2 over file $1. minisign is used
# when the host has it; otherwise the Ed25519 check runs in python3, which is
# far more likely to already be installed. Without either the install stops —
# skipping the check would defeat the point of signing releases at all.
verify_signature() {
  local file="$1" sig="$2"
  if command -v minisign >/dev/null 2>&1; then
    minisign -V -q -m "$file" -x "$sig" -P "$RELEASE_SIGNING_PUBLIC_KEY" >/dev/null
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$sig" "$RELEASE_SIGNING_PUBLIC_KEY" <<'PY'
import base64, hashlib, sys

def die(message):
    sys.stderr.write("install.sh: " + message + "\n")
    raise SystemExit(1)

# RFC 8032 Ed25519 verification. Only ~50 lines of integer arithmetic, and it
# removes the need for an OpenSSL new enough to expose raw Ed25519.
P = 2 ** 255 - 19
D = -121665 * pow(121666, P - 2, P) % P
L = 2 ** 252 + 27742317777372353535851937790883648493

def recover_x(y, sign):
    if y >= P:
        return None
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    if xx == 0:
        return None if sign else 0
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * pow(2, (P - 1) // 4, P) % P
    if (x * x - xx) % P != 0:
        return None
    if (x & 1) != sign:
        x = P - x
    return x

def point_add(p1, p2):
    a = (p1[1] - p1[0]) * (p2[1] - p2[0]) % P
    b = (p1[1] + p1[0]) * (p2[1] + p2[0]) % P
    c = 2 * p1[3] * p2[3] * D % P
    dd = 2 * p1[2] * p2[2] % P
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)

def point_mul(scalar, point):
    acc = (0, 1, 1, 0)
    while scalar > 0:
        if scalar & 1:
            acc = point_add(acc, point)
        point = point_add(point, point)
        scalar >>= 1
    return acc

def point_equal(p1, p2):
    if (p1[0] * p2[2] - p2[0] * p1[2]) % P != 0:
        return False
    return (p1[1] * p2[2] - p2[1] * p1[2]) % P == 0

def decompress(data):
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)

BASE_Y = 4 * pow(5, P - 2, P) % P
BASE = (recover_x(BASE_Y, 0), BASE_Y, 1, recover_x(BASE_Y, 0) * BASE_Y % P)

def ed25519_verify(public, message, signature):
    if len(public) != 32 or len(signature) != 64:
        return False
    a = decompress(public)
    r = decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % L
    return point_equal(point_mul(s, BASE), point_add(r, point_mul(h, a)))

def b64(data, expected, what):
    try:
        decoded = base64.b64decode(data, validate=True)
    except Exception:
        die("malformed " + what)
    if len(decoded) != expected:
        die("malformed " + what)
    return decoded

path, sig_path, pubkey = sys.argv[1], sys.argv[2], sys.argv[3]
key = b64(pubkey.strip().encode(), 42, "trusted public key")
if key[:2] != b"Ed":
    die("unsupported trusted public key algorithm")
key_id, key_bytes = key[2:10], key[10:]

with open(sig_path, "rb") as handle:
    lines = [line[:-1] if line.endswith(b"\r") else line for line in handle.read().split(b"\n")]
if len(lines) < 4:
    die("malformed signature file")
head = b64(lines[1].strip(), 74, "signature")
algorithm, sig_key_id, signature = head[:2], head[2:10], head[10:]
if sig_key_id != key_id:
    die("release is signed by an untrusted key")
prefix = b"trusted comment: "
if not lines[2].startswith(prefix):
    die("signature file has no trusted comment")
comment = lines[2][len(prefix):]
global_signature = b64(lines[3].strip(), 64, "global signature")

with open(path, "rb") as handle:
    content = handle.read()
if algorithm == b"ED":
    message = hashlib.blake2b(content).digest()
elif algorithm == b"Ed":
    message = content
else:
    die("unsupported signature algorithm")

if not ed25519_verify(key_bytes, message, signature):
    die("signature does not match the download")
# The global signature is what makes the trusted comment trustworthy.
if not ed25519_verify(key_bytes, signature + comment, global_signature):
    die("trusted comment is not signed by the release key")
PY
    return
  fi
  echo "install.sh: no Ed25519 verifier found — install minisign or python3, or" >&2
  echo "  download the release manually and verify it with minisign -Vm." >&2
  return 1
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

  local base
  base="$(release_base_url "$channel")"
  tmp="$(mktemp -d)"

  echo "install.sh: downloading ${asset} (${channel} channel)…"
  curl -fsSL "${base}/sha256sums.txt" -o "${tmp}/sha256sums.txt"
  curl -fsSL "${base}/sha256sums.txt.minisig" -o "${tmp}/sha256sums.txt.minisig" || {
    echo "install.sh: the ${channel} release has no sha256sums.txt.minisig — refusing to install an unsigned build." >&2
    exit 1
  }
  # Nothing in sha256sums.txt is believed until its signature checks out.
  verify_signature "${tmp}/sha256sums.txt" "${tmp}/sha256sums.txt.minisig" || {
    echo "install.sh: signature verification failed for the ${channel} release — refusing to install." >&2
    exit 1
  }
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

  echo "install.sh: installed ${dest}/${APP_NAME} (signature verified, ${channel} channel)."
  case ":${PATH}:" in
    *":${dest}:"*) ;;
    *) echo "install.sh: note — ${dest} is not on your PATH; add it to use ${APP_NAME}." ;;
  esac
  "${dest}/${APP_NAME}" --version || true
}

if [ "${INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
