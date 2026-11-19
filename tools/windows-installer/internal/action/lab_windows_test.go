//go:build windows && labwindows

package action

// The Windows lab (0.68.3): windows.script.run@1 under Windows PowerShell 5.1
// — System32's powershell.exe, the one the agent runs, not PowerShell 7 —
// with the real job object (scriptexec_windows.go). Built only with
// `-tags labwindows`, and skipped unless REM0TE_LAB=1.
//
// The plans are the package's ordinary test plans (fixture, scriptPlan), so
// the approval key and identity are the fixture's stand-ins; PowerShell, the
// job object, the wrapper and the files it reads are real.
//
// TestPwshTimeoutKillsTheTree in script_test.go skips on Windows because its
// child is /bin/sh. TestLabPS51TimeoutKillsTheTree below is its Windows
// counterpart: the child is another powershell.exe, so what ends it is the
// job object's KILL_ON_JOB_CLOSE / TerminateJobObject.

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/labevidence"
)

func ps51(t *testing.T, n *labevidence.Note) string {
	t.Helper()
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(sys, "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(p); err != nil {
		n.Skip("no Windows PowerShell 5.1 at " + p)
	}
	return p
}

func TestLabPS51RunsWithArgumentsAsData(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/script-run/ps51-arguments-as-data")
	ps := ps51(t, n)
	f := newFixture(t)
	content := []byte(testScript + "\"ps=$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor) edition=$($PSVersionTable.PSEdition)\"\nexit 4\n")
	r := f.runScript(scriptPlan(content, map[string]any{"Name": "x -Count 99", "Count": float64(5), "Loud": true}, 1), content, ExecHost{PowerShell: ps})
	out := decode(t, r.Script.Stdout)
	n.Logf("outcome %s/%s exit %d cleanup %s stdout %q stderr %q", r.Outcome, r.Reason, *r.Script.ExitCode, r.Script.Cleanup, strings.TrimSpace(out), strings.TrimSpace(decode(t, r.Script.Stderr)))
	if !strings.Contains(out, "ps=5.1 edition=Desktop") {
		t.Fatalf("not Windows PowerShell 5.1: %q", out)
	}
	if !strings.Contains(out, "hello x -Count 99 x5 loud=True") || r.Outcome != "failed" || r.Reason != "exit_code" || *r.Script.ExitCode != 4 || r.Script.Cleanup != "removed" {
		t.Fatalf("got %s/%s %q", r.Outcome, r.Reason, out)
	}
}

func TestLabPS51WrapperNeverEvaluatesArguments(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/script-run/ps51-wrapper-never-evaluates")
	ps := ps51(t, n)
	dir := t.TempDir()
	marker := filepath.Join(dir, "pwned")
	hostile := `$(New-Item -ItemType File -Path '` + marker + `'); "; New-Item -Path '` + marker + `' #`
	pj := fmt.Sprintf(`{"Name":%q}`, hostile)
	_ = os.WriteFile(filepath.Join(dir, "params.json"), []byte(pj), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "script.ps1"), []byte("\ufeffparam([string]$Name)\nWrite-Output \"name=[$Name]\"\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "run.ps1"), []byte(scriptWrapper), 0o600)
	run := ExecHost{PowerShell: ps}.RunPowerShell(dir, filepath.Join(dir, "run.ps1"), 60*time.Second, MaxScriptOutput)
	_, statErr := os.Stat(marker)
	n.Logf("exit %d, marker created %v, stdout %q, stderr %q", run.ExitCode, statErr == nil, strings.TrimSpace(string(run.Stdout)), strings.TrimSpace(string(run.Stderr)))
	if statErr == nil {
		t.Fatal("an argument was evaluated as PowerShell")
	}
	if !strings.Contains(string(run.Stdout), "name=["+hostile+"]") || run.ExitCode != 0 {
		t.Fatal("the value did not arrive as data")
	}
}

func processAlive(pid uint32) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == uint32(windows.WAIT_TIMEOUT)
}

func TestLabPS51TimeoutKillsTheTree(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/script-run/ps51-timeout-kills-the-tree")
	ps := ps51(t, n)
	f := newFixture(t)
	side := t.TempDir()
	marker := filepath.Join(side, "child-survived")
	pidFile := filepath.Join(side, "child.pid")
	// The script starts a second powershell.exe that would write the marker
	// after 15 s, records the child's PID, then never ends. The plan's
	// timeout is one "minute" of 8 s here: long enough for both PowerShells
	// to start, far shorter than the child's sleep.
	content := []byte("$c = Start-Process -FilePath '" + ps + "' -ArgumentList @('-NoProfile','-NonInteractive','-Command',\"Start-Sleep -Seconds 15; New-Item -ItemType File -Path '" + marker + "'\") -WindowStyle Hidden -PassThru\n" +
		"Set-Content -LiteralPath '" + pidFile + "' -Value $c.Id\n\"started $($c.Id)\"\nStart-Sleep -Seconds 600\n")
	o := f.opts()
	o.ScriptContent, o.Scripts, o.ScriptMinute = content, ExecHost{PowerShell: ps}, 8*time.Second
	plan := scriptPlan(content, map[string]any{"Name": "web"}, 1)
	plan["script"].(map[string]any)["parameters"] = []any{map[string]any{"name": "Name", "type": "string", "required": true, "charset": "safe_text", "maxLength": 32}}
	startAt := time.Now()
	r, err := Run(job, f.envelope(plan, nil), o)
	if err != nil {
		t.Fatal(err)
	}
	took := time.Since(startAt)
	raw, perr := os.ReadFile(pidFile)
	pid, _ := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(string(raw), "\ufeff")))
	n.Logf("outcome %s after %s, timedOut %v, child pid %d (pid file read: %v)", r.Outcome, took.Round(time.Millisecond), r.Script != nil && r.Script.TimedOut, pid, perr)
	if r.Outcome != "timed_out" || r.Script == nil || !r.Script.TimedOut || took > 60*time.Second {
		t.Fatalf("got %s after %v", r.Outcome, took)
	}
	if perr != nil || pid <= 0 {
		t.Fatal("the script never started its child, so the tree kill was not tested")
	}
	childAlive := processAlive(uint32(pid))
	n.Logf("child alive right after the timeout: %v", childAlive)
	if childAlive {
		t.Fatal("the child powershell.exe outlived the timeout")
	}
	time.Sleep(17 * time.Second)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the child wrote its marker: it outlived the timeout")
	}
	n.Logf("no marker 17 s later")
}

func TestLabPS51MemoryLimit(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/script-run/ps51-job-memory-limit")
	ps := ps51(t, n)
	f := newFixture(t)
	// A 700 MB array under a 300 MB job limit: Windows refuses the commit and
	// PowerShell reports OutOfMemory; "allocated" is never printed.
	content := []byte("$b = New-Object byte[] (700MB)\n$b[0] = 1\n\"allocated\"\n")
	plan := scriptPlan(content, map[string]any{"Name": "web"}, 1)
	r := f.runScript(plan, content, ExecHost{PowerShell: ps, MemoryLimit: 300 << 20})
	out, errs := decode(t, r.Script.Stdout), decode(t, r.Script.Stderr)
	n.Logf("outcome %s/%s, stdout %q, stderr (first 200) %q", r.Outcome, r.Reason, strings.TrimSpace(out), clipLab(strings.TrimSpace(errs), 200))
	if strings.Contains(out, "allocated") || r.Outcome == "succeeded" {
		t.Fatal("the allocation succeeded: the job memory limit did not apply")
	}
	// The control: the same script under a 2 GB limit allocates, so it was
	// the limit, not the runner, that refused it.
	g := newFixture(t)
	r2 := g.runScript(scriptPlan(content, map[string]any{"Name": "web"}, 1), content, ExecHost{PowerShell: ps, MemoryLimit: 2 << 30})
	out2 := decode(t, r2.Script.Stdout)
	n.Logf("control under 2 GB: outcome %s, stdout %q", r2.Outcome, strings.TrimSpace(out2))
	if !strings.Contains(out2, "allocated") || r2.Outcome != "succeeded" {
		t.Fatal("the control did not allocate either, so the limit is not what refused the first")
	}
}

func TestLabPS51OutputCap(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/script-run/ps51-output-cap")
	ps := ps51(t, n)
	f := newFixture(t)
	content := []byte("[Console]::Out.Write('ab ' * 70000)\n[Console]::Error.Write('token=' + ('A' * 50))\n")
	r := f.runScript(scriptPlan(content, map[string]any{"Name": "web"}, 1), content, ExecHost{PowerShell: ps})
	out, errs := decode(t, r.Script.Stdout), decode(t, r.Script.Stderr)
	n.Logf("stdout kept %d of %d bytes (truncated %v); stderr %q", len(out), r.Script.StdoutBytes, r.Script.StdoutTruncated, errs)
	if len(out) != MaxScriptOutput || !r.Script.StdoutTruncated || r.Script.StdoutBytes < 210000 || strings.Contains(errs, "AAAAAAAAAA") || !strings.Contains(errs, "token=[redacted]") {
		t.Fatal("output not capped or not redacted")
	}
}

func clipLab(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
