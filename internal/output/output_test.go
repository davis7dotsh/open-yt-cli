package output

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"open-yt-cli/internal/youtube"
)

func TestJSONPreservesLargeCounterString(t *testing.T) {
	result := youtube.ListResult{Items: []map[string]any{{"id": "v", "statistics": map[string]any{"viewCount": "900719925474099312345"}}}, Requests: 1}
	var buffer bytes.Buffer
	if err := Render(&buffer, result, Options{Format: "json"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buffer.String(), `"viewCount": "900719925474099312345"`) {
		t.Fatalf("counter was changed: %s", buffer.String())
	}
	var decoded youtube.ListResult
	if err := json.Unmarshal(buffer.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
}

func TestTSVColumnsAndSanitization(t *testing.T) {
	result := youtube.ListResult{Items: []map[string]any{{"id": "v", "snippet": map[string]any{"title": "line one\nline two"}}}}
	var buffer bytes.Buffer
	if err := Render(&buffer, result, Options{Format: "tsv", Columns: []string{"id", "snippet.title"}}); err != nil {
		t.Fatal(err)
	}
	want := "ID\tSNIPPET.TITLE\nv\tline one line two\n"
	if buffer.String() != want {
		t.Fatalf("TSV = %q, want %q", buffer.String(), want)
	}
}

func TestJSONLEmitsOneItemPerLine(t *testing.T) {
	result := youtube.ListResult{Items: []map[string]any{{"id": "a"}, {"id": "b"}}}
	var buffer bytes.Buffer
	if err := Render(&buffer, result, Options{Format: "jsonl"}); err != nil {
		t.Fatal(err)
	}
	if lines := strings.Split(strings.TrimSpace(buffer.String()), "\n"); len(lines) != 2 {
		t.Fatalf("JSONL lines = %d: %q", len(lines), buffer.String())
	}
}
