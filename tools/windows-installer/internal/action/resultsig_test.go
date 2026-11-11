package action

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/devsig"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

func openResult(t *testing.T, dir string, r Result) devsig.ResultStatement {
	t.Helper()
	k, err := devsig.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if r.Signed == nil {
		t.Fatalf("result %s/%s is unsigned", r.Outcome, r.Reason)
	}
	b, err := devsig.Open(r.Signed, devsig.PublicB64(k), devsig.ResultPrefix)
	if err != nil {
		t.Fatalf("result signature: %v", err)
	}
	var st devsig.ResultStatement
	d := json.NewDecoder(bytesReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&st); err != nil {
		t.Fatal(err)
	}
	return st
}

func planHash(env []byte) string {
	var e Envelope
	_ = json.Unmarshal(env, &e)
	b, _ := base64.StdEncoding.DecodeString(e.Plan)
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestUpdateResultIsSignedWithEveryGateFact(t *testing.T) {
	f := newFixture(t)
	w, reg := f.withWUA()
	env := f.envelope(updatePlan(), nil)
	r := f.runWith(env, w, reg)
	st := openResult(t, f.dir, r)
	if st.Schema != devsig.ResultStatementSchema || st.JobID != job || st.PlanSHA256 != planHash(env) {
		t.Fatalf("statement names %s / %s, want %s / %s", st.JobID, st.PlanSHA256, job, planHash(env))
	}
	if st.RustdeskID != "123456789" || st.DeviceSecretSHA256 != SecretSHA256("device-secret") {
		t.Fatalf("identity %s %s", st.RustdeskID, st.DeviceSecretSHA256)
	}
	if st.Outcome != "restart_required" || st.RebootPending == nil || !*st.RebootPending || st.CompletedAt != now.UTC().Format(devsig.TimeFormat) {
		t.Fatalf("statement %+v", st)
	}
	got := map[string]string{}
	for _, u := range st.Updates {
		got[u.UpdateID] = u.State
	}
	if got[cuID] != "restart_required" || got[drvID] != "excluded" || len(st.Updates) != len(r.Updates) {
		t.Fatalf("signed per-update states %v, reported %v", got, r.Updates)
	}

	// A re-delivery is answered from the journal with the same signature.
	r2 := f.runWith(env, w, reg)
	if r2.Signed == nil || r2.Signed.Sig != r.Signed.Sig || r2.Signed.Statement != r.Signed.Statement {
		t.Fatal("a replay must return the journaled, signed result unchanged")
	}
}

func TestRefusalsAndInterruptionsAreSignedToo(t *testing.T) {
	// A refusal is a final result like any other: signed, naming the plan.
	f := newFixture(t)
	f.p.rid = "999999999"
	env := f.envelope(basePlan(), nil)
	r := f.run(env)
	expect(t, r, "refused", "wrong_target")
	st := openResult(t, f.dir, r)
	if st.Outcome != "refused" || st.Reason != "wrong_target" || st.PlanSHA256 != planHash(env) || st.RustdeskID != "999999999" {
		t.Fatalf("refusal statement %+v", st)
	}

	// An interrupted job is reported uncertain — signed, still naming its plan.
	g := newFixture(t)
	o := g.opts()
	for _, d := range []string{"journal", "results", "locks"} {
		_ = os.MkdirAll(o.dir(d), 0o700)
	}
	writeJournal(o, journal{JobID: job, State: "executing", At: now.Format(time.RFC3339), ActionID: "windows.update.install", ActionVersion: 1, PlanSHA256: "ab" + selfSHA[2:]})
	w, reg := g.withWUA()
	u := g.runWith(g.envelope(updatePlan(), nil), w, reg)
	expect(t, u, "uncertain", "interrupted")
	if su := openResult(t, g.dir, u); su.Outcome != "uncertain" || su.PlanSHA256 != "ab"+selfSHA[2:] {
		t.Fatalf("interrupted statement %+v", su)
	}
}

func TestNotYetValidIsNeitherReportedNorSigned(t *testing.T) {
	f := newFixture(t)
	p := basePlan()
	p["window"] = map[string]any{"notBefore": now.Add(time.Hour).Format(time.RFC3339Nano), "notAfter": now.Add(2 * time.Hour).Format(time.RFC3339Nano)}
	r := f.run(f.envelope(p, nil))
	expect(t, r, "refused", "not_yet_valid")
	if r.Signed != nil {
		t.Fatal("a plan that is not yet valid is not consumed, and nothing about it is signed")
	}
}

func TestPreSignedJournalIsSignedOnReplay(t *testing.T) {
	// A result journaled by a 0.33 agent carries no signature; the 0.34 agent
	// signs it as recorded, dated when it was recorded.
	f := newFixture(t)
	o := f.opts()
	for _, d := range []string{"journal", "results", "locks"} {
		_ = os.MkdirAll(o.dir(d), 0o700)
	}
	old := Result{JobID: job, Outcome: "succeeded", Detail: "started"}
	writeJournal(o, journal{JobID: job, State: "done", At: "2026-11-01T10:00:00Z", Result: &old})
	r := f.run(f.envelope(basePlan(), nil))
	st := openResult(t, f.dir, r)
	if st.Outcome != "succeeded" || st.CompletedAt != "2026-11-01T10:00:00Z" {
		t.Fatalf("replayed 0.33 result %+v", st)
	}
}

func TestResultKeyIsThisComputersAndStaysOnIt(t *testing.T) {
	f := newFixture(t)
	r := f.run(f.envelope(basePlan(), nil))
	k, _ := devsig.Load(f.dir)
	if r.Signed.Key != devsig.PublicB64(k) {
		t.Fatal("the result names a key other than this computer's")
	}
	// The private half is nowhere in what is reported or journaled.
	seed := base64.StdEncoding.EncodeToString(k.Seed())
	for _, sub := range []string{"results", "journal"} {
		b, _ := os.ReadFile(filepath.Join(f.dir, "actions", sub, job+".json"))
		if len(b) == 0 || bytesContains(b, seed) {
			t.Fatalf("%s: %d bytes, private key present: %v", sub, len(b), bytesContains(b, seed))
		}
	}
	// Another computer's key cannot open this computer's result.
	other, _ := devsig.Load(t.TempDir())
	if _, err := devsig.Open(r.Signed, devsig.PublicB64(other), devsig.ResultPrefix); err == nil {
		t.Fatal("verified under another computer's key")
	}
	_ = ed25519.PublicKeySize
}

func TestScanStatementCarriesOnlyGateFacts(t *testing.T) {
	k, _ := devsig.Load(t.TempDir())
	w := &patch.FakeWUA{Offered: []patch.Update{{UpdateID: cuID, Revision: 200, KB: "KB5044284", Title: "CU", Classification: patch.ClassSecurity, EulaAccepted: true}}}
	p := patch.Scan(w, &patch.FakeRegistry{}, now)
	p.History = append(p.History,
		patch.HistoryEntry{UpdateID: drvID, Revision: 1, Result: "succeeded", Operation: "install"},
		patch.HistoryEntry{UpdateID: drvID, Revision: 1, Result: "succeeded", Operation: "install"},
		patch.HistoryEntry{UpdateID: cuID, Revision: 199, Result: "failed", Operation: "install"})
	if err := patch.SignScan(&p, k, "123456789", SecretSHA256("device-secret")); err != nil {
		t.Fatal(err)
	}
	b, err := devsig.Open(p.Signed, devsig.PublicB64(k), devsig.ScanPrefix)
	if err != nil {
		t.Fatal(err)
	}
	var st devsig.ScanStatement
	d := json.NewDecoder(bytesReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&st); err != nil {
		t.Fatal(err)
	}
	if st.ScannedAt != p.ScannedAt || len(st.Offered) != 1 || st.Offered[0] != cuID+"@200" || len(st.Installed) != 1 || st.Installed[0] != drvID+"@1" || st.RustdeskID != "123456789" {
		t.Fatalf("scan statement %+v", st)
	}
	if _, err := devsig.Open(p.Signed, devsig.PublicB64(k), devsig.ResultPrefix); err == nil {
		t.Fatal("a scan signature verified as a result")
	}
}

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

func bytesContains(b []byte, s string) bool { return len(s) > 0 && strings.Contains(string(b), s) }
