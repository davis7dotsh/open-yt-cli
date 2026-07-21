#!/bin/sh
# oytc installer — https://github.com/davis7dotsh/open-yt-cli
#
#   curl -fsSL https://davis7dotsh.github.io/open-yt-cli/install.sh | sh
#
# Options (environment variables):
#   OYTC_VERSION      release tag to install, e.g. v0.2.0 (default: latest)
#   OYTC_INSTALL_DIR  destination directory (default: ~/.local/bin, or
#                     ~/bin if ~/.local/bin is not creatable)
#   OYTC_NO_SYMLINKS  set to 1 to skip the oytc_update/oytc_upgrade symlinks
#
# Behavior:
#   - Detects OS (linux, darwin) and architecture (amd64, arm64).
#   - Downloads the release archive and checksums.txt from GitHub Releases.
#   - Verifies the archive's SHA-256 before extracting anything.
#   - Installs to a user-writable directory; never requires root by default.
#   - Creates oytc_update and oytc_upgrade symlinks (self-update aliases).
#
# Windows users: this script supports macOS and Linux only. On Windows,
# download the oytc_<version>_windows_<arch>.zip asset from
# https://github.com/davis7dotsh/open-yt-cli/releases, verify its SHA-256
# against checksums.txt (PowerShell: Get-FileHash -Algorithm SHA256), and
# place oytc.exe on your PATH.
set -eu

REPO="davis7dotsh/open-yt-cli"
# OYTC_API_BASE / OYTC_DOWNLOAD_BASE exist for hermetic testing only.
API="${OYTC_API_BASE:-https://api.github.com/repos/${REPO}}"
DOWNLOAD="${OYTC_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}"

say() { printf '%s\n' "$*" >&2; }
fail() {
    say "install.sh: error: $*"
    exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

# --- Detect platform -------------------------------------------------------
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
    linux) goos="linux" ;;
    darwin) goos="darwin" ;;
    mingw* | msys* | cygwin*)
        fail "Windows detected: download the windows zip from https://github.com/${REPO}/releases and see the README for PowerShell instructions"
        ;;
    *) fail "unsupported operating system: $os" ;;
esac

arch="$(uname -m)"
case "$arch" in
    x86_64 | amd64) goarch="amd64" ;;
    aarch64 | arm64) goarch="arm64" ;;
    *) fail "unsupported architecture: $arch (supported: x86_64/amd64, aarch64/arm64)" ;;
esac

# --- Resolve version --------------------------------------------------------
version="${OYTC_VERSION:-}"
if [ -z "$version" ]; then
    version="$(curl -fsSL -H 'Accept: application/vnd.github+json' "${API}/releases/latest" |
        awk -F '"' '/"tag_name"/ { print $4; exit }')" ||
        fail "could not query the latest release from GitHub (network or rate limit?)"
    [ -n "$version" ] || fail "no published release found for ${REPO} (releases page: https://github.com/${REPO}/releases)"
else
    case "$version" in
        v*) ;;
        *) version="v${version}" ;;
    esac
fi

asset="oytc_${version}_${goos}_${goarch}.tar.gz"
say "installing oytc ${version} (${goos}/${goarch})"

# --- Download and verify ----------------------------------------------------
workdir="$(mktemp -d "${TMPDIR:-/tmp}/oytc-install.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT INT TERM

curl -fsSL -o "${workdir}/${asset}" "${DOWNLOAD}/${version}/${asset}" ||
    fail "failed to download ${asset} — check that release ${version} exists and includes ${goos}/${goarch}"
curl -fsSL -o "${workdir}/checksums.txt" "${DOWNLOAD}/${version}/checksums.txt" ||
    fail "failed to download checksums.txt for ${version}; refusing to install an unverified binary"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*"name { print tolower($1); exit }' "${workdir}/checksums.txt")"
[ -n "$expected" ] || fail "checksums.txt has no entry for ${asset}"

if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${workdir}/${asset}" | awk '{print tolower($1)}')"
elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${workdir}/${asset}" | awk '{print tolower($1)}')"
else
    fail "neither sha256sum nor shasum is available; cannot verify the download"
fi

[ "$actual" = "$expected" ] ||
    fail "SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}; refusing to install"

tar -xzf "${workdir}/${asset}" -C "$workdir" oytc ||
    fail "failed to extract oytc from ${asset}"
[ -f "${workdir}/oytc" ] || fail "archive did not contain the oytc binary"
chmod 0755 "${workdir}/oytc"

# --- Install ----------------------------------------------------------------
destination="${OYTC_INSTALL_DIR:-}"
if [ -z "$destination" ]; then
    if mkdir -p "${HOME}/.local/bin" 2>/dev/null && [ -w "${HOME}/.local/bin" ]; then
        destination="${HOME}/.local/bin"
    elif mkdir -p "${HOME}/bin" 2>/dev/null && [ -w "${HOME}/bin" ]; then
        destination="${HOME}/bin"
    else
        fail "no user-writable install directory found; set OYTC_INSTALL_DIR"
    fi
else
    mkdir -p "$destination" || fail "cannot create ${destination}"
    [ -w "$destination" ] || fail "${destination} is not writable; choose another OYTC_INSTALL_DIR or re-run with appropriate permissions"
fi

# Atomic move into place (staging file in the destination directory).
staged="${destination}/.oytc.new.$$"
cp "${workdir}/oytc" "$staged"
chmod 0755 "$staged"
mv -f "$staged" "${destination}/oytc"
say "installed ${destination}/oytc"

if [ "${OYTC_NO_SYMLINKS:-0}" != "1" ]; then
    ln -sf oytc "${destination}/oytc_update"
    ln -sf oytc "${destination}/oytc_upgrade"
    say "created self-update aliases: ${destination}/oytc_update, ${destination}/oytc_upgrade"
fi

# --- PATH guidance -----------------------------------------------------------
case ":${PATH}:" in
    *:"$destination":*)
        say ""
        say "oytc ${version} is ready. Try: oytc --help"
        ;;
    *)
        say ""
        say "NOTE: ${destination} is not on your PATH."
        say "Add it to your shell profile, e.g.:"
        say "  echo 'export PATH=\"${destination}:\$PATH\"' >> ~/.profile"
        say "then restart your shell and try: oytc --help"
        ;;
esac

say ""
say "Next steps:"
say "  oytc login              # save a YouTube Data API v3 key (see docs/google-api-key.md)"
say "  oytc status --check     # verify the key"
say "  oytc update             # self-update later (oytc upgrade / oytc_update also work)"
