package enforce

// 0.78.1, finding F1 (docs/session-maintenance-mdm-backup-audit.md): a
// control grant used to set access-mode full, which RustDesk's Flutter
// builds read as every permission on before they look at any enable-* key.
// These tests hold the fix: no desired map, argument list or call carries
// full; every RustDesk permission is named; and what RustDesk would make of
// the desired values (Effective, a port of its own rule) is exactly what the
// grant and the Ceiling allow.

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/agit8or1/rem0te/windows-installer/internal/msa/grant"
)

// everyGrant: both modes and an unknown one, both consents, all 32
// permission combinations (tunnel and restart included, which the Ceiling
// refuses upstream; Desired must hold even so).
func everyGrant() []grant.Grant {
	var out []grant.Grant
	for _, mode := range []string{"view", "control", "other"} {
		for _, consent := range []string{"required", "not_required"} {
			for bits := 0; bits < 32; bits++ {
				g := baseGrant("00112233445566778899aabbccddeeff")
				g.Mode, g.Consent = mode, consent
				g.Permissions = grant.Permissions{Clipboard: bits&1 != 0, Files: bits&2 != 0, Audio: bits&4 != 0, Tunnel: bits&8 != 0, Restart: bits&16 != 0}
				out = append(out, g)
			}
		}
	}
	return out
}

func TestNoDesiredMapHoldsFull(t *testing.T) {
	for _, g := range everyGrant() {
		d := Desired(&g)
		if d["access-mode"] == "full" {
			t.Fatalf("%s grant asks for access-mode full", g.Mode)
		}
		want := "view"
		if g.Mode == "control" {
			want = "custom"
		}
		if d["access-mode"] != want {
			t.Fatalf("%s: access-mode %q, want %q", g.Mode, d["access-mode"], want)
		}
		if len(d) != len(Keys) {
			t.Fatalf("desired names %d keys, want %d", len(d), len(Keys))
		}
		for _, k := range Keys {
			if SetArgs(k, d[k]) == nil {
				t.Fatalf("desired %s=%q is not a value SetArgs builds", k, d[k])
			}
		}
		for _, k := range Locked {
			if d[k] != "N" {
				t.Fatalf("%s grant: %s = %q, want N", g.Mode, k, d[k])
			}
		}
	}
	for _, f := range []func(string, string) []string{SetArgs, RestoreArgs} {
		if f("access-mode", "full") != nil {
			t.Fatal("an argument builder accepted access-mode full")
		}
	}
	if Valid([]string{"--option", "access-mode", "full"}) {
		t.Fatal("Valid accepted access-mode full")
	}
}

func TestEveryPermissionIsNamed(t *testing.T) {
	// RustDesk's permission options, 1.4.1–1.5.3: the enable-* keys the
	// controlled side's Connection checks (connection.rs). Other enable-*
	// options (file-copy-paste, trusted-devices, lan-discovery, udp-punch,
	// hwcodec, directx-capture, check-update…) are not permissions.
	rustdesk := []string{"enable-keyboard", "enable-remote-printer", "enable-clipboard", "enable-file-transfer", "enable-audio",
		"enable-camera", "enable-terminal", "enable-tunnel", "enable-remote-restart", "enable-record-session",
		"enable-block-input", "enable-privacy-mode"}
	seen := map[string]bool{}
	for _, k := range Permissions {
		if seen[k] {
			t.Fatalf("%s twice", k)
		}
		seen[k] = true
		if !isKey(k) || !contains(order, k) {
			t.Fatalf("%s is not set and read back", k)
		}
	}
	for _, k := range rustdesk {
		if !seen[k] {
			t.Fatalf("RustDesk permission %s is not governed", k)
		}
	}
	if len(Permissions) != len(rustdesk) {
		t.Fatalf("permissions %v", Permissions)
	}
	for _, k := range Keys {
		if strings.HasPrefix(k, "enable-") && !seen[k] {
			t.Fatalf("%s is an enable-* key but not a permission", k)
		}
	}
}

func TestEffectiveIsExactlyWhatTheGrantAndCeilingAllow(t *testing.T) {
	for _, g := range everyGrant() {
		d := Desired(&g)
		if over := Beyond(&g, d); len(over) != 0 {
			t.Fatalf("%s %+v: RustDesk would also allow %v", g.Mode, g.Permissions, over)
		}
		eff := Effective(d)
		if !reflect.DeepEqual(eff, Allowed(&g)) {
			t.Fatalf("%s %+v: effective %v, allowed %v", g.Mode, g.Permissions, eff, Allowed(&g))
		}
		for _, k := range append([]string{"enable-tunnel", "enable-remote-restart"}, Locked...) {
			if eff[k] {
				t.Fatalf("%s grant: %s is on", g.Mode, k)
			}
		}
		control := g.Mode == "control"
		if eff["enable-keyboard"] != control || eff["enable-clipboard"] != (control && g.Permissions.Clipboard) ||
			eff["enable-file-transfer"] != (control && g.Permissions.Files) || eff["enable-audio"] != (control && g.Permissions.Audio) {
			t.Fatalf("%s %+v: effective %v", g.Mode, g.Permissions, eff)
		}
	}
}

// What 0.73–0.78 did, held as the bug it was: full turns every permission
// on, whatever the enable-* keys say.
func TestFullWasEveryPermission(t *testing.T) {
	g := baseGrant("00112233445566778899aabbccddeeff")
	g.Mode = "control"
	old := Desired(&g)
	old["access-mode"] = "full"
	over := Beyond(&g, old)
	want := []string{"enable-clipboard", "enable-file-transfer", "enable-audio", "enable-tunnel", "enable-remote-restart"}
	want = append(want, Locked...)
	if !reflect.DeepEqual(over, want) {
		t.Fatalf("under full: %v", over)
	}
	if eff := Effective(map[string]string{}); !eff["enable-terminal"] || !eff["enable-keyboard"] {
		t.Fatal("an unset option is on (option2bool: anything but N)")
	}
	if eff := Effective(map[string]string{"access-mode": "view", "enable-terminal": "Y"}); eff["enable-terminal"] {
		t.Fatal("view is every permission off")
	}
}

func TestLockedReadbackMismatchRefused(t *testing.T) {
	f := newFake()
	f.opts["enable-terminal"] = "Y"
	f.ignore["enable-terminal"] = true // RustDesk keeps the terminal on
	g := baseGrant("00112233445566778899aabbccddeeff")
	g.Mode, g.Permissions = "control", grant.Permissions{Clipboard: true}
	out := newEnforcer(f).Apply(context.Background(), &g)
	if out.OK || out.Code != ReadbackMismatch || !reflect.DeepEqual(out.Keys, []string{"enable-terminal"}) {
		t.Fatalf("outcome %+v", out)
	}
	if f.password == g.Password || !reflect.DeepEqual(f.stopSeq, []string{"Y", "N"}) {
		t.Fatal("a refused grant must end the session with a password nobody is told")
	}
}

func TestNoCallCarriesFull(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s) // the fake starts at access-mode full
	g := baseGrant("00112233445566778899aabbccddeeff")
	g.Mode, g.Consent, g.Permissions = "control", "not_required", grant.Permissions{Clipboard: true, Files: true, Audio: true}
	r.host.sessions = []int{1}
	r.portal.answers = []PollAnswer{managed("verified", s.envelope(g)), managed("rollback_pending"), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"secured", "received", "applied", "connected", "ended:rollback", "restored"}) {
		t.Fatalf("events %v", got)
	}
	for _, c := range r.f.calls {
		if len(c) == 3 && c[1] == "access-mode" && c[2] == "full" {
			t.Fatalf("a call carried full: %v", c)
		}
	}
	if v, ok := r.f.opts["access-mode"]; ok {
		t.Fatalf("a saved full is put back as RustDesk's default, got %q", v)
	}
}

func TestNormalise(t *testing.T) {
	if Normalise(nil) != nil {
		t.Fatal("nil")
	}
	g := baseGrant("")
	g.Mode = "control"
	old := Desired(&g)
	old["access-mode"] = "full"
	for _, k := range Locked {
		delete(old, k)
	}
	got := Normalise(old)
	if !reflect.DeepEqual(got, Desired(&g)) {
		t.Fatalf("normalised %v", got)
	}
	if old["access-mode"] != "full" {
		t.Fatal("Normalise must not change its argument")
	}
}

// A computer cut over by 0.73–0.78: its saved file holds the eleven keys
// only. The next grant reads the Locked keys before changing them, and a
// rollback puts them back.
func TestOlderSavedFileGainsLockedBeforeApply(t *testing.T) {
	s := newSigner(t)
	r := newRig(t, s)
	r.f.opts["access-mode"] = "custom"
	r.f.opts["enable-camera"] = "N" // the customer's own choice before cutover
	vals := map[string]string{}
	for _, k := range Keys[:11] {
		vals[k] = r.f.opts[k]
	}
	r.store.saved = &Saved{Schema: SavedSchema, Values: vals}
	r.store.state = &State{Schema: StateSchema, EndpointID: epID, Secured: true,
		Applied: map[string]string{"access-mode": "full", "enable-keyboard": "Y"}}
	before := map[string]string{}
	for k, v := range r.f.opts {
		before[k] = v
	}
	r.host.sessions = []int{1}
	g := baseGrant("00112233445566778899aabbccddeeff")
	r.portal.answers = []PollAnswer{managed("verified", s.envelope(g)), managed("rollback_pending"), {EndpointID: epID}}
	r.run(t)
	if got := r.portal.events(); !reflect.DeepEqual(got, []string{"received", "applied", "connected", "ended:rollback", "restored"}) {
		t.Fatalf("events %v", got)
	}
	if !reflect.DeepEqual(r.f.opts, before) {
		t.Fatalf("not restored: %v, want %v", r.f.opts, before)
	}
}

func TestRestoreSkipsLockedMissingFromAnOlderFile(t *testing.T) {
	f := newFake()
	f.opts["enable-terminal"] = "N"
	vals := map[string]string{}
	for _, k := range Keys[:11] {
		vals[k] = ""
	}
	if bad := newEnforcer(f).Restore(context.Background(), &Saved{Schema: SavedSchema, Values: vals}); len(bad) != 0 {
		t.Fatalf("restore: %v", bad)
	}
	if f.opts["enable-terminal"] != "N" {
		t.Fatal("a Locked key the older agent never touched is left alone")
	}
}
