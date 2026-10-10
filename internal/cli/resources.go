package cli

import (
	"github.com/spf13/cobra"

	"open-yt-cli/internal/ops"
)

func (a *App) playlistCommand() *cobra.Command {
	playlist := &cobra.Command{Use: "playlist", Short: "Read playlists and playlist items"}
	playlist.AddCommand(a.playlistGetCommand(), a.playlistListCommand(), a.playlistItemsCommand())
	return playlist
}

func (a *App) playlistGetCommand() *cobra.Command {
	var in ops.PlaylistGetInput
	cmd := &cobra.Command{
		Use: "get <PLAYLIST_ID>...", Short: "Get playlists by ID", Args: minimumArgs(1),
		RunE: func(cmd *cobra.Command, ids []string) error {
			in.IDs = ids
			result, err := ops.PlaylistGet(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.title", "snippet.channelTitle", "contentDetails.itemCount", "status.privacyStatus"})
		},
	}
	addAPIFlags(cmd, &in.API)
	addHLFlag(cmd, &in.HL)
	return cmd
}

func (a *App) playlistListCommand() *cobra.Command {
	var in ops.PlaylistListInput
	cmd := &cobra.Command{
		Use: "list", Short: "List a channel's public playlists", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := ops.PlaylistList(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.title", "contentDetails.itemCount", "status.privacyStatus"})
		},
	}
	addPageFlags(cmd, &in.Page, 25, 50)
	addAPIFlags(cmd, &in.API)
	addHLFlag(cmd, &in.HL)
	cmd.Flags().StringVar(&in.Channel, "channel", "", "channel ID (required)")
	return cmd
}

func (a *App) playlistItemsCommand() *cobra.Command {
	var in ops.PlaylistItemsInput
	cmd := &cobra.Command{
		Use: "items <PLAYLIST_ID>", Short: "List items in a playlist", Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			in.Playlist = args[0]
			result, err := ops.PlaylistItems(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"snippet.position", "contentDetails.videoId", "snippet.title", "snippet.videoOwnerChannelTitle"})
		},
	}
	addPageFlags(cmd, &in.Page, 50, 50)
	addAPIFlags(cmd, &in.API)
	cmd.Flags().StringVar(&in.Video, "video", "", "only items for this video ID")
	return cmd
}

func (a *App) commentCommand() *cobra.Command {
	comment := &cobra.Command{Use: "comment", Short: "Read public comments and comment threads"}
	comment.AddCommand(a.commentGetCommand(), a.commentRepliesCommand(), a.commentThreadsCommand())
	return comment
}

func (a *App) commentGetCommand() *cobra.Command {
	var in ops.CommentGetInput
	cmd := &cobra.Command{
		Use: "get <COMMENT_ID>...", Short: "Get comments by ID", Args: minimumArgs(1),
		RunE: func(cmd *cobra.Command, ids []string) error {
			in.IDs = ids
			result, err := ops.CommentGet(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, commentColumns())
		},
	}
	addAPIFlags(cmd, &in.API)
	cmd.Flags().StringVar(&in.TextFormat, "text-format", "plainText", "plainText or html")
	return cmd
}

func (a *App) commentRepliesCommand() *cobra.Command {
	var in ops.CommentRepliesInput
	cmd := &cobra.Command{
		Use: "replies <PARENT_COMMENT_ID>", Short: "List replies to a top-level comment", Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			in.Parent = args[0]
			result, err := ops.CommentReplies(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, commentColumns())
		},
	}
	addPageFlags(cmd, &in.Page, 20, 100)
	addAPIFlags(cmd, &in.API)
	cmd.Flags().StringVar(&in.TextFormat, "text-format", "plainText", "plainText or html")
	return cmd
}

func (a *App) commentThreadsCommand() *cobra.Command {
	var in ops.CommentThreadsInput
	cmd := &cobra.Command{
		Use: "threads", Short: "List comment threads by video, channel, or IDs", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := ops.CommentThreads(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.topLevelComment.snippet.authorDisplayName", "snippet.topLevelComment.snippet.textDisplay", "snippet.totalReplyCount"})
		},
	}
	addPageFlags(cmd, &in.Page, 20, 100)
	addAPIFlags(cmd, &in.API)
	cmd.Flags().StringVar(&in.Video, "video", "", "video ID")
	cmd.Flags().StringVar(&in.Channel, "channel", "", "channel ID")
	cmd.Flags().StringVar(&in.ID, "id", "", "comma-separated thread IDs")
	cmd.Flags().StringVar(&in.Order, "order", "time", "time or relevance")
	cmd.Flags().StringVar(&in.Search, "search", "", "restrict to comments containing these terms")
	cmd.Flags().StringVar(&in.TextFormat, "text-format", "plainText", "plainText or html")
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
	var in ops.SubscriptionListInput
	cmd := &cobra.Command{
		Use: "list", Short: "List subscriptions by channel or subscription IDs", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := ops.SubscriptionList(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.resourceId.channelId", "snippet.title", "contentDetails.totalItemCount"})
		},
	}
	addPageFlags(cmd, &in.Page, 25, 50)
	addAPIFlags(cmd, &in.API)
	cmd.Flags().StringVar(&in.Channel, "channel", "", "subscriber channel ID")
	cmd.Flags().StringVar(&in.ID, "id", "", "comma-separated subscription IDs")
	cmd.Flags().StringVar(&in.Order, "order", "relevance", "alphabetical or relevance")
	cmd.Flags().StringVar(&in.ForChannel, "for-channel", "", "only subscriptions to this channel ID")
	return cmd
}

func (a *App) categoryCommand() *cobra.Command {
	category := &cobra.Command{Use: "category", Short: "Read YouTube video categories"}
	var in ops.CategoryListInput
	list := &cobra.Command{
		Use: "list", Short: "List categories by region or IDs", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := ops.CategoryList(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.title", "snippet.assignable"})
		},
	}
	addAPIFlags(list, &in.API)
	addHLFlag(list, &in.HL)
	list.Flags().StringVar(&in.Region, "region", "", "ISO 3166-1 alpha-2 region code")
	list.Flags().StringVar(&in.ID, "id", "", "comma-separated category IDs")
	category.AddCommand(list)
	return category
}

func (a *App) languageCommand() *cobra.Command {
	language := &cobra.Command{Use: "language", Short: "Read supported YouTube UI languages"}
	var in ops.I18nListInput
	list := &cobra.Command{
		Use: "list", Short: "List supported YouTube UI languages", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := ops.LanguageList(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.name"})
		},
	}
	addAPIFlags(list, &in.API)
	addHLFlag(list, &in.HL)
	language.AddCommand(list)
	return language
}

func (a *App) regionCommand() *cobra.Command {
	region := &cobra.Command{Use: "region", Short: "Read supported YouTube regions"}
	var in ops.I18nListInput
	list := &cobra.Command{
		Use: "list", Short: "List supported YouTube regions", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := ops.RegionList(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.name", "snippet.glName"})
		},
	}
	addAPIFlags(list, &in.API)
	addHLFlag(list, &in.HL)
	region.AddCommand(list)
	return region
}
