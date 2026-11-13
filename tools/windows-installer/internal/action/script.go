package action

// windows.script.run@1 (v0.34): run one approved script-library version.
//
// This is the one catalog action whose effect the catalog does not fix, so
// it is held to everything the others are and more. Before the job is
// journaled as executing (Run's Precheck slot, after the signature, the
// target, the window, the build, the approvals and the signed pause):
//
//   - the plan carries a signed script block (the approval signer's own
//     allowlist entry) whose content SHA-256 and version are the parameters';
//   - the content delivered beside the envelope hashes to exactly that
//     SHA-256 and has exactly that length;
//   - the arguments match the block's declared parameters — the same closed
//     rules as apps/api/src/actions/script-run.ts argumentsProblem;
//   - no approver is among the script's contributors (SAME_PERSON), unless
//     the signer signed the plan in direct mode (0.39), where there are no
//     approvers to compare.
//
// Then the agent writes the script, the arguments (as JSON data) and a fixed
// wrapper into a fresh directory, and runs
//
//	powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\run.ps1
//
// The command line is that constant list: no argument ever comes from the
// plan. The wrapper reads params.json and splats it into the script, so an
// argument is bound as a typed parameter value and is never parsed as code.
// The run is stopped at its timeout with everything it started (a job object
// on Windows, a process group elsewhere), each output stream is capped at
// MaxScriptOutput and redacted, and the directory is removed.
//
// None of this has run on a real Windows computer: it is tested against
// PowerShell 7 on Linux (script_test.go, cmd/rem0te-action-sim).

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// MaxScriptBytes: the most content a script may have (the library's limit).
	MaxScriptBytes = 64 << 10
	// MaxScriptOutput: the most of each of stdout and stderr kept, in bytes.
	MaxScriptOutput = 64 << 10
	// MaxScriptParams: the most arguments one run may pass.
	MaxScriptParams = 10
	// ScriptMemoryLimit: the job object's memory limit on Windows.
	ScriptMemoryLimit = 1 << 30
)

// ScriptTimeouts: the only timeouts a plan may name, minutes (TIMEOUT_MINUTES in the portal).
var ScriptTimeouts = []int{1, 5, 10, 15, 30}

// ParamDecl is one declared parameter, as the library stores it.
type ParamDecl struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Required    bool     `json:"required"`
	Charset     string   `json:"charset,omitempty"`
	MaxLength   int      `json:"maxLength,omitempty"`
	Min         *int64   `json:"min,omitempty"`
	Max         *int64   `json:"max,omitempty"`
	Choices     []string `json:"choices,omitempty"`
}

// ScriptDef is the plan's signed script block.
type ScriptDef struct {
	AllowlistID      string      `json:"allowlistId"`
	ScriptID         string      `json:"scriptId"`
	VersionID        string      `json:"versionId"`
	Name             string      `json:"name"`
	Version          int         `json:"version"`
	BusinessID       *string     `json:"businessId"`
	Language         string      `json:"language"`
	TargetOS         string      `json:"targetOs"`
	Risk             string      `json:"risk"`
	Parameters       []ParamDecl `json:"parameters"`
	ContentSHA256    string      `json:"contentSha256"`
	ContentBytes     int         `json:"contentBytes"`
	DefinitionSHA256 string      `json:"definitionSha256"`
	Contributors     []string    `json:"contributors"`
	ReviewedBy       string      `json:"reviewedBy"`
}

// ScriptResult is what a run reports. The streams are base64 of redacted,
// capped UTF-8, so no JSON writer on the way can inflate them.
type ScriptResult struct {
	ContentSHA256   string `json:"contentSha256"`
	ExitCode        *int64 `json:"exitCode"`
	TimedOut        bool   `json:"timedOut"`
	DurationMs      int64  `json:"durationMs"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutBytes     int64  `json:"stdoutBytes"`
	StderrBytes     int64  `json:"stderrBytes"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
	Cleanup         string `json:"cleanup,omitempty"`
}

// ScriptRun is what a ScriptHost observed.
type ScriptRun struct {
	ExitCode    int
	TimedOut    bool
	Stdout      []byte // at most the cap
	Stderr      []byte
	StdoutTotal int64 // everything written, kept or not
	StderrTotal int64
	Duration    time.Duration
	// Leftovers: processes the script left running, stopped after it exited.
	Leftovers bool
	// Err: PowerShell could not be started at all.
	Err error
}

// ScriptHost runs the wrapper. ExecHost (scriptexec.go) is the real one.
type ScriptHost interface {
	RunPowerShell(dir, wrapper string, timeout time.Duration, maxOutput int) ScriptRun
}

var (
	scriptCharsets = map[string]*regexp.Regexp{
		"alphanumeric": regexp.MustCompile(`^[A-Za-z0-9]*$`),
		"identifier":   regexp.MustCompile(`^[A-Za-z0-9_.-]*$`),
		"hostname":     regexp.MustCompile(`^[A-Za-z0-9.-]*$`),
		"safe_text":    regexp.MustCompile(`^[A-Za-z0-9 _.,:@-]*$`),
	}
	paramNameRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,31}$`)
	hex64RE     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	scriptIDRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
)

func intArg(v any, lo, hi float64) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && f == math.Trunc(f) && f >= lo && f <= hi
}

// scriptParamsOK: exactly the four closed parameters of ScriptRunParams.
func scriptParamsOK(p map[string]any) bool {
	if len(p) != 4 {
		return false
	}
	id, ok1 := p["scriptVersionId"].(string)
	sh, ok2 := p["sha256"].(string)
	t, ok3 := intArg(p["timeoutMinutes"], 1, 30)
	args, ok4 := p["parameters"].(map[string]any)
	if !ok1 || !ok2 || !ok3 || !ok4 || !scriptIDRE.MatchString(id) || !hex64RE.MatchString(sh) || len(args) > MaxScriptParams {
		return false
	}
	timeoutOK := false
	for _, m := range ScriptTimeouts {
		if int(t) == m {
			timeoutOK = true
		}
	}
	if !timeoutOK {
		return false
	}
	for k, v := range args {
		if !paramNameRE.MatchString(k) {
			return false
		}
		switch x := v.(type) {
		case string:
			if len(x) > 256 {
				return false
			}
		case bool:
		case float64:
			if _, ok := intArg(x, math.MinInt32, math.MaxInt32); !ok {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// declsProblem: the declarations themselves are well formed (they are signed,
// so this only catches a signer bug — but the agent decides what runs).
func declsProblem(ds []ParamDecl) string {
	if len(ds) > MaxScriptParams {
		return "too many declared parameters"
	}
	seen := map[string]bool{}
	for _, d := range ds {
		if !paramNameRE.MatchString(d.Name) || seen[strings.ToLower(d.Name)] {
			return "bad parameter name " + d.Name
		}
		seen[strings.ToLower(d.Name)] = true
		switch d.Type {
		case "string":
			if scriptCharsets[d.Charset] == nil || d.MaxLength < 1 || d.MaxLength > 256 {
				return d.Name + ": bad string declaration"
			}
		case "integer":
			if d.Min == nil || d.Max == nil || *d.Min > *d.Max || *d.Min < math.MinInt32 || *d.Max > math.MaxInt32 {
				return d.Name + ": bad integer declaration"
			}
		case "boolean":
		case "choice":
			if len(d.Choices) < 1 || len(d.Choices) > 20 {
				return d.Name + ": bad choice declaration"
			}
			cs := map[string]bool{}
			for _, c := range d.Choices {
				if c == "" || len(c) > 64 || !scriptCharsets["identifier"].MatchString(c) || cs[c] {
					return d.Name + ": bad choice"
				}
				cs[c] = true
			}
		default:
			return d.Name + ": unknown type " + d.Type
		}
	}
	return ""
}

// argumentsProblem: the same rules as the portal's and the signer's
// (script-run.ts argumentsProblem). Every key declared, every required one
// present, each value exactly its type: nothing is coerced.
func argumentsProblem(ds []ParamDecl, args map[string]any) string {
	if len(args) > MaxScriptParams {
		return "too many arguments"
	}
	by := map[string]ParamDecl{}
	for _, d := range ds {
		by[d.Name] = d
	}
	for k := range args {
		if _, ok := by[k]; !ok {
			return k + ": not a declared parameter"
		}
	}
	for _, d := range ds {
		v, present := args[d.Name]
		if !present {
			if d.Required {
				return d.Name + ": required"
			}
			continue
		}
		switch d.Type {
		case "string":
			s, ok := v.(string)
			if !ok {
				return d.Name + ": must be a string"
			}
			if len(s) < 1 || len(s) > d.MaxLength {
				return fmt.Sprintf("%s: 1 to %d characters", d.Name, d.MaxLength)
			}
			if !scriptCharsets[d.Charset].MatchString(s) {
				return d.Name + ": only " + d.Charset + " characters"
			}
		case "integer":
			if _, ok := intArg(v, float64(*d.Min), float64(*d.Max)); !ok {
				return fmt.Sprintf("%s: a whole number %d to %d", d.Name, *d.Min, *d.Max)
			}
		case "boolean":
			if _, ok := v.(bool); !ok {
				return d.Name + ": must be true or false"
			}
		case "choice":
			s, ok := v.(string)
			found := false
			for _, c := range d.Choices {
				if ok && s == c {
					found = true
				}
			}
			if !found {
				return d.Name + ": not one of the choices"
			}
		}
	}
	return ""
}

func scriptPrecheck(p *Plan, o Options) *Result {
	if o.Scripts == nil {
		return &Result{Outcome: "failed", Reason: "no_script_host", Detail: "this agent cannot run scripts"}
	}
	s := p.Script
	if s == nil {
		return refuse("script_missing", "the plan carries no script block")
	}
	if p.Params["sha256"] != s.ContentSHA256 || p.Params["scriptVersionId"] != s.VersionID || !hex64RE.MatchString(s.ContentSHA256) {
		return refuse("script_mismatch", "the plan's parameters do not name its script block")
	}
	if s.Language != "powershell" || s.TargetOS != "windows" {
		return refuse("script_mismatch", "not a Windows PowerShell script")
	}
	if why := declsProblem(s.Parameters); why != "" {
		return refuse("bad_declarations", why)
	}
	args, _ := p.Params["parameters"].(map[string]any)
	if why := argumentsProblem(s.Parameters, args); why != "" {
		return refuse("arguments_not_allowed", why)
	}
	// SAME_PERSON: whoever wrote the content approves no run of it. A
	// direct plan (0.39) has no approval to give.
	if p.Policy.Approval != "direct" {
		for _, ap := range p.Approvers {
			for _, c := range s.Contributors {
				if ap.UserID == c {
					return refuse("contributor_approved", "an approver wrote or edited this script")
				}
			}
		}
	}
	if o.ScriptContent == nil {
		return refuse("no_content", "the script was not delivered with the plan")
	}
	if len(o.ScriptContent) > MaxScriptBytes || len(o.ScriptContent) != s.ContentBytes {
		return refuse("content_mismatch", "the delivered script is not the signed length")
	}
	sum := sha256.Sum256(o.ScriptContent)
	if hex.EncodeToString(sum[:]) != s.ContentSHA256 {
		return refuse("content_mismatch", "the delivered script does not hash to the signed SHA-256")
	}
	return nil
}

// scriptWrapper is the fixed text the agent runs. It reads the arguments as
// data and splats them into the script, so no argument is ever parsed as
// PowerShell. Keep it free of anything taken from a plan.
var utf8BOM = []byte{0xef, 0xbb, 0xbf}

const scriptWrapper = `# rem0te script run wrapper (v0.34). Fixed text; generated by the agent.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$here = $PSScriptRoot
$bound = @{}
$obj = [System.IO.File]::ReadAllText((Join-Path $here 'params.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($null -ne $obj) { foreach ($p in $obj.PSObject.Properties) { $bound[$p.Name] = $p.Value } }
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0
try {
    & (Join-Path $here 'script.ps1') @bound
} catch {
    [Console]::Error.WriteLine(($_ | Out-String))
    exit 1
}
if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
`

// streamOut: invalid UTF-8 replaced, redacted, capped again, base64.
func streamOut(b []byte, total int64) (string, bool) {
	s := RedactLog(strings.ToValidUTF8(string(b), "�"))
	trunc := total > int64(len(b))
	if len(s) > MaxScriptOutput {
		s, trunc = headBytes(s, MaxScriptOutput), true
	}
	return base64.StdEncoding.EncodeToString([]byte(s)), trunc
}

// headBytes: the first n bytes of s, never splitting a character.
func headBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func timeoutOf(p *Plan, o Options) time.Duration {
	t, _ := p.Params["timeoutMinutes"].(float64)
	unit := o.ScriptMinute
	if unit <= 0 {
		unit = time.Minute
	}
	return time.Duration(t) * unit
}

func runScript(p *Plan, o Options) Result {
	start := o.now()
	r := Result{ExecutedAt: start.UTC().Format(time.RFC3339), Observed: map[string]string{"script": p.Script.Name + " v" + itoa(p.Script.Version)}}
	if s, err := o.Platform.SelfSHA256(); err == nil {
		r.AgentSHA256 = s
	}
	sr := &ScriptResult{ContentSHA256: p.Script.ContentSHA256}
	r.Script = sr
	if err := os.MkdirAll(o.dir("run"), 0o700); err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "workdir_failed", trim(err.Error())
		return r
	}
	dir, err := os.MkdirTemp(o.dir("run"), p.JobID+"-")
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "workdir_failed", trim(err.Error())
		return r
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil {
			sr.Cleanup = "failed"
		} else {
			sr.Cleanup = "removed"
		}
	}()
	args, _ := p.Params["parameters"].(map[string]any)
	pj, _ := json.Marshal(args)
	if args == nil {
		pj = []byte("{}")
	}
	// script.ps1 gets a UTF-8 byte-order mark unless it has one (0.37.1):
	// Windows PowerShell 5.1 reads a BOM-less .ps1 as the ANSI code page, so
	// any non-ASCII text in an approved script (an em dash, an accented name)
	// is mis-decoded and can break parsing. The content's hash was checked
	// above, on the bytes as approved; the mark only tells PowerShell how to
	// read them. The wrapper is ASCII.
	content := o.ScriptContent
	if !bytes.HasPrefix(content, utf8BOM) {
		content = append(append([]byte{}, utf8BOM...), content...)
	}
	for name, b := range map[string][]byte{"script.ps1": content, "params.json": pj, "run.ps1": []byte(scriptWrapper)} {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			r.Outcome, r.Reason, r.Detail = "failed", "workdir_failed", trim(err.Error())
			return r
		}
	}
	run := o.Scripts.RunPowerShell(dir, filepath.Join(dir, "run.ps1"), timeoutOf(p, o), MaxScriptOutput)
	sr.DurationMs = run.Duration.Milliseconds()
	sr.Stdout, sr.StdoutTruncated = streamOut(run.Stdout, run.StdoutTotal)
	sr.Stderr, sr.StderrTruncated = streamOut(run.Stderr, run.StderrTotal)
	sr.StdoutBytes, sr.StderrBytes = run.StdoutTotal, run.StderrTotal
	sr.TimedOut = run.TimedOut
	if run.Leftovers {
		r.Observed["leftovers"] = "stopped"
	}
	switch {
	case run.Err != nil:
		r.Outcome, r.Reason, r.Detail = "failed", "start_failed", trim(run.Err.Error())
	case run.TimedOut:
		r.Outcome, r.Reason = "timed_out", "timed_out"
		t, _ := p.Params["timeoutMinutes"].(float64)
		r.Detail = fmt.Sprintf("stopped after %d minute(s), with everything it started; it may have done part of its work", int(t))
	default:
		code := int64(run.ExitCode)
		sr.ExitCode = &code
		r.Observed["exitCode"] = fmt.Sprint(code)
		if code == 0 {
			r.Outcome, r.Detail = "succeeded", "the script exited with code 0"
		} else {
			r.Outcome, r.Reason, r.Detail = "failed", "exit_code", fmt.Sprintf("the script exited with code %d", code)
		}
	}
	return r
}

// scriptInterrupted: the agent stopped while a script ran. Nothing is
// changed; what the script did is not known.
func scriptInterrupted(map[string]any, Options) map[string]string {
	return map[string]string{"script": "may have run in part; its output was not kept"}
}
