package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"open-yt-cli/internal/youtube"
)

func TestPlaylistItemsAllRetainsPageTokenWithPartialFields(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := requests.Add(1)
		if r.URL.Path != "/youtube/v3/playlistItems" {
			t.Errorf("path = %q", r.URL.Path)
		}
		fields := r.URL.Query().Get("fields")
		if !fieldSelectorIncludes(fields, "items/contentDetails/videoId") || !fieldSelectorIncludes(fields, "nextPageToken") {
			t.Errorf("fields = %q", fields)
		}
		switch request {
		case 1:
			if token := r.URL.Query().Get("pageToken"); token != "" {
				t.Errorf("first page token = %q", token)
			}
			_, _ = w.Write([]byte(`{"items":[{"contentDetails":{"videoId":"v1"}},{"contentDetails":{"videoId":"v2"}}],"nextPageToken":"page-2"}`))
		case 2:
			if token := r.URL.Query().Get("pageToken"); token != "page-2" {
				t.Errorf("second page token = %q", token)
			}
			_, _ = w.Write([]byte(`{"items":[{"contentDetails":{"videoId":"v3"}},{"contentDetails":{"videoId":"v4"}}],"nextPageToken":"page-3"}`))
		default:
			t.Errorf("unexpected request %d", request)
		}
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "playlist", "items", "playlist", "--page-size", "2", "--all", "--limit", "3", "--fields", "items(contentDetails/videoId)", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	var result youtube.ListResult
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 || result.Requests != 2 || len(result.Items) != 3 {
		t.Fatalf("requests = %d, output = %s", requests.Load(), out.String())
	}
	if result.NextPageToken != "" {
		t.Fatalf("unsafe token after trimmed page = %q", result.NextPageToken)
	}
	for index, expected := range []string{"v1", "v2", "v3"} {
		contentDetails, _ := result.Items[index]["contentDetails"].(map[string]any)
		if contentDetails["videoId"] != expected {
			t.Fatalf("item %d = %v, want %q", index, result.Items[index], expected)
		}
	}
}

func TestNonJSONListFormatsShowResumeTokenOnStderr(t *testing.T) {
	for _, format := range []string{"jsonl", "tsv"} {
		t.Run(format, func(t *testing.T) {
			t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
			t.Setenv("OYTC_API_KEY", "key")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"items":[{"contentDetails":{"videoId":"v1"}}],"nextPageToken":"resume-here"}`))
			}))
			defer server.Close()
			app, out, errOut := testApp(server)
			if err := execute(t, app, "playlist", "items", "playlist", "--format", format); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "v1") {
				t.Fatalf("missing item in stdout: %q", out.String())
			}
			if !strings.Contains(errOut.String(), "resume with --page-token resume-here") {
				t.Fatalf("missing resume hint in stderr: %q", errOut.String())
			}
			if bytes.Contains(out.Bytes(), []byte("resume-here")) {
				t.Fatalf("resume token mixed into item output: %q", out.String())
			}
		})
	}
}

func TestSearchRejectsEmptyTypeEntry(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("unexpected request for invalid --type")
	}))
	defer server.Close()
	app, _, _ := testApp(server)
	err := execute(t, app, "search", "example", "--type", "video,")
	var usage *UsageError
	if !errors.As(err, &usage) {
		t.Fatalf("expected UsageError, got %T: %v", err, err)
	}
}

func TestSearchUsesDefaultTypes(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("type"); got != "video,channel,playlist" {
			t.Errorf("default type filter = %q", got)
		}
		_, _ = w.Write([]byte(`{"items":[{"id":{"kind":"youtube#video","videoId":"v1"}}]}`))
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "search", "example", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	var result youtube.ListResult
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 {
		t.Fatalf("missing search result: %s", out.String())
	}
}

func TestLiveChatListLimitClearsUnsafeResumeToken(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"id":"first"},{"id":"discarded"}],"nextPageToken":"skips-discarded"}`))
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "live-chat", "list", "--chat-id", "chat", "--limit", "1", "--format", "json"); err != nil {
		t.Fatal(err)
	}
	var result youtube.ListResult
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0]["id"] != "first" || result.NextPageToken != "" {
		t.Fatalf("unsafe limited output: %s", out.String())
	}
}

func TestLiveChatStreamPartialFieldsKeepPollingAndDedupPrivate(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := requests.Add(1)
		fields := r.URL.Query().Get("fields")
		for _, required := range []string{"items/snippet/displayMessage", "items/id", "nextPageToken", "pollingIntervalMillis", "offlineAt"} {
			if !fieldSelectorIncludes(fields, required) {
				t.Errorf("fields %q omit %q", fields, required)
			}
		}
		switch request {
		case 1:
			_, _ = w.Write([]byte(`{"items":[{"id":"a","snippet":{"displayMessage":"first"}}],"nextPageToken":"poll-again","pollingIntervalMillis":1}`))
		case 2:
			if token := r.URL.Query().Get("pageToken"); token != "poll-again" {
				t.Errorf("second page token = %q", token)
			}
			_, _ = w.Write([]byte(`{"items":[{"id":"a","snippet":{"displayMessage":"duplicate"}},{"id":"b","snippet":{"displayMessage":"second"}}],"offlineAt":"2025-01-01T00:00:00Z"}`))
		default:
			t.Errorf("unexpected request %d", request)
		}
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "live-chat", "stream", "--chat-id", "chat", "--fields", "items(snippet/displayMessage)", "--format", "jsonl"); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatalf("requests = %d, output = %s", requests.Load(), out.String())
	}
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("stream lines = %d: %s", len(lines), out.String())
	}
	for index, expected := range []string{"first", "second"} {
		var item map[string]any
		if err := json.Unmarshal(lines[index], &item); err != nil {
			t.Fatal(err)
		}
		if _, exposed := item["id"]; exposed {
			t.Fatalf("internal dedup ID exposed: %s", lines[index])
		}
		snippet, _ := item["snippet"].(map[string]any)
		if snippet["displayMessage"] != expected {
			t.Fatalf("message %d = %v, want %q", index, item, expected)
		}
	}
}

func TestLiveChatStreamItemsSelectorPreservesTopLevelPollingMetadata(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "key")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := requests.Add(1)
		fields := r.URL.Query().Get("fields")
		for _, required := range []string{"nextPageToken", "pollingIntervalMillis", "offlineAt"} {
			if !fieldSelectorIncludes(fields, required) {
				t.Errorf("fields %q omit top-level %q", fields, required)
			}
		}
		switch request {
		case 1:
			_, _ = w.Write([]byte(`{"items":[{"id":"a"}],"nextPageToken":"poll-again","pollingIntervalMillis":1}`))
		case 2:
			if token := r.URL.Query().Get("pageToken"); token != "poll-again" {
				t.Errorf("second page token = %q", token)
			}
			_, _ = w.Write([]byte(`{"items":[{"id":"b"}],"offlineAt":"2025-01-01T00:00:00Z"}`))
		default:
			t.Errorf("unexpected request %d", request)
		}
	}))
	defer server.Close()
	app, out, _ := testApp(server)
	if err := execute(t, app, "live-chat", "stream", "--chat-id", "chat", "--fields", "items", "--format", "jsonl"); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 || bytes.Count(out.Bytes(), []byte(`"id":"a"`)) != 1 || bytes.Count(out.Bytes(), []byte(`"id":"b"`)) != 1 {
		t.Fatalf("requests = %d, output = %s", requests.Load(), out.String())
	}
}
