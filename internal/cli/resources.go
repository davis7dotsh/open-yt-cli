package cli

import (
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/youtube"
)

func (a *App) playlistCommand() *cobra.Command {
	playlist := &cobra.Command{Use: "playlist", Short: "Read playlists and playlist items"}
	playlist.AddCommand(a.playlistGetCommand(), a.playlistListCommand(), a.playlistItemsCommand())
	return playlist
}

func (a *App) playlistGetCommand() *cobra.Command {
	var api apiFlags
	cmd := &cobra.Command{
		Use: "get <PLAYLIST_ID>...", Short: "Get playlists by ID", Args: minimumArgs(1),
		RunE: func(cmd *cobra.Command, ids []string) error {
			client, err := a.authenticatedClient()
			if err != nil {
				return err
			}
			result := youtube.ListResult{}
			for _, group := range batch(ids, 50) {
				params := url.Values{"part": {partsOr(api.parts, "snippet,contentDetails,status")}, "id": {strings.Join(group, ",")}}
				setValues(params, map[string]string{"hl": api.hl, "fields": api.fields})
				response, err := client.Get(cmd.Context(), "playlists", params)
				if err != nil {
					return err
				}
				result.Items = append(result.Items, response.Items...)
				result.Requests++
			}
			return a.renderResult(result, []string{"id", "snippet.title", "snippet.channelTitle", "contentDetails.itemCount", "status.privacyStatus"})
		},
	}
	addAPIFlags(cmd, &api, true)
	return cmd
}

func (a *App) playlistListCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var channelID string
	cmd := &cobra.Command{
		Use: "list", Short: "List a channel's public playlists", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if channelID == "" {
				return &UsageError{Message: "--channel is required"}
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet,contentDetails,status")}, "channelId": {channelID}}
			setValues(params, map[string]string{"hl": api.hl, "fields": api.fields})
			return a.runList(cmd, "playlists", params, flags, []string{"id", "snippet.title", "contentDetails.itemCount", "status.privacyStatus"})
		},
	}
	addListFlags(cmd, &flags, 25, 50)
	addAPIFlags(cmd, &api, true)
	cmd.Flags().StringVar(&channelID, "channel", "", "channel ID (required)")
	return cmd
}

func (a *App) playlistItemsCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var videoID string
	cmd := &cobra.Command{
		Use: "items <PLAYLIST_ID>", Short: "List items in a playlist", Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			params := url.Values{"part": {partsOr(api.parts, "snippet,contentDetails,status")}, "playlistId": {args[0]}}
			setValues(params, map[string]string{"videoId": videoID, "fields": api.fields})
			return a.runList(cmd, "playlistItems", params, flags, []string{"snippet.position", "contentDetails.videoId", "snippet.title", "snippet.videoOwnerChannelTitle"})
		},
	}
	addListFlags(cmd, &flags, 50, 50)
	addAPIFlags(cmd, &api, false)
	cmd.Flags().StringVar(&videoID, "video", "", "only items for this video ID")
	return cmd
}

func (a *App) commentCommand() *cobra.Command {
	comment := &cobra.Command{Use: "comment", Short: "Read public comments and comment threads"}
	comment.AddCommand(a.commentGetCommand(), a.commentRepliesCommand(), a.commentThreadsCommand())
	return comment
}

func (a *App) commentGetCommand() *cobra.Command {
	var api apiFlags
	var textFormat string
	cmd := &cobra.Command{
		Use: "get <COMMENT_ID>...", Short: "Get comments by ID", Args: minimumArgs(1),
		RunE: func(cmd *cobra.Command, ids []string) error {
			if err := validateEnum("--text-format", textFormat, "plainText", "html"); err != nil {
				return err
			}
			client, err := a.authenticatedClient()
			if err != nil {
				return err
			}
			result := youtube.ListResult{}
			for _, group := range batch(ids, 100) {
				params := url.Values{"part": {partsOr(api.parts, "snippet")}, "id": {strings.Join(group, ",")}}
				setValues(params, map[string]string{"textFormat": textFormat, "fields": api.fields})
				response, err := client.Get(cmd.Context(), "comments", params)
				if err != nil {
					return err
				}
				result.Items = append(result.Items, response.Items...)
				result.Requests++
			}
			return a.renderResult(result, commentColumns())
		},
	}
	addAPIFlags(cmd, &api, false)
	cmd.Flags().StringVar(&textFormat, "text-format", "plainText", "plainText or html")
	return cmd
}

func (a *App) commentRepliesCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var textFormat string
	cmd := &cobra.Command{
		Use: "replies <PARENT_COMMENT_ID>", Short: "List replies to a top-level comment", Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validateEnum("--text-format", textFormat, "plainText", "html"); err != nil {
				return err
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet")}, "parentId": {args[0]}}
			setValues(params, map[string]string{"textFormat": textFormat, "fields": api.fields})
			return a.runList(cmd, "comments", params, flags, commentColumns())
		},
	}
	addListFlags(cmd, &flags, 20, 100)
	addAPIFlags(cmd, &api, false)
	cmd.Flags().StringVar(&textFormat, "text-format", "plainText", "plainText or html")
	return cmd
}

func (a *App) commentThreadsCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var videoID, channelID, ids, order, searchTerms, textFormat string
	cmd := &cobra.Command{
		Use: "threads", Short: "List comment threads by video, channel, or IDs", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := validateEnum("--text-format", textFormat, "plainText", "html"); err != nil {
				return err
			}
			if err := validateEnum("--order", order, "time", "relevance"); err != nil {
				return err
			}
			filters := 0
			for _, value := range []string{videoID, channelID, ids} {
				if value != "" {
					filters++
				}
			}
			if filters != 1 {
				return &UsageError{Message: "provide exactly one of --video, --channel, or --id"}
			}
			if ids != "" && (order != "time" || searchTerms != "") {
				return &UsageError{Message: "--order and --search are incompatible with --id"}
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet,replies")}}
			setValues(params, map[string]string{"videoId": videoID, "allThreadsRelatedToChannelId": channelID, "id": ids, "order": order, "searchTerms": searchTerms, "textFormat": textFormat, "fields": api.fields})
			return a.runList(cmd, "commentThreads", params, flags, []string{"id", "snippet.topLevelComment.snippet.authorDisplayName", "snippet.topLevelComment.snippet.textDisplay", "snippet.totalReplyCount"})
		},
	}
	addListFlags(cmd, &flags, 20, 100)
	addAPIFlags(cmd, &api, false)
	cmd.Flags().StringVar(&videoID, "video", "", "video ID")
	cmd.Flags().StringVar(&channelID, "channel", "", "channel ID")
	cmd.Flags().StringVar(&ids, "id", "", "comma-separated thread IDs")
	cmd.Flags().StringVar(&order, "order", "time", "time or relevance")
	cmd.Flags().StringVar(&searchTerms, "search", "", "restrict to comments containing these terms")
	cmd.Flags().StringVar(&textFormat, "text-format", "plainText", "plainText or html")
	return cmd
}

func commentColumns() []string {
	return []string{"id", "snippet.authorDisplayName", "snippet.textDisplay", "snippet.likeCount", "snippet.publishedAt"}
}

func (a *App) subscriptionCommand() *cobra.Command {
	subscription := &cobra.Command{Use: "subscription", Short: "Read public channel subscriptions"}
	subscription.AddCommand(a.subscriptionListCommand())
	return subscription
}

func (a *App) subscriptionListCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var channelID, ids, order, forChannel string
	cmd := &cobra.Command{
		Use: "list", Short: "List subscriptions by channel or subscription IDs", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := validateParts(partsOr(api.parts, "snippet,contentDetails"), "subscriberSnippet"); err != nil {
				return err
			}
			if err := validateEnum("--order", order, "alphabetical", "relevance"); err != nil {
				return err
			}
			if (channelID == "") == (ids == "") {
				return &UsageError{Message: "provide exactly one of --channel or --id"}
			}
			if ids != "" && (forChannel != "" || order != "relevance") {
				return &UsageError{Message: "--for-channel and --order are incompatible with --id"}
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet,contentDetails")}}
			setValues(params, map[string]string{"channelId": channelID, "id": ids, "order": order, "forChannelId": forChannel, "fields": api.fields})
			return a.runList(cmd, "subscriptions", params, flags, []string{"id", "snippet.resourceId.channelId", "snippet.title", "contentDetails.totalItemCount"})
		},
	}
	addListFlags(cmd, &flags, 25, 50)
	addAPIFlags(cmd, &api, false)
	cmd.Flags().StringVar(&channelID, "channel", "", "subscriber channel ID")
	cmd.Flags().StringVar(&ids, "id", "", "comma-separated subscription IDs")
	cmd.Flags().StringVar(&order, "order", "relevance", "alphabetical or relevance")
	cmd.Flags().StringVar(&forChannel, "for-channel", "", "only subscriptions to this channel ID")
	return cmd
}

func (a *App) categoryCommand() *cobra.Command {
	category := &cobra.Command{Use: "category", Short: "Read YouTube video categories"}
	var api apiFlags
	var region, ids string
	list := &cobra.Command{
		Use: "list", Short: "List categories by region or IDs", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if (region == "") == (ids == "") {
				return &UsageError{Message: "provide exactly one of --region or --id"}
			}
			params := url.Values{"part": {partsOr(api.parts, "snippet")}}
			setValues(params, map[string]string{"regionCode": region, "id": ids, "hl": api.hl, "fields": api.fields})
			return a.runList(cmd, "videoCategories", params, listFlags{}, []string{"id", "snippet.title", "snippet.assignable"})
		},
	}
	addAPIFlags(list, &api, true)
	list.Flags().StringVar(&region, "region", "", "ISO 3166-1 alpha-2 region code")
	list.Flags().StringVar(&ids, "id", "", "comma-separated category IDs")
	category.AddCommand(list)
	return category
}

func (a *App) languageCommand() *cobra.Command {
	language := &cobra.Command{Use: "language", Short: "Read supported YouTube UI languages"}
	var api apiFlags
	list := &cobra.Command{
		Use: "list", Short: "List supported YouTube UI languages", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			params := url.Values{"part": {partsOr(api.parts, "snippet")}}
			setValues(params, map[string]string{"hl": api.hl, "fields": api.fields})
			return a.runList(cmd, "i18nLanguages", params, listFlags{}, []string{"id", "snippet.name"})
		},
	}
	addAPIFlags(list, &api, true)
	language.AddCommand(list)
	return language
}

func (a *App) regionCommand() *cobra.Command {
	region := &cobra.Command{Use: "region", Short: "Read supported YouTube regions"}
	var api apiFlags
	list := &cobra.Command{
		Use: "list", Short: "List supported YouTube regions", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			params := url.Values{"part": {partsOr(api.parts, "snippet")}}
			setValues(params, map[string]string{"hl": api.hl, "fields": api.fields})
			return a.runList(cmd, "i18nRegions", params, listFlags{}, []string{"id", "snippet.name", "snippet.glName"})
		},
	}
	addAPIFlags(list, &api, true)
	region.AddCommand(list)
	return region
}
