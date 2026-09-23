// Package analytics provides a read-only YouTube Analytics reports client.
package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"open-yt-cli/internal/youtube"
)

const (
	DefaultBaseURL = "https://youtubeanalytics.googleapis.com/v2"
	MaxResults     = 200
	// MaxReportRequests stops a server that keeps returning full pages forever.
	MaxReportRequests = 10000
)

type ColumnHeader struct {
	Name       string `json:"name"`
	ColumnType string `json:"columnType"`
	DataType   string `json:"dataType"`
}

type Response struct {
	ColumnHeaders []ColumnHeader `json:"columnHeaders"`
	Rows          [][]any        `json:"rows"`
}

type Query struct {
	StartDate  string
	EndDate    string
	Metrics    []string
	Dimensions []string
	Filters    string
	Sort       string
	Limit      int
	PageSize   int
	StartIndex int
	All        bool
}

type Client struct {
	client *youtube.Client
}

func NewClient(source youtube.TokenSource, timeout time.Duration) *Client {
	client := youtube.NewClient("", timeout)
	client.BaseURL = DefaultBaseURL
	client.TokenSource = source
	return &Client{client: client}
}

func (c *Client) SetBaseURL(baseURL string) {
	c.client.BaseURL = baseURL
}

func (c *Client) SetHTTPClient(client *http.Client) {
	c.client.HTTPClient = client
}

func (c *Client) Report(ctx context.Context, query Query) (youtube.ListResult, error) {
	if len(query.Metrics) == 0 {
		return youtube.ListResult{}, errors.New("analytics metrics cannot be empty")
	}
	if query.Limit < 0 {
		return youtube.ListResult{}, errors.New("analytics limit must be non-negative")
	}
	pageSize := query.PageSize
	if pageSize == 0 {
		pageSize = MaxResults
	}
	if pageSize < 1 || pageSize > MaxResults {
		return youtube.ListResult{}, fmt.Errorf("analytics page size must be between 1 and %d", MaxResults)
	}
	startIndex := query.StartIndex
	if startIndex == 0 {
		startIndex = 1
	}
	if startIndex < 1 {
		return youtube.ListResult{}, errors.New("analytics start index must be at least 1")
	}
	query.StartIndex = startIndex
	if query.All {
		if dimension := reportTimeDimension(query.Dimensions); dimension != "" {
			query.Sort = strings.TrimSpace(query.Sort)
			if query.Sort != "" && query.Sort != dimension && query.Sort != "-"+dimension {
				return youtube.ListResult{}, fmt.Errorf("analytics --all with a %s dimension supports only --sort %s or --sort -%s; other sorts cannot be preserved across date windows", dimension, dimension, dimension)
			}
			return c.reportByTimeWindows(ctx, query, pageSize, dimension)
		}
	}
	return c.reportByIndex(ctx, query, pageSize)
}

func (c *Client) reportByIndex(ctx context.Context, query Query, pageSize int) (youtube.ListResult, error) {
	startIndex := query.StartIndex
	result := youtube.ListResult{Items: make([]map[string]any, 0)}
	sawFullPage := false
	hasTimeDimension := reportTimeDimension(query.Dimensions) != ""
	for {
		requestSize := pageSize
		if remaining := query.Limit - len(result.Items); query.Limit > 0 && remaining < requestSize {
			requestSize = remaining
		}
		response, err := c.reportPage(ctx, query, query.StartDate, query.EndDate, startIndex, requestSize)
		if err != nil {
			return result, err
		}
		result.Requests++
		if len(response.Rows) > requestSize {
			return result, fmt.Errorf("analytics returned %d rows after requesting at most %d", len(response.Rows), requestSize)
		}
		result.Items = append(result.Items, Normalize(response)...)
		result.NextStartIndex = 0
		if len(response.Rows) < requestSize {
			// The API may omit time rows at an offset even when it returns a
			// nonempty short page. A short page after a full --all page can
			// also hide rows without a safe date-window split.
			result.CompletionUncertain = (query.All && sawFullPage) || (query.StartIndex > 1 && (hasTimeDimension || len(response.Rows) == 0))
			break
		}
		sawFullPage = true
		if startIndex > math.MaxInt-len(response.Rows) {
			return result, errors.New("analytics start index exceeds the supported range")
		}
		startIndex += len(response.Rows)
		// A full page might be the final page; another request is needed to
		// establish whether more rows exist.
		result.NextStartIndex = startIndex
		if !query.All && hasTimeDimension {
			// The API's offset can skip known time rows, while --all uses a
			// chronological order. This API index cannot safely resume that order.
			result.NextStartIndex = 0
			result.CompletionUncertain = true
		}
		if !query.All || (query.Limit > 0 && len(result.Items) >= query.Limit) {
			break
		}
		if result.Requests >= MaxReportRequests {
			return result, fmt.Errorf("analytics pagination did not terminate after %d requests; narrow the date range or use --limit", MaxReportRequests)
		}
	}
	return result, nil
}

func (c *Client) reportPage(ctx context.Context, query Query, startDate, endDate string, startIndex, pageSize int) (Response, error) {
	params := url.Values{
		"ids":        {"channel==MINE"},
		"startDate":  {startDate},
		"endDate":    {endDate},
		"metrics":    {strings.Join(query.Metrics, ",")},
		"maxResults": {strconv.Itoa(pageSize)},
		"startIndex": {strconv.Itoa(startIndex)},
	}
	if len(query.Dimensions) > 0 {
		params.Set("dimensions", strings.Join(query.Dimensions, ","))
	}
	if query.Filters != "" {
		params.Set("filters", query.Filters)
	}
	if query.Sort != "" {
		params.Set("sort", query.Sort)
	}
	var response Response
	if err := c.client.GetJSON(ctx, "reports", params, true, &response); err != nil {
		return Response{}, err
	}
	return response, nil
}

func reportTimeDimension(dimensions []string) string {
	for _, dimension := range dimensions {
		if dimension == "day" {
			return "day"
		}
	}
	for _, dimension := range dimensions {
		if dimension == "month" {
			return "month"
		}
	}
	return ""
}

type reportWindow struct {
	start time.Time
	end   time.Time
}

func (c *Client) reportByTimeWindows(ctx context.Context, query Query, pageSize int, dimension string) (youtube.ListResult, error) {
	start, err := time.Parse(time.DateOnly, query.StartDate)
	if err != nil {
		return youtube.ListResult{}, fmt.Errorf("invalid analytics start date: %w", err)
	}
	end, err := time.Parse(time.DateOnly, query.EndDate)
	if err != nil {
		return youtube.ListResult{}, fmt.Errorf("invalid analytics end date: %w", err)
	}
	if start.After(end) {
		return youtube.ListResult{}, errors.New("analytics start date cannot be after end date")
	}
	reverse := query.Sort == "-"+dimension
	windows := reportDateWindows(start, end, dimension, reverse, pageSize)
	query.Sort = "" // Sort locally; the Analytics API fails on some long sorted reports.
	result := youtube.ListResult{Items: make([]map[string]any, 0)}
	skip := query.StartIndex - 1
	for windowIndex, window := range windows {
		rows, err := c.completeTimeWindow(ctx, query, pageSize, window, dimension, reverse, &result)
		if err != nil {
			return result, err
		}
		for rowIndex, row := range rows {
			if skip > 0 {
				skip--
				continue
			}
			result.Items = append(result.Items, row)
			if query.Limit > 0 && len(result.Items) == query.Limit {
				if rowIndex+1 < len(rows) || windowIndex+1 < len(windows) {
					if query.StartIndex > math.MaxInt-len(result.Items) {
						return result, errors.New("analytics start index exceeds the supported range")
					}
					result.NextStartIndex = query.StartIndex + len(result.Items)
				}
				return result, nil
			}
		}
	}
	return result, nil
}

func reportDateWindows(start, end time.Time, dimension string, reverse bool, pageSize int) []reportWindow {
	var windows []reportWindow
	windowDays := 28
	if pageSize <= windowDays {
		windowDays = pageSize - 1
		if windowDays < 1 {
			windowDays = 1
		}
	}
	if reverse {
		for current := end; !current.Before(start); {
			windowStart := current.AddDate(0, 0, 1-windowDays)
			if dimension == "month" {
				windowStart = time.Date(current.Year(), current.Month(), 1, 0, 0, 0, 0, time.UTC)
			}
			if windowStart.Before(start) {
				windowStart = start
			}
			windows = append(windows, reportWindow{start: windowStart, end: current})
			current = windowStart.AddDate(0, 0, -1)
		}
		return windows
	}
	for current := start; !current.After(end); {
		windowEnd := current.AddDate(0, 0, windowDays-1)
		if dimension == "month" {
			windowEnd = time.Date(current.Year(), current.Month()+1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -1)
		}
		if windowEnd.After(end) {
			windowEnd = end
		}
		windows = append(windows, reportWindow{start: current, end: windowEnd})
		current = windowEnd.AddDate(0, 0, 1)
	}
	return windows
}

func (c *Client) completeTimeWindow(ctx context.Context, query Query, pageSize int, window reportWindow, dimension string, reverse bool, result *youtube.ListResult) ([]map[string]any, error) {
	if result.Requests >= MaxReportRequests {
		return nil, fmt.Errorf("analytics pagination did not terminate after %d requests; narrow the date range or use --limit", MaxReportRequests)
	}
	response, err := c.reportPage(ctx, query, window.start.Format(time.DateOnly), window.end.Format(time.DateOnly), 1, pageSize)
	if err != nil {
		return nil, err
	}
	result.Requests++
	if len(response.Rows) > pageSize {
		return nil, fmt.Errorf("analytics returned %d rows after requesting at most %d", len(response.Rows), pageSize)
	}
	if len(response.Rows) == pageSize && dimension == "day" && window.start.Before(window.end) {
		days := int(window.end.Sub(window.start).Hours()/24) + 1
		leftEnd := window.start.AddDate(0, 0, days/2-1)
		left := reportWindow{start: window.start, end: leftEnd}
		right := reportWindow{start: leftEnd.AddDate(0, 0, 1), end: window.end}
		if reverse {
			left, right = right, left
		}
		first, err := c.completeTimeWindow(ctx, query, pageSize, left, dimension, reverse, result)
		if err != nil {
			return nil, err
		}
		second, err := c.completeTimeWindow(ctx, query, pageSize, right, dimension, reverse, result)
		if err != nil {
			return nil, err
		}
		return append(first, second...), nil
	}
	if len(response.Rows) == pageSize && (len(query.Dimensions) > 1 || pageSize > 1) {
		return nil, fmt.Errorf("analytics returned a full %s window (%s to %s); the API may omit rows and this report cannot be verified complete", dimension, window.start.Format(time.DateOnly), window.end.Format(time.DateOnly))
	}
	return sortTimeRows(Normalize(response), query.Dimensions, dimension, reverse)
}

func sortTimeRows(items []map[string]any, dimensions []string, dimension string, reverse bool) ([]map[string]any, error) {
	type keyedRow struct {
		item map[string]any
		date string
		key  string
	}
	rows := make([]keyedRow, len(items))
	for index, item := range items {
		date, ok := item[dimension].(string)
		if !ok {
			return nil, fmt.Errorf("analytics response omitted %s dimension; cannot order rows safely", dimension)
		}
		// Metrics can change between a limited run and its resumed run. Only
		// dimension values may determine the order of rows within a date.
		tie := make([]any, 0, len(dimensions)-1)
		for _, name := range dimensions {
			if name != dimension {
				tie = append(tie, item[name])
			}
		}
		encoded, err := json.Marshal(tie)
		if err != nil {
			return nil, err
		}
		rows[index] = keyedRow{item: item, date: date, key: string(encoded)}
	}
	sort.Slice(rows, func(left, right int) bool {
		if rows[left].date != rows[right].date {
			if reverse {
				return rows[left].date > rows[right].date
			}
			return rows[left].date < rows[right].date
		}
		return rows[left].key < rows[right].key
	})
	for index, row := range rows {
		items[index] = row.item
	}
	return items, nil
}

func Normalize(response Response) []map[string]any {
	items := make([]map[string]any, 0, len(response.Rows))
	for _, row := range response.Rows {
		item := make(map[string]any, len(response.ColumnHeaders))
		for index, header := range response.ColumnHeaders {
			if index < len(row) {
				item[header.Name] = row[index]
			} else {
				item[header.Name] = nil
			}
		}
		items = append(items, item)
	}
	return items
}
