package grant

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type revocationFixture struct {
	Prefix   string            `json:"prefix"`
	Reasons  []string          `json:"reasons"`
	Keys     map[string]string `json:"keys"`
	Sessions []struct {
		GrantID   string `json:"grantId"`
		NotBefore string `json:"notBefore"`
	} `json:"sessions"`
	Cases []struct {
		Name     string `json:"name"`
		Envelope string `json:"envelope"`
		Context  struct {
			EndpointID string   `json:"endpointId"`
			RustdeskID string   `json:"rustdeskId"`
			Now        string   `json:"now"`
			Seen       []string `json:"seen"`
		} `json:"context"`
		Expect string `json:"expect"`
		Ends   []bool `json:"ends"`
	} `json:"cases"`
}

// The portal's revocation fixture (gen-msa-grant-fixture.mjs, from
// src/msa/revocation.ts): every case gives the same answer here, and an
// accepted revocation ends the same sessions.
func TestRevocationFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "testdata", "msa-revocations.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f revocationFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if f.Prefix != RevocationPrefix {
		t.Fatalf("prefix %q, portal %q", RevocationPrefix, f.Prefix)
	}
	if len(f.Reasons) != len(RevocationReasons) {
		t.Fatalf("reasons %v, portal %v", RevocationReasons, f.Reasons)
	}
	for i := range RevocationReasons {
		if RevocationReasons[i] != f.Reasons[i] {
			t.Fatalf("reason %d: %q, portal %q", i, RevocationReasons[i], f.Reasons[i])
		}
	}
	keys := map[string]ed25519.PublicKey{}
	for id, k := range f.Keys {
		raw, err := base64.StdEncoding.DecodeString(k)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			t.Fatalf("fixture key %s", id)
		}
		keys[id] = raw
	}
	if len(f.Cases) < 30 || len(f.Sessions) != 2 {
		t.Fatalf("fixture too small: %d cases, %d sessions", len(f.Cases), len(f.Sessions))
	}
	seenExpect := map[string]bool{}
	for _, c := range f.Cases {
		now, err := time.Parse(time.RFC3339, c.Context.Now)
		if err != nil {
			t.Fatalf("%s: now", c.Name)
		}
		seen := map[string]bool{}
		for _, s := range c.Context.Seen {
			seen[s] = true
		}
		r, reason := VerifyRevocation([]byte(c.Envelope), RevocationContext{
			Keys: keys, EndpointID: c.Context.EndpointID, RustdeskID: c.Context.RustdeskID, Now: now, Seen: seen,
		})
		got := reason
		if got == "" {
			got = "ok"
		}
		seenExpect[got] = true
		if got != c.Expect {
			t.Errorf("%s: got %s, want %s", c.Name, got, c.Expect)
			continue
		}
		if r == nil {
			continue
		}
		if len(c.Ends) != len(f.Sessions) {
			t.Fatalf("%s: ends missing", c.Name)
		}
		for i, s := range f.Sessions {
			nb, _ := time.Parse(time.RFC3339, s.NotBefore)
			if Ends(r, s.GrantID, nb) != c.Ends[i] {
				t.Errorf("%s: session %d ends %v, portal %v", c.Name, i, !c.Ends[i], c.Ends[i])
			}
		}
	}
	for _, r := range append([]string{"ok"}, RevocationReasons...) {
		if !seenExpect[r] {
			t.Errorf("no fixture case for %s", r)
		}
	}
}

// A grant envelope is never a revocation and a revocation never a grant:
// the prefixes and envelope fields differ.
func TestRevocationDomainSeparation(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	kid := "0123456789abcdef"
	body := CanonicalRevocation(&Revocation{V: 1, RevocationID: "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb", EndpointID: "cmtestendpoint000000000001",
		RustdeskID: "123456789", All: true, GrantIDs: nil, IssuedAt: "2026-11-20T12:10:00Z", NotAfter: "2026-11-20T13:10:00Z"})
	sign := func(prefix, field string) []byte {
		env, _ := json.Marshal(map[string]string{"keyId": kid, field: base64.StdEncoding.EncodeToString(body),
			"sig": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, append([]byte(prefix), body...)))})
		return env
	}
	ctx := RevocationContext{Keys: map[string]ed25519.PublicKey{kid: pub}, EndpointID: "cmtestendpoint000000000001", RustdeskID: "123456789",
		Now: time.Date(2026, 11, 20, 12, 10, 5, 0, time.UTC)}
	if _, reason := VerifyRevocation(sign(RevocationPrefix, "revocation"), ctx); reason != "" {
		t.Fatalf("a good revocation: %s", reason)
	}
	if _, reason := VerifyRevocation(sign(Prefix, "revocation"), ctx); reason != BadSignature {
		t.Fatalf("grant prefix: %s", reason)
	}
	if res := Verify(sign(RevocationPrefix, "grant"), Context{Keys: ctx.Keys}); res.OK || res.Reason != BadSignature && res.Reason != GrantMalformed {
		t.Fatalf("a revocation read as a grant: %+v", res)
	}
}
