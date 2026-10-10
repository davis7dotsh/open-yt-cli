package ops

import (
	"cmp"
	"context"
	"regexp"
	"strings"
	"time"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/youtube"
)

var analyticsVideoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// AnalyticsInput is shared by every analytics report.
type AnalyticsInput struct {
	Channel    string `json:"channel,omitempty" jsonschema:"connected channel ID or @handle; empty means the default channel"`
	Start      string `json:"start,omitempty" jsonschema:"inclusive start date YYYY-MM-DD (default: 28 days ending yesterday, UTC)"`
	End        string `json:"end,omitempty" jsonschema:"inclusive end date YYYY-MM-DD (default: yesterday, UTC)"`
	Filters    string `json:"filters,omitempty" jsonschema:"Analytics filter expression, e.g. country==US"`
	Sort       string `json:"sort,omitempty" jsonschema:"comma-separated sort fields; prefix descending fields with -"`
	PageSize   int    `json:"pageSize,omitempty" jsonschema:"rows per request (1-200, default 200)"`
	StartIndex int    `json:"startIndex,omitempty" jsonschema:"1-based first row; pass a previous nextStartIndex to resume"`
	All        bool   `json:"all,omitempty" jsonschema:"fetch every page; time-grouped reports are fetched in date order"`
	Limit      int    `json:"limit,omitempty" jsonschema:"maximum total rows; 0 means no cap"`
	// Now is the clock behind the default dates; nil means time.Now.
	Now func() time.Time `json:"-"`
}

type AnalyticsReportInput struct {
	Metrics    string `json:"metrics" jsonschema:"comma-separated Analytics metrics, e.g. views,estimatedMinutesWatched"`
	Dimensions string `json:"dimensions,omitempty" jsonschema:"comma-separated Analytics dimensions, e.g. day or country"`
	AnalyticsInput
}

func AnalyticsReport(ctx context.Context, analyticsFor AnalyticsClient, in AnalyticsReportInput) (youtube.ListResult, error) {
	metrics := csvValues(in.Metrics)
	if len(metrics) == 0 {
		return youtube.ListResult{}, &InputError{Message: "metrics is required"}
	}
	return report(ctx, analyticsFor, in.AnalyticsInput, analytics.Query{Metrics: metrics, Dimensions: csvValues(in.Dimensions)})
}

type AnalyticsOverviewInput struct {
	By string `json:"by,omitempty" jsonschema:"group by day or month"`
	AnalyticsInput
}

// AnalyticsOverview reports channel views, engaged views, watch time,
// retention, and subscribers gained. Thumbnail impressions and impression CTR
// are Studio-only; the Analytics API has no such metrics.
func AnalyticsOverview(ctx context.Context, analyticsFor AnalyticsClient, in AnalyticsOverviewInput) (youtube.ListResult, error) {
	if err := validateEnum("by", in.By, "day", "month"); err != nil {
		return youtube.ListResult{}, err
	}
	metrics := []string{"views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained"}
	return report(ctx, analyticsFor, in.AnalyticsInput, analytics.Query{Metrics: metrics, Dimensions: csvValues(in.By)})
}

type AnalyticsVideoInput struct {
	Video string `json:"video" jsonschema:"ID of a video owned by the channel"`
	AnalyticsInput
}

func AnalyticsVideo(ctx context.Context, analyticsFor AnalyticsClient, in AnalyticsVideoInput) (youtube.ListResult, error) {
	if !analyticsVideoIDPattern.MatchString(in.Video) {
		return youtube.ListResult{}, &InputError{Message: "video may contain only letters, digits, underscores, and hyphens"}
	}
	metrics := []string{"views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "subscribersGained"}
	return report(ctx, analyticsFor, in.AnalyticsInput, analytics.Query{Metrics: metrics, Filters: "video==" + in.Video})
}

func AnalyticsTrafficSources(ctx context.Context, analyticsFor AnalyticsClient, in AnalyticsInput) (youtube.ListResult, error) {
	return report(ctx, analyticsFor, in, analytics.Query{Metrics: []string{"views", "estimatedMinutesWatched"}, Dimensions: []string{"insightTrafficSourceType"}})
}

func AnalyticsDemographics(ctx context.Context, analyticsFor AnalyticsClient, in AnalyticsInput) (youtube.ListResult, error) {
	return report(ctx, analyticsFor, in, analytics.Query{Metrics: []string{"viewerPercentage"}, Dimensions: []string{"ageGroup", "gender"}})
}

// report completes a preset query with the shared input and runs it.
func report(ctx context.Context, analyticsFor AnalyticsClient, in AnalyticsInput, query analytics.Query) (youtube.ListResult, error) {
	now := time.Now
	if in.Now != nil {
		now = in.Now
	}
	end := now().UTC().AddDate(0, 0, -1)
	in.Start = cmp.Or(in.Start, end.AddDate(0, 0, -27).Format(time.DateOnly))
	in.End = cmp.Or(in.End, end.Format(time.DateOnly))
	in.PageSize = cmp.Or(in.PageSize, analytics.MaxResults)
	in.StartIndex = cmp.Or(in.StartIndex, 1)
	if err := firstError(
		validateAnalyticsDates(in.Start, in.End),
		invalidIf(in.Limit < 0, "limit must be non-negative"),
		invalidIf(in.PageSize < 1 || in.PageSize > analytics.MaxResults, "pageSize must be between 1 and %d", analytics.MaxResults),
		invalidIf(in.StartIndex < 1, "startIndex must be at least 1"),
		validateAllSort(in, query.Dimensions),
	); err != nil {
		return youtube.ListResult{}, err
	}
	client, err := analyticsFor(ctx, in.Channel)
	if err != nil {
		return youtube.ListResult{}, err
	}
	query.StartDate = in.Start
	query.EndDate = in.End
	if query.Filters == "" {
		query.Filters = in.Filters
	} else if in.Filters != "" {
		query.Filters += ";" + in.Filters
	}
	query.Sort = in.Sort
	query.Limit = in.Limit
	query.PageSize = in.PageSize
	query.StartIndex = in.StartIndex
	query.All = in.All
	return client.Report(ctx, query)
}

// validateAllSort rejects sorts that all cannot preserve: time-grouped
// reports are fetched in date windows, so only the time order survives.
func validateAllSort(in AnalyticsInput, dimensions []string) error {
	if !in.All {
		return nil
	}
	timeDimension := ""
	for _, dimension := range dimensions {
		if dimension == "day" {
			timeDimension = "day"
			break
		}
		if dimension == "month" {
			timeDimension = "month"
		}
	}
	sort := strings.TrimSpace(in.Sort)
	return invalidIf(timeDimension != "" && sort != "" && sort != timeDimension && sort != "-"+timeDimension,
		"with all and a %s dimension, sort must be %s or -%s", timeDimension, timeDimension, timeDimension)
}

func validateAnalyticsDates(start, end string) error {
	startDate, err := time.Parse(time.DateOnly, start)
	if err != nil || startDate.Format(time.DateOnly) != start {
		return &InputError{Message: "start must use YYYY-MM-DD"}
	}
	endDate, err := time.Parse(time.DateOnly, end)
	if err != nil || endDate.Format(time.DateOnly) != end {
		return &InputError{Message: "end must use YYYY-MM-DD"}
	}
	return invalidIf(startDate.After(endDate), "start cannot be after end")
}
