# oytc installer for Windows — https://github.com/davis7dotsh/open-yt-cli
#
#   irm https://davis7dotsh.github.io/open-yt-cli/install.ps1 | iex
#
# Optional environment variables:
#   OYTC_VERSION      release tag to install, e.g. v0.2.0 (default: latest)
#   OYTC_INSTALL_DIR  destination directory (default: %LOCALAPPDATA%\Programs\oytc)
#
# Downloads the windows zip from GitHub Releases, verifies its SHA-256
# against checksums.txt, and installs oytc.exe plus oytc_update.cmd /
# oytc_upgrade.cmd shims. Never requires administrator rights.
#
# Only one Windows build is published: windows/amd64. The toolchain has no
# native ARM64 Windows target, so ARM64 machines install the amd64 binary and
# run it under Windows' x64 emulation.
$ErrorActionPreference = 'Stop'

$Repo = 'davis7dotsh/open-yt-cli'

# The published Windows asset is always amd64; $arch stays a variable so the
# asset name below keeps the same oytc_<version>_windows_<arch>.zip shape as
# the packager and the self-updater.
$arch = 'amd64'
$processorArchitecture = @(Get-CimInstance Win32_Processor)[0].Architecture
if ($processorArchitecture -eq 12) {
    # ARM64. There is no windows/arm64 asset; Windows on ARM runs x64 binaries
    # under emulation, so install amd64 rather than failing.
    Write-Host 'ARM64 Windows detected: installing the amd64 build, which runs under x64 emulation.'
} elseif ($processorArchitecture -ne 9 -and -not [Environment]::Is64BitOperatingSystem) {
    throw 'oytc requires a 64-bit Windows (amd64, or arm64 with x64 emulation).'
}

$version = $env:OYTC_VERSION
if (-not $version) {
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' }
    $version = $latest.tag_name
    if (-not $version) { throw "No published release found for $Repo." }
} elseif ($version -notmatch '^v') {
    $version = "v$version"
}

$asset = "oytc_${version}_windows_${arch}.zip"
$base = "https://github.com/$Repo/releases/download/$version"
Write-Host "Installing oytc $version (windows/$arch)"

$work = Join-Path ([IO.Path]::GetTempPath()) ("oytc-install-" + [Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $zipPath = Join-Path $work $asset
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $zipPath
    Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile (Join-Path $work 'checksums.txt')

    $expected = $null
    foreach ($line in Get-Content (Join-Path $work 'checksums.txt')) {
        $parts = -split $line.Trim()
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) {
            $expected = $parts[0].ToLowerInvariant()
            break
        }
    }
    if (-not $expected) { throw "checksums.txt has no entry for $asset; refusing to install." }

    $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA-256 mismatch for ${asset}: expected $expected, got $actual; refusing to install."
    }

    Expand-Archive -Path $zipPath -DestinationPath (Join-Path $work 'extracted') -Force
    $binary = Join-Path $work 'extracted\oytc.exe'
    if (-not (Test-Path $binary)) { throw 'Archive did not contain oytc.exe.' }

    $destination = $env:OYTC_INSTALL_DIR
    if (-not $destination) { $destination = Join-Path $env:LOCALAPPDATA 'Programs\oytc' }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null

    $target = Join-Path $destination 'oytc.exe'
    # A running oytc.exe cannot be overwritten in place; move it aside first.
    if (Test-Path $target) {
        Move-Item -Path $target -Destination "$target.old" -Force
    }
    Move-Item -Path $binary -Destination $target -Force
    Remove-Item -Path "$target.old" -ErrorAction SilentlyContinue

    # Self-update alias shims (argv[0] dispatch also treats these names as `oytc update`).
    Set-Content -Path (Join-Path $destination 'oytc_update.cmd') -Value "@echo off`r`n`"%~dp0oytc.exe`" update %*"
    Set-Content -Path (Join-Path $destination 'oytc_upgrade.cmd') -Value "@echo off`r`n`"%~dp0oytc.exe`" update %*"

    Write-Host "Installed $target"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $destination) {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$destination", 'User')
        Write-Host "Added $destination to your user PATH. Open a new terminal to use oytc."
    }

    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  oytc login              # save a YouTube Data API v3 key'
    Write-Host '  oytc status --check     # verify the key'
    Write-Host '  oytc update             # self-update later'
} finally {
    Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}
