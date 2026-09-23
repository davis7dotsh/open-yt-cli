package youtube

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestListPreservesPaginationWithPartialResponseFields(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		fields := r.URL.Query().Get("fields")
		if !strings.Contains(fields, "items(contentDetails/videoId)") || !strings.Contains(fields, "nextPageToken") {
			t.Errorf("request fields = %q", fields)
		}
		if requests == 1 {
			_, _ = w.Write([]byte(`{"items":[{"contentDetails":{"videoId":"a"}}],"nextPageToken":"second"}`))
			return
		}
		if r.URL.Query().Get("pageToken") != "second" {
			t.Errorf("page token = %q", r.URL.Query().Get("pageToken"))
		}
		_, _ = w.Write([]byte(`{"items":[{"contentDetails":{"videoId":"b"}}]}`))
	}))
	defer server.Close()

	params := url.Values{"fields": {"items(contentDetails/videoId)"}}
	result, err := testClient(server, "key").List(context.Background(), "playlistItems", params, PageOptions{All: true})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || result.Requests != 2 || len(result.Items) != 2 {
		t.Fatalf("requests = %d, result = %#v", requests, result)
	}
}

func TestWithPaginationFieldChecksTopLevel(t *testing.T) {
	tests := []struct{ input, want string }{
		{"items(nextPageToken)", "items(nextPageToken),nextPageToken"},
		{"items", "items,nextPageToken"},
		{"items(id),nextPageToken", "items(id),nextPageToken"},
		{"*", "*"},
	}
	for _, test := range tests {
		if got := withPaginationField(test.input); got != test.want {
			t.Errorf("withPaginationField(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}
