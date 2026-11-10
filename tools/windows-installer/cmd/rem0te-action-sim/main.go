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
//
//	rem0te-action-sim -scan -wua wua.json [-registry registry.json]     posture, as patch-scan writes it
//	rem0te-action-sim -restart -wua wua.json                            what a restart does to pending updates
//
// -wua is a patch.FakeWUA (offered, installed, superseded, results, fail),
// read before and written back after, so an install changes what the next
// scan sees. -registry is a patch.FakeRegistry (WSUS, Configuration Manager,
// pending-restart keys).
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
	scan := flag.Bool("scan", false, "print this computer's patch posture and exit")
	restart := flag.Bool("restart", false, "simulate a restart (clears pending restarts) and exit")
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
	o := action.Options{StateDir: *state, Keys: keys, Platform: p, Now: time.Now,
		Checks: []time.Duration{time.Millisecond, time.Millisecond}, WUAWait: time.Second}
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
