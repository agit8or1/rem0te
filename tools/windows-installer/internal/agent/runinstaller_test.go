//go:build !windows

package agent

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// A descendant that outlives the installer and inherits its output pipe must
// not hold the agent: this is what hung the 0.37 migration on real Windows.
func TestRunInstallerCmdDoesNotWaitForDescendants(t *testing.T) {
	var log bytes.Buffer
	cmd := exec.Command("sh", "-c", "echo installed; sleep 120 & exit 0")
	cmd.Stdout = io.MultiWriter(&log, io.Discard)
	cmd.Stderr = cmd.Stdout
	start := time.Now()
	code, err := RunInstallerCmd(cmd)
	took := time.Since(start)
	if err != nil || code != 0 {
		t.Fatalf("want exit 0 and no error, got %d %v", code, err)
	}
	if took > InstallerWaitDelay+10*time.Second {
		t.Fatalf("waited %v for a descendant", took)
	}
	if !strings.Contains(log.String(), "installed") {
		t.Fatalf("installer output lost: %q", log.String())
	}
}

// The installer's own failure is still reported, with or without a lingering descendant.
func TestRunInstallerCmdKeepsExitCode(t *testing.T) {
	for _, script := range []string{"exit 7", "sleep 120 & exit 7"} {
		cmd := exec.Command("sh", "-c", script)
		cmd.Stdout = io.MultiWriter(io.Discard)
		code, err := RunInstallerCmd(cmd)
		if err != nil || code != 7 {
			t.Fatalf("%q: want exit 7, got %d %v", script, code, err)
		}
	}
}

func TestRunInstallerCmdMissingBinary(t *testing.T) {
	cmd := exec.Command("/nonexistent/powershell")
	cmd.Stdout = os.Stdout
	if code, err := RunInstallerCmd(cmd); code != 1 || err == nil {
		t.Fatalf("want 1 and an error, got %d %v", code, err)
	}
}
