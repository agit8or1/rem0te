package enforce

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/msa"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa/grant"
)

// fakeRustdesk is RustDesk's command line as the 0.68.3 lab saw it on
// 1.4.1–1.5.3: --option KEY prints the value (nothing for a default, which
// RustDesk removes), --option KEY VALUE sets it, --password prints Done!.
type fakeRustdesk struct {
	opts     map[string]string
	calls    [][]string
	ignore   map[string]bool // a set of this key does nothing (readback mismatch)
	noDone   bool            // --password prints nothing
	password string
	stopSeq  []string
	failRead map[string]bool
}

var defaults = map[string]string{
	"enable-keyboard": "Y", "enable-clipboard": "Y", "enable-file-transfer": "Y", "enable-audio": "Y",
	"enable-tunnel": "Y", "enable-remote-restart": "Y", "allow-auto-disconnect": "N",
	"verification-method": "use-both-passwords", "stop-service": "N",
	"enable-terminal": "Y", "enable-camera": "Y", "enable-remote-printer": "Y",
	"enable-block-input": "Y", "enable-privacy-mode": "Y", "enable-record-session": "Y",
}

func newFake() *fakeRustdesk {
	return &fakeRustdesk{opts: map[string]string{"access-mode": "full", "approve-mode": "password-click"}, ignore: map[string]bool{}, failRead: map[string]bool{}}
}

func (f *fakeRustdesk) Run(_ context.Context, args []string) Result {
	if !Valid(args) {
		return Result{Err: errors.New("fake: invalid args")}
	}
	f.calls = append(f.calls, append([]string(nil), args...))
	switch {
	case args[0] == "--password":
		f.password = args[1]
		if f.noDone {
			return Result{}
		}
		return Result{Stdout: []byte("Done!\r\n")}
	case len(args) == 2:
		if f.failRead[args[1]] {
			return Result{ExitCode: 1}
		}
		return Result{Stdout: []byte(f.opts[args[1]] + "\r\n")}
	default:
		k, v := args[1], args[2]
		if k == "stop-service" {
			f.stopSeq = append(f.stopSeq, v)
		}
		if f.ignore[k] {
			return Result{}
		}
		if v == "" || defaults[k] == v {
			delete(f.opts, k)
		} else {
			f.opts[k] = v
		}
		return Result{}
	}
}

func (f *fakeRustdesk) passwordCalls() int {
	n := 0
	for _, c := range f.calls {
		if c[0] == "--password" {
			n++
		}
	}
	return n
}

func newEnforcer(f *fakeRustdesk) *Enforcer {
	return &Enforcer{R: f, Sleep: func(time.Duration) {}}
}

// ── args ────────────────────────────────────────────────────────────────────

func TestKeysAreThePreflightsThenLocked(t *testing.T) {
	if !reflect.DeepEqual(Keys[:len(msa.Keys)], msa.Keys) || len(msa.Keys) != 11 || !reflect.DeepEqual(Keys[11:], Locked) || len(Keys) != 17 {
		t.Fatalf("keys %v", Keys)
	}
	if !reflect.DeepEqual(Locked, []string{"enable-terminal", "enable-camera", "enable-remote-printer", "enable-block-input", "enable-privacy-mode", "enable-record-session"}) {
		t.Fatalf("locked %v", Locked)
	}
	for _, k := range order {
		if !isKey(k) {
			t.Fatalf("order names %s", k)
		}
	}
	if len(order) != len(Keys) {
		t.Fatal("order must name every key")
	}
}

func TestArgsAreClosed(t *testing.T) {
	refused := [][]string{
		SetArgs("custom-rendezvous-server", "evil"), SetArgs("access-mode", "full"), RestoreArgs("access-mode", "full"),
		SetArgs("enable-terminal", "Y"), SetArgs("enable-privacy-mode", ""), SetArgs("access-mode", ""), SetArgs("verification-method", "use-temporary-password"),
		SetArgs("allow-auto-disconnect", "N"), SetArgs("auto-disconnect-timeout", "0"), SetArgs("auto-disconnect-timeout", "121"),
		SetArgs("enable-keyboard", "Y N"), RestoreArgs("access-mode", "a b"), RestoreArgs("password", "x"),
		PasswordArgs("short"), PasswordArgs("ZZZZyyyyXXXXwwww0000111!"), PasswordArgs("ZZZZyyyyXXXXwwww00001111 --x"),
		ReadArgs("password"),
	}
	for i, a := range refused {
		if a != nil {
			t.Fatalf("case %d built %v", i, a)
		}
	}
	for _, a := range [][]string{
		{"--option", "access-mode", "view"}, {"--option", "auto-disconnect-timeout", "10"}, {"--password", "ZZZZyyyyXXXXwwww00001111"},
		{"--option", "stop-service", "Y"}, {"--option", "stop-service", "N"}, {"--option", "stop-service"}, {"--option", "enable-audio"},
		{"--option", "approve-mode", "password-click"}, {"--option", "access-mode", "custom"}, {"--option", "enable-terminal", "N"},
		{"--option", "enable-record-session"}, {"--option", "access-mode", ""}, {"--option", "enable-camera", "Y"},
	} {
		if !Valid(a) {
			t.Fatalf("%v should be valid", a)
		}
	}
	for _, a := range [][]string{
		{"--get-id"}, {"--option", "stop-service", "X"}, {"--password", "x"}, {"--config", "x"}, {"--option", "custom-rendezvous-server", "x"},
		{"--option", "access-mode", "view", "extra"}, {"--cm"}, {"--option"}, {},
		{"--option", "access-mode", "full"}, {"--option", "enable-file-copy-paste", "N"}, {"--option", "enable-perm-change-in-accept-window"},
	} {
		if Valid(a) {
			t.Fatalf("%v should be refused", a)
		}
	}
}

// ── signing ─────────────────────────────────────────────────────────────────

type signer struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	kid  string
}

func newSigner(t *testing.T) signer {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{pub, priv, grant.KeyID(pub)}
}

const (
	epID  = "cmtestendpoint000000000009"
	rid   = "555666777"
	bizID = "cmtestbusiness000000000009"
)

var t0 = time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)

func baseGrant(id string) grant.Grant {
	return grant.Grant{V: 1, GrantID: id, EndpointID: epID, RustdeskID: rid, BusinessID: bizID, TechnicianID: "cmtesttechnician0000000009",
		Mode: "view", Consent: "required", NotBefore: "2026-11-20T10:00:00Z", NotAfter: "2026-11-20T10:05:00Z",
		MaxMinutes: 30, IdleMinutes: 10, Password: "ZZZZyyyyXXXXwwww00001111"}
}

func (s signer) envelope(g grant.Grant) json.RawMessage {
	body := grant.Canonical(&g)
	sig := ed25519.Sign(s.priv, append([]byte(grant.Prefix), body...))
	env, _ := json.Marshal(map[string]string{"keyId": s.kid, "grant": base64.StdEncoding.EncodeToString(body), "sig": base64.StdEncoding.EncodeToString(sig)})
	return env
}

// ── apply ───────────────────────────────────────────────────────────────────

func TestApplySetsReadsBackThenPassword(t *testing.T) {
	f := newFake()
	g := baseGrant("00112233445566778899aabbccddeeff")
	out := newEnforcer(f).Apply(context.Background(), &g)
	if !out.OK {
		t.Fatalf("apply: %+v", out)
	}
	want := map[string]string{"verification-method": "use-permanent-password", "access-mode": "view", "enable-keyboard": "N",
		"enable-clipboard": "N", "enable-file-transfer": "N", "enable-audio": "N", "enable-tunnel": "N", "enable-remote-restart": "N",
		"enable-terminal": "N", "enable-camera": "N", "enable-remote-printer": "N", "enable-block-input": "N", "enable-privacy-mode": "N",
		"enable-record-session": "N", "approve-mode": "click", "allow-auto-disconnect": "Y", "auto-disconnect-timeout": "10"}
	if !reflect.DeepEqual(f.opts, want) {
		t.Fatalf("options %v", f.opts)
	}
	if f.password != g.Password {
		t.Fatal("one-time password not set")
	}
	last := f.calls[len(f.calls)-1]
	if last[0] != "--password" {
		t.Fatalf("the password must be the last call, got %v", last)
	}
	if first := f.calls[0]; first[1] != "verification-method" {
		t.Fatalf("the verification method must be first, got %v", first)
	}
}

func TestReadbackMismatchFailsClosed(t *testing.T) {
	f := newFake()
	f.ignore["access-mode"] = true // RustDesk keeps full access
	g := baseGrant("00112233445566778899aabbccddeeff")
	out := newEnforcer(f).Apply(context.Background(), &g)
	if out.OK || out.Code != ReadbackMismatch || !reflect.DeepEqual(out.Keys, []string{"access-mode"}) {
		t.Fatalf("outcome %+v", out)
	}
	if f.password == g.Password {
		t.Fatal("the grant's password must never be set after a mismatch")
	}
	if f.password == "" || !reflect.DeepEqual(f.stopSeq, []string{"Y", "N"}) {
		t.Fatalf("the session must be ended (random password, stop Y then N): pw=%v stop=%v", f.password != "", f.stopSeq)
	}
}

func TestPasswordWithoutDoneFails(t *testing.T) {
	f := newFake()
	f.noDone = true
	g := baseGrant("00112233445566778899aabbccddeeff")
	out := newEnforcer(f).Apply(context.Background(), &g)
	if out.OK || out.Code != PasswordNotApplied || !reflect.DeepEqual(out.Keys, []string{"password"}) {
		t.Fatalf("outcome %+v", out)
	}
}

func TestEmptyReadbackMeansDefault(t *testing.T) {
	if !Matches("enable-keyboard", "", "Y") || Matches("enable-keyboard", "", "N") || Matches("access-mode", "", "view") ||
		!Matches("allow-auto-disconnect", "", "N") || Matches("allow-auto-disconnect", "", "Y") ||
		!Matches("access-mode", "", "custom") || !Matches("enable-terminal", "", "Y") || Matches("enable-terminal", "", "N") {
		t.Fatal("empty readback table")
	}
}

func TestRandomPassword(t *testing.T) {
	a, b := RandomPassword(), RandomPassword()
	if PasswordArgs(a) == nil || a == b {
		t.Fatalf("random passwords %q %q", a, b)
	}
}

// ── the poller ──────────────────────────────────────────────────────────────

type fakePortal struct {
	answers []PollAnswer
	reports []Report
	acks    [][]string
	stopAt  int
}

func (p *fakePortal) Poll(_ context.Context, ack []string, _ bool) (PollAnswer, error) {
	p.acks = append(p.acks, ack)
	if len(p.answers) == 0 {
		return PollAnswer{}, ErrStop
	}
	a := p.answers[0]
	p.answers = p.answers[1:]
	return a, nil
}

func (p *fakePortal) Report(_ context.Context, r Report) error {
	for _, k := range r.Keys {
		if k == "password" {
			continue
		}
	}
	p.reports = append(p.reports, r)
	return nil
}

func (p *fakePortal) events() []string {
	var out []string
	for _, r := range p.reports {
		s := r.Event
		if r.Outcome != "" {
			s += ":" + r.Outcome
		}
		out = append(out, s)
	}
	return out
}

type fakeHost struct {
	keys     map[string]ed25519.PublicKey
	paused   bool
	sessions []int // successive answers; the last repeats
	trustErr error
}

func (h *fakeHost) RustdeskID(context.Context) (string, error) { return rid, nil }
func (h *fakeHost) Sessions() (int, error) {
	if len(h.sessions) == 0 {
		return 0, nil
	}
	n := h.sessions[0]
	if len(h.sessions) > 1 {
		h.sessions = h.sessions[1:]
	}
	return n, nil
}
func (h *fakeHost) Trust(context.Context) (map[string]ed25519.PublicKey, func(string, string) bool, error) {
	if h.trustErr != nil {
		return nil, nil, h.trustErr
	}
	return h.keys, func(string, string) bool { return h.paused }, nil
}

type memStore struct {
	state *State
	saved *Saved
	seen  map[string]time.Time
	saves int
}

func (m *memStore) LoadState() (*State, error)              { return m.state, nil }
func (m *memStore) SaveState(s *State) error                { c := *s; m.state = &c; return nil }
func (m *memStore) LoadSaved() (*Saved, error)              { return m.saved, nil }
func (m *memStore) SaveSaved(s *Saved) error                { m.saved = s; m.saves++; return nil }
func (m *memStore) DeleteSaved() error                      { m.saved = nil; return nil }
func (m *memStore) LoadSeen() (map[string]time.Time, error) { return m.seen, nil }
func (m *memStore) SaveSeen(s map[string]time.Time) error {
	m.seen = map[string]time.Time{}
	for k, v := range s {
		m.seen[k] = v
	}
	return nil
}

type rig struct {
	f      *fakeRustdesk
	portal *fakePortal
	host   *fakeHost
	store  *memStore
	clock  time.Time
	p      *Poller
}

func newRig(t *testing.T, s signer) *rig {
	r := &rig{f: newFake(), portal: &fakePortal{}, host: &fakeHost{keys: map[string]ed25519.PublicKey{s.kid: s.pub}}, store: &memStore{}, clock: t0.Add(time.Minute)}
	r.p = &Poller{E: newEnforcer(r.f), P: r.portal, H: r.host, S: r.store,
		Now: func() time.Time { return r.clock }, Wait: func(_ context.Context, d time.Duration) { r.clock = r.clock.Add(d) }}
	return r
}

func managed(state string, grants ...json.RawMessage) PollAnswer {
	return PollAnswer{EndpointID: epID, Managed: &ManagedAnswer{State: state, Rollback: state == "rollback_pending"}, Grants: grants}
}

func (r *rig) run(t *testing.T) {
	t.Helper()
	if err := r.p.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
}

func TestLegacyDoesNothing(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.portal.answers = []PollAnswer{{EndpointID: epID}} // managed: null
	r.run(t)
	if len(r.f.calls) != 0 || len(r.portal.reports) != 0 || r.store.saved != nil {
		t.Fatalf("a Legacy computer must see no RustDesk call: %v %v", r.f.calls, r.portal.reports)
	}
	r = newRig(t, s)
	r.run(t) // ErrStop at once (MSA off)
	if len(r.f.calls) != 0 {
		t.Fatal("MSA off: no RustDesk call")
	}
}

func TestTestSessionPendingFullCycle(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	before := map[string]string{}
	for k, v := range r.f.opts {
		before[k] = v
	}
	g := baseGrant("00112233445566778899aabbccddeeff")
	r.host.sessions = []int{1, 1, 0}
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(g)), managed("pending"), managed("pending"), managed("pending"), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"received", "applied", "connected", "ended:disconnected"}) {
		t.Fatalf("events %v", got)
	}
	if r.store.saved == nil || r.store.saves != 1 || r.store.saved.Values["access-mode"] != "full" {
		t.Fatalf("saved %+v", r.store.saved)
	}
	// Pending: the saved settings went back after the session — all but
	// access-mode full, which goes back as RustDesk's default (F1).
	delete(before, "access-mode")
	if !reflect.DeepEqual(r.f.opts, before) {
		t.Fatalf("pending computer not restored between test sessions: %v", r.f.opts)
	}
	if r.f.password == g.Password {
		t.Fatal("after the session the one-time password must be gone")
	}
	if r.store.state.EndpointID != epID {
		t.Fatal("endpoint id not pinned")
	}
	if !r.store.seen[g.GrantID].After(t0) {
		t.Fatal("grant not in the replay set")
	}
	if len(r.portal.acks) < 2 || !reflect.DeepEqual(r.portal.acks[1], []string{g.GrantID}) {
		t.Fatalf("acks %v", r.portal.acks)
	}
	for _, rep := range r.portal.reports {
		b, _ := json.Marshal(rep)
		if strings.Contains(string(b), g.Password) {
			t.Fatal("a report carried the password")
		}
	}
}

func TestReplayRefused(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	g := baseGrant("00112233445566778899aabbccddeeff")
	r.store.seen = map[string]time.Time{g.GrantID: t0.Add(time.Hour)}
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(g)), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"failed:replayed"}) {
		t.Fatalf("events %v", got)
	}
	if len(r.f.calls) != 0 {
		t.Fatal("a replayed grant must change nothing")
	}
}

func TestBadKeyAndNoKeysRefused(t *testing.T) {
	s, other := newSigner(t), newSigner(t)
	r := newRig(t, s)
	g := baseGrant("00112233445566778899aabbccddeeff")
	r.portal.answers = []PollAnswer{managed("pending", other.envelope(g)), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"failed:unknown_key"}) || len(r.f.calls) != 0 {
		t.Fatalf("events %v calls %v", got, r.f.calls)
	}
	r = newRig(t, s)
	r.host.trustErr = errors.New("target not listed")
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(g)), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"failed:no_keys"}) || len(r.f.calls) != 0 {
		t.Fatalf("events %v", got)
	}
}

func TestCeilingAndPauseRefused(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	// 0.73: control with clipboard, files and audio is inside the ceiling;
	// a tunnel or a remote restart never is.
	g := baseGrant("00112233445566778899aabbccddeeff")
	g.Mode = "control"
	g.Permissions.Tunnel = true
	g2 := baseGrant("00112233445566778899aabbccddee00")
	g2.Mode = "control"
	g2.Permissions.Restart = true
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(g), s.envelope(g2)), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"failed:permission_not_allowed", "failed:permission_not_allowed"}) || len(r.f.calls) != 0 {
		t.Fatalf("events %v", got)
	}
	r = newRig(t, s)
	r.host.paused = true
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(baseGrant("00112233445566778899aabbccddeeff"))), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"failed:remote_paused"}) || len(r.f.calls) != 0 {
		t.Fatalf("events %v", got)
	}
}

func TestWrongEndpointPinRefused(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.store.state = &State{Schema: StateSchema, EndpointID: "cmotherendpoint00000000009"}
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(baseGrant("00112233445566778899aabbccddeeff")))}
	if err := r.p.Run(context.Background()); err == nil {
		t.Fatal("a changed endpoint id must stop the poller")
	}
	if len(r.f.calls) != 0 {
		t.Fatal("nothing applied under another endpoint id")
	}
}

func TestReadbackMismatchReported(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.f.ignore["enable-clipboard"] = true
	r.f.opts["enable-clipboard"] = "Y"
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(baseGrant("00112233445566778899aabbccddeeff"))), {EndpointID: epID}}
	r.run(t)
	if len(r.portal.reports) != 2 || r.portal.reports[0].Event != "received" || r.portal.reports[1].Outcome != ReadbackMismatch || !reflect.DeepEqual(r.portal.reports[1].Keys, []string{"enable-clipboard"}) {
		t.Fatalf("reports %+v", r.portal.reports)
	}
}

func TestSaveFailsClosed(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.f.failRead["approve-mode"] = true
	r.portal.answers = []PollAnswer{managed("pending", s.envelope(baseGrant("00112233445566778899aabbccddeeff"))), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"received", "failed:save_failed"}) {
		t.Fatalf("events %v", got)
	}
	for _, c := range r.f.calls {
		if len(c) == 3 || c[0] == "--password" {
			t.Fatalf("nothing may be set when the save failed: %v", c)
		}
	}
}

func TestNoConnectionAndMaxMinutes(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.portal.answers = []PollAnswer{managed("verified", s.envelope(baseGrant("00112233445566778899aabbccddeeff")))}
	for i := 0; i < 200; i++ {
		r.portal.answers = append(r.portal.answers, managed("verified"))
	}
	r.portal.answers = append(r.portal.answers, PollAnswer{EndpointID: epID})
	r.run(t)
	ev := r.portal.events()
	if len(ev) < 4 || ev[0] != "secured" || ev[1] != "received" || ev[2] != "applied" || ev[3] != "ended:no_connection" {
		t.Fatalf("events %v", ev)
	}
	r = newRig(t, s)
	r.host.sessions = []int{1}
	r.portal.answers = []PollAnswer{managed("verified", s.envelope(baseGrant("00112233445566778899aabbccddeeff")))}
	for i := 0; i < 400; i++ {
		r.portal.answers = append(r.portal.answers, managed("verified"))
	}
	r.portal.answers = append(r.portal.answers, PollAnswer{EndpointID: epID})
	r.run(t)
	ev = r.portal.events()
	if len(ev) < 5 || ev[3] != "connected" || ev[4] != "ended:max_minutes" {
		t.Fatalf("events %v", ev)
	}
	// Verified: the managed settings stay after the session (no restore), with a password nobody is told.
	if r.f.opts["access-mode"] != "view" || r.f.password == baseGrant("").Password {
		t.Fatalf("verified computer after session: %v", r.f.opts)
	}
}

func TestRollbackRestores(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	before := map[string]string{}
	for k, v := range r.f.opts {
		before[k] = v
	}
	r.host.sessions = []int{1}
	r.portal.answers = []PollAnswer{managed("verified", s.envelope(baseGrant("00112233445566778899aabbccddeeff"))), managed("rollback_pending"), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"secured", "received", "applied", "connected", "ended:rollback", "restored"}) {
		t.Fatalf("events %v", got)
	}
	delete(before, "access-mode") // full goes back as RustDesk's default (F1)
	if !reflect.DeepEqual(r.f.opts, before) || r.store.saved != nil {
		t.Fatalf("not restored: %v saved=%v", r.f.opts, r.store.saved)
	}
}

func TestRollbackRestoreFailed(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.store.saved = &Saved{Schema: SavedSchema, Values: map[string]string{}}
	for _, k := range Keys {
		r.store.saved.Values[k] = ""
	}
	r.store.saved.Values["access-mode"] = "custom"
	r.f.ignore["access-mode"] = true
	r.f.opts["access-mode"] = "view"
	r.portal.answers = []PollAnswer{managed("rollback_pending"), {EndpointID: epID}}
	r.run(t)
	if len(r.portal.reports) != 1 || r.portal.reports[0].Event != "restore_failed" || !reflect.DeepEqual(r.portal.reports[0].Keys, []string{"access-mode"}) {
		t.Fatalf("reports %+v", r.portal.reports)
	}
	if r.store.saved == nil {
		t.Fatal("the saved settings must be kept after a failed restore")
	}
}

func TestRestCheckDrift(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.store.state = &State{Schema: StateSchema, EndpointID: epID, Secured: true, Applied: Desired(func() *grant.Grant { g := baseGrant(""); return &g }())}
	if bad := newEnforcer(r.f).Set(context.Background(), r.store.state.Applied); len(bad) != 0 {
		t.Fatal(bad)
	}
	r.f.calls = nil
	r.portal.answers = []PollAnswer{managed("verified"), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"checked"}) {
		t.Fatalf("events %v", got)
	}
	r.f.opts["access-mode"] = "full"
	r.p.lastRB = time.Time{}
	r.portal.answers = []PollAnswer{managed("verified"), {EndpointID: epID}}
	r.portal.reports = nil
	r.run(t)
	if len(r.portal.reports) != 1 || r.portal.reports[0].Event != "drift" || !reflect.DeepEqual(r.portal.reports[0].Keys, []string{"access-mode"}) {
		t.Fatalf("reports %+v", r.portal.reports)
	}
	if r.f.opts["access-mode"] != "view" {
		t.Fatal("drift must be corrected")
	}
}

func TestGrantKeysFile(t *testing.T) {
	s := newSigner(t)
	doc := `{"schema":"rem0te-msa-grant-keys/1","keys":[{"keyId":"` + s.kid + `","publicKey":"` + base64.StdEncoding.EncodeToString(s.pub) + `"}]}`
	keys, err := grant.ParseKeys([]byte(doc))
	if err != nil || len(keys) != 1 || !keys[s.kid].Equal(s.pub) {
		t.Fatalf("parse: %v", err)
	}
	for _, bad := range []string{
		strings.Replace(doc, s.kid, "0000000000000000", 1),
		strings.Replace(doc, "grant-keys/1", "grant-keys/2", 1),
		strings.Replace(doc, `"keys"`, `"extra":1,"keys"`, 1),
		doc + "x",
		`{"schema":"rem0te-msa-grant-keys/1"}`,
	} {
		if _, err := grant.ParseKeys([]byte(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}
