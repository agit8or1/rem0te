//go:build windows && labwindows

package main

// The Windows lab (0.69.0): the agent's read-only RustDesk preflight against
// the RustDesk release the lab's RustDesk job installed. Runs in that job,
// after rustdesk-lab.ps1, only when REM0TE_LAB=1 and REM0TE_LAB_RUSTDESK names
// the installed release. Twice: in this test process (the runner's elevated
// administrator), and as SYSTEM in session 0 — the real rem0te-agent.exe
// (REM0TE_LAB_AGENT_EXE) run by a scheduled task, exactly as the heartbeat
// starts it on a computer, writing C:\ProgramData\Rem0te\msa\preflight.json.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/labevidence"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa"
)

func checkPreflight(t *testing.T, n *labevidence.Note, rep msa.Report, want string) {
	t.Helper()
	b, _ := json.Marshal(rep)
	n.Logf("report %s (%d bytes)", b, len(b))
	if len(b) > 4096 {
		t.Errorf("report is %d bytes, over 4 KB", len(b))
	}
	if rep.Schema != msa.Schema {
		t.Errorf("schema %q", rep.Schema)
	}
	if !rep.Installed || !rep.ExpectedPath {
		t.Errorf("installed %v, expected path %v", rep.Installed, rep.ExpectedPath)
	}
	if rep.Service != "running" {
		t.Errorf("service %s", rep.Service)
	}
	if rep.Build != "flutter" {
		t.Errorf("build %s (heuristic: flutter_windows.dll beside rustdesk.exe)", rep.Build)
	}
	if rep.Version == nil || !(*rep.Version == want || strings.HasPrefix(*rep.Version, want+"+") || strings.HasPrefix(*rep.Version, want+".")) {
		t.Errorf("version %v, want %s", rep.Version, want)
	}
	if rep.CLI != msa.CLIOK || len(rep.Keys) != len(msa.Keys) {
		t.Errorf("cli %s, %d keys", rep.CLI, len(rep.Keys))
	}
	for _, k := range msa.Keys {
		if rep.Keys[k] != msa.KeyOK {
			t.Errorf("key %s: %s", k, rep.Keys[k])
		}
	}
}

func TestLabRustdeskPreflight(t *testing.T) {
	labevidence.Require(t)
	want := os.Getenv("REM0TE_LAB_RUSTDESK")
	if want == "" {
		t.Skip("REM0TE_LAB_RUSTDESK is not set: no RustDesk installed by the lab here")
	}

	t.Run("admin", func(t *testing.T) {
		n := labevidence.Track(t, "agent/rustdesk-preflight/"+want+"/admin")
		start := time.Now()
		rep, fp := runPreflight(context.Background())
		n.Logf("as the runner's elevated administrator in %s; exe fingerprint version %q size %d", time.Since(start).Round(time.Millisecond), fp.Version, fp.Size)
		checkPreflight(t, n, rep, want)
	})

	t.Run("system", func(t *testing.T) {
		n := labevidence.Track(t, "agent/rustdesk-preflight/"+want+"/system")
		exe := os.Getenv("REM0TE_LAB_AGENT_EXE")
		if exe == "" {
			n.Skip("REM0TE_LAB_AGENT_EXE is not set")
		}
		out := preflightFile(defaultPaths())
		_ = os.Remove(out)
		_ = os.Remove(preflightStateFile(defaultPaths()))
		task := "LabRem0tePreflight"
		run := func(args ...string) {
			o, err := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "schtasks.exe"), args...).CombinedOutput()
			if err != nil {
				t.Fatalf("schtasks %v: %v %s", args, err, o)
			}
		}
		_ = exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "schtasks.exe"), "/Delete", "/TN", task, "/F").Run()
		// No --force: a first run has no state, so ShouldRun decides to run.
		run("/Create", "/TN", task, "/TR", `"`+exe+`" rustdesk-preflight`, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F")
		defer run("/Delete", "/TN", task, "/F")
		run("/Run", "/TN", task)
		deadline := time.Now().Add(4 * time.Minute)
		var raw []byte
		for time.Now().Before(deadline) {
			if b, err := os.ReadFile(out); err == nil {
				if _, serr := os.Stat(preflightStateFile(defaultPaths())); serr == nil {
					raw = b
					break
				}
			}
			time.Sleep(2 * time.Second)
		}
		if raw == nil {
			t.Fatalf("no %s within 4 minutes", out)
		}
		var rep msa.Report
		if err := json.Unmarshal(raw, &rep); err != nil {
			t.Fatalf("preflight.json: %v", err)
		}
		n.Logf("as SYSTEM (scheduled task, session 0), rem0te-agent.exe rustdesk-preflight wrote %s", out)
		checkPreflight(t, n, rep, want)

		// The rate limit: started again at once, it must not run again.
		before, _ := os.Stat(out)
		run("/Run", "/TN", task)
		time.Sleep(15 * time.Second)
		after, _ := os.Stat(out)
		if before == nil || after == nil || !after.ModTime().Equal(before.ModTime()) {
			t.Errorf("a second start within 6 h rewrote preflight.json")
		} else {
			n.Logf("a second start within 6 h left preflight.json alone (rate limit held)")
		}
	})
}
