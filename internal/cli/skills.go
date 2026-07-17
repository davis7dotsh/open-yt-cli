package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"open-yt-cli/internal/skill"
)

func (a *App) skillsCommand() *cobra.Command {
	command := &cobra.Command{
		Use:     "skills",
		Aliases: []string{"skill"},
		Short:   "Install the bundled oytc agent skill",
	}
	command.AddCommand(a.skillsInstallCommand())
	return command
}

func (a *App) skillsInstallCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "install",
		Short: "Install or update the skill in ~/.agents/skills/oytc",
		Args:  exactArgs(0),
		RunE: func(_ *cobra.Command, _ []string) error {
			target := a.SkillInstallPath
			if target == "" {
				var err error
				target, err = skill.DefaultPath()
				if err != nil {
					return err
				}
			}

			action := "create"
			if _, err := os.Lstat(target); err == nil {
				action = "replace"
			} else if !os.IsNotExist(err) {
				return fmt.Errorf("inspect skill destination: %w", err)
			}
			fmt.Fprintf(a.Err, "Install the bundled oytc agent skill?\nDestination: %s\nPermission requested: %s this directory and write SKILL.md plus references.\nContinue? [y/N] ", target, action)
			answer, err := bufio.NewReader(a.In).ReadString('\n')
			if err != nil && len(answer) == 0 {
				return fmt.Errorf("read confirmation: %w", err)
			}
			fmt.Fprintln(a.Err)
			switch strings.ToLower(strings.TrimSpace(answer)) {
			case "y", "yes":
			default:
				fmt.Fprintln(a.Out, "Skill installation cancelled; no files were changed.")
				return nil
			}

			if err := skill.Install(target); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "Installed oytc agent skill to %s\n", target)
			return nil
		},
	}
}
