// rem0te-action-sim runs the agent's real action verifier and executor
// (internal/action) against a simulated Windows, for the portal's end-to-end
// test (apps/api/scripts/e2e-approved-action.mjs). The code that decides
// whether an envelope runs is the code the Windows agent ships; only the
// service manager, registry and RustDesk calls are fake.
//
//	rem0te-action-sim -state DIR -keys keys.json -job ID -envelope FILE \
//	    -rustdesk-id 123456789 -secret S -product-type 1 -self-sha HEX \
//	    [-service stopped|running|disabled] [-stops-after N] \
//	    [-wua wua.json] [-registry registry.json]
//	    [-sessions N] [-stop-fails] [-events-dir DIR] [-rustdesk-logs DIR]
//
//	rem0te-action-sim -scan -wua wua.json [-registry registry.json]     posture, as patch-scan writes it
//	rem0te-action-sim -restart -wua wua.json                            what a restart does to pending updates
//	rem0te-action-sim -fire-restart -state DIR -wua wua.json [-registry registry.json]
//	                                                                    the restart DIR has scheduled, if any, happens
//
// -wua is a patch.FakeWUA (offered, installed, superseded, results, fail),
// read before and written back after, so an install changes what the next
// scan sees. -registry is a patch.FakeRegistry (WSUS, Configuration Manager,
// pending-restart keys).
//
// Maintenance (v0.32): -sessions is how many RustDesk sessions are open (-1:
// the agent cannot tell); -stop-fails makes a service stop fail as Windows
// does when dependents are running; -events-dir holds System.txt and
// Application.txt (wevtutil /f:text output) and -rustdesk-logs a RustDesk log
// directory. A scheduled restart is kept in DIR/sim-restart (seconds, then the
// message), so a second schedule finds it and a cancel removes it.
//
// Restarts after updates (0.34): -fire-restart is the scheduled restart's
// delay running out. Only if DIR/sim-restart exists does the simulated
// computer restart (pending restarts clear, in Windows Update and in the
// registry, which is written back) and the file go; otherwise nothing
// changes. It prints {"restarted": true|false}. -clock-offset moves the
// agent's clock (e.g. 7h50m), to run a plan near the end of its window.
//
// It prints the Result as JSON. The state directory carries the journal, so
// running it twice with the same job is a replay, as on a real machine.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

type sim struct {
	stateFile string
	state     string
	stopAfter int
	reads     int
	product   int
	rid, sec  string
	self      string
	started   bool
}

func (s *sim) ServiceState(string) (string, error) {
	if s.started && s.stopAfter > 0 {
		s.reads++
		if s.reads >= s.stopAfter {
			s.state = "stopped"
		}
	}
	return s.state, nil
}

func (s *sim) StartService(string) error {
	if s.state == "disabled" {
		return errors.New("The service cannot be started, either because it is disabled or because it has no enabled devices associated with it.")
	}
	s.started = true
	s.state = "running"
	return nil
}

type simMaint struct {
	s          *sim
	stateDir   string
	sessions   int
	stopFails  bool
	eventsDir  string
	rustdeskLD string
}

func (m *simMaint) StopService(string, time.Duration) error {
	if m.stopFails {
		return errors.New("A stop control has been sent to a service that other running services are dependent on.")
	}
	if m.s.state != "disabled" { // a disabled service is already stopped, and stays disabled
		m.s.state = "stopped"
	}
	return nil
}
func (m *simMaint) restartFile() string { return filepath.Join(m.stateDir, "sim-restart") }
func (m *simMaint) ScheduleRestart(seconds int, message string) error {
	if _, err := os.Stat(m.restartFile()); err == nil {
		return action.ErrRestartScheduled
	}
	return os.WriteFile(m.restartFile(), []byte(fmt.Sprintf("%d\n%s", seconds, message)), 0o600)
}
func (m *simMaint) CancelRestart() error {
	if err := os.Remove(m.restartFile()); err != nil {
		return action.ErrNoRestartScheduled
	}
	return nil
}
func (m *simMaint) RemoteSessions() (int, error) {
	if m.sessions < 0 {
		return 0, errors.New("Access is denied.")
	}
	return m.sessions, nil
}
func (m *simMaint) Events(log string, _ time.Duration, _ int) ([]byte, error) {
	if m.eventsDir == "" {
		return nil, errors.New("wevtutil exit 15007")
	}
	return os.ReadFile(filepath.Join(m.eventsDir, log+".txt"))
}
func (m *simMaint) RustdeskLogDirs() []string {
	if m.rustdeskLD == "" {
		return nil
	}
	return []string{m.rustdeskLD}
}

func (s *sim) ProductType() (int, error)               { return s.product, nil }
func (s *sim) DeviceIdentity() (string, string, error) { return s.rid, action.SecretSHA256(s.sec), nil }
func (s *sim) SelfSHA256() (string, error)             { return s.self, nil }
func (s *sim) Sleep(time.Duration)                     {}

func main() {
	state := flag.String("state", "", "agent state directory (journal and results)")
	keysPath := flag.String("keys", "", "approval/keys.json")
	pausePath := flag.String("pause", "", "control/pause.json (the signed pause), if published")
	job := flag.String("job", "", "job id")
	envPath := flag.String("envelope", "", "envelope JSON file")
	rid := flag.String("rustdesk-id", "", "this machine's RustDesk ID")
	secret := flag.String("secret", "", "this machine's device secret")
	pt := flag.Int("product-type", 1, "1 workstation, 2 domain controller, 3 server")
	self := flag.String("self-sha", "", "sha256 of 'this' agent build")
	svc := flag.String("service", "stopped", "Spooler state before the action: stopped, running, disabled")
	stops := flag.Int("stops-after", 0, "the service stops again after N state reads (0 = stays up)")
	wuaPath := flag.String("wua", "", "simulated Windows Update state (patch.FakeWUA JSON)")
	regPath := flag.String("registry", "", "simulated registry (patch.FakeRegistry JSON)")
	sessions := flag.Int("sessions", 0, "open RustDesk sessions (-1: cannot tell)")
	stopFails := flag.Bool("stop-fails", false, "stopping a service fails (running dependents)")
	eventsDir := flag.String("events-dir", "", "directory with System.txt and Application.txt (wevtutil text)")
	rdLogs := flag.String("rustdesk-logs", "", "a RustDesk service log directory")
	scan := flag.Bool("scan", false, "print this computer's patch posture and exit")
	restart := flag.Bool("restart", false, "simulate a restart (clears pending restarts) and exit")
	fire := flag.Bool("fire-restart", false, "if a restart is scheduled in -state, it happens; then exit")
	offset := flag.Duration("clock-offset", 0, "added to the agent's clock")
	flag.Parse()

	fail := func(err error) {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	var wua *patch.FakeWUA
	reg := &patch.FakeRegistry{}
	if *wuaPath != "" {
		wua = &patch.FakeWUA{}
		if b, err := os.ReadFile(*wuaPath); err == nil {
			if err := json.Unmarshal(b, wua); err != nil {
				fail(err)
			}
		}
	}
	if *regPath != "" {
		b, err := os.ReadFile(*regPath)
		if err != nil {
			fail(err)
		}
		if err := json.Unmarshal(b, reg); err != nil {
			fail(err)
		}
	}
	saveWUA := func() {
		if wua != nil {
			wua.Calls = nil
			b, _ := json.Marshal(wua)
			_ = os.WriteFile(*wuaPath, b, 0o600)
		}
	}
	if *fire {
		if wua == nil || *state == "" {
			fail(errors.New("-fire-restart needs -state and -wua"))
		}
		f := filepath.Join(*state, "sim-restart")
		if _, err := os.Stat(f); err != nil {
			fmt.Println(`{"restarted":false}`)
			return
		}
		wua.Restart()
		reg.Keys = nil
		saveWUA()
		if *regPath != "" {
			b, _ := json.Marshal(reg)
			_ = os.WriteFile(*regPath, b, 0o600)
		}
		_ = os.Remove(f)
		fmt.Println(`{"restarted":true}`)
		return
	}
	if *scan || *restart {
		if wua == nil {
			fail(errors.New("-scan and -restart need -wua"))
		}
		if *restart {
			wua.Restart()
			reg.Keys = nil
			saveWUA()
			return
		}
		out, _ := json.Marshal(patch.Scan(wua, reg, time.Now()))
		fmt.Println(string(out))
		return
	}
	kr, err := os.ReadFile(*keysPath)
	if err != nil {
		fail(err)
	}
	keys, err := action.ParseKeys(kr)
	if err != nil {
		fail(err)
	}
	env, err := os.ReadFile(*envPath)
	if err != nil {
		fail(err)
	}
	if err := os.MkdirAll(*state, 0o700); err != nil {
		fail(err)
	}
	// The simulated service remembers its state between runs, as Windows would.
	sf := filepath.Join(*state, "sim-service")
	cur := *svc
	if b, err := os.ReadFile(sf); err == nil && *svc == "stopped" {
		cur = string(b)
	}
	p := &sim{state: cur, stopAfter: *stops, product: *pt, rid: *rid, sec: *secret, self: *self}
	clock := func() time.Time { return time.Now().Add(*offset) }
	o := action.Options{StateDir: *state, Keys: keys, Platform: p, Now: clock,
		Checks: []time.Duration{time.Millisecond, time.Millisecond}, WUAWait: time.Second,
		Maint: &simMaint{s: p, stateDir: *state, sessions: *sessions, stopFails: *stopFails, eventsDir: *eventsDir, rustdeskLD: *rdLogs}}
	if *pausePath != "" {
		raw, err := os.ReadFile(*pausePath)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		if o.Pause, err = action.ParsePause(raw); err != nil {
			fmt.Fprintln(os.Stderr, "pause:", err)
			os.Exit(2)
		}
	}
	if wua != nil {
		o.WUA, o.Registry = wua, reg
	}
	r, err := action.Run(*job, env, o)
	if err != nil {
		fail(err)
	}
	saveWUA()
	_ = os.WriteFile(sf, []byte(p.state), 0o600)
	out, _ := json.Marshal(r)
	fmt.Println(string(out))
}
