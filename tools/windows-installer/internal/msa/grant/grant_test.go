package grant

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fixtureCase struct {
	Name     string `json:"name"`
	Envelope string `json:"envelope"`
	Context  struct {
		EndpointID   string   `json:"endpointId"`
		RustdeskID   string   `json:"rustdeskId"`
		Now          string   `json:"now"`
		Seen         []string `json:"seen"`
		RemotePaused bool     `json:"remotePaused"`
		Ceiling      struct {
			Mode        string      `json:"mode"`
			Permissions Permissions `json:"permissions"`
		} `json:"ceiling"`
	} `json:"context"`
	Expect string `json:"expect"`
}

type fixture struct {
	Prefix  string            `json:"prefix"`
	Reasons []string          `json:"reasons"`
	Keys    map[string]string `json:"keys"`
	Cases   []fixtureCase     `json:"cases"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "testdata", "msa-grants.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// The portal's fixture (apps/api/scripts/gen-msa-grant-fixture.mjs, from
// src/msa/grant.ts): every case gives the same answer here as there.
func TestFixture(t *testing.T) {
	f := loadFixture(t)
	if f.Prefix != Prefix {
		t.Fatalf("prefix %q, portal %q", Prefix, f.Prefix)
	}
	if len(f.Reasons) != len(Reasons) {
		t.Fatalf("reasons %v, portal %v", Reasons, f.Reasons)
	}
	for i := range Reasons {
		if Reasons[i] != f.Reasons[i] {
			t.Fatalf("reason %d: %q, portal %q", i, Reasons[i], f.Reasons[i])
		}
	}
	keys := map[string]ed25519.PublicKey{}
	for id, b64 := range f.Keys {
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			t.Fatalf("fixture key %s", id)
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:])[:16] != id {
			t.Fatalf("fixture key id %s is not its SHA-256 prefix", id)
		}
		keys[id] = ed25519.PublicKey(raw)
	}
	if len(f.Cases) < 60 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	covered := map[string]bool{}
	for _, c := range f.Cases {
		now, err := time.Parse(time.RFC3339, c.Context.Now)
		if err != nil {
			t.Fatalf("%s: now %q", c.Name, c.Context.Now)
		}
		seen := map[string]bool{}
		for _, s := range c.Context.Seen {
			seen[s] = true
		}
		r := Verify([]byte(c.Envelope), Context{
			Keys: keys, EndpointID: c.Context.EndpointID, RustdeskID: c.Context.RustdeskID, Now: now, Seen: seen,
			Ceiling: Ceiling{Mode: c.Context.Ceiling.Mode, Permissions: c.Context.Ceiling.Permissions}, RemotePaused: c.Context.RemotePaused,
		})
		got := r.Reason
		if r.OK {
			got = "ok"
			if r.Grant == nil {
				t.Errorf("%s: ok without a grant", c.Name)
			}
		} else if r.Grant != nil {
			t.Errorf("%s: refused but returned a grant", c.Name)
		}
		if got != c.Expect {
			t.Errorf("%s: got %s, want %s", c.Name, got, c.Expect)
		}
		covered[c.Expect] = true
	}
	for _, r := range Reasons {
		if !covered[r] {
			t.Errorf("no fixture case for %s", r)
		}
	}
	if !covered["ok"] {
		t.Error("no ok case")
	}
}

// A grant signed here verifies here (the Go side's own round trip), and its
// canonical form matches what it signed.
func TestRoundTrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(pub)
	kid := hex.EncodeToString(sum[:])[:16]
	g := Grant{V: 1, GrantID: "00112233445566778899aabbccddeeff", EndpointID: "cmtestendpoint000000000009", RustdeskID: "555666777",
		BusinessID: "cmtestbusiness000000000009", TechnicianID: "cmtesttechnician0000000009", Mode: "control",
		Permissions: Permissions{Clipboard: true}, Consent: "not_required", NotBefore: "2026-11-20T10:00:00Z", NotAfter: "2026-11-20T10:05:00Z",
		MaxMinutes: 30, IdleMinutes: 10, Password: "ZZZZyyyyXXXXwwww00001111"}
	body := Canonical(&g)
	sig := ed25519.Sign(priv, append([]byte(Prefix), body...))
	env, _ := json.Marshal(map[string]string{"keyId": kid, "grant": base64.StdEncoding.EncodeToString(body), "sig": base64.StdEncoding.EncodeToString(sig)})
	ctx := Context{Keys: map[string]ed25519.PublicKey{kid: pub}, EndpointID: g.EndpointID, RustdeskID: g.RustdeskID,
		Now: time.Date(2026, 11, 20, 10, 2, 0, 0, time.UTC), Ceiling: Ceiling{Mode: "control", Permissions: Permissions{Clipboard: true}}}
	if r := Verify(env, ctx); !r.OK || *r.Grant != g {
		t.Fatalf("round trip: %+v", r)
	}
	ctx.Seen = map[string]bool{g.GrantID: true}
	if r := Verify(env, ctx); r.Reason != Replayed {
		t.Fatalf("replay: %+v", r)
	}
	ctx.Seen = nil
	ctx.Keys = nil
	if r := Verify(env, ctx); r.Reason != UnknownKey {
		t.Fatalf("no keys: %+v", r)
	}
}

// Nothing in the verifier reads the clock, a file or the environment: the
// agent supplies all of it.
func TestReasonsAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range Reasons {
		if seen[r] {
			t.Fatalf("duplicate reason %s", r)
		}
		seen[r] = true
	}
	if len(Reasons) != 14 {
		t.Fatalf("%d reasons", len(Reasons))
	}
}
