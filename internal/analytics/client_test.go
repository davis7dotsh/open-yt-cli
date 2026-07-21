package analytics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReportNormalizesRowsByColumnName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/reports" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer analytics-token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		query := r.URL.Query()
		if query.Get("ids") != "channel==MINE" || query.Get("metrics") != "views,estimatedMinutesWatched" || query.Get("dimensions") != "day" || query.Get("maxResults") != "25" || query.Get("startIndex") != "1" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"columnHeaders":[{"name":"day","columnType":"DIMENSION","dataType":"STRING"},{"name":"views","columnType":"METRIC","dataType":"INTEGER"},{"name":"estimatedMinutesWatched","columnType":"METRIC","dataType":"FLOAT"}],"rows":[["2026-01-01",12,3.5],["2026-01-02",8,2.25]]}`))
	}))
	defer server.Close()
	client := NewClient(func(context.Context, bool) (string, error) { return "analytics-token", nil }, time.Second)
	client.SetBaseURL(server.URL + "/v2")
	client.SetHTTPClient(server.Client())
	result, err := client.Report(context.Background(), Query{
		StartDate: "2026-01-01", EndDate: "2026-01-02", Metrics: []string{"views", "estimatedMinutesWatched"}, Dimensions: []string{"day"}, Limit: 25,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 || result.Requests != 1 || result.Items[0]["day"] != "2026-01-01" {
		t.Fatalf("result = %#v", result)
	}
	views, ok := result.Items[0]["views"].(json.Number)
	if !ok || views.String() != "12" {
		t.Fatalf("views = %T(%v)", result.Items[0]["views"], result.Items[0]["views"])
	}
}

func TestNormalizeFillsMissingCells(t *testing.T) {
	items := Normalize(Response{
		ColumnHeaders: []ColumnHeader{{Name: "day"}, {Name: "views"}},
		Rows:          [][]any{{"2026-01-01"}},
	})
	if len(items) != 1 || items[0]["day"] != "2026-01-01" || items[0]["views"] != nil {
		t.Fatalf("items = %#v", items)
	}
}
