// Package devsig is the signed agent's own signing key (v0.34): the one key
// on a computer that speaks for it, so the approval signer can tell a result
// this computer reported from one the portal wrote.
//
// Before 0.34 an approved update ring's result reached the approval signer
// only through the portal, which could forge it: a compromised portal that
// wrote a whole canary success could have the next ring of a patch policy
// signed early. Now the agent signs two kinds of statement:
//
//   - a result statement: the job, the sha256 of the exact signed plan it ran,
//     this computer's enrolled identity, the outcome and each update's final
//     state, as the journal records them;
//   - a scan statement: what Windows Update offered and had installed, and
//     whether a restart is pending, as patch-scan saw it.
//
// The key is Ed25519, generated here from crypto/rand the first time it is
// needed, and kept in the agent's state directory (SYSTEM and Administrators
// only, as heartbeat.dat). It never leaves the computer: only its public half
// is reported, inside every signed statement. The approval signer trusts that
// public half only once two approvers have approved a patch policy naming it
// (and then pins it, write-once, against the computer's enrolled identity);
// see docs/staged-patching.md "Signed results" for the trust-on-first-use
// window that leaves.
//
// The statements travel inside the result and posture files the heartbeat
// already reports. PowerShell re-serialises those files, so a statement is
// carried as base64 of the exact bytes signed, never as JSON to be
// re-canonicalised.
package devsig

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
)

const (
	// SignedSchema is the envelope around one signed statement.
	SignedSchema = "rem0te-device-signed/1"
	// KeySchema is the key file's own schema.
	KeySchema = "rem0te-device-result-key/1"
	// KeyFile, in the agent's state directory.
	KeyFile = "result-key.json"

	ResultStatementSchema = "rem0te-action-result-statement/1"
	ScanStatementSchema   = "rem0te-patch-scan-statement/1"
	// Domain separation: a result can never be read as a scan, nor either as
	// anything another rem0te key signs.
	ResultPrefix = "rem0te-device-result-v1\n"
	ScanPrefix   = "rem0te-device-scan-v1\n"
)

// Signed is one statement and this computer's signature over it.
type Signed struct {
	Schema string `json:"schema"`
	// Key: the public half (base64, 32 bytes). A hint for whoever reads it;
	// the verifier uses the key it already trusts for this computer.
	Key       string `json:"key"`
	Statement string `json:"statement"` // base64 of the exact bytes signed
	Sig       string `json:"sig"`       // base64 Ed25519 over prefix + statement bytes
}

type keyFile struct {
	Schema string `json:"schema"`
	Seed   string `json:"seed"`
}

// Load returns this computer's signing key, creating it the first time. Two
// processes creating it at once agree: the file is linked into place only if
// absent, and the loser reads the winner's.
func Load(stateDir string) (ed25519.PrivateKey, error) {
	path := filepath.Join(stateDir, KeyFile)
	if k, err := read(path); err == nil {
		return k, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		// Present but unusable (a torn write, a hand edit). A new key is the
		// honest answer: the approval signer will see a key it has not pinned
		// and refuse this computer's results (device_key_changed) until an
		// operator looks, rather than this computer signing nothing for ever.
		_ = os.Rename(path, path+".unusable")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(keyFile{Schema: KeySchema, Seed: base64.StdEncoding.EncodeToString(seed)})
	tmp := fmt.Sprintf("%s.%x.tmp", path, seed[:4])
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	_, werr := f.Write(raw)
	serr := f.Sync()
	cerr := f.Close()
	if werr != nil || serr != nil || cerr != nil {
		_ = os.Remove(tmp)
		return nil, errors.Join(werr, serr, cerr)
	}
	lerr := os.Link(tmp, path)
	_ = os.Remove(tmp)
	if lerr != nil && !errors.Is(lerr, os.ErrExist) {
		return nil, lerr
	}
	return read(path)
}

func read(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var k keyFile
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if err := d.Decode(&k); err != nil || k.Schema != KeySchema {
		return nil, errors.New("result-key.json is not a rem0te device key")
	}
	seed, err := base64.StdEncoding.DecodeString(k.Seed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("result-key.json carries no 32-byte seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// PublicB64 is the public half as the portal and signer name it.
func PublicB64(k ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(k.Public().(ed25519.PublicKey))
}

// Fingerprint is what a person compares between this computer's screen
// (`rem0te-agent.exe status`) and the approval signer's policy page: the
// first 16 hex of sha256(public key), in groups of four.
func Fingerprint(pub ed25519.PublicKey) string {
	s := sha256.Sum256(pub)
	h := hex.EncodeToString(s[:])[:16]
	return h[0:4] + "-" + h[4:8] + "-" + h[8:12] + "-" + h[12:16]
}

// Sign signs one statement (any JSON value) under a prefix.
func Sign(k ed25519.PrivateKey, prefix string, statement any) (*Signed, error) {
	b, err := json.Marshal(statement)
	if err != nil {
		return nil, err
	}
	sig := ed25519.Sign(k, append([]byte(prefix), b...))
	return &Signed{
		Schema: SignedSchema, Key: PublicB64(k),
		Statement: base64.StdEncoding.EncodeToString(b), Sig: base64.StdEncoding.EncodeToString(sig),
	}, nil
}

// Open verifies s under pub (base64) and prefix and returns the statement
// bytes. The key s names must be pub: a statement is never trusted on the
// strength of the key it carries.
func Open(s *Signed, pubB64, prefix string) ([]byte, error) {
	if s == nil || s.Schema != SignedSchema {
		return nil, errors.New("not a signed device statement")
	}
	pub, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("not a 32-byte Ed25519 key")
	}
	if s.Key != pubB64 {
		return nil, errors.New("signed by another key")
	}
	b, e1 := base64.StdEncoding.DecodeString(s.Statement)
	sig, e2 := base64.StdEncoding.DecodeString(s.Sig)
	if e1 != nil || e2 != nil || !ed25519.Verify(pub, append([]byte(prefix), b...), sig) {
		return nil, errors.New("signature does not verify")
	}
	return b, nil
}

// UpdateState is one update's final state, as the journal records it.
type UpdateState struct {
	UpdateID string `json:"updateId"`
	Revision int    `json:"revision"`
	State    string `json:"state"`
	HResult  string `json:"hresult,omitempty"`
}

// ResultStatement is what the agent signs about one job.
type ResultStatement struct {
	Schema string `json:"schema"`
	JobID  string `json:"jobId"`
	// PlanSHA256: sha256 of the signed plan bytes this computer verified
	// (empty when the envelope did not even decode).
	PlanSHA256         string        `json:"planSha256"`
	RustdeskID         string        `json:"rustdeskId"`
	DeviceSecretSHA256 string        `json:"deviceSecretSha256"`
	Outcome            string        `json:"outcome"`
	Reason             string        `json:"reason,omitempty"`
	CompletedAt        string        `json:"completedAt"`
	Updates            []UpdateState `json:"updates,omitempty"`
	RebootPending      *bool         `json:"rebootPending,omitempty"`
}

// ScanStatement is what the agent signs about one Windows Update scan: the
// facts the ring gate reads, as "updateId@revision" keys.
type ScanStatement struct {
	Schema             string   `json:"schema"`
	RustdeskID         string   `json:"rustdeskId"`
	DeviceSecretSHA256 string   `json:"deviceSecretSha256"`
	ScannedAt          string   `json:"scannedAt"`
	Error              bool     `json:"error"`
	RebootPending      bool     `json:"rebootPending"`
	Offered            []string `json:"offered"`
	Installed          []string `json:"installed"`
}

// TimeFormat is the one patch-scan already uses: UTC, milliseconds.
const TimeFormat = "2006-01-02T15:04:05.000Z07:00"
