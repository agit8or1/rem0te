package action

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// windows.script.run@1 (v0.34). The fake host checks what the agent wrote
// before it runs anything; the pwsh tests at the bottom run a real
// PowerShell 7 (PWSH, or pwsh on PATH) and are skipped without one. None of
// this is Windows PowerShell 5.1 on Windows.

const testScript = "param([string]$Name, [int]$Count = 1, [bool]$Loud = $false)\n\"hello $Name x$Count loud=$Loud\"\n"

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func i64(n int64) *int64 { return &n }

func scriptBlock(content []byte) map[string]any {
	return map[string]any{
		"allowlistId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "scriptId": "script-0001", "versionId": "version-0001", "name": "Greet", "version": 2,
		"businessId": "biz-aaaaaaa", "language": "powershell", "targetOs": "windows", "risk": "low",
		"parameters": []any{
			map[string]any{"name": "Name", "type": "string", "required": true, "charset": "safe_text", "maxLength": 32},
			map[string]any{"name": "Count", "type": "integer", "required": false, "min": 1, "max": 10},
			map[string]any{"name": "Loud", "type": "boolean", "required": false},
		},
		"contentSha256": sum(content), "contentBytes": len(content), "definitionSha256": strings.Repeat("d", 64),
		"contributors": []any{"user-author1"}, "reviewedBy": "user-reviewer",
	}
}

func scriptPlan(content []byte, args map[string]any, timeout int) map[string]any {
	p := highPlan("windows.script.run", map[string]any{"scriptVersionId": "version-0001", "sha256": sum(content), "parameters": args, "timeoutMinutes": timeout})
	p["script"] = scriptBlock(content)
	return p
}

type fakeHost struct {
	t       *testing.T
	f       *fixture
	calls   int
	run     ScriptRun
	sawFile map[string]string
	timeout time.Duration
}

func (h *fakeHost) RunPowerShell(dir, wrapper string, timeout time.Duration, max int) ScriptRun {
	h.calls++
	h.timeout = timeout
	h.sawFile = map[string]string{}
	for _, n := range []string{"script.ps1", "params.json", "run.ps1"} {
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			h.t.Fatalf("%s not written: %v", n, err)
		}
		h.sawFile[n] = string(b)
	}
	if wrapper != filepath.Join(dir, "run.ps1") || max != MaxScriptOutput {
		h.t.Fatalf("wrapper %s max %d", wrapper, max)
	}
	// The job is consumed before anything runs.
	if j, ok := readJournal(h.f.opts(), job); !ok || j.State != "executing" {
		h.t.Fatalf("journal before the run: %+v", j)
	}
	return h.run
}

func (f *fixture) runScript(plan map[string]any, content []byte, h ScriptHost) Result {
	o := f.opts()
	o.ScriptContent, o.Scripts = content, h
	r, err := Run(job, f.envelope(plan, nil), o)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func decode(t *testing.T, s string) string {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("not base64: %v", err)
	}
	return string(b)
}

func TestScriptRunWritesFilesRunsAndCleansUp(t *testing.T) {
	f := newFixture(t)
	content := []byte(testScript)
	h := &fakeHost{t: t, f: f, run: ScriptRun{ExitCode: 0, Stdout: []byte("hello web x5 loud=True\npassword=hunter2 C:\\Users\\alice\\x.txt\n"), StdoutTotal: 60, Duration: 1500 * time.Millisecond}}
	r := f.runScript(scriptPlan(content, map[string]any{"Name": "web", "Count": float64(5), "Loud": true}, 5), content, h)
	expect(t, r, "succeeded", "")
	if h.calls != 1 || h.sawFile["script.ps1"] != "\ufeff"+testScript || h.sawFile["run.ps1"] != scriptWrapper || h.timeout != 5*time.Minute {
		t.Fatalf("host saw %+v timeout %v", h.sawFile, h.timeout)
	}
	var pj map[string]any
	if err := json.Unmarshal([]byte(h.sawFile["params.json"]), &pj); err != nil || pj["Name"] != "web" || pj["Count"] != float64(5) || pj["Loud"] != true || len(pj) != 3 {
		t.Fatalf("params.json %s", h.sawFile["params.json"])
	}
	out := decode(t, r.Script.Stdout)
	if !strings.Contains(out, "hello web x5") || strings.Contains(out, "hunter2") || strings.Contains(out, "alice") || !strings.Contains(out, "password=[redacted]") {
		t.Fatalf("stdout not redacted: %q", out)
	}
	if *r.Script.ExitCode != 0 || r.Script.DurationMs != 1500 || r.Script.Cleanup != "removed" || r.Script.ContentSHA256 != sum(content) {
		t.Fatalf("script result %+v", r.Script)
	}
	if left, _ := os.ReadDir(filepath.Join(f.dir, "actions", "run")); len(left) != 0 {
		t.Fatalf("run directory left behind: %v", left)
	}
	// At most once: a re-delivery is answered from the journal.
	again := f.runScript(scriptPlan(content, map[string]any{"Name": "web", "Count": float64(5), "Loud": true}, 5), content, h)
	if h.calls != 1 || again.Outcome != "succeeded" {
		t.Fatalf("ran twice (%d) or answered %s", h.calls, again.Outcome)
	}
}

func TestScriptExitCodeAndTimeout(t *testing.T) {
	content := []byte(testScript)
	f := newFixture(t)
	r := f.runScript(scriptPlan(content, map[string]any{"Name": "web"}, 1), content, &fakeHost{t: t, f: f, run: ScriptRun{ExitCode: 3}})
	expect(t, r, "failed", "exit_code")
	if *r.Script.ExitCode != 3 {
		t.Fatalf("exit %v", r.Script.ExitCode)
	}
	f = newFixture(t)
	r = f.runScript(scriptPlan(content, map[string]any{"Name": "web"}, 1), content, &fakeHost{t: t, f: f, run: ScriptRun{TimedOut: true, ExitCode: -1}})
	expect(t, r, "timed_out", "timed_out")
	if r.Script.ExitCode != nil || !r.Script.TimedOut {
		t.Fatalf("a timed-out run has no exit code: %+v", r.Script)
	}
}

func TestScriptOutputIsCapped(t *testing.T) {
	f := newFixture(t)
	content := []byte(testScript)
	big := []byte(strings.Repeat("é", MaxScriptOutput)) // two bytes each: the cap falls inside the stream
	r := f.runScript(scriptPlan(content, map[string]any{"Name": "web"}, 1), content, &fakeHost{t: t, f: f, run: ScriptRun{Stdout: big[:MaxScriptOutput], StdoutTotal: int64(len(big)), Stderr: []byte("oops"), StderrTotal: 4}})
	out := decode(t, r.Script.Stdout)
	if len(out) > MaxScriptOutput || !strings.HasPrefix(out, "éé") || !r.Script.StdoutTruncated || r.Script.StdoutBytes != int64(len(big)) || r.Script.StderrTruncated || decode(t, r.Script.Stderr) != "oops" {
		t.Fatalf("cap: %d bytes, truncated %v, total %d", len(out), r.Script.StdoutTruncated, r.Script.StdoutBytes)
	}
	if !strings.HasSuffix(out, "é") {
		t.Fatal("the cap split a character")
	}
}

func TestScriptRefusals(t *testing.T) {
	content := []byte(testScript)
	ok := map[string]any{"Name": "web"}
	cases := []struct {
		name    string
		plan    func() map[string]any
		content []byte
		reason  string
	}{
		{"delivered bytes differ from the signed hash", func() map[string]any { return scriptPlan(content, ok, 1) }, []byte(strings.Replace(testScript, "hello", "HELLO", 1)), "content_mismatch"},
		{"no content delivered", func() map[string]any { return scriptPlan(content, ok, 1) }, nil, "no_content"},
		{"the author approved the run", func() map[string]any {
			p := scriptPlan(content, ok, 1)
			p["approvers"].([]any)[0].(map[string]any)["userId"] = "user-author1"
			return p
		}, content, "contributor_approved"},
		{"an argument smuggling a command", func() map[string]any {
			return scriptPlan(content, map[string]any{"Name": "web; Remove-Item C:\\ -Recurse"}, 1)
		}, content, "arguments_not_allowed"},
		{"an argument with $()", func() map[string]any { return scriptPlan(content, map[string]any{"Name": "$(whoami)"}, 1) }, content, "arguments_not_allowed"},
		{"an undeclared argument", func() map[string]any {
			return scriptPlan(content, map[string]any{"Name": "web", "Command": "whoami"}, 1)
		}, content, "arguments_not_allowed"},
		{"a string where an integer is declared", func() map[string]any { return scriptPlan(content, map[string]any{"Name": "web", "Count": "5"}, 1) }, content, "arguments_not_allowed"},
		{"an integer out of range", func() map[string]any {
			return scriptPlan(content, map[string]any{"Name": "web", "Count": float64(11)}, 1)
		}, content, "arguments_not_allowed"},
		{"a required argument missing", func() map[string]any { return scriptPlan(content, map[string]any{}, 1) }, content, "arguments_not_allowed"},
		{"a block naming another version", func() map[string]any {
			p := scriptPlan(content, ok, 1)
			p["script"].(map[string]any)["versionId"] = "version-0002"
			return p
		}, content, "script_mismatch"},
		{"no script block", func() map[string]any { p := scriptPlan(content, ok, 1); delete(p, "script"); return p }, content, "script_missing"},
		{"a timeout not on the list", func() map[string]any { return scriptPlan(content, ok, 7) }, content, "params_not_allowed"},
		{"an extra parameter", func() map[string]any {
			p := scriptPlan(content, ok, 1)
			p["params"].(map[string]any)["commandLine"] = "-EncodedCommand AAA"
			return p
		}, content, "params_not_allowed"},
		{"one approver", func() map[string]any {
			p := scriptPlan(content, ok, 1)
			p["approvers"] = p["approvers"].([]any)[:1]
			return p
		}, content, "too_few_approvals"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			h := &fakeHost{t: t, f: f}
			r := f.runScript(c.plan(), c.content, h)
			expect(t, r, "refused", c.reason)
			if h.calls != 0 {
				t.Fatal("ran despite the refusal")
			}
			if j, _ := readJournal(f.opts(), job); j.State != "done" {
				t.Fatalf("a refusal is final: journal %+v", j)
			}
		})
	}
}

func TestScriptPausedAndNoHost(t *testing.T) {
	content := []byte(testScript)
	f := newFixture(t)
	o := f.opts()
	o.ScriptContent = content
	h := &fakeHost{t: t, f: f}
	o.Scripts = h
	o.Pause = &Pause{Schema: PauseSchema, IssuedAt: now.Format(time.RFC3339), Reason: "incident", Actions: PauseScope{Businesses: []string{"biz-aaaaaaa"}}}
	r, _ := Run(job, f.envelope(scriptPlan(content, map[string]any{"Name": "web"}, 1), nil), o)
	expect(t, r, "refused", "paused")
	if h.calls != 0 {
		t.Fatal("ran while paused")
	}
	f = newFixture(t)
	r = f.runScript(scriptPlan(content, map[string]any{"Name": "web"}, 1), content, nil)
	expect(t, r, "failed", "no_script_host")
}

func TestScriptInterruptedIsNotRerun(t *testing.T) {
	f := newFixture(t)
	content := []byte(testScript)
	_ = os.MkdirAll(filepath.Join(f.dir, "actions", "journal"), 0o700)
	if err := writeJournal(f.opts(), journal{JobID: job, State: "executing", ActionID: "windows.script.run", ActionVersion: 1}); err != nil {
		t.Fatal(err)
	}
	h := &fakeHost{t: t, f: f}
	r := f.runScript(scriptPlan(content, map[string]any{"Name": "web"}, 1), content, h)
	expect(t, r, "uncertain", "interrupted")
	if h.calls != 0 || !strings.Contains(r.Observed["script"], "may have run in part") {
		t.Fatalf("re-ran or said %+v", r.Observed)
	}
}

func TestArgumentsMirrorThePortal(t *testing.T) {
	ds := []ParamDecl{
		{Name: "Host", Type: "string", Required: true, Charset: "hostname", MaxLength: 10},
		{Name: "N", Type: "integer", Min: i64(-5), Max: i64(5)},
		{Name: "Mode", Type: "choice", Choices: []string{"fast", "slow"}},
		{Name: "On", Type: "boolean"},
	}
	good := []map[string]any{{"Host": "a.b-c"}, {"Host": "x", "N": float64(-5), "Mode": "slow", "On": false}}
	bad := []map[string]any{{}, {"Host": ""}, {"Host": "a b"}, {"Host": "a_b"}, {"Host": "abcdefghijk"}, {"Host": "x", "N": 1.5}, {"Host": "x", "N": float64(6)},
		{"Host": "x", "Mode": "FAST"}, {"Host": "x", "On": "true"}, {"Host": "x", "host": "y"}, {"Host": "x", "Extra": "y"}}
	for _, a := range good {
		if why := argumentsProblem(ds, a); why != "" {
			t.Fatalf("refused %v: %s", a, why)
		}
	}
	for _, a := range bad {
		if argumentsProblem(ds, a) == "" {
			t.Fatalf("accepted %v", a)
		}
	}
	if declsProblem([]ParamDecl{{Name: "a", Type: "string", Charset: "regex", MaxLength: 5}}) == "" || declsProblem([]ParamDecl{{Name: "A", Type: "boolean"}, {Name: "a", Type: "boolean"}}) == "" {
		t.Fatal("accepted a bad declaration")
	}
}

// ── Real PowerShell (PowerShell 7; not Windows PowerShell 5.1) ─────────────

func pwshPath(t *testing.T) string {
	if p := os.Getenv("PWSH"); p != "" {
		return p
	}
	p, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("no pwsh: set PWSH to run the real-PowerShell script tests")
	}
	return p
}

func TestPwshRunsWithArgumentsAsData(t *testing.T) {
	ps := pwshPath(t)
	f := newFixture(t)
	content := []byte(testScript + "exit 4\n")
	// "x -Count 99" would set Count if it were ever pasted into a command line.
	r := f.runScript(scriptPlan(content, map[string]any{"Name": "x -Count 99", "Count": float64(5), "Loud": true}, 1), content, ExecHost{PowerShell: ps})
	out := decode(t, r.Script.Stdout)
	if !strings.Contains(out, "hello x -Count 99 x5 loud=True") || r.Outcome != "failed" || r.Reason != "exit_code" || *r.Script.ExitCode != 4 || r.Script.Cleanup != "removed" {
		t.Fatalf("got %s/%s %q stderr %q", r.Outcome, r.Reason, out, decode(t, r.Script.Stderr))
	}
}

// The wrapper binds params.json as values even if the validation upstream
// were bypassed: a value that is PowerShell is printed, never run.
func TestPwshWrapperNeverEvaluatesArguments(t *testing.T) {
	ps := pwshPath(t)
	dir := t.TempDir()
	marker := filepath.Join(dir, "pwned")
	hostile := `$(New-Item -ItemType File -Path '` + marker + `'); "; New-Item -Path '` + marker + `' #`
	pj, _ := json.Marshal(map[string]any{"Name": hostile})
	_ = os.WriteFile(filepath.Join(dir, "params.json"), pj, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "script.ps1"), []byte("param([string]$Name)\nWrite-Output \"name=[$Name]\"\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "run.ps1"), []byte(scriptWrapper), 0o600)
	run := ExecHost{PowerShell: ps}.RunPowerShell(dir, filepath.Join(dir, "run.ps1"), 30*time.Second, MaxScriptOutput)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("an argument was evaluated as PowerShell")
	}
	if !strings.Contains(string(run.Stdout), "name=["+hostile+"]") || run.ExitCode != 0 {
		t.Fatalf("stdout %q stderr %q exit %d", run.Stdout, run.Stderr, run.ExitCode)
	}
}

func TestPwshTimeoutKillsTheTree(t *testing.T) {
	ps := pwshPath(t)
	f := newFixture(t)
	marker := filepath.Join(t.TempDir(), "child-survived")
	// A child that would write the marker after 3 s, and a parent that never ends.
	content := []byte("Start-Process -FilePath /bin/sh -ArgumentList @('-c', 'sleep 3; touch " + marker + "')\n\"started\"\nStart-Sleep -Seconds 600\n")
	o := f.opts()
	o.ScriptContent, o.Scripts, o.ScriptMinute = content, ExecHost{PowerShell: ps}, 2*time.Second
	plan := scriptPlan(content, map[string]any{"Name": "web"}, 1)
	plan["script"].(map[string]any)["parameters"] = []any{map[string]any{"name": "Name", "type": "string", "required": true, "charset": "safe_text", "maxLength": 32}}
	startAt := time.Now()
	r, _ := Run(job, f.envelope(plan, nil), o)
	if r.Outcome != "timed_out" || !r.Script.TimedOut || time.Since(startAt) > 20*time.Second {
		t.Fatalf("got %s after %v: %+v", r.Outcome, time.Since(startAt), r.Script)
	}
	time.Sleep(4 * time.Second)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a process the script started outlived the timeout")
	}
}

func TestPwshOutputCap(t *testing.T) {
	ps := pwshPath(t)
	f := newFixture(t)
	// Words, not one long run: a run of 40+ token characters is itself redacted.
	content := []byte("[Console]::Out.Write('ab ' * 70000)\n[Console]::Error.Write('token=' + ('A' * 50))\n")
	plan := scriptPlan(content, map[string]any{"Name": "web"}, 1)
	r := f.runScript(plan, content, ExecHost{PowerShell: ps})
	out, errs := decode(t, r.Script.Stdout), decode(t, r.Script.Stderr)
	if len(out) != MaxScriptOutput || !r.Script.StdoutTruncated || r.Script.StdoutBytes < 210000 || strings.Contains(errs, "AAAAAAAAAA") || !strings.Contains(errs, "token=[redacted]") {
		t.Fatalf("stdout %d bytes (truncated %v, total %d), stderr %q", len(out), r.Script.StdoutTruncated, r.Script.StdoutBytes, errs)
	}
}
