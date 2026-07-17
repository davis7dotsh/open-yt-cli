// Package version exposes the build-time version metadata for oytc.
//
// Release builds inject these values with:
//
//	go build -ldflags "-X open-yt-cli/internal/version.Version=v1.2.3 \
//	  -X open-yt-cli/internal/version.Commit=abc1234 \
//	  -X open-yt-cli/internal/version.Date=2026-01-02T15:04:05Z"
//
// Builds without injection (go install, go run) fall back to Go module build
// info where available and otherwise report "dev".
package version

import (
	"runtime"
	"runtime/debug"
)

var (
	// Version is the semantic version of this build, with a leading "v"
	// (for example "v0.1.0"), or "dev" for uninjected builds.
	Version = "dev"
	// Commit is the short or full git commit hash of this build.
	Commit = "unknown"
	// Date is the RFC 3339 UTC build timestamp.
	Date = "unknown"
)

// Info is a stable, machine-readable description of the running binary.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	Date      string `json:"date"`
	GoVersion string `json:"goVersion"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
}

// Get resolves the effective build metadata, consulting module build info
// when the linker did not inject values.
func Get() Info {
	info := Info{
		Version:   Version,
		Commit:    Commit,
		Date:      Date,
		GoVersion: runtime.Version(),
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
	}
	build, ok := debug.ReadBuildInfo()
	if !ok {
		return info
	}
	if info.Version == "dev" && build.Main.Version != "" && build.Main.Version != "(devel)" {
		info.Version = build.Main.Version
	}
	if info.Commit == "unknown" {
		for _, setting := range build.Settings {
			if setting.Key == "vcs.revision" && setting.Value != "" {
				info.Commit = setting.Value
			}
			if setting.Key == "vcs.time" && setting.Value != "" && info.Date == "unknown" {
				info.Date = setting.Value
			}
		}
	}
	return info
}
