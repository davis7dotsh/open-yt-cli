// Package ops holds oytc's read operations, shared by the CLI and the MCP
// tools. Each operation validates its input before resolving a client, so
// callers see input mistakes before credential problems or any request.
package ops

import (
	"context"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/youtube"
)

// DataClient resolves a YouTube Data API client for the current caller.
type DataClient func(context.Context) (*youtube.Client, error)

// AnalyticsClient resolves a YouTube Analytics client for one of the caller's
// channels; an empty channel means the caller's default channel.
type AnalyticsClient func(ctx context.Context, channel string) (*analytics.Client, error)

// InputError is a caller mistake caught before any request is sent.
type InputError struct{ Message string }

func (e *InputError) Error() string { return e.Message }
