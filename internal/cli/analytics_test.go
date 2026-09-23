package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"open-yt-cli/internal/analytics"
	"open-yt-cli/internal/config"
	"open-yt-cli/internal/youtube"
)

func TestAnalyticsPaginationFlagsAndContinuation(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	if _, err := config.SaveOAuth(config.OAuthCredentials{
		ClientID: "id", ClientSecret: "secret", AccessToken: "oauth-access", RefreshToken: "oauth-refresh",
		Expiry: "2099-01-01T00:00:00Z", Scopes: []string{analyticsReadonlyScope},
	}); err != nil {
		t.Fatal(err)
	}
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
		_ = json.NewEncoder(w).Encode(analytics.Response{ColumnHeaders: []analytics.ColumnHeader{{Name: "views"}}, Rows: rows})
	}))
	defer server.Close()

	app, out, _ := testApp(server)
	if err := execute(t, app, "analytics", "report", "--metrics", "views", "--page-size", "2", "--limit", "3", "--all", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Items          []map[string]any `json:"items"`
		NextStartIndex int              `json:"nextStartIndex"`
		Requests       int              `json:"requests"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 3 || result.NextStartIndex != 4 || result.Requests != 2 {
		t.Fatalf("result = %#v", result)
	}
	if !reflect.DeepEqual(requests, []string{"1:2", "3:1"}) {
		t.Fatalf("requests = %v", requests)
	}

	requests = nil
	app, out, errOut := testApp(server)
	if err := execute(t, app, "analytics", "report", "--metrics", "views", "--start-index", "4", "--page-size", "2", "--format", "table"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte("VIEWS")) || !strings.Contains(errOut.String(), "more may be available (resume with --start-index 6)") {
		t.Fatalf("table = %s; summary = %s", out.String(), errOut.String())
	}
	if !reflect.DeepEqual(requests, []string{"4:2"}) {
		t.Fatalf("resumed requests = %v", requests)
	}
}

func TestAnalyticsRejectsUnsupportedAllTimeSortBeforeAuth(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	app, _, _ := testApp(nil)
	err := execute(t, app, "analytics", "overview", "--by", "day", "--all", "--sort=-views")
	var usage *UsageError
	if !errors.As(err, &usage) || !strings.Contains(err.Error(), "--sort day") {
		t.Fatalf("expected sort usage error before auth, got %T: %v", err, err)
	}
}

func TestAnalyticsUncertainOutputSuggestsAll(t *testing.T) {
	app, _, errOut := testApp(nil)
	app.format = "json"
	result := youtube.ListResult{Items: []map[string]any{}, Requests: 1, CompletionUncertain: true}
	if err := app.renderResult(result, []string{"day"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut.String(), "--all") {
		t.Fatalf("uncertainty warning = %q", errOut.String())
	}
}
