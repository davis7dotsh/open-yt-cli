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
