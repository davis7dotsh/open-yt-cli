package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/ops"
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

func (a *App) liveChatListCommand() *cobra.Command {
	var in ops.LiveChatPageInput
	var all bool
	cmd := &cobra.Command{
		Use: "list", Short: "Fetch one finite page of live chat messages", Args: exactArgs(0),
		Long: "Fetch one finite page of public live chat messages. Use stream for continuous, polling-aware output.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if all {
				return &UsageError{Message: "--all is not supported for live chat because its next token represents future polling; use 'live-chat stream'"}
			}
			page, err := ops.LiveChatPage(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(page.ListResult, liveChatColumns())
		},
	}
	addLiveChatFlags(cmd, &in)
	cmd.Flags().BoolVar(&all, "all", false, "not supported for finite live chat; use stream")
	return cmd
}

func (a *App) liveChatStreamCommand() *cobra.Command {
	var in ops.LiveChatPageInput
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
			// The stream limits emitted messages across pages, so each page
			// is fetched whole.
			limit := in.Limit
			if limit < 0 {
				return &UsageError{Message: "limit cannot be negative"}
			}
			in.Limit = 0
			var preserveIDPart, preserveSnippetPart bool
			in.Parts, preserveIDPart = liveChatPartsWithRequired(in.Parts, "id")
			in.Parts, preserveSnippetPart = liveChatPartsWithRequired(in.Parts, "snippet")
			requestFields, preserveIDField := ops.FieldsWithRequired(in.Fields, "items/id")
			requestFields, preserveComboCount := ops.FieldsWithRequired(requestFields, "items/snippet/giftEventDetails/giftMetadata/comboCount")
			in.Fields = requestFields
			preserveID := preserveIDField && (preserveIDPart || !cmd.Flags().Changed("parts"))
			seen := newRecentIDs(liveChatDedupWindow)
			emitted := 0
			firstPage := true
			for {
				page, err := ops.LiveChatPage(cmd.Context(), a.dataClient, in)
				if err != nil {
					if errors.Is(err, context.Canceled) || apiErrorHasReason(err, "liveChatEnded") {
						return nil
					}
					return err
				}
				// Resolve a --video only once.
				in.Video, in.ChatID = "", page.LiveChatID
				items := make([]map[string]any, 0, len(page.Items))
				for _, item := range page.Items {
					id, _ := item["id"].(string)
					comboCount := liveChatComboCount(item)
					if !preserveID {
						delete(item, "id")
					}
					stripLiveChatInternalSnippet(item, preserveSnippetPart, preserveComboCount)
					if len(item) == 0 {
						continue
					}
					if id != "" && !seen.AddRevision(id, comboCount) {
						continue
					}
					items = append(items, item)
					if limit > 0 && emitted+len(items) >= limit {
						break
					}
				}
				if len(items) > 0 {
					columns := a.columns
					if len(columns) == 0 {
						columns = liveChatColumns()
					}
					if err := output.Render(a.Out, youtube.ListResult{Items: items}, output.Options{Format: format, Columns: columns, NoHeader: a.noHeader || !firstPage}); err != nil {
						return err
					}
					emitted += len(items)
					firstPage = false
				}
				if limit > 0 && emitted >= limit {
					return nil
				}
				if page.OfflineAt != "" || page.NextPageToken == "" {
					return nil
				}
				in.PageToken = page.NextPageToken
				interval := liveChatPollingInterval(page.PollingIntervalMillis)
				if err := waitFor(cmd.Context(), interval); err != nil {
					if errors.Is(err, context.Canceled) {
						return nil
					}
					return err
				}
			}
		},
	}
	addLiveChatFlags(cmd, &in)
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

func stripLiveChatInternalSnippet(item map[string]any, preserveSnippet, preserveComboCount bool) {
	if !preserveSnippet {
		delete(item, "snippet")
		return
	}
	if preserveComboCount {
		return
	}
	snippet, ok := item["snippet"].(map[string]any)
	if !ok {
		return
	}
	giftEvent, ok := snippet["giftEventDetails"].(map[string]any)
	if !ok {
		return
	}
	metadata, ok := giftEvent["giftMetadata"].(map[string]any)
	if !ok {
		return
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

func addLiveChatFlags(cmd *cobra.Command, in *ops.LiveChatPageInput) {
	cmd.Flags().StringVar(&in.Video, "video", "", "live video ID (resolved to activeLiveChatId)")
	cmd.Flags().StringVar(&in.ChatID, "chat-id", "", "live chat ID")
	cmd.Flags().IntVar(&in.PageSize, "page-size", 500, "messages per request (200-2000)")
	cmd.Flags().StringVar(&in.PageToken, "page-token", "", "resume at this live chat page token")
	cmd.Flags().IntVar(&in.Limit, "limit", 0, "stop after this many emitted messages (0 means unlimited)")
	cmd.Flags().IntVar(&in.ProfileImageSize, "profile-image-size", 88, "author image size in pixels (16-720)")
	cmd.Flags().StringVar(&in.Parts, "parts", "snippet,authorDetails", "comma-separated API resource parts")
	cmd.Flags().StringVar(&in.Fields, "fields", "", "Google partial-response fields selector")
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
