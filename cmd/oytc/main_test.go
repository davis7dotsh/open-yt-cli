package main

import (
	"errors"
	"reflect"
	"testing"

	"open-yt-cli/internal/cli"
	"open-yt-cli/internal/youtube"
)

func TestDispatchArgs(t *testing.T) {
	tests := []struct {
		argv0 string
		rest  []string
		want  []string
	}{
		{"oytc", []string{"search", "cats"}, []string{"search", "cats"}},
		{"/usr/local/bin/oytc", nil, nil},
		{"oytc_update", nil, []string{"update"}},
		{"/home/user/.local/bin/oytc_update", []string{"--check"}, []string{"update", "--check"}},
		{"oytc_upgrade", nil, []string{"update"}},
		{"oytc-update", nil, []string{"update"}},
		{"oytc-upgrade", []string{"--version", "v1.0.0"}, []string{"update", "--version", "v1.0.0"}},
		{`C:\Users\u\oytc_update.exe`, nil, []string{"update"}},
		{"oytc_updater", []string{"x"}, []string{"x"}},
	}
	for _, test := range tests {
		got := dispatchArgs(test.argv0, test.rest)
		if !reflect.DeepEqual(got, test.want) {
			t.Errorf("dispatchArgs(%q, %v) = %v, want %v", test.argv0, test.rest, got, test.want)
		}
	}
}

func TestExitCodes(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"usage", &cli.UsageError{Message: "bad flag"}, 2},
		{"unknown command", errors.New(`unknown command "wat"`), 2},
		{"missing key", youtube.ErrMissingKey, 3},
		{"not found", &youtube.APIError{HTTPStatus: 404, Code: 404}, 4},
		{"quota", &youtube.APIError{HTTPStatus: 403, Code: 403, Reasons: []string{"quotaExceeded"}}, 5},
		{"rate limit", &youtube.APIError{HTTPStatus: 429, Code: 429}, 5},
		{"upstream", &youtube.APIError{HTTPStatus: 503, Code: 503}, 6},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := exitCode(test.err); got != test.want {
				t.Fatalf("exitCode(%v) = %d, want %d", test.err, got, test.want)
			}
		})
	}
}
