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
