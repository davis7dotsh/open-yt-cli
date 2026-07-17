package skillbundle

import "embed"

// Files contains the complete oytc agent skill shipped with each release.
//
//go:embed SKILL.md references/*.md
var Files embed.FS
