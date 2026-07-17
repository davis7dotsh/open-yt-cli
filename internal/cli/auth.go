package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/config"
	"open-yt-cli/internal/oauth"
	"open-yt-cli/internal/output"
	"open-yt-cli/internal/youtube"
)

const (
	youtubeReadonlyScope   = "https://www.googleapis.com/auth/youtube.readonly"
	analyticsReadonlyScope = "https://www.googleapis.com/auth/yt-analytics.readonly"
)

var oauthScopes = []string{youtubeReadonlyScope, analyticsReadonlyScope}

func (a *App) authenticationCommands() []*cobra.Command {
	var useOAuth bool
	login := &cobra.Command{
		Use:   "login",
		Short: "Validate and save an API key or read-only OAuth authorization",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if useOAuth {
				return a.loginOAuth(cmd)
			}
			return a.loginAPIKey(cmd)
		},
	}
	login.Flags().BoolVar(&useOAuth, "oauth", false, "authorize read-only access to your channel and Analytics")

	var check bool
	status := &cobra.Command{
		Use:   "status",
		Short: "Show API-key and OAuth status; optionally validate them",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runStatus(cmd, check)
		},
	}
	status.Flags().BoolVar(&check, "check", false, "validate configured credentials with the API")

	logout := &cobra.Command{
		Use:   "logout",
		Short: "Revoke OAuth best-effort and remove stored credentials",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runLogout(cmd.Context())
		},
	}
	return []*cobra.Command{login, status, logout}
}

func (a *App) loginAPIKey(cmd *cobra.Command) error {
	fmt.Fprint(a.Err, "YouTube Data API key: ")
	key, err := a.ReadSecret()
	fmt.Fprintln(a.Err)
	if err != nil {
		return fmt.Errorf("read API key: %w", err)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return &UsageError{Message: "API key cannot be empty"}
	}
	client := a.client(key)
	if _, err := client.Get(cmd.Context(), "i18nLanguages", url.Values{"part": {"snippet"}}); err != nil {
		return fmt.Errorf("API key validation failed: %w", err)
	}
	path, err := config.Save(key)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.Out, "API key validated and saved to %s (%s)\n", path, config.Fingerprint(key))
	if config.EnvKeySet() {
		fmt.Fprintln(a.Out, "Note: OYTC_API_KEY remains the active, higher-precedence credential.")
	}
	return nil
}

func (a *App) loginOAuth(cmd *cobra.Command) error {
	clientID, clientSecret := config.OAuthBootstrap()
	reader := bufio.NewReader(a.In)
	var err error
	if clientID == "" {
		fmt.Fprint(a.Err, "OAuth client ID: ")
		clientID, err = reader.ReadString('\n')
		if err != nil && strings.TrimSpace(clientID) == "" {
			return fmt.Errorf("read OAuth client ID: %w", err)
		}
		clientID = strings.TrimSpace(clientID)
	}
	if clientSecret == "" {
		fmt.Fprint(a.Err, "OAuth client secret: ")
		clientSecret, err = a.ReadSecret()
		fmt.Fprintln(a.Err)
		if err != nil {
			return fmt.Errorf("read OAuth client secret: %w", err)
		}
		clientSecret = strings.TrimSpace(clientSecret)
	}
	if clientID == "" || clientSecret == "" {
		return &UsageError{Message: "OAuth client ID and client secret cannot be empty"}
	}

	token, err := oauth.Login(cmd.Context(), a.oauthConfig(clientID, clientSecret))
	if err != nil {
		return fmt.Errorf("OAuth login failed: %w", err)
	}
	path, err := config.SaveOAuth(storedOAuth(clientID, clientSecret, token))
	if err != nil {
		return err
	}
	fmt.Fprintf(a.Out, "OAuth authorization saved to %s\nGranted scopes: %s\n", path, strings.Join(token.Scopes, ", "))
	return nil
}

func (a *App) runStatus(cmd *cobra.Command, check bool) error {
	credentials, err := config.Load()
	if err != nil {
		return err
	}
	keyConfigured := credentials.Key != ""
	oauthConfigured := credentials.OAuth != nil
	state := map[string]any{
		"path": credentials.Path,
		"api_key": map[string]any{
			"configured": keyConfigured,
			"source":     valueOr(credentials.Source, "none"),
		},
		"oauth": oauthStatus(credentials.OAuth),
	}
	if keyConfigured {
		state["api_key"].(map[string]any)["fingerprint"] = config.Fingerprint(credentials.Key)
	}
	if check {
		if !keyConfigured && !oauthConfigured {
			return youtube.ErrMissingKey
		}
		if keyConfigured {
			_, err := a.client(credentials.Key).Get(cmd.Context(), "i18nLanguages", url.Values{"part": {"snippet"}})
			state["api_key"].(map[string]any)["valid"] = err == nil
			if err != nil {
				return err
			}
		}
		if oauthConfigured {
			source, err := a.oauthTokenSource(credentials.OAuth)
			if err != nil {
				return err
			}
			client := a.client("")
			client.TokenSource = source.AccessToken
			_, err = client.Get(cmd.Context(), "i18nLanguages", url.Values{"part": {"snippet"}})
			state["oauth"].(map[string]any)["valid"] = err == nil
			if err != nil {
				return oauthAuthHint(err)
			}
		}
	}

	if a.outputFormat() != "table" {
		columns := a.columns
		if len(columns) == 0 {
			columns = []string{"path", "api_key.configured", "api_key.source", "api_key.fingerprint", "oauth.configured", "oauth.client_id", "oauth.scopes", "oauth.expiry"}
		}
		return output.RenderObject(a.Out, state, a.outputFormat(), columns, a.noHeader)
	}
	fmt.Fprintf(a.Out, "Path: %s\nAPI key configured: %t\nAPI key source: %s\n", credentials.Path, keyConfigured, valueOr(credentials.Source, "none"))
	if keyConfigured {
		fmt.Fprintf(a.Out, "API key fingerprint: %s\n", config.Fingerprint(credentials.Key))
	}
	fmt.Fprintf(a.Out, "OAuth configured: %t\n", oauthConfigured)
	if oauthConfigured {
		fmt.Fprintf(a.Out, "OAuth client ID: %s\nOAuth scopes: %s\nOAuth token expiry: %s\n", credentials.OAuth.ClientID, strings.Join(credentials.OAuth.Scopes, ", "), valueOr(credentials.OAuth.Expiry, "unknown"))
	}
	if check {
		if keyConfigured {
			fmt.Fprintln(a.Out, "API key remote check: valid")
		}
		if oauthConfigured {
			fmt.Fprintln(a.Out, "OAuth remote check: valid")
		}
	}
	return nil
}

func (a *App) runLogout(ctx context.Context) error {
	credentials, loadErr := config.Load()
	if loadErr != nil {
		return loadErr
	}
	if credentials.OAuth != nil {
		token := credentials.OAuth.RefreshToken
		if token == "" {
			token = credentials.OAuth.AccessToken
		}
		if err := oauth.Revoke(ctx, a.oauthConfig(credentials.OAuth.ClientID, credentials.OAuth.ClientSecret), token); err != nil {
			fmt.Fprintf(a.Err, "Warning: could not revoke OAuth token: %v\n", err)
		}
	}
	path, removed, err := config.Remove()
	if err != nil {
		return err
	}
	if removed {
		fmt.Fprintf(a.Out, "Removed stored credentials at %s.\n", path)
	} else {
		fmt.Fprintf(a.Out, "No stored credentials at %s.\n", path)
	}
	if config.EnvKeySet() {
		fmt.Fprintln(a.Out, "OYTC_API_KEY is still set; environment credentials remain active.")
	}
	return nil
}

func (a *App) oauthConfig(clientID, clientSecret string) oauth.Config {
	return oauth.Config{
		ClientID:         clientID,
		ClientSecret:     clientSecret,
		Scopes:           oauthScopes,
		AuthorizationURL: a.OAuthAuthURL,
		TokenURL:         a.OAuthTokenURL,
		RevokeURL:        a.OAuthRevokeURL,
		HTTPClient:       a.HTTPClient,
		OpenBrowser:      a.OpenBrowser,
		Out:              a.Err,
		Timeout:          3 * time.Minute,
		Now:              a.Now,
	}
}

func (a *App) oauthTokenSource(credentials *config.OAuthCredentials) (*oauth.TokenSource, error) {
	if credentials == nil {
		return nil, youtube.ErrMissingOAuth
	}
	expiry, err := oauth.ParseExpiry(credentials.Expiry)
	if err != nil {
		return nil, err
	}
	clientID, clientSecret := credentials.ClientID, credentials.ClientSecret
	source := &oauth.TokenSource{
		Config: a.oauthConfig(clientID, clientSecret),
		Token: oauth.Token{
			AccessToken:  credentials.AccessToken,
			RefreshToken: credentials.RefreshToken,
			Expiry:       expiry,
			Scopes:       append([]string(nil), credentials.Scopes...),
		},
	}
	source.OnUpdate = func(token oauth.Token) error {
		_, err := config.SaveOAuth(storedOAuth(clientID, clientSecret, token))
		return err
	}
	return source, nil
}

func storedOAuth(clientID, clientSecret string, token oauth.Token) config.OAuthCredentials {
	return config.OAuthCredentials{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		Expiry:       oauth.FormatExpiry(token.Expiry),
		Scopes:       append([]string(nil), token.Scopes...),
	}
}

func oauthStatus(credentials *config.OAuthCredentials) map[string]any {
	if credentials == nil {
		return map[string]any{"configured": false}
	}
	return map[string]any{
		"configured": true,
		"client_id":  credentials.ClientID,
		"scopes":     append([]string(nil), credentials.Scopes...),
		"expiry":     credentials.Expiry,
	}
}

func oauthAuthHint(err error) error {
	var apiErr *youtube.APIError
	if strings.Contains(strings.ToLower(err.Error()), "invalid_grant") {
		return fmt.Errorf("OAuth authorization failed; re-run 'oytc login --oauth': %w", err)
	}
	if !errors.As(err, &apiErr) {
		return err
	}
	if apiErr.HTTPStatus == 401 {
		return fmt.Errorf("OAuth authorization failed; re-run 'oytc login --oauth': %w", err)
	}
	for _, reason := range apiErr.Reasons {
		if strings.EqualFold(reason, "insufficientPermissions") {
			return fmt.Errorf("OAuth scopes are insufficient; re-run 'oytc login --oauth': %w", err)
		}
	}
	return err
}
