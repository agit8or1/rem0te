package enforce

// 0.73 (build step 5): the managed ceiling, revocations, the signed pause
// during a session, and a restarted poller.

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/msa/grant"
)

func (s signer) revocation(r grant.Revocation) json.RawMessage {
	body := grant.CanonicalRevocation(&r)
	sig := ed25519.Sign(s.priv, append([]byte(grant.RevocationPrefix), body...))
	env, _ := json.Marshal(map[string]string{"keyId": s.kid, "revocation": base64.StdEncoding.EncodeToString(body), "sig": base64.StdEncoding.EncodeToString(sig)})
	return env
}

func baseRevocation(id string, all bool, grants ...string) grant.Revocation {
	if grants == nil {
		grants = []string{}
	}
	return grant.Revocation{V: 1, RevocationID: id, EndpointID: epID, RustdeskID: rid, All: all, GrantIDs: grants,
		IssuedAt: "2026-11-20T10:00:30Z", NotAfter: "2026-11-20T19:00:00Z"}
}

const (
	gA     = "00112233445566778899aabbccddeeff"
	gB     = "ffeeddccbbaa99887766554433221100"
	revA   = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb"
	forged = "bbbbbbbbbbbbbbbbaaaaaaaaaaaaaaaa"
)

func TestControlGrantAppliesWithinCeiling(t *testing.T) {
	f := newFake()
	g := baseGrant(gA)
	g.Mode, g.Consent = "control", "not_required"
	g.Permissions = grant.Permissions{Clipboard: true, Files: true, Audio: true}
	if out := newEnforcer(f).Apply(context.Background(), &g); !out.OK {
		t.Fatalf("apply: %+v", out)
	}
	d := Desired(&g)
	for k, v := range map[string]string{"access-mode": "full", "enable-keyboard": "Y", "enable-clipboard": "Y", "enable-file-transfer": "Y",
		"enable-audio": "Y", "enable-tunnel": "N", "enable-remote-restart": "N", "approve-mode": "password"} {
		if d[k] != v {
			t.Fatalf("%s = %q, want %q", k, d[k], v)
		}
	}
	if bad := newEnforcer(f).Check(context.Background(), d); len(bad) != 0 {
		t.Fatalf("readback: %v", bad)
	}
	// The second lock: even a grant that somehow named a tunnel or a restart
	// asks RustDesk for neither.
	g.Permissions.Tunnel, g.Permissions.Restart = true, true
	if d := Desired(&g); d["enable-tunnel"] != "N" || d["enable-remote-restart"] != "N" {
		t.Fatalf("tunnel/restart desired %v", d)
	}
	if Ceiling.Mode != "control" || !Ceiling.Permissions.Clipboard || !Ceiling.Permissions.Files || !Ceiling.Permissions.Audio || Ceiling.Permissions.Tunnel || Ceiling.Permissions.Restart {
		t.Fatalf("ceiling %+v", Ceiling)
	}
}

// sessionRig: a verified computer, a grant applied and connected, then extra answers.
func sessionRig(t *testing.T, s signer, extra ...PollAnswer) *rig {
	r := newRig(t, s)
	r.host.sessions = []int{1}
	r.portal.answers = append([]PollAnswer{managed("verified", s.envelope(baseGrant(gA)))}, extra...)
	r.portal.answers = append(r.portal.answers, PollAnswer{EndpointID: epID})
	r.store.state = &State{Schema: StateSchema, EndpointID: epID, Secured: true}
	return r
}

func withRev(state string, revs ...json.RawMessage) PollAnswer {
	a := managed(state)
	a.Revocations = revs
	return a
}

func countAck(r *rig, id string) int {
	n := 0
	for _, a := range r.portal.acks {
		for _, x := range a {
			if x == id {
				n++
			}
		}
	}
	return n
}

func TestRevocationEndsTheNamedSession(t *testing.T) {
	s := newSigner(t)
	rev := s.revocation(baseRevocation(revA, false, gA))
	r := sessionRig(t, s, managed("verified"), withRev("verified", rev), managed("verified"), withRev("verified", rev))
	r.run(t)
	if got := r.portal.events(); len(got) < 4 || !reflect.DeepEqual(got[:4], []string{"received", "applied", "connected", "ended:revoked"}) {
		t.Fatalf("events %v", got)
	}
	// Acked on the next poll; a repeat is acked again and does nothing.
	if n := countAck(r, revA); n != 2 || r.store.state.Revocations[revA].IsZero() || r.store.state.Active != nil {
		t.Fatalf("acks %v state %+v", r.portal.acks, r.store.state)
	}
	if r.f.password == baseGrant("").Password {
		t.Fatal("the session's password must be gone")
	}
}

func TestRevocationAllEndsOnlyEarlierSessions(t *testing.T) {
	s := newSigner(t)
	early := baseRevocation(revA, true)
	early.IssuedAt = "2026-11-20T09:59:00Z" // before the grant's notBefore
	r := sessionRig(t, s, withRev("verified", s.revocation(early)), managed("verified"))
	r.run(t)
	for _, e := range r.portal.events() {
		if e == "ended:revoked" {
			t.Fatalf("an older `all` must not end a later session: %v", r.portal.events())
		}
	}
	r = sessionRig(t, s, withRev("verified", s.revocation(baseRevocation(revA, true))))
	r.run(t)
	if got := r.portal.events(); len(got) < 4 || !reflect.DeepEqual(got[:4], []string{"received", "applied", "connected", "ended:revoked"}) {
		t.Fatalf("events %v", got)
	}
}

func TestRevocationOtherGrantForgedAndLateGrant(t *testing.T) {
	s, other := newSigner(t), newSigner(t)
	r := sessionRig(t, s, withRev("verified", s.revocation(baseRevocation(revA, false, gB)), other.revocation(baseRevocation(forged, true))))
	r.run(t)
	for _, e := range r.portal.events() {
		if e == "ended:revoked" {
			t.Fatalf("another grant's revocation, or a forged one, ended the session: %v", r.portal.events())
		}
	}
	if countAck(r, forged) != 0 || countAck(r, revA) != 1 {
		t.Fatalf("acks %v", r.portal.acks)
	}
	// gB was named: when it arrives it is refused as replayed and nothing changes.
	if r.store.seen[gB].IsZero() {
		t.Fatal("a revoked grant must join the replay set")
	}
	r2 := newRig(t, s)
	r2.store.seen = r.store.seen
	r2.store.state = &State{Schema: StateSchema, EndpointID: epID, Secured: true}
	r2.portal.answers = []PollAnswer{managed("verified", s.envelope(baseGrant(gB))), {EndpointID: epID}}
	r2.run(t)
	if got := r2.portal.events(); !reflect.DeepEqual(got, []string{"failed:replayed"}) || len(r2.f.calls) != 0 {
		t.Fatalf("late revoked grant: %v calls %v", got, r2.f.calls)
	}
}

func TestSignedPauseEndsTheSession(t *testing.T) {
	s := newSigner(t)
	var extra []PollAnswer
	for i := 0; i < 40; i++ {
		extra = append(extra, managed("verified"))
	}
	r := sessionRig(t, s, extra...)
	n := 0
	r.p.Wait = func(_ context.Context, d time.Duration) {
		r.clock = r.clock.Add(d)
		if n++; n == 3 {
			r.host.paused = true
		}
	}
	r.run(t)
	if got := r.portal.events(); len(got) < 4 || got[3] != "ended:paused" {
		t.Fatalf("events %v", got)
	}
}

func TestRestartedPollerEndsOrResumesTheSession(t *testing.T) {
	s := newSigner(t)
	g := baseGrant(gA)
	nb, _ := time.Parse(time.RFC3339, g.NotBefore)
	na, _ := time.Parse(time.RFC3339, g.NotAfter)
	open := ActiveSession{GrantID: gA, BusinessID: bizID, NotBefore: nb, NotAfter: na, AppliedAt: t0, MaxMinutes: 30, IdleMinutes: 10, Connected: true}

	// Past its limit: ended before the first poll.
	r := newRig(t, s)
	r.clock = t0.Add(31 * time.Minute)
	c := open
	r.store.state = &State{Schema: StateSchema, EndpointID: epID, Secured: true, Managed: "verified", Active: &c}
	r.run(t) // the portal stops at once
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"ended:max_minutes"}) || r.store.state.Active != nil || len(r.f.stopSeq) != 2 {
		t.Fatalf("events %v state %+v stop %v", got, r.store.state, r.f.stopSeq)
	}

	// Inside it: watched again, and ended when the connection goes.
	r = newRig(t, s)
	c = open
	r.store.state = &State{Schema: StateSchema, EndpointID: epID, Secured: true, Managed: "verified", Active: &c}
	r.host.sessions = []int{1, 0}
	r.portal.answers = []PollAnswer{managed("verified"), managed("verified"), managed("verified"), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"ended:disconnected"}) {
		t.Fatalf("events %v", got)
	}

	// A 0.72 state file keeps its pin and its applied values, with no session.
	r = newRig(t, s)
	r.store.state = &State{Schema: "rem0te-msa-enforce/1", EndpointID: epID, Secured: true, Applied: map[string]string{"access-mode": "view"}}
	r.portal.answers = []PollAnswer{{EndpointID: epID}}
	r.run(t)
	if r.store.state.Schema != StateSchema || r.store.state.EndpointID != epID || !r.store.state.Secured || r.store.state.Applied["access-mode"] != "view" {
		t.Fatalf("v1 state not carried over: %+v", r.store.state)
	}
}

func TestStateNeverHoldsThePassword(t *testing.T) {
	s := newSigner(t)
	r := sessionRig(t, s, managed("verified"))
	var during []byte
	r.p.Wait = func(_ context.Context, d time.Duration) {
		r.clock = r.clock.Add(d)
		if during == nil && r.store.state != nil && r.store.state.Active != nil {
			during, _ = json.Marshal(r.store.state)
		}
	}
	r.run(t)
	if during == nil || !strings.Contains(string(during), gA) || strings.Contains(string(during), baseGrant("").Password) {
		t.Fatalf("state during the session: %s", during)
	}
}
