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

// windows.service.control@1 and windows.process.stop@1 (0.45), against a
// fake service manager and process table. Nothing here is Windows: the SCM
// and OpenProcess/TerminateProcess calls (svcproc_windows.go) have not run
// on a real computer.

type fakeSvc struct {
	ServiceInfo
	stopErr, startErr, configErr error
	ignoresConfig                bool
}

type fakeSCM struct {
	svcs  map[string]*fakeSvc
	procs []ProcessInfo
	calls []string
	// terminate behaviour
	denied   map[uint32]bool
	survives map[uint32]bool
	queryErr error
}

func (f *fakeSCM) get(name string) *fakeSvc {
	for k, v := range f.svcs {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return nil
}
func (f *fakeSCM) Service(name string) (ServiceInfo, bool, error) {
	if f.queryErr != nil {
		return ServiceInfo{}, false, f.queryErr
	}
	v := f.get(name)
	if v == nil {
		return ServiceInfo{}, false, nil
	}
	return v.ServiceInfo, true, nil
}
func (f *fakeSCM) Start(name string, _ time.Duration) error {
	f.calls = append(f.calls, "start "+name)
	v := f.get(name)
	if v.startErr != nil {
		return v.startErr
	}
	if v.StartType == "disabled" {
		return errors.New("disabled")
	}
	v.State = "running"
	return nil
}
func (f *fakeSCM) Stop(name string, _ time.Duration) error {
	f.calls = append(f.calls, "stop "+name)
	v := f.get(name)
	if v.stopErr != nil {
		return v.stopErr
	}
	v.State = "stopped"
	return nil
}
func (f *fakeSCM) SetStartType(name, t string) error {
	f.calls = append(f.calls, "config "+name+" "+t)
	v := f.get(name)
	if v.configErr != nil {
		return v.configErr
	}
	if !v.ignoresConfig {
		v.StartType = t
	}
	return nil
}
func (f *fakeSCM) Processes() ([]ProcessInfo, error) {
	return append([]ProcessInfo(nil), f.procs...), nil
}
func (f *fakeSCM) Terminate(pid uint32, created time.Time, _ time.Duration) error {
	for i, p := range f.procs {
		if p.PID != pid {
			continue
		}
		if !SameCreation(p.Created, created.UTC().Truncate(time.Millisecond)) {
			return ErrProcessChanged
		}
		f.calls = append(f.calls, "terminate "+itoa(int(pid)))
		if f.denied[pid] {
			return errors.New("Access is denied.")
		}
		if !f.survives[pid] {
			f.procs = append(f.procs[:i], f.procs[i+1:]...)
		}
		return nil
	}
	return ErrProcessGone
}

var procT0 = time.Date(2026, 11, 9, 8, 30, 15, 123456700, time.UTC)

func newSCM() *fakeSCM {
	return &fakeSCM{
		svcs: map[string]*fakeSvc{
			"Spooler":   {ServiceInfo: ServiceInfo{Name: "Spooler", DisplayName: "Print Spooler", State: "running", StartType: "automatic"}},
			"Fax":       {ServiceInfo: ServiceInfo{Name: "Fax", DisplayName: "Fax", State: "stopped", StartType: "manual"}},
			"RustDesk":  {ServiceInfo: ServiceInfo{Name: "RustDesk", DisplayName: "RustDesk Service", State: "running", StartType: "automatic"}},
			"wuauserv":  {ServiceInfo: ServiceInfo{Name: "wuauserv", DisplayName: "Windows Update", State: "stopped", StartType: "manual"}},
			"WinDefend": {ServiceInfo: ServiceInfo{Name: "WinDefend", DisplayName: "Microsoft Defender Antivirus Service", State: "running", StartType: "automatic"}},
			"disk":      {ServiceInfo: ServiceInfo{Name: "disk", DisplayName: "Disk Driver", State: "running", StartType: "boot", Driver: true}},
		},
		procs: []ProcessInfo{
			{PID: 4, ParentPID: 0, Name: "System"},
			{PID: 700, ParentPID: 600, Name: "svchost.exe", Created: procT0},
			{PID: 4000, ParentPID: 900, Name: "notepad.exe", Created: procT0},
			{PID: 5000, ParentPID: 900, Name: "chrome.exe", Created: procT0},
			{PID: 5004, ParentPID: 5000, Name: "chrome.exe", Created: procT0.Add(time.Second)},
			{PID: 5008, ParentPID: 5004, Name: "chrome.exe", Created: procT0.Add(2 * time.Second)},
			// Parent id 5000, but created before 5000: an orphan of an earlier 5000.
			{PID: 5012, ParentPID: 5000, Name: "old.exe", Created: procT0.Add(-time.Hour)},
			{PID: 6000, ParentPID: 900, Name: "tool.exe", Created: procT0},
			{PID: 6004, ParentPID: 6000, Name: "rustdesk.exe", Created: procT0.Add(time.Second)},
			{PID: 7000, ParentPID: 900, Name: "rem0te-agent.exe", Created: procT0},
		},
		denied: map[uint32]bool{}, survives: map[uint32]bool{},
	}
}

func (f *fixture) runCtl(id string, params map[string]any, scm *fakeSCM, m Maintenance, mut func(p map[string]any)) Result {
	p := highPlan(id, params)
	if mut != nil {
		mut(p)
	}
	o := f.opts()
	o.Services, o.Processes, o.Maint = scm, scm, m
	o.Checks = []time.Duration{time.Second}
	r, err := Run(job, f.envelope(p, nil), o)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func svcParams(name, display, op, st string) map[string]any {
	p := map[string]any{"service": name, "displayName": display, "op": op}
	if st != "" {
		p["startType"] = st
	}
	return p
}

func TestCatalogIsExactlyTheTwelveActions(t *testing.T) {
	want := []string{"windows.service.start@1", "windows.update.install@1", "windows.service.restart@1", "windows.reboot.schedule@1", "windows.reboot.cancel@1", "windows.logs.collect@1",
		"windows.script.run@1", "windows.software.install@1", "windows.software.uninstall@1", "windows.software.remove@1",
		"windows.service.control@1", "windows.process.stop@1"}
	if got := Supported(); !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog %v", got)
	}
	for _, id := range []string{"windows.service.control", "windows.process.stop"} {
		a := Lookup(id, 1)
		if a.Risk(1, 1) != "high" || a.MaxTargets != 1 || a.Precheck == nil {
			t.Fatalf("%s: risk %s, targets %d", id, a.Risk(1, 1), a.MaxTargets)
		}
	}
}

func TestServiceParamsAreClosed(t *testing.T) {
	ok := []map[string]any{
		svcParams("Spooler", "Print Spooler", "start", ""), svcParams("Spooler", "Print Spooler", "stop", ""), svcParams("Spooler", "Print Spooler", "restart", ""),
		svcParams("Spooler", "Print Spooler", "set_start_type", "automatic_delayed"), svcParams("Spooler", "Print Spooler", "set_start_type", "disabled"),
	}
	for _, p := range ok {
		if !serviceControlParamsOK(p) {
			t.Fatalf("refused %v", p)
		}
	}
	bad := []map[string]any{
		{"service": "Spooler", "displayName": "Print Spooler"},
		svcParams("Spooler", "Print Spooler", "pause", ""),
		svcParams("Spooler", "Print Spooler", "set_start_type", ""),
		svcParams("Spooler", "Print Spooler", "set_start_type", "boot"),
		svcParams("Spooler", "Print Spooler", "start", "manual"), // startType only with set_start_type
		svcParams("Spool er", "Print Spooler", "start", ""),
		svcParams("..\\Spooler", "Print Spooler", "start", ""),
		svcParams("-Spooler", "Print Spooler", "start", ""),
		svcParams("Spooler", "Print \"Spooler\"", "start", ""),
		svcParams("Spooler", " Print Spooler", "start", ""),
		svcParams("Spooler", "", "start", ""),
		{"service": "Spooler", "displayName": "Print Spooler", "op": "start", "binaryPath": "C:\\evil.exe"},
		{"service": "Spooler", "displayName": "Print Spooler", "op": "set_start_type", "startType": "manual", "account": "LocalSystem"},
		{"service": "Spooler", "displayName": "Print Spooler", "op": "set_start_type", "startType": "manual", "password": "x"},
	}
	for _, p := range bad {
		if serviceControlParamsOK(p) {
			t.Fatalf("accepted %v", p)
		}
	}
}

func TestServiceRefusalLists(t *testing.T) {
	cases := []struct {
		name, op, st string
		refused      bool
	}{
		{"WinDefend", "stop", "", true}, {"windefend", "start", "", true}, {"EventLog", "restart", "", true}, {"Schedule", "set_start_type", "manual", true},
		{"Rem0teHeartbeat", "start", "", true}, {"rem0te-anything", "stop", "", true},
		{"RustDesk", "stop", "", true}, {"RustDesk", "set_start_type", "disabled", true}, {"RustDesk", "set_start_type", "manual", true},
		{"RustDesk", "restart", "", false}, {"RustDesk", "start", "", false}, {"RustDesk", "set_start_type", "automatic_delayed", false},
		{"wuauserv", "set_start_type", "disabled", true}, {"wuauserv", "stop", "", false}, {"wuauserv", "set_start_type", "manual", false},
		{"Spooler", "stop", "", false}, {"Spooler", "set_start_type", "disabled", false},
	}
	for _, c := range cases {
		if got := ServiceRefusal(c.name, c.op, c.st) != ""; got != c.refused {
			t.Errorf("%s %s %s: refused %v, want %v", c.name, c.op, c.st, got, c.refused)
		}
	}
}

func TestServiceOpsRunAndVerify(t *testing.T) {
	for _, c := range []struct {
		params           map[string]any
		state, startType string
		calls            []string
	}{
		{svcParams("Spooler", "Print Spooler", "stop", ""), "stopped", "automatic", []string{"stop Spooler"}},
		{svcParams("Fax", "Fax", "start", ""), "running", "manual", []string{"start Fax"}},
		{svcParams("Spooler", "Print Spooler", "restart", ""), "running", "automatic", []string{"stop Spooler", "start Spooler"}},
		{svcParams("Spooler", "Print Spooler", "set_start_type", "automatic_delayed"), "running", "automatic_delayed", []string{"config Spooler automatic_delayed"}},
		{svcParams("Fax", "Fax", "set_start_type", "disabled"), "stopped", "disabled", []string{"config Fax disabled"}},
	} {
		f := newFixture(t)
		scm := newSCM()
		r := f.runCtl("windows.service.control", c.params, scm, &fakeMaint{}, nil)
		expect(t, r, "succeeded", "")
		if r.Observed["state"] != c.state || r.Observed["startType"] != c.startType || !reflect.DeepEqual(scm.calls, c.calls) {
			t.Fatalf("%v: observed %v, calls %v", c.params, r.Observed, scm.calls)
		}
	}
}

func TestServiceNoChange(t *testing.T) {
	for _, p := range []map[string]any{svcParams("Spooler", "Print Spooler", "start", ""), svcParams("Fax", "Fax", "stop", ""), svcParams("Fax", "Fax", "set_start_type", "manual")} {
		f := newFixture(t)
		scm := newSCM()
		r := f.runCtl("windows.service.control", p, scm, nil, nil)
		expect(t, r, "no_change", "")
		if len(scm.calls) != 0 {
			t.Fatalf("calls %v", scm.calls)
		}
	}
}

func TestServiceRefusedOnTheComputer(t *testing.T) {
	for _, c := range []struct {
		params map[string]any
		reason string
	}{
		{svcParams("WinDefend", "Microsoft Defender Antivirus Service", "stop", ""), "protected_service"},
		{svcParams("windefend", "Microsoft Defender Antivirus Service", "stop", ""), "protected_service"},
		{svcParams("RustDesk", "RustDesk Service", "stop", ""), "protected_service"},
		{svcParams("RustDesk", "RustDesk Service", "set_start_type", "disabled"), "protected_service"},
		{svcParams("wuauserv", "Windows Update", "set_start_type", "disabled"), "protected_service"},
		{svcParams("Spooler", "Print Spooler (renamed)", "stop", ""), "service_changed"},
		{svcParams("NotThere", "Not There", "start", ""), "service_not_found"},
		{svcParams("disk", "Disk Driver", "set_start_type", "disabled"), "not_a_service"},
	} {
		f := newFixture(t)
		scm := newSCM()
		r := f.runCtl("windows.service.control", c.params, scm, &fakeMaint{}, nil)
		expect(t, r, "refused", c.reason)
		if len(scm.calls) != 0 {
			t.Fatalf("%v: calls %v", c.params, scm.calls)
		}
		// Refused in Precheck: never journaled as executing first.
		var j journal
		b, _ := os.ReadFile(filepath.Join(f.dir, "actions", "journal", job+".json"))
		if json.Unmarshal(b, &j) != nil || j.State != "done" || j.Step != "" {
			t.Fatalf("journal %s", b)
		}
	}
}

func TestRustDeskRestartWaitsForNoSession(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	r := f.runCtl("windows.service.control", svcParams("RustDesk", "RustDesk Service", "restart", ""), scm, &fakeMaint{sessions: 1}, nil)
	expect(t, r, "not_executed", "remote_session_open")
	f = newFixture(t)
	r = f.runCtl("windows.service.control", svcParams("RustDesk", "RustDesk Service", "restart", ""), scm, &fakeMaint{sessErr: errors.New("Access is denied.")}, nil)
	expect(t, r, "not_executed", "session_state_unknown")
	if len(scm.calls) != 0 {
		t.Fatalf("calls %v", scm.calls)
	}
	f = newFixture(t)
	r = f.runCtl("windows.service.control", svcParams("RustDesk", "RustDesk Service", "restart", ""), scm, &fakeMaint{}, nil)
	expect(t, r, "succeeded", "")
	// Another service's restart does not ask about sessions.
	f = newFixture(t)
	m := &fakeMaint{sessions: 3}
	expect(t, f.runCtl("windows.service.control", svcParams("Spooler", "Print Spooler", "restart", ""), newSCM(), m, nil), "succeeded", "")
	if m.sessCalls != 0 {
		t.Fatal("a Spooler restart asked about RustDesk sessions")
	}
}

func TestServiceFailuresAreReported(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	scm.svcs["Spooler"].stopErr = errors.New("A stop control has been sent to a service that other running services are dependent on.")
	r := f.runCtl("windows.service.control", svcParams("Spooler", "Print Spooler", "stop", ""), scm, nil, nil)
	expect(t, r, "failed", "stop_failed")
	if r.Observed["state"] != "running" || r.Observed["startType"] != "automatic" {
		t.Fatalf("observed %v", r.Observed)
	}
	f = newFixture(t)
	scm = newSCM()
	scm.svcs["Spooler"].ignoresConfig = true
	r = f.runCtl("windows.service.control", svcParams("Spooler", "Print Spooler", "set_start_type", "manual"), scm, nil, nil)
	expect(t, r, "failed", "start_type_not_applied")
	f = newFixture(t)
	scm = newSCM()
	scm.svcs["Fax"].StartType = "disabled"
	r = f.runCtl("windows.service.control", svcParams("Fax", "Fax", "start", ""), scm, nil, nil)
	expect(t, r, "failed", "start_failed")
}

func TestServiceRefusedUnderThePauseBeforePrecheck(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	p := highPlan("windows.service.control", svcParams("Spooler", "Print Spooler", "stop", ""))
	o := f.opts()
	o.Services = scm
	o.Pause = &Pause{Schema: PauseSchema, IssuedAt: "2026-11-10T00:00:00Z", Reason: "incident 9", Actions: PauseScope{Businesses: []string{"biz-aaaaaaa"}}}
	r, _ := Run(job, f.envelope(p, nil), o)
	expect(t, r, "refused", "paused")
	if len(scm.calls) != 0 {
		t.Fatal("the pause did not hold")
	}
}

func TestServiceDirectPlan(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	r := f.runCtl("windows.service.control", svcParams("Spooler", "Print Spooler", "stop", ""), scm, nil, func(p map[string]any) { direct(p, "high") })
	expect(t, r, "succeeded", "")
	f = newFixture(t)
	r = f.runCtl("windows.service.control", svcParams("Spooler", "Print Spooler", "stop", ""), newSCM(), nil, func(p map[string]any) { direct(p, "low") })
	expect(t, r, "refused", "risk_understated")
}

func procParams(pid int, name string, at time.Time, tree *bool) map[string]any {
	p := map[string]any{"pid": float64(pid), "name": name, "startedAt": at.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")}
	if tree != nil {
		p["tree"] = *tree
	}
	return p
}

func TestProcessParamsAreClosed(t *testing.T) {
	yes := true
	if !processStopParamsOK(procParams(4000, "notepad", procT0, nil)) || !processStopParamsOK(procParams(4000, "notepad", procT0, &yes)) {
		t.Fatal("refused a well-formed plan")
	}
	at := procT0.Format("2006-01-02T15:04:05.000Z")
	for _, p := range []map[string]any{
		{"pid": float64(4000), "name": "notepad"},
		{"pid": float64(4000.5), "name": "notepad", "startedAt": at},
		{"pid": float64(0), "name": "notepad", "startedAt": at},
		{"pid": "4000", "name": "notepad", "startedAt": at},
		{"pid": float64(4000), "name": "C:\\Windows\\notepad", "startedAt": at},
		{"pid": float64(4000), "name": "-notepad", "startedAt": at},
		{"pid": float64(4000), "name": "notepad", "startedAt": "2026-11-09T08:30:15Z"},
		{"pid": float64(4000), "name": "notepad", "startedAt": at, "tree": "yes"},
		{"pid": float64(4000), "name": "notepad", "startedAt": at, "commandLine": "taskkill /f"},
	} {
		if processStopParamsOK(p) {
			t.Fatalf("accepted %v", p)
		}
	}
}

func TestEndProcess(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	r := f.runCtl("windows.process.stop", procParams(4000, "notepad", procT0, nil), scm, nil, nil)
	expect(t, r, "succeeded", "")
	if !reflect.DeepEqual(scm.calls, []string{"terminate 4000"}) || r.Observed["stillRunning"] != "false" {
		t.Fatalf("calls %v observed %v", scm.calls, r.Observed)
	}
	// The plan's time is the portal's, truncated to the millisecond.
	if !SameCreation(procT0, procT0.Truncate(time.Millisecond)) || SameCreation(procT0, procT0.Truncate(time.Millisecond).Add(time.Millisecond)) || SameCreation(time.Time{}, time.Time{}) {
		t.Fatal("SameCreation")
	}
}

func TestEndProcessRefusesAReusedPID(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	// Same PID and name, another start time: a different process.
	r := f.runCtl("windows.process.stop", procParams(4000, "notepad", procT0.Add(-time.Minute), nil), scm, nil, nil)
	expect(t, r, "refused", "process_changed")
	// Same PID and time, another name.
	f = newFixture(t)
	r = f.runCtl("windows.process.stop", procParams(4000, "calc", procT0, nil), scm, nil, nil)
	expect(t, r, "refused", "process_changed")
	if len(scm.calls) != 0 {
		t.Fatalf("calls %v", scm.calls)
	}
	// Gone: nothing to do.
	f = newFixture(t)
	r = f.runCtl("windows.process.stop", procParams(9999, "notepad", procT0, nil), scm, nil, nil)
	expect(t, r, "no_change", "not_running")
}

func TestEndProcessProtected(t *testing.T) {
	for _, c := range []struct {
		pid  int
		name string
	}{{700, "svchost"}, {7000, "rem0te-agent"}, {4, "System"}, {4000, "LSASS"}} {
		f := newFixture(t)
		scm := newSCM()
		r := f.runCtl("windows.process.stop", procParams(c.pid, c.name, procT0, nil), scm, nil, nil)
		expect(t, r, "refused", "protected_process")
		if len(scm.calls) != 0 {
			t.Fatalf("%s: calls %v", c.name, scm.calls)
		}
	}
	if !strings.Contains(ProcessRefusal("svchost.exe", 700), "stop the service instead") {
		t.Fatal("svchost does not say to stop the service")
	}
}

func TestEndProcessTree(t *testing.T) {
	yes := true
	f := newFixture(t)
	scm := newSCM()
	r := f.runCtl("windows.process.stop", procParams(5000, "chrome", procT0, &yes), scm, nil, nil)
	expect(t, r, "succeeded", "")
	// Children first, deepest first; the orphan whose parent id was reused is left alone.
	if !reflect.DeepEqual(scm.calls, []string{"terminate 5008", "terminate 5004", "terminate 5000"}) || r.Observed["children"] != "2" {
		t.Fatalf("calls %v observed %v", scm.calls, r.Observed)
	}
	// A protected process in the tree refuses the whole plan.
	f = newFixture(t)
	scm = newSCM()
	r = f.runCtl("windows.process.stop", procParams(6000, "tool", procT0, &yes), scm, nil, nil)
	expect(t, r, "refused", "protected_process")
	if len(scm.calls) != 0 {
		t.Fatalf("calls %v", scm.calls)
	}
	// Without tree, the same process is ended alone.
	f = newFixture(t)
	r = f.runCtl("windows.process.stop", procParams(6000, "tool", procT0, nil), scm, nil, nil)
	expect(t, r, "succeeded", "")
}

func TestEndProcessFailures(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	scm.denied[4000] = true
	expect(t, f.runCtl("windows.process.stop", procParams(4000, "notepad", procT0, nil), scm, nil, nil), "failed", "terminate_failed")
	f = newFixture(t)
	scm = newSCM()
	scm.survives[4000] = true
	expect(t, f.runCtl("windows.process.stop", procParams(4000, "notepad", procT0, nil), scm, nil, nil), "failed", "still_running")
}

func TestEndProcessInterruptedIsNotRerun(t *testing.T) {
	f := newFixture(t)
	scm := newSCM()
	params := procParams(4000, "notepad", procT0, nil)
	if err := os.MkdirAll(filepath.Join(f.dir, "actions", "journal"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = writeJournal(f.opts(), journal{JobID: job, State: "executing", ActionID: "windows.process.stop", ActionVersion: 1, Params: params, Step: "ending"})
	r := f.runCtl("windows.process.stop", params, scm, nil, nil)
	expect(t, r, "uncertain", "interrupted")
	if len(scm.calls) != 0 || r.Observed["stillRunning"] != "true" {
		t.Fatalf("calls %v observed %v", scm.calls, r.Observed)
	}
}
