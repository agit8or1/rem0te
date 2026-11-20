package grant

// Revocations (0.73, build step 5, docs/managed-secure-access.md §3.4).
//
// A revocation ends sessions on ONE computer. The portal signs it with the
// same grant key as a grant, under its own prefix, so a grant signature can
// never be read as a revocation nor the reverse, and in its own envelope
// field (`revocation`, never `grant`). The document, prefix and reason codes
// are the portal's (apps/api/src/msa/revocation.ts); both are tested
// against internal/msa/testdata/msa-revocations.json.
//
// A revocation only ever reduces: it ends the open session when that
// session's grant is named, or — All — when the session's grant started no
// later than the revocation was issued; every grant it names joins the
// replay set. Nothing in it can grant, widen or extend.
//
// Pure, like grant.go: the same imports, no clock.

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"time"
)

// RevocationPrefix is the signing prefix. The portal's REVOCATION_PREFIX is identical (§83).
const RevocationPrefix = "rem0te-msa-revoke-v1\n"

// RevocationVersion is the only revocation version accepted.
const RevocationVersion = 1

// RevocationWindow is the longest notAfter may be after issuedAt: longer
// than any grant can live (a 5-minute start window plus 480 minutes).
const RevocationWindow = 9 * time.Hour

// RevocationMaxGrants bounds the named grants.
const RevocationMaxGrants = 20

// MaxRevocationBytes bounds the decoded document.
const MaxRevocationBytes = 2048

// Revocation reason codes, in the order VerifyRevocation checks them (the
// portal's REVOCATION_REASONS). Shared codes keep the grant's constants.
const (
	RevocationMalformed = "revocation_malformed"
)

// RevocationReasons lists every reason code in check order.
var RevocationReasons = []string{
	EnvelopeMalformed, UnknownKey, BadSignature, RevocationMalformed, UnsupportedVersion, BadWindow,
	WrongEndpoint, WrongRustdeskID, NotYetValid, Expired, Replayed,
}

// Revocation is the signed document, fields in canonical order.
type Revocation struct {
	V            int      `json:"v"`
	RevocationID string   `json:"revocationId"`
	EndpointID   string   `json:"endpointId"`
	RustdeskID   string   `json:"rustdeskId"`
	All          bool     `json:"all"`
	GrantIDs     []string `json:"grantIds"`
	IssuedAt     string   `json:"issuedAt"`
	NotAfter     string   `json:"notAfter"`
}

// RevocationContext is what VerifyRevocation needs from the agent.
type RevocationContext struct {
	Keys       map[string]ed25519.PublicKey
	EndpointID string
	RustdeskID string
	Now        time.Time
	// Seen: revocation ids already acted on.
	Seen map[string]bool
}

// CanonicalRevocation serialises a revocation in its one signed form.
func CanonicalRevocation(r *Revocation) []byte {
	c := *r
	if c.GrantIDs == nil {
		c.GrantIDs = []string{}
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(&c)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

func revocationFieldsOK(r *Revocation) bool {
	if !grantIDRE.MatchString(r.RevocationID) || !entityIDRE.MatchString(r.EndpointID) || !rustdeskRE.MatchString(r.RustdeskID) {
		return false
	}
	if r.GrantIDs == nil || len(r.GrantIDs) > RevocationMaxGrants {
		return false
	}
	for i, id := range r.GrantIDs {
		if !grantIDRE.MatchString(id) || (i > 0 && !(r.GrantIDs[i-1] < id)) {
			return false
		}
	}
	if !r.All && len(r.GrantIDs) == 0 {
		return false
	}
	_, ok1 := instant(r.IssuedAt)
	_, ok2 := instant(r.NotAfter)
	return ok1 && ok2
}

var revocationEnvelopeKeys = []string{"keyId", "revocation", "sig"}

// VerifyRevocation checks an envelope, in the portal's order
// (RevocationReasons). It returns the revocation and "" when it holds, or
// a reason code.
func VerifyRevocation(envelope []byte, c RevocationContext) (*Revocation, string) {
	if !exactKeys(envelope, revocationEnvelopeKeys) {
		return nil, EnvelopeMalformed
	}
	var e struct {
		KeyID      string `json:"keyId"`
		Revocation string `json:"revocation"`
		Sig        string `json:"sig"`
	}
	dec := json.NewDecoder(bytes.NewReader(envelope))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&e); err != nil || !keyIDRE.MatchString(e.KeyID) {
		return nil, EnvelopeMalformed
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, EnvelopeMalformed
	}
	body, ok := strictB64(e.Revocation, (MaxRevocationBytes+2)/3*4)
	sig, ok2 := strictB64(e.Sig, 88)
	if !ok || !ok2 || len(sig) != ed25519.SignatureSize {
		return nil, EnvelopeMalformed
	}
	pub, ok := c.Keys[e.KeyID]
	if !ok || len(pub) != ed25519.PublicKeySize {
		return nil, UnknownKey
	}
	if !ed25519.Verify(pub, append([]byte(RevocationPrefix), body...), sig) {
		return nil, BadSignature
	}

	var head map[string]json.RawMessage
	if err := json.Unmarshal(body, &head); err != nil || head == nil {
		return nil, RevocationMalformed
	}
	var v float64
	if raw, has := head["v"]; !has || json.Unmarshal(raw, &v) != nil || v != RevocationVersion {
		return nil, UnsupportedVersion
	}
	var r Revocation
	rd := json.NewDecoder(bytes.NewReader(body))
	rd.DisallowUnknownFields()
	if err := rd.Decode(&r); err != nil || r.V != RevocationVersion || !revocationFieldsOK(&r) || !bytes.Equal(CanonicalRevocation(&r), body) {
		return nil, RevocationMalformed
	}
	ia, _ := instant(r.IssuedAt)
	na, _ := instant(r.NotAfter)
	if !na.After(ia) || na.Sub(ia) > RevocationWindow {
		return nil, BadWindow
	}
	if r.EndpointID != c.EndpointID {
		return nil, WrongEndpoint
	}
	if r.RustdeskID != c.RustdeskID {
		return nil, WrongRustdeskID
	}
	if c.Now.Before(ia.Add(-ClockSkew)) {
		return nil, NotYetValid
	}
	if c.Now.After(na.Add(ClockSkew)) {
		return nil, Expired
	}
	if c.Seen[r.RevocationID] {
		return nil, Replayed
	}
	return &r, ""
}

// Ends reports whether a verified revocation ends the session open under
// grantID: named, or All and that grant's notBefore is no later than the
// revocation's issuedAt. The portal's revocationEnds is the same rule.
func Ends(r *Revocation, grantID string, notBefore time.Time) bool {
	for _, id := range r.GrantIDs {
		if id == grantID {
			return true
		}
	}
	if !r.All {
		return false
	}
	ia, ok := instant(r.IssuedAt)
	return ok && !notBefore.After(ia)
}

// RevocationNotAfter is when a verified revocation stops mattering (for pruning a seen set).
func RevocationNotAfter(r *Revocation) time.Time {
	t, _ := instant(r.NotAfter)
	return t
}
