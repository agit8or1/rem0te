package action

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeMaint struct {
	stops     []string
	stopErr   error
	sessions  int
	sessErr   error
	sessCalls int
	scheduled *struct {
		seconds int
		msg     string
	}
	scheduleN  int
	cancels    int
	events     map[string]string
	eventsErr  error
	logDirs    []string
	stateAfter func() // what a stop does to the fake service
}

func (m *fakeMaint) StopService(name string, _ time.Duration) error {
	m.stops = append(m.stops, name)
	if m.stopErr != nil {
		return m.stopErr
	}
	if m.stateAfter != nil {
		m.stateAfter()
	}
	return nil
}
func (m *fakeMaint) ScheduleRestart(seconds int, msg string) error {
	m.scheduleN++
	if m.scheduled != nil {
		return ErrRestartScheduled
	}
	m.scheduled = &struct {
		seconds int
		msg     string
	}{seconds, msg}
	return nil
}
func (m *fakeMaint) CancelRestart() error {
	m.cancels++
	if m.scheduled == nil {
		return ErrNoRestartScheduled
	}
	m.scheduled = nil
	return nil
}
func (m *fakeMaint) RemoteSessions() (int, error) { m.sessCalls++; return m.sessions, m.sessErr }
func (m *fakeMaint) Events(log string, _ time.Duration, _ int) ([]byte, error) {
	if m.eventsErr != nil {
		return nil, m.eventsErr
	}
	return []byte(m.events[log]), nil
}
func (m *fakeMaint) RustdeskLogDirs() []string { return m.logDirs }

func highPlan(id string, params map[string]any) map[string]any {
	p := basePlan()
	p["action"] = map[string]any{"id": id, "version": 1}
	p["params"] = params
	p["policy"] = map[string]any{"risk": "high", "approvalsRequired": 2, "customerSignoff": false}
	signed := now.Add(-time.Minute).Format(time.RFC3339Nano)
	p["approvers"] = []any{
		map[string]any{"userId": "user-approver1", "name": "Olivia", "role": "approver", "credentialSha256": selfSHA, "at": signed},
		map[string]any{"userId": "user-approver2", "name": "Priya", "role": "approver", "credentialSha256": selfSHA, "at": signed},
	}
	return p
}

func (f *fixture) withMaint() *fakeMaint {
	m := &fakeMaint{stateAfter: func() { f.p.state = "stopped" }}
	return m
}

func (f *fixture) runMaint(env []byte, m Maintenance) Result {
	o := f.opts()
	o.Maint = m
	r, err := Run(job, env, o)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func TestCatalogIsExactlyTheNineActions(t *testing.T) {
	want := []string{"windows.service.start@1", "windows.update.install@1", "windows.service.restart@1", "windows.reboot.schedule@1", "windows.reboot.cancel@1", "windows.logs.collect@1",
		"windows.script.run@1", "windows.software.install@1", "windows.software.uninstall@1"}
	if got := Supported(); !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog %v", got)
	}
	for _, a := range catalog {
		if a.Risk(1, 1) == "low" && a.ID != "windows.service.start" {
			t.Fatalf("%s is low risk on a workstation; only the 0.26 spooler start is", a.ID)
		}
	}
}

func TestRestartAllowlistAndCharset(t *testing.T) {
	for _, s := range RestartableServices {
		if RestartService(map[string]any{"service": s}) != s {
			t.Fatalf("%s should be restartable", s)
		}
	}
	for _, p := range []map[string]any{
		{"service": "WinDefend"}, {"service": "lsass"}, {"service": "EventLog"}, {"service": "mpssvc"}, {"service": "Dnscache"},
		{"service": "LanmanWorkstation"}, {"service": "spooler"}, {"service": "Spooler "}, {"service": "Spooler\x00"},
		{"service": "Spooler&calc"}, {"service": "..\\Spooler"}, {"service": 1}, {"service": "Spooler", "args": "x"}, {},
	} {
		if RestartService(p) != "" {
			t.Fatalf("%v must not be restartable", p)
		}
	}
}

func TestRestartStopsStartsAndVerifies(t *testing.T) {
	f := newFixture(t)
	f.p.state = "running"
	m := f.withMaint()
	r := f.runMaint(f.envelope(highPlan("windows.service.restart", map[string]any{"service": "wuauserv"}), nil), m)
	expect(t, r, "succeeded", "")
	if !reflect.DeepEqual(m.stops, []string{"wuauserv"}) || f.p.starts != 1 || r.Observed["before"] != "running" || r.Observed["stopped"] != "stopped" || r.Observed["after2s"] != "running" {
		t.Fatalf("stops %v starts %d observed %+v", m.stops, f.p.starts, r.Observed)
	}
	if m.sessCalls != 0 {
		t.Fatal("only the RustDesk restart needs the session check")
	}
	// Replay: the journal answers, nothing is restarted again.
	f.p.state = "running"
	r = f.runMaint(f.envelope(highPlan("windows.service.restart", map[string]any{"service": "wuauserv"}), nil), m)
	if len(m.stops) != 1 || f.p.starts != 1 || r.Outcome != "succeeded" {
		t.Fatalf("a re-delivered restart ran again: stops %v starts %d", m.stops, f.p.starts)
	}
}

func TestRestartOfAStoppedServiceOnlyStartsIt(t *testing.T) {
	f := newFixture(t)
	m := f.withMaint()
	r := f.runMaint(f.envelope(highPlan("windows.service.restart", map[string]any{"service": "BITS"}), nil), m)
	expect(t, r, "succeeded", "")
	if len(m.stops) != 0 || f.p.starts != 1 {
		t.Fatalf("stops %v starts %d", m.stops, f.p.starts)
	}
}

func TestRestartStopFailureStartsNothing(t *testing.T) {
	f := newFixture(t)
	f.p.state = "running"
	m := f.withMaint()
	m.stopErr = errors.New("A stop control has been sent to a service that other running services are dependent on.")
	r := f.runMaint(f.envelope(highPlan("windows.service.restart", map[string]any{"service": "WinRM"}), nil), m)
	expect(t, r, "failed", "stop_failed")
	if f.p.starts != 0 {
		t.Fatal("started after a failed stop")
	}
}

func TestRestartRefusals(t *testing.T) {
	cases := []struct {
		name, reason string
		plan         map[string]any
	}{
		{"security product", "params_not_allowed", highPlan("windows.service.restart", map[string]any{"service": "WinDefend"})},
		{"lsass", "params_not_allowed", highPlan("windows.service.restart", map[string]any{"service": "lsass"})},
		{"extra field", "params_not_allowed", highPlan("windows.service.restart", map[string]any{"service": "Spooler", "command": "whoami"})},
		{"low-risk plan on a workstation", "risk_understated", func() map[string]any {
			p := basePlan()
			p["action"] = map[string]any{"id": "windows.service.restart", "version": 1}
			return p
		}()},
		{"one approver", "too_few_approvals", func() map[string]any {
			p := highPlan("windows.service.restart", map[string]any{"service": "Spooler"})
			p["approvers"] = p["approvers"].([]any)[:1]
			return p
		}()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			f.p.state = "running"
			m := f.withMaint()
			expect(t, f.runMaint(f.envelope(c.plan, nil), m), "refused", c.reason)
			if len(m.stops) != 0 || f.p.starts != 0 {
				t.Fatal("a refused plan touched a service")
			}
		})
	}
}

func TestRustdeskRestartWaitsForNoSession(t *testing.T) {
	for _, c := range []struct {
		name     string
		sessions int
		err      error
		outcome  string
		reason   string
	}{
		{"open session", 1, nil, "not_executed", "remote_session_open"},
		{"cannot tell", 0, errors.New("Access is denied."), "not_executed", "session_state_unknown"},
		{"nobody connected", 0, nil, "succeeded", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			f.p.state = "running"
			m := f.withMaint()
			m.sessions, m.sessErr = c.sessions, c.err
			r := f.runMaint(f.envelope(highPlan("windows.service.restart", map[string]any{"service": "RustDesk"}), nil), m)
			expect(t, r, c.outcome, c.reason)
			if c.outcome != "succeeded" {
				if len(m.stops) != 0 {
					t.Fatal("stopped RustDesk with a session that may be open")
				}
				j, _ := readJournal(f.opts(), job)
				if j.State != "done" {
					t.Fatal("a skipped job must be final")
				}
			}
		})
	}
}

func TestRestartInterruptedReportsTheNamedService(t *testing.T) {
	f := newFixture(t)
	o := f.opts()
	os.MkdirAll(filepath.Join(f.dir, "actions", "journal"), 0o700)
	writeJournal(o, journal{JobID: job, State: "executing", Step: "starting", At: now.Format(time.RFC3339), ActionID: "windows.service.restart", ActionVersion: 1, Params: map[string]any{"service": "BITS"}})
	r := f.runMaint(f.envelope(highPlan("windows.service.restart", map[string]any{"service": "BITS"}), nil), f.withMaint())
	expect(t, r, "uncertain", "interrupted")
	if r.Observed["service"] != "BITS" || r.Observed["now"] != "stopped" || !strings.Contains(r.Detail, "starting") || f.p.starts != 0 {
		t.Fatalf("observed %+v detail %q starts %d", r.Observed, r.Detail, f.p.starts)
	}
	// A journal naming a service off the allowlist reports nothing about it.
	if got := restartInterrupted(map[string]any{"service": "lsass"}, o); got != nil {
		t.Fatalf("reported %v", got)
	}
}

func TestScheduleRestart(t *testing.T) {
	f := newFixture(t)
	m := f.withMaint()
	r := f.runMaint(f.envelope(highPlan("windows.reboot.schedule", map[string]any{"delayMinutes": float64(30)}), nil), m)
	expect(t, r, "succeeded", "")
	if m.scheduled == nil || m.scheduled.seconds != 1800 || m.sessCalls != 1 {
		t.Fatalf("scheduled %+v sessions asked %d", m.scheduled, m.sessCalls)
	}
	if !strings.Contains(m.scheduled.msg, "in 30 minutes") || !strings.Contains(m.scheduled.msg, job[:8]) || !strings.Contains(m.scheduled.msg, "save your work") || len(m.scheduled.msg) > 500 {
		t.Fatalf("message %q", m.scheduled.msg)
	}
	if r.Observed["scheduledFor"] != now.Add(30*time.Minute).Format(time.RFC3339) {
		t.Fatalf("observed %+v", r.Observed)
	}
	var rec RebootRecord
	if b, err := os.ReadFile(rebootRecordPath(f.opts())); err != nil || json.Unmarshal(b, &rec) != nil || rec.JobID != job {
		t.Fatalf("no record of the scheduled restart: %v", err)
	}
	// A re-delivered envelope does not schedule a second restart.
	f.runMaint(f.envelope(highPlan("windows.reboot.schedule", map[string]any{"delayMinutes": float64(30)}), nil), m)
	if m.scheduleN != 1 {
		t.Fatalf("scheduled %d times", m.scheduleN)
	}
}

func TestScheduleRestartRefusals(t *testing.T) {
	for _, c := range []struct {
		name   string
		params map[string]any
	}{
		{"immediate", map[string]any{"delayMinutes": float64(0)}},
		{"under five minutes", map[string]any{"delayMinutes": float64(4)}},
		{"over a day", map[string]any{"delayMinutes": float64(1441)}},
		{"fraction", map[string]any{"delayMinutes": 30.5}},
		{"string", map[string]any{"delayMinutes": "30"}},
		{"message smuggled", map[string]any{"delayMinutes": float64(30), "message": "click here"}},
		{"none", map[string]any{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			m := f.withMaint()
			expect(t, f.runMaint(f.envelope(highPlan("windows.reboot.schedule", c.params), nil), m), "refused", "params_not_allowed")
			if m.scheduleN != 0 {
				t.Fatal("scheduled from a refused plan")
			}
		})
	}
	t.Run("window longer than two hours", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		p := highPlan("windows.reboot.schedule", map[string]any{"delayMinutes": float64(30)})
		p["window"] = map[string]any{"notBefore": now.Add(-time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(90 * time.Minute).Format(time.RFC3339Nano)}
		expect(t, f.runMaint(f.envelope(p, nil), m), "refused", "bad_window")
	})
	t.Run("session open", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		m.sessions = 2
		r := f.runMaint(f.envelope(highPlan("windows.reboot.schedule", map[string]any{"delayMinutes": float64(30)}), nil), m)
		expect(t, r, "not_executed", "remote_session_open")
		if m.scheduleN != 0 || r.Observed["remoteSessions"] != "2" {
			t.Fatalf("scheduled %d observed %+v", m.scheduleN, r.Observed)
		}
	})
	t.Run("already scheduled", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		m.scheduled = &struct {
			seconds int
			msg     string
		}{60, "someone else"}
		expect(t, f.runMaint(f.envelope(highPlan("windows.reboot.schedule", map[string]any{"delayMinutes": float64(30)}), nil), m), "failed", "restart_already_scheduled")
		if m.scheduled.msg != "someone else" {
			t.Fatal("replaced a pending restart")
		}
	})
	t.Run("paused before anything is asked", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		o := f.opts()
		o.Maint = m
		o.Pause = &Pause{Schema: PauseSchema, IssuedAt: now.Format(time.RFC3339), Reason: "incident", Actions: PauseScope{All: true}}
		r, _ := Run(job, f.envelope(highPlan("windows.reboot.schedule", map[string]any{"delayMinutes": float64(30)}), nil), o)
		expect(t, r, "refused", "paused")
		if m.sessCalls != 0 || m.scheduleN != 0 {
			t.Fatal("the signed pause must come before the action's own checks")
		}
	})
}

func TestCancelRestart(t *testing.T) {
	f := newFixture(t)
	m := f.withMaint()
	m.scheduled = &struct {
		seconds int
		msg     string
	}{600, "x"}
	os.MkdirAll(filepath.Join(f.dir, "actions", "journal"), 0o700)
	atomicWrite(rebootRecordPath(f.opts()), RebootRecord{JobID: "ffffffffffffffffffffffffffffffff", At: now.Format(time.RFC3339)})
	r := f.runMaint(f.envelope(highPlan("windows.reboot.cancel", map[string]any{}), nil), m)
	expect(t, r, "succeeded", "")
	if m.scheduled != nil || r.Observed["scheduledBy"] != "ffffffffffffffffffffffffffffffff" {
		t.Fatalf("observed %+v", r.Observed)
	}
	if _, err := os.Stat(rebootRecordPath(f.opts())); err == nil {
		t.Fatal("the record of a canceled restart was kept")
	}

	g := newFixture(t)
	expect(t, g.runMaint(g.envelope(highPlan("windows.reboot.cancel", map[string]any{}), nil), g.withMaint()), "no_change", "")
	h := newFixture(t)
	expect(t, h.runMaint(h.envelope(highPlan("windows.reboot.cancel", map[string]any{"force": true}), nil), h.withMaint()), "refused", "params_not_allowed")
}

const sampleEvents = "Event[0]:\r\n  Log Name: System\r\n  Source: Service Control Manager\r\n  Date: 2026-11-09T11:00:00.000\r\n  Event ID: 7000\r\n  Task: N/A\r\n  Level: Error\r\n  Opcode: N/A\r\n  Keyword: Classic\r\n  User: N/A\r\n  User Name: N/A\r\n  Computer: FRONTDESK.corp.example\r\n  Description: \r\nThe Print Spooler service failed to start: C:\\Users\\alice\\AppData\\x.dll password=hunter2\r\n"

func TestCollectLogs(t *testing.T) {
	f := newFixture(t)
	m := f.withMaint()
	m.events = map[string]string{"System": sampleEvents, "Application": ""}
	rd := filepath.Join(t.TempDir(), "log")
	os.MkdirAll(filepath.Join(rd, "server"), 0o700)
	os.WriteFile(filepath.Join(rd, "old.log"), []byte("old"), 0o600)
	os.Chtimes(filepath.Join(rd, "old.log"), now.Add(-time.Hour), now.Add(-time.Hour))
	os.WriteFile(filepath.Join(rd, "server", "rustdesk_r.log"), []byte("[INFO] connected key="+strings.Repeat("A", 44)+"\n"+strings.Repeat("a line of the service log\n", 1000)+"last line\n"), 0o600)
	os.WriteFile(filepath.Join(rd, "server", "RustDesk2.toml"), []byte("password = 'secret'"), 0o600)
	m.logDirs = []string{rd}
	os.MkdirAll(filepath.Join(f.dir, "Logs"), 0o700)
	os.WriteFile(filepath.Join(f.dir, "Logs", "agent.log"), []byte("=== 2026 [action]\n  action abc: succeeded token: s3cr3tvalue\n"), 0o600)

	r := f.runMaint(f.envelope(highPlan("windows.logs.collect", map[string]any{}), nil), m)
	expect(t, r, "succeeded", "")
	if len(r.Logs) != len(LogSources) {
		t.Fatalf("sections %+v", r.Logs)
	}
	total := 0
	for i, s := range r.Logs {
		if s.Source != LogSources[i] {
			t.Fatalf("section %d is %s", i, s.Source)
		}
		if len(s.Text) > MaxSectionBytes {
			t.Fatalf("%s is %d bytes", s.Source, len(s.Text))
		}
		total += len(s.Text)
		for _, leak := range []string{"alice", "hunter2", strings.Repeat("A", 44), "s3cr3tvalue", "Computer:", "'secret'"} {
			if strings.Contains(s.Text, leak) {
				t.Fatalf("%s leaks %q: %q", s.Source, leak, s.Text)
			}
		}
	}
	if total > MaxLogsBytes {
		t.Fatalf("total %d", total)
	}
	sys := r.Logs[0].Text
	if !strings.Contains(sys, "Event ID: 7000") || !strings.Contains(sys, "%USERPROFILE%") || !strings.Contains(sys, "password=[redacted]") {
		t.Fatalf("system %q", sys)
	}
	if r.Logs[1].Note == "" || r.Logs[2].Text == "" && r.Logs[2].Note == "" {
		t.Fatalf("notes %+v", r.Logs)
	}
	rdl := r.Logs[4]
	if !rdl.Truncated || !strings.HasSuffix(rdl.Text, "last line\n") || !strings.Contains(rdl.Note, "rustdesk_r.log") {
		t.Fatalf("rustdesk %+v", rdl.Note)
	}
	if !strings.Contains(r.Logs[2].Text, "windows.logs.collect@1 executing (at collecting)") {
		t.Fatalf("journal %q", r.Logs[2].Text)
	}
}

func TestCollectLogsRefusesLinksAndParams(t *testing.T) {
	f := newFixture(t)
	m := f.withMaint()
	m.eventsErr = errors.New("wevtutil exit 5")
	rd := t.TempDir()
	secret := filepath.Join(t.TempDir(), "secret.log")
	os.WriteFile(secret, []byte("do not read"), 0o600)
	if err := os.Symlink(secret, filepath.Join(rd, "link.log")); err != nil {
		t.Skip("no symlinks here")
	}
	m.logDirs = []string{rd}
	r := f.runMaint(f.envelope(highPlan("windows.logs.collect", map[string]any{}), nil), m)
	expect(t, r, "succeeded", "")
	for _, s := range r.Logs {
		if strings.Contains(s.Text, "do not read") {
			t.Fatal("followed a link out of the log directory")
		}
	}
	if r.Logs[0].Note == "" || r.Logs[4].Text != "" {
		t.Fatalf("%+v", r.Logs)
	}
	g := newFixture(t)
	expect(t, g.runMaint(g.envelope(highPlan("windows.logs.collect", map[string]any{"path": "C:\\Windows"}), nil), g.withMaint()), "refused", "params_not_allowed")
	h := newFixture(t)
	expect(t, h.runMaint(h.envelope(highPlan("windows.logs.collect", map[string]any{}), nil), nil), "failed", "no_maintenance")
}

func TestRedactAndDecode(t *testing.T) {
	in := "a\x07b C:\\Users\\bob\\Desktop Authorization: Bearer xyz pwd=\"two words\" " + strings.Repeat("Zz09", 12) + "\tend"
	out := RedactLog(in)
	for _, leak := range []string{"\x07", "bob", "xyz", "two words", strings.Repeat("Zz09", 12)} {
		if strings.Contains(out, leak) {
			t.Fatalf("%q leaks %q", out, leak)
		}
	}
	if !strings.Contains(out, "\tend") {
		t.Fatalf("tab lost: %q", out)
	}
	u := []byte{0xff, 0xfe, 'h', 0, 'i', 0}
	if decodeText(u) != "hi" || decodeText([]byte{'h', 0, 'e', 0, 'l', 0, 'l', 0, 'o', 0}) != "hello" || decodeText([]byte("ok\xff")) != "ok?" {
		t.Fatal("decodeText")
	}
	if tailBytes("héllo", 4) != "llo" {
		t.Fatalf("tailBytes split a rune: %q", tailBytes("héllo", 4))
	}
}
