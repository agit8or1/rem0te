// Package msa is the signed agent's read-only RustDesk preflight for Managed
// Secure Access (0.69.0, build step 2 in docs/managed-secure-access.md).
//
// It only reads. It asks the INSTALLED rustdesk.exe for the current value of
// each option Managed Secure Access will one day set, through
// `rustdesk.exe --option <key>` with no value, and records only whether each
// read was answered and parsed. It never passes a value to an option, never
// sets the password, never reports what a setting is, and never reports a
// path or a user name. ReadArgs is the only way its command line is built.
//
// This file is portable (no Windows calls) so the whole decision is tested
// on every platform; the Windows side (rustdesk_preflight_windows.go) only
// supplies the facts and runs the reads.
package msa

import (
	"bytes"
	"context"
	"regexp"
	"time"
)

// Schema names the report the heartbeat sends as rustdeskPreflight.
const Schema = "rem0te-rustdesk-preflight/1"

// Keys is the closed list of RustDesk options the preflight reads, in order:
// the eleven the Windows lab (0.68.3) proved SYSTEM can change and read back.
var Keys = []string{
	"access-mode",
	"enable-keyboard",
	"enable-clipboard",
	"enable-file-transfer",
	"enable-audio",
	"enable-tunnel",
	"enable-remote-restart",
	"approve-mode",
	"verification-method",
	"allow-auto-disconnect",
	"auto-disconnect-timeout",
}

// Per-key result values.
const (
	KeyOK       = "ok"
	KeyUnparsed = "unparsed"
	KeyTimeout  = "timeout"
	KeyError    = "error"
)

// CLI summary values.
const (
	CLIOK      = "ok"
	CLIPartial = "partial"
	CLIFailed  = "failed"
	CLINotRun  = "not_run"
)

// Bounds.
const (
	// ReadTimeout bounds one read; the lab measured about 80–190 ms.
	ReadTimeout = 15 * time.Second
	// RunTimeout bounds the whole preflight.
	RunTimeout = 3 * time.Minute
	// MaxReadBytes caps what is kept of one read's output.
	MaxReadBytes = 4096
	// Every is how often the preflight runs when nothing changed.
	Every = 6 * time.Hour
	// FutureSkew: a last run further in the future than this is a clock that jumped.
	FutureSkew = 10 * time.Minute
)

func isKey(k string) bool {
	for _, x := range Keys {
		if x == k {
			return true
		}
	}
	return false
}

// ReadArgs is the only way the preflight's argument list is built: exactly
// {"--option", key} for a key on the closed list, and nil for anything else.
// It takes no value, so the preflight can only ever read.
func ReadArgs(key string) []string {
	if !isKey(key) {
		return nil
	}
	return []string{"--option", key}
}

var answerRE = regexp.MustCompile(`^[A-Za-z0-9_.:-]{0,64}$`)

// ParseRead classifies one read: ok when it exited 0 in time and printed one
// short line in the answer charset (empty is an answer: the option is unset).
// truncated means the output went over MaxReadBytes.
func ParseRead(stdout []byte, exitCode int, timedOut, truncated bool, err error) string {
	if timedOut {
		return KeyTimeout
	}
	if err != nil || exitCode != 0 {
		return KeyError
	}
	if truncated || len(stdout) > MaxReadBytes {
		return KeyUnparsed
	}
	s := bytes.TrimSpace(stdout)
	if bytes.ContainsAny(s, "\r\n") || !answerRE.Match(s) {
		return KeyUnparsed
	}
	return KeyOK
}

var versionRE = regexp.MustCompile(`^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}([.+][0-9]{1,6})?$`)

// ParseVersion returns the file version if it is in the strict charset, else "".
func ParseVersion(v string) string {
	if versionRE.MatchString(v) {
		return v
	}
	return ""
}

// ClassifyBuild is a heuristic: a Flutter build ships flutter_windows.dll
// beside rustdesk.exe; a Sciter build ships sciter.dll.
func ClassifyBuild(hasFlutter, hasSciter bool) string {
	switch {
	case hasFlutter:
		return "flutter"
	case hasSciter:
		return "sciter"
	}
	return "unknown"
}

// Summarise turns the per-key results into the cli field.
func Summarise(keys map[string]string) string {
	if len(keys) == 0 {
		return CLINotRun
	}
	ok := 0
	for _, k := range Keys {
		if keys[k] == KeyOK {
			ok++
		}
	}
	switch {
	case ok == len(Keys):
		return CLIOK
	case ok == 0:
		return CLIFailed
	}
	return CLIPartial
}

// Fingerprint identifies the installed exe. Kept in the local state file
// only; never reported.
type Fingerprint struct {
	Version string `json:"version"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // unix nanoseconds
}

// State is msa\preflight.state.json.
type State struct {
	LastRunAt   time.Time   `json:"lastRunAt"`
	Fingerprint Fingerprint `json:"fingerprint"`
}

// ShouldRun: no state, Every since the last run, a changed exe, or a last run
// in the future by more than FutureSkew (a clock that jumped).
func ShouldRun(prev *State, now time.Time, fp Fingerprint) bool {
	if prev == nil || prev.LastRunAt.IsZero() {
		return true
	}
	if prev.Fingerprint != fp {
		return true
	}
	if prev.LastRunAt.After(now.Add(FutureSkew)) {
		return true
	}
	return now.Sub(prev.LastRunAt) >= Every
}

// Facts are what the Windows side reads before any read is run.
type Facts struct {
	Installed    bool   // %ProgramFiles%\RustDesk\rustdesk.exe exists as a regular file, not a reparse point
	ExpectedPath bool   // the RustDesk service's image path names exactly that exe
	Version      string // FileVersion from the version resource, unchecked
	HasFlutter   bool
	HasSciter    bool
	Service      string // running | stopped | missing | other
}

// ReadResult is one read's raw outcome.
type ReadResult struct {
	Stdout    []byte
	ExitCode  int
	TimedOut  bool
	Truncated bool
	Err       error
}

// Runner runs the installed rustdesk.exe with exactly args (from ReadArgs).
type Runner interface {
	Read(ctx context.Context, args []string) ReadResult
}

// Report is preflight.json, exactly the block the portal validates.
type Report struct {
	Schema       string            `json:"schema"`
	CheckedAt    string            `json:"checkedAt"`
	Installed    bool              `json:"installed"`
	ExpectedPath bool              `json:"expectedPath"`
	Version      *string           `json:"version"`
	Build        string            `json:"build"`
	Service      string            `json:"service"`
	CLI          string            `json:"cli"`
	Keys         map[string]string `json:"keys"`
	DurationMs   int64             `json:"durationMs"`
}

func normService(s string) string {
	switch s {
	case "running", "stopped", "missing":
		return s
	}
	return "other"
}

// Run builds the report. Reads run only when the exe is installed at the
// expected path; each is bounded by ReadTimeout and the whole by RunTimeout.
func Run(ctx context.Context, r Runner, f Facts, now func() time.Time) Report {
	start := now()
	rep := Report{
		Schema:       Schema,
		CheckedAt:    start.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z"),
		Installed:    f.Installed,
		ExpectedPath: f.Installed && f.ExpectedPath,
		Build:        ClassifyBuild(f.HasFlutter, f.HasSciter),
		Service:      normService(f.Service),
		Keys:         map[string]string{},
	}
	if v := ParseVersion(f.Version); v != "" {
		rep.Version = &v
	}
	if rep.Installed && rep.ExpectedPath {
		ctx, cancel := context.WithTimeout(ctx, RunTimeout)
		defer cancel()
		for _, k := range Keys {
			args := ReadArgs(k)
			if args == nil { // cannot happen: k is from Keys
				rep.Keys[k] = KeyError
				continue
			}
			if ctx.Err() != nil {
				rep.Keys[k] = KeyTimeout
				continue
			}
			rctx, rcancel := context.WithTimeout(ctx, ReadTimeout)
			res := r.Read(rctx, args)
			if rctx.Err() != nil && res.Err != nil {
				res.TimedOut = true
			}
			rcancel()
			rep.Keys[k] = ParseRead(res.Stdout, res.ExitCode, res.TimedOut, res.Truncated, res.Err)
		}
	}
	rep.CLI = Summarise(rep.Keys)
	d := now().Sub(start).Milliseconds()
	if d < 0 {
		d = 0
	}
	if d > 600000 {
		d = 600000
	}
	rep.DurationMs = d
	return rep
}
