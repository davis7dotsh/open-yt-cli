package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/output"
	"open-yt-cli/internal/update"
	"open-yt-cli/internal/version"
)

func (a *App) versionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Show version, commit, and build date",
		Args:  exactArgs(0),
		RunE: func(_ *cobra.Command, _ []string) error {
			info := version.Get()
			if a.outputFormat() != "table" {
				state := map[string]any{
					"version":   info.Version,
					"commit":    info.Commit,
					"date":      info.Date,
					"goVersion": info.GoVersion,
					"os":        info.OS,
					"arch":      info.Arch,
				}
				columns := a.columns
				if len(columns) == 0 {
					columns = []string{"version", "commit", "date", "goVersion", "os", "arch"}
				}
				return output.RenderObject(a.Out, state, a.outputFormat(), columns, a.noHeader)
			}
			fmt.Fprintf(a.Out, "oytc %s\ncommit: %s\nbuilt: %s\ngo: %s (%s/%s)\n", info.Version, info.Commit, info.Date, info.GoVersion, info.OS, info.Arch)
			return nil
		},
	}
}

func (a *App) updateCommand() *cobra.Command {
	var check bool
	var targetVersion string
	cmd := &cobra.Command{
		Use:     "update",
		Aliases: []string{"upgrade"},
		Short:   "Self-update oytc from GitHub Releases (checksum-verified)",
		Long: "Downloads the matching release archive and checksums.txt from GitHub Releases,\n" +
			"verifies the archive's SHA-256, and atomically replaces the current executable.\n" +
			"The updater never reads or transmits the YouTube API key.\n\n" +
			"'oytc upgrade' is an alias, and the installer also provides oytc_update and\n" +
			"oytc_upgrade shims that run the same operation.",
		Args: exactArgs(0),
		RunE: func(cmd *cobra.Command, _ []string) error {
			updater := a.newUpdater()
			result, err := updater.Run(cmd.Context(), update.Options{TargetVersion: targetVersion, CheckOnly: check})
			if err != nil {
				return err
			}
			if a.outputFormat() != "table" {
				state := map[string]any{
					"currentVersion": result.CurrentVersion,
					"targetVersion":  result.TargetVersion,
					"updated":        result.Updated,
					"upToDate":       result.UpToDate,
					"asset":          result.AssetName,
					"executable":     result.ExecutablePath,
				}
				columns := a.columns
				if len(columns) == 0 {
					columns = []string{"currentVersion", "targetVersion", "updated", "upToDate", "asset", "executable"}
				}
				return output.RenderObject(a.Out, state, a.outputFormat(), columns, a.noHeader)
			}
			switch {
			case result.UpToDate:
				fmt.Fprintf(a.Out, "oytc %s is already the latest release.\n", result.CurrentVersion)
			case result.Updated:
				fmt.Fprintf(a.Out, "Updated %s -> %s (%s)\n", result.CurrentVersion, result.TargetVersion, result.ExecutablePath)
			default:
				fmt.Fprintf(a.Out, "Update available: %s (current: %s)\nRun 'oytc update' to install it.\n", result.TargetVersion, result.CurrentVersion)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "only report whether a newer release exists")
	cmd.Flags().StringVar(&targetVersion, "version", "", "install this exact release tag (e.g. v0.2.0) instead of the latest")
	return cmd
}

func (a *App) newUpdater() *update.Updater {
	updater := &update.Updater{CurrentVersion: version.Get().Version}
	if a.UpdaterFactory != nil {
		return a.UpdaterFactory(updater)
	}
	return updater
}
