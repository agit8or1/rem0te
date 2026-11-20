//go:build windows && labwindows

package main

// The Windows lab (0.72.0): Managed Secure Access enforcement against the
// RustDesk release the lab's RustDesk job installed, through the agent's own
// enforcement exec site (enforceRunner) and enforce.Enforcer — the code the
// msa-poller runs. One cycle, in order:
//
//   save every setting → apply a view-only grant (every setting set and read
//   back, then the one-time password, which must print "Done") → read back
//   again → end the session (a random password nobody is told, stop-service
//   Y, a pause, N, read back N) → restore the saved settings and read them
//   back.
//
// Twice: as the runner's elevated administrator (this process), and as
// SYSTEM in session 0 — this same test binary started by a scheduled task
// with -lab-enforce-out, writing its result to a file this process reads.
// What it does not cover: the portal, the long-poll, grant verification
// (internal/msa/enforce's unit tests) and a real remote connection.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/labevidence"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa/enforce"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa/grant"
)

var labEnforceOut = flag.String("lab-enforce-out", "", "lab only: run the enforcement cycle and write the result here")

type enforceCycle struct {
	OK    bool     `json:"ok"`
	Steps []string `json:"steps"`
	Err   string   `json:"err,omitempty"`
}

func runEnforceCycle(ctx context.Context) enforceCycle {
	var c enforceCycle
	step := func(f string, a ...any) { c.Steps = append(c.Steps, fmt.Sprintf(f, a...)) }
	fail := func(f string, a ...any) enforceCycle { c.Err = fmt.Sprintf(f, a...); return c }
	e := &enforce.Enforcer{R: enforceRunner{exe: installedRustdeskExe()}}

	saved, err := e.ReadAll(ctx)
	if err != nil {
		return fail("save: %v", err)
	}
	step("saved %d settings", len(saved))

	g := grant.Grant{V: 1, GrantID: "00112233445566778899aabbccddeeff", Mode: "view", Consent: "required",
		MaxMinutes: 30, IdleMinutes: 10, Password: enforce.RandomPassword()}
	if out := e.Apply(ctx, &g); !out.OK {
		_ = e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved})
		return fail("apply: %s %v", out.Code, out.Keys)
	}
	step("applied a view-only grant: %d settings read back, one-time password set (Done)", len(enforce.Keys))
	if bad := e.Check(ctx, enforce.Desired(&g)); len(bad) > 0 {
		return fail("second readback: %v", bad)
	}
	step("a second readback agreed")

	start := time.Now()
	if err := e.EndSession(ctx); err != nil {
		return fail("end session: %v", err)
	}
	step("ended the session in %s: random password, stop-service Y then N, read back N", time.Since(start).Round(time.Millisecond))

	if bad := e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved}); len(bad) > 0 {
		return fail("restore: %v", bad)
	}
	again, err := e.ReadAll(ctx)
	if err != nil {
		return fail("read after restore: %v", err)
	}
	for _, k := range enforce.Keys {
		if !enforce.Matches(k, again[k], saved[k]) {
			return fail("after restore %s reads %q, saved %q", k, again[k], saved[k])
		}
	}
	step("restored and read back every saved setting")
	c.OK = true
	return c
}

// TestLabRustdeskEnforceChild is the SYSTEM half: it runs only when the
// scheduled task passes -lab-enforce-out.
func TestLabRustdeskEnforceChild(t *testing.T) {
	if *labEnforceOut == "" {
		t.Skip("started by TestLabRustdeskEnforce/system only")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	b, _ := json.Marshal(runEnforceCycle(ctx))
	if err := os.WriteFile(*labEnforceOut+".new", b, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(*labEnforceOut+".new", *labEnforceOut); err != nil {
		t.Fatal(err)
	}
}

func TestLabRustdeskEnforce(t *testing.T) {
	labevidence.Require(t)
	want := os.Getenv("REM0TE_LAB_RUSTDESK")
	if want == "" {
		t.Skip("REM0TE_LAB_RUSTDESK is not set: no RustDesk installed by the lab here")
	}
	report := func(t *testing.T, n *labevidence.Note, c enforceCycle) {
		for _, s := range c.Steps {
			n.Logf("%s", s)
		}
		if !c.OK {
			t.Errorf("enforcement cycle failed: %s", c.Err)
		}
	}

	t.Run("admin", func(t *testing.T) {
		n := labevidence.Track(t, "agent/msa-enforce/"+want+"/admin")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		report(t, n, runEnforceCycle(ctx))
	})

	t.Run("system", func(t *testing.T) {
		n := labevidence.Track(t, "agent/msa-enforce/"+want+"/system")
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(os.Getenv("ProgramData"), "Rem0te", "lab-msa-enforce.json")
		_ = os.MkdirAll(filepath.Dir(out), 0o755)
		_ = os.Remove(out)
		schtasks := filepath.Join(os.Getenv("SystemRoot"), "System32", "schtasks.exe")
		task := "LabRem0teMsaEnforce"
		run := func(args ...string) {
			o, err := exec.Command(schtasks, args...).CombinedOutput()
			if err != nil {
				t.Fatalf("schtasks %v: %v %s", args, err, o)
			}
		}
		_ = exec.Command(schtasks, "/Delete", "/TN", task, "/F").Run()
		tr := fmt.Sprintf(`"%s" -test.run ^TestLabRustdeskEnforceChild$ -lab-enforce-out "%s"`, self, out)
		run("/Create", "/TN", task, "/TR", tr, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F")
		defer run("/Delete", "/TN", task, "/F")
		run("/Run", "/TN", task)
		deadline := time.Now().Add(6 * time.Minute)
		var raw []byte
		for time.Now().Before(deadline) {
			if b, err := os.ReadFile(out); err == nil {
				raw = b
				break
			}
			time.Sleep(2 * time.Second)
		}
		if raw == nil {
			t.Fatalf("no %s within 6 minutes", out)
		}
		var c enforceCycle
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("result: %v", err)
		}
		n.Logf("as SYSTEM (scheduled task, session 0), the agent's enforcement code through enforceRunner")
		report(t, n, c)
	})
}
