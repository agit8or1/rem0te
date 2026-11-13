package action

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/winget/stub"
)

// Removing an installed program (0.41): windows.software.remove@1 against
// the stub's simulated uninstall registry.

const remove = "windows.software.remove"

type programsAdapter struct{ r stub.Registry }

func (p programsAdapter) Program(view, key string) (Program, bool, error) {
	sp, ok, err := p.r.Program(view, key)
	return Program{DisplayName: sp.DisplayName, DisplayVersion: sp.DisplayVersion, UninstallString: sp.UninstallString,
		QuietUninstallString: sp.QuietUninstallString, WindowsInstaller: sp.WindowsInstaller}, ok, err
}

func (p programsAdapter) Remove(c RemovalCommand, timeout time.Duration) (int, []byte, error) {
	return p.r.Remove(stub.Removal{Kind: c.Kind, ProductCode: c.ProductCode, Exe: c.Exe, Args: c.Args}, timeout)
}

type rmFixture struct {
	*fixture
	state string
}

func newRM(t *testing.T, st *stub.State) *rmFixture {
	f := newFixture(t)
	p := filepath.Join(t.TempDir(), "winget.json")
	if err := st.Save(p); err != nil {
		t.Fatal(err)
	}
	return &rmFixture{fixture: f, state: p}
}

func (s *rmFixture) runRM(params map[string]any, timeout time.Duration) Result {
	o := s.opts()
	o.Programs = programsAdapter{stub.Registry{State: s.state}}
	o.Software = probeAdapter{stub.Probe{State: s.state}}
	o.SoftwareTimeout = timeout
	r, err := Run(job, s.envelope(highPlan(remove, params), nil), o)
	if err != nil {
		s.t.Fatalf("run: %v", err)
	}
	return r
}

func (s *rmFixture) now() *stub.State {
	st, err := stub.Load(s.state)
	if err != nil {
		s.t.Fatal(err)
	}
	return st
}

func rmParams(key, view, name string) map[string]any {
	return map[string]any{"key": key, "view": view, "displayName": name}
}

const sevenGUID = "{23170F69-40C1-2702-2606-000001000000}"

var (
	msiProgram   = stub.Program{View: "64", Key: sevenGUID, DisplayName: "7-Zip 26.06 (x64 edition)", DisplayVersion: "26.06.00.0", UninstallString: "MsiExec.exe /I" + sevenGUID, WindowsInstaller: true}
	nsisProgram  = stub.Program{View: "64", Key: "Notepad++", DisplayName: "Notepad++ (64-bit x64)", DisplayVersion: "8.9.9.1", UninstallString: `"C:\Program Files\Notepad++\uninstall.exe"`, QuietUninstallString: `"C:\Program Files\Notepad++\uninstall.exe" /S`}
	clickProgram = stub.Program{View: "32", Key: "Contoso Clicker", DisplayName: "Contoso Clicker", UninstallString: `"C:\Program Files (x86)\Contoso\unins000.exe"`}
)

func TestRemoveMSIRunsOnlyMsiexecForTheProductCode(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{msiProgram}})
	r := s.runRM(rmParams(sevenGUID, "64", msiProgram.DisplayName), 0)
	expect(t, r, "succeeded", "")
	st := s.now()
	if want := []stub.Removal{{Kind: "msi", ProductCode: sevenGUID}}; !reflect.DeepEqual(st.Removals, want) || len(st.Programs) != 0 {
		t.Fatalf("removals %+v programs %+v", st.Removals, st.Programs)
	}
	if o := r.Observed; o["method"] != "msi" || o["presentBefore"] != "true" || o["presentAfter"] != "false" || o["effective"] != "true" || o["versionBefore"] != "26.06.00.0" {
		t.Fatalf("observed %+v", o)
	}
	if got := MsiArgs(sevenGUID); !reflect.DeepEqual(got, []string{"/x", sevenGUID, "/qn", "/norestart"}) {
		t.Fatalf("msiexec args %q", got)
	}
}

func TestRemoveQuietRunsTheRegisteredQuietCommand(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{nsisProgram}})
	r := s.runRM(rmParams("Notepad++", "64", nsisProgram.DisplayName), 0)
	expect(t, r, "succeeded", "")
	st := s.now()
	if want := []stub.Removal{{Kind: "quiet", Exe: `C:\Program Files\Notepad++\uninstall.exe`, Args: "/S"}}; !reflect.DeepEqual(st.Removals, want) {
		t.Fatalf("removals %+v", st.Removals)
	}
	if r.Observed["program"] != "uninstall.exe" || r.Observed["method"] != "quiet" {
		t.Fatalf("observed %+v", r.Observed)
	}
}

func TestRemoveRefusesAnInteractiveOnlyUninstall(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{clickProgram}})
	r := s.runRM(rmParams("Contoso Clicker", "32", "Contoso Clicker"), 0)
	expect(t, r, "refused", "no_silent_uninstall")
	if len(s.now().Removals) != 0 || !strings.Contains(r.Detail, "interactive") {
		t.Fatalf("ran something: %+v %s", s.now().Removals, r.Detail)
	}
	// Refused in Precheck: final, journaled done, never "executing".
	b, _ := os.ReadFile(filepath.Join(s.dir, "actions", "journal", job+".json"))
	if !strings.Contains(string(b), `"state":"done"`) || strings.Contains(string(b), `"step"`) {
		t.Fatalf("journal %s", b)
	}
}

func TestRemoveRefusesAChangedProgram(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{nsisProgram}})
	r := s.runRM(rmParams("Notepad++", "64", "Notepad++ (32-bit x86)"), 0)
	expect(t, r, "refused", "program_changed")
	if len(s.now().Removals) != 0 || r.Observed["displayNameNow"] != nsisProgram.DisplayName {
		t.Fatalf("ran something or no evidence: %+v %+v", s.now().Removals, r.Observed)
	}
	// The view is part of the identity: the same key in the other view is not it.
	s2 := newRM(t, &stub.State{Programs: []stub.Program{nsisProgram}})
	r2 := s2.runRM(rmParams("Notepad++", "32", nsisProgram.DisplayName), 0)
	expect(t, r2, "no_change", "")
	if len(s2.now().Removals) != 0 {
		t.Fatal("removed from the other view")
	}
}

func TestRemoveAbsentIsANoOp(t *testing.T) {
	s := newRM(t, &stub.State{})
	r := s.runRM(rmParams("Notepad++", "64", "Notepad++ (64-bit x64)"), 0)
	expect(t, r, "no_change", "")
	if r.Observed["presentBefore"] != "false" || len(s.now().Removals) != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestRemoveStillThereIsNotEffective(t *testing.T) {
	p := nsisProgram
	p.NoEffect = true
	s := newRM(t, &stub.State{Programs: []stub.Program{p}})
	r := s.runRM(rmParams("Notepad++", "64", p.DisplayName), 0)
	expect(t, r, "failed", "not_effective")
	if r.Observed["presentAfter"] != "true" || r.Observed["effective"] != "false" {
		t.Fatalf("%+v", r.Observed)
	}
	// A non-zero exit with the key still there is a failure naming the code.
	q := nsisProgram
	q.RemoveExitCode = 2
	s2 := newRM(t, &stub.State{Programs: []stub.Program{q}})
	r2 := s2.runRM(rmParams("Notepad++", "64", q.DisplayName), 0)
	expect(t, r2, "failed", "uninstall_failed")
	if r2.Observed["exitCode"] != "2" {
		t.Fatalf("%+v", r2.Observed)
	}
	// msiexec 3010 with the key still there: a restart finishes it.
	m := msiProgram
	m.RemoveExitCode, m.NoEffect = 3010, true
	s3 := newRM(t, &stub.State{Programs: []stub.Program{m}})
	r3 := s3.runRM(rmParams(sevenGUID, "64", m.DisplayName), 0)
	expect(t, r3, "restart_required", "")
}

func TestRemoveTimeoutIsUncertain(t *testing.T) {
	p := nsisProgram
	p.Hang = true
	s := newRM(t, &stub.State{Programs: []stub.Program{p}})
	r := s.runRM(rmParams("Notepad++", "64", p.DisplayName), 50*time.Millisecond)
	expect(t, r, "uncertain", "timeout")
	if r.Observed["presentNow"] != "true" {
		t.Fatalf("%+v", r.Observed)
	}
}

func TestRemoveRefusedWhenManagedElsewhereOrUnreadable(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{nsisProgram}, Managers: []string{"configmgr"}})
	r := s.runRM(rmParams("Notepad++", "64", nsisProgram.DisplayName), 0)
	expect(t, r, "refused", "managed_elsewhere")
	s2 := newRM(t, &stub.State{Programs: []stub.Program{nsisProgram}, RegistryUnreadable: true})
	r2 := s2.runRM(rmParams("Notepad++", "64", nsisProgram.DisplayName), 0)
	expect(t, r2, "not_executed", "registry_unreadable")
	if len(s.now().Removals)+len(s2.now().Removals) != 0 {
		t.Fatal("ran something")
	}
}

func TestRemoveParamsAreClosed(t *testing.T) {
	ok := rmParams("Notepad++", "64", "Notepad++ (64-bit x64)")
	if !removeParamsOK(ok) {
		t.Fatal("good params refused")
	}
	bad := []map[string]any{
		rmParams(`..\Run`, "64", "x"), rmParams(`Software\Microsoft`, "64", "x"), rmParams("-x", "64", "x"), rmParams("", "64", "x"),
		rmParams("Notepad++", "both", "x"), rmParams("Notepad++", "", "x"), rmParams("Notepad++", "64", ""), rmParams("Notepad++", "64", " padded"),
		rmParams("Notepad++", "64", "a\"b"), rmParams("Notepad++", "64", "a<script>"), rmParams("Notepad++", "64", "line\nbreak"), rmParams("Notepad++", "64", `back\slash`),
		{"key": "Notepad++", "view": "64"}, {"key": "Notepad++", "view": "64", "displayName": "x", "command": "calc.exe"},
		{"key": "Notepad++", "view": 64, "displayName": "x"},
	}
	for _, p := range bad {
		if removeParamsOK(p) {
			t.Fatalf("accepted %+v", p)
		}
	}
	s := newRM(t, &stub.State{Programs: []stub.Program{nsisProgram}})
	r := s.runRM(map[string]any{"key": "Notepad++", "view": "64", "displayName": nsisProgram.DisplayName, "quietUninstallString": "calc.exe"}, 0)
	expect(t, r, "refused", "params_not_allowed")
}

func TestParseQuietUninstall(t *testing.T) {
	good := map[string]RemovalCommand{
		`"C:\Program Files\7-Zip\Uninstall.exe" /S`:                                 {Kind: "quiet", Exe: `C:\Program Files\7-Zip\Uninstall.exe`, Args: "/S"},
		`C:\Tools\unins000.exe /VERYSILENT /SUPPRESSMSGBOXES`:                       {Kind: "quiet", Exe: `C:\Tools\unins000.exe`, Args: "/VERYSILENT /SUPPRESSMSGBOXES"},
		`"C:\Program Files (x86)\App\uninst.exe"`:                                   {Kind: "quiet", Exe: `C:\Program Files (x86)\App\uninst.exe`},
		`MsiExec.exe /X{23170F69-40C1-2702-2606-000001000000} /qn`:                  {Kind: "msi", ProductCode: sevenGUID},
		`C:\Windows\System32\msiexec.exe /x {23170f69-40c1-2702-2606-000001000000}`: {Kind: "msi", ProductCode: sevenGUID},
	}
	for in, want := range good {
		got, err := ParseQuietUninstall(in)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %+v %v", in, got, err)
		}
	}
	bad := []string{
		``, `uninstall.exe /S`, `"C:\Program Files\x\un.exe`, `"C:\x\un.exe"/S`, `C:\Program Files\x\un.exe /S`,
		`cmd.exe /c del C:\x`, `C:\Windows\System32\cmd.exe /c calc`, `"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -c x`,
		`C:\Windows\System32\rundll32.exe x.dll,Uninstall`, `C:\x\un.exe /S & calc`, `C:\x\un.exe /S | more`, `"%ProgramFiles%\x\un.exe" /S`,
		`C:\x\..\Windows\System32\cmd.exe`, `C:\x\un.bat /S`, `\\server\share\un.exe`, `C:/x/un.exe`, `C:\x\un.exe /S` + "\r\n" + `calc`,
		`MsiExec.exe /X{23170F69-40C1-2702-2606-000001000000} TRANSFORMS=x.mst`, `msiexec /i C:\x.msi`, "C:\\x\\un.exe /S\x00",
		`C:\x\un.exe ` + strings.Repeat("a", 1100),
	}
	for _, in := range bad {
		if got, err := ParseQuietUninstall(in); err == nil {
			t.Fatalf("accepted %q as %+v", in, got)
		}
	}
	// A QuietUninstallString that removes another MSI product is refused for this key.
	if _, r := removalFor("Contoso", Program{QuietUninstallString: `MsiExec.exe /X` + sevenGUID}); r == nil || r.Reason != "uninstall_command_refused" {
		t.Fatalf("%+v", r)
	}
	// WindowsInstaller without a GUID key is not taken as MSI.
	if c, r := removalFor("Contoso", Program{WindowsInstaller: true, QuietUninstallString: `"C:\x\un.exe" /S`}); r != nil || c.Kind != "quiet" {
		t.Fatalf("%+v %+v", c, r)
	}
}

func TestRemoveSourceStartsNothing(t *testing.T) {
	src, _ := os.ReadFile("remove.go")
	if strings.Contains(string(src), "os/exec") || strings.Contains(string(src), "exec.Command") {
		t.Fatal("remove.go must not start a process; ProgramRegistry.Remove does, on Windows")
	}
	i, j := strings.Index(string(src), `journalStep(o, p, "removing")`), strings.Index(string(src), `o.Programs.Remove(`)
	if i < 0 || j < i {
		t.Fatal("removing must be journaled before the removal runs")
	}
}
