package action

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/winget/stub"
)

// The signed revocation statement (v0.36), revocation.go.

// statementWith signs a statement with priv, as the approval signer does.
func statementWith(priv ed25519.PrivateKey, kid string, asOf time.Time, scripts, software []string, mutate func(st map[string]any)) []byte {
	sort.Strings(scripts)
	sort.Strings(software)
	if scripts == nil {
		scripts = []string{}
	}
	if software == nil {
		software = []string{}
	}
	st := map[string]any{"schema": RevocationSchema, "seq": len(scripts) + len(software), "asOf": asOf.UTC().Format(time.RFC3339Nano), "scripts": scripts, "software": software}
	if mutate != nil {
		mutate(st)
	}
	body, _ := json.Marshal(st)
	sig := ed25519.Sign(priv, append([]byte(RevocationPrefix), body...))
	env, _ := json.Marshal(map[string]any{"schema": RevocationEnvelopeSchema, "kid": kid, "statement": base64.StdEncoding.EncodeToString(body), "sig": base64.StdEncoding.EncodeToString(sig)})
	return env
}

func (f *fixture) revocations(asOf time.Time, scripts, software []string) []byte {
	return statementWith(f.priv, "k1", asOf, scripts, software, nil)
}

// runRev runs a plan with this statement delivered (nil: none).
func (f *fixture) runRev(plan map[string]any, statement []byte, content []byte, h ScriptHost) Result {
	o := f.opts()
	o.Revocations = statement
	o.ScriptContent, o.Scripts = content, h
	r, err := Run(job, f.envelope(plan, nil), o)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func (f *fixture) journaled() (journal, bool) { return readJournal(f.opts(), job) }

func okHost(t *testing.T, f *fixture) *fakeHost {
	return &fakeHost{t: t, f: f, run: ScriptRun{ExitCode: 0, Stdout: []byte("ok\n"), StdoutTotal: 3}}
}

// Without a statement as new as the plan's signature, nothing runs, and the
// job is not consumed: fail closed, but retryable.
func TestRevocationNoStatementFailsClosedAndIsNotConsumed(t *testing.T) {
	f := newFixture(t)
	content := []byte(testScript)
	h := okHost(t, f)
	r := f.runRev(scriptPlan(content, map[string]any{"Name": "web"}, 5), nil, content, h)
	expect(t, r, "refused", "revocations_stale")
	if h.calls != 0 {
		t.Fatal("ran without a revocation statement")
	}
	if _, ok := f.journaled(); ok {
		t.Fatal("a stale refusal must not consume the job")
	}
	if _, err := os.Stat(filepath.Join(f.dir, "actions", "results", job+".json")); !os.IsNotExist(err) {
		t.Fatal("a stale refusal must not be reported (the portal would record it as final)")
	}
	// The next delivery brings a fresh statement: it runs.
	r = f.runRev(scriptPlan(content, map[string]any{"Name": "web"}, 5), f.revocations(now, nil, nil), content, h)
	expect(t, r, "succeeded", "")
}

// A forged statement is never consulted and never stored, however it was forged.
func TestRevocationForgedStatementRefused(t *testing.T) {
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	cases := map[string]func(f *fixture) []byte{
		"signed by another key": func(f *fixture) []byte { return statementWith(other, "k1", now, nil, nil, nil) },
		"unknown kid":           func(f *fixture) []byte { return statementWith(f.priv, "k9", now, nil, nil, nil) },
		"body edited after signing": func(f *fixture) []byte {
			var env map[string]any
			_ = json.Unmarshal(f.revocations(now, []string{strings.Repeat("a", 64)}, nil), &env)
			body, _ := base64.StdEncoding.DecodeString(env["statement"].(string))
			env["statement"] = base64.StdEncoding.EncodeToString([]byte(strings.Replace(string(body), strings.Repeat("a", 64), strings.Repeat("b", 64), 1)))
			b, _ := json.Marshal(env)
			return b
		},
		"a plan's signing prefix": func(f *fixture) []byte {
			body, _ := json.Marshal(map[string]any{"schema": RevocationSchema, "seq": 0, "asOf": now.Format(time.RFC3339Nano), "scripts": []string{}, "software": []string{}})
			sig := ed25519.Sign(f.priv, append([]byte(SigningPrefix), body...))
			b, _ := json.Marshal(map[string]any{"schema": RevocationEnvelopeSchema, "kid": "k1", "statement": base64.StdEncoding.EncodeToString(body), "sig": base64.StdEncoding.EncodeToString(sig)})
			return b
		},
		"seq does not count the entries": func(f *fixture) []byte {
			return statementWith(f.priv, "k1", now, []string{strings.Repeat("a", 64)}, nil, func(st map[string]any) { st["seq"] = 5 })
		},
		"an unknown field": func(f *fixture) []byte {
			return statementWith(f.priv, "k1", now, nil, nil, func(st map[string]any) { st["unrevoke"] = []string{strings.Repeat("a", 64)} })
		},
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			content := []byte(testScript)
			h := okHost(t, f)
			r := f.runRev(scriptPlan(content, map[string]any{"Name": "web"}, 5), mk(f), content, h)
			expect(t, r, "refused", "revocations_stale")
			if h.calls != 0 || !strings.Contains(r.Detail, "was refused") {
				t.Fatalf("calls %d detail %q", h.calls, r.Detail)
			}
			if _, err := os.Stat(revocationsPath(f.opts())); !os.IsNotExist(err) {
				t.Fatal("a forged statement was stored")
			}
		})
	}
}

// A revoked content hash is refused before the job is journaled executing,
// and for good.
func TestRevokedScriptRefusedBeforeExecuting(t *testing.T) {
	f := newFixture(t)
	content := []byte(testScript)
	h := okHost(t, f)
	plan := scriptPlan(content, map[string]any{"Name": "web"}, 5)
	r := f.runRev(plan, f.revocations(now, []string{sum(content)}, nil), content, h)
	expect(t, r, "refused", "revoked")
	if h.calls != 0 || r.Script != nil {
		t.Fatal("a revoked script ran")
	}
	j, ok := f.journaled()
	if !ok || j.State != "done" || j.ActionID != "" || j.Result == nil || j.Result.Reason != "revoked" {
		t.Fatalf("journal %+v: the job must go straight to done, never executing", j)
	}
	if !strings.Contains(r.Detail, "seq 1") {
		t.Fatalf("detail %q", r.Detail)
	}
	// Final: a re-delivery is answered from the journal.
	r = f.runRev(plan, f.revocations(now, nil, nil), content, h)
	expect(t, r, "refused", "revoked")
	if h.calls != 0 {
		t.Fatal("ran after a revocation refusal")
	}
}

// The intended rule for older plans: a plan signed before a revocation of
// SOMETHING ELSE still runs; a plan signed before the statement the agent
// holds runs; one signed after it waits.
func TestOlderPlanStillRunsAndNewerPlanWaits(t *testing.T) {
	content := []byte(testScript)
	other := strings.Repeat("e", 64)

	f := newFixture(t)
	h := okHost(t, f)
	// Signed a minute ago (basePlan); the statement is from now and revokes another script.
	r := f.runRev(scriptPlan(content, map[string]any{"Name": "web"}, 5), f.revocations(now, []string{other}, []string{"entry-other-01"}), content, h)
	expect(t, r, "succeeded", "")

	// Signed after the newest statement this computer holds: it waits.
	g := newFixture(t)
	hg := okHost(t, g)
	plan := scriptPlan(content, map[string]any{"Name": "web"}, 5)
	signed := now.Add(-time.Minute).Format(time.RFC3339Nano)
	plan["signedAt"] = signed
	r = g.runRev(plan, g.revocations(now.Add(-2*time.Minute), nil, nil), content, hg)
	expect(t, r, "refused", "revocations_stale")
	if hg.calls != 0 || !strings.Contains(r.Detail, "older than the plan's signature") {
		t.Fatalf("calls %d detail %q", hg.calls, r.Detail)
	}
	// With the statement held from that run and none delivered, still waiting.
	r = g.runRev(plan, nil, content, hg)
	expect(t, r, "refused", "revocations_stale")
	// A newer statement arrives: it runs.
	r = g.runRev(plan, g.revocations(now, nil, nil), content, hg)
	expect(t, r, "succeeded", "")
}

// The agent keeps the newest statement it has seen, and refuses to go back.
func TestRevocationRollbackRefused(t *testing.T) {
	content := []byte(testScript)
	f := newFixture(t)
	h := okHost(t, f)
	// First a statement revoking this script's content arrives with an
	// unrelated job (the spooler start runs, the statement is kept)...
	revoking := f.revocations(now.Add(-30*time.Second), []string{sum(content)}, nil)
	o := f.opts()
	o.Revocations = revoking
	if r, _ := Run("ffffffffffffffffffffffffffffffff", f.envelopeFor("ffffffffffffffffffffffffffffffff", basePlan()), o); r.Outcome != "succeeded" {
		t.Fatalf("spooler job: %+v", r)
	}
	// ...then a portal delivers the run with a statement from before the
	// revocation: seq 0, empty, even with a later asOf. It is not taken; the
	// held seq 1 decides, and the run is refused.
	older := f.revocations(now, nil, nil)
	r := f.runRev(scriptPlan(content, map[string]any{"Name": "web"}, 5), older, content, h)
	expect(t, r, "refused", "revoked")
	if h.calls != 0 {
		t.Fatal("rolled back to a statement without the revocation")
	}
	raw, _ := os.ReadFile(revocationsPath(f.opts()))
	if held, err := ParseRevocations(raw, f.opts().Keys); err != nil || held.Seq != 1 {
		t.Fatalf("held statement after the rollback attempt: %+v %v", held, err)
	}
	if _, note := currentRevocations(Options{StateDir: f.dir, Keys: f.opts().Keys, Revocations: older}); note != "refused an older revocation statement (seq 0; this computer holds seq 1)" {
		t.Fatalf("note %q", note)
	}
	// A higher seq that leaves out what it holds is refused too.
	g := newFixture(t)
	hg := okHost(t, g)
	og := g.opts()
	og.Revocations = g.revocations(now, []string{sum(content)}, nil)
	_, _ = Run("ffffffffffffffffffffffffffffffff", g.envelopeFor("ffffffffffffffffffffffffffffffff", basePlan()), og)
	r = g.runRev(scriptPlan(content, map[string]any{"Name": "web"}, 5), g.revocations(now.Add(time.Second), []string{strings.Repeat("1", 64), strings.Repeat("2", 64)}, nil), content, hg)
	expect(t, r, "refused", "revoked")
	if hg.calls != 0 {
		t.Fatal("a statement that dropped a revocation un-revoked it")
	}
	// Same seq, a different set (an equivocating statement): the held one stands.
	k := newFixture(t)
	hk := okHost(t, k)
	ok := k.opts()
	ok.Revocations = k.revocations(now.Add(-time.Second), []string{sum(content)}, nil)
	_, _ = Run("ffffffffffffffffffffffffffffffff", k.envelopeFor("ffffffffffffffffffffffffffffffff", basePlan()), ok)
	r = k.runRev(scriptPlan(content, map[string]any{"Name": "web"}, 5), k.revocations(now, []string{strings.Repeat("3", 64)}, nil), content, hk)
	expect(t, r, "refused", "revoked")
}

// Software: an install from a revoked entry is refused; an uninstall is not;
// an install naming no entry is refused.
func TestRevokedSoftwareEntry(t *testing.T) {
	s := newSW(t, &stub.State{Version: "v1.9.25200"})
	o := s.opts()
	o.Revocations = s.revocations(now, nil, []string{swEntry})
	o.Winget = stub.New(mustExe(t), s.state)
	o.Software = probeAdapter{stub.Probe{State: s.state}}
	r, _ := Run(job, s.envelope(swPlan(install, swParams(nil)), nil), o)
	expect(t, r, "refused", "revoked")
	if len(s.calls()) != 0 {
		t.Fatalf("winget was asked %v", s.calls())
	}

	u := newSW(t, &stub.State{Version: "v1.9.25200", Installed: []stub.Entry{{Key: "7-Zip", DisplayName: "7-Zip 24.08 (x64)", DisplayVersion: "24.08"}}})
	ou := u.opts()
	ou.Revocations = u.revocations(now, nil, []string{swEntry})
	ou.Winget = stub.New(mustExe(t), u.state)
	ou.Software = probeAdapter{stub.Probe{State: u.state}}
	r, _ = Run(job, u.envelope(swPlan(uninstall, swParams(nil)), nil), ou)
	if r.Reason == "revoked" {
		t.Fatalf("an uninstall from an archived entry must still run: %+v", r)
	}

	n := newSW(t, &stub.State{Version: "v1.9.25200"})
	plan := swPlan(install, swParams(nil))
	delete(plan, "display")
	r = n.runSW(n.envelope(plan, nil), 0)
	expect(t, r, "refused", "software_entry_missing")
}

func mustExe(t *testing.T) string {
	p, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// envelopeFor signs a plan for another job id.
func (f *fixture) envelopeFor(id string, plan map[string]any) []byte {
	plan["jobId"] = id
	return f.envelope(plan, nil)
}
