package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"strings"
	"testing"

	"open-yt-cli/internal/version"
	"open-yt-cli/internal/youtube"
)

func TestLoginHelpAndPromptsLinkToSetup(t *testing.T) {
	t.Setenv("OYTC_OAUTH_CLIENT_ID", "")
	t.Setenv("OYTC_OAUTH_CLIENT_SECRET", "")

	app := New()
	var out bytes.Buffer
	app.Out = &out
	if err := execute(t, app, "login", "--help"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), apiKeySetupURL) || !strings.Contains(out.String(), oauthSetupURL) {
		t.Fatalf("login help omitted setup links: %s", out.String())
	}

	for _, test := range []struct {
		name string
		args []string
		url  string
	}{
		{name: "API key", args: []string{"login"}, url: apiKeySetupURL},
		{name: "OAuth", args: []string{"login", "--oauth"}, url: oauthSetupURL},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := New()
			app.In = bytes.NewBuffer(nil)
			var stderr bytes.Buffer
			app.Err = &stderr
			var usage *UsageError
			if err := execute(t, app, test.args...); !errors.As(err, &usage) {
				t.Fatalf("empty input error = %T %v, want UsageError", err, err)
			}
			if !strings.Contains(stderr.String(), test.url) {
				t.Fatalf("prompt omitted setup link: %s", stderr.String())
			}
		})
	}
}

func TestLoginEOFIsUsageForEveryPrompt(t *testing.T) {
	t.Setenv("OYTC_OAUTH_CLIENT_ID", "")
	t.Setenv("OYTC_OAUTH_CLIENT_SECRET", "")
	for _, test := range []struct {
		name       string
		args       []string
		input      string
		readSecret func() (string, error)
		message    string
	}{
		{name: "API key", args: []string{"login"}, readSecret: func() (string, error) { return "", io.EOF }, message: "API key cannot be empty"},
		{name: "OAuth client ID", args: []string{"login", "--oauth"}, message: "OAuth client ID cannot be empty"},
		{name: "OAuth client secret", args: []string{"login", "--oauth"}, input: "client-id\n", readSecret: func() (string, error) { return "", io.EOF }, message: "OAuth client secret cannot be empty"},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := New()
			app.In = bytes.NewBufferString(test.input)
			app.Out = io.Discard
			app.Err = io.Discard
			if test.readSecret != nil {
				app.ReadSecret = test.readSecret
			}
			var usage *UsageError
			if err := execute(t, app, test.args...); !errors.As(err, &usage) || usage.Message != test.message {
				t.Fatalf("error = %T %v, want UsageError %q", err, err, test.message)
			}
		})
	}
}

func TestStatusCheckWithoutCredentialsRendersStateThenFails(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	app := New()
	var out bytes.Buffer
	app.Out = &out
	err := execute(t, app, "status", "--check", "--format", "json")
	if !errors.Is(err, youtube.ErrMissingKey) {
		t.Fatalf("status error = %v, want missing credentials", err)
	}
	var state struct {
		APIKey struct {
			Configured bool `json:"configured"`
		} `json:"api_key"`
		OAuth struct {
			Configured bool `json:"configured"`
		} `json:"oauth"`
	}
	if err := json.Unmarshal(out.Bytes(), &state); err != nil {
		t.Fatalf("status did not render JSON: %v; output = %q", err, out.String())
	}
	if state.APIKey.Configured || state.OAuth.Configured {
		t.Fatalf("status reported credentials when none exist: %s", out.String())
	}
}

func TestStatusAndVersionHonorTableColumnsAndNoHeader(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	for _, test := range []struct {
		name string
		args []string
		want []string
	}{
		{name: "status columns", args: []string{"status", "--format", "table", "--columns", "api_key.configured,oauth.configured", "--no-header"}, want: []string{"false", "false"}},
		{name: "version columns", args: []string{"version", "--format", "table", "--columns", "version,os", "--no-header"}, want: []string{version.Get().Version, runtime.GOOS}},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := New()
			var out bytes.Buffer
			app.Out = &out
			if err := execute(t, app, test.args...); err != nil {
				t.Fatal(err)
			}
			got := strings.Fields(out.String())
			if len(got) != len(test.want) {
				t.Fatalf("table fields = %q, want %q", got, test.want)
			}
			for i, want := range test.want {
				if got[i] != want {
					t.Fatalf("table fields = %q, want %q", got, test.want)
				}
			}
		})
	}
}

func TestStatusNoHeaderUsesRowOutput(t *testing.T) {
	t.Setenv("OYTC_CONFIG_DIR", t.TempDir())
	t.Setenv("OYTC_API_KEY", "")
	app := New()
	var out bytes.Buffer
	app.Out = &out
	if err := execute(t, app, "status", "--format", "table", "--no-header"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "Path:") || strings.Contains(out.String(), "API key configured:") || strings.Contains(out.String(), "CONFIGURED") {
		t.Fatalf("--no-header rendered labels: %q", out.String())
	}
}
