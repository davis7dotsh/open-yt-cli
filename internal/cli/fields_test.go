package cli

import "testing"

func TestFieldSelectorIncludes(t *testing.T) {
	tests := []struct {
		selector string
		want     bool
	}{
		{"", false},
		{"items", true},
		{"items/*", true},
		{"items/id", true},
		{"items(id/videoId,snippet/title),nextPageToken", true},
		{"items(snippet/title),nextPageToken", false},
		{"items/snippet/resourceId/channelId", false},
	}
	for _, test := range tests {
		if got := fieldSelectorIncludes(test.selector, "items/id"); got != test.want {
			t.Errorf("fieldSelectorIncludes(%q) = %v, want %v", test.selector, got, test.want)
		}
	}
}

func TestFieldSelectorIncludesNestedSearchKind(t *testing.T) {
	tests := []struct {
		selector string
		want     bool
	}{
		{"items", true},
		{"items/id", true},
		{"items/id/*", true},
		{"items/id/kind", true},
		{"items(id/kind,snippet/title)", true},
		{"items(id/*,snippet/title)", true},
		{"items(id/channelId,snippet/title)", false},
		{"items(id/videoId,snippet/title)", false},
	}
	for _, test := range tests {
		if got := fieldSelectorIncludes(test.selector, "items/id/kind"); got != test.want {
			t.Errorf("fieldSelectorIncludes(%q) = %v, want %v", test.selector, got, test.want)
		}
	}
}
