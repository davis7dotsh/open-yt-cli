package ops

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
		if got := FieldSelectorIncludes(test.selector, "items/id"); got != test.want {
			t.Errorf("FieldSelectorIncludes(%q) = %v, want %v", test.selector, got, test.want)
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
		if got := FieldSelectorIncludes(test.selector, "items/id/kind"); got != test.want {
			t.Errorf("FieldSelectorIncludes(%q) = %v, want %v", test.selector, got, test.want)
		}
	}
}

func TestFieldSelectorDistinguishesTopLevelMetadata(t *testing.T) {
	for _, selector := range []string{"items", "items(nextPageToken)", "items/snippet/title"} {
		if FieldSelectorIncludes(selector, "nextPageToken") {
			t.Errorf("%q incorrectly includes top-level nextPageToken", selector)
		}
		fields, _ := FieldsWithRequired(selector, "nextPageToken")
		if !FieldSelectorIncludes(fields, "nextPageToken") {
			t.Errorf("%q did not acquire top-level nextPageToken: %q", selector, fields)
		}
	}
	if !FieldSelectorIncludes("items", "items/id") {
		t.Fatal("items should include nested item ID")
	}
}
