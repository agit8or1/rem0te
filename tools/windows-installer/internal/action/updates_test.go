package action

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

const (
	cuID  = "11111111-2222-3333-4444-555555555555"
	drvID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
)

func updatePlan(targets ...map[string]any) map[string]any {
	p := basePlan()
	p["action"] = map[string]any{"id": "windows.update.install", "version": 1}
	p["params"] = map[string]any{"reboot": "never", "updates": []any{map[string]any{"updateId": cuID, "revision": 200}, map[string]any{"updateId": drvID, "revision": 1}}}
	p["policy"] = map[string]any{"risk": "high", "approvalsRequired": 2, "customerSignoff": false}
	// A misleading label is signed but changes nothing: the driver stays excluded.
	p["display"] = map[string]any{"updates": []any{map[string]any{"updateId": drvID, "revision": 1, "kb": "KB5044284", "title": "Critical security update", "className": "Security Updates", "severity": "Critical"}}, "deployment": nil}
	signed := now.Add(-time.Minute).Format(time.RFC3339Nano)
	p["approvers"] = []any{
		map[string]any{"userId": "user-approver1", "name": "Olivia", "role": "approver", "credentialSha256": selfSHA, "at": signed},
		map[string]any{"userId": "user-approver2", "name": "Priya", "role": "approver", "credentialSha256": selfSHA, "at": signed},
	}
	if len(targets) > 0 {
		ts := []any{}
		for _, t := range targets {
			ts = append(ts, t)
		}
		p["targets"] = ts
	}
	return p
}

func target(ep, rid, secret string) map[string]any {
	return map[string]any{"endpointId": ep, "businessId": "biz-aaaaaaa", "businessName": "Acme", "hostname": "PC-" + rid[:3],
		"deviceClass": "WORKSTATION", "rustdeskId": rid, "deviceSecretSha256": SecretSHA256(secret)}
}

func (f *fixture) withWUA() (*patch.FakeWUA, *patch.FakeRegistry) {
	w := &patch.FakeWUA{Offered: []patch.Update{
		{UpdateID: cuID, Revision: 200, KB: "KB5044284", Title: "2026-11 Cumulative Update", Classification: patch.ClassSecurity, EulaAccepted: true, RebootBehavior: 1},
		// 0.42: drivers are installable; a feature upgrade never is.
		{UpdateID: drvID, Revision: 1, Title: "Feature update to Windows 11", Classification: patch.ClassUpgrades, EulaAccepted: true},
	}, Results: map[string]patch.FakeResult{cuID + "@200": {ResultCode: 2, RebootRequired: true}}}
	return w, &patch.FakeRegistry{}
}

func (f *fixture) runWith(env []byte, w patch.WUA, reg patch.Registry) Result {
	o := f.opts()
	o.WUA, o.Registry = w, reg
	r, err := Run(job, env, o)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func TestUpdateInstallInstallsEligibleNeverRestarts(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	r := f.runWith(f.envelope(updatePlan(), nil), w, reg)
	expect(t, r, "restart_required", "")
	got := map[string]string{}
	for _, u := range r.Updates {
		got[u.UpdateID] = u.State + ":" + u.Reason
	}
	if got[cuID] != "restart_required:" || got[drvID] != "excluded:excluded_classification" {
		t.Fatalf("%v", got)
	}
	if r.Reboot == nil || !r.Reboot.Pending || r.Observed["rebootPending"] != "true" {
		t.Fatalf("reboot %+v", r.Reboot)
	}
	// Replay: the journal answers; Windows Update is not asked again.
	calls := len(w.Calls)
	r2 := f.runWith(f.envelope(updatePlan(), nil), w, reg)
	if r2.Outcome != "restart_required" || len(w.Calls) != calls {
		t.Fatalf("replay ran again: %v", w.Calls)
	}
}

func TestUpdateInstallNeedsTwoApprovalsEvenOnAWorkstation(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	p := updatePlan()
	p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 1, "customerSignoff": false}
	expect(t, f.runWith(f.envelope(p, nil), w, reg), "refused", "risk_understated")
	p = updatePlan()
	p["approvers"] = p["approvers"].([]any)[:1]
	f = newFixture(t)
	expect(t, f.runWith(f.envelope(p, nil), w, reg), "refused", "too_few_approvals")
	if len(w.Calls) != 0 {
		t.Fatalf("Windows Update was called for a refused plan: %v", w.Calls)
	}
}

func TestUpdateParamsAreClosed(t *testing.T) {
	for name, params := range map[string]map[string]any{
		"reboot allowed":   {"reboot": "if_needed", "updates": []any{map[string]any{"updateId": cuID, "revision": 200}}},
		"url":              {"reboot": "never", "updates": []any{map[string]any{"updateId": cuID, "revision": 200}}, "url": "https://evil/x.msu"},
		"extra field":      {"reboot": "never", "updates": []any{map[string]any{"updateId": cuID, "revision": 200, "path": "C:\\x.msu"}}},
		"kb only":          {"reboot": "never", "updates": []any{map[string]any{"kb": "KB5044284"}}},
		"uppercase guid":   {"reboot": "never", "updates": []any{map[string]any{"updateId": strings.ToUpper(cuID), "revision": 200}}},
		"fraction":         {"reboot": "never", "updates": []any{map[string]any{"updateId": cuID, "revision": 1.5}}},
		"duplicate":        {"reboot": "never", "updates": []any{map[string]any{"updateId": cuID, "revision": 200}, map[string]any{"updateId": cuID, "revision": 200}}},
		"empty":            {"reboot": "never", "updates": []any{}},
		"command as param": {"reboot": "never", "updates": "powershell -c whoami"},
	} {
		if updateParamsOK(params) {
			t.Errorf("%s: accepted", name)
		}
	}
	var many []any
	for i := 0; i < patch.MaxPerPlan+1; i++ {
		many = append(many, map[string]any{"updateId": "00000000-0000-0000-0000-0000000000" + string(rune('a'+i/16)) + string("0123456789abcdef"[i%16]), "revision": 1})
	}
	if updateParamsOK(map[string]any{"reboot": "never", "updates": many}) {
		t.Error("more than MaxPerPlan accepted")
	}
}

// 0.32: a policy plan's "allow" narrows; it is as closed as the rest.
func TestUpdateAllowIsClosedAndOnlyNarrows(t *testing.T) {
	one := []any{map[string]any{"updateId": cuID, "revision": float64(200)}} // as JSON decodes it
	ok := map[string]any{"reboot": "never", "updates": one, "allow": map[string]any{"classifications": []any{patch.ClassSecurity}, "severities": []any{"Critical", "Unrated"}, "excludeKbs": []any{"KB5000001"}}}
	if !updateParamsOK(ok) {
		t.Fatal("a well-formed allow was refused")
	}
	for name, allow := range map[string]any{
		"not an object":         "Security Updates",
		"no classifications":    map[string]any{"severities": []any{"Critical"}},
		"empty classifications": map[string]any{"classifications": []any{}},
		"upgrade class":         map[string]any{"classifications": []any{patch.ClassUpgrades}},
		"feature packs":         map[string]any{"classifications": []any{patch.ClassFeaturePacks}},
		"service packs":         map[string]any{"classifications": []any{patch.ClassServicePacks}},
		"tools":                 map[string]any{"classifications": []any{patch.ClassTools}},
		"unknown class":         map[string]any{"classifications": []any{"00000000-0000-0000-0000-000000000000"}},
		"class by name":         map[string]any{"classifications": []any{"Security Updates"}},
		"duplicate class":       map[string]any{"classifications": []any{patch.ClassSecurity, patch.ClassSecurity}},
		"bad severity":          map[string]any{"classifications": []any{patch.ClassSecurity}, "severities": []any{"Urgent"}},
		"bad kb":                map[string]any{"classifications": []any{patch.ClassSecurity}, "excludeKbs": []any{"5000001"}},
		"extra field":           map[string]any{"classifications": []any{patch.ClassSecurity}, "include": []any{cuID}},
		"script":                map[string]any{"classifications": []any{patch.ClassSecurity}, "script": "whoami"},
	} {
		if updateParamsOK(map[string]any{"reboot": "never", "updates": one, "allow": allow}) {
			t.Errorf("%s: accepted", name)
		}
	}
	// 0.42: a policy may name drivers and definition updates.
	if !updateParamsOK(map[string]any{"reboot": "never", "updates": one, "allow": map[string]any{"classifications": []any{patch.ClassDrivers, patch.ClassDefinitions}}}) {
		t.Error("drivers and definition updates in allow were refused")
	}
	if updateParamsOK(map[string]any{"reboot": "never", "updates": one, "allow": ok["allow"], "extra": 1}) {
		t.Error("a fourth parameter was accepted")
	}
	if updateParamsOK(map[string]any{"reboot": "in_window", "updates": one, "allow": ok["allow"]}) {
		t.Error("a reboot other than never was accepted")
	}
}

// The filter is applied to what Windows Update itself says, not to what the
// plan's display claims: a CU labelled "Updates" by the portal is still a
// security update here, and a "Security" label on an ordinary update does not
// get it past a security-only policy.
func TestPolicyPlanFilterAppliesWindowsUpdatesOwnAnswer(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	ordID := "22222222-3333-4444-5555-666666666666"
	w.Offered = append(w.Offered, patch.Update{UpdateID: ordID, Revision: 4, KB: "KB5044100", Title: ".NET update", Classification: patch.ClassUpdates, EulaAccepted: true})
	p := updatePlan()
	p["params"] = map[string]any{"reboot": "never", "allow": map[string]any{"classifications": []any{patch.ClassSecurity}},
		"updates": []any{map[string]any{"updateId": cuID, "revision": 200}, map[string]any{"updateId": ordID, "revision": 4}}}
	p["display"] = map[string]any{"updates": []any{map[string]any{"updateId": ordID, "revision": 4, "kb": "KB5044100", "title": "Critical security update", "className": "Security Updates", "severity": "Critical"}}, "deployment": nil}
	r := f.runWith(f.envelope(p, nil), w, reg)
	got := map[string]string{}
	for _, u := range r.Updates {
		got[u.UpdateID] = u.State + ":" + u.Reason
	}
	if got[cuID] != "restart_required:" || got[ordID] != "excluded:classification_not_in_policy" {
		t.Fatalf("%v", got)
	}
	for _, id := range w.Installed {
		if id.UpdateID == ordID {
			t.Fatalf("the ordinary update was installed: %v", w.Installed)
		}
	}

	f = newFixture(t)
	w, reg = f.withWUA()
	p = updatePlan()
	p["params"] = map[string]any{"reboot": "never", "allow": map[string]any{"classifications": []any{patch.ClassSecurity}, "excludeKbs": []any{"KB5044284"}},
		"updates": []any{map[string]any{"updateId": cuID, "revision": 200}}}
	r = f.runWith(f.envelope(p, nil), w, reg)
	if r.Outcome != "no_change" || len(r.Updates) != 1 || r.Updates[0].State != "excluded" || r.Updates[0].Reason != "kb_excluded_by_policy" {
		t.Fatalf("excluded KB: %+v", r)
	}
}

func TestRingPlanRunsOnlyOnNamedComputers(t *testing.T) {
	ring := updatePlan(target("ep-aaaaaaaa", "111111111", "s1"), target("ep-bbbbbbbb", "123456789", "device-secret"), target("ep-cccccccc", "333333333", "s3"))
	f := newFixture(t)
	w, reg := f.withWUA()
	expect(t, f.runWith(f.envelope(ring, nil), w, reg), "restart_required", "")

	// Not among the targets.
	f = newFixture(t)
	f.p.rid = "999999999"
	expect(t, f.runWith(f.envelope(ring, nil), w, reg), "refused", "wrong_target")
	// Same RustDesk ID listed with another computer's secret.
	f = newFixture(t)
	other := updatePlan(target("ep-aaaaaaaa", "123456789", "someone-else"))
	expect(t, f.runWith(f.envelope(other, nil), w, reg), "refused", "wrong_target")
	// A computer named twice.
	f = newFixture(t)
	dup := updatePlan(target("ep-aaaaaaaa", "123456789", "device-secret"), target("ep-bbbbbbbb", "123456789", "device-secret"))
	expect(t, f.runWith(f.envelope(dup, nil), w, reg), "refused", "bad_targets")
	// The spooler action stays one computer per plan.
	f = newFixture(t)
	sp := basePlan()
	sp["targets"] = ring["targets"]
	sp["policy"] = map[string]any{"risk": "high", "approvalsRequired": 2, "customerSignoff": false}
	sp["approvers"] = ring["approvers"]
	expect(t, f.run(f.envelope(sp, nil)), "refused", "bad_targets")
	// Too many targets.
	var ts []map[string]any
	for i := 0; i < MaxRingTargets+1; i++ {
		ts = append(ts, target("ep-"+strings.Repeat(string(rune('a'+i%26)), 8)+string(rune('a'+i/26)), "1"+strings.Repeat("0", 7)+string(rune('0'+i%10))+string(rune('0'+i/10)), "x"))
	}
	f = newFixture(t)
	expect(t, f.runWith(f.envelope(updatePlan(ts...), nil), w, reg), "refused", "bad_targets")
}

func TestManagedElsewhereRefusesAfterJournal(t *testing.T) {
	f := newFixture(t)
	w, _ := f.withWUA()
	reg := &patch.FakeRegistry{Services: []string{"CcmExec"}}
	r := f.runWith(f.envelope(updatePlan(), nil), w, reg)
	expect(t, r, "refused", "managed_elsewhere")
	if len(w.Calls) != 0 {
		t.Fatal(w.Calls)
	}
}

func TestInterruptedInstallIsUncertainAndNeverRerun(t *testing.T) {
	f := newFixture(t)
	w, _ := f.withWUA()
	reg := &patch.FakeRegistry{Keys: []string{`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`}}
	o := f.opts()
	os.MkdirAll(filepath.Join(f.dir, "actions", "journal"), 0o700)
	writeJournal(o, journal{JobID: job, State: "executing", At: now.Format(time.RFC3339), ActionID: "windows.update.install", ActionVersion: 1})
	r := f.runWith(f.envelope(updatePlan(), nil), w, reg)
	expect(t, r, "uncertain", "interrupted")
	if r.Observed["rebootPending"] != "true" || r.Observed["rebootSources"] != "component_servicing" || len(w.Calls) != 0 {
		t.Fatalf("%+v %v", r.Observed, w.Calls)
	}
}

func TestInstallCrashIsUncertain(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	w.Fail = "install_crash"
	expect(t, f.runWith(f.envelope(updatePlan(), nil), w, reg), "uncertain", "")
}

func TestScanInProgressMakesInstallWaitThenGiveUp(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	l, err := flock.TryLock(WUALock(f.dir))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()
	o := f.opts()
	o.WUA, o.Registry, o.WUAWait = w, reg, 50*time.Millisecond
	r, _ := Run(job, f.envelope(updatePlan(), nil), o)
	expect(t, r, "failed", "update_agent_busy")
	if len(w.Calls) != 0 {
		t.Fatal(w.Calls)
	}
}

// A second process given the same job while the first still runs it reports
// in_progress and touches nothing — not "uncertain", which the journal alone
// would say.
func TestRedeliveryWhileRunningIsInProgress(t *testing.T) {
	if os.Getenv("ACTION_CHILD_DIR") != "" {
		f := &fixture{t: t, dir: os.Getenv("ACTION_CHILD_DIR")}
		var r Result
		r, _ = Run(job, []byte(`{}`), Options{StateDir: f.dir, Platform: &fakePlatform{}})
		b, _ := json.Marshal(r)
		os.Stdout.Write(b)
		os.Exit(0)
	}
	f := newFixture(t)
	os.MkdirAll(filepath.Join(f.dir, "actions", "locks"), 0o700)
	os.MkdirAll(filepath.Join(f.dir, "actions", "journal"), 0o700)
	l, err := flock.TryLock(filepath.Join(f.dir, "actions", "locks", job+".lock"))
	if err != nil {
		t.Fatal(err)
	}
	writeJournal(f.opts(), journal{JobID: job, State: "executing", At: now.Format(time.RFC3339), ActionID: "windows.update.install", ActionVersion: 1})
	cmd := exec.Command(os.Args[0], "-test.run", "TestRedeliveryWhileRunningIsInProgress")
	cmd.Env = append(os.Environ(), "ACTION_CHILD_DIR="+f.dir)
	out, _ := cmd.Output()
	l.Release()
	if !strings.Contains(string(out), `"outcome":"in_progress"`) {
		t.Fatalf("child: %s", out)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "actions", "results", job+".json")); err == nil {
		t.Fatal("in_progress was reported as a result")
	}
	j, _ := readJournal(f.opts(), job)
	if j.State != "executing" {
		t.Fatal("the running job's journal was changed")
	}
}

// ── The in-window restart rule (0.34) ───────────────────────────────────────

func rebootPlan(rule string, notAfter time.Duration) map[string]any {
	p := updatePlan()
	p["params"].(map[string]any)["reboot"] = rule
	p["window"] = map[string]any{"notBefore": now.Add(-time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(notAfter).Format(time.RFC3339Nano)}
	return p
}

func (f *fixture) runUpdateMaint(env []byte, w patch.WUA, reg patch.Registry, m Maintenance) Result {
	o := f.opts()
	o.WUA, o.Registry, o.Maint = w, reg, m
	r, err := Run(job, env, o)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func TestUpdateRebootRuleIsClosed(t *testing.T) {
	ids := []any{map[string]any{"updateId": cuID, "revision": float64(200)}}
	if !updateParamsOK(map[string]any{"reboot": "if_required_in_window", "updates": ids}) || !updateParamsOK(map[string]any{"reboot": "never", "updates": ids}) {
		t.Fatal("the two rules must be accepted")
	}
	for _, rb := range []any{"always", "if_required", "IF_REQUIRED_IN_WINDOW", "", nil, true, float64(1), map[string]any{"delayMinutes": 0}} {
		if updateParamsOK(map[string]any{"reboot": rb, "updates": ids}) {
			t.Errorf("reboot %v accepted", rb)
		}
	}
	if updateParamsOK(map[string]any{"reboot": "if_required_in_window", "updates": ids, "delayMinutes": float64(5)}) {
		t.Error("a delay was accepted beside the rule")
	}
}

func TestInWindowRestartIsScheduledThroughTheMaintenancePath(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	m := f.withMaint()
	r := f.runUpdateMaint(f.envelope(rebootPlan(RebootInWindow, time.Hour), nil), w, reg, m)
	expect(t, r, "restart_required", "")
	if r.Restart == nil || r.Restart.State != "scheduled" || r.Restart.DelayMinutes != UpdateRestartWarningMinutes {
		t.Fatalf("restart %+v", r.Restart)
	}
	if m.scheduled == nil || m.scheduled.seconds != UpdateRestartWarningMinutes*60 || m.sessCalls != 1 {
		t.Fatalf("scheduled %+v sessions asked %d", m.scheduled, m.sessCalls)
	}
	if !strings.Contains(m.scheduled.msg, "in 15 minutes") || !strings.Contains(m.scheduled.msg, "save your work") || !strings.Contains(m.scheduled.msg, job[:8]) {
		t.Fatalf("not the fixed warning: %q", m.scheduled.msg)
	}
	if want := now.Add(15 * time.Minute).Format(time.RFC3339); r.Restart.ScheduledFor != want || r.Observed["scheduledFor"] != want {
		t.Fatalf("scheduledFor %q, want %q", r.Restart.ScheduledFor, want)
	}
	var rec RebootRecord
	if b, err := os.ReadFile(rebootRecordPath(f.opts())); err != nil || json.Unmarshal(b, &rec) != nil || rec.JobID != job {
		t.Fatal("windows.reboot.cancel would not know this restart")
	}
	// wua.ps1 was never asked to restart anything: only scan modes ran.
	for _, c := range w.Calls {
		if c != "lookup" && c != "install" {
			t.Fatalf("wua mode %q", c)
		}
	}
	r2 := f.runUpdateMaint(f.envelope(rebootPlan(RebootInWindow, time.Hour), nil), w, reg, m)
	if m.scheduleN != 1 || r2.Restart == nil || r2.Restart.State != "scheduled" {
		t.Fatalf("a re-delivered plan scheduled again (%d)", m.scheduleN)
	}
}

func TestNeverMeansNever(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	m := f.withMaint()
	r := f.runUpdateMaint(f.envelope(rebootPlan(RebootNever, time.Hour), nil), w, reg, m)
	expect(t, r, "restart_required", "")
	if r.Restart != nil || m.scheduleN != 0 || m.sessCalls != 0 {
		t.Fatalf("restart %+v scheduled %d", r.Restart, m.scheduleN)
	}
}

func TestInWindowRestartIsDeferred(t *testing.T) {
	for _, c := range []struct {
		name     string
		notAfter time.Duration
		setup    func(w *patch.FakeWUA, m *fakeMaint)
		state    string
		reason   string
		sessions int // how often the session check may run
	}{
		{"session open", time.Hour, func(_ *patch.FakeWUA, m *fakeMaint) { m.sessions = 1 }, "restart_deferred", "remote_session_open", 1},
		{"cannot tell", time.Hour, func(_ *patch.FakeWUA, m *fakeMaint) { m.sessErr = errors.New("Access is denied.") }, "restart_deferred", "session_state_unknown", 1},
		{"window closes first", 14 * time.Minute, nil, "restart_deferred", "window_closed", 0},
		{"already scheduled", time.Hour, func(_ *patch.FakeWUA, m *fakeMaint) {
			m.scheduled = &struct {
				seconds int
				msg     string
			}{60, "someone else"}
		}, "restart_deferred", "restart_already_scheduled", 1},
		{"installer crashed", time.Hour, func(w *patch.FakeWUA, _ *fakeMaint) { w.Fail = "install_crash"; w.RebootRequired = true }, "restart_deferred", "install_uncertain", 0},
		{"no restart needed", time.Hour, func(w *patch.FakeWUA, _ *fakeMaint) { w.Results = nil }, "not_required", "no_restart_pending", 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			w, reg := f.withWUA()
			m := f.withMaint()
			if c.setup != nil {
				c.setup(w, m)
			}
			before := m.scheduleN
			r := f.runUpdateMaint(f.envelope(rebootPlan(RebootInWindow, c.notAfter), nil), w, reg, m)
			if r.Restart == nil || r.Restart.State != c.state || r.Restart.Reason != c.reason {
				t.Fatalf("restart %+v (%s)", r.Restart, r.Detail)
			}
			if c.reason != "restart_already_scheduled" && m.scheduleN != before {
				t.Fatal("scheduled anyway")
			}
			if c.reason == "restart_already_scheduled" && m.scheduled.msg != "someone else" {
				t.Fatal("replaced a pending restart")
			}
			if m.sessCalls != c.sessions {
				t.Fatalf("session checks %d, want %d", m.sessCalls, c.sessions)
			}
		})
	}
	t.Run("nothing installed, an older restart pending", func(t *testing.T) {
		f := newFixture(t)
		w, _ := f.withWUA()
		w.Offered, w.Installed = nil, []patch.Identity{{UpdateID: cuID, Revision: 200}}
		reg := &patch.FakeRegistry{Keys: []string{`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`}}
		m := f.withMaint()
		r := f.runUpdateMaint(f.envelope(rebootPlan(RebootInWindow, time.Hour), nil), w, reg, m)
		if r.Outcome != "no_change" || r.Restart == nil || r.Restart.Reason != "nothing_installed" || m.scheduleN != 0 {
			t.Fatalf("%s restart %+v scheduled %d", r.Outcome, r.Restart, m.scheduleN)
		}
	})
	t.Run("no maintenance surface", func(t *testing.T) {
		f := newFixture(t)
		w, reg := f.withWUA()
		r := f.runWith(f.envelope(rebootPlan(RebootInWindow, time.Hour), nil), w, reg)
		if r.Restart == nil || r.Restart.Reason != "no_maintenance" {
			t.Fatalf("restart %+v", r.Restart)
		}
	})
}

func TestInterruptedInWindowInstallSaysARestartMayBePending(t *testing.T) {
	f := newFixture(t)
	o := f.opts()
	o.Registry = &patch.FakeRegistry{}
	os.MkdirAll(o.dir("journal"), 0o700)
	writeJournal(o, journal{JobID: job, State: "executing", Step: "scheduling_restart", ActionID: "windows.update.install", ActionVersion: 1,
		Params: map[string]any{"reboot": RebootInWindow, "updates": []any{map[string]any{"updateId": cuID, "revision": float64(200)}}}})
	r, _ := Run(job, f.envelope(rebootPlan(RebootInWindow, time.Hour), nil), o)
	if r.Outcome != "uncertain" || !strings.Contains(r.Observed["note"], "restart may have been scheduled") || !strings.Contains(r.Detail, "scheduling_restart") {
		t.Fatalf("%+v", r)
	}
}
