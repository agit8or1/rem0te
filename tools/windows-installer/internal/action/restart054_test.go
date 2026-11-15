package action

import (
	"errors"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

// 0.54: windows.reboot.schedule's two optional signed flags, onlyIfRequired
// and ignoreRemoteSession, and the update restart's ignoreRemoteSession.

const rebootRequiredKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`

func (f *fixture) runReboot(params map[string]any, m Maintenance, reg patch.Registry) Result {
	o := f.opts()
	o.Maint = m
	if reg != nil {
		o.Registry = reg
	}
	r, err := Run(job, f.envelope(highPlan("windows.reboot.schedule", params), nil), o)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func TestRestartFlagsAreClosed(t *testing.T) {
	ok := []map[string]any{
		{"delayMinutes": float64(15)},
		{"delayMinutes": float64(15), "onlyIfRequired": true},
		{"delayMinutes": float64(15), "ignoreRemoteSession": true},
		{"delayMinutes": float64(15), "onlyIfRequired": true, "ignoreRemoteSession": true},
	}
	for _, p := range ok {
		if RestartDelay(p) != 15 {
			t.Errorf("%v refused", p)
		}
	}
	bad := []map[string]any{
		{"delayMinutes": float64(15), "onlyIfRequired": false},
		{"delayMinutes": float64(15), "ignoreRemoteSession": false},
		{"delayMinutes": float64(15), "ignoreRemoteSession": "true"},
		{"delayMinutes": float64(15), "ignoreRemoteSession": float64(1)},
		{"delayMinutes": float64(15), "onlyIfRequired": nil},
		{"delayMinutes": float64(15), "ignoreSessions": true},
		{"onlyIfRequired": true},
		{"delayMinutes": float64(4), "onlyIfRequired": true},
	}
	for _, p := range bad {
		if RestartDelay(p) != 0 {
			t.Errorf("%v accepted", p)
		}
	}
}

func TestOnlyIfRequiredDecidesFromWindows(t *testing.T) {
	t.Run("not required: nothing scheduled, no session asked", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		r := f.runReboot(map[string]any{"delayMinutes": float64(15), "onlyIfRequired": true}, m, &patch.FakeRegistry{})
		expect(t, r, "no_change", "no_restart_required")
		if m.scheduleN != 0 || m.sessCalls != 0 {
			t.Fatalf("scheduled %d sessions %d", m.scheduleN, m.sessCalls)
		}
	})
	t.Run("required: scheduled", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		r := f.runReboot(map[string]any{"delayMinutes": float64(15), "onlyIfRequired": true}, m, &patch.FakeRegistry{Keys: []string{rebootRequiredKey}})
		expect(t, r, "succeeded", "")
		if m.scheduleN != 1 || m.scheduled.seconds != 900 || m.sessCalls != 1 {
			t.Fatalf("scheduled %d (%+v) sessions %d", m.scheduleN, m.scheduled, m.sessCalls)
		}
	})
	t.Run("cannot read the state: not restarted", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		o := f.opts()
		o.Maint, o.Registry = m, nil
		r, _ := Run(job, f.envelope(highPlan("windows.reboot.schedule", map[string]any{"delayMinutes": float64(15), "onlyIfRequired": true}), nil), o)
		expect(t, r, "not_executed", "reboot_state_unknown")
		if m.scheduleN != 0 {
			t.Fatal("scheduled without knowing")
		}
	})
}

func TestIgnoreRemoteSessionIsTheOnlyWayPastASession(t *testing.T) {
	t.Run("session open, no override: deferred", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		m.sessions = 1
		expect(t, f.runReboot(map[string]any{"delayMinutes": float64(15)}, m, nil), "not_executed", "remote_session_open")
		if m.scheduleN != 0 {
			t.Fatal("scheduled over a session")
		}
	})
	t.Run("session open, signed override: scheduled with the fixed warning, recorded", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		m.sessions = 2
		r := f.runReboot(map[string]any{"delayMinutes": float64(15), "ignoreRemoteSession": true}, m, nil)
		expect(t, r, "succeeded", "")
		if m.scheduleN != 1 || m.scheduled.seconds != 900 || r.Observed["sessionOverride"] != "true" || r.Observed["remoteSessions"] != "2" {
			t.Fatalf("scheduled %d observed %+v", m.scheduleN, r.Observed)
		}
		if want := RestartMessage(now.Add(15*time.Minute).Local(), 15, job); m.scheduled.msg != want {
			t.Fatalf("not the fixed warning: %q", m.scheduled.msg)
		}
	})
	t.Run("cannot tell, signed override: scheduled, sessions unknown", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		m.sessErr = errors.New("Access is denied.")
		r := f.runReboot(map[string]any{"delayMinutes": float64(15), "ignoreRemoteSession": true}, m, nil)
		expect(t, r, "succeeded", "")
		if r.Observed["remoteSessions"] != "unknown" {
			t.Fatalf("observed %+v", r.Observed)
		}
	})
	t.Run("override false is refused, not read as absent", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		expect(t, f.runReboot(map[string]any{"delayMinutes": float64(15), "ignoreRemoteSession": false}, m, nil), "refused", "params_not_allowed")
	})
	t.Run("the override does not skip only-if-required", func(t *testing.T) {
		f := newFixture(t)
		m := f.withMaint()
		m.sessions = 1
		r := f.runReboot(map[string]any{"delayMinutes": float64(15), "onlyIfRequired": true, "ignoreRemoteSession": true}, m, &patch.FakeRegistry{})
		expect(t, r, "no_change", "no_restart_required")
		if m.scheduleN != 0 {
			t.Fatal("restarted although not required")
		}
	})
}

func TestUpdateRestartOverride(t *testing.T) {
	ids := []any{map[string]any{"updateId": cuID, "revision": float64(200)}}
	if !updateParamsOK(map[string]any{"reboot": "if_required_in_window", "updates": ids, "ignoreRemoteSession": true}) {
		t.Fatal("the override beside the in-window rule must be accepted")
	}
	for _, p := range []map[string]any{
		{"reboot": "never", "updates": ids, "ignoreRemoteSession": true},
		{"reboot": "if_required_in_window", "updates": ids, "ignoreRemoteSession": false},
		{"reboot": "if_required_in_window", "updates": ids, "ignoreRemoteSession": "yes"},
	} {
		if updateParamsOK(p) {
			t.Errorf("%v accepted", p)
		}
	}
	f := newFixture(t)
	w, reg := f.withWUA()
	m := f.withMaint()
	m.sessions = 1
	p := rebootPlan(RebootInWindow, time.Hour)
	p["params"].(map[string]any)["ignoreRemoteSession"] = true
	r := f.runUpdateMaint(f.envelope(p, nil), w, reg, m)
	if r.Restart == nil || r.Restart.State != "scheduled" || r.Observed["sessionOverride"] != "true" || r.Observed["remoteSessions"] != "1" {
		t.Fatalf("restart %+v observed %+v", r.Restart, r.Observed)
	}
}
