package cli

import (
	"context"
	"errors"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"

	"open-yt-cli/internal/mcptools"
	"open-yt-cli/internal/version"
	"open-yt-cli/internal/youtube"
)

func (a *App) mcpCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "mcp",
		Short: "Serve the read-only tools over MCP stdio",
		Long: "Serve oytc's read commands as MCP tools over stdio, using the same credentials as the CLI:\n\n" +
			"  claude mcp add oytc -- oytc mcp",
		Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			resolver := mcptools.Resolver{Data: a.mcpDataClient, Analytics: a.analyticsClient}
			server := mcptools.NewServer(resolver, mcptools.Options{Version: version.Get().Version})
			err := server.Run(cmd.Context(), &mcp.StdioTransport{})
			if errors.Is(err, context.Canceled) {
				// Interrupt and SIGTERM are how clients stop the server.
				return nil
			}
			return err
		},
	}
}

// mcpDataClient falls back to a keyless client so video_trainability works
// without credentials; every other tool still gets ErrMissingKey from it.
func (a *App) mcpDataClient(ctx context.Context) (*youtube.Client, error) {
	client, err := a.dataClient(ctx)
	if errors.Is(err, youtube.ErrMissingKey) {
		return a.publicClient(ctx)
	}
	return client, err
}
