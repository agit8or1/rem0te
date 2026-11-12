package action

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakePlatform struct {
	state     string
	starts    int
	startErr  error
	stopAfter int // service stops after this many state reads following a start (0 = never)
	reads     int
	product   int
	rid, sec  string
	self      string
}

func (f *fakePlatform) ServiceState(string) (string, error) {
	if f.starts > 0 && f.stopAfter > 0 {
		f.reads++
		if f.reads >= f.stopAfter {
			f.state = "stopped"
		}
	}
	return f.state, nil
}
func (f *fakePlatform) StartService(string) error {
	if f.startErr != nil {
		return f.startErr
	}
	f.starts++
	f.state = "running"
	return nil
}
func (f *fakePlatform) ProductType() (int, error)               { return f.product, nil }
func (f *fakePlatform) DeviceIdentity() (string, string, error) { return f.rid, f.sec, nil }
func (f *fakePlatform) SelfSHA256() (string, error)             { return f.self, nil }
func (f *fakePlatform) Sleep(time.Duration)                     {}

const selfSHA = "ab0000000000000000000000000000000000000000000000000000000000cdef"

var now = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

type fixture struct {
	t    *testing.T
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	dir  string
	p    *fakePlatform
}

func newFixture(t *testing.T) *fixture {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	return &fixture{t: t, pub: pub, priv: priv, dir: t.TempDir(), p: &fakePlatform{
		state: "stopped", product: 1, rid: "123456789", sec: SecretSHA256("device-secret"), self: selfSHA,
	}}
}

// opts: a fresh, empty revocation statement is delivered with every run, as
// the Windows agent fetches one before each (v0.36); revocation_test.go
// covers what happens without one.
func (f *fixture) opts() Options {
	return Options{StateDir: f.dir, Keys: []Key{{Kid: "k1", Ed25519: base64.StdEncoding.EncodeToString(f.pub)}}, Platform: f.p, Now: func() time.Time { return now }, Checks: []time.Duration{time.Second, time.Second},
		Revocations: f.revocations(now, nil, nil)}
}

const job = "0123456789abcdef0123456789abcdef"

func basePlan() map[string]any {
	signed := now.Add(-time.Minute).Format(time.RFC3339Nano)
	return map[string]any{
		"schema": PlanSchema, "jobId": job,
		"action":   map[string]any{"id": "windows.service.start", "version": 1},
		"artifact": map[string]any{"target": "windows/rem0te-agent.exe", "sha256": selfSHA},
		"params":   map[string]any{"service": "Spooler"},
		"targets": []any{map[string]any{"endpointId": "ep-aaaaaaaa", "businessId": "biz-aaaaaaa", "businessName": "Acme", "hostname": "FRONTDESK",
			"deviceClass": "WORKSTATION", "rustdeskId": "123456789", "deviceSecretSha256": SecretSHA256("device-secret")}},
		"requestedBy": map[string]any{"userId": "user-requester", "name": "Dana", "via": "portal"},
		"origin":      map[string]any{"kind": "technician", "ticketRef": nil},
		"reason":      "spooler stopped",
		"policy":      map[string]any{"risk": "low", "approvalsRequired": 1, "customerSignoff": false},
		"window":      map[string]any{"notBefore": now.Add(-time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(time.Hour).Format(time.RFC3339Nano)},
		"createdAt":   now.Add(-2 * time.Hour).Format(time.RFC3339Nano),
		"approvers":   []any{map[string]any{"userId": "user-approver1", "name": "Olivia", "role": "approver", "credentialSha256": selfSHA, "at": signed}},
		"signedAt":    signed,
	}
}

func (f *fixture) envelope(plan map[string]any, mutate func(env map[string]any)) []byte {
	pb, _ := json.Marshal(plan)
	sig := ed25519.Sign(f.priv, append([]byte(SigningPrefix), pb...))
	env := map[string]any{"schema": EnvelopeSchema, "kid": "k1", "plan": base64.StdEncoding.EncodeToString(pb), "sig": base64.StdEncoding.EncodeToString(sig)}
	if mutate != nil {
		mutate(env)
	}
	b, _ := json.Marshal(env)
	return b
}

func (f *fixture) run(env []byte) Result {
	r, err := Run(job, env, f.opts())
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	return r
}

func expect(t *testing.T, r Result, outcome, reason string) {
	t.Helper()
	if r.Outcome != outcome || (reason != "" && r.Reason != reason) {
		t.Fatalf("got %s/%s (%s), want %s/%s", r.Outcome, r.Reason, r.Detail, outcome, reason)
	}
}

func TestApprovedPlanStartsAndVerifies(t *testing.T) {
	f := newFixture(t)
	r := f.run(f.envelope(basePlan(), nil))
	expect(t, r, "succeeded", "")
	if f.p.starts != 1 || r.Observed["before"] != "stopped" || r.Observed["after1s"] != "running" || r.Observed["after2s"] != "running" {
		t.Fatalf("observed %+v, starts %d", r.Observed, f.p.starts)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "actions", "results", job+".json")); err != nil {
		t.Fatal("result not written for the heartbeat")
	}
}

func TestReplayNeverRunsTwice(t *testing.T) {
	f := newFixture(t)
	env := f.envelope(basePlan(), nil)
	f.run(env)
	f.p.state = "stopped" // someone stopped it again; the same envelope must not restart it
	r := f.run(env)
	expect(t, r, "succeeded", "")
	if f.p.starts != 1 {
		t.Fatalf("re-delivered envelope started the service again (%d starts)", f.p.starts)
	}
}

func TestCrashMidActionIsUncertainNotRerun(t *testing.T) {
	f := newFixture(t)
	o := f.opts()
	os.MkdirAll(filepath.Join(f.dir, "actions", "journal"), 0o700)
	writeJournal(o, journal{JobID: job, State: "executing", At: now.Format(time.RFC3339)})
	f.p.state = "running"
	r := f.run(f.envelope(basePlan(), nil))
	expect(t, r, "uncertain", "interrupted")
	if f.p.starts != 0 || r.Observed["now"] != "running" {
		t.Fatalf("starts %d, observed %+v", f.p.starts, r.Observed)
	}
}

func TestAlreadyRunningChangesNothing(t *testing.T) {
	f := newFixture(t)
	f.p.state = "running"
	r := f.run(f.envelope(basePlan(), nil))
	expect(t, r, "already_running", "")
	if f.p.starts != 0 {
		t.Fatal("started a running service")
	}
}

func TestDidNotRemainRunning(t *testing.T) {
	f := newFixture(t)
	f.p.stopAfter = 2
	r := f.run(f.envelope(basePlan(), nil))
	expect(t, r, "failed", "did_not_remain_running")
}

func TestStartFailure(t *testing.T) {
	f := newFixture(t)
	f.p.startErr = errors.New("Access is denied.")
	expect(t, f.run(f.envelope(basePlan(), nil)), "failed", "start_failed")
}

func TestRefusals(t *testing.T) {
	cases := []struct {
		name, reason string
		plan         func(p map[string]any)
		env          func(e map[string]any)
		plat         func(p *fakePlatform)
		outcome      string
	}{
		{name: "tampered plan", reason: "bad_signature", env: func(e map[string]any) {
			var p map[string]any
			b, _ := base64.StdEncoding.DecodeString(e["plan"].(string))
			json.Unmarshal(b, &p)
			p["params"] = map[string]any{"service": "WinDefend"}
			nb, _ := json.Marshal(p)
			e["plan"] = base64.StdEncoding.EncodeToString(nb)
		}},
		{name: "unknown key id", reason: "unknown_key", env: func(e map[string]any) { e["kid"] = "attacker" }},
		{name: "other service", reason: "params_not_allowed", plan: func(p map[string]any) { p["params"] = map[string]any{"service": "WinDefend"} }},
		{name: "extra param", reason: "params_not_allowed", plan: func(p map[string]any) { p["params"] = map[string]any{"service": "Spooler", "args": "/c whoami"} }},
		{name: "unknown action", reason: "unknown_action", plan: func(p map[string]any) { p["action"] = map[string]any{"id": "windows.shell.run", "version": 1} }},
		{name: "other computer", reason: "wrong_target", plat: func(p *fakePlatform) { p.rid = "999999999" }},
		{name: "other device secret", reason: "wrong_target", plat: func(p *fakePlatform) { p.sec = SecretSHA256("someone-else") }},
		{name: "expired", reason: "expired", outcome: "not_executed", plan: func(p map[string]any) {
			p["window"] = map[string]any{"notBefore": now.Add(-3 * time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(-time.Hour).Format(time.RFC3339Nano)}
		}},
		{name: "not yet", reason: "not_yet_valid", plan: func(p map[string]any) {
			p["window"] = map[string]any{"notBefore": now.Add(time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(2 * time.Hour).Format(time.RFC3339Nano)}
		}},
		{name: "different agent build", reason: "artifact_mismatch", plat: func(p *fakePlatform) { p.self = "ff" + selfSHA[2:] }},
		{name: "server with low-risk plan", reason: "risk_understated", plat: func(p *fakePlatform) { p.product = 3 }},
		{name: "domain controller with low-risk plan", reason: "risk_understated", plat: func(p *fakePlatform) { p.product = 2 }},
		{name: "server, high risk, one approver", reason: "too_few_approvals", plat: func(p *fakePlatform) { p.product = 3 }, plan: func(p map[string]any) {
			p["policy"] = map[string]any{"risk": "high", "approvalsRequired": 2, "customerSignoff": false}
		}},
		{name: "server, high risk, approvalsRequired understated", reason: "too_few_approvals", plat: func(p *fakePlatform) { p.product = 3 }, plan: func(p map[string]any) {
			p["policy"] = map[string]any{"risk": "high", "approvalsRequired": 1, "customerSignoff": false}
		}},
		{name: "no approvers", reason: "too_few_approvals", plan: func(p map[string]any) { p["approvers"] = []any{} }},
		{name: "requester approved own", reason: "requester_approved", plan: func(p map[string]any) {
			p["approvers"] = []any{map[string]any{"userId": "user-requester", "name": "Dana", "role": "approver", "credentialSha256": selfSHA, "at": now.Format(time.RFC3339Nano)}}
		}},
		{name: "same approver twice", reason: "too_few_approvals", plan: func(p map[string]any) {
			a := map[string]any{"userId": "user-approver1", "name": "Olivia", "role": "approver", "credentialSha256": selfSHA, "at": now.Format(time.RFC3339Nano)}
			p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 2, "customerSignoff": false}
			p["approvers"] = []any{a, a}
		}},
		{name: "customer sign-off missing", reason: "no_customer_signoff", plan: func(p map[string]any) {
			p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 1, "customerSignoff": true}
		}},
		{name: "customer sign-off by the approver themself", reason: "no_customer_signoff", plan: func(p map[string]any) {
			p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 1, "customerSignoff": true}
			p["approvers"] = append(p["approvers"].([]any), map[string]any{"userId": "user-approver1", "name": "Olivia", "role": "customer", "credentialSha256": selfSHA, "at": now.Format(time.RFC3339Nano)})
		}},
		{name: "plan for another job id", reason: "job_mismatch", plan: func(p map[string]any) { p["jobId"] = "ffffffffffffffffffffffffffffffff" }},
		{name: "unsigned plan", reason: "not_signed", plan: func(p map[string]any) { p["signedAt"] = nil }},
		{name: "unknown field smuggled in", reason: "bad_plan", plan: func(p map[string]any) { p["command"] = "powershell -c whoami" }},
		{name: "two targets", reason: "bad_targets", plan: func(p map[string]any) { t := p["targets"].([]any); p["targets"] = append(t, t[0]) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			p := basePlan()
			if c.plan != nil {
				c.plan(p)
			}
			if c.plat != nil {
				c.plat(f.p)
			}
			want := c.outcome
			if want == "" {
				want = "refused"
			}
			r := f.run(f.envelope(p, c.env))
			expect(t, r, want, c.reason)
			if f.p.starts != 0 {
				t.Fatal("the service was started by a refused plan")
			}
		})
	}
}

func TestCustomerSignoffSatisfied(t *testing.T) {
	f := newFixture(t)
	p := basePlan()
	p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 1, "customerSignoff": true}
	p["approvers"] = append(p["approvers"].([]any), map[string]any{"userId": "user-owner", "name": "Owen", "role": "customer", "credentialSha256": selfSHA, "at": now.Format(time.RFC3339Nano)})
	expect(t, f.run(f.envelope(p, nil)), "succeeded", "")
}

func TestServerWithTwoApproversRuns(t *testing.T) {
	f := newFixture(t)
	f.p.product = 3
	p := basePlan()
	p["policy"] = map[string]any{"risk": "high", "approvalsRequired": 2, "customerSignoff": false}
	p["approvers"] = append(p["approvers"].([]any), map[string]any{"userId": "user-approver2", "name": "Quinn", "role": "approver", "credentialSha256": selfSHA, "at": now.Format(time.RFC3339Nano)})
	expect(t, f.run(f.envelope(p, nil)), "succeeded", "")
}

func TestRefusalIsFinalButNotYetIsNot(t *testing.T) {
	f := newFixture(t)
	p := basePlan()
	p["window"] = map[string]any{"notBefore": now.Add(time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(2 * time.Hour).Format(time.RFC3339Nano)}
	env := f.envelope(p, nil)
	expect(t, f.run(env), "refused", "not_yet_valid")
	if _, err := os.Stat(filepath.Join(f.dir, "actions", "results", job+".json")); err == nil {
		t.Fatal("a not-yet-valid plan was reported; the portal would treat it as a final refusal")
	}
	// An hour later, by this machine's clock, the same envelope runs.
	o := f.opts()
	o.Now = func() time.Time { return now.Add(90 * time.Minute) }
	r, _ := Run(job, env, o)
	expect(t, r, "succeeded", "")

	g := newFixture(t)
	g.p.rid = "999999999"
	env2 := g.envelope(basePlan(), nil)
	expect(t, g.run(env2), "refused", "wrong_target")
	g.p.rid = "123456789"
	expect(t, g.run(env2), "refused", "wrong_target") // final: answered from the journal
	if g.p.starts != 0 {
		t.Fatal("a refused job ran on re-delivery")
	}
}

func TestBadJobIDRejected(t *testing.T) {
	f := newFixture(t)
	if _, err := Run("../../etc/passwd", f.envelope(basePlan(), nil), f.opts()); err != ErrBadJob {
		t.Fatalf("got %v", err)
	}
}

func TestParseKeys(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	sum := sha256.Sum256(pub)
	kid := hex.EncodeToString(sum[:])[:16]
	good := fmt.Sprintf(`{"schema":"rem0te-approval-keys/1","keys":[{"kid":%q,"ed25519":%q}]}`, kid, base64.StdEncoding.EncodeToString(pub))
	if _, err := ParseKeys([]byte(good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{"schema":"rem0te-approval-keys/1","keys":[{"kid":"a","ed25519":"AAAA"}]}`,
		`{"schema":"rem0te-approval-keys/1","keys":[]}`,
		fmt.Sprintf(`{"schema":"rem0te-approval-keys/1","keys":[{"kid":"0000000000000000","ed25519":%q}]}`, base64.StdEncoding.EncodeToString(pub)),
		strings.Replace(good, `"keys"`, `"extra":1,"keys"`, 1),
	} {
		if _, err := ParseKeys([]byte(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	if _, err := ParseKeys([]byte(`{"schema":"other","keys":[]}`)); err == nil {
		t.Fatal("accepted a foreign document")
	}
	if got := Supported(); len(got) != 9 || got[0] != "windows.service.start@1" || got[1] != "windows.update.install@1" { // the rest: TestCatalogIsExactlyTheNineActions
		t.Fatalf("supported %v", got)
	}
}
