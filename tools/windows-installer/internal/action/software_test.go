package action

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/winget/stub"
)

// The test binary doubles as the stub winget: the agent's real exec path
// (internal/winget.Runner) re-runs it with REM0TE_WINGET_STUB set.
func TestMain(m *testing.M) {
	if os.Getenv(stub.EnvVar) != "" {
		os.Exit(stub.Main(os.Args[1:]))
	}
	os.Exit(m.Run())
}

type probeAdapter struct{ stub.Probe }

func (p probeAdapter) UninstallEntries() ([]UninstallEntry, error) {
	es, err := p.Entries()
	out := make([]UninstallEntry, 0, len(es))
	for _, e := range es {
		out = append(out, UninstallEntry{Key: e.Key, DisplayName: e.DisplayName, DisplayVersion: e.DisplayVersion})
	}
	return out, err
}

const installerBytes = "MZ 7-Zip 24.08 x64 installer stand-in"

func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

type swFixture struct {
	*fixture
	state string
}

func newSW(t *testing.T, st *stub.State) *swFixture {
	f := newFixture(t)
	p := filepath.Join(t.TempDir(), "winget.json")
	if st.Packages == nil {
		st.Packages = map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, DisplayName: "7-Zip 24.08 (x64)", DisplayVersion: "24.08", UninstallKey: "7-Zip", File: `ProgramFiles|7-Zip\7z.exe`}}
	}
	if err := st.Save(p); err != nil {
		t.Fatal(err)
	}
	return &swFixture{fixture: f, state: p}
}

func (s *swFixture) runSW(env []byte, timeout time.Duration) Result {
	o := s.opts()
	self, _ := os.Executable()
	o.Winget = stub.New(self, s.state)
	o.Software = probeAdapter{stub.Probe{State: s.state}}
	o.SoftwareTimeout = timeout
	r, err := Run(job, env, o)
	if err != nil {
		s.t.Fatalf("run: %v", err)
	}
	return r
}

func (s *swFixture) calls() []string {
	var out []string
	for _, c := range stub.Calls(s.state) {
		if len(c) > 0 {
			out = append(out, c[0])
		}
	}
	return out
}

func swParams(over map[string]any) map[string]any {
	p := map[string]any{
		"packageId": "7zip.7zip", "version": "24.08", "installerSha256": sha(installerBytes), "scope": "machine",
		"detection": map[string]any{"kind": "display_name", "name": "7-Zip", "match": "prefix", "compare": "gte", "version": "24.08"},
	}
	for k, v := range over {
		if v == nil {
			delete(p, k)
		} else {
			p[k] = v
		}
	}
	return p
}

func swPlan(id string, params map[string]any) map[string]any { return highPlan(id, params) }

const install, uninstall = "windows.software.install", "windows.software.uninstall"

var banned = []string{"--ignore-security-hash", "--force", "--override", "--custom", "--location", "--manifest", "-h", "--header", "--rainbow"}

func TestSoftwareInstallSucceeds(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200"})
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r, "succeeded", "")
	o := r.Observed
	if o["wingetVersion"] != "v1.9.25200" || o["detectedBefore"] != "absent" || o["detectedAfter"] != "installed" || o["versionAfter"] != "24.08" ||
		o["installerSha256"] != sha(installerBytes) || o["effective"] != "true" || o["exitCode"] != "0x00000000" || o["packageId"] != "7zip.7zip" {
		t.Fatalf("observed %+v", o)
	}
	calls := stub.Calls(s.state)
	var dl, in []string
	for _, c := range calls {
		switch c[0] {
		case "download":
			dl = c
		case "install":
			in = c
		}
	}
	dir := filepath.Join(s.dir, "actions", "software", job)
	wantDL := []string{"download", "--id", "7zip.7zip", "--version", "24.08", "--exact", "--source", "winget", "--scope", "machine", "--skip-dependencies",
		"--download-directory", dir, "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"}
	wantIn := []string{"install", "--id", "7zip.7zip", "--version", "24.08", "--exact", "--source", "winget", "--silent", "--scope", "machine", "--skip-dependencies",
		"--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"}
	if !reflect.DeepEqual(dl, wantDL) || !reflect.DeepEqual(in, wantIn) {
		t.Fatalf("argv:\n download %q\n install  %q", dl, in)
	}
	for _, c := range calls {
		for _, a := range c {
			for _, b := range banned {
				if a == b {
					t.Fatalf("banned flag %s in %q", b, c)
				}
			}
		}
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("the download directory was not removed")
	}
	// Replayed: answered from the journal, winget not asked again.
	n := len(stub.Calls(s.state))
	again := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	if again.Outcome != "succeeded" || len(stub.Calls(s.state)) != n {
		t.Fatalf("replay ran winget: %+v", again)
	}
}

func TestSoftwareAlreadyInstalledIsANoOp(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200", Installed: []stub.Entry{{Key: "7-Zip", DisplayName: "7-Zip 24.09 (x64)", DisplayVersion: "24.09", PackageID: "7zip.7zip"}}})
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r, "no_change", "")
	if c := s.calls(); !reflect.DeepEqual(c, []string{"--version"}) || r.Observed["detectedBefore"] != "installed" || r.Observed["versionBefore"] != "24.09" {
		t.Fatalf("calls %v observed %+v", c, r.Observed)
	}
	// An older version present is "outdated", and the install goes ahead.
	s2 := newSW(t, &stub.State{Version: "v1.9.25200", Installed: []stub.Entry{{Key: "7-Zip", DisplayName: "7-Zip 23.01 (x64)", DisplayVersion: "23.01"}}})
	r2 := s2.runSW(s2.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r2, "succeeded", "")
	if r2.Observed["detectedBefore"] != "outdated" {
		t.Fatalf("observed %+v", r2.Observed)
	}
}

func TestSoftwareJournalsBeforeDownloading(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200"})
	s.runSW(s.envelope(swPlan(install, swParams(map[string]any{"installerSha256": strings.Repeat("0", 64)})), nil), 0)
	// The download happened only after the job was consumed: a crash from
	// here on reports uncertain, never runs again.
	o := s.opts()
	b, err := os.ReadFile(filepath.Join(s.dir, "actions", "journal", job+".json"))
	if err != nil || !strings.Contains(string(b), `"state":"done"`) {
		t.Fatalf("journal %s %v", b, err)
	}
	_ = o
	src, _ := os.ReadFile("software.go")
	i, j := strings.Index(string(src), `journalStep(o, p, "downloading")`), strings.Index(string(src), `o.Winget.Run(downloadArgs(`)
	if i < 0 || j < i {
		t.Fatal("downloading must be journaled before the download runs")
	}
}

func TestSoftwareHashMismatchRefusedBeforeInstall(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200"})
	r := s.runSW(s.envelope(swPlan(install, swParams(map[string]any{"installerSha256": sha("some other installer")})), nil), 0)
	expect(t, r, "refused", "hash_mismatch")
	if c := s.calls(); !reflect.DeepEqual(c, []string{"--version", "--version", "download"}) || r.Observed["installerSha256"] != sha(installerBytes) {
		t.Fatalf("calls %v observed %+v", c, r.Observed)
	}
}

func TestSoftwareManifestHashMismatchRefused(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200", Packages: map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, ManifestSha256: strings.Repeat("ab", 32), DisplayName: "7-Zip 24.08"}}})
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r, "refused", "manifest_hash_mismatch")
	if c := s.calls(); !reflect.DeepEqual(c, []string{"--version", "--version", "download"}) {
		t.Fatalf("calls %v", c)
	}
}

func TestSoftwareWingetMissingOrOld(t *testing.T) {
	s := newSW(t, &stub.State{})
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r, "not_executed", "winget_unavailable")
	if len(s.calls()) != 0 {
		t.Fatal("ran something without winget")
	}
	s2 := newSW(t, &stub.State{Version: "v1.6.3133"})
	r2 := s2.runSW(s2.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r2, "not_executed", "winget_too_old")
	if c := s2.calls(); !reflect.DeepEqual(c, []string{"--version"}) || r2.Observed["wingetVersion"] != "v1.6.3133" {
		t.Fatalf("calls %v observed %+v", c, r2.Observed)
	}
	s3 := newSW(t, &stub.State{Version: "garbage"})
	expect(t, s3.runSW(s3.envelope(swPlan(install, swParams(nil)), nil), 0), "not_executed", "winget_unavailable")
}

func TestSoftwareTimeoutIsUncertain(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200", Packages: map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, Hang: true}}})
	start := time.Now()
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 1500*time.Millisecond)
	expect(t, r, "uncertain", "timeout")
	if time.Since(start) > 30*time.Second || r.Observed["detectedNow"] != "absent" {
		t.Fatalf("took %s observed %+v", time.Since(start), r.Observed)
	}
}

func TestSoftwareNotEffectiveAndRestartRequired(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200", Packages: map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, NoEffect: true}}})
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r, "failed", "not_effective")
	if r.Observed["effective"] != "false" || r.Observed["detectedAfter"] != "absent" {
		t.Fatalf("observed %+v", r.Observed)
	}
	s2 := newSW(t, &stub.State{Version: "v1.9.25200", Packages: map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, NoEffect: true, ExitCode: stub.RebootToFinish}}})
	r2 := s2.runSW(s2.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r2, "restart_required", "")
	if r2.Observed["exitCode"] != "0x8A150109" || r2.Observed["rebootRequired"] != "true" {
		t.Fatalf("observed %+v", r2.Observed)
	}
	s3 := newSW(t, &stub.State{Version: "v1.9.25200", Packages: map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, ExitCode: stub.InstallFailed}}})
	r3 := s3.runSW(s3.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r3, "failed", "install_failed")
	if r3.Observed["exitCode"] != "0x8A150011" {
		t.Fatalf("observed %+v", r3.Observed)
	}
}

func TestSoftwareInjectionRefusedWithoutRunningAnything(t *testing.T) {
	det := func(over map[string]any) map[string]any {
		d := map[string]any{"kind": "display_name", "name": "7-Zip", "match": "prefix", "compare": "gte", "version": "24.08"}
		for k, v := range over {
			d[k] = v
		}
		return d
	}
	cases := map[string]map[string]any{
		"option as id":        {"packageId": "--override"},
		"id with a space":     {"packageId": "7zip.7zip --override x"},
		"id with ;":           {"packageId": "a.b;calc"},
		"id leading dash":     {"packageId": "-x.y"},
		"id with a quote":     {"packageId": `7zip.7zip" --force`},
		"id unicode":          {"packageId": "7zip.7ẓip"},
		"id without a dot":    {"packageId": "7zip"},
		"id too long":         {"packageId": strings.Repeat("a", 64) + "." + strings.Repeat("b", 64)},
		"version as option":   {"version": "--force"},
		"version with space":  {"version": "24.08 --force"},
		"upper-case hash":     {"installerSha256": strings.ToUpper(sha(installerBytes))},
		"user scope":          {"scope": "user"},
		"extra field":         {"override": "/S"},
		"missing detection":   {"detection": nil},
		"bad match":           {"detection": det(map[string]any{"match": "regex"})},
		"name with quote":     {"detection": det(map[string]any{"name": `7-Zip"`})},
		"detection extra":     {"detection": det(map[string]any{"path": `C:\x`})},
		"key with backslash":  {"detection": map[string]any{"kind": "uninstall_key", "key": `..\Run`, "compare": "gte", "version": "1"}},
		"file traversal":      {"detection": map[string]any{"kind": "file_version", "base": "ProgramFiles", "file": `..\Windows\System32\cmd.exe`, "compare": "gte", "version": "1"}},
		"file absolute":       {"detection": map[string]any{"kind": "file_version", "base": "ProgramFiles", "file": `C:\Windows\x.exe`, "compare": "gte", "version": "1"}},
		"file not exe or dll": {"detection": map[string]any{"kind": "file_version", "base": "ProgramFiles", "file": `7-Zip\7z.txt`, "compare": "gte", "version": "1"}},
		"file other base":     {"detection": map[string]any{"kind": "file_version", "base": "Windows", "file": `7-Zip\7z.exe`, "compare": "gte", "version": "1"}},
		"file trailing dot":   {"detection": map[string]any{"kind": "file_version", "base": "ProgramFiles", "file": `7-Zip.\7z.exe`, "compare": "gte", "version": "1"}},
	}
	for name, over := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSW(t, &stub.State{Version: "v1.9.25200"})
			r := s.runSW(s.envelope(swPlan(install, swParams(over)), nil), 0)
			expect(t, r, "refused", "params_not_allowed")
			if len(stub.Calls(s.state)) != 0 {
				t.Fatalf("winget was run: %v", stub.Calls(s.state))
			}
		})
	}
	// The forms that are allowed.
	for _, id := range []string{"7zip.7zip", "Notepad++.Notepad++", "Microsoft.VisualStudio.2022.Community", "Git.Git"} {
		if !ValidPackageID(id) {
			t.Fatalf("%s refused", id)
		}
	}
	if !ValidDetectionFile(`Mozilla Firefox\firefox.exe`) || !ValidDetectionFile(`7-Zip\7z.dll`) {
		t.Fatal("ordinary files refused")
	}
}

func TestSoftwareManagedElsewhere(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200", Managers: []string{"configmgr", "intune"}})
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r, "refused", "managed_elsewhere")
	if r.Observed["managers"] != "configmgr,intune" || len(s.calls()) != 0 {
		t.Fatalf("observed %+v calls %v", r.Observed, s.calls())
	}
}

func TestSoftwareNeedsTheSurface(t *testing.T) {
	f := newFixture(t)
	r, _ := Run(job, f.envelope(swPlan(install, swParams(nil)), nil), f.opts())
	expect(t, r, "failed", "no_software")
}

func TestSoftwareUninstall(t *testing.T) {
	present := []stub.Entry{{Key: "7-Zip", DisplayName: "7-Zip 24.08 (x64)", DisplayVersion: "24.08", PackageID: "7zip.7zip"}}
	s := newSW(t, &stub.State{Version: "v1.9.25200", Installed: present})
	r := s.runSW(s.envelope(swPlan(uninstall, swParams(nil)), nil), 0)
	expect(t, r, "succeeded", "")
	want := []string{"uninstall", "--id", "7zip.7zip", "--exact", "--source", "winget", "--silent", "--scope", "machine", "--accept-source-agreements", "--disable-interactivity"}
	calls := stub.Calls(s.state)
	if !reflect.DeepEqual(calls[len(calls)-1], want) || r.Observed["detectedBefore"] != "installed" || r.Observed["detectedAfter"] != "absent" || r.Observed["effective"] != "true" {
		t.Fatalf("argv %q observed %+v", calls[len(calls)-1], r.Observed)
	}
	s2 := newSW(t, &stub.State{Version: "v1.9.25200"})
	r2 := s2.runSW(s2.envelope(swPlan(uninstall, swParams(nil)), nil), 0)
	expect(t, r2, "no_change", "")
	if c := s2.calls(); !reflect.DeepEqual(c, []string{"--version"}) {
		t.Fatalf("calls %v", c)
	}
	// Uninstall that leaves it there.
	s3 := newSW(t, &stub.State{Version: "v1.9.25200", Installed: present, Packages: map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, NoEffect: true}}})
	expect(t, s3.runSW(s3.envelope(swPlan(uninstall, swParams(nil)), nil), 0), "failed", "not_effective")
}

func TestSoftwareDetectionKinds(t *testing.T) {
	st := &stub.State{Version: "v1.9.25200", Packages: map[string]*stub.Package{"7zip.7zip@24.08": {Installer: installerBytes, DisplayName: "7-Zip 24.08", DisplayVersion: "24.08", UninstallKey: "7-Zip", File: `ProgramFiles|7-Zip\7z.exe`}}}
	for name, d := range map[string]map[string]any{
		"uninstall_key": {"kind": "uninstall_key", "key": "7-zip", "compare": "eq", "version": "24.08"},
		"file_version":  {"kind": "file_version", "base": "ProgramFiles", "file": `7-Zip\7z.exe`, "compare": "gte", "version": "24.8"},
	} {
		t.Run(name, func(t *testing.T) {
			s := newSW(t, st)
			r := s.runSW(s.envelope(swPlan(install, swParams(map[string]any{"detection": d})), nil), 0)
			expect(t, r, "succeeded", "")
			if r.Observed["detectedAfter"] != "installed" {
				t.Fatalf("observed %+v", r.Observed)
			}
		})
	}
	p := probeAdapter{stub.Probe{State: filepath.Join(t.TempDir(), "x.json")}}
	_ = (&stub.State{Installed: []stub.Entry{{DisplayName: "Foo 1"}, {DisplayName: "Foo 2", DisplayVersion: "2.0"}, {DisplayName: "Bar", DisplayVersion: "9"}}}).Save(p.State)
	st2, v, err := Detect(p, Detection{Kind: "display_name", Name: "foo", Match: "prefix", Compare: "gte", Version: "1.5"})
	if err != nil || st2 != "installed" || v != "2.0" {
		t.Fatalf("highest match decides: %s %s %v", st2, v, err)
	}
	st3, _, _ := Detect(p, Detection{Kind: "display_name", Name: "Foo 1", Match: "exact", Compare: "gte", Version: "1"})
	if st3 != "outdated" {
		t.Fatalf("no DisplayVersion is outdated: %s", st3)
	}
}

func TestSoftwareInterruptedReportsDetectionNow(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200", Installed: []stub.Entry{{DisplayName: "7-Zip 24.08", DisplayVersion: "24.08"}}})
	o := s.opts()
	os.MkdirAll(filepath.Join(s.dir, "actions", "journal"), 0o700)
	writeJournal(o, journal{JobID: job, State: "executing", Step: "installing", At: now.Format(time.RFC3339), ActionID: install, ActionVersion: 1, Params: swParams(nil)})
	r := s.runSW(s.envelope(swPlan(install, swParams(nil)), nil), 0)
	expect(t, r, "uncertain", "interrupted")
	if r.Observed["detectedNow"] != "installed" || r.Observed["versionNow"] != "24.08" || !strings.Contains(r.Detail, "installing") || len(s.calls()) != 0 {
		t.Fatalf("observed %+v detail %q calls %v", r.Observed, r.Detail, s.calls())
	}
}

func TestSoftwareRiskIsAlwaysHigh(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200"})
	s2 := newSW(t, &stub.State{Version: "v1.9.25200"})
	p := swPlan(install, swParams(nil))
	p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 1, "customerSignoff": false}
	expect(t, s.runSW(s.envelope(p, nil), 0), "refused", "risk_understated")
	p2 := swPlan(install, swParams(nil))
	p2["approvers"] = p2["approvers"].([]any)[:1]
	expect(t, s2.runSW(s2.envelope(p2, nil), 0), "refused", "too_few_approvals")
	if len(stub.Calls(s.state))+len(stub.Calls(s2.state)) != 0 {
		t.Fatal("winget ran for a refused plan")
	}
}

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"24.08", "24.08", 0}, {"24.8", "24.08", 0}, {"24.09", "24.08", 1}, {"1.10", "1.9", 1}, {"1.2", "1.2.0.0", 0},
		{"1.2.1", "1.2", 1}, {"120.0", "99.0.1", 1}, {"1.0-beta", "1.0-alpha", 1}, {"1.0.RC1", "1.0.rc1", 0},
		{"99999999999999999999.1", "99999999999999999998.9", 1}, {"", "0", 0}, {"", "1", -1}, {"1..2", "1.0.2", 0}, {"2.0_1", "2.0.1", 0},
		{"1.2a", "1.2", 1},
	} {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
