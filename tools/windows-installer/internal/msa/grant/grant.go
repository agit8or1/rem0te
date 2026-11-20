// Package grant verifies a Managed Secure Access session grant (0.71, build
// step 3 in docs/managed-secure-access.md, §3.2).
//
// It is pure — no I/O, no clock, no Windows calls — and in 0.71 it is
// imported by no command: the agent binary is unchanged, and nothing on a
// computer acts on a grant until build step 4 wires a poller and the
// enforcement in (check-security-invariants §81). It lives in its own
// package, not in internal/msa, because the agent already imports
// internal/msa for the preflight.
//
// The document, the signing prefix and the reason codes are the portal's
// (apps/api/src/msa/grant.ts). Both are tested against one fixture,
// internal/msa/testdata/msa-grants.json.
package grant

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"regexp"
	"time"
)

// Prefix is the signing prefix: Ed25519 signs Prefix + the grant's bytes.
// The portal's GRANT_PREFIX is identical (§81).
const Prefix = "rem0te-msa-grant-v1\n"

// Version is the only grant version this verifier accepts.
const Version = 1

// MaxStartWindow is the longest notAfter may be after notBefore.
const MaxStartWindow = 5 * time.Minute

// ClockSkew is how far the computer's clock may disagree with the portal's,
// on either edge of the window.
const ClockSkew = 30 * time.Second

// MaxGrantBytes bounds the decoded grant.
const MaxGrantBytes = 2048

// Reason codes, in the order Verify checks them. The portal's REASONS list
// is the same, in the same order.
const (
	EnvelopeMalformed    = "envelope_malformed"
	UnknownKey           = "unknown_key"
	BadSignature         = "bad_signature"
	GrantMalformed       = "grant_malformed"
	UnsupportedVersion   = "unsupported_version"
	BadWindow            = "bad_window"
	WrongEndpoint        = "wrong_endpoint"
	WrongRustdeskID      = "wrong_rustdesk_id"
	RemotePaused         = "remote_paused"
	NotYetValid          = "not_yet_valid"
	Expired              = "expired"
	Replayed             = "replayed"
	ModeNotAllowed       = "mode_not_allowed"
	PermissionNotAllowed = "permission_not_allowed"
)

// Reasons lists every reason code in check order.
var Reasons = []string{
	EnvelopeMalformed, UnknownKey, BadSignature, GrantMalformed, UnsupportedVersion, BadWindow,
	WrongEndpoint, WrongRustdeskID, RemotePaused, NotYetValid, Expired, Replayed,
	ModeNotAllowed, PermissionNotAllowed,
}

var (
	grantIDRE  = regexp.MustCompile(`^[0-9a-f]{32}$`)
	entityIDRE = regexp.MustCompile(`^[a-z0-9]{20,40}$`)
	rustdeskRE = regexp.MustCompile(`^[0-9]{6,15}$`)
	timeRE     = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$`)
	passwordRE = regexp.MustCompile(`^[A-Za-z0-9]{24}$`)
	keyIDRE    = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

// Permissions is what a grant allows beyond the mode.
type Permissions struct {
	Clipboard bool `json:"clipboard"`
	Files     bool `json:"files"`
	Audio     bool `json:"audio"`
	Tunnel    bool `json:"tunnel"`
	Restart   bool `json:"restart"`
}

// Grant is the signed document, fields in canonical order.
type Grant struct {
	V            int         `json:"v"`
	GrantID      string      `json:"grantId"`
	EndpointID   string      `json:"endpointId"`
	RustdeskID   string      `json:"rustdeskId"`
	BusinessID   string      `json:"businessId"`
	TechnicianID string      `json:"technicianId"`
	Mode         string      `json:"mode"`
	Permissions  Permissions `json:"permissions"`
	Consent      string      `json:"consent"`
	NotBefore    string      `json:"notBefore"`
	NotAfter     string      `json:"notAfter"`
	MaxMinutes   int         `json:"maxMinutes"`
	IdleMinutes  int         `json:"idleMinutes"`
	Password     string      `json:"password"`
}

// Ceiling is the most this computer allows.
type Ceiling struct {
	Mode        string // "view" or "control"
	Permissions Permissions
}

// Context is everything Verify needs from the agent: the published grant
// keys by key id, the computer's own identity, the time, the grant ids it
// has already used, its ceiling, and whether its signed pause file says
// `remote`.
type Context struct {
	Keys         map[string]ed25519.PublicKey
	EndpointID   string
	RustdeskID   string
	Now          time.Time
	Seen         map[string]bool
	Ceiling      Ceiling
	RemotePaused bool
}

// Result is the verdict: OK with the grant, or a reason code.
type Result struct {
	OK     bool
	Reason string
	Grant  *Grant
}

func no(reason string) Result { return Result{Reason: reason} }

// strictB64 decodes standard padded base64 and refuses any other spelling.
func strictB64(s string, max int) ([]byte, bool) {
	if s == "" || len(s) > max || len(s)%4 != 0 {
		return nil, false
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || base64.StdEncoding.EncodeToString(b) != s {
		return nil, false
	}
	return b, true
}

func instant(s string) (time.Time, bool) {
	if !timeRE.MatchString(s) {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil || t.UTC().Format("2006-01-02T15:04:05Z") != s {
		return time.Time{}, false
	}
	return t, true
}

// Canonical serialises a grant in the one form that is signed: the fixed
// key order and no whitespace. Every string is charset-checked before it
// gets here, so nothing is escaped.
func Canonical(g *Grant) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(g)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

func fieldsOK(g *Grant) bool {
	if !grantIDRE.MatchString(g.GrantID) || !entityIDRE.MatchString(g.EndpointID) || !rustdeskRE.MatchString(g.RustdeskID) ||
		!entityIDRE.MatchString(g.BusinessID) || !entityIDRE.MatchString(g.TechnicianID) || !passwordRE.MatchString(g.Password) {
		return false
	}
	if g.Mode != "view" && g.Mode != "control" {
		return false
	}
	if g.Consent != "required" && g.Consent != "not_required" {
		return false
	}
	if g.MaxMinutes < 1 || g.MaxMinutes > 480 || g.IdleMinutes < 1 || g.IdleMinutes > 120 || g.IdleMinutes > g.MaxMinutes {
		return false
	}
	_, ok1 := instant(g.NotBefore)
	_, ok2 := instant(g.NotAfter)
	return ok1 && ok2
}

// exactKeys reports whether a JSON object has exactly these keys, each once.
func exactKeys(raw []byte, want []string) bool {
	dec := json.NewDecoder(bytes.NewReader(raw))
	t, err := dec.Token()
	if err != nil || t != json.Delim('{') {
		return false
	}
	seen := map[string]bool{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return false
		}
		k, ok := kt.(string)
		if !ok || seen[k] {
			return false
		}
		seen[k] = true
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return false
		}
	}
	if len(seen) != len(want) {
		return false
	}
	for _, k := range want {
		if !seen[k] {
			return false
		}
	}
	return true
}

var envelopeKeys = []string{"keyId", "grant", "sig"}

// Verify checks an envelope, in the portal's order (Reasons).
func Verify(envelope []byte, c Context) Result {
	if !exactKeys(envelope, envelopeKeys) {
		return no(EnvelopeMalformed)
	}
	var e struct {
		KeyID string `json:"keyId"`
		Grant string `json:"grant"`
		Sig   string `json:"sig"`
	}
	dec := json.NewDecoder(bytes.NewReader(envelope))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&e); err != nil || !keyIDRE.MatchString(e.KeyID) {
		return no(EnvelopeMalformed)
	}
	if _, err := dec.Token(); err != io.EOF {
		return no(EnvelopeMalformed) // anything after the envelope
	}
	body, ok := strictB64(e.Grant, (MaxGrantBytes+2)/3*4)
	sig, ok2 := strictB64(e.Sig, 88)
	if !ok || !ok2 || len(sig) != ed25519.SignatureSize {
		return no(EnvelopeMalformed)
	}
	pub, ok := c.Keys[e.KeyID]
	if !ok || len(pub) != ed25519.PublicKeySize {
		return no(UnknownKey)
	}
	if !ed25519.Verify(pub, append([]byte(Prefix), body...), sig) {
		return no(BadSignature)
	}

	var head map[string]json.RawMessage
	if err := json.Unmarshal(body, &head); err != nil || head == nil {
		return no(GrantMalformed)
	}
	var v float64
	if raw, has := head["v"]; !has || json.Unmarshal(raw, &v) != nil || v != Version {
		return no(UnsupportedVersion)
	}
	var g Grant
	gd := json.NewDecoder(bytes.NewReader(body))
	gd.DisallowUnknownFields()
	if err := gd.Decode(&g); err != nil || g.V != Version || !fieldsOK(&g) || !bytes.Equal(Canonical(&g), body) {
		return no(GrantMalformed)
	}
	nb, _ := instant(g.NotBefore)
	na, _ := instant(g.NotAfter)
	if !na.After(nb) || na.Sub(nb) > MaxStartWindow {
		return no(BadWindow)
	}
	if g.EndpointID != c.EndpointID {
		return no(WrongEndpoint)
	}
	if g.RustdeskID != c.RustdeskID {
		return no(WrongRustdeskID)
	}
	if c.RemotePaused {
		return no(RemotePaused)
	}
	if c.Now.Before(nb.Add(-ClockSkew)) {
		return no(NotYetValid)
	}
	if c.Now.After(na.Add(ClockSkew)) {
		return no(Expired)
	}
	if c.Seen[g.GrantID] {
		return no(Replayed)
	}
	if g.Mode == "control" && c.Ceiling.Mode != "control" {
		return no(ModeNotAllowed)
	}
	p, cp := g.Permissions, c.Ceiling.Permissions
	if (p.Clipboard && !cp.Clipboard) || (p.Files && !cp.Files) || (p.Audio && !cp.Audio) || (p.Tunnel && !cp.Tunnel) || (p.Restart && !cp.Restart) {
		return no(PermissionNotAllowed)
	}
	return Result{OK: true, Grant: &g}
}
