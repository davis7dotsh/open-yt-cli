package youtube

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
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
	if len(result.Items) != 3 || result.Requests != 2 || result.NextPageToken != "unused" {
		t.Fatalf("unexpected result: %#v", result)
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
