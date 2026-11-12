package action

// Signed results (v0.34). Every final result this agent reports carries its
// own signature, by this computer's device key (internal/devsig), over the
// facts a patch policy's ring gate reads: the job, the exact plan, this
// computer's enrolled identity, the outcome and each update's final state.
// The portal relays the signature; the approval signer verifies it before it
// lets a later ring of a policy be signed. Nothing here is consulted to
// decide whether a plan runs: the signature is about what happened, after.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/agit8or1/rem0te/windows-installer/internal/devsig"
)

// planSHA256 is the sha256 of the plan bytes inside an envelope, as the
// approval signer signed them — "" when the envelope does not decode, in
// which case the result can name no plan.
func planSHA256(envelope []byte) string {
	var env Envelope
	if json.Unmarshal(envelope, &env) != nil || env.Plan == "" {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(env.Plan)
	if err != nil {
		return ""
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ResultStatement is exactly what signResult signs for r.
func ResultStatement(r Result, planSHA, rustdeskID, secretSHA256, at string) devsig.ResultStatement {
	st := devsig.ResultStatement{
		Schema: devsig.ResultStatementSchema, JobID: r.JobID, PlanSHA256: planSHA,
		RustdeskID: rustdeskID, DeviceSecretSHA256: strings.ToLower(secretSHA256),
		Outcome: r.Outcome, Reason: r.Reason, CompletedAt: at,
	}
	for _, u := range r.Updates {
		st.Updates = append(st.Updates, devsig.UpdateState{UpdateID: u.UpdateID, Revision: u.Revision, State: u.State, HResult: u.HResult})
	}
	if r.Reboot != nil {
		p := r.Reboot.Pending
		st.RebootPending = &p
	}
	return st
}

// signResult sets r.Signed. A key or identity that cannot be read leaves the
// result unsigned (or signed for an empty identity, which the signer refuses
// as another device's): it is still reported, and still counts as failed —
// never as succeeded — wherever a signature is required.
func signResult(o *Options, r *Result, planSHA, at string) {
	r.Signed = nil
	if o.ResultKey == nil {
		k, err := devsig.Load(o.StateDir)
		if err != nil {
			return
		}
		o.ResultKey = k
	}
	rid, sec := "", ""
	if o.Platform != nil {
		rid, sec, _ = o.Platform.DeviceIdentity()
	}
	if s, err := devsig.Sign(o.ResultKey, devsig.ResultPrefix, ResultStatement(*r, planSHA, rid, sec, at)); err == nil {
		r.Signed = s
	}
}
