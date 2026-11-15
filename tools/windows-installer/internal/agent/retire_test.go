package agent_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
)

// fakeTasks is the Windows side of RetireStandard: a task list and the HKLM
// Run key, recording every name it is asked about.
type fakeTasks struct {
	tasks  map[string]bool
	run    map[string]bool
	asked  []string
	delRun []string
}

func (f *fakeTasks) TaskExists(n string) (bool, error) { f.asked = append(f.asked, n); return f.tasks[n], nil }
func (f *fakeTasks) DeleteTask(n string) error         { f.asked = append(f.asked, "delete "+n); delete(f.tasks, n); return nil }
func (f *fakeTasks) DeleteRunValue(n string) (bool, error) {
	f.delRun = append(f.delRun, n)
	had := f.run[n]
	delete(f.run, n)
	return had, nil
}

// The lists are exact names — the ones the standard installer has always
// used — and none of them can match anything else.
func TestRetireNamesAreExact(t *testing.T) {
	if len(agent.StandardTasks) != 1 || agent.StandardTasks[0] != "Rem0teEnrollment" {
		t.Fatalf("StandardTasks = %v", agent.StandardTasks)
	}
	if agent.SharedHeartbeatTask != "Rem0teHeartbeat" {
		t.Fatal("the shared heartbeat task name changed")
	}
	for _, n := range agent.StandardTasks {
		if n == agent.SharedHeartbeatTask {
			t.Fatal("the shared heartbeat task must never be deleted: the signed agent's heartbeat is the same task")
		}
	}
	all := append(append([]string{}, agent.StandardTasks...), agent.StandardFiles...)
	all = append(all, agent.StandardRunValue)
	for _, n := range all {
		if strings.ContainsAny(n, "*?[]%") || n == "" {
			t.Fatalf("%q is a pattern, not a name", n)
		}
	}
	want := []string{"retry-enroll.ps1", "enroll.dat", filepath.Join("tray", "tray.json")}
	if strings.Join(agent.StandardFiles, "|") != strings.Join(want, "|") {
		t.Fatalf("StandardFiles = %v", agent.StandardFiles)
	}
}

func TestRetireStandardRemovesLeftoversAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	p := agent.Paths{InstallDir: filepath.Join(dir, "pf"), StateDir: filepath.Join(dir, "pd")}
	os.MkdirAll(filepath.Join(p.StateDir, "tray"), 0o700)
	for _, f := range []string{"retry-enroll.ps1", "enroll.dat", filepath.Join("tray", "tray.json"), "heartbeat.ps1", "heartbeat.dat", "tray-other.json"} {
		os.WriteFile(filepath.Join(p.StateDir, f), []byte("x"), 0o600)
	}
	ops := &fakeTasks{tasks: map[string]bool{"Rem0teEnrollment": true, "Rem0teHeartbeat": true, "Rem0teEnrollmentX": true}, run: map[string]bool{"Rem0teTray": true, "Rem0teTrayOther": true}}

	r := agent.RetireStandard(p, ops)
	if len(r.Errors) != 0 {
		t.Fatalf("errors: %v", r.Errors)
	}
	if got := strings.Join(r.Removed, "|"); got != "task Rem0teEnrollment|retry-enroll.ps1|enroll.dat|"+filepath.Join("tray", "tray.json")+"|Run value Rem0teTray" {
		t.Fatalf("removed %q", got)
	}
	// Exactly those names were asked about; neighbours survive.
	if !ops.tasks["Rem0teHeartbeat"] || !ops.tasks["Rem0teEnrollmentX"] || !ops.run["Rem0teTrayOther"] {
		t.Fatal("removed something that was not on the list")
	}
	for _, a := range ops.asked {
		if strings.Contains(a, "Rem0teHeartbeat") {
			t.Fatalf("asked about the shared heartbeat task: %v", ops.asked)
		}
	}
	for _, f := range []string{"heartbeat.ps1", "heartbeat.dat", "tray-other.json"} {
		if _, err := os.Stat(filepath.Join(p.StateDir, f)); err != nil {
			t.Fatalf("%s was removed", f)
		}
	}

	// Again: nothing left to do, nothing reported, no error.
	r2 := agent.RetireStandard(p, ops)
	if len(r2.Removed) != 0 || len(r2.Errors) != 0 || r2.Summary() != "" {
		t.Fatalf("second run: %+v", r2)
	}
}

func TestRetireStandardFlagsAStandardHeartbeatAndSkipsNonFiles(t *testing.T) {
	dir := t.TempDir()
	p := agent.Paths{StateDir: dir}
	os.WriteFile(filepath.Join(dir, "heartbeat.ps1"), []byte("x\n"+agent.StandardHeartbeatMarker+"\n"), 0o600)
	os.MkdirAll(filepath.Join(dir, "enroll.dat"), 0o700) // a directory where a file was expected
	r := agent.RetireStandard(p, &fakeTasks{})
	if !r.StandardHeartbeat || !strings.Contains(r.Summary(), "still the standard heartbeat") {
		t.Fatalf("%+v", r)
	}
	if len(r.Errors) != 1 || !strings.Contains(r.Errors[0], "not a regular file") {
		t.Fatalf("errors %v", r.Errors)
	}
	if _, err := os.Stat(filepath.Join(dir, "enroll.dat")); err != nil {
		t.Fatal("a directory was removed")
	}
}

// The signed install retires the standard leftovers after a successful
// installer run, and only then.
type retiringWin struct {
	*fakeWin
	ops      *fakeTasks
	installs int
}

func (r *retiringWin) RetireOps() agent.RetireOps { return r.ops }
func (r *retiringWin) InstallAgent(src, dst string) error {
	r.installs++
	return r.fakeWin.InstallAgent(src, dst)
}
func (r *retiringWin) RunAgent(exe string, args []string) (int, error) {
	r.fakeWin.stage2Ran = true
	r.fakeWin.self = exe
	o := r.fakeWin.opts
	o.Stage2 = true
	return agent.Run(o, r)
}

func TestSignedInstallRetiresStandardAndKeepsAnIdenticalAgent(t *testing.T) {
	_, f, o := setup(t, agent.ModeInstall)
	rw := &retiringWin{fakeWin: f, ops: &fakeTasks{tasks: map[string]bool{"Rem0teEnrollment": true}, run: map[string]bool{}}}
	if code, err := agent.Run(o, rw); err != nil || code != 0 {
		t.Fatalf("install: %d %v", code, err)
	}
	if rw.installs != 1 || rw.ops.tasks["Rem0teEnrollment"] {
		t.Fatalf("installs %d, enrollment task left %v", rw.installs, rw.ops.tasks)
	}
	raw, _ := os.ReadFile(o.Paths.StatusFile())
	if !strings.Contains(string(raw), "removed standard leftovers: task Rem0teEnrollment") {
		t.Fatalf("status %s", raw)
	}

	// An update run by the installed agent: the verified build is the one
	// already installed, so it is not replaced (the tray host keeps running).
	st, _ := os.Stat(o.Paths.AgentExe())
	o2 := o
	o2.Mode, o2.ClaimToken = agent.ModeUpdate, ""
	rw.fakeWin.opts = o2
	rw.fakeWin.self = o.Paths.AgentExe()
	if code, err := agent.Run(o2, rw); err != nil || code != 0 {
		t.Fatalf("update: %d %v", code, err)
	}
	if rw.installs != 1 {
		t.Fatalf("an identical agent was replaced (%d installs)", rw.installs)
	}
	if st2, _ := os.Stat(o.Paths.AgentExe()); !st2.ModTime().Equal(st.ModTime()) {
		t.Fatal("the installed agent's timestamp changed")
	}

	// A failed installer run removes nothing.
	rw.ops.tasks["Rem0teEnrollment"] = true
	rw.fakeWin.exitCode = 5
	if code, _ := agent.Run(o2, rw); code != 5 {
		t.Fatalf("code %d", code)
	}
	if !rw.ops.tasks["Rem0teEnrollment"] {
		t.Fatal("retired after a failed install")
	}
}
