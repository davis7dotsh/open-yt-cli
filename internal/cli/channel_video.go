package cli

import (
	"github.com/spf13/cobra"

	"open-yt-cli/internal/ops"
	"open-yt-cli/internal/output"
)

func (a *App) channelCommand() *cobra.Command {
	channel := &cobra.Command{Use: "channel", Short: "Read channels, activities, sections, and uploads"}
	channel.AddCommand(a.channelGetCommand(), a.channelActivitiesCommand(), a.channelSectionsCommand(), a.channelUploadsCommand())
	return channel
}

func (a *App) channelGetCommand() *cobra.Command {
	var in ops.ChannelGetInput
	cmd := &cobra.Command{
		Use:   "get <REFERENCE>...",
		Short: "Get channels by ID, @handle, or common channel URL",
		Args:  minimumArgs(1),
		RunE: func(cmd *cobra.Command, references []string) error {
			in.Refs = references
			result, err := ops.ChannelGet(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.title", "statistics.subscriberCount", "statistics.videoCount", "statistics.viewCount"})
		},
	}
	addAPIFlags(cmd, &in.API)
	addHLFlag(cmd, &in.HL)
	return cmd
}

func (a *App) channelActivitiesCommand() *cobra.Command {
	var in ops.ChannelActivitiesInput
	cmd := &cobra.Command{
		Use:   "activities <CHANNEL>",
		Short: "List a channel's public activities",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			in.Channel = args[0]
			result, err := ops.ChannelActivities(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.publishedAt", "snippet.type", "snippet.title"})
		},
	}
	addPageFlags(cmd, &in.Page, 25, 50)
	addAPIFlags(cmd, &in.API)
	cmd.Flags().StringVar(&in.PublishedAfter, "published-after", "", "RFC 3339 lower publication bound")
	cmd.Flags().StringVar(&in.PublishedBefore, "published-before", "", "RFC 3339 upper publication bound")
	return cmd
}

func (a *App) channelSectionsCommand() *cobra.Command {
	var in ops.ChannelSectionsInput
	cmd := &cobra.Command{
		Use:   "sections [CHANNEL]",
		Short: "List a channel's sections or get section IDs",
		Args:  maximumArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 1 {
				in.Channel = args[0]
			}
			result, err := ops.ChannelSections(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.type", "snippet.position", "snippet.title"})
		},
	}
	addAPIFlags(cmd, &in.API)
	addHLFlag(cmd, &in.HL)
	cmd.Flags().StringVar(&in.ID, "id", "", "comma-separated channel section IDs")
	return cmd
}

func (a *App) channelUploadsCommand() *cobra.Command {
	var in ops.ChannelUploadsInput
	cmd := &cobra.Command{
		Use:   "uploads <CHANNEL>",
		Short: "Resolve and enumerate a channel's uploads playlist",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			in.Channel = args[0]
			result, err := ops.ChannelUploads(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"snippet.position", "contentDetails.videoId", "snippet.title", "snippet.publishedAt"})
		},
	}
	addPageFlags(cmd, &in.Page, 50, 50)
	addAPIFlags(cmd, &in.API)
	return cmd
}

func (a *App) videoCommand() *cobra.Command {
	video := &cobra.Command{Use: "video", Short: "Read videos, statistics, charts, and trainability"}
	video.AddCommand(a.videoGetCommand(false), a.videoGetCommand(true), a.videoPopularCommand(), a.videoTrainabilityCommand())
	return video
}

func (a *App) videoGetCommand(stats bool) *cobra.Command {
	var in ops.VideoGetInput
	use, short, get := "get <VIDEO_ID>...", "Get videos by ID", ops.VideoGet
	columns := []string{"id", "snippet.title", "snippet.channelTitle", "contentDetails.duration", "statistics.viewCount"}
	if stats {
		use, short, get = "stats <VIDEO_ID>...", "Get video counters", ops.VideoStats
		columns = []string{"id", "statistics.viewCount", "statistics.likeCount", "statistics.commentCount"}
	}
	cmd := &cobra.Command{
		Use: use, Short: short, Args: minimumArgs(1),
		RunE: func(cmd *cobra.Command, ids []string) error {
			in.IDs = ids
			result, err := get(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, columns)
		},
	}
	addAPIFlags(cmd, &in.API)
	addHLFlag(cmd, &in.HL)
	return cmd
}

func (a *App) videoPopularCommand() *cobra.Command {
	var in ops.VideoPopularInput
	cmd := &cobra.Command{
		Use: "popular", Short: "List the most popular videos", Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			result, err := ops.VideoPopular(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id", "snippet.title", "snippet.channelTitle", "statistics.viewCount"})
		},
	}
	addPageFlags(cmd, &in.Page, 25, 50)
	addAPIFlags(cmd, &in.API)
	addHLFlag(cmd, &in.HL)
	cmd.Flags().StringVar(&in.Region, "region", "US", "ISO 3166-1 alpha-2 chart region")
	cmd.Flags().StringVar(&in.Category, "category", "", "video category ID")
	return cmd
}

func (a *App) videoTrainabilityCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use: "trainability <VIDEO_ID>", Short: "Get third-party AI trainability (no key or quota required)", Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			result, err := ops.VideoTrainability(cmd.Context(), a.publicClient, ops.VideoTrainabilityInput{Video: args[0]})
			if err != nil {
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
