package action

// Maintenance actions (v0.32): restart one service from a fixed allowlist,
// schedule a warned restart of the computer, cancel it, and collect a fixed
// set of logs. Same rules as the rest of the catalog: closed parameters, no
// command, script, path or URL anywhere, journaled before anything changes,
// and every value re-checked here even though ParamsOK already passed it.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// Maintenance is the Windows surface these actions use; tests and the
// simulator fake it. Nothing here takes a command line: each method is one
// fixed operation.
type Maintenance interface {
	// StopService asks the service manager to stop the service and waits
	// until it reports stopped, or the timeout passes. It never stops a
	// dependent service: Windows refuses, and that refusal is the answer.
	StopService(name string, timeout time.Duration) error
	// ScheduleRestart: %SystemRoot%\System32\shutdown.exe /r /t <seconds>
	// /d p:4:1 /c <message>. ErrRestartScheduled if one is already pending.
	ScheduleRestart(seconds int, message string) error
	// CancelRestart: shutdown.exe /a. ErrNoRestartScheduled when none is pending.
	CancelRestart() error
	// RemoteSessions counts incoming RustDesk sessions — the
	// 'rustdesk.exe --cm' connection-manager processes, the signal the
	// heartbeat already reports as rustdeskSessions. An error means "cannot
	// tell", which the callers treat as "a session may be open".
	RemoteSessions() (int, error)
	// Events returns wevtutil's text rendering of the Critical and Error
	// events in log (System or Application only) newer than since, newest
	// first, at most max.
	Events(log string, since time.Duration, max int) ([]byte, error)
	// RustdeskLogDirs lists the RustDesk service's log directories. Service
	// profiles only, never a user's profile.
	RustdeskLogDirs() []string
}

var (
	ErrRestartScheduled   = errors.New("a restart is already scheduled on this computer")
	ErrNoRestartScheduled = errors.New("no restart is scheduled on this computer")
)

// RestartableServices: the only services windows.service.restart may name.
// Each is an ordinary Windows or RustDesk service whose restart is a routine
// repair and whose absence for a few seconds harms nothing permanent. Kept
// out deliberately: security products (Defender, firewall, EDR agents), the
// security subsystem (lsass, SamSs, KeyIso, VaultSvc), RPC and the service
// manager itself, the event log (restarting it is how intruders hide), DNS
// Client (Dnscache: Windows 10+ refuses to stop it, so the button would only
// ever fail) and Workstation (LanmanWorkstation: stopping it drops every
// open file and mapped drive, and Netlogon depends on it on domain members).
// Keep in step with RESTARTABLE_SERVICES in apps/api/src/actions/catalog.ts.
var RestartableServices = []string{"Spooler", "wuauserv", "BITS", "W32Time", "WinRM", "RustDesk"}

// ServiceNameRE is the charset any service name must match before it is
// compared with the allowlist or passed to the service manager.
var ServiceNameRE = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)

// RestartService returns the allowlisted service a plan's params name, or "".
// Exactly {"service": <name>}; the name must pass the charset and then match
// an allowlist entry exactly (case and all).
func RestartService(p map[string]any) string {
	if len(p) != 1 {
		return ""
	}
	s, ok := p["service"].(string)
	if !ok || !ServiceNameRE.MatchString(s) {
		return ""
	}
	for _, a := range RestartableServices {
		if s == a {
			return s
		}
	}
	return ""
}

// Restart delay bounds, minutes: never sooner than five minutes after the
// warning appears, never more than a day out.
const (
	MinRestartDelayMinutes = 5
	MaxRestartDelayMinutes = 24 * 60
)

// RestartDelay returns the plan's delay in minutes, or 0 if the params are
// anything but exactly {"delayMinutes": <integer 5..1440>}.
func RestartDelay(p map[string]any) int {
	if len(p) != 1 {
		return 0
	}
	d, ok := p["delayMinutes"].(float64)
	if !ok || d != math.Trunc(d) || d < MinRestartDelayMinutes || d > MaxRestartDelayMinutes {
		return 0
	}
	return int(d)
}

// RestartMessage is the warning Windows shows the person at the computer.
// Fixed text: the only inputs are the time and the delay this agent computed
// itself, and the job id it verified. Nothing from the portal or a ticket.
func RestartMessage(at time.Time, minutes int, jobID string) string {
	return fmt.Sprintf("Your IT support provider has scheduled a restart of this computer for %s (in %d minutes). "+
		"Please save your work and close your programs before then: programs still open will be closed without saving. "+
		"Approved maintenance, reference %s.", at.Format("15:04 on Mon 2 Jan"), minutes, jobID[:8])
}

// RebootRecord is what the agent remembers about a restart it scheduled.
type RebootRecord struct {
	JobID string `json:"jobId"`
	At    string `json:"at"`
}

func rebootRecordPath(o Options) string { return filepath.Join(o.dir("journal"), "reboot.json") }

// Steps between the "executing" and "done" journal entries, so an
// interrupted job says how far it got.
func journalStep(o Options, p *Plan, step string) {
	_ = writeJournal(o, journal{JobID: p.JobID, State: "executing", Step: step, At: o.now().UTC().Format(time.RFC3339),
		ActionID: p.Action.ID, ActionVersion: p.Action.Version, Params: p.Params})
}

func started(o Options) Result {
	r := Result{ExecutedAt: o.now().UTC().Format(time.RFC3339), Observed: map[string]string{}}
	if s, err := o.Platform.SelfSHA256(); err == nil {
		r.AgentSHA256 = s
	}
	return r
}

// sessionCheck refuses to go on while anyone may be connected through
// RustDesk. "Cannot tell" counts as connected.
func sessionCheck(what string) func(p *Plan, o Options) *Result {
	return func(p *Plan, o Options) *Result {
		if o.Maint == nil {
			return &Result{Outcome: "failed", Reason: "no_maintenance", Detail: "this agent cannot perform maintenance actions"}
		}
		n, err := o.Maint.RemoteSessions()
		if err != nil {
			return &Result{Outcome: "not_executed", Reason: "session_state_unknown",
				Detail: "could not tell whether a remote session is open, so " + what + " was not done: " + trim(err.Error())}
		}
		if n > 0 {
			return &Result{Outcome: "not_executed", Reason: "remote_session_open", Observed: map[string]string{"remoteSessions": strconv.Itoa(n)},
				Detail: "a RustDesk session was open on this computer, so " + what + " was not done. Request it again when nobody is connected."}
		}
		return nil
	}
}

// restartPrecheck: only the RustDesk service needs the session check —
// restarting it drops whoever is connected.
func restartPrecheck(p *Plan, o Options) *Result {
	if o.Maint == nil {
		return &Result{Outcome: "failed", Reason: "no_maintenance", Detail: "this agent cannot perform maintenance actions"}
	}
	if RestartService(p.Params) == "RustDesk" {
		return sessionCheck("the RustDesk restart")(p, o)
	}
	return nil
}

func restartService(p *Plan, o Options) Result {
	r := started(o)
	name := RestartService(p.Params) // verified already; checked again before use
	if name == "" {
		r.Outcome, r.Reason, r.Detail = "refused", "params_not_allowed", "the service is not on this agent's allowlist"
		return r
	}
	r.Observed["service"] = name
	before, err := o.Platform.ServiceState(name)
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "service_query_failed", trim(err.Error())
		return r
	}
	r.Observed["before"] = before
	if before != "stopped" {
		journalStep(o, p, "stopping")
		timeout := o.StopTimeout
		if timeout == 0 {
			timeout = 60 * time.Second
		}
		if err := o.Maint.StopService(name, timeout); err != nil {
			r.Outcome, r.Reason, r.Detail = "failed", "stop_failed", trim(err.Error())
			if st, e := o.Platform.ServiceState(name); e == nil {
				r.Observed["after"] = st
			}
			return r
		}
		st, _ := o.Platform.ServiceState(name)
		r.Observed["stopped"] = st
	}
	journalStep(o, p, "starting")
	if err := o.Platform.StartService(name); err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "start_failed", trim(err.Error())
		if st, e := o.Platform.ServiceState(name); e == nil {
			r.Observed["after"] = st
		}
		return r
	}
	if verifyRunning(o, name, &r) {
		r.Outcome, r.Detail = "succeeded", "restarted; running at every check"
		if before == "stopped" {
			r.Detail = "it was stopped, so it was started; running at every check"
		}
	} else {
		r.Outcome, r.Reason, r.Detail = "failed", "did_not_remain_running", "restarted, but was not running at every check"
	}
	return r
}

// verifyRunning sleeps through o.Checks and records the state after each.
func verifyRunning(o Options, name string, r *Result) bool {
	checks := o.Checks
	if checks == nil {
		checks = []time.Duration{10 * time.Second, 20 * time.Second}
	}
	elapsed, ok := time.Duration(0), true
	for _, d := range checks {
		o.Platform.Sleep(d)
		elapsed += d
		st, err := o.Platform.ServiceState(name)
		if err != nil {
			st = "unknown"
		}
		r.Observed[fmt.Sprintf("after%ds", int(elapsed.Seconds()))] = st
		if st != "running" {
			ok = false
		}
	}
	return ok
}

func restartInterrupted(params map[string]any, o Options) map[string]string {
	if name := RestartService(params); name != "" {
		if st, err := o.Platform.ServiceState(name); err == nil {
			return map[string]string{"service": name, "now": st}
		}
	}
	return nil
}

func scheduleRestart(p *Plan, o Options) Result {
	r := started(o)
	minutes := RestartDelay(p.Params)
	if minutes == 0 {
		r.Outcome, r.Reason, r.Detail = "refused", "params_not_allowed", "the delay is outside 5 minutes to 24 hours"
		return r
	}
	journalStep(o, p, "scheduling")
	at, err := scheduleWarnedRestart(p, o, minutes)
	if err != nil {
		if errors.Is(err, ErrRestartScheduled) {
			r.Outcome, r.Reason, r.Detail = "failed", "restart_already_scheduled", "Windows already has a restart or shutdown pending; nothing was changed. Cancel that one first if it is ours."
		} else {
			r.Outcome, r.Reason, r.Detail = "failed", "schedule_failed", trim(err.Error())
		}
		return r
	}
	r.Observed["scheduledFor"] = at.UTC().Format(time.RFC3339)
	r.Observed["delayMinutes"] = strconv.Itoa(minutes)
	r.Outcome, r.Detail = "succeeded", "Windows is showing the restart warning; the computer restarts at the time shown unless the restart is canceled"
	return r
}

// scheduleWarnedRestart is the one way this agent restarts a computer:
// Maintenance.ScheduleRestart (shutdown.exe /r /t <seconds> on Windows) with
// the fixed RestartMessage, then a record of it for windows.reboot.cancel.
// windows.reboot.schedule and windows.update.install's in-window restart
// (0.34) both come through here, after their own session and window checks.
func scheduleWarnedRestart(p *Plan, o Options, minutes int) (time.Time, error) {
	at := o.now().Add(time.Duration(minutes) * time.Minute)
	if err := o.Maint.ScheduleRestart(minutes*60, RestartMessage(at.Local(), minutes, p.JobID)); err != nil {
		return at, err
	}
	_ = atomicWrite(rebootRecordPath(o), RebootRecord{JobID: p.JobID, At: at.UTC().Format(time.RFC3339)})
	return at, nil
}

func scheduleInterrupted(_ map[string]any, o Options) map[string]string {
	return map[string]string{"note": "a restart may have been scheduled; look for the Windows warning"}
}

func cancelRestart(p *Plan, o Options) Result {
	r := started(o)
	var rec RebootRecord
	if b, err := os.ReadFile(rebootRecordPath(o)); err == nil && json.Unmarshal(b, &rec) == nil && jobRE.MatchString(rec.JobID) {
		r.Observed["scheduledBy"] = rec.JobID
		if _, err := time.Parse(time.RFC3339, rec.At); err == nil {
			r.Observed["scheduledFor"] = rec.At
		}
	}
	journalStep(o, p, "canceling")
	err := o.Maint.CancelRestart()
	switch {
	case errors.Is(err, ErrNoRestartScheduled):
		r.Outcome, r.Detail = "no_change", "no restart was pending on this computer; nothing was changed"
	case err != nil:
		r.Outcome, r.Reason, r.Detail = "failed", "cancel_failed", trim(err.Error())
		return r
	default:
		r.Outcome, r.Detail = "succeeded", "the pending restart was canceled"
	}
	_ = os.Remove(rebootRecordPath(o))
	return r
}

// ── Log collection ──────────────────────────────────────────────────────────

// LogSources is the fixed set windows.logs.collect returns, in this order.
var LogSources = []string{"system_errors", "application_errors", "agent_journal", "agent_log", "rustdesk_log"}

const (
	// MaxSectionBytes: the most text any one source contributes.
	MaxSectionBytes = 12 << 10
	// MaxLogsBytes: the most text one collection carries in all.
	MaxLogsBytes = 40 << 10
	// LogEventsPerLog and LogEventsWindow: what the event-log sources ask for.
	LogEventsPerLog = 50
	LogEventsWindow = 24 * time.Hour
	// Journal entries summarized.
	logJournalEntries = 25
	// Files examined under the RustDesk log directories, at most.
	logMaxFiles = 400
)

// LogSection is one source's text. Note says why it is empty or short.
type LogSection struct {
	Source    string `json:"source"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Note      string `json:"note,omitempty"`
}

func collectLogs(p *Plan, o Options) Result {
	r := started(o)
	var out []LogSection
	total := 0
	add := func(src string, text string, note string, cut bool) {
		s := LogSection{Source: src, Note: note, Truncated: cut}
		text = RedactLog(text)
		if len(text) > MaxSectionBytes {
			text, s.Truncated = tailBytes(text, MaxSectionBytes), true
		}
		if total+len(text) > MaxLogsBytes {
			text, s.Truncated = tailBytes(text, MaxLogsBytes-total), true
			if s.Note == "" {
				s.Note = "shortened: the collection reached its size limit"
			}
		}
		total += len(text)
		s.Text = text
		out = append(out, s)
	}
	journalStep(o, p, "collecting")
	for _, l := range []struct{ src, log string }{{"system_errors", "System"}, {"application_errors", "Application"}} {
		raw, err := o.Maint.Events(l.log, LogEventsWindow, LogEventsPerLog)
		switch {
		case err != nil:
			add(l.src, "", "could not read the "+l.log+" log: "+trim(err.Error()), false)
		default:
			t := CompactEvents(decodeText(raw))
			note := ""
			if strings.TrimSpace(t) == "" {
				note = "no Critical or Error events in the last 24 hours"
			}
			add(l.src, t, note, false)
		}
	}
	j, n := journalSummary(o)
	note := ""
	if n == 0 {
		note = "no earlier approved actions on this computer"
	}
	add("agent_journal", j, note, false)
	if t, cut, err := tailFile(filepath.Join(o.StateDir, "Logs", "agent.log"), MaxSectionBytes); err != nil {
		add("agent_log", "", "no agent log: "+trim(err.Error()), false)
	} else {
		add("agent_log", t, "", cut)
	}
	if f, err := newestLog(o.Maint.RustdeskLogDirs()); err != nil {
		add("rustdesk_log", "", trim(err.Error()), false)
	} else if t, cut, err := tailFile(f, MaxSectionBytes); err != nil {
		add("rustdesk_log", "", "could not read the newest RustDesk log: "+trim(err.Error()), false)
	} else {
		add("rustdesk_log", t, "newest log: "+trim(filepath.Base(f)), cut)
	}
	r.Logs = out
	r.Observed["sources"] = strconv.Itoa(len(out))
	r.Observed["bytes"] = strconv.Itoa(total)
	empty := 0
	for _, s := range out {
		if s.Text == "" {
			empty++
		}
	}
	r.Outcome, r.Detail = "succeeded", fmt.Sprintf("collected %d sources (%d bytes, redacted)", len(out)-empty, total)
	return r
}

// journalSummary: one line per recent job, newest first. The journal is the
// agent's own record, so this needs no redaction beyond the usual.
func journalSummary(o Options) (string, int) {
	ents, err := os.ReadDir(o.dir("journal"))
	if err != nil {
		return "", 0
	}
	var js []journal
	for _, e := range ents {
		n := e.Name()
		if !e.Type().IsRegular() || !strings.HasSuffix(n, ".json") || !jobRE.MatchString(strings.TrimSuffix(n, ".json")) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(o.dir("journal"), n))
		if err != nil || len(b) > 256<<10 {
			continue
		}
		var j journal
		if json.Unmarshal(b, &j) == nil {
			js = append(js, j)
		}
	}
	sort.Slice(js, func(a, b int) bool { return js[a].At > js[b].At })
	if len(js) > logJournalEntries {
		js = js[:logJournalEntries]
	}
	var sb strings.Builder
	for _, j := range js {
		fmt.Fprintf(&sb, "%s %s %s@%d %s", j.At, j.JobID, j.ActionID, j.ActionVersion, j.State)
		if j.Step != "" && j.State == "executing" {
			fmt.Fprintf(&sb, " (at %s)", j.Step)
		}
		if j.Result != nil {
			fmt.Fprintf(&sb, " → %s", j.Result.Outcome)
			if j.Result.Reason != "" {
				fmt.Fprintf(&sb, " (%s)", j.Result.Reason)
			}
		}
		sb.WriteByte('\n')
	}
	return sb.String(), len(js)
}

// newestLog finds the most recently written *.log file under dirs, at most
// two levels down, ignoring links and anything that is not a regular file.
func newestLog(dirs []string) (string, error) {
	best, bestT, seen := "", time.Time{}, 0
	for _, d := range dirs {
		root := filepath.Clean(d)
		_ = filepath.WalkDir(root, func(p string, e fs.DirEntry, err error) error {
			if seen >= logMaxFiles {
				return fs.SkipAll
			}
			if err != nil {
				return fs.SkipDir
			}
			rel, _ := filepath.Rel(root, p)
			depth := len(strings.Split(rel, string(filepath.Separator)))
			if e.IsDir() {
				if rel != "." && depth > 2 {
					return fs.SkipDir
				}
				return nil
			}
			if !e.Type().IsRegular() || !strings.EqualFold(filepath.Ext(p), ".log") {
				return nil
			}
			seen++
			if fi, err := e.Info(); err == nil && fi.ModTime().After(bestT) {
				best, bestT = p, fi.ModTime()
			}
			return nil
		})
	}
	if best == "" {
		return "", errors.New("no RustDesk service log found")
	}
	return best, nil
}

// tailFile reads at most max bytes from the end of a regular file. Links and
// other non-regular files are refused, so nothing outside the fixed
// locations is read through them.
func tailFile(p string, max int) (string, bool, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		return "", false, err
	}
	if !fi.Mode().IsRegular() {
		return "", false, errors.New("not a regular file")
	}
	f, err := os.Open(p)
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	off := fi.Size() - int64(max)
	if off < 0 {
		off = 0
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return "", false, err
	}
	b, err := io.ReadAll(io.LimitReader(f, int64(max)))
	if err != nil {
		return "", false, err
	}
	s := decodeText(b)
	if off > 0 {
		// Start at a line boundary rather than mid-line.
		if i := strings.IndexByte(s, '\n'); i >= 0 && i < len(s)-1 {
			s = s[i+1:]
		}
	}
	return s, off > 0, nil
}

// decodeText: UTF-16LE (with or without BOM, as wevtutil may write it) or
// UTF-8, always returned as valid UTF-8.
func decodeText(b []byte) string {
	if len(b) >= 2 && b[0] == 0xff && b[1] == 0xfe {
		return utf16le(b[2:])
	}
	if len(b) >= 4 {
		zeros := 0
		n := len(b)
		if n > 512 {
			n = 512
		}
		for i := 1; i < n; i += 2 {
			if b[i] == 0 {
				zeros++
			}
		}
		if zeros*4 > n {
			return utf16le(b)
		}
	}
	b = []byte(strings.TrimPrefix(string(b), "\xef\xbb\xbf"))
	if !utf8.Valid(b) {
		return strings.ToValidUTF8(string(b), "?")
	}
	return string(b)
}

func utf16le(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
	}
	return string(utf16.Decode(u))
}

// tailBytes keeps the last n bytes of s without splitting a character.
func tailBytes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	for len(s) > 0 && !utf8.RuneStart(s[0]) {
		s = s[1:]
	}
	return s
}

// CompactEvents keeps the lines of wevtutil's /f:text output that say what
// happened (when, source, id, level, description) and drops the rest
// (computer, user, task, opcode, keywords), which cost space and say nothing.
func CompactEvents(s string) string {
	drop := []string{"Log Name:", "Task:", "Opcode:", "Keyword:", "User:", "User Name:", "Computer:"}
	var sb strings.Builder
	for _, line := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		skip := false
		for _, d := range drop {
			if strings.HasPrefix(t, d) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		if strings.HasPrefix(t, "Event[") {
			sb.WriteByte('\n')
		}
		sb.WriteString(t)
		sb.WriteByte('\n')
	}
	return strings.TrimLeft(sb.String(), "\n")
}

// Redaction. The first three rules are the diagnostics catalog's redact()
// (apps/api/src/diagnostics-catalog/catalog.ts), ported so that what leaves
// this computer is already redacted; the portal applies the same rules again
// on receipt and does not trust this copy.
var (
	logControl = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f]`)
	logProfile = regexp.MustCompile(`(?i)[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s"'<>|]+`)
	logToken   = regexp.MustCompile(`\b[A-Za-z0-9+/_-]{40,}={0,2}`)
	// Credentials written as key=value or key: value in a log line.
	logCred = regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*)((?:Bearer|Basic)\s+\S+|"[^"]*"|'[^']*'|\S+)`)
)

// RedactLog: control characters, user-profile paths, long opaque tokens and
// key=value credentials. Tabs and newlines are kept.
func RedactLog(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = logControl.ReplaceAllString(s, " ")
	s = logProfile.ReplaceAllString(s, "%USERPROFILE%")
	s = logToken.ReplaceAllString(s, "[redacted]")
	return logCred.ReplaceAllString(s, "$1$2[redacted]")
}
