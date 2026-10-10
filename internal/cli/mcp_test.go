package cli

import (
	"strings"
	"testing"
)

func TestMCPCommandHelp(t *testing.T) {
	app, out, _ := testApp(nil)
	if err := execute(t, app, "mcp", "--help"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "claude mcp add oytc -- oytc mcp") {
		t.Fatalf("help = %s", out.String())
	}
}
