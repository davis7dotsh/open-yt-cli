package cli

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/output"
	"open-yt-cli/internal/youtube"
)

func (a *App) channelCommand() *cobra.Command {
	channel := &cobra.Command{Use: "channel", Short: "Read channels, activities, sections, and uploads"}
	channel.AddCommand(a.channelGetCommand(), a.channelActivitiesCommand(), a.channelSectionsCommand(), a.channelUploadsCommand())
	return channel
}

func (a *App) channelGetCommand() *cobra.Command {
	var api apiFlags
	cmd := &cobra.Command{
		Use:   "get <REFERENCE>...",
		Short: "Get channels by ID, @handle, or common channel URL",
		Args:  minimumArgs(1),
		RunE: func(cmd *cobra.Command, references []string) error {
			parts := partsOr(api.parts, "snippet,contentDetails,statistics")
			if err := validateParts(parts, "auditDetails", "contentOwnerDetails"); err != nil {
				return err
			}
			client, err := a.authenticatedClient()
			if err != nil {
				return err
			}
			ids := make([]string, 0, len(references))
			requests := 0
			for _, reference := range references {
				id, used, err := client.ResolveChannel(cmd.Context(), reference)
				requests += used
				if err != nil {
					return err
				}
				ids = append(ids, id)
			}
			result := youtube.ListResult{Requests: requests}
			for _, group := range batch(ids, 50) {
				params := url.Values{"part": {parts}, "id": {strings.Join(group, ",")}}
				setValues(params, map[string]string{"hl": api.hl, "fields": api.fields})
				response, err := client.Get(cmd.Context(), "channels", params)
				if err != nil {
					return err
				}
				result.Requests++
				result.Items = append(result.Items, response.Items...)
			}
			return a.renderResult(result, []string{"id", "snippet.title", "statistics.subscriberCount", "statistics.videoCount", "statistics.viewCount"})
		},
	}
	addAPIFlags(cmd, &api, true)
	return cmd
}

func (a *App) channelActivitiesCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var publishedAfter, publishedBefore string
	cmd := &cobra.Command{
		Use:   "activities <CHANNEL>",
		Short: "List a channel's public activities",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validateTimestamp("--published-after", publishedAfter); err != nil {
				return err
			}
			if err := validateTimestamp("--published-before", publishedBefore); err != nil {
				return err
			}
			client, err := a.authenticatedClient()
			if err != nil {
				return err
			}
			channelID, requests, err := client.ResolveChannel(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet,contentDetails")}, "channelId": {channelID}}
			setValues(params, map[string]string{"publishedAfter": publishedAfter, "publishedBefore": publishedBefore, "fields": api.fields})
			result, err := client.List(cmd.Context(), "activities", params, youtube.PageOptions{All: flags.all, Limit: flags.limit, PageSize: flags.pageSize, PageToken: flags.pageToken})
			if err != nil {
				return err
			}
			result.Requests += requests
			return a.renderResult(result, []string{"id", "snippet.publishedAt", "snippet.type", "snippet.title"})
		},
	}
	addListFlags(cmd, &flags, 25, 50)
	addAPIFlags(cmd, &api, false)
	cmd.Flags().StringVar(&publishedAfter, "published-after", "", "RFC 3339 lower publication bound")
	cmd.Flags().StringVar(&publishedBefore, "published-before", "", "RFC 3339 upper publication bound")
	return cmd
}

func (a *App) channelSectionsCommand() *cobra.Command {
	var api apiFlags
	var ids string
	cmd := &cobra.Command{
		Use:   "sections [CHANNEL]",
		Short: "List a channel's sections or get section IDs",
		Args:  maximumArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if (ids == "") == (len(args) == 0) {
				return &UsageError{Message: "provide exactly one of CHANNEL or --id"}
			}
			client, err := a.authenticatedClient()
			if err != nil {
				return err
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet,contentDetails")}}
			requests := 0
			if ids != "" {
				params.Set("id", ids)
			} else {
				channelID, used, err := client.ResolveChannel(cmd.Context(), args[0])
				if err != nil {
					return err
				}
				requests += used
				params.Set("channelId", channelID)
			}
			setValues(params, map[string]string{"hl": api.hl, "fields": api.fields})
			response, err := client.Get(cmd.Context(), "channelSections", params)
			if err != nil {
				return err
			}
			return a.renderResult(youtube.ListResult{Items: response.Items, Requests: requests + 1}, []string{"id", "snippet.type", "snippet.position", "snippet.title"})
		},
	}
	addAPIFlags(cmd, &api, true)
	cmd.Flags().StringVar(&ids, "id", "", "comma-separated channel section IDs")
	return cmd
}

func (a *App) channelUploadsCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	cmd := &cobra.Command{
		Use:   "uploads <CHANNEL>",
		Short: "Resolve and enumerate a channel's uploads playlist",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := a.authenticatedClient()
			if err != nil {
				return err
			}
			channelID, requests, err := client.ResolveChannel(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			channelResponse, err := client.Get(cmd.Context(), "channels", url.Values{"part": {"contentDetails"}, "id": {channelID}})
			if err != nil {
				return err
			}
			requests++
			if len(channelResponse.Items) == 0 {
				return fmt.Errorf("channel %q not found", args[0])
			}
			uploads, ok := mapPathString(channelResponse.Items[0], "contentDetails", "relatedPlaylists", "uploads")
			if !ok || uploads == "" {
				return fmt.Errorf("channel %q has no public uploads playlist", args[0])
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet,contentDetails")}, "playlistId": {uploads}}
			setValues(params, map[string]string{"fields": api.fields})
			result, err := client.List(cmd.Context(), "playlistItems", params, youtube.PageOptions{All: flags.all, Limit: flags.limit, PageSize: flags.pageSize, PageToken: flags.pageToken})
			if err != nil {
				return err
			}
			result.Requests += requests
			return a.renderResult(result, []string{"snippet.position", "contentDetails.videoId", "snippet.title", "snippet.publishedAt"})
		},
	}
	addListFlags(cmd, &flags, 50, 50)
	addAPIFlags(cmd, &api, false)
	return cmd
}

func (a *App) videoCommand() *cobra.Command {
	video := &cobra.Command{Use: "video", Short: "Read videos, statistics, charts, and trainability"}
	video.AddCommand(a.videoGetCommand(false), a.videoGetCommand(true), a.videoPopularCommand(), a.videoTrainabilityCommand())
	return video
}

func (a *App) videoGetCommand(stats bool) *cobra.Command {
	var api apiFlags
	use, short, defaults := "get <VIDEO_ID>...", "Get videos by ID", "snippet,contentDetails,statistics,status"
	columns := []string{"id", "snippet.title", "snippet.channelTitle", "contentDetails.duration", "statistics.viewCount"}
	if stats {
		use, short, defaults = "stats <VIDEO_ID>...", "Get video counters", "statistics"
		columns = []string{"id", "statistics.viewCount", "statistics.likeCount", "statistics.commentCount"}
	}
	cmd := &cobra.Command{
		Use: use, Short: short, Args: minimumArgs(1),
		RunE: func(cmd *cobra.Command, ids []string) error {
			parts := partsOr(api.parts, defaults)
			if err := validateParts(parts, "fileDetails", "processingDetails", "suggestions"); err != nil {
				return err
			}
			client, err := a.authenticatedClient()
			if err != nil {
				return err
			}
			result := youtube.ListResult{}
			for _, group := range batch(ids, 50) {
				params := url.Values{"part": {parts}, "id": {strings.Join(group, ",")}}
				setValues(params, map[string]string{"hl": api.hl, "fields": api.fields})
				response, err := client.Get(cmd.Context(), "videos", params)
				if err != nil {
					return err
				}
				result.Requests++
				result.Items = append(result.Items, response.Items...)
			}
			return a.renderResult(result, columns)
		},
	}
	addAPIFlags(cmd, &api, true)
	return cmd
}

func (a *App) videoPopularCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var region, category string
	cmd := &cobra.Command{
		Use: "popular", Short: "List the most popular videos", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			parts := partsOr(api.parts, "snippet,contentDetails,statistics")
			if err := validateParts(parts, "fileDetails", "processingDetails", "suggestions"); err != nil {
				return err
			}
			params := url.Values{"part": {parts}, "chart": {"mostPopular"}}
			setValues(params, map[string]string{"regionCode": region, "videoCategoryId": category, "hl": api.hl, "fields": api.fields})
			return a.runList(cmd, "videos", params, flags, []string{"id", "snippet.title", "snippet.channelTitle", "statistics.viewCount"})
		},
	}
	addListFlags(cmd, &flags, 25, 50)
	addAPIFlags(cmd, &api, true)
	cmd.Flags().StringVar(&region, "region", "US", "ISO 3166-1 alpha-2 chart region")
	cmd.Flags().StringVar(&category, "category", "", "video category ID")
	return cmd
}

func (a *App) videoTrainabilityCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use: "trainability <VIDEO_ID>", Short: "Get third-party AI trainability (no key or quota required)", Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := a.client("")
			var result map[string]any
			if err := client.GetJSON(cmd.Context(), "videoTrainability", url.Values{"id": {args[0]}}, false, &result); err != nil {
				return err
			}
			columns := a.columns
			if len(columns) == 0 {
				columns = []string{"videoId", "permitted"}
			}
			return output.RenderObject(a.Out, result, a.outputFormat(), columns, a.noHeader)
		},
	}
	return cmd
}

func mapPathString(item map[string]any, path ...string) (string, bool) {
	var value any = item
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return "", false
		}
		value, ok = object[key]
		if !ok {
			return "", false
		}
	}
	result, ok := value.(string)
	return result, ok
}
