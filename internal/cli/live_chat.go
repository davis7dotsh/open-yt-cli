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
			if flags.limit > 0 && len(items) > flags.limit {
				items = items[:flags.limit]
			}
			return a.renderResult(youtube.ListResult{Items: items, NextPageToken: response.NextPageToken, Requests: requests + 1}, liveChatColumns())
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
		Long: "Continuously polls liveChatMessages.list, respects pollingIntervalMillis, carries page tokens, and deduplicates IDs. This first draft is a REST polling fallback, not the official gRPC streamList method. JSONL is the default stream format.",
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
			seen := make(map[string]struct{})
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
					if id != "" {
						if _, exists := seen[id]; exists {
							continue
						}
						seen[id] = struct{}{}
					}
					items = append(items, item)
					if flags.limit > 0 && emitted+len(items) >= flags.limit {
						break
					}
				}
				if len(items) > 0 {
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
				interval := time.Duration(response.PollingIntervalMillis) * time.Millisecond
				if interval <= 0 {
					interval = time.Second
				}
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
	setValues(params, map[string]string{"pageToken": flags.pageToken, "fields": flags.fields})
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
