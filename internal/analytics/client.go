// Package analytics provides a read-only YouTube Analytics reports client.
package analytics

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"open-yt-cli/internal/youtube"
)

const (
	DefaultBaseURL = "https://youtubeanalytics.googleapis.com/v2"
	MaxResults     = 200
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
	StartIndex int
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
	limit := query.Limit
	if limit == 0 {
		limit = MaxResults
	}
	if limit < 1 || limit > MaxResults {
		return youtube.ListResult{}, fmt.Errorf("analytics limit must be between 1 and %d", MaxResults)
	}
	startIndex := query.StartIndex
	if startIndex == 0 {
		startIndex = 1
	}
	params := url.Values{
		"ids":        {"channel==MINE"},
		"startDate":  {query.StartDate},
		"endDate":    {query.EndDate},
		"metrics":    {strings.Join(query.Metrics, ",")},
		"maxResults": {strconv.Itoa(limit)},
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
		return youtube.ListResult{}, err
	}
	return youtube.ListResult{Items: Normalize(response), Requests: 1}, nil
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
