package cli

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/output"
	"open-yt-cli/internal/youtube"
)

const liveChatDedupWindow = 10000
const maxLiveChatPollingInterval = 60 * time.Second

func (a *App) liveChatCommand() *cobra.Command {
	live := &cobra.Command{Use: "live-chat", Short: "Read public live chat using REST polling"}
	live.AddCommand(a.liveChatListCommand(), a.liveChatStreamCommand())
	return live
}

type liveChatFlags struct {
	videoID     string
	chatID      string
	pageSize    int
	pageToken   string
	limit       int
	profileSize int
	parts       string
	fields      string
}

func (a *App) liveChatListCommand() *cobra.Command {
	var flags liveChatFlags
	var all bool
	cmd := &cobra.Command{
		Use: "list", Short: "Fetch one finite page of live chat messages", Args: exactArgs(0),
		Long: "Fetch one finite page of public live chat messages. Use stream for continuous, polling-aware output.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if all {
				return &UsageError{Message: "--all is not supported for live chat because its next token represents future polling; use 'live-chat stream'"}
			}
			client, chatID, requests, err := a.liveChatClientAndID(cmd, flags.videoID, flags.chatID)
			if err != nil {
				return err
			}
			response, err := client.Get(cmd.Context(), "liveChat/messages", liveChatParams(chatID, flags))
			if err != nil {
				return err
			}
			items := response.Items
			nextPageToken := response.NextPageToken
			if flags.limit > 0 && len(items) > flags.limit {
				items = items[:flags.limit]
				// The server token points past the entire fetched page. Returning
				// it after discarding messages would skip those messages on resume.
				nextPageToken = ""
			}
			return a.renderResult(youtube.ListResult{Items: items, NextPageToken: nextPageToken, Requests: requests + 1}, liveChatColumns())
		},
	}
	addLiveChatFlags(cmd, &flags)
	cmd.Flags().BoolVar(&all, "all", false, "not supported for finite live chat; use stream")
	return cmd
}

func (a *App) liveChatStreamCommand() *cobra.Command {
	var flags liveChatFlags
	cmd := &cobra.Command{
		Use: "stream", Short: "Continuously poll live chat and emit deduplicated messages", Args: exactArgs(0),
		Long: "Continuously polls liveChatMessages.list, respects pollingIntervalMillis, carries page tokens, and deduplicates unchanged messages. Gift combo count updates are emitted. This first draft is a REST polling fallback, not the official gRPC streamList method. JSONL is the default stream format.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			format := a.outputFormat()
			if a.format == "" {
				format = "jsonl"
			}
			if format == "json" {
				return &UsageError{Message: "--format json is not valid for an unbounded stream; use jsonl, tsv, or table"}
			}
			client, chatID, requests, err := a.liveChatClientAndID(cmd, flags.videoID, flags.chatID)
			if err != nil {
				return err
			}
			var preserveIDPart, preserveSnippetPart bool
			flags.parts, preserveIDPart = liveChatPartsWithRequired(flags.parts, "id")
			flags.parts, preserveSnippetPart = liveChatPartsWithRequired(flags.parts, "snippet")
			requestFields, preserveIDField := fieldsWithRequired(flags.fields, "items/id")
			requestFields, preserveComboCount := fieldsWithRequired(requestFields, "items/snippet/giftEventDetails/giftMetadata/comboCount")
			flags.fields = requestFields
			preserveID := preserveIDField && (preserveIDPart || !cmd.Flags().Changed("parts"))
			seen := newRecentIDs(liveChatDedupWindow)
			emitted := 0
			firstPage := true
			for {
				response, err := client.Get(cmd.Context(), "liveChat/messages", liveChatParams(chatID, flags))
				if err != nil {
					if errors.Is(err, context.Canceled) || apiErrorHasReason(err, "liveChatEnded") {
						return nil
					}
					return err
				}
				requests++
				items := make([]map[string]any, 0, len(response.Items))
				for _, item := range response.Items {
					id, _ := item["id"].(string)
					if id != "" && !seen.AddRevision(id, liveChatComboCount(item)) {
						continue
					}
					items = append(items, item)
					if flags.limit > 0 && emitted+len(items) >= flags.limit {
						break
					}
				}
				if len(items) > 0 {
					stripItemIDs(items, preserveID)
					stripLiveChatInternalSnippet(items, preserveSnippetPart, preserveComboCount)
					columns := a.columns
					if len(columns) == 0 {
						columns = liveChatColumns()
					}
					if err := output.Render(a.Out, youtube.ListResult{Items: items, Requests: requests}, output.Options{Format: format, Columns: columns, NoHeader: a.noHeader || !firstPage}); err != nil {
						return err
					}
					emitted += len(items)
					firstPage = false
				}
				if flags.limit > 0 && emitted >= flags.limit {
					return nil
				}
				if response.OfflineAt != "" || response.NextPageToken == "" {
					return nil
				}
				flags.pageToken = response.NextPageToken
				interval := liveChatPollingInterval(response.PollingIntervalMillis)
				if err := waitFor(cmd.Context(), interval); err != nil {
					if errors.Is(err, context.Canceled) {
						return nil
					}
					return err
				}
			}
		},
	}
	addLiveChatFlags(cmd, &flags)
	return cmd
}

func liveChatPollingInterval(milliseconds int64) time.Duration {
	if milliseconds <= 0 {
		return time.Second
	}
	if milliseconds >= int64(maxLiveChatPollingInterval/time.Millisecond) {
		return maxLiveChatPollingInterval
	}
	return time.Duration(milliseconds) * time.Millisecond
}

type recentIDs struct {
	values   map[string]string
	order    []string
	next     int
	capacity int
}

func newRecentIDs(capacity int) *recentIDs {
	return &recentIDs{values: make(map[string]string, capacity), order: make([]string, 0, capacity), capacity: capacity}
}

func (r *recentIDs) Add(value string) bool {
	return r.AddRevision(value, "")
}

func (r *recentIDs) AddRevision(value, revision string) bool {
	if previous, exists := r.values[value]; exists {
		if previous == revision {
			return false
		}
		r.values[value] = revision
		return true
	}
	if r.capacity == 0 {
		return false
	}
	if len(r.order) < r.capacity {
		r.order = append(r.order, value)
	} else {
		delete(r.values, r.order[r.next])
		r.order[r.next] = value
		r.next = (r.next + 1) % r.capacity
	}
	r.values[value] = revision
	return true
}

func liveChatComboCount(item map[string]any) string {
	value := any(item)
	for _, key := range []string{"snippet", "giftEventDetails", "giftMetadata", "comboCount"} {
		object, ok := value.(map[string]any)
		if !ok {
			return ""
		}
		value, ok = object[key]
		if !ok {
			return ""
		}
	}
	return fmt.Sprint(value)
}

func liveChatPartsWithRequired(parts, required string) (string, bool) {
	for _, part := range strings.Split(parts, ",") {
		if strings.TrimSpace(part) == required {
			return parts, true
		}
	}
	if strings.TrimSpace(parts) == "" {
		return required, false
	}
	return parts + "," + required, false
}

func stripLiveChatInternalSnippet(items []map[string]any, preserveSnippet, preserveComboCount bool) {
	for _, item := range items {
		if !preserveSnippet {
			delete(item, "snippet")
			continue
		}
		if preserveComboCount {
			continue
		}
		snippet, ok := item["snippet"].(map[string]any)
		if !ok {
			continue
		}
		giftEvent, ok := snippet["giftEventDetails"].(map[string]any)
		if !ok {
			continue
		}
		metadata, ok := giftEvent["giftMetadata"].(map[string]any)
		if !ok {
			continue
		}
		delete(metadata, "comboCount")
		if len(metadata) == 0 {
			delete(giftEvent, "giftMetadata")
		}
		if len(giftEvent) == 0 {
			delete(snippet, "giftEventDetails")
		}
		if len(snippet) == 0 {
			delete(item, "snippet")
		}
	}
}

func addLiveChatFlags(cmd *cobra.Command, flags *liveChatFlags) {
	cmd.Flags().StringVar(&flags.videoID, "video", "", "live video ID (resolved to activeLiveChatId)")
	cmd.Flags().StringVar(&flags.chatID, "chat-id", "", "live chat ID")
	cmd.Flags().IntVar(&flags.pageSize, "page-size", 500, "messages per request (200-2000)")
	cmd.Flags().StringVar(&flags.pageToken, "page-token", "", "resume at this live chat page token")
	cmd.Flags().IntVar(&flags.limit, "limit", 0, "stop after this many emitted messages (0 means unlimited)")
	cmd.Flags().IntVar(&flags.profileSize, "profile-image-size", 88, "author image size in pixels (16-720)")
	cmd.Flags().StringVar(&flags.parts, "parts", "snippet,authorDetails", "comma-separated API resource parts")
	cmd.Flags().StringVar(&flags.fields, "fields", "", "Google partial-response fields selector")
	cmd.PreRunE = func(_ *cobra.Command, _ []string) error {
		if (flags.videoID == "") == (flags.chatID == "") {
			return &UsageError{Message: "provide exactly one of --video or --chat-id"}
		}
		if flags.pageSize < 200 || flags.pageSize > 2000 {
			return &UsageError{Message: "--page-size must be between 200 and 2000"}
		}
		if flags.profileSize < 16 || flags.profileSize > 720 {
			return &UsageError{Message: "--profile-image-size must be between 16 and 720"}
		}
		if flags.limit < 0 {
			return &UsageError{Message: "--limit cannot be negative"}
		}
		return nil
	}
}

func (a *App) liveChatClientAndID(cmd *cobra.Command, videoID, chatID string) (*youtube.Client, string, int, error) {
	client, err := a.authenticatedClient()
	if err != nil {
		return nil, "", 0, err
	}
	if chatID != "" {
		return client, chatID, 0, nil
	}
	response, err := client.Get(cmd.Context(), "videos", url.Values{"part": {"liveStreamingDetails"}, "id": {videoID}})
	if err != nil {
		return nil, "", 1, err
	}
	if len(response.Items) == 0 {
		return nil, "", 1, fmt.Errorf("video %q not found", videoID)
	}
	resolved, ok := mapPathString(response.Items[0], "liveStreamingDetails", "activeLiveChatId")
	if !ok || strings.TrimSpace(resolved) == "" {
		return nil, "", 1, fmt.Errorf("video %q has no active public live chat", videoID)
	}
	return client, resolved, 1, nil
}

func liveChatParams(chatID string, flags liveChatFlags) url.Values {
	params := url.Values{
		"part":             {flags.parts},
		"liveChatId":       {chatID},
		"maxResults":       {fmt.Sprint(flags.pageSize)},
		"profileImageSize": {fmt.Sprint(flags.profileSize)},
	}
	fields := flags.fields
	for _, required := range []string{"nextPageToken", "pollingIntervalMillis", "offlineAt"} {
		fields, _ = fieldsWithRequired(fields, required)
	}
	setValues(params, map[string]string{"pageToken": flags.pageToken, "fields": fields})
	return params
}

func liveChatColumns() []string {
	return []string{"snippet.publishedAt", "authorDetails.displayName", "snippet.displayMessage", "snippet.type", "id"}
}

func apiErrorHasReason(err error, wanted string) bool {
	var apiErr *youtube.APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	for _, reason := range apiErr.Reasons {
		if reason == wanted {
			return true
		}
	}
	return false
}

func waitFor(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
