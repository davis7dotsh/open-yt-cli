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
#   internal/update/update.go (AssetName)
#   site/install.sh
#   .depot/workflows/release.yml
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
LDFLAGS="-s -w \
 -X open-yt-cli/internal/version.Version=$VERSION \
 -X open-yt-cli/internal/version.Commit=$COMMIT \
 -X open-yt-cli/internal/version.Date=$DATE"

# GOOS/GOARCH pairs. Go supports windows/arm64 since 1.17.
PLATFORMS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64"

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

for platform in $PLATFORMS; do
    goos="${platform%/*}"
    goarch="${platform#*/}"
    binary="oytc"
    ext="tar.gz"
    if [ "$goos" = "windows" ]; then
        binary="oytc.exe"
        ext="zip"
    fi
    asset="oytc_${VERSION}_${goos}_${goarch}.${ext}"
    workdir="$(mktemp -d)"
    echo "building $asset"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
        go build -trimpath -ldflags "$LDFLAGS" -o "$workdir/$binary" ./cmd/oytc
    if [ "$ext" = "zip" ]; then
        (cd "$workdir" && zip -q -X "$asset" "$binary")
        mv "$workdir/$asset" "$DIST/$asset"
    else
        # Deterministic-ish tar: single file, no user/group names.
        tar -C "$workdir" -czf "$DIST/$asset" --owner=0 --group=0 "$binary" 2>/dev/null ||
            tar -C "$workdir" -czf "$DIST/$asset" "$binary"
    fi
    rm -rf "$workdir"
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
