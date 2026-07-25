#!/usr/bin/env sh
# Cross-compile and package oytc release artifacts.
#
# Usage: scripts/package.sh <version-tag> [output-dir]
#   version-tag  semantic version with leading v, e.g. v0.1.0
#   output-dir   destination directory (default: dist)
#
# Produces, for each platform:
#   oytc_<tag>_<os>_<arch>.tar.gz   (linux, darwin; contains a single "oytc")
#   oytc_<tag>_<os>_<arch>.zip      (windows; contains a single "oytc.exe")
# plus a combined checksums.txt in sha256sum format.
#
# The asset naming here must stay in sync with:
#   src/impl/platformMatrix.ts (assetName)
#   site/install.sh
#   site/install.ps1
#   .depot/workflows/release.yml
#
# The archive names keep the historical Go-style os/arch tokens (linux, darwin,
# windows / amd64, arm64) even though the compiler is now Bun, so clients
# installed from an older release can still self-update.
set -eu

VERSION="${1:-}"
DIST="${2:-dist}"

if [ -z "$VERSION" ]; then
    echo "usage: scripts/package.sh <version-tag> [output-dir]" >&2
    exit 2
fi
case "$VERSION" in
    v[0-9]*) ;;
    *)
        echo "error: version must look like v0.1.0 (got '$VERSION')" >&2
        exit 2
        ;;
esac

COMMIT="${OYTC_COMMIT:-$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
DATE="${OYTC_BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
ENTRYPOINT="src/main.ts"

# Release platforms, named with the historical goos/goarch tokens that appear in
# the asset names. windows/arm64 is deliberately absent: `bun build --compile`
# has no bun-windows-arm64 target. ARM64 Windows installs the amd64 build and
# runs it under emulation (see site/install.ps1).
PLATFORMS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64"

# Map an asset-name platform pair to its `bun build --compile --target=` value.
# Keep in sync with PLATFORMS above and with src/impl/platformMatrix.ts.
bun_target() {
    case "$1/$2" in
        linux/amd64) echo "bun-linux-x64" ;;
        linux/arm64) echo "bun-linux-arm64" ;;
        darwin/amd64) echo "bun-darwin-x64" ;;
        darwin/arm64) echo "bun-darwin-arm64" ;;
        windows/amd64) echo "bun-windows-x64" ;;
        *)
            echo "error: no bun --compile target for $1/$2" >&2
            return 1
            ;;
    esac
}

mkdir -p "$DIST"
rm -f "$DIST"/oytc_"$VERSION"_*.tar.gz "$DIST"/oytc_"$VERSION"_*.zip "$DIST"/checksums.txt

checksum_file() {
    # sha256sum on Linux, shasum -a 256 on macOS. Both emit "<hex>  <name>".
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1"
    else
        shasum -a 256 "$1"
    fi
}

# Each iteration builds into a fresh temp dir; clean up the in-flight one if a
# build fails, so `set -e` does not leave a multi-hundred-MB directory behind.
workdir=""
cleanup() {
    [ -n "$workdir" ] && rm -rf "$workdir"
    workdir=""
}
# INT/TERM must clean up *and* abort. A plain `trap cleanup INT TERM` runs the
# handler and then resumes the loop, so Ctrl-C would silently build all five
# ~100 MB platforms and exit 0; re-raising with the trap reset gives the caller
# the conventional 130/143 status.
trap cleanup EXIT
trap 'cleanup; trap - INT; kill -INT $$' INT
trap 'cleanup; trap - TERM; kill -TERM $$' TERM

for platform in $PLATFORMS; do
    goos="${platform%/*}"
    goarch="${platform#*/}"
    target="$(bun_target "$goos" "$goarch")"
    binary="oytc"
    ext="tar.gz"
    if [ "$goos" = "windows" ]; then
        binary="oytc.exe"
        ext="zip"
    fi
    asset="oytc_${VERSION}_${goos}_${goarch}.${ext}"
    workdir="$(mktemp -d)"
    echo "building $asset"
    # Version metadata is injected at bundle time; src/impl/versionInfo.ts reads
    # these defines and falls back to dev/unknown/unknown under plain `bun run`.
    bun build --compile \
        --target="$target" \
        --define "OYTC_VERSION=\"$VERSION\"" \
        --define "OYTC_COMMIT=\"$COMMIT\"" \
        --define "OYTC_DATE=\"$DATE\"" \
        --outfile "$workdir/oytc" \
        "$ENTRYPOINT"
    # A windows target appends .exe to --outfile, which is already the name the
    # archive needs. Normalize either way rather than depending on that.
    if [ ! -f "$workdir/$binary" ] && [ -f "$workdir/oytc" ]; then
        mv "$workdir/oytc" "$workdir/$binary"
    fi
    if [ ! -f "$workdir/$binary" ]; then
        echo "error: bun build did not produce $workdir/$binary" >&2
        exit 1
    fi
    chmod 0755 "$workdir/$binary"
    if [ "$ext" = "zip" ]; then
        (cd "$workdir" && zip -q -X "$asset" "$binary")
        mv "$workdir/$asset" "$DIST/$asset"
    else
        # Deterministic-ish tar: single file, no user/group names.
        tar -C "$workdir" -czf "$DIST/$asset" --owner=0 --group=0 "$binary" 2>/dev/null ||
            tar -C "$workdir" -czf "$DIST/$asset" "$binary"
    fi
    cleanup
done

(
    cd "$DIST"
    : >checksums.txt
    for archive in oytc_"$VERSION"_*.tar.gz oytc_"$VERSION"_*.zip; do
        [ -f "$archive" ] || continue
        checksum_file "$archive" >>checksums.txt
    done
)

echo
echo "artifacts in $DIST:"
ls -1 "$DIST"/oytc_"$VERSION"_* "$DIST"/checksums.txt
