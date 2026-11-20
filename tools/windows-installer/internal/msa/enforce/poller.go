package enforce

// The grant poller (0.72): `rem0te-agent.exe msa-poller`, started by the
// signed heartbeat only when the portal answers msaPoll: true (MSA_GRANTS on
// AND a Platform Admin moved this one computer into Managed Secure Access).
// Portable: the portal, the computer and the files are interfaces, so every
// decision runs under test with fakes. The Windows wiring is
// msa_poller_windows.go.
//
// What it does, in order, on each answer:
//
//   - nothing at all unless the answer names a managed state (Legacy: it
//     ends any session it holds and exits);
//   - rollback: end any session, restore the saved settings, read them back,
//     report restored (or restore_failed with the keys);
//   - verified and not yet secured: replace the permanent password with one
//     nobody is told, report secured;
//   - each grant: verify it (internal/msa/grant) under the keys from the
//     verified update chain only, this computer's own identity, the compiled
//     Ceiling and the persisted replay set; refuse remote_paused under the
//     signed pause; save the previous settings before the FIRST change;
//     apply, read back, set the one-time password; report applied or why not;
//   - between answers: watch for the RustDesk connection manager and end the
//     session when it disconnects, when maxMinutes runs out, or when no one
//     connected by notAfter; at rest, read the managed settings back hourly.
//
// Fail closed: no keys, an unreadable pause, a grant that does not verify, a
// readback that disagrees — each refuses and is reported; nothing weaker is
// ever applied in its place.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/msa/grant"
)

// ErrStop: the portal said this computer has no business polling (MSA
// switched off, not managed, not the signed agent). The poller exits.
var ErrStop = errors.New("msa: the portal does not want this computer to poll")

// ManagedAnswer is the portal's managed state for this computer.
type ManagedAnswer struct {
	State    string `json:"state"`
	Rollback bool   `json:"rollback"`
}

// PollAnswer is one poll's answer, as the agent reads it.
type PollAnswer struct {
	Grants       []json.RawMessage `json:"grants"`
	Paused       bool              `json:"paused"`
	EndpointID   string            `json:"endpointId"`
	Managed      *ManagedAnswer    `json:"managed"`
	RetryAfterMs int               `json:"retryAfterMs"`
}

// Report is one report to the portal. Never a password.
type Report struct {
	Event   string   `json:"event"`
	GrantID string   `json:"grantId,omitempty"`
	Outcome string   `json:"outcome,omitempty"`
	Keys    []string `json:"keys,omitempty"`
}

// Portal is the agent's side of POST /msa/agent/poll and /msa/agent/report
// (the device secret and RustDesk ID are the implementation's).
type Portal interface {
	Poll(ctx context.Context, ack []string, wait bool) (PollAnswer, error)
	Report(ctx context.Context, r Report) error
}

// Host is the computer: its RustDesk ID, its open RustDesk sessions, the
// grant keys and signed pause from the verified update chain.
type Host interface {
	RustdeskID(ctx context.Context) (string, error)
	// Sessions counts `rustdesk.exe --cm`; an error is "cannot tell".
	Sessions() (int, error)
	// Trust returns the grant keys and whether the signed pause covers this
	// business and RustDesk ID (an unreadable listed pause covers everything).
	Trust(ctx context.Context) (keys map[string]ed25519.PublicKey, paused func(businessID, rustdeskID string) bool, err error)
}

// State is the poller's own file (msa\enforce.json): the endpoint id it
// pinned, what it last applied (never a password), and whether the legacy
// password was replaced.
type State struct {
	Schema     string            `json:"schema"`
	EndpointID string            `json:"endpointId,omitempty"`
	Applied    map[string]string `json:"applied,omitempty"`
	Secured    bool              `json:"secured,omitempty"`
}

// StateSchema names the state file.
const StateSchema = "rem0te-msa-enforce/1"

// Store keeps the poller's files, SYSTEM-only.
type Store interface {
	LoadState() (*State, error)
	SaveState(*State) error
	LoadSaved() (*Saved, error) // nil, nil when there is none
	SaveSaved(*Saved) error
	DeleteSaved() error
	LoadSeen() (map[string]time.Time, error)
	SaveSeen(map[string]time.Time) error
}

// Poller bounds.
const (
	// Tick is how often an active session is checked.
	Tick = 5 * time.Second
	// RestCheck is how often a verified computer's settings are read back.
	RestCheck = time.Hour
	// IdleExit: with no session for this long the poller exits; the next
	// heartbeat starts it again while the portal still wants it.
	IdleExit = time.Hour
	// MaxBackoff bounds the wait after a failed poll.
	MaxBackoff = time.Minute
)

type active struct {
	g         *grant.Grant
	appliedAt time.Time
	connected bool
}

// Poller is one run.
type Poller struct {
	E      *Enforcer
	P      Portal
	H      Host
	S      Store
	Now    func() time.Time
	Wait   func(context.Context, time.Duration)
	Logf   func(string, ...any)
	state  *State
	seen   map[string]time.Time
	act    *active
	mstate string
	ack    []string
	lastRB time.Time
	rolled bool
}

func (p *Poller) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p *Poller) logf(f string, a ...any) {
	if p.Logf != nil {
		p.Logf(f, a...)
	}
}

func (p *Poller) wait(ctx context.Context, d time.Duration) {
	if p.Wait != nil {
		p.Wait(ctx, d)
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func (p *Poller) report(ctx context.Context, r Report) {
	if err := p.P.Report(ctx, r); err != nil {
		p.logf("msa-poller: report %s: %v", r.Event, err)
	}
}

// Run polls until the portal stops wanting it, the context ends, or IdleExit.
func (p *Poller) Run(ctx context.Context) error {
	st, err := p.S.LoadState()
	if err != nil || st == nil || st.Schema != StateSchema {
		st = &State{Schema: StateSchema}
	}
	p.state = st
	if p.seen, err = p.S.LoadSeen(); err != nil || p.seen == nil {
		p.seen = map[string]time.Time{}
	}
	backoff := 5 * time.Second
	lastActive := p.now()
	for ctx.Err() == nil {
		ans, err := p.P.Poll(ctx, p.ack, p.act == nil)
		if errors.Is(err, ErrStop) {
			p.endActive(ctx, NotEnabled)
			return nil
		}
		if err != nil {
			p.logf("msa-poller: poll: %v", err)
			p.tick(ctx)
			p.wait(ctx, backoff)
			if backoff *= 2; backoff > MaxBackoff {
				backoff = MaxBackoff
			}
			continue
		}
		backoff = 5 * time.Second
		p.ack = nil
		if !p.pin(ans.EndpointID) {
			p.logf("msa-poller: the portal named another computer; stopping")
			p.endActive(ctx, NotEnabled)
			return errors.New("endpoint id changed")
		}
		if ans.Managed == nil {
			p.endActive(ctx, NotEnabled)
			return nil
		}
		p.mstate = ans.Managed.State
		if ans.Managed.Rollback {
			if !p.rolled {
				p.rollback(ctx)
			}
			p.wait(ctx, Tick)
			continue
		}
		p.rolled = false
		if ans.Managed.State == "verified" && !p.state.Secured && p.act == nil {
			if p.E.Secure(ctx) {
				p.state.Secured = true
				p.saveState()
				p.report(ctx, Report{Event: "secured"})
			}
		}
		for _, env := range ans.Grants {
			p.handle(ctx, env)
		}
		p.tick(ctx)
		if p.act != nil {
			lastActive = p.now()
			p.wait(ctx, Tick)
			continue
		}
		p.restCheck(ctx)
		if p.now().Sub(lastActive) > IdleExit {
			return nil
		}
		if ans.RetryAfterMs > 0 {
			p.wait(ctx, time.Duration(ans.RetryAfterMs)*time.Millisecond)
		}
	}
	p.endActive(context.Background(), NotEnabled)
	return ctx.Err()
}

// pin: the endpoint id the portal names is written once; a different one later is refused.
func (p *Poller) pin(id string) bool {
	if id == "" {
		return p.state.EndpointID != ""
	}
	if p.state.EndpointID == "" {
		p.state.EndpointID = id
		p.saveState()
		return true
	}
	return p.state.EndpointID == id
}

func (p *Poller) saveState() {
	if err := p.S.SaveState(p.state); err != nil {
		p.logf("msa-poller: state: %v", err)
	}
}

var grantIDRE = regexp.MustCompile(`^[0-9a-f]{32}$`)

// grantIDOf reads the grant id out of an envelope without trusting it: only
// to name the grant in a refusal report (the portal checks it is this
// computer's own grant).
func grantIDOf(env []byte) string {
	var e struct {
		Grant string `json:"grant"`
	}
	if json.Unmarshal(env, &e) != nil {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(e.Grant)
	if err != nil || len(b) > grant.MaxGrantBytes {
		return ""
	}
	var g struct {
		GrantID string `json:"grantId"`
	}
	if json.Unmarshal(b, &g) != nil || !grantIDRE.MatchString(g.GrantID) {
		return ""
	}
	return g.GrantID
}

func (p *Poller) handle(ctx context.Context, env json.RawMessage) {
	gid := grantIDOf(env)
	if gid != "" {
		p.ack = append(p.ack, gid)
	}
	refuse := func(code string, keys []string) {
		p.logf("msa-poller: grant %s refused: %s", gid, code)
		if gid != "" {
			p.report(ctx, Report{Event: "failed", GrantID: gid, Outcome: code, Keys: keys})
		}
	}
	keys, paused, err := p.H.Trust(ctx)
	if err != nil || len(keys) == 0 {
		refuse(NoKeys, nil)
		return
	}
	rid, err := p.H.RustdeskID(ctx)
	if err != nil {
		refuse(RustdeskNotReady, nil)
		return
	}
	seen := map[string]bool{}
	for id := range p.seen {
		seen[id] = true
	}
	res := grant.Verify(bytes.TrimSpace(env), grant.Context{
		Keys: keys, EndpointID: p.state.EndpointID, RustdeskID: rid, Now: p.now(), Seen: seen, Ceiling: Ceiling,
	})
	if !res.OK {
		refuse(res.Reason, nil)
		return
	}
	g := res.Grant
	gid = g.GrantID
	if paused == nil || paused(g.BusinessID, rid) {
		refuse(grant.RemotePaused, nil)
		return
	}
	// The replay set is written before anything changes: a crash after this
	// can never let the same grant apply twice.
	na, _ := time.Parse(time.RFC3339, g.NotAfter)
	p.seen[g.GrantID] = na.Add(time.Duration(g.MaxMinutes)*time.Minute + grant.ClockSkew)
	p.pruneSeen()
	if err := p.S.SaveSeen(p.seen); err != nil {
		refuse(SaveFailed, nil)
		return
	}
	if p.act != nil {
		p.endSession(ctx, Superseded)
	}
	// Save what RustDesk had before the FIRST change; never overwrite it.
	if s, err := p.S.LoadSaved(); err != nil || s == nil {
		vals, err := p.E.ReadAll(ctx)
		if err != nil {
			refuse(SaveFailed, nil)
			return
		}
		if err := p.S.SaveSaved(&Saved{Schema: SavedSchema, SavedAt: p.now().UTC().Format(time.RFC3339), Values: vals}); err != nil {
			refuse(SaveFailed, nil)
			return
		}
	}
	out := p.E.Apply(ctx, g)
	if !out.OK {
		refuse(out.Code, out.Keys)
		return
	}
	p.state.Applied = Desired(g)
	p.saveState()
	p.act = &active{g: g, appliedAt: p.now()}
	p.report(ctx, Report{Event: "applied", GrantID: g.GrantID})
}

func (p *Poller) pruneSeen() {
	t := p.now()
	for id, until := range p.seen {
		if t.After(until) {
			delete(p.seen, id)
		}
	}
}

// tick watches an active session.
func (p *Poller) tick(ctx context.Context) {
	a := p.act
	if a == nil {
		return
	}
	t := p.now()
	if t.Sub(a.appliedAt) >= time.Duration(a.g.MaxMinutes)*time.Minute {
		p.endSession(ctx, MaxMinutes)
		return
	}
	n, err := p.H.Sessions()
	if err != nil {
		return // cannot tell: the time limits still end it
	}
	switch {
	case n > 0 && !a.connected:
		a.connected = true
		p.report(ctx, Report{Event: "connected", GrantID: a.g.GrantID})
	case n == 0 && a.connected:
		p.endSession(ctx, Disconnected)
	case n == 0 && !a.connected:
		if na, err := time.Parse(time.RFC3339, a.g.NotAfter); err != nil || t.After(na.Add(grant.ClockSkew)) {
			p.endSession(ctx, NoConnection)
		}
	}
}

func (p *Poller) endActive(ctx context.Context, code string) {
	if p.act != nil {
		p.endSession(ctx, code)
	}
}

// endSession: a password nobody is told, stop-service Y then N. On a
// computer still Managed (pending) the saved settings go back too, so
// Legacy works between test sessions as it did before; the portal then
// re-establishes a permanent password it knows through its rotation.
func (p *Poller) endSession(ctx context.Context, code string) {
	a := p.act
	p.act = nil
	err := p.E.EndSession(ctx)
	if err != nil {
		p.logf("msa-poller: ending the session: %v", err)
		code = StopFailed
	}
	if p.mstate == "pending" && code != Rollback {
		if s, lerr := p.S.LoadSaved(); lerr == nil && s != nil {
			if bad := p.E.Restore(ctx, s); len(bad) > 0 {
				p.logf("msa-poller: restoring between test sessions: %v", bad)
			} else {
				p.state.Applied = nil
				p.saveState()
			}
		}
	}
	if a != nil {
		p.report(ctx, Report{Event: "ended", GrantID: a.g.GrantID, Outcome: code})
	}
}

// rollback: end any session, then put back what RustDesk had before the first apply.
func (p *Poller) rollback(ctx context.Context) {
	p.rolled = true
	p.endActive(ctx, Rollback)
	s, err := p.S.LoadSaved()
	if err != nil {
		p.report(ctx, Report{Event: "restore_failed", Keys: append([]string(nil), Keys...)})
		return
	}
	if s != nil {
		if bad := p.E.Restore(ctx, s); len(bad) > 0 {
			p.report(ctx, Report{Event: "restore_failed", Keys: bad})
			return
		}
		if err := p.S.DeleteSaved(); err != nil {
			p.logf("msa-poller: removing the saved settings: %v", err)
		}
	}
	p.state.Applied = nil
	p.state.Secured = false
	p.saveState()
	p.report(ctx, Report{Event: "restored"})
}

// restCheck: on a verified computer with no session, read the managed
// settings back hourly. A change is drift: reported (the portal marks an
// enforcement failure) and the managed values set again.
func (p *Poller) restCheck(ctx context.Context) {
	if p.mstate != "verified" || p.state.Applied == nil || p.now().Sub(p.lastRB) < RestCheck {
		return
	}
	p.lastRB = p.now()
	if bad := p.E.Check(ctx, p.state.Applied); len(bad) > 0 {
		p.report(ctx, Report{Event: "drift", Keys: bad})
		_ = p.E.Set(ctx, p.state.Applied)
		return
	}
	p.report(ctx, Report{Event: "checked"})
}
