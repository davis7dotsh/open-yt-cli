package analytics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
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

func TestReportPaginationAndResume(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		requests = append(requests, query.Get("startIndex")+":"+query.Get("maxResults"))
		start, _ := strconv.Atoi(query.Get("startIndex"))
		size, _ := strconv.Atoi(query.Get("maxResults"))
		rows := make([][]any, 0, size)
		for index := start; index < start+size && index <= 5; index++ {
			rows = append(rows, []any{index})
		}
		_ = json.NewEncoder(w).Encode(Response{ColumnHeaders: []ColumnHeader{{Name: "views"}}, Rows: rows})
	}))
	defer server.Close()
	client := NewClient(func(context.Context, bool) (string, error) { return "analytics-token", nil }, time.Second)
	client.SetBaseURL(server.URL)
	client.SetHTTPClient(server.Client())

	result, err := client.Report(context.Background(), Query{Metrics: []string{"views"}, PageSize: 2, Limit: 3, All: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Requests != 2 || len(result.Items) != 3 || result.NextStartIndex != 4 {
		t.Fatalf("bounded result = %#v", result)
	}
	if !reflect.DeepEqual(requests, []string{"1:2", "3:1"}) {
		t.Fatalf("bounded requests = %v", requests)
	}

	requests = nil
	result, err = client.Report(context.Background(), Query{Metrics: []string{"views"}, PageSize: 2, StartIndex: 4, All: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Requests != 2 || len(result.Items) != 2 || result.NextStartIndex != 0 {
		t.Fatalf("resumed result = %#v", result)
	}
	if got := result.Items[0]["views"].(json.Number).String(); got != "4" {
		t.Fatalf("first resumed view = %s", got)
	}
	if !reflect.DeepEqual(requests, []string{"4:2", "6:2"}) {
		t.Fatalf("resume requests = %v", requests)
	}
}

func TestReportFullSinglePageOffersResumeIndex(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("maxResults"); got != "200" {
			t.Errorf("maxResults = %s", got)
		}
		rows := make([][]any, MaxResults)
		for index := range rows {
			rows[index] = []any{index + 1}
		}
		_ = json.NewEncoder(w).Encode(Response{ColumnHeaders: []ColumnHeader{{Name: "views"}}, Rows: rows})
	}))
	defer server.Close()
	client := NewClient(func(context.Context, bool) (string, error) { return "analytics-token", nil }, time.Second)
	client.SetBaseURL(server.URL)
	client.SetHTTPClient(server.Client())
	result, err := client.Report(context.Background(), Query{Metrics: []string{"views"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != MaxResults || result.Requests != 1 || result.NextStartIndex != MaxResults+1 {
		t.Fatalf("result = %#v", result)
	}
}

func TestReportTimeWindowsRecoverRowsHiddenByBrokenOffset(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		query := r.URL.Query()
		start, err := time.Parse(time.DateOnly, query.Get("startDate"))
		if err != nil {
			t.Error(err)
		}
		end, err := time.Parse(time.DateOnly, query.Get("endDate"))
		if err != nil {
			t.Error(err)
		}
		index, _ := strconv.Atoi(query.Get("startIndex"))
		size, _ := strconv.Atoi(query.Get("maxResults"))
		rows := make([][]any, 0)
		if index == 1 {
			for date := end; !date.Before(start) && len(rows) < size; date = date.AddDate(0, 0, -1) {
				rows = append(rows, []any{date.Format(time.DateOnly), 1})
			}
		}
		_ = json.NewEncoder(w).Encode(Response{ColumnHeaders: []ColumnHeader{{Name: "day"}, {Name: "views"}}, Rows: rows})
	}))
	defer server.Close()
	client := NewClient(func(context.Context, bool) (string, error) { return "analytics-token", nil }, time.Second)
	client.SetBaseURL(server.URL)
	client.SetHTTPClient(server.Client())
	query := Query{StartDate: "2026-01-01", EndDate: "2026-09-20", Metrics: []string{"views"}, Dimensions: []string{"day"}}

	onePage, err := client.Report(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(onePage.Items) != MaxResults || onePage.Requests != 1 || onePage.NextStartIndex != 0 || !onePage.CompletionUncertain {
		t.Fatalf("one-page result = %d rows, %d requests, next index %d, uncertain %v", len(onePage.Items), onePage.Requests, onePage.NextStartIndex, onePage.CompletionUncertain)
	}
	query.All = true
	query.Limit = 200
	bounded, err := client.Report(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(bounded.Items) != 200 || bounded.NextStartIndex != 201 || bounded.CompletionUncertain {
		t.Fatalf("bounded result = %d rows, next index %d, uncertain %v", len(bounded.Items), bounded.NextStartIndex, bounded.CompletionUncertain)
	}
	query.Limit = 0
	result, err := client.Report(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 263 || result.Requests != 10 || requests != 19 || result.NextStartIndex != 0 || result.CompletionUncertain {
		t.Fatalf("complete result = %d rows, %d requests, next index %d, uncertain %v", len(result.Items), result.Requests, result.NextStartIndex, result.CompletionUncertain)
	}
	if bounded.Items[0]["day"] != result.Items[0]["day"] || bounded.Items[199]["day"] != result.Items[199]["day"] {
		t.Fatal("bounded --all rows differ from complete report ordering")
	}
	if result.Items[0]["day"] != "2026-01-01" || result.Items[len(result.Items)-1]["day"] != "2026-09-20" {
		t.Fatalf("date order = %v to %v", result.Items[0]["day"], result.Items[len(result.Items)-1]["day"])
	}
	for _, date := range []string{"2026-09-05", "2026-09-06", "2026-09-13"} {
		found := false
		for _, item := range result.Items {
			if item["day"] == date {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("date %s missing from complete report", date)
		}
	}
}

func TestReportTimeWindowsApplyLogicalLimitAndReverseOrder(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("startIndex") != "1" || query.Get("sort") != "" {
			t.Errorf("window query = %s", r.URL.RawQuery)
		}
		start, _ := time.Parse(time.DateOnly, query.Get("startDate"))
		end, _ := time.Parse(time.DateOnly, query.Get("endDate"))
		rows := make([][]any, 0)
		for date := start; !date.After(end); date = date.AddDate(0, 0, 1) {
			rows = append(rows, []any{date.Format(time.DateOnly)})
		}
		_ = json.NewEncoder(w).Encode(Response{ColumnHeaders: []ColumnHeader{{Name: "day"}}, Rows: rows})
	}))
	defer server.Close()
	client := NewClient(func(context.Context, bool) (string, error) { return "analytics-token", nil }, time.Second)
	client.SetBaseURL(server.URL)
	client.SetHTTPClient(server.Client())
	query := Query{StartDate: "2026-01-01", EndDate: "2026-01-05", Metrics: []string{"views"}, Dimensions: []string{"day"}, PageSize: 2, StartIndex: 2, Limit: 2, Sort: "-day", All: true}
	result, err := client.Report(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if result.Requests != 3 || result.NextStartIndex != 4 || len(result.Items) != 2 || result.Items[0]["day"] != "2026-01-04" || result.Items[1]["day"] != "2026-01-03" {
		t.Fatalf("reverse bounded result = %#v", result)
	}
}

func TestReportNonTimeDimensionSignalsUncertainCompletion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rows := make([][]any, 0, MaxResults)
		if r.URL.Query().Get("startIndex") == "1" {
			for index := 0; index < MaxResults; index++ {
				rows = append(rows, []any{index})
			}
		}
		_ = json.NewEncoder(w).Encode(Response{ColumnHeaders: []ColumnHeader{{Name: "views"}}, Rows: rows})
	}))
	defer server.Close()
	client := NewClient(func(context.Context, bool) (string, error) { return "analytics-token", nil }, time.Second)
	client.SetBaseURL(server.URL)
	client.SetHTTPClient(server.Client())
	result, err := client.Report(context.Background(), Query{Metrics: []string{"views"}, Dimensions: []string{"video"}, All: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != MaxResults || result.Requests != 2 || !result.CompletionUncertain || result.NextStartIndex != 0 {
		t.Fatalf("result = %d rows, %d requests, uncertain %v, next index %d", len(result.Items), result.Requests, result.CompletionUncertain, result.NextStartIndex)
	}
}
