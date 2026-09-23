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

func TestFieldSelectorDistinguishesTopLevelMetadata(t *testing.T) {
	for _, selector := range []string{"items", "items(nextPageToken)", "items/snippet/title"} {
		if fieldSelectorIncludes(selector, "nextPageToken") {
			t.Errorf("%q incorrectly includes top-level nextPageToken", selector)
		}
		fields, _ := fieldsWithRequired(selector, "nextPageToken")
		if !fieldSelectorIncludes(fields, "nextPageToken") {
			t.Errorf("%q did not acquire top-level nextPageToken: %q", selector, fields)
		}
	}
	if !fieldSelectorIncludes("items", "items/id") {
		t.Fatal("items should include nested item ID")
	}
}
