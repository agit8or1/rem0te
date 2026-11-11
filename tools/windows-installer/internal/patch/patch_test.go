package patch

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	idCU  = "11111111-2222-3333-4444-555555555555"
	idDrv = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	idOpt = "99999999-8888-7777-6666-555555555555"
	idOld = "12121212-3434-5656-7878-909090909090"
	idNew = "01010101-0202-0303-0404-050505050505"
)

func cu() Update {
	return Update{UpdateID: idCU, Revision: 200, KB: "KB5044284", Title: "2026-11 Cumulative Update for Windows 11", Classification: ClassSecurity,
		Severity: "Critical", RebootBehavior: 1, EulaAccepted: true, SizeBytes: 900 << 20}
}
func drv() Update {
	return Update{UpdateID: idDrv, Revision: 1, Title: "Intel - Display - 31.0", Classification: ClassDrivers, EulaAccepted: true}
}

func fake() *FakeWUA {
	o := drv()
	opt := cu()
	opt.UpdateID, opt.Revision, opt.BrowseOnly, opt.Classification, opt.KB = idOpt, 1, true, ClassUpdates, "KB5044999"
	return &FakeWUA{Offered: []Update{cu(), o, opt}, Superseded: []Identity{{idOld, 3}}, Installed: []Identity{{idNew, 7}}}
}

func states(r Report) map[string]string {
	m := map[string]string{}
	for _, o := range r.Outcomes {
		m[o.UpdateID] = o.State + ":" + o.Reason
	}
	return m
}

func TestInstallOnlyEligibleApprovedUpdates(t *testing.T) {
	f := fake()
	ids := []Identity{{idCU, 200}, {idDrv, 1}, {idOpt, 1}, {idOld, 3}, {idNew, 7}, {"deadbeef-0000-0000-0000-000000000000", 1}}
	r := Install(f, &FakeRegistry{}, ids)
	if r.Refusal != "" {
		t.Fatal(r.Refusal)
	}
	s := states(r)
	want := map[string]string{
		idCU: "installed:", idDrv: "excluded:excluded_classification", idOpt: "excluded:optional_update",
		idOld: "superseded:a newer update replaces it", idNew: "already_installed:",
		"deadbeef-0000-0000-0000-000000000000": "not_offered:Windows Update does not offer this update to this computer",
	}
	for k, v := range want {
		if s[k] != v {
			t.Errorf("%s: got %q want %q", k, s[k], v)
		}
	}
	// Only the eligible one went to the installer.
	if strings.Join(f.Calls, ",") != "lookup,install" || len(f.Installed) != 2 {
		t.Fatalf("calls %v installed %v", f.Calls, f.Installed)
	}
	if Overall(r) != "succeeded" {
		t.Fatal(Overall(r))
	}
}

func TestEligibility(t *testing.T) {
	for _, c := range []struct {
		mut  func(*Update)
		want string
	}{
		{func(u *Update) {}, ""},
		{func(u *Update) { u.Classification = ClassUpgrades }, "excluded_classification"},
		{func(u *Update) { u.Classification = ClassFeaturePacks }, "excluded_classification"},
		{func(u *Update) { u.Classification = ClassDefinitions }, "excluded_classification"},
		{func(u *Update) { u.Classification = "" }, "excluded_classification"},
		{func(u *Update) { u.UserInput = true }, "needs_user_input"},
		{func(u *Update) { u.EulaAccepted = false }, "eula_required"},
		{func(u *Update) { u.BrowseOnly = true }, "optional_update"},
	} {
		u := cu()
		c.mut(&u)
		_, why := Eligible(u)
		if why != c.want {
			t.Errorf("got %q want %q", why, c.want)
		}
	}
}

func TestCompetingManagersRefuseBeforeAnything(t *testing.T) {
	for name, reg := range map[string]*FakeRegistry{
		"wsus":        {Strings: map[string]string{wuPolicy + "|WUServer": "http://wsus.corp:8530"}, DWords: map[string]uint32{auPolicy + "|UseWUServer": 1}},
		"wufb_policy": {DWords: map[string]uint32{wuPolicy + "|DeferQualityUpdatesPeriodInDays": 7}},
		"mdm_policy":  {Values: []string{mdmPol + "|DeferQualityUpdatesPeriodInDays"}},
		"configmgr":   {Services: []string{"CcmExec"}},
	} {
		f := fake()
		r := Install(f, reg, []Identity{{idCU, 200}})
		if r.Refusal != "managed_elsewhere" || !strings.Contains(r.Detail, name) || len(f.Calls) != 0 {
			t.Errorf("%s: refusal %q detail %q calls %v", name, r.Refusal, r.Detail, f.Calls)
		}
	}
	// A WSUS server named but not in use is not a manager.
	if m := Managers(&FakeRegistry{Strings: map[string]string{wuPolicy + "|WUServer": "http://old"}}); len(m) != 0 {
		t.Fatal(m)
	}
}

func TestRestartRequiredAndReboot(t *testing.T) {
	f := fake()
	f.Results = map[string]FakeResult{Identity{idCU, 200}.Key(): {ResultCode: 2, RebootRequired: true}}
	reg := &FakeRegistry{Keys: []string{`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`}}
	r := Install(f, reg, []Identity{{idCU, 200}})
	if states(r)[idCU] != "restart_required:" || !r.Reboot.Pending || Overall(r) != "restart_required" {
		t.Fatalf("%v %+v %s", states(r), r.Reboot, Overall(r))
	}
	if strings.Join(r.Reboot.Sources, ",") != "update_agent,windows_update" {
		t.Fatal(r.Reboot.Sources)
	}
}

func TestFailuresAndCrash(t *testing.T) {
	f := fake()
	f.Results = map[string]FakeResult{Identity{idCU, 200}.Key(): {ResultCode: 4, HResult: "0x80240022"}}
	r := Install(f, &FakeRegistry{}, []Identity{{idCU, 200}})
	if states(r)[idCU] != "failed:install_failed" || r.Outcomes[0].HResult != "0x80240022" || Overall(r) != "failed" {
		t.Fatalf("%v %s", states(r), Overall(r))
	}
	f = fake()
	f.Results = map[string]FakeResult{Identity{idCU, 200}.Key(): {ResultCode: 3}}
	if r := Install(f, &FakeRegistry{}, []Identity{{idCU, 200}}); states(r)[idCU] != "failed:completed_with_errors" {
		t.Fatal(states(r))
	}
	// The script dying mid-install is "unknown", never "failed": a blind retry
	// of something that may have installed is exactly what must not happen.
	f = fake()
	f.Fail = "install_crash"
	r = Install(f, &FakeRegistry{}, []Identity{{idCU, 200}})
	if !strings.HasPrefix(states(r)[idCU], "unknown:") || Overall(r) != "uncertain" {
		t.Fatalf("%v %s", states(r), Overall(r))
	}
	f = fake()
	f.Fail = "lookup"
	if r := Install(f, &FakeRegistry{}, []Identity{{idCU, 200}}); r.Refusal != "lookup_failed" {
		t.Fatal(r.Refusal)
	}
}

func TestNothingToDo(t *testing.T) {
	r := Install(fake(), &FakeRegistry{}, []Identity{{idNew, 7}, {idOld, 3}})
	if Overall(r) != "no_change" {
		t.Fatal(Overall(r))
	}
}

// A compromised or confused script answering for something it was not asked
// about is an error, not extra data.
func TestParsersRefuseUnaskedAnswers(t *testing.T) {
	asked := []Identity{{idCU, 200}}
	if _, err := ParseLookup([]byte(`{"results":[{"updateId":"`+idDrv+`","revision":1,"state":"installed"}]}`), asked); err == nil {
		t.Fatal("lookup: unasked identity accepted")
	}
	if _, err := ParseInstall([]byte(`{"results":[{"updateId":"`+idDrv+`","revision":1,"downloaded":true,"resultCode":2,"rebootRequired":false,"found":true}],"rebootRequired":false,"error":""}`), asked); err == nil {
		t.Fatal("install: unasked identity accepted")
	}
	if _, err := ParseLookup([]byte(`{"results":[],"extra":1}`), asked); err == nil {
		t.Fatal("unknown field accepted")
	}
	if _, err := ParseLookup([]byte(`{"results":[{"updateId":"`+idCU+`","revision":200,"state":"offered","update":{"updateId":"`+idDrv+`","revision":1,"title":"x","classification":"","downloaded":false,"rebootBehavior":0,"userInput":false,"eulaAccepted":true,"browseOnly":false,"sizeBytes":0}}]}`), asked); err == nil {
		t.Fatal("offered details for a different update accepted")
	}
}

func TestScanSanitizesAndBounds(t *testing.T) {
	f := &FakeWUA{}
	for i := 0; i < 130; i++ {
		u := cu()
		u.Title = "evil\x00\x1b[31m title " + strings.Repeat("x", 400)
		u.KB = "KB12; rm -rf"
		f.Offered = append(f.Offered, u)
	}
	f.Offered = append(f.Offered, Update{UpdateID: "not-a-guid", Revision: 1})
	p := Scan(f, &FakeRegistry{Services: []string{"CcmExec"}}, time.Now())
	if len(p.Updates) != MaxUpdates || len(p.Updates[0].Title) > 300 || strings.ContainsAny(p.Updates[0].Title, "\x00\x1b") || p.Updates[0].KB != "" {
		t.Fatalf("%d %q %q", len(p.Updates), p.Updates[0].Title[:20], p.Updates[0].KB)
	}
	if strings.Join(p.Managers, ",") != "configmgr" || p.Schema != PostureSchema {
		t.Fatal(p.Managers)
	}
	f.Fail = "scan"
	p = Scan(f, &FakeRegistry{Keys: []string{`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`}}, time.Now())
	if p.Error == "" || !p.Reboot.Pending || len(p.Updates) != 0 {
		t.Fatalf("%+v", p)
	}
}

// wua.ps1 must parse, and must never restart, accept a licence or change
// settings. Parsed with pwsh when it is on PATH (CI has it).
func TestScriptParsesAndStaysInBounds(t *testing.T) {
	for _, banned := range []string{"Restart-Computer", "shutdown", "AcceptEula", "Invoke-Expression", "iex ", "Invoke-WebRequest", "DownloadString", "Set-ItemProperty", "New-ItemProperty", "Stop-Service", "Set-Service"} {
		if strings.Contains(strings.ToLower(Script), strings.ToLower(banned)) {
			t.Errorf("wua.ps1 contains %q", banned)
		}
	}
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		if p := os.Getenv("PWSH"); p != "" {
			pwsh = p
		} else {
			t.Skip("pwsh not available")
		}
	}
	f := filepath.Join(t.TempDir(), "wua.ps1")
	os.WriteFile(f, []byte(Script), 0o600)
	out, err := exec.Command(pwsh, "-NoProfile", "-Command", `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('`+f+`',[ref]$null,[ref]$e); if ($e.Count) { $e | % { $_.ToString() }; exit 1 }`).CombinedOutput()
	if err != nil {
		t.Fatalf("wua.ps1 does not parse: %s", out)
	}
}

// 0.32: a signed policy's filter only ever removes updates Eligible allows.
func TestInstallFilteredOnlyNarrows(t *testing.T) {
	ord := cu()
	ord.UpdateID, ord.Revision, ord.Classification, ord.KB, ord.Severity = idOld, 3, ClassUpdates, "KB5044100", ""
	f := &FakeWUA{Offered: []Update{cu(), drv(), ord}}
	ids := []Identity{{idCU, 200}, {idDrv, 1}, {idOld, 3}}
	// A filter naming drivers cannot get a driver past Eligible.
	r := InstallFiltered(f, &FakeRegistry{}, ids, &Filter{Classifications: []string{ClassSecurity, ClassUpdates, ClassDrivers}})
	if s := states(r); s[idDrv] != "excluded:excluded_classification" || s[idCU] != "installed:" || s[idOld] != "installed:" {
		t.Fatalf("%v", s)
	}
	f = &FakeWUA{Offered: []Update{cu(), ord}}
	r = InstallFiltered(f, &FakeRegistry{}, []Identity{{idCU, 200}, {idOld, 3}}, &Filter{Classifications: []string{ClassSecurity, ClassUpdates}, Severities: []string{"Critical"}})
	if s := states(r); s[idCU] != "installed:" || s[idOld] != "excluded:severity_not_in_policy" {
		t.Fatalf("severity: %v", s)
	}
	f = &FakeWUA{Offered: []Update{cu(), ord}}
	r = InstallFiltered(f, &FakeRegistry{}, []Identity{{idCU, 200}, {idOld, 3}}, &Filter{Classifications: []string{ClassSecurity, ClassUpdates}, Severities: []string{"Critical", "Unrated"}, ExcludeKBs: []string{"KB5044284"}})
	if s := states(r); s[idCU] != "excluded:kb_excluded_by_policy" || s[idOld] != "installed:" {
		t.Fatalf("kb / unrated: %v", s)
	}
	var none *Filter
	if ok, _ := none.Allows(drv()); !ok {
		t.Fatal("a nil filter must narrow nothing (Eligible still decides)")
	}
}
