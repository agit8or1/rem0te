//go:build windows && labwindows

package main

// The Windows lab (0.68.3): the agent's Windows code against the real
// operating system, on a disposable GitHub runner. Built only with
// `-tags labwindows`, and every test skips unless REM0TE_LAB=1, so neither
// `go test ./...` nor a developer's computer ever runs any of it.
//
// What is real and what is not, exactly:
//   - REAL: the service control manager (svcproc_windows.go winServices),
//     the process table and TerminateProcess (winProcesses), the HKLM
//     uninstall keys and the removal's process start (winPrograms), the
//     Windows Update COM scan through wua.ps1 under Windows PowerShell 5.1
//     (winWUA), and internal/action's whole Run: envelope verification, the
//     journal, the precheck and the action itself.
//   - STAND-INS: the approval key is generated here, and the computer's
//     identity (RustDesk ID and device secret) and the agent's own hash are
//     fixed values the plans name. Those are the inputs verify() compares; on
//     a real computer they come from heartbeat.dat, `rustdesk --get-id` and
//     the installed agent. Nothing the action does depends on them.
//
// The test binary doubles as the throwaway programs the tests need: a
// Windows service (--lab-service), a process to end (--lab-sleep), and an
// uninstaller (--lab-uninstall). Each mode is handled in TestMain, before
// any test runs, and touches nothing but what the test set up.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/labevidence"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

// ── Helper modes ─────────────────────────────────────────────────────────────

type labService struct{}

func (labService) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	s <- svc.Status{State: svc.StartPending}
	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			s <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			s <- svc.Status{State: svc.StopPending}
			return false, 0
		}
	}
	return false, 0
}

func TestMain(m *testing.M) {
	if len(os.Args) >= 3 {
		switch os.Args[1] {
		case "--lab-service":
			if err := svc.Run(os.Args[2], labService{}); err != nil {
				os.Exit(2)
			}
			os.Exit(0)
		case "--lab-sleep":
			secs, _ := strconv.Atoi(os.Args[2])
			if len(os.Args) >= 4 && os.Args[3] == "--lab-spawn" {
				self, _ := os.Executable()
				c := exec.Command(self, "--lab-sleep", os.Args[2])
				_ = c.Start()
			}
			time.Sleep(time.Duration(secs) * time.Second)
			os.Exit(0)
		case "--lab-uninstall":
			// The uninstaller a QuietUninstallString names: removes its own
			// uninstall key, as a real uninstaller does last, and nothing else.
			key := os.Args[2]
			if !strings.HasPrefix(key, "LabProbe") {
				os.Exit(3)
			}
			// The key is in the 64-bit view, which is what this 64-bit process sees.
			if err := registry.DeleteKey(registry.LOCAL_MACHINE, uninstallRoot+`\`+key); err != nil {
				os.Exit(4)
			}
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}

// labBinDir holds copies of the test binary under plain names. An absolute
// path with no spaces, so a QuietUninstallString can name it.
const labBinDir = `C:\lab-bin`

func labCopy(t *testing.T, name string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(labBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(labBinDir, name)
	in, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		// Still running from an earlier test: use it as it is.
		if _, serr := os.Stat(dst); serr == nil {
			return dst
		}
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	return dst
}

// ── Signed plans, as the approval signer makes them ─────────────────────────

const (
	labSelf     = "ab0000000000000000000000000000000000000000000000000000000000cdef"
	labRID      = "123456789"
	labSecret   = "lab-device-secret"
	labRequests = "user-requester"
)

type labPlatform struct{ w *winActions }

func (p labPlatform) ServiceState(n string) (string, error) { return p.w.ServiceState(n) }
func (p labPlatform) StartService(n string) error           { return p.w.StartService(n) }
func (p labPlatform) ProductType() (int, error)             { return p.w.ProductType() }
func (p labPlatform) DeviceIdentity() (string, string, error) {
	return labRID, action.SecretSHA256(labSecret), nil
}
func (p labPlatform) SelfSHA256() (string, error) { return labSelf, nil }
func (p labPlatform) Sleep(d time.Duration)       { time.Sleep(d) }

type lab struct {
	t    *testing.T
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	dir  string
}

func newLab(t *testing.T) *lab {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &lab{t: t, pub: pub, priv: priv, dir: t.TempDir()}
}

func jobID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (l *lab) plan(job, id string, params map[string]any) map[string]any {
	now := time.Now().UTC()
	signed := now.Add(-time.Minute).Format(time.RFC3339Nano)
	return map[string]any{
		"schema": action.PlanSchema, "jobId": job,
		"action":   map[string]any{"id": id, "version": 1},
		"artifact": map[string]any{"target": "windows/rem0te-agent.exe", "sha256": labSelf},
		"params":   params,
		"targets": []any{map[string]any{"endpointId": "ep-lab00001", "businessId": "biz-lab0001", "businessName": "Lab", "hostname": "LABRUNNER",
			"deviceClass": "WORKSTATION", "rustdeskId": labRID, "deviceSecretSha256": action.SecretSHA256(labSecret)}},
		"requestedBy": map[string]any{"userId": labRequests, "name": "Lab", "via": "portal"},
		"origin":      map[string]any{"kind": "technician", "ticketRef": nil},
		"reason":      "windows lab",
		"policy":      map[string]any{"risk": "high", "approvalsRequired": 2, "customerSignoff": false},
		"window":      map[string]any{"notBefore": now.Add(-time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(time.Hour).Format(time.RFC3339Nano)},
		"createdAt":   now.Add(-2 * time.Hour).Format(time.RFC3339Nano),
		"approvers": []any{
			map[string]any{"userId": "user-approver1", "name": "Olivia", "role": "approver", "credentialSha256": labSelf, "at": signed},
			map[string]any{"userId": "user-approver2", "name": "Priya", "role": "approver", "credentialSha256": labSelf, "at": signed},
		},
		"signedAt": signed,
	}
}

func (l *lab) envelope(plan map[string]any) []byte {
	pb, _ := json.Marshal(plan)
	sig := ed25519.Sign(l.priv, append([]byte(action.SigningPrefix), pb...))
	b, _ := json.Marshal(map[string]any{"schema": action.EnvelopeSchema, "kid": "k1", "plan": base64.StdEncoding.EncodeToString(pb), "sig": base64.StdEncoding.EncodeToString(sig)})
	return b
}

// revocations: an empty signed statement as new as now, as the Windows agent
// fetches before every job.
func (l *lab) revocations() []byte {
	st := map[string]any{"schema": action.RevocationSchema, "seq": 0, "asOf": time.Now().UTC().Format(time.RFC3339Nano), "scripts": []string{}, "software": []string{}}
	body, _ := json.Marshal(st)
	sig := ed25519.Sign(l.priv, append([]byte(action.RevocationPrefix), body...))
	env, _ := json.Marshal(map[string]any{"schema": action.RevocationEnvelopeSchema, "kid": "k1", "statement": base64.StdEncoding.EncodeToString(body), "sig": base64.StdEncoding.EncodeToString(sig)})
	return env
}

func (l *lab) opts() action.Options {
	return action.Options{
		StateDir: l.dir, Keys: []action.Key{{Kid: "k1", Ed25519: base64.StdEncoding.EncodeToString(l.pub)}},
		Platform: labPlatform{w: &winActions{paths: agent.Paths{StateDir: l.dir}}}, Now: time.Now,
		Checks: []time.Duration{2 * time.Second}, StopTimeout: 30 * time.Second,
		// The real Windows implementations, exactly as cmdAction wires them.
		Services: winServices{}, Processes: winProcesses{}, Programs: winPrograms{}, Software: winSoftware{},
		Registry: winRegistry{},
		Revocations: l.revocations(),
	}
}

func (l *lab) run(id string, params map[string]any) action.Result {
	l.t.Helper()
	job := jobID()
	r, err := action.Run(job, l.envelope(l.plan(job, id, params)), l.opts())
	if err != nil {
		l.t.Fatalf("run: %v", err)
	}
	return r
}

func want(t *testing.T, n *labevidence.Note, r action.Result, outcome, reason string) {
	t.Helper()
	n.Logf("agent answered %s/%s (%s) observed %v", r.Outcome, r.Reason, r.Detail, r.Observed)
	if r.Outcome != outcome || (reason != "" && r.Reason != reason) {
		t.Fatalf("got %s/%s, want %s/%s", r.Outcome, r.Reason, outcome, reason)
	}
}

// ── 1. Service control through the real service control manager ────────────

const (
	labSvcName    = "LabProbeSvc"
	labSvcDisplay = "Lab Probe Service"
)

func scmConfig(t *testing.T, name string) (mgr.Config, svc.State) {
	t.Helper()
	m, err := mgr.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := s.Config()
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.Query()
	if err != nil {
		t.Fatal(err)
	}
	return c, st.State
}

func removeLabService() {
	m, err := mgr.Connect()
	if err != nil {
		return
	}
	defer m.Disconnect()
	s, err := m.OpenService(labSvcName)
	if err != nil {
		return
	}
	_, _ = s.Control(svc.Stop)
	time.Sleep(time.Second)
	_ = s.Delete()
	s.Close()
}

func svcParams(name, display, op, st string) map[string]any {
	p := map[string]any{"service": name, "displayName": display, "op": op}
	if st != "" {
		p["startType"] = st
	}
	return p
}

func TestLabServiceControl(t *testing.T) {
	labevidence.Require(t)
	removeLabService()
	exe := labCopy(t, "labsvc.exe")
	m, err := mgr.Connect()
	if err != nil {
		t.Fatal(err)
	}
	s, err := m.CreateService(labSvcName, exe, mgr.Config{DisplayName: labSvcDisplay, StartType: mgr.StartManual}, "--lab-service", labSvcName)
	if err != nil {
		m.Disconnect()
		t.Fatalf("creating the throwaway service: %v", err)
	}
	s.Close()
	m.Disconnect()
	t.Cleanup(removeLabService)
	before, _ := scmConfig(t, labSvcName)
	l := newLab(t)
	ctl := "windows.service.control"

	step := func(name string, f func(t *testing.T, n *labevidence.Note)) {
		t.Run(name, func(t *testing.T) {
			n := labevidence.Track(t, "agent/service-control/"+name)
			f(t, n)
		})
	}
	state := func(t *testing.T, n *labevidence.Note, wantState svc.State, wantStart uint32, delayed bool) {
		t.Helper()
		c, st := scmConfig(t, labSvcName)
		n.Logf("service manager says: state %s, start type %d, delayed %v", svcState(st), c.StartType, c.DelayedAutoStart)
		if st != wantState || c.StartType != wantStart || c.DelayedAutoStart != delayed {
			t.Fatalf("service manager: state %s start %d delayed %v; want %s %d %v", svcState(st), c.StartType, c.DelayedAutoStart, svcState(wantState), wantStart, delayed)
		}
	}

	step("start", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "start", "")), "succeeded", "")
		state(t, n, svc.Running, mgr.StartManual, false)
	})
	step("start-when-running-is-no-change", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "start", "")), "no_change", "")
	})
	step("restart", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "restart", "")), "succeeded", "")
		state(t, n, svc.Running, mgr.StartManual, false)
	})
	step("stop", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "stop", "")), "succeeded", "")
		state(t, n, svc.Stopped, mgr.StartManual, false)
	})
	step("set-disabled", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "set_start_type", "disabled")), "succeeded", "")
		state(t, n, svc.Stopped, mgr.StartDisabled, false)
	})
	step("start-while-disabled-fails", func(t *testing.T, n *labevidence.Note) {
		// The startup type is never touched by a start: Windows refuses it.
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "start", "")), "failed", "start_failed")
		state(t, n, svc.Stopped, mgr.StartDisabled, false)
	})
	step("set-automatic-delayed", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "set_start_type", "automatic_delayed")), "succeeded", "")
		state(t, n, svc.Stopped, mgr.StartAutomatic, true)
	})
	step("set-automatic-clears-delayed", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "set_start_type", "automatic")), "succeeded", "")
		state(t, n, svc.Stopped, mgr.StartAutomatic, false)
	})
	step("set-manual-changes-only-the-start-type", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, labSvcDisplay, "set_start_type", "manual")), "succeeded", "")
		state(t, n, svc.Stopped, mgr.StartManual, false)
		after, _ := scmConfig(t, labSvcName)
		n.Logf("binary path unchanged %v, account unchanged %v, display name unchanged %v, error control unchanged %v",
			after.BinaryPathName == before.BinaryPathName, after.ServiceStartName == before.ServiceStartName, after.DisplayName == before.DisplayName, after.ErrorControl == before.ErrorControl)
		if after.BinaryPathName != before.BinaryPathName || after.ServiceStartName != before.ServiceStartName || after.DisplayName != before.DisplayName ||
			after.ErrorControl != before.ErrorControl || after.ServiceType != before.ServiceType {
			t.Fatalf("a field other than the start type changed: before %+v after %+v", before, after)
		}
	})
	step("display-name-mismatch-refused", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams(labSvcName, "Some Other Service", "start", "")), "refused", "service_changed")
		state(t, n, svc.Stopped, mgr.StartManual, false)
	})
	step("unknown-service-refused", func(t *testing.T, n *labevidence.Note) {
		want(t, n, l.run(ctl, svcParams("LabNoSuchService", "Nothing", "start", "")), "refused", "service_not_found")
	})
	step("protected-service-refused", func(t *testing.T, n *labevidence.Note) {
		// The event log, under the name Windows uses and in another case.
		_, before := scmConfig(t, "EventLog")
		for _, name := range []string{"EventLog", "eventlog"} {
			want(t, n, l.run(ctl, svcParams(name, "Windows Event Log", "stop", "")), "refused", "protected_service")
		}
		_, after := scmConfig(t, "EventLog")
		n.Logf("EventLog was %s and is %s", svcState(before), svcState(after))
		if after != before {
			t.Fatalf("EventLog changed from %s to %s", svcState(before), svcState(after))
		}
	})
	step("rustdesk-stop-refused-before-any-call", func(t *testing.T, n *labevidence.Note) {
		// No RustDesk here; the refusal comes before the service manager is asked.
		want(t, n, l.run(ctl, svcParams("RustDesk", "RustDesk Service", "stop", "")), "refused", "protected_service")
	})
	step("driver-refused", func(t *testing.T, n *labevidence.Note) {
		for _, name := range []string{"Tcpip", "disk", "volmgr"} {
			info, found, err := winServices{}.Service(name)
			if err != nil || !found {
				continue
			}
			n.Logf("%s: driver %v, start type %s", name, info.Driver, info.StartType)
			want(t, n, l.run(ctl, svcParams(name, strings.TrimSpace(info.DisplayName), "stop", "")), "refused", "not_a_service")
			return
		}
		n.Skip("none of Tcpip, disk or volmgr is registered here")
	})
}

// ── 2. Ending a process through the real process table ─────────────────────

func findProc(t *testing.T, pid uint32) (action.ProcessInfo, bool) {
	t.Helper()
	all, err := winProcesses{}.Processes()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range all {
		if p.PID == pid {
			return p, true
		}
	}
	return action.ProcessInfo{}, false
}

func stamp(c time.Time) string { return c.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z") }

func procParams(p action.ProcessInfo, at time.Time, tree bool) map[string]any {
	m := map[string]any{"pid": float64(p.PID), "name": action.ImageBase(p.Name), "startedAt": stamp(at)}
	if tree {
		m["tree"] = true
	}
	return m
}

func alive(pid uint32, created time.Time) bool {
	all, err := winProcesses{}.Processes()
	if err != nil {
		return true
	}
	for _, p := range all {
		if p.PID == pid && action.SameCreation(p.Created, created.UTC().Truncate(time.Millisecond)) {
			return true
		}
	}
	return false
}

func spawn(t *testing.T, exe string, extra ...string) (*exec.Cmd, action.ProcessInfo) {
	t.Helper()
	c := exec.Command(exe, append([]string{"--lab-sleep", "300"}, extra...)...)
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Process.Kill(); _, _ = c.Process.Wait() })
	p, ok := findProc(t, uint32(c.Process.Pid))
	if !ok || p.Created.IsZero() {
		t.Fatalf("spawned %d but cannot read it back (%+v)", c.Process.Pid, p)
	}
	return c, p
}

func TestLabProcessStop(t *testing.T) {
	labevidence.Require(t)
	exe := labCopy(t, "labchild.exe")
	l := newLab(t)
	stop := "windows.process.stop"
	step := func(name string, f func(t *testing.T, n *labevidence.Note)) {
		t.Run(name, func(t *testing.T) {
			n := labevidence.Track(t, "agent/process-stop/"+name)
			f(t, n)
		})
	}

	step("wrong-creation-time-refused", func(t *testing.T, n *labevidence.Note) {
		_, p := spawn(t, exe)
		n.Logf("child %s pid %d created %s", p.Name, p.PID, stamp(p.Created))
		want(t, n, l.run(stop, procParams(p, p.Created.Add(time.Second), false)), "refused", "process_changed")
		if !alive(p.PID, p.Created) {
			t.Fatal("the process was ended although the plan named another start time")
		}
		n.Logf("still running afterwards: true")
	})
	step("handle-checks-creation-time", func(t *testing.T, n *labevidence.Note) {
		// The PID-reuse guard on the handle itself: Terminate opens the PID and
		// compares the creation time on that handle before it ends anything.
		_, p := spawn(t, exe)
		err := winProcesses{}.Terminate(p.PID, p.Created.Add(-time.Millisecond*5), 5*time.Second)
		n.Logf("Terminate with a creation time 5 ms off: %v", err)
		if !errors.Is(err, action.ErrProcessChanged) {
			t.Fatalf("want ErrProcessChanged, got %v", err)
		}
		if !alive(p.PID, p.Created) {
			t.Fatal("ended anyway")
		}
	})
	var ended action.ProcessInfo
	step("end-with-correct-creation-time", func(t *testing.T, n *labevidence.Note) {
		c, p := spawn(t, exe)
		ended = p
		want(t, n, l.run(stop, procParams(p, p.Created, false)), "succeeded", "")
		done := make(chan error, 1)
		go func() { done <- c.Wait() }()
		select {
		case err := <-done:
			n.Logf("the child's Wait returned: %v", err)
		case <-time.After(10 * time.Second):
			t.Fatal("the child is still running")
		}
		if alive(p.PID, p.Created) {
			t.Fatal("still in the process table")
		}
	})
	step("already-ended-is-no-change", func(t *testing.T, n *labevidence.Note) {
		if ended.PID == 0 {
			n.Skip("the previous step did not run")
		}
		r := l.run(stop, procParams(ended, ended.Created, false))
		n.Logf("agent answered %s/%s", r.Outcome, r.Reason)
		// Windows may already have reused the PID; then it is someone else's
		// process and must be refused, never ended.
		if !(r.Outcome == "no_change" && r.Reason == "not_running") && !(r.Outcome == "refused" && r.Reason == "process_changed") {
			t.Fatalf("got %s/%s", r.Outcome, r.Reason)
		}
	})
	step("tree", func(t *testing.T, n *labevidence.Note) {
		_, parent := spawn(t, exe, "--lab-spawn")
		var child action.ProcessInfo
		for i := 0; i < 50 && child.PID == 0; i++ {
			all, _ := winProcesses{}.Processes()
			for _, q := range all {
				if q.ParentPID == parent.PID && strings.EqualFold(q.Name, "labchild.exe") {
					child = q
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		if child.PID == 0 {
			t.Fatal("the parent started no child")
		}
		t.Cleanup(func() {
			if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, child.PID); err == nil {
				_ = windows.TerminateProcess(h, 1)
				windows.CloseHandle(h)
			}
		})
		n.Logf("parent %d, child %d", parent.PID, child.PID)
		r := l.run(stop, procParams(parent, parent.Created, true))
		want(t, n, r, "succeeded", "")
		if r.Observed["children"] != "1" || r.Observed["childrenEnded"] != "1" {
			t.Fatalf("observed %v", r.Observed)
		}
		time.Sleep(500 * time.Millisecond)
		if alive(parent.PID, parent.Created) || alive(child.PID, child.Created) {
			t.Fatal("part of the tree is still running")
		}
	})
	step("protected-process-refused", func(t *testing.T, n *labevidence.Note) {
		all, err := winProcesses{}.Processes()
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range all {
			if strings.EqualFold(p.Name, "svchost.exe") && !p.Created.IsZero() {
				want(t, n, l.run(stop, procParams(p, p.Created, false)), "refused", "protected_process")
				if !alive(p.PID, p.Created) {
					t.Fatal("svchost ended")
				}
				return
			}
		}
		n.Skip("no svchost.exe whose creation time could be read")
	})
}

// ── 3. Removing a program: the real uninstall keys and the real process start ─

func makeKey(t *testing.T, view uint32, key string, vals map[string]string) {
	t.Helper()
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, uninstallRoot+`\`+key, registry.ALL_ACCESS|view)
	if err != nil {
		t.Fatal(err)
	}
	defer k.Close()
	for n, v := range vals {
		if err := k.SetStringValue(n, v); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = deleteKey(view, key) })
}

func deleteKey(view uint32, key string) error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallRoot, registry.ALL_ACCESS|view)
	if err != nil {
		return err
	}
	defer k.Close()
	return regDeleteKeyEx(k, key, view)
}

var procRegDeleteKeyExW = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegDeleteKeyExW")

// regDeleteKeyEx deletes sub in one registry view (registry.DeleteKey has no
// view argument, so it cannot reach WOW6432Node from a 64-bit process).
func regDeleteKeyEx(parent registry.Key, sub string, view uint32) error {
	p, err := windows.UTF16PtrFromString(sub)
	if err != nil {
		return err
	}
	r, _, _ := procRegDeleteKeyExW.Call(uintptr(parent), uintptr(unsafe.Pointer(p)), uintptr(view), 0)
	if r != 0 {
		return windows.Errno(r)
	}
	return nil
}

func keyExists(view uint32, key string) bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallRoot+`\`+key, registry.QUERY_VALUE|view)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

func rmParams(key, view, name string) map[string]any {
	return map[string]any{"key": key, "view": view, "displayName": name}
}

func TestLabProgramRemove(t *testing.T) {
	labevidence.Require(t)
	l := newLab(t)
	rm := "windows.software.remove"
	step := func(name string, f func(t *testing.T, n *labevidence.Note)) {
		t.Run(name, func(t *testing.T) {
			n := labevidence.Track(t, "agent/program-remove/"+name)
			f(t, n)
		})
	}
	if m := (winSoftware{}).AppManagers(); len(m) > 0 {
		t.Logf("application managers on this runner: %v (every removal will be managed_elsewhere)", m)
	}

	step("quiet-uninstall-string-runs-and-key-goes", func(t *testing.T, n *labevidence.Note) {
		exe := labCopy(t, "labuninst.exe")
		makeKey(t, registry.WOW64_64KEY, "LabProbeQuiet", map[string]string{
			"DisplayName": "Lab Probe Quiet", "DisplayVersion": "1.0",
			"UninstallString":      `"` + exe + `" --lab-uninstall LabProbeQuiet`,
			"QuietUninstallString": `"` + exe + `" --lab-uninstall LabProbeQuiet`,
		})
		r := l.run(rm, rmParams("LabProbeQuiet", "64", "Lab Probe Quiet"))
		want(t, n, r, "succeeded", "")
		if r.Observed["method"] != "quiet" || keyExists(registry.WOW64_64KEY, "LabProbeQuiet") {
			t.Fatalf("method %s, key still there %v", r.Observed["method"], keyExists(registry.WOW64_64KEY, "LabProbeQuiet"))
		}
	})
	step("interpreter-refused-and-not-run", func(t *testing.T, n *labevidence.Note) {
		sys, _ := windows.GetSystemDirectory()
		makeKey(t, registry.WOW64_64KEY, "LabProbeCmd", map[string]string{
			"DisplayName": "Lab Probe Cmd", "QuietUninstallString": filepath.Join(sys, "cmd.exe") + ` /c reg delete HKLM\x /f`,
		})
		want(t, n, l.run(rm, rmParams("LabProbeCmd", "64", "Lab Probe Cmd")), "refused", "uninstall_command_refused")
		if !keyExists(registry.WOW64_64KEY, "LabProbeCmd") {
			t.Fatal("the key went")
		}
	})
	step("display-name-mismatch-refused", func(t *testing.T, n *labevidence.Note) {
		exe := labCopy(t, "labuninst.exe")
		makeKey(t, registry.WOW64_64KEY, "LabProbeRenamed", map[string]string{
			"DisplayName": "Lab Probe Renamed", "QuietUninstallString": `"` + exe + `" --lab-uninstall LabProbeRenamed`,
		})
		want(t, n, l.run(rm, rmParams("LabProbeRenamed", "64", "Lab Probe Original")), "refused", "program_changed")
		if !keyExists(registry.WOW64_64KEY, "LabProbeRenamed") {
			t.Fatal("the uninstaller ran")
		}
	})
	step("protected-program-refused", func(t *testing.T, n *labevidence.Note) {
		exe := labCopy(t, "labuninst.exe")
		makeKey(t, registry.WOW64_64KEY, "LabProbeRD", map[string]string{
			"DisplayName": "RustDesk", "QuietUninstallString": `"` + exe + `" --lab-uninstall LabProbeRD`,
		})
		want(t, n, l.run(rm, rmParams("LabProbeRD", "64", "RustDesk")), "refused", "protected_program")
		if !keyExists(registry.WOW64_64KEY, "LabProbeRD") {
			t.Fatal("the uninstaller ran")
		}
	})
	step("32-bit-view-is-read", func(t *testing.T, n *labevidence.Note) {
		// A key only in WOW6432Node: the 64-bit view must not see it, the
		// 32-bit view must, and a plan naming the wrong view changes nothing.
		makeKey(t, registry.WOW64_32KEY, "LabProbeWow", map[string]string{"DisplayName": "Lab Probe Wow"})
		_, f64, _ := winPrograms{}.Program("64", "LabProbeWow")
		p32, f32, err := winPrograms{}.Program("32", "LabProbeWow")
		n.Logf("64-bit view found %v; 32-bit view found %v (%q, %v)", f64, f32, p32.DisplayName, err)
		if f64 || !f32 || p32.DisplayName != "Lab Probe Wow" {
			t.Fatal("registry views mixed up")
		}
		want(t, n, l.run(rm, rmParams("LabProbeWow", "64", "Lab Probe Wow")), "no_change", "")
		// The 32-bit key registers no uninstaller at all.
		want(t, n, l.run(rm, rmParams("LabProbeWow", "32", "Lab Probe Wow")), "refused", "no_silent_uninstall")
	})
	step("msi", func(t *testing.T, n *labevidence.Note) { labMSI(t, n, l) })
	// A real Inno Setup uninstaller, twice: as Inno registers it (its own
	// QuietUninstallString), and with that value removed, so the agent has to
	// recognise the interactive UninstallString as the Inno form (0.42) and
	// add /VERYSILENT itself.
	step("inno-quiet-uninstall-string", func(t *testing.T, n *labevidence.Note) { labInno(t, n, l, false) })
	step("inno-recognised-form", func(t *testing.T, n *labevidence.Note) { labInno(t, n, l, true) })
}

// labMSI builds a one-file MSI with the WiX Toolset when the runner has it,
// installs it with msiexec, and removes it through the agent.
func labMSI(t *testing.T, n *labevidence.Note, l *lab) {
	dir := t.TempDir()
	product := strings.ToUpper("{" + guid() + "}")
	src := strings.NewReplacer("PRODUCT", product, "UPGRADE", "{"+guid()+"}", "COMPONENT", "{"+guid()+"}")
	if err := os.WriteFile(filepath.Join(dir, "payload.txt"), []byte("lab"), 0o644); err != nil {
		t.Fatal(err)
	}
	msi := filepath.Join(dir, "lab.msi")
	var built string
	if wix, err := exec.LookPath("wix.exe"); err == nil {
		_ = os.WriteFile(filepath.Join(dir, "lab.wxs"), []byte(src.Replace(wxs4)), 0o644)
		out, err := exec.Command(wix, "build", "-arch", "x64", "-o", msi, filepath.Join(dir, "lab.wxs")).CombinedOutput()
		if err != nil {
			t.Fatalf("wix build: %v: %s", err, out)
		}
		built = "WiX v4+ (" + wix + ")"
	} else {
		candle, light := wix3("candle.exe"), wix3("light.exe")
		if candle == "" || light == "" {
			n.Skip("no WiX Toolset on this runner (neither wix.exe nor candle.exe/light.exe), so no MSI can be built without downloading a tool; the msi removal path is not exercised")
		}
		_ = os.WriteFile(filepath.Join(dir, "lab.wxs"), []byte(src.Replace(wxs3)), 0o644)
		obj := filepath.Join(dir, "lab.wixobj")
		if out, err := exec.Command(candle, "-nologo", "-arch", "x64", "-out", obj, filepath.Join(dir, "lab.wxs")).CombinedOutput(); err != nil {
			t.Fatalf("candle: %v: %s", err, out)
		}
		cmd := exec.Command(light, "-nologo", "-sval", "-out", msi, obj)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("light: %v: %s", err, out)
		}
		built = "WiX 3 (" + candle + ")"
	}
	sys, _ := windows.GetSystemDirectory()
	if out, err := exec.Command(filepath.Join(sys, "msiexec.exe"), "/i", msi, "/qn", "/norestart").CombinedOutput(); err != nil {
		t.Fatalf("installing the lab MSI: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command(filepath.Join(sys, "msiexec.exe"), "/x", product, "/qn", "/norestart").Run() })
	if !keyExists(registry.WOW64_64KEY, product) {
		t.Fatalf("the MSI installed but its uninstall key %s is not in the 64-bit view", product)
	}
	n.Logf("built with %s and installed %s", built, product)
	r := l.run("windows.software.remove", rmParams(product, "64", "Lab Probe Package"))
	want(t, n, r, "succeeded", "")
	if r.Observed["method"] != "msi" || keyExists(registry.WOW64_64KEY, product) {
		t.Fatalf("method %s; key still there %v", r.Observed["method"], keyExists(registry.WOW64_64KEY, product))
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("ProgramFiles"), "LabProbePackage", "payload.txt")); err == nil {
		t.Fatal("the installed file is still there")
	}
}

// labInno builds a one-file Inno Setup installer with the runner's ISCC,
// installs it silently, and removes it through the agent.
func labInno(t *testing.T, n *labevidence.Note, l *lab, recognised bool) {
	iscc := ""
	for _, p := range []string{os.Getenv("ProgramFiles(x86)") + `\Inno Setup 6\ISCC.exe`, os.Getenv("ProgramFiles") + `\Inno Setup 6\ISCC.exe`} {
		if fileExists(p) {
			iscc = p
		}
	}
	if iscc == "" {
		if p, err := exec.LookPath("iscc.exe"); err == nil {
			iscc = p
		}
	}
	if iscc == "" {
		n.Skip("no Inno Setup compiler (ISCC.exe) on this runner")
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "payload.txt"), []byte("lab"), 0o644)
	iss := "[Setup]\r\nAppId=LabProbeInno\r\nAppName=Lab Probe Inno\r\nAppVersion=1.0\r\nAppVerName=Lab Probe Inno\r\nDefaultDirName={autopf}\\LabProbeInno\r\n" +
		"OutputDir=" + dir + "\r\nOutputBaseFilename=labinno\r\nPrivilegesRequired=admin\r\nArchitecturesAllowed=x64compatible\r\n" +
		"ArchitecturesInstallIn64BitMode=x64compatible\r\nDisableProgramGroupPage=yes\r\nDisableDirPage=yes\r\n\r\n[Files]\r\nSource: \"payload.txt\"; DestDir: \"{app}\"\r\n"
	_ = os.WriteFile(filepath.Join(dir, "lab.iss"), []byte(iss), 0o644)
	cmd := exec.Command(iscc, "/Q", filepath.Join(dir, "lab.iss"))
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ISCC: %v: %s", err, out)
	}
	setup := filepath.Join(dir, "labinno.exe")
	if out, err := exec.Command(setup, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART").CombinedOutput(); err != nil {
		t.Fatalf("installing: %v: %s", err, out)
	}
	key := "LabProbeInno_is1"
	if !keyExists(registry.WOW64_64KEY, key) {
		t.Fatal("the Inno installer registered no 64-bit uninstall key " + key)
	}
	t.Cleanup(func() { _ = deleteKey(registry.WOW64_64KEY, key) })
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallRoot+`\`+key, registry.ALL_ACCESS|registry.WOW64_64KEY)
	if err != nil {
		t.Fatal(err)
	}
	dn, _, _ := k.GetStringValue("DisplayName")
	us, _, _ := k.GetStringValue("UninstallString")
	qs, _, _ := k.GetStringValue("QuietUninstallString")
	n.Logf("installed; DisplayName %q, UninstallString %q, QuietUninstallString %q", dn, us, qs)
	if recognised {
		if err := k.DeleteValue("QuietUninstallString"); err != nil && !errors.Is(err, registry.ErrNotExist) {
			k.Close()
			t.Fatal(err)
		}
	}
	k.Close()
	app := filepath.Join(os.Getenv("ProgramFiles"), "LabProbeInno", "payload.txt")
	r := l.run("windows.software.remove", rmParams(key, "64", strings.TrimSpace(dn)))
	want(t, n, r, "succeeded", "")
	wantMethod := "quiet"
	if recognised {
		wantMethod = "inno"
	}
	if r.Observed["method"] != wantMethod || keyExists(registry.WOW64_64KEY, key) {
		t.Fatalf("method %s (want %s); key still there %v", r.Observed["method"], wantMethod, keyExists(registry.WOW64_64KEY, key))
	}
	if fileExists(app) {
		t.Fatal("the installed file is still there")
	}
}

func wix3(exe string) string {
	if p, err := exec.LookPath(exe); err == nil {
		return p
	}
	for _, root := range []string{os.Getenv("WIX"), `C:\Program Files (x86)\WiX Toolset v3.14`, `C:\Program Files (x86)\WiX Toolset v3.11`} {
		if root == "" {
			continue
		}
		if p := filepath.Join(root, "bin", exe); fileExists(p) {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool { st, err := os.Stat(p); return err == nil && st.Mode().IsRegular() }

func guid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

const wxs3 = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="PRODUCT" Name="Lab Probe Package" Language="1033" Version="1.0.0" Manufacturer="Rem0te Lab" UpgradeCode="UPGRADE">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="x64" />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="LabProbePackage">
          <Component Id="Payload" Guid="COMPONENT" Win64="yes">
            <File Id="PayloadFile" Source="payload.txt" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="Main" Level="1"><ComponentRef Id="Payload" /></Feature>
  </Product>
</Wix>
`

const wxs4 = `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Lab Probe Package" Language="1033" Version="1.0.0" Manufacturer="Rem0te Lab" UpgradeCode="UPGRADE" ProductCode="PRODUCT" Scope="perMachine">
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="LabProbePackage">
        <Component Id="Payload" Guid="COMPONENT">
          <File Id="PayloadFile" Source="payload.txt" KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
    <Feature Id="Main"><ComponentRef Id="Payload" /></Feature>
  </Package>
</Wix>
`

// ── 4. The Windows Update scan, read-only, offline ──────────────────────────

// wuBlockScript keeps Windows Update off the network for the rest of the
// job. The decisive part is policy: Windows Update is pointed at a WSUS
// server on 127.0.0.1:8530, where nothing listens, and told never to reach
// Windows Update's internet locations; automatic updates are off. Around
// that: Windows Firewall on, outbound blocked for the update services by
// service SID, and the update host names resolving to 127.0.0.1. Lab setup,
// never agent behaviour. It prints the number of block rules it made.
//
// The firewall rules and hosts entries alone were not enough: with them in
// place, and wuauserv stopped and disabled, a scan still returned an update
// (an earlier run of this lab, recorded in the 0.68.3 changelog).
const wuBlockScript = `$ErrorActionPreference = 'Stop'
Set-NetFirewallProfile -All -Enabled True
foreach ($s in 'wuauserv','BITS','DoSvc','UsoSvc','WaaSMedicSvc') {
  New-NetFirewallRule -DisplayName "lab: block $s outbound" -Direction Outbound -Action Block -Service $s -Program "$env:SystemRoot\System32\svchost.exe" | Out-Null
}
$names = 'update.microsoft.com','fe2.update.microsoft.com','fe3.delivery.mp.microsoft.com','fe3cr.delivery.mp.microsoft.com','sls.update.microsoft.com','slscr.update.microsoft.com','windowsupdate.microsoft.com','download.windowsupdate.com','ctldl.windowsupdate.com','dl.delivery.mp.microsoft.com','tsfe.trafficshaping.dsp.mp.microsoft.com','emdl.ws.microsoft.com'
$nl = [Environment]::NewLine
Add-Content -LiteralPath "$env:SystemRoot\System32\drivers\etc\hosts" -Value ($nl + '# rem0te lab: Windows Update' + $nl + (($names | ForEach-Object { "127.0.0.1 $_" }) -join $nl)) -Encoding ASCII
Clear-DnsClientCache
$wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
New-Item -Path "$wu\AU" -Force | Out-Null
Set-ItemProperty -Path $wu -Name WUServer -Value 'http://127.0.0.1:8530'
Set-ItemProperty -Path $wu -Name WUStatusServer -Value 'http://127.0.0.1:8530'
Set-ItemProperty -Path $wu -Name DoNotConnectToWindowsUpdateInternetLocations -Value 1 -Type DWord
Set-ItemProperty -Path "$wu\AU" -Name UseWUServer -Value 1 -Type DWord
Set-ItemProperty -Path "$wu\AU" -Name NoAutoUpdate -Value 1 -Type DWord
@(Get-NetFirewallRule -DisplayName 'lab: block * outbound').Count
`

func TestLabWindowsUpdateScan(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/windows-update/scan-offline")
	// The lab never contacts anything but GitHub and localhost, and an online
	// scan asks Microsoft Update. Two earlier versions of this test reached an
	// update source anyway (the 0.68.3 changelog): stopping and disabling
	// wuauserv did not hold — Windows had it running again, start type
	// Manual, by the end of the scan — and service-SID firewall rules with
	// hosts entries did not stop a scan returning an update. So Windows Update
	// is now pointed at a WSUS server on localhost by policy (wuBlockScript),
	// where nothing answers. The service is still stopped and disabled first
	// (directly through the service manager: the agent itself never disables
	// it), to record what Windows does with that. The scan then exercises the
	// agent's real path — wua.ps1 under Windows PowerShell 5.1, the Windows
	// Update Agent COM API, the policy read, the result file and its parser —
	// up to Windows Update's own failure. It proves the path runs and fails
	// cleanly, not that an online scan returns the right updates.
	info, found, err := winServices{}.Service("wuauserv")
	if err != nil || !found {
		n.Skip(fmt.Sprintf("no Windows Update service here (%v)", err))
	}
	n.Logf("wuauserv before: %s, %s", info.State, info.StartType)
	sys, _ := windows.GetSystemDirectory()
	ps := filepath.Join(sys, "WindowsPowerShell", "v1.0", "powershell.exe")
	out, err := exec.Command(ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wuBlockScript).CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "5" {
		t.Fatalf("could not close the network to Windows Update, so the scan is not run: %v: %s", err, out)
	}
	n.Logf("Windows Update pointed by policy at a WSUS on 127.0.0.1:8530 that does not exist; its services blocked outbound by Windows Firewall; update hosts pointed at 127.0.0.1")
	if err := (winServices{}).Stop("wuauserv", 60*time.Second); err != nil {
		t.Fatalf("stopping wuauserv: %v", err)
	}
	if err := (winServices{}).SetStartType("wuauserv", "disabled"); err != nil {
		t.Fatalf("disabling wuauserv: %v", err)
	}
	mid, _, _ := winServices{}.Service("wuauserv")
	n.Logf("wuauserv after stop and disable: %s, %s", mid.State, mid.StartType)
	// Not t.TempDir(): on the runner that is under C:\Users\RUNNER~1, and
	// wua.ps1 refuses an output path with a "~" in it (exit 64) before it
	// touches COM. The agent's own state directory is C:\ProgramData\Rem0te.
	dir := `C:\lab-state\wua`
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Second)
	pre, _, _ := winServices{}.Service("wuauserv")
	n.Logf("wuauserv 3 s later, as the scan starts: %s, %s", pre.State, pre.StartType)
	done := make(chan patch.Posture, 1)
	start := time.Now()
	go func() { done <- patch.Scan(winWUA{paths: agent.Paths{StateDir: dir}}, winRegistry{}, time.Now()) }()
	var p patch.Posture
	select {
	case p = <-done:
	case <-time.After(10 * time.Minute):
		t.Fatal("the scan did not return within 10 minutes")
	}
	now, _, _ := winServices{}.Service("wuauserv")
	n.Logf("scan returned in %s: schema %s, %d updates, %d history, managers %v, autoUpdate %s, reboot pending %v %v, error %q; wuauserv after: %s, %s",
		time.Since(start).Round(time.Millisecond), p.Schema, len(p.Updates), len(p.History), p.Managers, p.AutoUpdate, p.Reboot.Pending, p.Reboot.Sources, p.Error, now.State, now.StartType)
	if p.Schema != patch.PostureSchema {
		t.Fatalf("schema %q", p.Schema)
	}
	if _, err := time.Parse(time.RFC3339, p.ScannedAt); err != nil {
		t.Fatalf("scannedAt %q", p.ScannedAt)
	}
	if p.Updates == nil || p.History == nil {
		t.Fatal("nil lists in the posture")
	}
	if strings.Contains(p.Error, "exit status 64") {
		// wua.ps1's own input check: it never reached Windows Update.
		t.Fatalf("wua.ps1 refused its inputs; the scan path was not exercised: %s", p.Error)
	}
	if !strings.Contains(strings.Join(p.Managers, ","), "wsus") {
		t.Fatalf("the WSUS policy was not read as a manager: %v", p.Managers)
	}
	if pre.StartType == "disabled" && now.StartType != "disabled" {
		n.Logf("finding: Windows changed wuauserv from disabled to %s (and %s) during a read-only scan", now.StartType, now.State)
	}
	if len(p.Updates) != 0 {
		t.Fatalf("%d updates offered with Windows Update blocked: the scan reached an update source", len(p.Updates))
	}
	if p.Error == "" {
		t.Fatal("the scan reported success with Windows Update blocked")
	}
	if b, err := json.Marshal(p); err != nil || len(b) == 0 {
		t.Fatalf("the posture does not serialise: %v", err)
	}
}
