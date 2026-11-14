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

func (p programsAdapter) FileHead(path string, max int) ([]byte, error) {
	return p.r.FileHead(path, max)
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
	if _, r := removalFor("Contoso", Program{QuietUninstallString: `MsiExec.exe /X` + sevenGUID}, Options{}); r == nil || r.Reason != "uninstall_command_refused" {
		t.Fatalf("%+v", r)
	}
	// WindowsInstaller without a GUID key is not taken as MSI.
	if c, r := removalFor("Contoso", Program{WindowsInstaller: true, QuietUninstallString: `"C:\x\un.exe" /S`}, Options{}); r != nil || c.Kind != "quiet" {
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

// ── 0.42: silent forms recognised from an interactive UninstallString ──────

const vlcKey = "VLC media player"

var (
	innoProgram = stub.Program{View: "32", Key: "Mp3tag_is1", DisplayName: "Contoso Inno App 3.1", DisplayVersion: "3.1",
		UninstallString: `"C:\Program Files (x86)\Contoso Inno\unins000.exe"`}
	nsisOnly = stub.Program{View: "64", Key: vlcKey, DisplayName: "VLC media player", DisplayVersion: "3.0.24",
		UninstallString: `"C:\Program Files\VideoLAN\VLC\uninstall.exe"`, NSIS: true}
	chromeProgram = stub.Program{View: "64", Key: "Google Chrome", DisplayName: "Google Chrome", DisplayVersion: "142.0.7444.60",
		UninstallString: `"C:\Program Files\Google\Chrome\Application\142.0.7444.60\Installer\setup.exe" --uninstall --channel=stable --system-level --verbose-logging`}
	msiInteractive = stub.Program{View: "64", Key: "{11111111-2222-3333-4444-555555555555}", DisplayName: "Contoso Runtime",
		UninstallString: "MsiExec.exe /X{11111111-2222-3333-4444-555555555555}"}
	officeProgram = stub.Program{View: "64", Key: "O365HomePremRetail - en-us", DisplayName: "Microsoft 365 - en-us",
		UninstallString: `"C:\Program Files\Common Files\Microsoft Shared\ClickToRun\OfficeClickToRun.exe" scenario=install scenariosubtype=ARP sourcetype=None productstoremove=O365HomePremRetail.16_en-us_x-none culture=en-us version.16=16.0`}
	driverPkg = stub.Program{View: "64", Key: "0123456789ABCDEF0123456789ABCDEF01234567", DisplayName: "Windows Driver Package - Realtek (rt640x64) Net  (10/01/2025 10.77)",
		UninstallString: `C:\PROGRA~1\DIFX\0123456789ABCDEF\DPInst64.exe /u C:\Windows\System32\DriverStore\FileRepository\rt640x64.inf_amd64\rt640x64.inf`}
	rustdesk = stub.Program{View: "64", Key: "RustDesk", DisplayName: "RustDesk", DisplayVersion: "1.4.3",
		UninstallString: `"C:\Program Files\RustDesk\RustDesk.exe" --uninstall`, QuietUninstallString: `"C:\Program Files\RustDesk\RustDesk.exe" --uninstall --silent`}
)

func TestRemoveInnoSetupRunsVerySilent(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{innoProgram}})
	r := s.runRM(rmParams(innoProgram.Key, "32", innoProgram.DisplayName), 0)
	expect(t, r, "succeeded", "")
	want := []stub.Removal{{Kind: "inno", Exe: `C:\Program Files (x86)\Contoso Inno\unins000.exe`, Args: "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"}}
	if st := s.now(); !reflect.DeepEqual(st.Removals, want) || len(st.Programs) != 0 {
		t.Fatalf("removals %+v", st.Removals)
	}
	if r.Observed["method"] != "inno" || r.Observed["program"] != "unins000.exe" {
		t.Fatalf("%+v", r.Observed)
	}
}

func TestRemoveNSISNeedsTheHeaderAndRunsSlashS(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{nsisOnly}})
	r := s.runRM(rmParams(vlcKey, "64", nsisOnly.DisplayName), 0)
	expect(t, r, "succeeded", "")
	if want := []stub.Removal{{Kind: "nsis", Exe: `C:\Program Files\VideoLAN\VLC\uninstall.exe`, Args: "/S"}}; !reflect.DeepEqual(s.now().Removals, want) {
		t.Fatalf("removals %+v", s.now().Removals)
	}
	// The same layout without the NSIS header (WinRAR's own uninstall.exe, say) is not guessed at.
	p := nsisOnly
	p.NSIS = false
	s2 := newRM(t, &stub.State{Programs: []stub.Program{p}})
	expect(t, s2.runRM(rmParams(vlcKey, "64", p.DisplayName), 0), "refused", "no_silent_uninstall")
	if len(s2.now().Removals) != 0 {
		t.Fatal("ran an uninstaller that is not NSIS")
	}
	// An electron-builder NSIS uninstaller registered with /allusers keeps it.
	e := stub.Program{View: "64", Key: "1a2b3c4d-arduino", DisplayName: "Arduino IDE 2.3.6", UninstallString: `"C:\Program Files\Arduino IDE\Uninstall Arduino IDE.exe" /allusers`, NSIS: true}
	s3 := newRM(t, &stub.State{Programs: []stub.Program{e}})
	expect(t, s3.runRM(rmParams(e.Key, "64", e.DisplayName), 0), "succeeded", "")
	if got := s3.now().Removals; len(got) != 1 || got[0].Args != "/allusers /S" {
		t.Fatalf("%+v", got)
	}
	// Mozilla's uninstall\helper.exe is NSIS too.
	m := stub.Program{View: "64", Key: "Mozilla Thunderbird 140.5.0 (x64 en-US)", DisplayName: "Mozilla Thunderbird (x64 en-US)", UninstallString: `"C:\Program Files\Mozilla Thunderbird\uninstall\helper.exe"`, NSIS: true}
	s4 := newRM(t, &stub.State{Programs: []stub.Program{m}})
	expect(t, s4.runRM(rmParams(m.Key, "64", m.DisplayName), 0), "succeeded", "")
}

func TestRemoveChromiumAddsForceUninstall(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{chromeProgram}})
	r := s.runRM(rmParams("Google Chrome", "64", "Google Chrome"), 0)
	expect(t, r, "succeeded", "")
	want := []stub.Removal{{Kind: "chromium", Exe: `C:\Program Files\Google\Chrome\Application\142.0.7444.60\Installer\setup.exe`,
		Args: "--uninstall --channel=stable --system-level --verbose-logging --force-uninstall"}}
	if !reflect.DeepEqual(s.now().Removals, want) {
		t.Fatalf("removals %+v", s.now().Removals)
	}
}

func TestRemoveMsiexecInUninstallStringUsesTheMsiForm(t *testing.T) {
	s := newRM(t, &stub.State{Programs: []stub.Program{msiInteractive}})
	r := s.runRM(rmParams(msiInteractive.Key, "64", msiInteractive.DisplayName), 0)
	expect(t, r, "succeeded", "")
	if want := []stub.Removal{{Kind: "msi", ProductCode: msiInteractive.Key}}; !reflect.DeepEqual(s.now().Removals, want) {
		t.Fatalf("removals %+v", s.now().Removals)
	}
	// /I of a different product than the key's own is refused.
	o := msiInteractive
	o.UninstallString = "MsiExec.exe /I" + sevenGUID
	s2 := newRM(t, &stub.State{Programs: []stub.Program{o}})
	r2 := s2.runRM(rmParams(o.Key, "64", o.DisplayName), 0)
	expect(t, r2, "refused", "no_silent_uninstall")
	if !strings.Contains(r2.Detail, "different Windows Installer product") || len(s2.now().Removals) != 0 {
		t.Fatalf("%s %+v", r2.Detail, s2.now().Removals)
	}
}

func TestRemoveRefusesOfficeDriversAndProtected(t *testing.T) {
	for name, c := range map[string]struct {
		p      stub.Program
		reason string
		detail string
	}{
		"office":       {officeProgram, "no_silent_uninstall", "Click-to-Run"},
		"driver":       {driverPkg, "no_silent_uninstall", "driver package"},
		"rustdesk":     {rustdesk, "protected_program", "RustDesk"},
		"rem0te":       {stub.Program{View: "64", Key: "Rem0te Agent", DisplayName: "Rem0te Agent", QuietUninstallString: `"C:\Program Files\Rem0te\rem0te-agent.exe" uninstall`}, "protected_program", "Rem0te"},
		"rustdesk msi": {stub.Program{View: "64", Key: "{99999999-2222-3333-4444-555555555555}", DisplayName: "RustDesk 1.4.3", WindowsInstaller: true}, "protected_program", "RustDesk"},
	} {
		s := newRM(t, &stub.State{Programs: []stub.Program{c.p}})
		r := s.runRM(rmParams(c.p.Key, c.p.View, c.p.DisplayName), 0)
		expect(t, r, "refused", c.reason)
		if !strings.Contains(r.Detail, c.detail) || len(s.now().Removals) != 0 {
			t.Fatalf("%s: %s %+v", name, r.Detail, s.now().Removals)
		}
	}
}

func TestRecognizeUninstallIsClosed(t *testing.T) {
	head := programsAdapter{stub.Registry{State: filepath.Join(t.TempDir(), "none.json")}}
	for _, c := range []struct {
		key, us string
	}{
		{"App_is1", `"C:\x\unins000.exe" /SILENT`},                   // Inno with registered arguments: not the closed form
		{"App", `"C:\x\unins000.exe"`},                               // Inno exe without an _is1 key
		{"App_is1", `"C:\x\unins0000.exe"`},                          // four digits
		{"App_is1", `"C:\Windows\System32\cmd.exe" /c unins000.exe`}, // NeverRun first
		{"App_is1", `"%ProgramFiles%\x\unins000.exe"`},               // environment variables
		{"Chrome", `"C:\x\Installer\setup.exe" --uninstall`},         // no --system-level
		{"Chrome", `"C:\x\setup.exe" --uninstall --system-level`},    // not in an Installer folder
		{"Chrome", `"C:\x\Installer\setup.exe" --uninstall --system-level --x=$(calc)`},
		{"Chrome", `"C:\x\Installer\setup.exe" --uninstall --system-level --force-uninstall`},
		{"Chrome", `"C:\x\Installer\setup.exe" --uninstall --system-level & calc`},
		{"App", `"C:\x\uninstall.exe" _?=C:\x`}, // NSIS argument outside the closed set
		{"App", `"C:\x\uninstall.exe" /S /D=C:\y`},
		{"App", `"C:\x\app.exe" --uninstall`},
		{"App", `rundll32.exe C:\x\un.dll,Uninstall`},
	} {
		if got, why := RecognizeUninstall(c.key, Program{UninstallString: c.us}, head); why == "" {
			t.Errorf("%s %s: accepted as %+v", c.key, c.us, got)
		}
	}
	// No file reader means no NSIS.
	if _, why := RecognizeUninstall("VLC", Program{UninstallString: `"C:\x\uninstall.exe"`}, nil); why == "" {
		t.Error("NSIS accepted without reading the header")
	}
	for _, n := range []string{"RustDesk", "rustdesk 1.4.3", "Rem0te Agent", "rem0te-tray", "Reboot Remote", "RebootRemote"} {
		if !ProtectedProgram("", n) {
			t.Errorf("%s not protected", n)
		}
	}
	for _, n := range []string{"RustDesker Pro", "Remote Desktop Manager", "TeamViewer", "Rem0teX"} {
		if ProtectedProgram("", n) {
			t.Errorf("%s protected", n)
		}
	}
}
