package main

import (
	"errors"
	"reflect"
	"testing"

	"open-yt-cli/internal/cli"
	"open-yt-cli/internal/oauth"
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
		{"missing OAuth", youtube.ErrMissingOAuth, 3},
		{"invalid OAuth grant", &oauth.Error{HTTPStatus: 400, Code: "invalid_grant"}, 3},
		{"unlisted OAuth code", &oauth.Error{HTTPStatus: 400, Code: "invalid_scope"}, 3},
		{"codeless OAuth error", &oauth.Error{HTTPStatus: 400}, 3},
		{"transient OAuth error", &oauth.Error{HTTPStatus: 503, Code: "temporarily_unavailable"}, 6},
		{"OAuth server error", &oauth.Error{HTTPStatus: 500, Code: "server_error"}, 6},
		{"OAuth rate limited", &oauth.Error{HTTPStatus: 429}, 5},
		{"insufficient OAuth permissions", &youtube.APIError{HTTPStatus: 403, Code: 403, Reasons: []string{"insufficientPermissions"}}, 3},
		{"invalid key camel case", &youtube.APIError{HTTPStatus: 400, Code: 400, Reasons: []string{"keyInvalid"}}, 3},
		{"invalid key uppercase underscore", &youtube.APIError{HTTPStatus: 400, Code: 400, Reasons: []string{"badRequest", "API_KEY_INVALID"}}, 3},
		{"API not enabled", &youtube.APIError{HTTPStatus: 403, Code: 403, Reasons: []string{"accessNotConfigured"}}, 3},
		{"not found", &youtube.APIError{HTTPStatus: 404, Code: 404}, 4},
		{"local not found", errors.New("videos not found: missing"), 4},
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
