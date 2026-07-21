package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/config"
	"open-yt-cli/internal/youtube"
)

type analyticsFlags struct {
	start   string
	end     string
	filters string
	sort    string
	limit   int
}

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
	var flags analyticsFlags
	var metrics, dimensions string
	cmd := &cobra.Command{
		Use:   "report",
		Short: "Run a raw YouTube Analytics report",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			metricList := csvValues(metrics)
			if len(metricList) == 0 {
				return &UsageError{Message: "--metrics is required"}
			}
			return a.runAnalytics(cmd, flags, analytics.Query{
				Metrics:    metricList,
				Dimensions: csvValues(dimensions),
			}, append(csvValues(dimensions), metricList...))
		},
	}
	a.addAnalyticsFlags(cmd, &flags)
	cmd.Flags().StringVar(&metrics, "metrics", "", "required comma-separated Analytics metrics")
	cmd.Flags().StringVar(&dimensions, "dimensions", "", "comma-separated Analytics dimensions")
	return cmd
}

func (a *App) analyticsOverviewCommand() *cobra.Command {
	var flags analyticsFlags
	var by string
	// Note: thumbnail impressions and impression CTR are Studio-only; the
	// Analytics API has no such metrics.
	metrics := []string{"views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained"}
	cmd := &cobra.Command{
		Use:   "overview",
		Short: "Show channel views, watch time, retention, and subscribers gained",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := validateEnum("--by", by, "day", "month"); err != nil {
				return err
			}
			dimensions := csvValues(by)
			return a.runAnalytics(cmd, flags, analytics.Query{Metrics: metrics, Dimensions: dimensions}, append(dimensions, metrics...))
		},
	}
	a.addAnalyticsFlags(cmd, &flags)
	cmd.Flags().StringVar(&by, "by", "", "group by day or month")
	return cmd
}

func (a *App) analyticsVideoCommand() *cobra.Command {
	var flags analyticsFlags
	metrics := []string{"views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "subscribersGained"}
	cmd := &cobra.Command{
		Use:   "video <VIDEO_ID>",
		Short: "Show core analytics metrics for one owned video",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			query := analytics.Query{Metrics: metrics, Filters: "video==" + args[0]}
			return a.runAnalytics(cmd, flags, query, metrics)
		},
	}
	a.addAnalyticsFlags(cmd, &flags)
	return cmd
}

func (a *App) analyticsTrafficSourcesCommand() *cobra.Command {
	var flags analyticsFlags
	metrics := []string{"views", "estimatedMinutesWatched"}
	dimensions := []string{"insightTrafficSourceType"}
	cmd := &cobra.Command{
		Use:   "traffic-sources",
		Short: "Break views and watch time down by traffic source",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runAnalytics(cmd, flags, analytics.Query{Metrics: metrics, Dimensions: dimensions}, append(dimensions, metrics...))
		},
	}
	a.addAnalyticsFlags(cmd, &flags)
	return cmd
}

func (a *App) analyticsDemographicsCommand() *cobra.Command {
	var flags analyticsFlags
	metrics := []string{"viewerPercentage"}
	dimensions := []string{"ageGroup", "gender"}
	cmd := &cobra.Command{
		Use:   "demographics",
		Short: "Break viewer percentage down by age group and gender",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runAnalytics(cmd, flags, analytics.Query{Metrics: metrics, Dimensions: dimensions}, append(dimensions, metrics...))
		},
	}
	a.addAnalyticsFlags(cmd, &flags)
	return cmd
}

func (a *App) addAnalyticsFlags(cmd *cobra.Command, flags *analyticsFlags) {
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}
	end := now().UTC().AddDate(0, 0, -1)
	start := end.AddDate(0, 0, -27)
	cmd.Flags().StringVar(&flags.start, "start", start.Format(time.DateOnly), "report start date (YYYY-MM-DD; default: 28 days ending yesterday)")
	cmd.Flags().StringVar(&flags.end, "end", end.Format(time.DateOnly), "report end date (YYYY-MM-DD; default: yesterday)")
	cmd.Flags().StringVar(&flags.filters, "filters", "", "Analytics filter expression")
	cmd.Flags().StringVar(&flags.sort, "sort", "", "comma-separated Analytics sort fields")
	cmd.Flags().IntVar(&flags.limit, "limit", analytics.MaxResults, fmt.Sprintf("maximum rows (1-%d)", analytics.MaxResults))
}

func (a *App) runAnalytics(cmd *cobra.Command, flags analyticsFlags, query analytics.Query, defaultColumns []string) error {
	if err := validateAnalyticsDates(flags.start, flags.end); err != nil {
		return err
	}
	if flags.limit < 1 || flags.limit > analytics.MaxResults {
		return &UsageError{Message: fmt.Sprintf("--limit must be between 1 and %d", analytics.MaxResults)}
	}
	credentials, err := config.Load()
	if err != nil {
		return err
	}
	if credentials.OAuth == nil {
		return fmt.Errorf("%w; analytics requires OAuth", youtube.ErrMissingOAuth)
	}
	source, err := a.oauthTokenSource(credentials.OAuth)
	if err != nil {
		return err
	}
	client := analytics.NewClient(source.AccessToken, a.timeout)
	if a.AnalyticsBaseURL != "" {
		client.SetBaseURL(a.AnalyticsBaseURL)
	}
	if a.HTTPClient != nil {
		client.SetHTTPClient(a.HTTPClient)
	}
	query.StartDate = flags.start
	query.EndDate = flags.end
	if query.Filters == "" {
		query.Filters = flags.filters
	} else if flags.filters != "" {
		query.Filters += ";" + flags.filters
	}
	query.Sort = flags.sort
	query.Limit = flags.limit
	result, err := client.Report(cmd.Context(), query)
	if err != nil {
		return oauthAuthHint(err)
	}
	return a.renderResult(result, defaultColumns)
}

func validateAnalyticsDates(start, end string) error {
	startDate, err := time.Parse(time.DateOnly, start)
	if err != nil || startDate.Format(time.DateOnly) != start {
		return &UsageError{Message: "--start must use YYYY-MM-DD"}
	}
	endDate, err := time.Parse(time.DateOnly, end)
	if err != nil || endDate.Format(time.DateOnly) != end {
		return &UsageError{Message: "--end must use YYYY-MM-DD"}
	}
	if startDate.After(endDate) {
		return &UsageError{Message: "--start cannot be after --end"}
	}
	return nil
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
