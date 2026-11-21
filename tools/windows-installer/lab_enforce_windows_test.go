//go:build windows && labwindows

package main

// The Windows lab (0.72.0): Managed Secure Access enforcement against the
// RustDesk release the lab's RustDesk job installed, through the agent's own
// enforcement exec site (enforceRunner) and enforce.Enforcer — the code the
// msa-poller runs. One cycle, in order:
//
//   save every setting → apply a view-only grant (every setting set and read
//   back, then the one-time password, which must print "Done") → read back
//   again → end the session (a random password nobody is told, stop-service
//   Y, a pause, N, read back N) → restore the saved settings and read them
//   back.
//
// Twice: as the runner's elevated administrator (this process), and as
// SYSTEM in session 0 — this same test binary started by a scheduled task
// with -lab-enforce-out, writing its result to a file this process reads.
//
// 0.73 adds, in the same cycle: a control grant inside the 0.73 ceiling
// (clipboard, file transfer and audio Y; tunnel and remote restart N, read
// back), and a revocation — the agent's own enforce.Poller, with a stand-in
// portal and host and an in-process test key, applies a control grant to the
// real RustDesk, then verifies a signed revocation naming it and ends the
// session (a password nobody is told, stop-service Y then N) — before the
// saved settings are restored.
//
// 0.78.1 (F1) adds, for both grants: access-mode reads view or custom
// (never full), every Locked permission reads N, and the effective
// permissions — RustDesk's own rule (enforce.Effective) over every
// permission option as RustDesk reports it — are exactly what the grant and
// the ceiling allow (labEffective).
//
// What it does not cover: the real portal and long-poll, the signed key
// chain (internal/msa/enforce's unit tests), and a real remote connection —
// so what a connecting technician is actually permitted is derived, not
// observed (labEffective says why).

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/labevidence"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa/enforce"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa/grant"
)

var labEnforceOut = flag.String("lab-enforce-out", "", "lab only: run the enforcement cycle and write the result here")

type enforceCycle struct {
	OK    bool     `json:"ok"`
	Steps []string `json:"steps"`
	Err   string   `json:"err,omitempty"`
}

func runEnforceCycle(ctx context.Context) enforceCycle {
	var c enforceCycle
	step := func(f string, a ...any) { c.Steps = append(c.Steps, fmt.Sprintf(f, a...)) }
	fail := func(f string, a ...any) enforceCycle { c.Err = fmt.Sprintf(f, a...); return c }
	e := &enforce.Enforcer{R: enforceRunner{exe: installedRustdeskExe()}}

	saved, err := e.ReadAll(ctx)
	if err != nil {
		return fail("save: %v", err)
	}
	step("saved %d settings", len(saved))

	g := grant.Grant{V: 1, GrantID: "00112233445566778899aabbccddeeff", Mode: "view", Consent: "required",
		MaxMinutes: 30, IdleMinutes: 10, Password: enforce.RandomPassword()}
	if out := e.Apply(ctx, &g); !out.OK {
		_ = e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved})
		return fail("apply: %s %v", out.Code, out.Keys)
	}
	step("applied a view-only grant: %d settings read back, one-time password set (Done)", len(enforce.Keys))
	if bad := e.Check(ctx, enforce.Desired(&g)); len(bad) > 0 {
		return fail("second readback: %v", bad)
	}
	step("a second readback agreed")
	if msg, err := labEffective(ctx, e, &g); err != nil {
		_ = e.EndSession(ctx)
		_ = e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved})
		return fail("view effective: %v", err)
	} else {
		step("%s", msg)
	}

	start := time.Now()
	if err := e.EndSession(ctx); err != nil {
		return fail("end session: %v", err)
	}
	step("ended the session in %s: random password, stop-service Y then N, read back N", time.Since(start).Round(time.Millisecond))

	// 0.73: a control grant inside the ceiling.
	cg := grant.Grant{V: 1, GrantID: "00112233445566778899aabbccddee01", Mode: "control", Consent: "not_required",
		Permissions: grant.Permissions{Clipboard: true, Files: true, Audio: true}, MaxMinutes: 30, IdleMinutes: 10, Password: enforce.RandomPassword()}
	if out := e.Apply(ctx, &cg); !out.OK {
		_ = e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved})
		return fail("apply control: %s %v", out.Code, out.Keys)
	}
	// 0.78.1 (F1): access-mode reads custom (never full), every Locked
	// permission reads N, and RustDesk's own rule over what it reports
	// grants exactly what the grant and the ceiling allow.
	want := map[string]string{"access-mode": "custom", "enable-keyboard": "Y", "enable-clipboard": "Y", "enable-file-transfer": "Y",
		"enable-audio": "Y", "enable-tunnel": "N", "enable-remote-restart": "N", "approve-mode": "password"}
	for _, k := range enforce.Locked {
		want[k] = "N"
	}
	for k, v := range want {
		got, ok := e.Read(ctx, k)
		if !ok || !enforce.Matches(k, got, v) {
			_ = e.EndSession(ctx)
			_ = e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved})
			return fail("control readback %s = %q, want %q", k, got, v)
		}
	}
	step("applied a control grant: access-mode custom; clipboard, file transfer and audio Y; tunnel, remote restart, terminal, camera, remote printer, block-input, privacy mode and recording N; read back")
	if msg, err := labEffective(ctx, e, &cg); err != nil {
		_ = e.EndSession(ctx)
		_ = e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved})
		return fail("control effective: %v", err)
	} else {
		step("%s", msg)
	}
	if err := e.EndSession(ctx); err != nil {
		return fail("end control session: %v", err)
	}

	// 0.73: a revocation through the agent's own poller.
	if err := labRevocationCycle(ctx, e); err != nil {
		_ = e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved})
		return fail("revocation: %v", err)
	}
	step("the poller applied a control grant, verified a signed revocation naming it and ended the session: random password, stop-service Y then N")

	if bad := e.Restore(ctx, &enforce.Saved{Schema: enforce.SavedSchema, Values: saved}); len(bad) > 0 {
		return fail("restore: %v", bad)
	}
	again, err := e.ReadAll(ctx)
	if err != nil {
		return fail("read after restore: %v", err)
	}
	for _, k := range enforce.Keys {
		if !enforce.Matches(k, again[k], saved[k]) {
			return fail("after restore %s reads %q, saved %q", k, again[k], saved[k])
		}
	}
	step("restored and read back every saved setting")
	c.OK = true
	return c
}

// labEffective (0.78.1, F1) reads access-mode and every RustDesk permission
// option back from the running RustDesk — `--option KEY` answers from the
// service's own option table over its IPC, the table the connection code
// consults — and evaluates them with enforce.Effective, the port of
// RustDesk's own rule (full: every permission; view: none; anything else:
// each enable-* key, on unless N). The answer must be exactly what the grant
// and the Ceiling allow.
//
// This is the effective state as RustDesk's rule derives it from what
// RustDesk reports, not a connection: RustDesk 1.4.1–1.5.3 has no command
// line or documented IPC that answers "what would a connection be allowed",
// and the lab has no second RustDesk to connect from (no headless login).
func labEffective(ctx context.Context, e *enforce.Enforcer, g *grant.Grant) (string, error) {
	got := map[string]string{}
	for _, k := range append([]string{"access-mode"}, enforce.Permissions...) {
		v, ok := e.Read(ctx, k)
		if !ok {
			return "", fmt.Errorf("%s did not read", k)
		}
		got[k] = v
	}
	if got["access-mode"] == "full" {
		return "", fmt.Errorf("access-mode reads full")
	}
	if over := enforce.Beyond(g, got); len(over) > 0 {
		return "", fmt.Errorf("RustDesk would also allow %v (read %v)", over, got)
	}
	eff, allowed := enforce.Effective(got), enforce.Allowed(g)
	var on []string
	for _, k := range enforce.Permissions {
		if eff[k] != allowed[k] {
			return "", fmt.Errorf("%s effective %v, the grant allows %v", k, eff[k], allowed[k])
		}
		if eff[k] {
			on = append(on, k)
		}
	}
	return fmt.Sprintf("%s grant, effective by RustDesk's rule over what it reports: access-mode %q, %d permissions read, on: %v; every other permission off",
		g.Mode, got["access-mode"], len(enforce.Permissions), on), nil
}

// TestLabRustdeskEnforceChild is the SYSTEM half: it runs only when the
// scheduled task passes -lab-enforce-out.
func TestLabRustdeskEnforceChild(t *testing.T) {
	if *labEnforceOut == "" {
		t.Skip("started by TestLabRustdeskEnforce/system only")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	b, _ := json.Marshal(runEnforceCycle(ctx))
	if err := os.WriteFile(*labEnforceOut+".new", b, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(*labEnforceOut+".new", *labEnforceOut); err != nil {
		t.Fatal(err)
	}
}

func TestLabRustdeskEnforce(t *testing.T) {
	labevidence.Require(t)
	want := os.Getenv("REM0TE_LAB_RUSTDESK")
	if want == "" {
		t.Skip("REM0TE_LAB_RUSTDESK is not set: no RustDesk installed by the lab here")
	}
	report := func(t *testing.T, n *labevidence.Note, c enforceCycle) {
		for _, s := range c.Steps {
			n.Logf("%s", s)
		}
		if !c.OK {
			t.Errorf("enforcement cycle failed: %s", c.Err)
		}
	}

	t.Run("admin", func(t *testing.T) {
		n := labevidence.Track(t, "agent/msa-enforce/"+want+"/admin")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		report(t, n, runEnforceCycle(ctx))
	})

	t.Run("system", func(t *testing.T) {
		n := labevidence.Track(t, "agent/msa-enforce/"+want+"/system")
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(os.Getenv("ProgramData"), "Rem0te", "lab-msa-enforce.json")
		_ = os.MkdirAll(filepath.Dir(out), 0o755)
		_ = os.Remove(out)
		schtasks := filepath.Join(os.Getenv("SystemRoot"), "System32", "schtasks.exe")
		task := "LabRem0teMsaEnforce"
		run := func(args ...string) {
			o, err := exec.Command(schtasks, args...).CombinedOutput()
			if err != nil {
				t.Fatalf("schtasks %v: %v %s", args, err, o)
			}
		}
		_ = exec.Command(schtasks, "/Delete", "/TN", task, "/F").Run()
		tr := fmt.Sprintf(`"%s" -test.run ^TestLabRustdeskEnforceChild$ -lab-enforce-out "%s"`, self, out)
		run("/Create", "/TN", task, "/TR", tr, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F")
		defer run("/Delete", "/TN", task, "/F")
		run("/Run", "/TN", task)
		deadline := time.Now().Add(6 * time.Minute)
		var raw []byte
		for time.Now().Before(deadline) {
			if b, err := os.ReadFile(out); err == nil {
				raw = b
				break
			}
			time.Sleep(2 * time.Second)
		}
		if raw == nil {
			t.Fatalf("no %s within 6 minutes", out)
		}
		var c enforceCycle
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("result: %v", err)
		}
		n.Logf("as SYSTEM (scheduled task, session 0), the agent's enforcement code through enforceRunner")
		report(t, n, c)
	})
}

// ── 0.73: a revocation through enforce.Poller on the real RustDesk ─────────

const (
	labEndpoint = "cmlabendpoint0000000000001"
	labBusiness = "cmlabbusiness0000000000001"
	labRustdesk = "123456789"
)

type labPortal struct {
	answers []enforce.PollAnswer
	reports []enforce.Report
	acks    [][]string
}

func (p *labPortal) Poll(_ context.Context, ack []string, _ bool) (enforce.PollAnswer, error) {
	p.acks = append(p.acks, ack)
	if len(p.answers) == 0 {
		return enforce.PollAnswer{}, enforce.ErrStop
	}
	a := p.answers[0]
	p.answers = p.answers[1:]
	return a, nil
}
func (p *labPortal) Report(_ context.Context, r enforce.Report) error {
	p.reports = append(p.reports, r)
	return nil
}

type labHost struct{ keys map[string]ed25519.PublicKey }

func (h labHost) RustdeskID(context.Context) (string, error) { return labRustdesk, nil }
func (h labHost) Sessions() (int, error)                     { return 0, nil }
func (h labHost) Trust(context.Context) (map[string]ed25519.PublicKey, func(string, string) bool, error) {
	return h.keys, func(string, string) bool { return false }, nil
}

type labStore struct {
	st    *enforce.State
	saved *enforce.Saved
	seen  map[string]time.Time
}

func (m *labStore) LoadState() (*enforce.State, error)      { return m.st, nil }
func (m *labStore) SaveState(s *enforce.State) error        { c := *s; m.st = &c; return nil }
func (m *labStore) LoadSaved() (*enforce.Saved, error)      { return m.saved, nil }
func (m *labStore) SaveSaved(s *enforce.Saved) error        { m.saved = s; return nil }
func (m *labStore) DeleteSaved() error                      { m.saved = nil; return nil }
func (m *labStore) LoadSeen() (map[string]time.Time, error) { return m.seen, nil }
func (m *labStore) SaveSeen(s map[string]time.Time) error   { m.seen = s; return nil }

func labRevocationCycle(ctx context.Context, e *enforce.Enforcer) error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	kid := grant.KeyID(pub)
	now := time.Now().UTC().Truncate(time.Second)
	iso := func(t time.Time) string { return t.Format("2006-01-02T15:04:05Z") }
	g := grant.Grant{V: 1, GrantID: "00112233445566778899aabbccddee02", EndpointID: labEndpoint, RustdeskID: labRustdesk, BusinessID: labBusiness,
		TechnicianID: "cmlabtechnician00000000001", Mode: "control", Consent: "not_required",
		Permissions: grant.Permissions{Clipboard: true, Files: true, Audio: true},
		NotBefore:   iso(now.Add(-10 * time.Second)), NotAfter: iso(now.Add(4 * time.Minute)), MaxMinutes: 30, IdleMinutes: 10, Password: enforce.RandomPassword()}
	gb := grant.Canonical(&g)
	genv, _ := json.Marshal(map[string]string{"keyId": kid, "grant": base64.StdEncoding.EncodeToString(gb),
		"sig": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, append([]byte(grant.Prefix), gb...)))})
	r := grant.Revocation{V: 1, RevocationID: "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb", EndpointID: labEndpoint, RustdeskID: labRustdesk,
		GrantIDs: []string{g.GrantID}, IssuedAt: iso(now), NotAfter: iso(now.Add(time.Hour))}
	rb := grant.CanonicalRevocation(&r)
	renv, _ := json.Marshal(map[string]string{"keyId": kid, "revocation": base64.StdEncoding.EncodeToString(rb),
		"sig": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, append([]byte(grant.RevocationPrefix), rb...)))})
	m := &enforce.ManagedAnswer{State: "verified"}
	portal := &labPortal{answers: []enforce.PollAnswer{
		{EndpointID: labEndpoint, Managed: m, Grants: []json.RawMessage{genv}},
		{EndpointID: labEndpoint, Managed: m, Revocations: []json.RawMessage{renv}},
		{EndpointID: labEndpoint, Managed: m},
	}}
	store := &labStore{st: &enforce.State{Schema: enforce.StateSchema, EndpointID: labEndpoint, Secured: true}, seen: map[string]time.Time{}}
	p := &enforce.Poller{E: e, P: portal, H: labHost{keys: map[string]ed25519.PublicKey{kid: pub}}, S: store,
		Wait: func(context.Context, time.Duration) {}}
	if err := p.Run(ctx); err != nil {
		return err
	}
	var events []string
	for _, rep := range portal.reports {
		events = append(events, rep.Event+":"+rep.Outcome)
	}
	want := []string{"received:", "applied:", "ended:revoked"}
	if len(events) < 3 || events[0] != want[0] || events[1] != want[1] || events[2] != want[2] {
		return fmt.Errorf("events %v, want %v first", events, want)
	}
	acked := false
	for _, a := range portal.acks {
		for _, id := range a {
			acked = acked || id == r.RevocationID
		}
	}
	if !acked {
		return fmt.Errorf("the revocation was not acked: %v", portal.acks)
	}
	if got, ok := e.Read(ctx, "stop-service"); !ok || !enforce.Matches("stop-service", got, "N") {
		return fmt.Errorf("stop-service reads %q after the session ended", got)
	}
	return nil
}
