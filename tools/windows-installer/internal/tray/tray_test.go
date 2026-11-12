package tray

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
)

// ── Protocol ─────────────────────────────────────────────────────────────────

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := Frame{T: FrameSelfHelp, ID: "0011aabb", Tool: "dns.check"}
	if err := WriteFrame(&buf, in); err != nil {
		t.Fatal(err)
	}
	f, err := NewReader(&buf).Next()
	if err != nil || f.T != in.T || f.Tool != in.Tool || f.ID != in.ID {
		t.Fatalf("%+v %v", f, err)
	}
	if _, err := NewReader(&buf).Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestReaderRefuses(t *testing.T) {
	big := `{"t":"code","id":"0011aabb","text":"` + strings.Repeat("a", MaxFrameBytes) + `"}` + "\n"
	huge := `{"t":"support","id":"0011aabb","shot":"` + strings.Repeat("A", MaxSupportFrameBytes) + `"}` + "\n"
	for name, line := range map[string]string{
		"not json":              "hello\n",
		"unknown field":         `{"t":"code","id":"0011aabb","cmd":"calc.exe"}` + "\n",
		"trailing":              `{"t":"code"} {"t":"code"}` + "\n",
		"unterminated":          `{"t":"code"}`,
		"big non-support frame": big,
		"over the support cap":  huge,
	} {
		if _, err := NewReader(strings.NewReader(line)).Next(); !errors.Is(err, ErrFrame) {
			t.Errorf("%s: want ErrFrame, got %v", name, err)
		}
	}
	// A support frame up to the support cap is read.
	ok := `{"t":"support","id":"0011aabb","text":"x","shot":"` + strings.Repeat("A", 500_000) + `"}` + "\n"
	if _, err := NewReader(strings.NewReader(ok)).Next(); err != nil {
		t.Errorf("a 500 KB support frame: %v", err)
	}
}

func TestCheckFromTray(t *testing.T) {
	nonce := NewNonce()
	good := []Frame{
		{T: FrameHello, Nonce: nonce},
		{T: FrameCode, ID: "0011aabb"},
		{T: FrameSupport, ID: "0011aabb", Text: "printer is broken", Usage: true},
		{T: FrameSupport, ID: "0011aabb", Text: "see screen", Shot: base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0xff})},
		{T: FrameSelfHelp, ID: "0011aabb", Tool: "ip.renew"},
		{T: FrameSeen, IDs: []string{"clx0000000000000000000001"}},
	}
	for _, f := range good {
		if _, err := CheckFromTray(f); err != nil {
			t.Errorf("%+v refused: %v", f, err)
		}
	}
	bad := map[string]Frame{
		"hello without nonce":     {T: FrameHello},
		"hello with short nonce":  {T: FrameHello, Nonce: "abc"},
		"code without id":         {T: FrameCode},
		"code carrying a url":     {T: FrameCode, ID: "0011aabb", URL: "https://evil.example/"},
		"code carrying a tool":    {T: FrameCode, ID: "0011aabb", Tool: "dns.check"},
		"empty support":           {T: FrameSupport, ID: "0011aabb", Text: "  "},
		"long support":            {T: FrameSupport, ID: "0011aabb", Text: strings.Repeat("x", 2001)},
		"support shot not base64": {T: FrameSupport, ID: "0011aabb", Text: "x", Shot: "not base64!"},
		"support shot over cap":   {T: FrameSupport, ID: "0011aabb", Text: "x", Shot: strings.Repeat("A", MaxScreenshotBytes*4/3+8)},
		"unknown tool":            {T: FrameSelfHelp, ID: "0011aabb", Tool: "cmd.run"},
		"tool with a parameter":   {T: FrameSelfHelp, ID: "0011aabb", Tool: "dns.check", Text: "evil.example"},
		"seen bad id":             {T: FrameSeen, IDs: []string{"../x"}},
		"seen nothing":            {T: FrameSeen},
		"state from the tray":     {T: FrameState, State: &State{}},
		"reply from the tray":     {T: FrameReply, ID: "0011aabb", OK: true},
		"unknown type":            {T: "exec"},
	}
	for name, f := range bad {
		if _, err := CheckFromTray(f); !errors.Is(err, ErrFrame) && !errors.Is(err, ErrRequestText) {
			t.Errorf("%s: accepted (%v)", name, err)
		}
	}
}

func TestCheckFromHost(t *testing.T) {
	st := State{Business: "Acme\u202e\nLtd", Accent: "red;background:url(x)", Agent: "root", Portal: "evil/path",
		Chat:  ChatState{Open: true, ConversationID: "clx0000000000000000000001", Unread: []string{"clx0000000000000000000002", "<script>"}, StartedBy: "attacker"},
		Tools: []ToolState{{ID: "dns.check"}, {ID: "cmd.run", Title: "Run anything"}, {ID: "ip.renew", Title: "Spoofed title"}}}
	f, err := CheckFromHost(Frame{T: FrameState, State: &st})
	if err != nil {
		t.Fatal(err)
	}
	s := *f.State
	if s.Business != "Acme Ltd" || s.Accent != "#3B82F6" || s.Agent != "standard" || s.Portal != "" || s.Chat.StartedBy != "" {
		t.Errorf("state not cleaned: %+v", s)
	}
	if len(s.Chat.Unread) != 1 || len(s.Tools) != 2 || s.Tools[1].Title != "Renew IP address" || !s.Tools[1].Elevated {
		t.Errorf("unread/tools not cleaned: %+v", s)
	}
	for name, fr := range map[string]Frame{
		"hello from the host": {T: FrameHello, Nonce: NewNonce()},
		"state without state": {T: FrameState},
		"reply bad outcome":   {T: FrameReply, ID: "0011aabb", Outcome: "pwned"},
		"reply with a tool":   {T: FrameReply, ID: "0011aabb", Tool: "dns.flush"},
	} {
		if _, err := CheckFromHost(fr); !errors.Is(err, ErrFrame) {
			t.Errorf("%s: accepted", name)
		}
	}
}

// ── The catalog is the same list in the portal, the database and here ───────

func TestCatalogMatchesPortalAndMigration(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	ts, err := os.ReadFile(filepath.Join(root, "apps", "api", "src", "tray", "tray-policy.ts"))
	if err != nil {
		t.Skipf("portal source not present: %v", err)
	}
	re := regexp.MustCompile(`\{ id: '([a-z.]+)', title: '([^']+)', elevated: (true|false), perWindow: (\d+), windowMs: (\d+) \* 60_000, blockedBy: \[([^\]]*)\] \}`)
	m := re.FindAllStringSubmatch(string(ts), -1)
	if len(m) != len(Catalog) {
		t.Fatalf("portal has %d tools, agent %d", len(m), len(Catalog))
	}
	for i, x := range m {
		c := Catalog[i]
		blocked := strings.ReplaceAll(strings.ReplaceAll(x[6], "'", ""), " ", "")
		got := strings.Join(c.BlockedBy, ",")
		if x[1] != c.ID || x[2] != c.Title || (x[3] == "true") != c.Elevated || x[4] != itoa(c.PerWindow) || x[5] != itoa(int(c.Window/time.Minute)) || blocked != got {
			t.Errorf("tool %d differs: portal %v, agent %+v", i, x[1:], c)
		}
	}
	if !strings.Contains(string(ts), "SELF_HELP_PER_HOUR = 30") || PerHour != 30 {
		t.Error("hourly cap differs")
	}
	sql, err := os.ReadFile(filepath.Join(root, "apps", "api", "prisma", "migrations", "0062_tray", "migration.sql"))
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, c := range Catalog {
		ids = append(ids, "'"+c.ID+"'")
	}
	if !strings.Contains(string(sql), "\"tool\" IN ("+strings.Join(ids, ", ")+")") {
		t.Errorf("migration CHECK does not list exactly %s", strings.Join(ids, ", "))
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// ── Limits ───────────────────────────────────────────────────────────────────

func TestLimits(t *testing.T) {
	now := time.Unix(10_000, 0)
	l := NewLimits()
	l.Now = func() time.Time { return now }
	renew, _ := Tool("ip.renew")
	if !l.AllowTool(renew) || !l.AllowTool(renew) || l.AllowTool(renew) {
		t.Fatal("ip.renew: two per 15 minutes")
	}
	now = now.Add(16 * time.Minute)
	if !l.AllowTool(renew) {
		t.Fatal("ip.renew allowed again after the window")
	}
	// The hourly cap across every tool.
	l2 := NewLimits()
	l2.Now = func() time.Time { return now }
	n := 0
	for i := 0; i < 100; i++ {
		for _, c := range Catalog {
			if l2.AllowTool(c) {
				n++
			}
		}
		now = now.Add(30 * time.Second)
	}
	if n != PerHour {
		t.Errorf("hourly cap: %d runs allowed, want %d", n, PerHour)
	}
	// Support: 2 per user, 3 per device.
	l3 := NewLimits()
	l3.Now = func() time.Time { return now }
	if !l3.AllowSupport(`A\one`) || !l3.AllowSupport(`A\one`) || l3.AllowSupport(`A\one`) {
		t.Error("two per user per hour")
	}
	if !l3.AllowSupport(`A\two`) || l3.AllowSupport(`A\three`) {
		t.Error("three per device per hour")
	}
}

// ── URLs ─────────────────────────────────────────────────────────────────────

func TestAssistURLAndNavigation(t *testing.T) {
	code := strings.Repeat("A", 43)
	u, err := AssistURL("portal.example.com", code)
	if err != nil || u != "https://portal.example.com/assist/open?c="+code {
		t.Fatalf("%q %v", u, err)
	}
	for _, p := range []string{"", "evil.example/x", "a b", "portal.example.com/../"} {
		if _, err := AssistURL(p, code); err == nil {
			t.Errorf("portal %q accepted", p)
		}
	}
	for _, c := range []string{"", "short", strings.Repeat("A", 42) + "&", strings.Repeat("A", 44)} {
		if _, err := AssistURL("portal.example.com", c); err == nil {
			t.Errorf("code %q accepted", c)
		}
	}
	allow := []string{"https://portal.example.com/assist/chat", "https://PORTAL.example.com/assist/assist.js"}
	deny := []string{"http://portal.example.com/assist/chat", "https://portal.example.com/dashboard", "https://evil.example/assist/chat",
		"https://portal.example.com.evil.example/assist/chat", "https://user@portal.example.com/assist/chat", "https://portal.example.com/assist/../api/v1/auth",
		"https://portal.example.com/assist/%2e%2e/x", "javascript:alert(1)", "file:///C:/Windows", "https://portal.example.com:444/assist/chat"}
	for _, a := range allow {
		if !AllowedNavigation("portal.example.com", a) {
			t.Errorf("refused %s", a)
		}
	}
	for _, d := range deny {
		if AllowedNavigation("portal.example.com", d) {
			t.Errorf("allowed %s", d)
		}
	}
}

// ── Screenshot ───────────────────────────────────────────────────────────────

func TestEncodeShot(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 3840, 2160))
	r := rand.New(rand.NewSource(1))
	for i := range img.Pix {
		img.Pix[i] = uint8(r.Intn(256)) // noise: the worst case for JPEG
	}
	b, err := EncodeShot(img)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > MaxScreenshotBytes {
		t.Fatalf("%d bytes over the cap", len(b))
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width > ShotMaxWidth || cfg.Width < 320 {
		t.Fatalf("decoded %+v %v", cfg, err)
	}
	small := image.NewRGBA(image.Rect(0, 0, 800, 600))
	for i := 0; i < 800; i++ {
		small.Set(i, 10, color.RGBA{255, 0, 0, 255})
	}
	if b, err := EncodeShot(small); err != nil || len(b) == 0 {
		t.Fatal(err)
	}
	if _, err := EncodeShot(image.NewRGBA(image.Rect(0, 0, 0, 0))); err == nil {
		t.Error("an empty capture must be refused")
	}
}

func TestBuildUsage(t *testing.T) {
	raw := RawUsage{CPUPercent: 140, MemTotalMB: 16000, MemUsedMB: 8000, Procs: []ProcUse{
		{Name: "chrome.exe", CPUPercent: 30}, {Name: "evil\" onload=", CPUPercent: 99}, {Name: "C:\\Users\\bob\\secret.exe", CPUPercent: 50}, {Name: "svchost.exe", CPUPercent: 1},
	}}
	raw.Have.CPU, raw.Have.Mem = true, true
	u := BuildUsage(raw, time.Unix(0, 0))
	if *u.CPUPercent != 100 || u.DiskTotalMB != nil || len(u.TopProcesses) != 2 || u.TopProcesses[0].Name != "chrome.exe" {
		t.Errorf("%+v", u)
	}
}

// ── The portal client and Core, against a fake portal ───────────────────────

type fakePortal struct {
	mu        sync.Mutex
	calls     []map[string]any
	paths     []string
	down      bool
	contained string
	runs      int
	results   []map[string]any
}

// setDown and setContained change the fake under its lock: its handler runs
// on the server's goroutines.
func (p *fakePortal) setDown(v bool)        { p.mu.Lock(); p.down = v; p.mu.Unlock() }
func (p *fakePortal) setContained(v string) { p.mu.Lock(); p.contained = v; p.mu.Unlock() }

func (p *fakePortal) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.down {
			hj, _ := w.(http.Hijacker)
			c, _, _ := hj.Hijack()
			c.Close()
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		p.calls = append(p.calls, body)
		p.paths = append(p.paths, r.URL.Path)
		ok := func(data any) { _ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": data}) }
		fail := func(status int, code, msg string) {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "statusCode": status, "code": code, "message": msg})
		}
		switch r.URL.Path {
		case "/api/v1/tray/status":
			var blocked any
			if p.contained != "" {
				blocked = p.contained
			}
			ok(map[string]any{"businessName": "Acme", "providerName": "Prov", "supportText": "Call us", "accent": "#112233", "agent": "signed", "hasBusiness": true,
				"chat":      map[string]any{"open": true, "conversationId": "clx0000000000000000000001", "startedBy": "technician", "recorded": false, "unread": []string{"clx0000000000000000000009"}, "autoOpen": true},
				"recordNew": true, "contained": map[string]any{"remote": nil, "actions": blocked},
				"selfHelp":    []map[string]any{{"id": "dns.check", "title": "Check DNS", "elevated": false, "blocked": nil}, {"id": "ip.renew", "title": "Renew IP address", "elevated": true, "blocked": blocked}},
				"pollSeconds": 10})
		case "/api/v1/tray/chat-code":
			ok(map[string]any{"code": strings.Repeat("Z", 43)})
		case "/api/v1/tray/support-requests":
			ok(map[string]any{"id": "req1"})
		case "/api/v1/tray/self-help/begin":
			if p.contained != "" && body["tool"] == "ip.renew" {
				fail(403, "CONTAINED", p.contained)
				return
			}
			p.runs++
			ok(map[string]any{"runId": "run" + itoa(p.runs)})
		case "/api/v1/tray/self-help/result":
			p.results = append(p.results, body)
			ok(map[string]any{"recorded": true})
		default:
			fail(404, "NOT_FOUND", "no")
		}
	})
}

type fakeOS struct {
	renews, flushes, restarts int
	sessions                  int
	sessErr                   error
}

func (o *fakeOS) Resolve(ctx context.Context, h string) ([]string, error) {
	return []string{"192.0.2.10"}, nil
}
func (o *fakeOS) Adapters() ([]Adapter, error) {
	return []Adapter{{Name: "Ethernet", Up: true, DHCP: true, IPv4: []string{"192.168.1.20"}, Gateways: []string{"192.168.1.1"}, DNS: []string{"192.168.1.1"}}}, nil
}
func (o *fakeOS) DialTLS(ctx context.Context, hp string) (time.Duration, error) {
	return 20 * time.Millisecond, nil
}
func (o *fakeOS) Ping(ctx context.Context, ip string) (time.Duration, error) {
	return time.Millisecond, nil
}
func (o *fakeOS) FlushDNS() (string, error)    { o.flushes++; return "Successfully flushed", nil }
func (o *fakeOS) RenewIP() (string, error)     { o.renews++; return "Windows IP Configuration", nil }
func (o *fakeOS) RemoteSessions() (int, error) { return o.sessions, o.sessErr }
func (o *fakeOS) RestartRustDesk() error       { o.restarts++; return nil }

func newCore(t *testing.T, cred Credential, elevated bool) (*Core, *fakePortal, *fakeOS) {
	p := &fakePortal{}
	srv := httptest.NewServer(p.handler(t))
	t.Cleanup(srv.Close)
	o := &fakeOS{}
	c := &Core{API: &Client{Base: srv.URL + "/api/v1", Cred: cred}, Portal: "portal.example.com", Agent: "signed", Version: "0.36.0",
		Run: &Runner{OS: o, Portal: "portal.example.com", Elevated: elevated}}
	return c, p, o
}

var deviceCred = Credential{RustdeskID: "123456789", Secret: "s3cr3t-device-secret-value"}

func TestClientCredentials(t *testing.T) {
	for _, c := range []Credential{{}, {TrayKey: "tk_x", Secret: "y"}, {TrayKey: "not-a-key"}} {
		if _, err := c.body(); err == nil {
			t.Errorf("%+v accepted", c)
		}
	}
	key := "tk_" + strings.Repeat("a", 24) + "." + strings.Repeat("B", 43)
	c, p, _ := newCore(t, Credential{TrayKey: key}, false)
	if _, _, err := c.Refresh(context.Background(), `PC\bob`, true); err != nil {
		t.Fatal(err)
	}
	if p.calls[0]["trayKey"] != key || p.calls[0]["agentSecret"] != nil || p.calls[0]["localUser"] != `PC\bob` {
		t.Errorf("tray key body: %v", p.calls[0])
	}
}

func TestCoreStateAndChat(t *testing.T) {
	c, p, _ := newCore(t, deviceCred, true)
	st, poll, err := c.Refresh(context.Background(), `PC\bob`, false)
	if err != nil || poll != 10*time.Second {
		t.Fatal(err, poll)
	}
	if st.Business != "Acme" || !st.Chat.Open || st.Chat.Recorded || st.Chat.AutoOpen || len(st.Tools) != 2 {
		t.Errorf("state %+v (a session that is not the console never auto-opens)", st)
	}
	if st, _, _ = c.Refresh(context.Background(), `PC\bob`, true); !st.Chat.AutoOpen {
		t.Error("the console session's tray auto-opens a technician's chat")
	}
	c.Seen([]string{"clx0000000000000000000009", "bad id"})
	_, _, _ = c.Refresh(context.Background(), `PC\bob`, true)
	last := p.calls[len(p.calls)-1]
	if d, _ := last["delivered"].([]any); len(d) != 1 {
		t.Errorf("delivered not reported once: %v", last)
	}
	u, err := c.OpenChat(context.Background(), `PC\bob`)
	if err != nil || u != "https://portal.example.com/assist/open?c="+strings.Repeat("Z", 43) {
		t.Errorf("%q %v", u, err)
	}
	// The secret is in the request to the portal, and nowhere in what the tray is given.
	b, _ := json.Marshal(st)
	if bytes.Contains(b, []byte(deviceCred.Secret)) || strings.Contains(u, deviceCred.Secret) {
		t.Error("the device secret reached the tray")
	}
	// Unreachable: last state, marked offline.
	p.setDown(true)
	st, _, err = c.Refresh(context.Background(), `PC\bob`, true)
	if err == nil || !st.Offline || st.Business != "Acme" || st.Chat.AutoOpen {
		t.Errorf("offline state %+v %v", st, err)
	}
}

func TestCoreSelfHelp(t *testing.T) {
	ctx := context.Background()
	c, p, o := newCore(t, deviceCred, true)
	r := c.SelfHelp(ctx, `PC\bob`, "dns.check")
	if r.Outcome != OutcomeSucceeded || len(p.results) != 1 || p.results[0]["runId"] != "run1" {
		t.Fatalf("%+v %v", r, p.results)
	}
	r = c.SelfHelp(ctx, `PC\bob`, "ip.renew")
	if r.Outcome != OutcomeSucceeded || o.renews != 1 {
		t.Fatalf("%+v", r)
	}
	if r = c.SelfHelp(ctx, `PC\bob`, "cmd.run"); r.Outcome != OutcomeRefused {
		t.Error("unknown tool ran")
	}
	// Containment refused by the portal: nothing runs.
	p.setContained("Paused by your IT provider.")
	if r = c.SelfHelp(ctx, `PC\bob`, "ip.renew"); r.Outcome != OutcomeRefused || o.renews != 1 || !strings.Contains(r.Summary, "Paused") {
		t.Errorf("contained renew: %+v renews=%d", r, o.renews)
	}
	// The signed pause stops an elevated tool before the portal is asked.
	p.setContained("")
	c.SignedPause = func(context.Context, string) (string, error) { return "the signed pause covers this computer", nil }
	before := len(p.paths)
	if r = c.SelfHelp(ctx, `PC\bob`, "dns.flush"); r.Outcome != OutcomeRefused || o.flushes != 0 || len(p.paths) != before {
		t.Errorf("signed pause: %+v", r)
	}
	// Local rate limit: the third renew in 15 minutes is refused here.
	c.SignedPause = nil
	if r = c.SelfHelp(ctx, `PC\bob`, "ip.renew"); r.Outcome != OutcomeSucceeded {
		t.Fatalf("second renew: %+v", r)
	}
	if r = c.SelfHelp(ctx, `PC\bob`, "ip.renew"); r.Outcome != OutcomeRefused || o.renews != 2 {
		t.Errorf("third renew: %+v", r)
	}
	// RustDesk restart: open session, unknown, none.
	o.sessions = 1
	if r = c.SelfHelp(ctx, `PC\bob`, "rustdesk.restart"); r.Outcome != OutcomeRefused || o.restarts != 0 {
		t.Errorf("restart with a session open: %+v", r)
	}
	o.sessions, o.sessErr = 0, errors.New("cannot read")
	if r = c.SelfHelp(ctx, `PC\bob`, "rustdesk.restart"); r.Outcome != OutcomeRefused || o.restarts != 0 {
		t.Errorf("restart when sessions are unknown: %+v", r)
	}
}

func TestStandardNeverRunsElevated(t *testing.T) {
	key := "tk_" + strings.Repeat("a", 24) + "." + strings.Repeat("B", 43)
	c, p, o := newCore(t, Credential{TrayKey: key}, false)
	st, _, _ := c.Refresh(context.Background(), `PC\bob`, true)
	for _, ts := range st.Tools {
		if ts.Elevated {
			t.Errorf("standard tray offered %s", ts.ID)
		}
	}
	for _, id := range []string{"dns.flush", "ip.renew", "rustdesk.restart"} {
		before := len(p.paths)
		if r := c.SelfHelp(context.Background(), `PC\bob`, id); r.Outcome != OutcomeRefused || len(p.paths) != before {
			t.Errorf("%s: %+v", id, r)
		}
	}
	if o.renews+o.flushes+o.restarts != 0 {
		t.Error("an elevated operation ran in the standard tray")
	}
}

func TestOfflineSelfHelp(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(50_000, 0)
	c, p, o := newCore(t, deviceCred, true)
	c.Now = func() time.Time { return now }
	c.SignedPause = func(context.Context, string) (string, error) { return "", nil }
	// Never heard from the portal: no elevated tool offline.
	p.setDown(true)
	if r := c.SelfHelp(ctx, `PC\bob`, "ip.renew"); r.Outcome != OutcomeRefused || o.renews != 0 {
		t.Fatalf("offline without state: %+v", r)
	}
	if r := c.SelfHelp(ctx, `PC\bob`, "dns.check"); r.Outcome != OutcomeSucceeded {
		t.Fatalf("read-only offline: %+v", r)
	}
	p.setDown(false)
	if _, _, err := c.Refresh(ctx, `PC\bob`, true); err != nil {
		t.Fatal(err)
	}
	c.FlushPending(ctx)
	if len(p.results) != 1 || p.results[0]["offline"] != true || p.results[0]["tool"] != "dns.check" {
		t.Fatalf("offline report: %v", p.results)
	}
	// Recent state, signed pause read: an offline renew runs and is reported later.
	_ = c.SelfHelp(ctx, `PC\bob`, "dns.check") // reads the signed pause? no: read-only
	c.pauseAt = now
	p.setDown(true)
	if r := c.SelfHelp(ctx, `PC\bob`, "ip.renew"); r.Outcome != OutcomeSucceeded || o.renews != 1 || c.Pending() != 1 {
		t.Fatalf("offline renew: %+v pending %d", r, c.Pending())
	}
	// Stale state: refused.
	now = now.Add(2 * time.Hour)
	if r := c.SelfHelp(ctx, `PC\bob`, "dns.flush"); r.Outcome != OutcomeRefused || o.flushes != 0 {
		t.Fatalf("stale offline flush: %+v", r)
	}
	p.setDown(false)
	c.FlushPending(ctx)
	if c.Pending() != 0 || p.results[len(p.results)-1]["tool"] != "ip.renew" {
		t.Errorf("pending not flushed: %v", p.results)
	}
	// Cached containment blocks offline too.
	now = time.Unix(90_000, 0)
	p.setContained("Paused.")
	_, _, _ = c.Refresh(ctx, `PC\bob`, true)
	c.pauseAt = now
	p.setDown(true)
	if r := c.SelfHelp(ctx, `PC\bob`, "ip.renew"); r.Outcome != OutcomeRefused {
		t.Errorf("cached containment offline: %+v", r)
	}
}

func TestSupport(t *testing.T) {
	c, p, _ := newCore(t, deviceCred, true)
	c.Sample = func() (*Usage, error) { return BuildUsage(RawUsage{}, time.Unix(0, 0)), nil }
	shot := []byte{0xff, 0xd8, 0xff, 0xe0}
	if _, err := c.Support(context.Background(), `PC\bob`, "  printer\r\nbroken ", true, shot); err != nil {
		t.Fatal(err)
	}
	last := p.calls[len(p.calls)-1]
	if last["description"] != "printer\nbroken" || last["usage"] == nil || last["screenshot"] != base64.StdEncoding.EncodeToString(shot) {
		t.Errorf("%v", last)
	}
	if _, err := c.Support(context.Background(), `PC\bob`, "again", false, nil); err != nil {
		t.Fatal(err)
	}
	if last = p.calls[len(p.calls)-1]; last["usage"] != nil || last["screenshot"] != nil {
		t.Errorf("unchecked boxes sent data: %v", last)
	}
	if _, err := c.Support(context.Background(), `PC\bob`, "third", false, nil); !errors.Is(err, ErrLimited) {
		t.Errorf("third from one user in an hour: %v", err)
	}
	if _, err := c.Support(context.Background(), `PC\amy`, "x", false, make([]byte, MaxScreenshotBytes+1)); err == nil {
		t.Error("oversized screenshot accepted")
	}
}

// ── Host ↔ tray over pipes ───────────────────────────────────────────────────

func TestServeAndPipeBackend(t *testing.T) {
	c, p, o := newCore(t, deviceCred, true)
	downR, downW := io.Pipe() // host → tray
	upR, upW := io.Pipe()     // tray → host
	nonce := NewNonce()
	sess := Session{ID: 2, User: `PC\bob`, Console: true}
	hostErr := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		r := NewReader(upR)
		if err := Attach(r, nonce); err != nil {
			hostErr <- err
			return
		}
		hostErr <- Serve(ctx, c, sess, r, downW, nil)
	}()
	b, err := NewPipeBackend(downR, upW, nonce, func() { upW.Close(); downR.Close() })
	if err != nil {
		t.Fatal(err)
	}
	states := make(chan State, 4)
	b.Start(func(s State) { states <- s })
	select {
	case s := <-states:
		if s.Business != "Acme" || !s.Chat.AutoOpen {
			t.Errorf("state %+v", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no state")
	}
	u, err := b.OpenChat(ctx)
	if err != nil || !strings.HasPrefix(u, "https://portal.example.com/assist/open?c=") {
		t.Fatalf("%q %v", u, err)
	}
	if r, err := b.SelfHelp(ctx, "dns.flush"); err != nil || r.Outcome != OutcomeSucceeded || o.flushes != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	if err := b.Support(ctx, "help", false, nil); err != nil {
		t.Fatal(err)
	}
	// The user is the host's, never the tray's: every portal call names PC\bob.
	for _, call := range p.calls {
		if call["localUser"] != `PC\bob` || call["agentSecret"] != deviceCred.Secret {
			t.Errorf("call %v", call)
		}
	}
	// A frame the tray may not send closes the connection.
	_, _ = upW.Write([]byte(`{"t":"selfhelp","id":"0011aabb","tool":"cmd.run"}` + "\n"))
	select {
	case err := <-hostErr:
		if !errors.Is(err, ErrFrame) {
			t.Errorf("host ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("host kept serving after a refused frame")
	}
}

func TestAttachNeedsTheNonce(t *testing.T) {
	nonce := NewNonce()
	for name, line := range map[string]string{
		"wrong nonce": `{"t":"hello","nonce":"` + NewNonce() + `"}`,
		"no hello":    `{"t":"code","id":"0011aabb"}`,
	} {
		if err := Attach(NewReader(strings.NewReader(line+"\n")), nonce); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if err := Attach(NewReader(strings.NewReader(`{"t":"hello","nonce":"`+nonce+`"}`+"\n")), nonce); err != nil {
		t.Error(err)
	}
}

func TestProtocolVersionMatchesAgent(t *testing.T) {
	if agent.TrayProtocol != ProtocolVersion {
		t.Fatalf("agent reports tray %d, tray speaks %d", agent.TrayProtocol, ProtocolVersion)
	}
}
