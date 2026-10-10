// Package mcptools exposes the ops layer as MCP tools. The same server serves
// the local `oytc mcp` stdio command and the hosted oytcd endpoint; only the
// Resolver differs.
package mcptools

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"open-yt-cli/internal/ops"
)

// PageBudget caps Data API requests per tool call (youtube.Client.PageBudget)
// so `all: true` cannot drain the daily quota; results stay resumable.
const PageBudget = 20

// Channel is one YouTube channel the caller has connected.
type Channel struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Handle  string `json:"handle,omitempty"`
	Default bool   `json:"default,omitempty"`
	// Status is "ok" or "revoked" (Google access must be reconnected).
	Status string `json:"status"`
}

// Resolver supplies per-caller clients. Hosted servers build one per request
// with the caller's identity baked in, so tools never deal with users.
type Resolver struct {
	Data      ops.DataClient
	Analytics ops.AnalyticsClient
	// Channels lists the caller's connected channels. Nil (local stdio)
	// omits the list_channels tool.
	Channels func(context.Context) ([]Channel, error)
}

type Options struct {
	Version string
	// SchemaCache should be shared when a server is built per request.
	SchemaCache *mcp.SchemaCache
}

func NewServer(r Resolver, o Options) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "oytc", Version: o.Version}, &mcp.ServerOptions{Instructions: instructions, SchemaCache: o.SchemaCache})
	if r.Channels != nil {
		mcp.AddTool(server, &mcp.Tool{Name: "list_channels", Description: "List the YouTube channels connected to this account. Analytics tools take one of these as `channel` (ID or @handle); omitting it uses the default channel.", Annotations: readOnly},
			func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, channelList, error) {
				channels, err := r.Channels(ctx)
				return nil, channelList{Channels: channels}, err
			})
	}
	registerTools(server, r)
	return server
}

type channelList struct {
	Channels []Channel `json:"channels"`
}

var readOnly = &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: new(true)}

const instructions = `oytc reads public YouTube data (Data API v3) and the connected channel's analytics (YouTube Analytics API). Everything is read-only.

- search draws on a 100 calls/day bucket; enumerate a channel with channel_uploads then video_get instead of searching.
- Other reads cost about 1 unit of a shared 10,000 units/day quota; prefer batching IDs (video_get takes up to 50) over many single calls.
- Channel references accept UC… IDs, @handles, and channel URLs.
- Counters (viewCount, likeCount, …) are strings; keep them as strings.
- Lists return nextPageToken (Data API) or nextStartIndex (Analytics); pass it back as pageToken / startIndex to continue. If completionUncertain is true, narrow the date range or filters.
- Use fields (Google partial-response selector) to keep large results small.`
