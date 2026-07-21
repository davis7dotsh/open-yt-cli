package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"open-yt-cli/internal/cli"
	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/youtube"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	app := cli.New()
	root := app.Root()
	root.SetArgs(dispatchArgs(os.Args[0], os.Args[1:]))
	err := root.ExecuteContext(ctx)
	if err == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "oytc: %v\n", err)
	os.Exit(exitCode(err))
}

// dispatchArgs implements argv[0] dispatch: when the binary is invoked as
// oytc_update or oytc_upgrade (for example through an installer-created
// symlink or shim), it behaves exactly like `oytc update`. Any extra
// arguments (such as --check) are passed through to the update command.
func dispatchArgs(argv0 string, rest []string) []string {
	// Split on both separators so Windows-style argv[0] values work everywhere.
	base := filepath.Base(strings.ReplaceAll(argv0, `\`, "/"))
	name := strings.TrimSuffix(base, ".exe")
	switch name {
	case "oytc_update", "oytc-update", "oytc_upgrade", "oytc-upgrade":
		return append([]string{"update"}, rest...)
	}
	return rest
}

func exitCode(err error) int {
	var usage *cli.UsageError
	if errors.As(err, &usage) {
		return 2
	}
	if errors.Is(err, youtube.ErrMissingKey) || errors.Is(err, youtube.ErrMissingOAuth) {
		return 3
	}
	var oauthErr *oauth.Error
	if errors.As(err, &oauthErr) {
		// Every structured OAuth failure is an auth problem (exit 3)
		// except clearly transient Google-side errors.
		switch oauthErr.Code {
		case "server_error", "temporarily_unavailable":
			return 6
		}
		if oauthErr.HTTPStatus == 429 {
			return 5
		}
		if oauthErr.HTTPStatus >= 500 {
			return 6
		}
		return 3
	}
	var apiErr *youtube.APIError
	if errors.As(err, &apiErr) {
		reasons := strings.ToLower(strings.Join(apiErr.Reasons, ","))
		normalizedReasons := strings.NewReplacer("_", "", "-", "").Replace(reasons)
		if strings.Contains(normalizedReasons, "keyinvalid") || strings.Contains(normalizedReasons, "apikeyinvalid") || strings.Contains(normalizedReasons, "accessnotconfigured") || strings.Contains(normalizedReasons, "insufficientpermissions") || apiErr.HTTPStatus == 401 {
			return 3
		}
		if apiErr.HTTPStatus == 404 {
			return 4
		}
		if apiErr.HTTPStatus == 429 || strings.Contains(strings.ToLower(reasons), "quota") || strings.Contains(strings.ToLower(reasons), "ratelimit") {
			return 5
		}
		if apiErr.HTTPStatus == 403 {
			return 4
		}
		if apiErr.HTTPStatus >= 500 {
			return 6
		}
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "invalid_grant") || strings.Contains(message, "re-run 'oytc login --oauth'") {
		return 3
	}
	if strings.Contains(message, "unknown command") || strings.Contains(message, "unknown flag") {
		return 2
	}
	if strings.Contains(message, "not found") || strings.Contains(message, "no active public live chat") || strings.Contains(message, "no public uploads") {
		return 4
	}
	if errors.Is(err, context.Canceled) {
		return 130
	}
	return 6
}
