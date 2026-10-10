package mcptools

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/youtube"
)

func TestToolsListEveryReadCommand(t *testing.T) {
	want := []string{
		"analytics_demographics", "analytics_overview", "analytics_report", "analytics_traffic_sources", "analytics_video",
		"category_list", "channel_activities", "channel_get", "channel_sections", "channel_uploads",
		"comment_get", "comment_replies", "comment_threads", "language_list", "live_chat_messages",
		"playlist_get", "playlist_items", "playlist_list", "region_list", "search", "subscription_list",
		"video_get", "video_popular", "video_stats", "video_trainability",
	}
	channels := func(context.Context) ([]Channel, error) { return nil, nil }
	for _, test := range []struct {
		name     string
		resolver Resolver
		want     []string
	}{
		{"local", Resolver{}, want},
		{"hosted", Resolver{Channels: channels}, append(slices.Clone(want), "list_channels")},
	} {
		t.Run(test.name, func(t *testing.T) {
			session := connect(t, test.resolver)
			schemas := make(map[string]inputSchema)
			for tool, err := range session.Tools(t.Context(), nil) {
				if err != nil {
					t.Fatal(err)
				}
				if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
					t.Errorf("%s is not annotated read-only", tool.Name)
				}
				schemas[tool.Name] = decode[inputSchema](t, tool.InputSchema)
			}
			names := slices.Sorted(maps.Keys(schemas))
			if !slices.Equal(names, slices.Sorted(slices.Values(test.want))) {
				t.Fatalf("tools = %v, want %v", names, test.want)
			}
			// Embedded Page and API fields flatten like encoding/json.
			for _, property := range []string{"query", "pageSize", "pageToken", "all", "limit", "parts", "fields"} {
				if _, ok := schemas["search"].Properties[property]; !ok {
					t.Errorf("search schema lacks %q: %v", property, schemas["search"].Properties)
				}
			}
			report := schemas["analytics_report"]
			if _, ok := report.Properties["channel"]; !ok || !slices.Equal(report.Required, []string{"metrics"}) {
				t.Errorf("analytics_report schema = %+v", report)
			}
			if !slices.Equal(schemas["video_get"].Required, []string{"ids"}) {
				t.Errorf("video_get required = %v", schemas["video_get"].Required)
			}
		})
	}
}

func TestSearchToolReturnsStructuredItems(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" || r.URL.Query().Get("q") != "go" || r.URL.Query().Get("type") != "video" || r.URL.Query().Get("maxResults") != "25" {
			t.Errorf("request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"items":[{"id":{"kind":"youtube#video","videoId":"v1"}},{"id":{"kind":"youtube#channel","channelId":"c1"}}],"nextPageToken":"p2"}`))
	}))
	defer server.Close()
	data := func(context.Context) (*youtube.Client, error) {
		client := youtube.NewClient("key", time.Second)
		client.BaseURL = server.URL
		client.HTTPClient = server.Client()
		return client, nil
	}
	session := connect(t, Resolver{Data: data})
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "search", Arguments: map[string]any{"query": "go", "type": "video"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("tool error: %v", result.Content)
	}
	got := decode[youtube.ListResult](t, result.StructuredContent)
	if len(got.Items) != 1 || got.NextPageToken != "p2" || got.Requests != 1 {
		t.Fatalf("result = %+v", got)
	}
	if id, _ := got.Items[0]["id"].(map[string]any); id["videoId"] != "v1" {
		t.Fatalf("item = %v", got.Items[0])
	}
}

func TestAnalyticsToolUsesRequestedChannel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("dimensions") != "insightTrafficSourceType" || query.Get("metrics") != "views,estimatedMinutesWatched" || query.Get("startDate") == "" || query.Get("endDate") == "" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"columnHeaders":[{"name":"insightTrafficSourceType"},{"name":"views"}],"rows":[["YT_SEARCH",42]]}`))
	}))
	defer server.Close()
	var channel string
	reports := func(_ context.Context, requested string) (*analytics.Client, error) {
		channel = requested
		client := analytics.NewClient(func(context.Context, bool) (string, error) { return "token", nil }, time.Second)
		client.SetBaseURL(server.URL)
		client.SetHTTPClient(server.Client())
		return client, nil
	}
	session := connect(t, Resolver{Analytics: reports})
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "analytics_traffic_sources", Arguments: map[string]any{"channel": "@mine"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("tool error: %v", result.Content)
	}
	got := decode[youtube.ListResult](t, result.StructuredContent)
	if channel != "@mine" || len(got.Items) != 1 || got.Items[0]["insightTrafficSourceType"] != "YT_SEARCH" {
		t.Fatalf("channel = %q, result = %+v", channel, got)
	}
}

func TestInvalidInputIsToolError(t *testing.T) {
	data := func(context.Context) (*youtube.Client, error) {
		t.Error("client resolved for invalid input")
		return nil, context.Canceled
	}
	session := connect(t, Resolver{Data: data})
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "search", Arguments: map[string]any{"query": "go", "order": "loudest"}})
	if err != nil {
		t.Fatal(err)
	}
	text, _ := result.Content[0].(*mcp.TextContent)
	if !result.IsError || text == nil || !strings.Contains(text.Text, "order must be one of") {
		t.Fatalf("result = %+v", result)
	}
}

func TestToolCallsStayWithinPageBudget(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/reports" {
			rows := strings.TrimSuffix(strings.Repeat(`["US",1],`, analytics.MaxResults), ",")
			_, _ = w.Write([]byte(`{"columnHeaders":[{"name":"country"},{"name":"views"}],"rows":[` + rows + `]}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"x"}],"nextPageToken":"p` + strings.Repeat("x", requests) + `"}`))
	}))
	defer server.Close()
	data := func(context.Context) (*youtube.Client, error) {
		client := youtube.NewClient("key", time.Second)
		client.BaseURL, client.HTTPClient, client.MaxRetries = server.URL, server.Client(), 0
		return client, nil
	}
	reports := func(context.Context, string) (*analytics.Client, error) {
		client := analytics.NewClient(func(context.Context, bool) (string, error) { return "token", nil }, time.Second)
		client.SetBaseURL(server.URL)
		client.SetHTTPClient(server.Client())
		return client, nil
	}
	session := connect(t, Resolver{Data: data, Analytics: reports})
	call := func(name string, arguments map[string]any) *mcp.CallToolResult {
		t.Helper()
		requests = 0
		result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: name, Arguments: arguments})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}

	ids := make([]string, PageBudget*50+1)
	for i := range ids {
		ids[i] = "v"
	}
	for name, arguments := range map[string]map[string]any{
		"search":    {"query": "go", "all": true},
		"video_get": {"ids": ids},
	} {
		if result := call(name, arguments); !result.IsError || requests != 0 {
			t.Errorf("%s: error = %v after %d requests, want an input error before any request", name, result.IsError, requests)
		}
	}

	items := decode[youtube.ListResult](t, call("playlist_items", map[string]any{"playlist": "PL1", "all": true}).StructuredContent)
	if items.Requests != PageBudget || items.NextPageToken == "" {
		t.Errorf("playlist_items requests = %d, next = %q; want %d and a resume token", items.Requests, items.NextPageToken, PageBudget)
	}
	report := decode[youtube.ListResult](t, call("analytics_report", map[string]any{"metrics": "views", "dimensions": "country", "all": true}).StructuredContent)
	if report.Requests != PageBudget || report.NextStartIndex == 0 {
		t.Errorf("analytics_report requests = %d, nextStartIndex = %d; want %d and a resume index", report.Requests, report.NextStartIndex, PageBudget)
	}
}

type inputSchema struct {
	Properties map[string]any `json:"properties"`
	Required   []string       `json:"required"`
}

func connect(t *testing.T, r Resolver) *mcp.ClientSession {
	t.Helper()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	if _, err := NewServer(r, Options{Version: "test"}).Connect(t.Context(), serverTransport, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "test"}, nil).Connect(t.Context(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

// decode round-trips a decoded JSON value into T.
func decode[T any](t *testing.T, value any) T {
	t.Helper()
	var out T
	encoded, err := json.Marshal(value)
	if err == nil {
		err = json.Unmarshal(encoded, &out)
	}
	if err != nil {
		t.Fatal(err)
	}
	return out
}
