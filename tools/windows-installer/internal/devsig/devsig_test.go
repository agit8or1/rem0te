package devsig

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestLoadCreatesOnceAndKeepsTheKey(t *testing.T) {
	dir := t.TempDir()
	k1, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	k2, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !k1.Equal(k2) {
		t.Fatal("a second Load made a new key")
	}
	st, err := os.Stat(filepath.Join(dir, KeyFile))
	if err != nil || st.Mode().Perm()&0o077 != 0 {
		t.Fatalf("key file %v %v: must exist and be private", st, err)
	}
	// The file holds the seed only; no other field, no public key to trust.
	raw, _ := os.ReadFile(filepath.Join(dir, KeyFile))
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if len(m) != 2 || m["schema"] != KeySchema {
		t.Fatalf("key file: %s", raw)
	}
}

func TestConcurrentFirstLoadAgrees(t *testing.T) {
	dir := t.TempDir()
	var wg sync.WaitGroup
	keys := make([]ed25519.PrivateKey, 8)
	for i := range keys {
		wg.Add(1)
		go func(i int) { defer wg.Done(); keys[i], _ = Load(dir) }(i)
	}
	wg.Wait()
	for _, k := range keys {
		if k == nil || !k.Equal(keys[0]) {
			t.Fatal("processes racing to create the key ended with different keys")
		}
	}
}

func TestUnusableKeyFileIsSetAsideNotTrusted(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, KeyFile), []byte(`{"schema":"rem0te-device-result-key/1","seed":"short"}`), 0o600)
	k, err := Load(dir)
	if err != nil || k == nil {
		t.Fatalf("load: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, KeyFile+".unusable")); err != nil {
		t.Fatal("the unusable file should be kept aside for an operator")
	}
}

func TestSignOpen(t *testing.T) {
	k, _ := Load(t.TempDir())
	st := ResultStatement{Schema: ResultStatementSchema, JobID: "0123456789abcdef0123456789abcdef", Outcome: "succeeded", CompletedAt: "2026-11-11T10:00:00.000Z"}
	s, err := Sign(k, ResultPrefix, st)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Open(s, PublicB64(k), ResultPrefix)
	if err != nil {
		t.Fatalf("genuine statement refused: %v", err)
	}
	var back ResultStatement
	if json.Unmarshal(b, &back) != nil || back.JobID != st.JobID || back.Outcome != "succeeded" {
		t.Fatalf("round trip: %s", b)
	}

	// Forged: another key signs, and names itself.
	pub, other, _ := ed25519.GenerateKey(rand.Reader)
	f, _ := Sign(other, ResultPrefix, st)
	if _, err := Open(f, PublicB64(k), ResultPrefix); err == nil {
		t.Fatal("a statement signed by another key verified")
	}
	// Forged: another key signs, but claims to be this one.
	f.Key = PublicB64(k)
	if _, err := Open(f, PublicB64(k), ResultPrefix); err == nil {
		t.Fatal("a statement claiming this key but signed by another verified")
	}
	_ = pub

	// Altered: the outcome is changed after signing.
	alt := *s
	st.Outcome = "failed"
	b2, _ := json.Marshal(st)
	alt.Statement = base64.StdEncoding.EncodeToString(b2)
	if _, err := Open(&alt, PublicB64(k), ResultPrefix); err == nil {
		t.Fatal("an altered statement verified")
	}
	// Cross-domain: a result statement presented as a scan.
	if _, err := Open(s, PublicB64(k), ScanPrefix); err == nil {
		t.Fatal("a result signature verified as a scan")
	}
	// Not an envelope at all.
	if _, err := Open(&Signed{Schema: "x"}, PublicB64(k), ResultPrefix); err == nil {
		t.Fatal("an unknown schema verified")
	}
}

func TestFingerprint(t *testing.T) {
	k, _ := Load(t.TempDir())
	fp := Fingerprint(k.Public().(ed25519.PublicKey))
	if len(fp) != 19 || fp[4] != '-' || fp[9] != '-' || fp[14] != '-' {
		t.Fatalf("fingerprint %q", fp)
	}
}
