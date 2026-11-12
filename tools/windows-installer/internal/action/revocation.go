package action

// The signed revocation statement (v0.36).
//
// A script's content hash comes off the approval signer's allowlist, or a
// software catalog entry is archived, after a plan using it was signed. The
// plan is still genuine and still inside its window, so without this the
// agent would run it. The signer publishes a statement — every revoked
// script content hash and every revoked software entry id — signed with its
// job-approval key, which this agent trusts only from approval/keys.json in
// the offline-rooted update chain. The portal relays it; it cannot forge it,
// drop an entry from it or pass an older one off as newer:
//
//   - seq counts the revocations it lists. Revocations are permanent, so a
//     genuine statement never lists fewer. The agent keeps the newest it has
//     seen and refuses a lower seq (rollback) or one that leaves out an entry
//     it already holds.
//   - asOf is when the signer signed it, on the signer's clock — the clock
//     that also wrote the plan's signedAt.
//
// The rule, checked after the signature, the target, the window, the build,
// the approvals and the signed pause, and before the job is journaled
// "executing":
//
//  1. FRESHNESS (fail closed): a plan runs only with a statement whose asOf
//     is no older than the plan's signedAt. Such a statement lists every
//     revocation made before the plan was signed, so a plan signed after a
//     revocation can never run on an agent that has not seen it. And a
//     portal that withholds the statement gets nothing new run at all. This
//     refusal ("revocations_stale") is NOT final and NOT reported: like a
//     window that has not opened, the job is left unconsumed and the next
//     delivery tries again with a newer statement.
//  2. REVOCATION (final): a windows.script.run whose content hash, or a
//     windows.software.install whose catalog entry, is in the statement is
//     refused "revoked" and journaled done, so it can never run later.
//
// Plans signed before a revocation keep running on an agent that has not yet
// seen it — that is the window a withholding portal can hold open, bounded by
// the plan's own window (at most 24 hours). Uninstalls are never refused:
// removing a withdrawn package is what an archive is usually for.

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
)

const (
	RevocationEnvelopeSchema = "rem0te-revocations-envelope/1"
	RevocationSchema         = "rem0te-revocations/1"
	RevocationPrefix         = "rem0te-revocations-v1\n"
	// MaxRevocations: the most entries a statement may list (MAX_REVOCATIONS on the signer).
	MaxRevocations = 5000
	// MaxRevocationBytes: the most a delivered envelope may be.
	MaxRevocationBytes = 1 << 20
)

var (
	revScriptRE = regexp.MustCompile(`^[0-9a-f]{64}$`)
	revEntryRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
)

type revocationEnvelope struct {
	Schema    string `json:"schema"`
	Kid       string `json:"kid"`
	Statement string `json:"statement"`
	Sig       string `json:"sig"`
}

// Revocations is a verified statement.
type Revocations struct {
	Schema   string   `json:"schema"`
	Seq      int      `json:"seq"`
	AsOf     string   `json:"asOf"`
	Scripts  []string `json:"scripts"`
	Software []string `json:"software"`

	asOf     time.Time
	scripts  map[string]bool
	software map[string]bool
}

// ParseRevocations verifies an envelope against the approval keys and
// returns its statement. Anything short of a genuine, well-formed statement
// is an error: a forged one is never stored and never consulted.
func ParseRevocations(raw []byte, keys []Key) (*Revocations, error) {
	if len(raw) > MaxRevocationBytes {
		return nil, errors.New("revocations: too large")
	}
	var env revocationEnvelope
	if err := strictJSON(raw, &env); err != nil || env.Schema != RevocationEnvelopeSchema {
		return nil, errors.New("revocations: not a rem0te revocation envelope")
	}
	var key ed25519.PublicKey
	for _, k := range keys {
		if k.Kid == env.Kid {
			b, err := base64.StdEncoding.DecodeString(k.Ed25519)
			if err == nil && len(b) == ed25519.PublicKeySize {
				key = b
			}
		}
	}
	if key == nil {
		return nil, errors.New("revocations: not signed by an approval key this agent trusts")
	}
	body, err1 := base64.StdEncoding.DecodeString(env.Statement)
	sig, err2 := base64.StdEncoding.DecodeString(env.Sig)
	if err1 != nil || err2 != nil || !ed25519.Verify(key, append([]byte(RevocationPrefix), body...), sig) {
		return nil, errors.New("revocations: the signature does not verify")
	}
	var r Revocations
	if err := strictJSON(body, &r); err != nil || r.Schema != RevocationSchema {
		return nil, errors.New("revocations: the signed statement does not parse")
	}
	t, err := time.Parse(time.RFC3339Nano, r.AsOf)
	if err != nil {
		return nil, errors.New("revocations: asOf must be RFC 3339")
	}
	if len(r.Scripts)+len(r.Software) > MaxRevocations || r.Seq != len(r.Scripts)+len(r.Software) {
		return nil, errors.New("revocations: seq must count the entries, at most 5000")
	}
	r.asOf, r.scripts, r.software = t, map[string]bool{}, map[string]bool{}
	for _, h := range r.Scripts {
		if !revScriptRE.MatchString(h) || r.scripts[h] {
			return nil, errors.New("revocations: bad or repeated script hash")
		}
		r.scripts[h] = true
	}
	for _, id := range r.Software {
		if !revEntryRE.MatchString(id) || r.software[id] {
			return nil, errors.New("revocations: bad or repeated software entry id")
		}
		r.software[id] = true
	}
	return &r, nil
}

// covers: every entry of o is in r. A genuine later statement always covers
// an earlier one: nothing is ever un-revoked.
func (r *Revocations) covers(o *Revocations) bool {
	for h := range o.scripts {
		if !r.scripts[h] {
			return false
		}
	}
	for id := range o.software {
		if !r.software[id] {
			return false
		}
	}
	return true
}

func revocationsPath(o Options) string { return filepath.Join(o.StateDir, "actions", "revocations.json") }

// currentRevocations returns the newest genuine statement this agent holds,
// after considering the one delivered with this run (o.Revocations), and a
// note when the delivered one was not taken. The newest is kept on disk, so
// a later run with an older statement — or none — still has it.
func currentRevocations(o Options) (*Revocations, string) {
	// One writer at a time: two jobs delivered on one heartbeat run side by
	// side, and a stale write must not replace a newer one.
	lk, lerr := flock.Wait(filepath.Join(o.dir("locks"), "revocations.lock"), 10*time.Second, 50*time.Millisecond)
	if lerr == nil {
		defer lk.Release()
	}
	var held *Revocations
	if raw, err := os.ReadFile(revocationsPath(o)); err == nil {
		// Unreadable, or signed by a key no longer trusted: as if none were held.
		held, _ = ParseRevocations(raw, o.Keys)
	}
	if o.Revocations == nil {
		return held, ""
	}
	got, err := ParseRevocations(o.Revocations, o.Keys)
	switch {
	case err != nil:
		return held, "the delivered revocation statement was refused: " + err.Error()
	case held != nil && got.Seq < held.Seq:
		return held, fmt.Sprintf("refused an older revocation statement (seq %d; this computer holds seq %d)", got.Seq, held.Seq)
	case held != nil && !got.covers(held):
		return held, fmt.Sprintf("refused a revocation statement that leaves out a revocation this computer holds (seq %d)", got.Seq)
	case held != nil && got.Seq == held.Seq && !got.asOf.After(held.asOf):
		return held, ""
	}
	if lerr == nil {
		_ = atomicWrite(revocationsPath(o), json.RawMessage(o.Revocations))
	}
	return got, ""
}

// softwareEntryID: the catalog entry a software plan names (display.software.entryId).
func softwareEntryID(p *Plan) string {
	var d struct {
		Software *struct {
			EntryID string `json:"entryId"`
		} `json:"software"`
	}
	if len(p.Display) == 0 || json.Unmarshal(p.Display, &d) != nil || d.Software == nil {
		return ""
	}
	return d.Software.EntryID
}

// revocationCheck applies the rule above. It returns nil to proceed, or a
// refusal and whether that refusal is final.
func revocationCheck(p *Plan, o Options) (*Result, bool) {
	rv, note := currentRevocations(o)
	signed, err := time.Parse(time.RFC3339Nano, *p.SignedAt)
	if err != nil {
		return refuse("bad_plan", "the plan's signing time does not parse"), true
	}
	if rv == nil || rv.asOf.Before(signed) {
		d := "this computer has no revocation statement as new as the plan's signature, so it cannot tell whether what the plan runs was revoked since; it will try again on the next delivery"
		if rv != nil {
			d = fmt.Sprintf("this computer's newest revocation statement (seq %d, %s) is older than the plan's signature (%s); it will try again on the next delivery", rv.Seq, rv.AsOf, *p.SignedAt)
		}
		if note != "" {
			d += " (" + note + ")"
		}
		return refuse("revocations_stale", d), false
	}
	switch p.Action.ID {
	case "windows.script.run":
		sha, _ := p.Params["sha256"].(string)
		if (p.Script != nil && rv.scripts[p.Script.ContentSHA256]) || rv.scripts[sha] {
			return refuse("revoked", fmt.Sprintf("this script's content was removed from the approval signer's allowlist after the plan was signed (revocation statement seq %d, %s); nothing was run", rv.Seq, rv.AsOf)), true
		}
	case "windows.software.install":
		id := softwareEntryID(p)
		if id == "" {
			return refuse("software_entry_missing", "a software plan must name the catalog entry that is its source"), true
		}
		if rv.software[id] {
			return refuse("revoked", fmt.Sprintf("this software catalog entry was archived after the plan was signed (revocation statement seq %d, %s); nothing was installed", rv.Seq, rv.AsOf)), true
		}
	}
	return nil, true
}
