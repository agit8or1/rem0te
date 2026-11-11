// Package action executes approved catalog actions (v0.26) — the copy of the
// rules that decides what actually runs on the computer.
//
// An action arrives as an envelope: the exact canonical plan bytes an
// approval signer signed, its Ed25519 signature, and a key id. The agent
// trusts approval keys only from approval/keys.json, a target of the
// offline-rooted update chain — never from the portal. Before anything runs:
//
//  1. The job journal is consulted first. A job id is executed at most once,
//     ever: a re-delivered envelope gets the recorded result, and a job whose
//     journal says "executing" (the agent died mid-action) is reported
//     uncertain, with what the service looks like now — never re-run.
//  2. The signature, the key id, and the plan's job id.
//  3. The action and its parameters against the catalog compiled in here.
//  4. The target: this machine's own RustDesk ID and sha256(device secret).
//  5. The window, by this machine's clock.
//  6. The artifact: the plan names the signed agent build; it must be this one.
//  7. The approvals: enough distinct approvers for the risk THIS machine
//     computes from its own product type (a server is always high impact,
//     whatever the plan says), none of them the requester, plus a customer
//     sign-off when the plan's policy says so.
//
// Only then is the journal written ("executing"), and only then does the
// action run. Its result says what was observed and nothing more.
package action

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

const (
	EnvelopeSchema = "rem0te-action-envelope/1"
	PlanSchema     = "rem0te-action-plan/1"
	KeysSchema     = "rem0te-approval-keys/1"
	SigningPrefix  = "rem0te-action-plan-v1\n"
	// KeysTarget is the TUF target that carries the approval public keys.
	KeysTarget = "approval/keys.json"
)

// Platform is everything that touches Windows; tests fake it.
type Platform interface {
	// ServiceState: "running", "stopped", "start_pending", ... or an error.
	ServiceState(name string) (string, error)
	StartService(name string) error
	// ProductType: 1 workstation, 2 domain controller, 3 server.
	ProductType() (int, error)
	// DeviceIdentity: this machine's RustDesk ID and sha256(device secret), hex.
	DeviceIdentity() (rustdeskID, secretSHA256 string, err error)
	SelfSHA256() (string, error)
	Sleep(time.Duration)
}

type Key struct {
	Kid     string `json:"kid"`
	Ed25519 string `json:"ed25519"`
}
type KeysDoc struct {
	Schema string `json:"schema"`
	Keys   []Key  `json:"keys"`
}

type Envelope struct {
	Schema string `json:"schema"`
	Kid    string `json:"kid"`
	Plan   string `json:"plan"`
	Sig    string `json:"sig"`
}

type Target struct {
	EndpointID         string `json:"endpointId"`
	BusinessID         string `json:"businessId"`
	BusinessName       string `json:"businessName"`
	Hostname           string `json:"hostname"`
	DeviceClass        string `json:"deviceClass"`
	RustdeskID         string `json:"rustdeskId"`
	DeviceSecretSHA256 string `json:"deviceSecretSha256"`
}
type Approver struct {
	UserID           string `json:"userId"`
	Name             string `json:"name"`
	Role             string `json:"role"`
	CredentialSHA256 string `json:"credentialSha256"`
	At               string `json:"at"`
}
type Plan struct {
	Schema string `json:"schema"`
	JobID  string `json:"jobId"`
	Action struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	} `json:"action"`
	Artifact struct {
		Target string `json:"target"`
		SHA256 string `json:"sha256"`
	} `json:"artifact"`
	Params      map[string]any `json:"params"`
	Targets     []Target       `json:"targets"`
	RequestedBy struct {
		UserID string `json:"userId"`
		Name   string `json:"name"`
		Via    string `json:"via"`
	} `json:"requestedBy"`
	Origin struct {
		Kind      string  `json:"kind"`
		TicketRef *string `json:"ticketRef"`
	} `json:"origin"`
	Reason string `json:"reason"`
	Policy struct {
		Risk              string `json:"risk"`
		ApprovalsRequired int    `json:"approvalsRequired"`
		CustomerSignoff   bool   `json:"customerSignoff"`
	} `json:"policy"`
	Window struct {
		NotBefore string `json:"notBefore"`
		NotAfter  string `json:"notAfter"`
	} `json:"window"`
	// Display: what the approver was shown (update KBs and titles). Signed,
	// and deliberately never read here: decisions come from Windows Update.
	Display   json.RawMessage `json:"display,omitempty"`
	CreatedAt string          `json:"createdAt"`
	Approvers []Approver      `json:"approvers"`
	SignedAt  *string         `json:"signedAt"`
}

// Result is what the heartbeat reports. Observations only.
type Result struct {
	JobID       string            `json:"jobId"`
	Outcome     string            `json:"outcome"` // succeeded already_running failed refused not_executed uncertain
	Reason      string            `json:"reason,omitempty"`
	Detail      string            `json:"detail,omitempty"`
	Observed    map[string]string `json:"observed,omitempty"`
	ExecutedAt  string            `json:"executedAt,omitempty"`
	AgentSHA256 string            `json:"agentSha256,omitempty"`
	// Updates and Reboot: windows.update.install only.
	Updates []patch.Outcome `json:"updates,omitempty"`
	Reboot  *patch.Reboot   `json:"reboot,omitempty"`
	// Logs: windows.logs.collect only. Bounded and redacted (maintenance.go).
	Logs []LogSection `json:"logs,omitempty"`
}

type journal struct {
	JobID         string `json:"jobId"`
	State         string `json:"state"` // executing | done
	At            string `json:"at"`
	ActionID      string `json:"actionId,omitempty"`
	ActionVersion int    `json:"actionVersion,omitempty"`
	// Params: the verified plan's (v0.32), so an interrupted job can say
	// what it was working on. Step: how far an executing job got.
	Params map[string]any `json:"params,omitempty"`
	Step   string         `json:"step,omitempty"`
	Result *Result        `json:"result,omitempty"`
}

type Options struct {
	StateDir string
	Keys     []Key
	Platform Platform
	Now      func() time.Time
	// Verification delays after starting; 10s and 30s by default.
	Checks []time.Duration
	// Windows Update (windows.update.install); nil where not available.
	WUA      patch.WUA
	Registry patch.Registry
	// How long an install waits for a scan in progress; 20 minutes by default.
	WUAWait time.Duration
	// The signed pause (control/pause.json), or nil when none is published.
	Pause *Pause
	// Maintenance actions (v0.32); nil where not available.
	Maint Maintenance
	// How long a service restart waits for the stop; 60 seconds by default.
	StopTimeout time.Duration
}

var jobRE = regexp.MustCompile(`^[a-f0-9]{32}$`)

// ErrBadJob is returned for a job id that cannot even name a journal entry.
var ErrBadJob = errors.New("invalid job id")

func (o *Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}
func (o *Options) dir(sub string) string { return filepath.Join(o.StateDir, "actions", sub) }

// Run handles one delivered envelope for jobID. It always returns a Result to
// report (and writes it to the results directory), except for an unusable job id.
func Run(jobID string, envelope []byte, o Options) (Result, error) {
	if !jobRE.MatchString(jobID) {
		return Result{}, ErrBadJob
	}
	for _, d := range []string{"journal", "results", "locks"} {
		if err := os.MkdirAll(o.dir(d), 0o700); err != nil {
			return Result{}, err
		}
	}
	// 0. One process per job. A long action (an update install) outlives many
	// heartbeats, and each re-delivers the envelope: those find the lock held
	// and leave, reporting nothing. The OS releases the lock when its holder
	// exits, however it exits — so "executing" in the journal with the lock
	// free means the agent died mid-action.
	lk, err := flock.TryLock(filepath.Join(o.dir("locks"), jobID+".lock"))
	if errors.Is(err, flock.ErrBusy) {
		return Result{JobID: jobID, Outcome: "in_progress", Detail: "already running on this computer"}, nil
	}
	if err != nil {
		return Result{}, err
	}
	defer lk.Release()

	// 1. The journal first: at most once, ever.
	if j, ok := readJournal(o, jobID); ok {
		if j.State == "done" && j.Result != nil {
			return report(o, *j.Result)
		}
		r := Result{JobID: jobID, Outcome: "uncertain", Reason: "interrupted",
			Detail: "the agent stopped while this action was running; it will not run it again"}
		if j.Step != "" {
			r.Detail += " (it had reached: " + j.Step + ")"
		}
		if a := Lookup(j.ActionID, j.ActionVersion); a != nil && a.Interrupted != nil {
			r.Observed = a.Interrupted(j.Params, o)
		} else if st, err := o.Platform.ServiceState(ServiceName); err == nil && j.ActionID == "" {
			r.Observed = map[string]string{"now": st} // journals written by 0.26
		}
		writeJournal(o, journal{JobID: jobID, State: "done", At: o.now().UTC().Format(time.RFC3339), Result: &r})
		return report(o, r)
	}

	plan, refusal := verify(jobID, envelope, o)
	if refusal != nil {
		r := *refusal
		r.JobID = jobID
		// A plan that is not valid YET is not consumed: the clocks may simply
		// disagree. Everything else is final, so it can never run later.
		// Nor is it reported: the portal would record a refusal as final.
		if r.Reason == "not_yet_valid" {
			return r, nil
		}
		writeJournal(o, journal{JobID: jobID, State: "done", At: o.now().UTC().Format(time.RFC3339), Result: &r})
		return report(o, r)
	}

	// 1b. The signed pause (v0.28). Checked once the plan is known to be
	// genuine and for this computer, so the refusal names a real job. Final,
	// like any refusal: once the pause is lifted, request it again.
	if o.Pause != nil {
		rid, _, _ := o.Platform.DeviceIdentity()
		if o.Pause.ActionsPaused(plan.Targets[0].BusinessID, rid) {
			r := Result{JobID: jobID, Outcome: "refused", Reason: "paused", Detail: "actions are paused by the signed pause (" + o.Pause.IssuedAt + "): " + o.Pause.Reason}
			writeJournal(o, journal{JobID: jobID, State: "done", At: o.now().UTC().Format(time.RFC3339), Result: &r})
			return report(o, r)
		}
	}

	// 1c. Read-only checks an action needs on this computer now (v0.32: no
	// RustDesk session open before a restart). Final, like a refusal.
	if a := Lookup(plan.Action.ID, plan.Action.Version); a.Precheck != nil {
		if pr := a.Precheck(plan, o); pr != nil {
			r := *pr
			r.JobID = jobID
			writeJournal(o, journal{JobID: jobID, State: "done", At: o.now().UTC().Format(time.RFC3339), Result: &r})
			return report(o, r)
		}
	}

	// 2. Consume the job before acting on it.
	if err := writeJournal(o, journal{JobID: jobID, State: "executing", At: o.now().UTC().Format(time.RFC3339), ActionID: plan.Action.ID, ActionVersion: plan.Action.Version, Params: plan.Params}); err != nil {
		return Result{}, fmt.Errorf("journal: %w", err)
	}
	r := Lookup(plan.Action.ID, plan.Action.Version).Execute(plan, o)
	r.JobID = jobID
	writeJournal(o, journal{JobID: jobID, State: "done", At: o.now().UTC().Format(time.RFC3339), Result: &r})
	return report(o, r)
}

func refuse(reason, detail string) *Result {
	return &Result{Outcome: "refused", Reason: reason, Detail: detail}
}

func verify(jobID string, raw []byte, o Options) (*Plan, *Result) {
	var env Envelope
	if err := strictJSON(raw, &env); err != nil || env.Schema != EnvelopeSchema {
		return nil, refuse("bad_envelope", "not a rem0te action envelope")
	}
	var key ed25519.PublicKey
	for _, k := range o.Keys {
		if k.Kid == env.Kid {
			b, err := base64.StdEncoding.DecodeString(k.Ed25519)
			if err == nil && len(b) == ed25519.PublicKeySize {
				key = b
			}
		}
	}
	if key == nil {
		return nil, refuse("unknown_key", "the envelope is not signed by an approval key this agent trusts")
	}
	planBytes, err1 := base64.StdEncoding.DecodeString(env.Plan)
	sig, err2 := base64.StdEncoding.DecodeString(env.Sig)
	if err1 != nil || err2 != nil || !ed25519.Verify(key, append([]byte(SigningPrefix), planBytes...), sig) {
		return nil, refuse("bad_signature", "the approval signature does not verify")
	}
	var p Plan
	if err := strictJSON(planBytes, &p); err != nil || p.Schema != PlanSchema {
		return nil, refuse("bad_plan", "the signed plan does not parse")
	}
	if p.JobID != jobID {
		return nil, refuse("job_mismatch", "the signed plan is for a different job")
	}
	if p.SignedAt == nil {
		return nil, refuse("not_signed", "the plan carries no signing time")
	}
	a := Lookup(p.Action.ID, p.Action.Version)
	if a == nil {
		return nil, refuse("unknown_action", "this agent's catalog does not contain that action")
	}
	if !a.ParamsOK(p.Params) {
		return nil, refuse("params_not_allowed", "parameters outside the catalog")
	}
	if len(p.Targets) < 1 || len(p.Targets) > a.MaxTargets {
		return nil, refuse("bad_targets", fmt.Sprintf("this action allows 1 to %d targets per plan", a.MaxTargets))
	}
	ids, eps := map[string]bool{}, map[string]bool{}
	for _, t := range p.Targets {
		if ids[t.RustdeskID] || eps[t.EndpointID] {
			return nil, refuse("bad_targets", "a computer is named twice")
		}
		ids[t.RustdeskID], eps[t.EndpointID] = true, true
	}
	rid, sec, err := o.Platform.DeviceIdentity()
	if err != nil || rid == "" || sec == "" {
		return nil, refuse("no_identity", "this machine cannot read its own enrolled identity")
	}
	mine := false
	for _, t := range p.Targets {
		if t.RustdeskID == rid && strings.EqualFold(t.DeviceSecretSHA256, sec) {
			mine = true
		}
	}
	if !mine {
		return nil, refuse("wrong_target", "this plan names a different computer")
	}
	nb, e1 := time.Parse(time.RFC3339Nano, p.Window.NotBefore)
	na, e2 := time.Parse(time.RFC3339Nano, p.Window.NotAfter)
	now := o.now()
	if e1 != nil || e2 != nil || !na.After(nb) {
		return nil, refuse("bad_window", "the plan's window does not parse")
	}
	if a.MaxWindow > 0 && na.Sub(nb) > a.MaxWindow {
		return nil, refuse("bad_window", "the plan's window is longer than this action allows")
	}
	if now.Before(nb) {
		return nil, refuse("not_yet_valid", "the plan's window has not opened by this computer's clock")
	}
	if !now.Before(na) {
		return nil, &Result{Outcome: "not_executed", Reason: "expired", Detail: "the plan's window closed before it reached this computer"}
	}
	self, err := o.Platform.SelfSHA256()
	if err != nil || p.Artifact.Target != "windows/rem0te-agent.exe" || !strings.EqualFold(self, p.Artifact.SHA256) {
		return nil, refuse("artifact_mismatch", "the plan names a different agent build from this one")
	}
	pt, err := o.Platform.ProductType()
	if err != nil {
		return nil, refuse("no_product_type", "cannot tell whether this computer is a workstation")
	}
	local := a.Risk(pt, len(p.Targets))
	if local == "high" && p.Policy.Risk != "high" {
		return nil, refuse("risk_understated", "this is a high-impact action here, so the plan needed high-impact approval")
	}
	need := MinApprovals[local]
	if p.Policy.ApprovalsRequired > need {
		need = p.Policy.ApprovalsRequired
	}
	approvers, customers := map[string]bool{}, map[string]bool{}
	for _, ap := range p.Approvers {
		if ap.UserID == p.RequestedBy.UserID {
			return nil, refuse("requester_approved", "the requester is among the approvers")
		}
		switch ap.Role {
		case "approver":
			approvers[ap.UserID] = true
		case "customer":
			customers[ap.UserID] = true
		}
	}
	if len(approvers) < need {
		return nil, refuse("too_few_approvals", fmt.Sprintf("needs %d distinct approvers, has %d", need, len(approvers)))
	}
	if p.Policy.CustomerSignoff {
		ok := false
		for c := range customers {
			if !approvers[c] {
				ok = true
			}
		}
		if !ok {
			return nil, refuse("no_customer_signoff", "customer sign-off is required and missing")
		}
	}
	return &p, nil
}

func startSpooler(p *Plan, o Options) Result {
	r := Result{ExecutedAt: o.now().UTC().Format(time.RFC3339), Observed: map[string]string{}}
	if s, err := o.Platform.SelfSHA256(); err == nil {
		r.AgentSHA256 = s
	}
	before, err := o.Platform.ServiceState(ServiceName)
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "service_query_failed", trim(err.Error())
		return r
	}
	r.Observed["before"] = before
	if before == "running" {
		r.Outcome, r.Detail = "already_running", "the service was already running; nothing was changed"
		return r
	}
	if err := o.Platform.StartService(ServiceName); err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "start_failed", trim(err.Error())
		if st, e := o.Platform.ServiceState(ServiceName); e == nil {
			r.Observed["after"] = st
		}
		return r
	}
	checks := o.Checks
	if checks == nil {
		checks = []time.Duration{10 * time.Second, 20 * time.Second}
	}
	elapsed := time.Duration(0)
	ok := true
	for _, d := range checks {
		o.Platform.Sleep(d)
		elapsed += d
		st, err := o.Platform.ServiceState(ServiceName)
		if err != nil {
			st = "unknown"
		}
		r.Observed[fmt.Sprintf("after%ds", int(elapsed.Seconds()))] = st
		if st != "running" {
			ok = false
		}
	}
	if ok {
		r.Outcome, r.Detail = "succeeded", "started; still running at every check"
	} else {
		r.Outcome, r.Reason, r.Detail = "failed", "did_not_remain_running", "started, but was not running at every check"
	}
	return r
}

func trim(s string) string {
	if len(s) > 200 {
		return s[:200]
	}
	return s
}

func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.More() {
		return errors.New("trailing data")
	}
	return nil
}

func readJournal(o Options, id string) (journal, bool) {
	raw, err := os.ReadFile(filepath.Join(o.dir("journal"), id+".json"))
	if err != nil {
		return journal{}, false
	}
	var j journal
	if json.Unmarshal(raw, &j) != nil {
		// A journal entry exists but is unreadable: treat as interrupted.
		return journal{JobID: id, State: "executing"}, true
	}
	return j, true
}

// writeJournal is write-temp, fsync, rename: after it returns, a crash leaves
// the entry in place.
func writeJournal(o Options, j journal) error {
	return atomicWrite(filepath.Join(o.dir("journal"), j.JobID+".json"), j)
}

func report(o Options, r Result) (Result, error) {
	return r, atomicWrite(filepath.Join(o.dir("results"), r.JobID+".json"), r)
}

func atomicWrite(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ParseKeys reads approval/keys.json (already verified by the trust client).
func ParseKeys(raw []byte) ([]Key, error) {
	var d KeysDoc
	if err := strictJSON(raw, &d); err != nil || d.Schema != KeysSchema {
		return nil, errors.New("approval/keys.json is not a rem0te approval key list")
	}
	if len(d.Keys) == 0 || len(d.Keys) > 8 {
		return nil, errors.New("approval/keys.json must list 1 to 8 keys")
	}
	for _, k := range d.Keys {
		pub, err := base64.StdEncoding.DecodeString(k.Ed25519)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("approval key %q is not a 32-byte Ed25519 key", k.Kid)
		}
		// kid = first 16 hex of sha256(raw key), the same as the signer's.
		sum := sha256.Sum256(pub)
		if k.Kid != hex.EncodeToString(sum[:])[:16] {
			return nil, fmt.Errorf("approval key id %q does not match its key", k.Kid)
		}
	}
	return d.Keys, nil
}

// SecretSHA256 is how the portal stores a device secret, so the agent can compare.
func SecretSHA256(secret string) string {
	s := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(s[:])
}
