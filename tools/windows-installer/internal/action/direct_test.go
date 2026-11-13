package action

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Direct mode (0.40). The approval signer signs a plan at admission, with no
// approvers, when its own operator set the business to direct; the signed
// plan says so (policy.approval "direct"). The agent then needs no approvers
// and applies no requester or contributor rule. Everything else is the same:
// this machine's own risk, the signed pause, the revocation statement, the
// window, the target and the artifact.

func direct(p map[string]any, risk string) map[string]any {
	p["policy"] = map[string]any{"risk": risk, "approvalsRequired": 0, "customerSignoff": false, "approval": "direct"}
	p["approvers"] = []any{}
	return p
}

func TestDirectPlanRunsWithNoApprovers(t *testing.T) {
	f := newFixture(t)
	expect(t, f.run(f.envelope(direct(basePlan(), "low"), nil)), "succeeded", "")
	if f.p.starts != 1 {
		t.Fatalf("starts %d", f.p.starts)
	}
}

func TestDirectPlanRunsOnAServer(t *testing.T) {
	f := newFixture(t)
	f.p.product = 3
	expect(t, f.run(f.envelope(direct(basePlan(), "high"), nil)), "succeeded", "")
}

func TestDirectKeepsTheRiskCheck(t *testing.T) {
	// Direct relaxes who approves, never what this machine is.
	f := newFixture(t)
	f.p.product = 3
	expect(t, f.run(f.envelope(direct(basePlan(), "low"), nil)), "refused", "risk_understated")
}

func TestDirectWithApproversStillRuns(t *testing.T) {
	// A ring plan under a policy approved before the business went direct
	// carries that policy's approvers, the requester among them perhaps.
	f := newFixture(t)
	p := direct(basePlan(), "low")
	p["approvers"] = []any{map[string]any{"userId": "user-requester", "name": "Dana", "role": "approver", "credentialSha256": selfSHA, "at": now.Add(-time.Minute).Format(time.RFC3339Nano)}}
	expect(t, f.run(f.envelope(p, nil)), "succeeded", "")
}

func TestDirectRefusedUnderASignedPause(t *testing.T) {
	f := newFixture(t)
	o := f.opts()
	o.Pause = &Pause{Schema: PauseSchema, IssuedAt: "2026-11-10T00:00:00Z", Reason: "incident 9", Actions: PauseScope{Businesses: []string{"biz-aaaaaaa"}}}
	r, err := Run(job, f.envelope(direct(basePlan(), "low"), nil), o)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, r, "refused", "paused")
	if f.p.starts != 0 || !strings.Contains(r.Detail, "incident 9") {
		t.Fatalf("starts %d, detail %q", f.p.starts, r.Detail)
	}
}

func TestDirectScriptRefusedWhenRevoked(t *testing.T) {
	f := newFixture(t)
	content := []byte(testScript)
	h := okHost(t, f)
	plan := direct(scriptPlan(content, map[string]any{"Name": "web"}, 5), "high")
	r := f.runRev(plan, f.revocations(now, []string{sum(content)}, nil), content, h)
	expect(t, r, "refused", "revoked")
	if h.calls != 0 {
		t.Fatal("a revoked script ran under direct mode")
	}
}

func TestDirectScriptRunByItsAuthor(t *testing.T) {
	// The author requests the run; with no approvers there is nobody to compare.
	f := newFixture(t)
	content := []byte(testScript)
	h := okHost(t, f)
	plan := direct(scriptPlan(content, map[string]any{"Name": "web"}, 5), "high")
	plan["requestedBy"] = map[string]any{"userId": "user-author1", "name": "Ada", "via": "portal"}
	expect(t, f.runScript(plan, content, h), "succeeded", "")
	if h.calls != 1 {
		t.Fatalf("calls %d", h.calls)
	}
}

func TestWithoutDirectNothingRelaxes(t *testing.T) {
	// No approvers and no flag: too few, as always.
	f := newFixture(t)
	p := basePlan()
	p["approvers"] = []any{}
	expect(t, f.run(f.envelope(p, nil)), "refused", "too_few_approvals")

	// approvalsRequired 0 without the flag does not lower the minimum.
	f = newFixture(t)
	p = basePlan()
	p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 0, "customerSignoff": false}
	p["approvers"] = []any{}
	expect(t, f.run(f.envelope(p, nil)), "refused", "too_few_approvals")

	// The requester approving, without the flag: refused.
	f = newFixture(t)
	p = basePlan()
	p["approvers"] = []any{map[string]any{"userId": "user-requester", "name": "Dana", "role": "approver", "credentialSha256": selfSHA, "at": now.Format(time.RFC3339Nano)}}
	expect(t, f.run(f.envelope(p, nil)), "refused", "requester_approved")
}

func TestDirectFlagIsOnlyDirect(t *testing.T) {
	for _, mode := range []any{"Direct", "signed", "none", true} {
		f := newFixture(t)
		p := direct(basePlan(), "low")
		p["policy"].(map[string]any)["approval"] = mode
		expect(t, f.run(f.envelope(p, nil)), "refused", "bad_plan")
	}
}

func TestDirectNeverWithCustomerSignoff(t *testing.T) {
	f := newFixture(t)
	p := direct(basePlan(), "low")
	p["policy"].(map[string]any)["customerSignoff"] = true
	expect(t, f.run(f.envelope(p, nil)), "refused", "bad_plan")
}

func TestDirectCannotBeAddedAfterSigning(t *testing.T) {
	// Only the approval signer can put the flag in: changing the plan after
	// signing breaks the signature.
	f := newFixture(t)
	signed := f.envelope(basePlan(), func(e map[string]any) {
		e["plan"] = f.envelopePlanB64(direct(basePlan(), "low"))
	})
	expect(t, f.run(signed), "refused", "bad_signature")
}

func TestAnUnknownPolicyFieldIsStillRefused(t *testing.T) {
	f := newFixture(t)
	p := basePlan()
	p["policy"] = map[string]any{"risk": "low", "approvalsRequired": 1, "customerSignoff": false, "selfApproval": true}
	expect(t, f.run(f.envelope(p, nil)), "refused", "bad_plan")
}

// envelopePlanB64: a plan's bytes as an envelope carries them, unsigned.
func (f *fixture) envelopePlanB64(plan map[string]any) string {
	pb, _ := json.Marshal(plan)
	return base64.StdEncoding.EncodeToString(pb)
}
