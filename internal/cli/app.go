// Package cli defines the oytc command-line interface.
package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"open-yt-cli/internal/config"
	"open-yt-cli/internal/ops"
	"open-yt-cli/internal/output"
	"open-yt-cli/internal/update"
	"open-yt-cli/internal/version"
	"open-yt-cli/internal/youtube"
)

// UsageError is an invalid invocation; operations report theirs as
// ops.InputError, so both exit with the usage code.
type UsageError = ops.InputError

type App struct {
	In               io.Reader
	Out              io.Writer
	Err              io.Writer
	HTTPClient       *http.Client
	BaseURL          string
	AnalyticsBaseURL string
	OAuthAuthURL     string
	OAuthTokenURL    string
	OAuthRevokeURL   string
	OpenBrowser      func(string) error
	Now              func() time.Time
	ReadSecret       func() (string, error)
	// stdin buffers a.In so consecutive prompts (e.g. OAuth client ID then
	// secret) never lose bytes prefetched by an earlier bufio.Reader.
	stdin       *bufio.Reader
	IsOutputTTY bool
	// UpdaterFactory lets tests replace the self-updater's endpoints,
	// HTTP client, and target executable.
	UpdaterFactory func(*update.Updater) *update.Updater
	// SkillInstallPath overrides ~/.agents/skills/oytc in tests.
	SkillInstallPath string

	format   string
	columns  []string
	noHeader bool
	noColor  bool
	quiet    bool
	timeout  time.Duration
}

func New() *App {
	app := &App{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, BaseURL: youtube.DefaultBaseURL, timeout: 20 * time.Second, Now: time.Now}
	app.IsOutputTTY = term.IsTerminal(int(os.Stdout.Fd()))
	app.ReadSecret = app.readSecret
	return app
}

func (a *App) Root() *cobra.Command {
	root := &cobra.Command{
		Use:           "oytc",
		Short:         "Read YouTube data and your channel analytics",
		Version:       version.Get().Version,
		SilenceErrors: true,
		SilenceUsage:  true,
		Long: "oytc is a read-only CLI for public YouTube data and your own channel analytics.\n" +
			"API keys cover public data; OAuth enables read-only owner analytics.\n\n" +
			"Get started: oytc login, then oytc status --check.\n" +
			"Docs: https://github.com/davis7dotsh/open-yt-cli/blob/main/docs/commands.md",
	}
	root.SetIn(a.In)
	root.SetOut(a.Out)
	root.SetErr(a.Err)
	root.SetVersionTemplate("oytc {{.Version}}\n")
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

	root.AddCommand(a.authenticationCommands()...)
	root.AddCommand(a.analyticsCommand())
	root.AddCommand(a.searchCommand())
	root.AddCommand(a.channelCommand())
	root.AddCommand(a.videoCommand())
	root.AddCommand(a.playlistCommand())
	root.AddCommand(a.commentCommand())
	root.AddCommand(a.subscriptionCommand())
	root.AddCommand(a.liveChatCommand())
	root.AddCommand(a.categoryCommand(), a.languageCommand(), a.regionCommand())
	root.AddCommand(a.versionCommand(), a.updateCommand(), a.skillsCommand(), a.mcpCommand())
	return root
}

func (a *App) searchCommand() *cobra.Command {
	var in ops.SearchInput
	cmd := &cobra.Command{
		Use:   "search [QUERY]",
		Short: "Search public YouTube resources (1 call from the 100 calls/day search bucket)",
		Args:  maximumArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 1 {
				in.Query = args[0]
			}
			result, err := ops.Search(cmd.Context(), a.dataClient, in)
			if err != nil {
				return err
			}
			return a.renderResult(result, []string{"id.kind", "id.videoId", "id.channelId", "id.playlistId", "snippet.title"})
		},
	}
	addPageFlags(cmd, &in.Page, 25, 50)
	addAPIFlags(cmd, &in.API)
	cmd.Flags().StringVar(&in.Channel, "channel", "", "only resources created by this channel ID")
	cmd.Flags().StringVar(&in.ChannelType, "channel-type", "", "any or show (requires --type channel)")
	cmd.Flags().StringVar(&in.Order, "order", "relevance", "date, rating, relevance, title, videoCount, or viewCount")
	cmd.Flags().StringVar(&in.PublishedAfter, "published-after", "", "RFC 3339 lower publication bound")
	cmd.Flags().StringVar(&in.PublishedBefore, "published-before", "", "RFC 3339 upper publication bound")
	cmd.Flags().StringVar(&in.Region, "region", "", "ISO 3166-1 alpha-2 region code")
	cmd.Flags().StringVar(&in.Language, "language", "", "relevance language code")
	cmd.Flags().StringVar(&in.SafeSearch, "safe-search", "moderate", "moderate, none, or strict")
	cmd.Flags().StringVar(&in.Type, "type", "video,channel,playlist", "comma-separated video, channel, and/or playlist")
	cmd.Flags().StringVar(&in.EventType, "event-type", "", "completed, live, or upcoming (video searches)")
	cmd.Flags().StringVar(&in.Location, "location", "", "latitude,longitude for a geographic video search")
	cmd.Flags().StringVar(&in.LocationRadius, "location-radius", "", "radius such as 5km (requires --location)")
	cmd.Flags().StringVar(&in.Topic, "topic", "", "Freebase topic ID")
	cmd.Flags().StringVar(&in.VideoCaption, "video-caption", "", "any, closedCaption, or none")
	cmd.Flags().StringVar(&in.VideoCategory, "video-category", "", "video category ID")
	cmd.Flags().StringVar(&in.VideoDuration, "video-duration", "", "any, short, medium, or long")
	cmd.Flags().StringVar(&in.VideoEmbeddable, "video-embeddable", "", "any or true")
	cmd.Flags().StringVar(&in.VideoLicense, "video-license", "", "any, creativeCommon, or youtube")
	cmd.Flags().StringVar(&in.VideoPaidProductPlacement, "video-paid-product-placement", "", "any or true")
	cmd.Flags().StringVar(&in.VideoSyndicated, "video-syndicated", "", "any or true")
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

// dataClient is the CLI's ops.DataClient: the API key, else an OAuth grant
// that covers Data API reads.
func (a *App) dataClient(context.Context) (*youtube.Client, error) {
	credentials, err := config.Load()
	if err != nil {
		return nil, err
	}
	if credentials.Key != "" {
		return a.client(credentials.Key), nil
	}
	// Only fall back to OAuth for Data API reads when the stored grant
	// actually covers them; the default analytics-only authorization would
	// produce an opaque 401/403 instead of a clear "run login" hint.
	if credentials.OAuth == nil || !hasScope(credentials.OAuth.Scopes, youtubeReadonlyScope) {
		return nil, youtube.ErrMissingKey
	}
	source, err := a.oauthTokenSource(credentials.OAuth)
	if err != nil {
		return nil, err
	}
	client := a.client("")
	client.TokenSource = source.AccessToken
	return client, nil
}

// publicClient is an ops.DataClient for keyless endpoints.
func (a *App) publicClient(context.Context) (*youtube.Client, error) {
	return a.client(""), nil
}

func hasScope(scopes []string, scope string) bool {
	for _, granted := range scopes {
		if granted == scope {
			return true
		}
	}
	return false
}

func (a *App) renderResult(result youtube.ListResult, defaultColumns []string) error {
	format := a.outputFormat()
	columns := a.columns
	if len(columns) == 0 {
		columns = defaultColumns
	}
	if err := output.Render(a.Out, result, output.Options{Format: format, Columns: columns, NoHeader: a.noHeader}); err != nil {
		return &UsageError{Message: err.Error()}
	}
	if result.CompletionUncertain {
		fmt.Fprintln(a.Err, "warning: Analytics result may be incomplete; rerun time-grouped reports with --all, or narrow the date range or filters to verify coverage")
	}
	if a.quiet {
		return nil
	}
	if format == "table" {
		fmt.Fprintf(a.Err, "%d item(s), %d request(s)", len(result.Items), result.Requests)
		writeContinuationHint(a.Err, result, "; ")
		fmt.Fprintln(a.Err)
	} else if format == "jsonl" || format == "tsv" {
		if result.NextPageToken != "" || result.NextStartIndex > 0 {
			writeContinuationHint(a.Err, result, "")
			fmt.Fprintln(a.Err)
		}
	}
	return nil
}

func writeContinuationHint(w io.Writer, result youtube.ListResult, prefix string) {
	if result.NextPageToken != "" {
		fmt.Fprintf(w, "%smore available (resume with --page-token %s)", prefix, result.NextPageToken)
		prefix = "; "
	}
	if result.NextStartIndex > 0 {
		fmt.Fprintf(w, "%smore may be available (resume with --start-index %d)", prefix, result.NextStartIndex)
	}
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
	line, err := a.stdinReader().ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// stdinReader returns a single shared buffered reader over a.In. Creating a
// fresh bufio.Reader per prompt would drop bytes an earlier reader had already
// buffered from piped input.
func (a *App) stdinReader() *bufio.Reader {
	if a.stdin == nil {
		a.stdin = bufio.NewReader(a.In)
	}
	return a.stdin
}

func addPageFlags(cmd *cobra.Command, page *ops.Page, defaultSize, maxSize int) {
	cmd.Flags().IntVar(&page.PageSize, "page-size", defaultSize, fmt.Sprintf("results per request (1-%d)", maxSize))
	cmd.Flags().StringVar(&page.PageToken, "page-token", "", "start at this API page token")
	cmd.Flags().BoolVar(&page.All, "all", false, "fetch all available pages")
	cmd.Flags().IntVar(&page.Limit, "limit", 0, "maximum items to emit (0 means no additional limit)")
}

func addAPIFlags(cmd *cobra.Command, api *ops.API) {
	cmd.Flags().StringVar(&api.Parts, "parts", "", "comma-separated API resource parts")
	cmd.Flags().StringVar(&api.Fields, "fields", "", "Google partial-response fields selector")
}

func addHLFlag(cmd *cobra.Command, hl *string) {
	cmd.Flags().StringVar(hl, "hl", "", "localization language code")
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

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
