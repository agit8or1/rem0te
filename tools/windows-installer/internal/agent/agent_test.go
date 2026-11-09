package agent_test

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/release"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

const (
	relayKey  = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw="
	relayKey2 = "AAAAKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw="
	token     = "0123456789abcdef0123456789abcdef"
	nonce     = "nonce_ABCDEFGH12345678"
)

// ---------------------------------------------------------------- portal fake

type portal struct {
	t        *testing.T
	repo     *release.Repo
	dir      string
	k        map[string]*release.Key
	srv      *httptest.Server
	host     string
	params   agent.Params
	root1    []byte
	agentBin []byte
	// paramsHook lets a test play a compromised portal.
	paramsHook func(q url.Values) (int, any)
}

func newPortal(t *testing.T) *portal {
	t.Helper()
	base := t.TempDir()
	kd := filepath.Join(base, "keys")
	os.MkdirAll(kd, 0o700)
	k := map[string]*release.Key{}
	for _, n := range []string{"r1", "r2", "targets", "snapshot", "timestamp"} {
		key, err := release.GenerateKey(filepath.Join(kd, n+".pem"))
		if err != nil {
			t.Fatal(err)
		}
		k[n] = key
	}
	p := &portal{t: t, dir: filepath.Join(base, "repo"), k: k, agentBin: []byte("MZ signed agent build 1")}
	p.repo = release.Open(p.dir)
	if err := p.repo.Init(release.InitOptions{RootKeys: []*release.Key{k["r1"], k["r2"]}, RootThreshold: 2, TargetsKeys: []*release.Key{k["targets"]}, SnapshotKey: k["snapshot"], TimestampKey: k["timestamp"]}); err != nil {
		t.Fatal(err)
	}
	p.root1, _ = os.ReadFile(filepath.Join(p.dir, "metadata", "1.root.json"))
	p.publish(map[string][]byte{
		agent.TargetInstaller:             []byte("# signed installer v1"),
		agent.TargetAgent:                 p.agentBin,
		trust.RustdeskTargetName("1.4.5"): []byte("rustdesk 1.4.5"),
		trust.RustdeskTargetName("1.4.6"): []byte("rustdesk 1.4.6"),
	}, nil)
	mux := http.NewServeMux()
	mux.Handle("/api/v1/public/updates/", http.StripPrefix("/api/v1/public/updates", http.FileServer(http.Dir(p.dir))))
	mux.HandleFunc("/api/v1/public/install/windows-params.json", func(w http.ResponseWriter, r *http.Request) {
		if p.paramsHook != nil {
			code, body := p.paramsHook(r.URL.Query())
			w.WriteHeader(code)
			json.NewEncoder(w).Encode(body)
			return
		}
		prm := p.params
		prm.UpdateNonce = r.URL.Query().Get("updateNonce")
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": prm})
	})
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	u, _ := url.Parse(p.srv.URL)
	p.host = u.Host
	p.params = agent.Params{Schema: agent.ParamsSchema, Host: "relay.example.com", Key: relayKey, RustdeskVersion: "1.4.6"}
	return p
}

func (p *portal) publish(files map[string][]byte, custom map[string]map[string]any) {
	p.t.Helper()
	src := p.t.TempDir()
	specs := []release.TargetSpec{}
	for name, body := range files {
		f := filepath.Join(src, strings.ReplaceAll(name, "/", "_"))
		os.WriteFile(f, body, 0o644)
		specs = append(specs, release.TargetSpec{Name: name, File: f, Custom: custom[name]})
	}
	if err := p.repo.Release(release.ReleaseOptions{Add: specs, TargetsKeys: []*release.Key{p.k["targets"]}, SnapshotKey: p.k["snapshot"], TimestampKey: p.k["timestamp"]}); err != nil {
		p.t.Fatal(err)
	}
}

// ---------------------------------------------------------------- platform fake

type fakeWin struct {
	t         *testing.T
	self      string
	rdVersion string
	priorHost string
	priorKey  string
	ranScript string
	params    agent.ScriptParams
	stage2Ran bool
	opts      agent.Options // for the in-process "exec" of stage 2
	exitCode  int
}

func (f *fakeWin) RustdeskVersion() string      { return f.rdVersion }
func (f *fakeWin) SecureDir(d string) error     { return os.MkdirAll(d, 0o700) }
func (f *fakeWin) SelfPath() (string, error)    { return f.self, nil }
func (f *fakeWin) PriorRelay() (string, string) { return f.priorHost, f.priorKey }
func (f *fakeWin) InstallAgent(src, dst string) error {
	os.MkdirAll(filepath.Dir(dst), 0o755)
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o755)
}
func (f *fakeWin) RunAgent(exe string, args []string) (int, error) {
	// "exec" the installed binary: stage 2 runs with SelfPath = exe.
	f.stage2Ran = true
	f.self = exe
	o := f.opts
	o.Stage2 = true
	return agent.Run(o, f)
}
func (f *fakeWin) RunInstaller(script, params string) (int, error) {
	b, _ := os.ReadFile(script)
	f.ranScript = string(b)
	raw, _ := os.ReadFile(params)
	json.Unmarshal(raw, &f.params)
	return f.exitCode, nil
}

func setup(t *testing.T, mode agent.Mode) (*portal, *fakeWin, agent.Options) {
	p := newPortal(t)
	base := t.TempDir()
	boot := filepath.Join(base, "Downloads", "rem0te-setup.exe")
	os.MkdirAll(filepath.Dir(boot), 0o755)
	os.WriteFile(boot, []byte("MZ portal-patched bootstrap"), 0o755)
	o := agent.Options{
		Mode: mode, PortalHost: p.host, Root: p.root1, Scheme: "http",
		Paths: agent.Paths{InstallDir: filepath.Join(base, "Program Files", "Rem0te"), StateDir: filepath.Join(base, "ProgramData", "Rem0te")},
	}
	if mode == agent.ModeInstall {
		o.ClaimToken = token
	}
	f := &fakeWin{t: t, self: boot, opts: o}
	return p, f, o
}

// ---------------------------------------------------------------- tests

func TestInstallRunsOnlySignedCode(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	code, err := agent.Run(o, f)
	if err != nil || code != 0 {
		t.Fatalf("install: %d %v", code, err)
	}
	if !f.stage2Ran || f.ranScript != "# signed installer v1" {
		t.Fatalf("stage2=%v script=%q", f.stage2Ran, f.ranScript)
	}
	installed, _ := os.ReadFile(o.Paths.AgentExe())
	if string(installed) != string(p.agentBin) {
		t.Fatal("installed agent is not the signed target (it must never be the patched bootstrap)")
	}
	sp := f.params
	if sp.Host != "relay.example.com" || sp.Key != relayKey || sp.ClaimToken != token || sp.RustdeskVersion != "1.4.6" || len(sp.RustdeskSHA256) != 64 || sp.TrustRoot != 1 {
		t.Fatalf("script params %+v", sp)
	}
	if rd, _ := os.ReadFile(sp.RustdeskExe); string(rd) != "rustdesk 1.4.6" {
		t.Fatalf("RustDesk file %q", rd)
	}
	var st agent.Status
	raw, _ := os.ReadFile(o.Paths.StatusFile())
	json.Unmarshal(raw, &st)
	if st.Channel != "signed" || st.TrustRoot != 1 || st.AgentSHA256 == "" {
		t.Fatalf("status %+v", st)
	}
}

// Stage 2 refuses to run privileged steps from anything but the signed binary.
func TestStage2RefusesUnsignedSelf(t *testing.T) {
	_, f, o := setup(t, agent.ModeInstall)
	o.Stage2 = true // as if a tampered/patched binary claimed to be stage 2
	_, err := agent.Run(o, f)
	if !errors.Is(err, agent.ErrRefuse) || !strings.Contains(err.Error(), "not the signed agent") {
		t.Fatalf("got %v", err)
	}
	if f.ranScript != "" {
		t.Fatal("installer ran")
	}
}

func TestUnsignedRustdeskVersionRefused(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	p.params.RustdeskVersion = "1.9.9"
	_, err := agent.Run(o, f)
	if !errors.Is(err, agent.ErrRefuse) || !strings.Contains(err.Error(), "not a signed release") {
		t.Fatalf("got %v", err)
	}
}

// The portal can choose which *signed* build to roll out, but not walk a
// machine back to an older one.
func TestDowngradeRefusedUnlessSignedAsRollback(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	f.rdVersion = "1.4.6"
	p.params.RustdeskVersion = "1.4.5"
	if _, err := agent.Run(o, f); !errors.Is(err, agent.ErrRefuse) || !strings.Contains(err.Error(), "older than installed") {
		t.Fatalf("downgrade: %v", err)
	}
	p.publish(map[string][]byte{trust.RustdeskTargetName("1.4.5"): []byte("rustdesk 1.4.5")}, map[string]map[string]any{trust.RustdeskTargetName("1.4.5"): {"allowDowngrade": true}})
	f.self = filepath.Join(filepath.Dir(o.Paths.InstallDir), "x") // re-run from stage 1
	if code, err := agent.Run(o, f); err != nil || code != 0 || f.params.RustdeskVersion != "1.4.5" {
		t.Fatalf("signed rollback: %d %v %+v", code, err, f.params)
	}
}

// A compromised portal changes the relay in its parameters. An installed
// machine keeps its pin and reports the request instead.
func TestUpdateKeepsPinnedRelay(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	if _, err := agent.Run(o, f); err != nil {
		t.Fatal(err)
	}
	p.params.Host, p.params.Key = "evil-relay.example.net", relayKey2
	u := o
	u.Mode, u.ClaimToken, u.Nonce = agent.ModeUpdate, "", nonce
	f.opts = u
	if code, err := agent.Run(u, f); err != nil || code != 0 {
		t.Fatalf("update: %d %v", code, err)
	}
	if f.params.Host != "relay.example.com" || f.params.Key != relayKey || f.params.UpdateNonce != nonce {
		t.Fatalf("relay was repointed: %+v", f.params)
	}
	var st agent.Status
	raw, _ := os.ReadFile(o.Paths.StatusFile())
	json.Unmarshal(raw, &st)
	if !st.RelayChangeAsked {
		t.Fatal("relay change request not reported")
	}
}

func TestUpdateWithoutPinRefused(t *testing.T) {
	_, f, o := setup(t, agent.ModeUpdate)
	if _, err := agent.Run(o, f); !errors.Is(err, agent.ErrRefuse) || !strings.Contains(err.Error(), "migrate") {
		t.Fatalf("got %v", err)
	}
}

// Migration pins the relay the legacy install already uses, not the portal's.
func TestMigratePinsPriorRelay(t *testing.T) {
	p, f, o := setup(t, agent.ModeMigrate)
	f.priorHost, f.priorKey = "relay.example.com", relayKey
	p.params.Host = "other.example.org"
	if code, err := agent.Run(o, f); err != nil || code != 0 {
		t.Fatalf("migrate: %d %v", code, err)
	}
	if f.params.Host != "relay.example.com" || f.params.ClaimToken != "" || f.params.Mode != agent.ModeMigrate {
		t.Fatalf("params %+v", f.params)
	}
}

func TestNonceMismatchRefused(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	agent.Run(o, f)
	p.paramsHook = func(q url.Values) (int, any) {
		prm := p.params
		prm.UpdateNonce = "nonce_SOMEOTHERJOB00000"
		return 200, map[string]any{"data": prm}
	}
	u := o
	u.Mode, u.ClaimToken, u.Nonce = agent.ModeUpdate, "", nonce
	f.opts = u
	if _, err := agent.Run(u, f); !errors.Is(err, agent.ErrRefuse) || !strings.Contains(err.Error(), "nonce") {
		t.Fatalf("got %v", err)
	}
}

// Every parameter is validated: a portal cannot smuggle script syntax.
func TestHostileParamsRefused(t *testing.T) {
	bad := []agent.Params{
		{Schema: agent.ParamsSchema, Host: "a.example.com'; iex x", Key: relayKey, RustdeskVersion: "1.4.6"},
		{Schema: agent.ParamsSchema, Host: "a.example.com", Key: "not base64 !", RustdeskVersion: "1.4.6"},
		{Schema: agent.ParamsSchema, Host: "a.example.com", Key: relayKey, RustdeskVersion: "1.4.6; calc"},
		{Schema: "something-else", Host: "a.example.com", Key: relayKey, RustdeskVersion: "1.4.6"},
	}
	for i, b := range bad {
		p, f, o := setup(t, agent.ModeInstall)
		p.params = b
		if _, err := agent.Run(o, f); !errors.Is(err, agent.ErrRefuse) {
			t.Fatalf("case %d accepted: %v", i, err)
		}
		if f.ranScript != "" {
			t.Fatalf("case %d ran the installer", i)
		}
	}
}

func TestOptionValidation(t *testing.T) {
	_, f, o := setup(t, agent.ModeInstall)
	for _, mut := range []func(*agent.Options){
		func(o *agent.Options) { o.PortalHost = "https://x" },
		func(o *agent.Options) { o.PortalHost = "a..b" },
		func(o *agent.Options) { o.ClaimToken = "zz" },
		func(o *agent.Options) { o.Nonce = "short" },
		func(o *agent.Options) { o.Mode = "shell" },
	} {
		oo := o
		mut(&oo)
		if _, err := agent.Run(oo, f); !errors.Is(err, agent.ErrRefuse) {
			t.Fatalf("accepted %+v: %v", oo, err)
		}
	}
}

// A mirror that serves a forged agent binary stops stage 1 before anything runs.
func TestTamperedAgentBinaryStopsStage1(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	m, _ := filepath.Glob(filepath.Join(p.dir, "targets", "windows", "*.rem0te-agent.exe"))
	for _, x := range m {
		os.WriteFile(x, []byte("MZ evil agent build 1!!"), 0o644)
	}
	if _, err := agent.Run(o, f); err == nil {
		t.Fatal("forged agent binary accepted")
	}
	if f.stage2Ran {
		t.Fatal("stage 2 ran")
	}
	if _, err := os.Stat(o.Paths.AgentExe()); err == nil {
		t.Fatal("forged binary was installed")
	}
}

func TestParamsHTTPErrorFailsClosed(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	p.paramsHook = func(url.Values) (int, any) { return 404, map[string]any{"code": "NOT_FOUND"} }
	if _, err := agent.Run(o, f); err == nil || f.ranScript != "" {
		t.Fatalf("got %v, script=%q", err, f.ranScript)
	}
	_ = io.EOF
}

func TestParseSlotURL(t *testing.T) {
	ok := []struct{ in, host, tok string }{
		{"https://remote.example.com/api/v1/public/install/windows.ps1?token=" + token, "remote.example.com", token},
		{"https://remote.example.com:8443/api/v1/public/install/windows.ps1", "remote.example.com:8443", ""},
	}
	for _, c := range ok {
		h, tk, good := agent.ParseSlotURL(c.in)
		if !good || h != c.host || tk != c.tok {
			t.Fatalf("%s -> %q %q %v", c.in, h, tk, good)
		}
	}
	for _, bad := range []string{
		"http://remote.example.com/api/v1/public/install/windows.ps1",
		"https://u:p@remote.example.com/api/v1/public/install/windows.ps1",
		"https://remote.example.com/evil.ps1",
		"https://remote.example.com/api/v1/public/install/windows.ps1?token=zz'",
		"https://a..b/api/v1/public/install/windows.ps1",
	} {
		if _, _, good := agent.ParseSlotURL(bad); good {
			t.Fatalf("accepted %s", bad)
		}
	}
}
