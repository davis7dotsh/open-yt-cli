package youtube

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetUsesHeaderNotQueryForKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/youtube/v3/videos" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("X-Goog-Api-Key"); got != "super-secret" {
			t.Errorf("key header = %q", got)
		}
		if got := r.URL.Query().Get("key"); got != "" {
			t.Errorf("key leaked in URL: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[{"id":"v","statistics":{"viewCount":"9007199254740993123"}}]}`))
	}))
	defer server.Close()
	client := testClient(server, "super-secret")
	response, err := client.Get(context.Background(), "videos", url.Values{"part": {"statistics"}, "id": {"v"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := response.Items[0]["id"]; got != "v" {
		t.Fatalf("item ID = %v", got)
	}
}

func TestBearerAuthenticationForcesOneRefreshAfter401(t *testing.T) {
	var requests atomic.Int32
	var forced atomic.Int32
	var current atomic.Value
	current.Store("stale-token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := requests.Add(1)
		if r.Header.Get("X-Goog-Api-Key") != "" {
			t.Error("bearer request also sent API key")
		}
		if request == 1 {
			if r.Header.Get("Authorization") != "Bearer stale-token" {
				t.Errorf("first authorization = %q", r.Header.Get("Authorization"))
			}
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":401,"message":"expired"}}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer fresh-token" {
			t.Errorf("second authorization = %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"ok"}]}`))
	}))
	defer server.Close()
	client := testClient(server, "")
	client.TokenSource = func(_ context.Context, force bool) (string, error) {
		if force {
			forced.Add(1)
			current.Store("fresh-token")
		}
		return current.Load().(string), nil
	}
	response, err := client.Get(context.Background(), "videos", url.Values{})
	if err != nil {
		t.Fatal(err)
	}
	if response.Items[0]["id"] != "ok" || requests.Load() != 2 || forced.Load() != 1 {
		t.Fatalf("response/requests/forced = %#v/%d/%d", response, requests.Load(), forced.Load())
	}
}

func TestGetWithoutAuthenticationSendsNoKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Goog-Api-Key"); got != "" {
			t.Errorf("unexpected key header %q", got)
		}
		_, _ = w.Write([]byte(`{"videoId":"v","permitted":["none"]}`))
	}))
	defer server.Close()
	client := testClient(server, "configured-but-unused")
	var response map[string]any
	if err := client.GetJSON(context.Background(), "videoTrainability", url.Values{"id": {"v"}}, false, &response); err != nil {
		t.Fatal(err)
	}
}

func TestStructuredAPIErrorAndRetry(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"code":503,"message":"try later","errors":[{"reason":"backendError"}]}}`))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":403,"message":"quota exhausted","errors":[{"reason":"quotaExceeded"}]}}`))
	}))
	defer server.Close()
	client := testClient(server, "key")
	client.MaxRetries = 1
	client.Sleep = func(context.Context, time.Duration) error { return nil }
	_, err := client.Get(context.Background(), "videos", url.Values{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %T: %v", err, err)
	}
	if apiErr.Code != 403 || len(apiErr.Reasons) != 1 || apiErr.Reasons[0] != "quotaExceeded" {
		t.Fatalf("unexpected API error: %#v", apiErr)
	}
	if requests.Load() != 2 {
		t.Fatalf("requests = %d, want 2", requests.Load())
	}
}

func TestListPaginationLimitAndToken(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := requests.Add(1)
		if r.URL.Query().Get("maxResults") != "2" {
			t.Errorf("maxResults = %q", r.URL.Query().Get("maxResults"))
		}
		if request == 1 {
			if r.URL.Query().Get("pageToken") != "start" {
				t.Errorf("first page token = %q", r.URL.Query().Get("pageToken"))
			}
			_, _ = w.Write([]byte(`{"items":[{"id":"1"},{"id":"2"}],"nextPageToken":"next"}`))
			return
		}
		if r.URL.Query().Get("pageToken") != "next" {
			t.Errorf("second page token = %q", r.URL.Query().Get("pageToken"))
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"3"},{"id":"4"}],"nextPageToken":"unused"}`))
	}))
	defer server.Close()
	client := testClient(server, "key")
	result, err := client.List(context.Background(), "playlistItems", url.Values{}, PageOptions{All: true, Limit: 3, PageSize: 2, PageToken: "start"})
	if err != nil {
		t.Fatal(err)
	}
	// The second page was truncated (item "4" discarded), so the server's
	// token must not be reported: resuming from it would skip the discarded
	// item.
	if len(result.Items) != 3 || result.Requests != 2 || result.NextPageToken != "" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestListExactLimitBoundaryKeepsToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"id":"1"},{"id":"2"}],"nextPageToken":"resume"}`))
	}))
	defer server.Close()

	// The limit consumes the page exactly; nothing was discarded, so the
	// token is a valid resume point and must be kept.
	result, err := testClient(server, "key").List(context.Background(), "playlistItems", url.Values{}, PageOptions{All: true, Limit: 2, PageSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 || result.NextPageToken != "resume" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestListStopsOnRepeatedPageToken(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"items":[{"id":"1"}],"nextPageToken":"loop"}`))
	}))
	defer server.Close()

	result, err := testClient(server, "key").List(context.Background(), "search", url.Values{}, PageOptions{All: true})
	if err != nil {
		t.Fatal(err)
	}
	// First page yields token "loop"; the second page repeats it, which can
	// only re-fetch the same page, so the loop stops and reports no resume
	// point instead of iterating forever.
	if result.Requests != 2 || requests.Load() != 2 {
		t.Fatalf("requests = %d (server saw %d), want 2", result.Requests, requests.Load())
	}
	if result.NextPageToken != "" {
		t.Fatalf("NextPageToken = %q, want empty", result.NextPageToken)
	}
}

func TestListRequestCeiling(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Every page returns a distinct token, so loop detection never fires
		// and only the request ceiling can end the pagination.
		token := requests.Add(1)
		fmt.Fprintf(w, `{"items":[{"id":"x"}],"nextPageToken":"t%d"}`, token)
	}))
	defer server.Close()

	result, err := testClient(server, "key").List(context.Background(), "search", url.Values{}, PageOptions{All: true})
	if err == nil {
		t.Fatal("expected an error after hitting the request ceiling")
	}
	if !strings.Contains(err.Error(), "pagination did not terminate") || !strings.Contains(err.Error(), "--limit") {
		t.Fatalf("error = %v", err)
	}
	if result.Requests != MaxListRequests {
		t.Fatalf("requests = %d, want %d", result.Requests, MaxListRequests)
	}
}

func TestListReturnsEmptySliceWhenResponseHasNoItems(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	result, err := testClient(server, "key").List(context.Background(), "search", url.Values{}, PageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Items == nil || len(result.Items) != 0 {
		t.Fatalf("items = %#v, want non-nil empty slice", result.Items)
	}
}

func TestResolveChannelHandleAndURL(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Query().Get("forHandle") != "example" {
			t.Errorf("forHandle = %q", r.URL.Query().Get("forHandle"))
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"UC1234567890123456789012"}]}`))
	}))
	defer server.Close()
	client := testClient(server, "key")
	id, used, err := client.ResolveChannel(context.Background(), "https://youtube.com/@example/videos")
	if err != nil || id != "UC1234567890123456789012" || used != 1 {
		t.Fatalf("ResolveChannel() = %q, %d, %v", id, used, err)
	}
	canonical := "UC" + strconv.FormatInt(1234567890123456789, 10) + "abc"
	if len(canonical) == 24 {
		_, _, _ = client.ResolveChannel(context.Background(), canonical)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d", requests.Load())
	}
}

func testClient(server *httptest.Server, key string) *Client {
	client := NewClient(key, time.Second)
	client.BaseURL = server.URL + "/youtube/v3"
	client.HTTPClient = server.Client()
	client.MaxRetries = 0
	return client
}
