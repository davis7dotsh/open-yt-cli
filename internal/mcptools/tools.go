package mcptools

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"open-yt-cli/internal/ops"
)

const analyticsChannel = " `channel` takes a connected channel ID or @handle (see list_channels when available); omit it for the default channel. Dates default to the 28 days ending yesterday (UTC)."

// registerTools adds one tool per oytc read command.
func registerTools(server *mcp.Server, r Resolver) {
	data, analytics := r.Data, r.Analytics

	tool(server, "search", "Search public YouTube videos, channels, and playlists. Uses 1 of only 100 searches/day; prefer channel_uploads + video_get to enumerate a channel.", bind(data, ops.Search))
	tool(server, "channel_get", "Get channels by UC… ID, @handle, or channel URL: snippet, contentDetails, and statistics by default.", bind(data, ops.ChannelGet))
	tool(server, "channel_activities", "List a channel's public activities.", bind(data, ops.ChannelActivities))
	tool(server, "channel_sections", "List a channel's sections, or get sections by ID. Provide exactly one of channel or id.", bind(data, ops.ChannelSections))
	tool(server, "channel_uploads", "List a channel's uploaded videos via its uploads playlist. The cheap way to enumerate a channel; pass the video IDs to video_get for details.", bind(data, ops.ChannelUploads))
	tool(server, "video_get", "Get videos by ID: snippet, contentDetails, statistics, and status by default. Batch up to 50 IDs per call.", bind(data, ops.VideoGet))
	tool(server, "video_stats", "Get view, like, and comment counters for videos by ID. Batch up to 50 IDs per call.", bind(data, ops.VideoStats))
	tool(server, "video_popular", "List the most popular videos for a region (default US), optionally in one category.", bind(data, ops.VideoPopular))
	tool(server, "video_trainability", "Get which third parties a video's owner allows to train AI models on it. Costs no quota.", bind(data, ops.VideoTrainability))
	tool(server, "playlist_get", "Get playlists by ID. Batch up to 50 IDs per call.", bind(data, ops.PlaylistGet))
	tool(server, "playlist_list", "List a channel's public playlists.", bind(data, ops.PlaylistList))
	tool(server, "playlist_items", "List the items in a playlist.", bind(data, ops.PlaylistItems))
	tool(server, "comment_get", "Get comments by ID. Batch up to 100 IDs per call.", bind(data, ops.CommentGet))
	tool(server, "comment_replies", "List replies to a top-level comment.", bind(data, ops.CommentReplies))
	tool(server, "comment_threads", "List comment threads for a video, a channel, or thread IDs. Provide exactly one of video, channel, or id.", bind(data, ops.CommentThreads))
	tool(server, "subscription_list", "List a channel's public subscriptions, or subscriptions by ID. Provide exactly one of channel or id; many channels hide their subscriptions.", bind(data, ops.SubscriptionList))
	tool(server, "category_list", "List video categories for a region, or by ID. Provide exactly one of region or id.", bind(data, ops.CategoryList))
	tool(server, "language_list", "List the UI languages YouTube supports.", bind(data, ops.LanguageList))
	tool(server, "region_list", "List the regions YouTube supports.", bind(data, ops.RegionList))
	tool(server, "live_chat_messages", "Fetch one page of a public live chat by video or chatId. To follow the chat, call again with the returned liveChatId and nextPageToken as pageToken after pollingIntervalMillis; offlineAt set means the chat ended.", bind(data, ops.LiveChatPage))

	tool(server, "analytics_report", "Run a raw YouTube Analytics report for a connected channel: metrics required; dimensions, filters, and sort optional."+analyticsChannel, bind(analytics, ops.AnalyticsReport))
	tool(server, "analytics_overview", "Show a channel's views, engaged views, watch time, retention, and subscribers gained, optionally by day or month."+analyticsChannel, bind(analytics, ops.AnalyticsOverview))
	tool(server, "analytics_video", "Show core analytics for one video owned by the channel."+analyticsChannel, bind(analytics, ops.AnalyticsVideo))
	tool(server, "analytics_traffic_sources", "Break a channel's views and watch time down by traffic source."+analyticsChannel, bind(analytics, ops.AnalyticsTrafficSources))
	tool(server, "analytics_demographics", "Break a channel's viewer percentage down by age group and gender."+analyticsChannel, bind(analytics, ops.AnalyticsDemographics))
}

func tool[In, Out any](server *mcp.Server, name, description string, run func(context.Context, In) (Out, error)) {
	mcp.AddTool(server, &mcp.Tool{Name: name, Description: description, Annotations: readOnly},
		func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, Out, error) {
			out, err := run(ctx, in)
			return nil, out, err
		})
}

// bind fixes an operation's client resolver.
func bind[Client, In, Out any](client Client, op func(context.Context, Client, In) (Out, error)) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) { return op(ctx, client, in) }
}
