// Package cli defines the oytc command-line interface.
package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"open-yt-cli/internal/config"
	"open-yt-cli/internal/output"
	"open-yt-cli/internal/update"
	"open-yt-cli/internal/youtube"
)

type UsageError struct{ Message string }

func (e *UsageError) Error() string { return e.Message }

type App struct {
	In          io.Reader
	Out         io.Writer
	Err         io.Writer
	HTTPClient  *http.Client
	BaseURL     string
	ReadSecret  func() (string, error)
	IsOutputTTY bool
	// UpdaterFactory lets tests replace the self-updater's endpoints,
	// HTTP client, and target executable.
	UpdaterFactory func(*update.Updater) *update.Updater

	format   string
	columns  []string
	noHeader bool
	noColor  bool
	quiet    bool
	timeout  time.Duration
}

type listFlags struct {
	pageSize  int
	pageToken string
	all       bool
	limit     int
}

type apiFlags struct {
	parts  string
	fields string
	hl     string
}

func New() *App {
	app := &App{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, BaseURL: youtube.DefaultBaseURL, timeout: 20 * time.Second}
	app.IsOutputTTY = term.IsTerminal(int(os.Stdout.Fd()))
	app.ReadSecret = app.readSecret
	return app
}

func (a *App) Root() *cobra.Command {
	root := &cobra.Command{
		Use:           "oytc",
		Short:         "Read public YouTube data from the command line",
		SilenceErrors: true,
		SilenceUsage:  true,
		Long: "oytc is an API-key-only CLI for public YouTube Data API resources.\n" +
			"It never performs OAuth or private-user operations.\n\n" +
			"Get started: oytc login, then oytc status --check.\n" +
			"Docs: https://github.com/davis7dotsh/open-yt-cli/blob/main/docs/commands.md",
	}
	root.SetIn(a.In)
	root.SetOut(a.Out)
	root.SetErr(a.Err)
	root.PersistentFlags().StringVarP(&a.format, "format", "f", "", "output format: table, json, jsonl, or tsv (default: table on a TTY, json otherwise)")
	root.PersistentFlags().StringSliceVar(&a.columns, "columns", nil, "table/TSV property paths (comma-separated)")
	root.PersistentFlags().BoolVar(&a.noHeader, "no-header", false, "omit table/TSV header")
	root.PersistentFlags().BoolVar(&a.noColor, "no-color", false, "disable color (accepted for scripting; first draft emits no color)")
	root.PersistentFlags().BoolVarP(&a.quiet, "quiet", "q", false, "suppress human request summaries")
	root.PersistentFlags().DurationVar(&a.timeout, "timeout", 20*time.Second, "per-request timeout")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return &UsageError{Message: err.Error()} })
	root.PersistentPreRunE = func(_ *cobra.Command, _ []string) error {
		format := a.outputFormat()
		if format != "table" && format != "json" && format != "jsonl" && format != "tsv" {
			return &UsageError{Message: fmt.Sprintf("unsupported format %q (use table, json, jsonl, or tsv)", format)}
		}
		if a.timeout <= 0 {
			return &UsageError{Message: "--timeout must be positive"}
		}
		return nil
	}

	root.AddCommand(a.authCommands()...)
	root.AddCommand(a.searchCommand())
	root.AddCommand(a.channelCommand())
	root.AddCommand(a.videoCommand())
	root.AddCommand(a.playlistCommand())
	root.AddCommand(a.commentCommand())
	root.AddCommand(a.subscriptionCommand())
	root.AddCommand(a.liveChatCommand())
	root.AddCommand(a.categoryCommand(), a.languageCommand(), a.regionCommand())
	root.AddCommand(a.versionCommand(), a.updateCommand())
	return root
}

func (a *App) authCommands() []*cobra.Command {
	login := &cobra.Command{
		Use:   "login",
		Short: "Securely validate and save a YouTube Data API key",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
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
		},
	}

	var check bool
	status := &cobra.Command{
		Use:   "status",
		Short: "Show local credential status; optionally validate it",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			credentials, err := config.Load()
			if err != nil {
				return err
			}
			configured := credentials.Key != ""
			if a.outputFormat() != "table" {
				state := map[string]any{"configured": configured, "source": credentials.Source, "path": credentials.Path}
				if configured {
					state["fingerprint"] = config.Fingerprint(credentials.Key)
				}
				if check {
					if !configured {
						return youtube.ErrMissingKey
					}
					_, err := a.client(credentials.Key).Get(cmd.Context(), "i18nLanguages", url.Values{"part": {"snippet"}})
					state["valid"] = err == nil
					if err != nil {
						return err
					}
				}
				columns := a.columns
				if len(columns) == 0 {
					columns = []string{"configured", "source", "path", "fingerprint", "valid"}
				}
				return output.RenderObject(a.Out, state, a.outputFormat(), columns, a.noHeader)
			}
			fmt.Fprintf(a.Out, "Configured: %t\nSource: %s\nPath: %s\n", configured, valueOr(credentials.Source, "none"), credentials.Path)
			if configured {
				fmt.Fprintf(a.Out, "Fingerprint: %s\n", config.Fingerprint(credentials.Key))
			}
			if check {
				if !configured {
					return youtube.ErrMissingKey
				}
				if _, err := a.client(credentials.Key).Get(cmd.Context(), "i18nLanguages", url.Values{"part": {"snippet"}}); err != nil {
					return err
				}
				fmt.Fprintln(a.Out, "Remote check: valid")
			}
			return nil
		},
	}
	status.Flags().BoolVar(&check, "check", false, "validate the active key with the API")

	logout := &cobra.Command{
		Use:   "logout",
		Short: "Remove the stored credential",
		Args:  exactArgs(0),
		RunE: func(_ *cobra.Command, _ []string) error {
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
		},
	}
	return []*cobra.Command{login, status, logout}
}

func (a *App) searchCommand() *cobra.Command {
	var flags listFlags
	var api apiFlags
	var channelID, channelType, order, publishedAfter, publishedBefore, region, language, safeSearch, resourceType string
	var eventType, location, locationRadius, topicID, videoCaption, videoCategory, videoDuration, videoEmbeddable, videoLicense, videoPaidProductPlacement, videoSyndicated string
	cmd := &cobra.Command{
		Use:   "search [QUERY]",
		Short: "Search public YouTube resources (1 call from the 100 calls/day search bucket)",
		Args:  maximumArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			params := url.Values{"part": {partsOr(api.parts, "snippet")}}
			if len(args) == 1 {
				params.Set("q", args[0])
			}
			setValues(params, map[string]string{"channelId": channelID, "channelType": channelType, "order": order, "publishedAfter": publishedAfter, "publishedBefore": publishedBefore, "regionCode": region, "relevanceLanguage": language, "safeSearch": safeSearch, "type": resourceType, "eventType": eventType, "location": location, "locationRadius": locationRadius, "topicId": topicID, "videoCaption": videoCaption, "videoCategoryId": videoCategory, "videoDuration": videoDuration, "videoEmbeddable": videoEmbeddable, "videoLicense": videoLicense, "videoPaidProductPlacement": videoPaidProductPlacement, "videoSyndicated": videoSyndicated, "fields": api.fields})
			if err := validateEnum("--order", order, "date", "rating", "relevance", "title", "videoCount", "viewCount"); err != nil {
				return err
			}
			if err := validateEnum("--safe-search", safeSearch, "moderate", "none", "strict"); err != nil {
				return err
			}
			if err := validateCSVEnum("--type", resourceType, "video", "channel", "playlist"); err != nil {
				return err
			}
			for _, check := range []struct {
				flag, value string
				allowed     []string
			}{
				{"--channel-type", channelType, []string{"any", "show"}},
				{"--event-type", eventType, []string{"completed", "live", "upcoming"}},
				{"--video-caption", videoCaption, []string{"any", "closedCaption", "none"}},
				{"--video-duration", videoDuration, []string{"any", "short", "medium", "long"}},
				{"--video-embeddable", videoEmbeddable, []string{"any", "true"}},
				{"--video-license", videoLicense, []string{"any", "creativeCommon", "youtube"}},
				{"--video-paid-product-placement", videoPaidProductPlacement, []string{"any", "true"}},
				{"--video-syndicated", videoSyndicated, []string{"any", "true"}},
			} {
				if err := validateEnum(check.flag, check.value, check.allowed...); err != nil {
					return err
				}
			}
			if err := validateTimestamp("--published-after", publishedAfter); err != nil {
				return err
			}
			if err := validateTimestamp("--published-before", publishedBefore); err != nil {
				return err
			}
			if (location == "") != (locationRadius == "") {
				return &UsageError{Message: "--location and --location-radius must be used together"}
			}
			videoFilter := eventType != "" || location != "" || videoCaption != "" || videoCategory != "" || videoDuration != "" || videoEmbeddable != "" || videoLicense != "" || videoPaidProductPlacement != "" || videoSyndicated != ""
			if videoFilter && resourceType != "video" {
				return &UsageError{Message: "video-specific filters require --type video"}
			}
			if channelType != "" && resourceType != "channel" {
				return &UsageError{Message: "--channel-type requires --type channel"}
			}
			return a.runList(cmd, "search", params, flags, []string{"id.kind", "id.videoId", "id.channelId", "id.playlistId", "snippet.title"})
		},
	}
	addListFlags(cmd, &flags, 25, 50)
	addAPIFlags(cmd, &api, false)
	cmd.Flags().StringVar(&channelID, "channel", "", "only resources created by this channel ID")
	cmd.Flags().StringVar(&channelType, "channel-type", "", "any or show (requires --type channel)")
	cmd.Flags().StringVar(&order, "order", "relevance", "date, rating, relevance, title, videoCount, or viewCount")
	cmd.Flags().StringVar(&publishedAfter, "published-after", "", "RFC 3339 lower publication bound")
	cmd.Flags().StringVar(&publishedBefore, "published-before", "", "RFC 3339 upper publication bound")
	cmd.Flags().StringVar(&region, "region", "", "ISO 3166-1 alpha-2 region code")
	cmd.Flags().StringVar(&language, "language", "", "relevance language code")
	cmd.Flags().StringVar(&safeSearch, "safe-search", "moderate", "moderate, none, or strict")
	cmd.Flags().StringVar(&resourceType, "type", "video,channel,playlist", "comma-separated video, channel, and/or playlist")
	cmd.Flags().StringVar(&eventType, "event-type", "", "completed, live, or upcoming (video searches)")
	cmd.Flags().StringVar(&location, "location", "", "latitude,longitude for a geographic video search")
	cmd.Flags().StringVar(&locationRadius, "location-radius", "", "radius such as 5km (requires --location)")
	cmd.Flags().StringVar(&topicID, "topic", "", "Freebase topic ID")
	cmd.Flags().StringVar(&videoCaption, "video-caption", "", "any, closedCaption, or none")
	cmd.Flags().StringVar(&videoCategory, "video-category", "", "video category ID")
	cmd.Flags().StringVar(&videoDuration, "video-duration", "", "any, short, medium, or long")
	cmd.Flags().StringVar(&videoEmbeddable, "video-embeddable", "", "any or true")
	cmd.Flags().StringVar(&videoLicense, "video-license", "", "any, creativeCommon, or youtube")
	cmd.Flags().StringVar(&videoPaidProductPlacement, "video-paid-product-placement", "", "any or true")
	cmd.Flags().StringVar(&videoSyndicated, "video-syndicated", "", "any or true")
	return cmd
}

func (a *App) client(key string) *youtube.Client {
	client := youtube.NewClient(key, a.timeout)
	if a.BaseURL != "" {
		client.BaseURL = a.BaseURL
	}
	if a.HTTPClient != nil {
		client.HTTPClient = a.HTTPClient
	}
	return client
}

func (a *App) authenticatedClient() (*youtube.Client, error) {
	credentials, err := config.Load()
	if err != nil {
		return nil, err
	}
	if credentials.Key == "" {
		return nil, youtube.ErrMissingKey
	}
	return a.client(credentials.Key), nil
}

func (a *App) runList(cmd *cobra.Command, resource string, params url.Values, flags listFlags, defaultColumns []string) error {
	client, err := a.authenticatedClient()
	if err != nil {
		return err
	}
	result, err := client.List(cmd.Context(), resource, params, youtube.PageOptions{All: flags.all, Limit: flags.limit, PageSize: flags.pageSize, PageToken: flags.pageToken})
	if err != nil {
		return err
	}
	return a.renderResult(result, defaultColumns)
}

func (a *App) renderResult(result youtube.ListResult, defaultColumns []string) error {
	columns := a.columns
	if len(columns) == 0 {
		columns = defaultColumns
	}
	if err := output.Render(a.Out, result, output.Options{Format: a.outputFormat(), Columns: columns, NoHeader: a.noHeader}); err != nil {
		return &UsageError{Message: err.Error()}
	}
	if !a.quiet && a.outputFormat() == "table" {
		fmt.Fprintf(a.Err, "%d item(s), %d request(s)", len(result.Items), result.Requests)
		if result.NextPageToken != "" {
			fmt.Fprintf(a.Err, "; more available (next token: %s)", result.NextPageToken)
		}
		fmt.Fprintln(a.Err)
	}
	return nil
}

func (a *App) outputFormat() string {
	if a.format != "" {
		return strings.ToLower(a.format)
	}
	if a.IsOutputTTY {
		return "table"
	}
	return "json"
}

func (a *App) readSecret() (string, error) {
	if file, ok := a.In.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		data, err := term.ReadPassword(int(file.Fd()))
		return string(data), err
	}
	line, err := bufio.NewReader(a.In).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func addListFlags(cmd *cobra.Command, flags *listFlags, defaultSize, maxSize int) {
	cmd.Flags().IntVar(&flags.pageSize, "page-size", defaultSize, fmt.Sprintf("results per request (1-%d)", maxSize))
	cmd.Flags().StringVar(&flags.pageToken, "page-token", "", "start at this API page token")
	cmd.Flags().BoolVar(&flags.all, "all", false, "fetch all available pages")
	cmd.Flags().IntVar(&flags.limit, "limit", 0, "maximum items to emit (0 means no additional limit)")
	cmd.PreRunE = chainPreRun(cmd.PreRunE, func(_ *cobra.Command, _ []string) error {
		if flags.pageSize < 1 || flags.pageSize > maxSize {
			return &UsageError{Message: fmt.Sprintf("--page-size must be between 1 and %d", maxSize)}
		}
		if flags.limit < 0 {
			return &UsageError{Message: "--limit cannot be negative"}
		}
		return nil
	})
}

func addAPIFlags(cmd *cobra.Command, flags *apiFlags, withHL bool) {
	cmd.Flags().StringVar(&flags.parts, "parts", "", "comma-separated API resource parts")
	cmd.Flags().StringVar(&flags.fields, "fields", "", "Google partial-response fields selector")
	if withHL {
		cmd.Flags().StringVar(&flags.hl, "hl", "", "localization language code")
	}
}

func chainPreRun(first func(*cobra.Command, []string) error, second func(*cobra.Command, []string) error) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		if first != nil {
			if err := first(cmd, args); err != nil {
				return err
			}
		}
		return second(cmd, args)
	}
}

func exactArgs(count int) cobra.PositionalArgs {
	return func(_ *cobra.Command, args []string) error {
		if len(args) != count {
			return &UsageError{Message: fmt.Sprintf("expected %d argument(s), received %d", count, len(args))}
		}
		return nil
	}
}

func minimumArgs(count int) cobra.PositionalArgs {
	return func(_ *cobra.Command, args []string) error {
		if len(args) < count {
			return &UsageError{Message: fmt.Sprintf("expected at least %d argument(s), received %d", count, len(args))}
		}
		return nil
	}
}

func maximumArgs(count int) cobra.PositionalArgs {
	return func(_ *cobra.Command, args []string) error {
		if len(args) > count {
			return &UsageError{Message: fmt.Sprintf("expected at most %d argument(s), received %d", count, len(args))}
		}
		return nil
	}
}

func partsOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func setValues(values url.Values, entries map[string]string) {
	for key, value := range entries {
		if value != "" {
			values.Set(key, value)
		}
	}
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func validateTimestamp(flag, value string) error {
	if value == "" {
		return nil
	}
	if _, err := time.Parse(time.RFC3339, value); err != nil {
		return &UsageError{Message: fmt.Sprintf("%s must be an RFC 3339 timestamp", flag)}
	}
	return nil
}

func validateCSVEnum(flag, value string, allowed ...string) error {
	for _, entry := range strings.Split(value, ",") {
		if err := validateEnum(flag, strings.TrimSpace(entry), allowed...); err != nil {
			return err
		}
	}
	return nil
}

func validateEnum(flag, value string, allowed ...string) error {
	if value == "" {
		return nil
	}
	for _, candidate := range allowed {
		if value == candidate {
			return nil
		}
	}
	return &UsageError{Message: fmt.Sprintf("%s must be one of: %s", flag, strings.Join(allowed, ", "))}
}

func validateParts(parts string, forbidden ...string) error {
	for _, value := range strings.Split(parts, ",") {
		for _, blocked := range forbidden {
			if strings.TrimSpace(value) == blocked {
				return &UsageError{Message: fmt.Sprintf("part %q requires owner/OAuth access and is not supported", blocked)}
			}
		}
	}
	return nil
}

func batch(values []string, size int) [][]string {
	var batches [][]string
	for len(values) > 0 {
		count := min(size, len(values))
		batches = append(batches, values[:count])
		values = values[count:]
	}
	return batches
}
