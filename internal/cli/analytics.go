package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/config"
	"open-yt-cli/internal/ops"
	"open-yt-cli/internal/youtube"
)

func (a *App) analyticsCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "analytics",
		Short: "Read analytics for your authorized YouTube channel (OAuth required)",
	}
	command.AddCommand(
		a.analyticsReportCommand(),
		a.analyticsOverviewCommand(),
		a.analyticsVideoCommand(),
		a.analyticsTrafficSourcesCommand(),
		a.analyticsDemographicsCommand(),
	)
	return command
}

func (a *App) analyticsReportCommand() *cobra.Command {
	var in ops.AnalyticsReportInput
	cmd := &cobra.Command{
		Use:   "report",
		Short: "Run a raw YouTube Analytics report",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			in.Now = a.Now
			result, err := ops.AnalyticsReport(cmd.Context(), a.analyticsClient, in)
			return a.renderReport(result, err, append(csvValues(in.Dimensions), csvValues(in.Metrics)...))
		},
	}
	addAnalyticsFlags(cmd, &in.AnalyticsInput)
	cmd.Flags().StringVar(&in.Metrics, "metrics", "", "required comma-separated Analytics metrics")
	cmd.Flags().StringVar(&in.Dimensions, "dimensions", "", "comma-separated Analytics dimensions")
	return cmd
}

func (a *App) analyticsOverviewCommand() *cobra.Command {
	var in ops.AnalyticsOverviewInput
	cmd := &cobra.Command{
		Use:   "overview",
		Short: "Show channel views, engaged views, watch time, retention, and subscribers gained",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			in.Now = a.Now
			result, err := ops.AnalyticsOverview(cmd.Context(), a.analyticsClient, in)
			return a.renderReport(result, err, append(csvValues(in.By), "views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained"))
		},
	}
	addAnalyticsFlags(cmd, &in.AnalyticsInput)
	cmd.Flags().StringVar(&in.By, "by", "", "group by day or month")
	return cmd
}

func (a *App) analyticsVideoCommand() *cobra.Command {
	var in ops.AnalyticsVideoInput
	cmd := &cobra.Command{
		Use:   "video <VIDEO_ID>",
		Short: "Show core analytics metrics for one owned video",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			in.Video, in.Now = args[0], a.Now
			result, err := ops.AnalyticsVideo(cmd.Context(), a.analyticsClient, in)
			return a.renderReport(result, err, []string{"views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "subscribersGained"})
		},
	}
	addAnalyticsFlags(cmd, &in.AnalyticsInput)
	return cmd
}

func (a *App) analyticsTrafficSourcesCommand() *cobra.Command {
	var in ops.AnalyticsInput
	cmd := &cobra.Command{
		Use:   "traffic-sources",
		Short: "Break views and watch time down by traffic source",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			in.Now = a.Now
			result, err := ops.AnalyticsTrafficSources(cmd.Context(), a.analyticsClient, in)
			return a.renderReport(result, err, []string{"insightTrafficSourceType", "views", "estimatedMinutesWatched"})
		},
	}
	addAnalyticsFlags(cmd, &in)
	return cmd
}

func (a *App) analyticsDemographicsCommand() *cobra.Command {
	var in ops.AnalyticsInput
	cmd := &cobra.Command{
		Use:   "demographics",
		Short: "Break viewer percentage down by age group and gender",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			in.Now = a.Now
			result, err := ops.AnalyticsDemographics(cmd.Context(), a.analyticsClient, in)
			return a.renderReport(result, err, []string{"ageGroup", "gender", "viewerPercentage"})
		},
	}
	addAnalyticsFlags(cmd, &in)
	return cmd
}

func addAnalyticsFlags(cmd *cobra.Command, in *ops.AnalyticsInput) {
	cmd.Flags().StringVar(&in.Start, "start", "", "report start date (YYYY-MM-DD; default: 28 days ending yesterday)")
	cmd.Flags().StringVar(&in.End, "end", "", "report end date (YYYY-MM-DD; default: yesterday)")
	cmd.Flags().StringVar(&in.Filters, "filters", "", "Analytics filter expression")
	cmd.Flags().StringVar(&in.Sort, "sort", "", "comma-separated Analytics sort fields")
	cmd.Flags().IntVar(&in.PageSize, "page-size", analytics.MaxResults, fmt.Sprintf("rows per request (1-%d)", analytics.MaxResults))
	cmd.Flags().IntVar(&in.StartIndex, "start-index", 1, "1-based index of the first report row")
	cmd.Flags().BoolVar(&in.All, "all", false, "fetch all report pages")
	cmd.Flags().IntVar(&in.Limit, "limit", 0, "maximum total rows (0 = no cap; requires --all to fetch multiple pages)")
}

// analyticsClient is the CLI's ops.AnalyticsClient. Locally there is one
// OAuth grant, so only its channel is available.
func (a *App) analyticsClient(_ context.Context, channel string) (*analytics.Client, error) {
	if channel != "" {
		return nil, &UsageError{Message: "local mode uses the channel authorized by `oytc login --oauth`; omit channel"}
	}
	credentials, err := config.Load()
	if err != nil {
		return nil, err
	}
	if credentials.OAuth == nil {
		return nil, fmt.Errorf("%w; analytics requires OAuth", youtube.ErrMissingOAuth)
	}
	source, err := a.oauthTokenSource(credentials.OAuth)
	if err != nil {
		return nil, err
	}
	client := analytics.NewClient(source.AccessToken, a.timeout)
	if a.AnalyticsBaseURL != "" {
		client.SetBaseURL(a.AnalyticsBaseURL)
	}
	if a.HTTPClient != nil {
		client.SetHTTPClient(a.HTTPClient)
	}
	return client, nil
}

func (a *App) renderReport(result youtube.ListResult, err error, defaultColumns []string) error {
	if err != nil {
		return oauthAuthHint(err)
	}
	return a.renderResult(result, defaultColumns)
}

func csvValues(value string) []string {
	var values []string
	for _, entry := range strings.Split(value, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			values = append(values, entry)
		}
	}
	return values
}
