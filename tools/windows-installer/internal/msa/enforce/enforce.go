package enforce

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"strconv"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/msa"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa/grant"
)

// Ceiling is the most a managed computer allows (0.73; 0.72's was
// view-only): interactive control with clipboard, file transfer and audio,
// never a TCP tunnel and never a remote restart, and never a permission the
// grant format does not name (Locked: terminal, camera, remote printer,
// block-input, privacy mode, recording), which every grant sets to N. From
// 0.78.1 RustDesk enforces it, not only stores it (F1). Compiled in, not taken from
// the portal: a portal-supplied (or portal-signed) ceiling would be the
// portal asking itself, so widening it takes a signed agent release.
//
//   - tunnel: RustDesk's TCP tunnel reaches the customer's network beyond
//     the desktop, invisibly to the person watching;
//   - restart: a remote restart drops RustDesk and the session with it, and
//     this agent's bookkeeping is what ends a grant on time.
//
// The portal's MANAGED_CEILING is the same (§82, §83).
var Ceiling = grant.Ceiling{Mode: "control", Permissions: grant.Permissions{Clipboard: true, Files: true, Audio: true}}

// Outcome codes the agent reports (the portal's AGENT_OUTCOMES).
const (
	ReadbackMismatch   = "readback_mismatch"
	PasswordNotApplied = "password_not_applied"
	SaveFailed         = "save_failed"
	RustdeskNotReady   = "rustdesk_not_ready"
	NoKeys             = "no_keys"
	MaxMinutes         = "max_minutes"
	NoConnection       = "no_connection"
	Disconnected       = "disconnected"
	Rollback           = "rollback"
	Superseded         = "superseded"
	NotEnabled         = "not_enabled"
	StopFailed         = "stop_failed"
	// 0.73: a signed revocation ended the session; the signed pause did.
	Revoked = "revoked"
	Paused  = "paused"
)

// Outcomes lists them in the portal's order.
var Outcomes = []string{
	ReadbackMismatch, PasswordNotApplied, SaveFailed, RustdeskNotReady, NoKeys,
	MaxMinutes, NoConnection, Disconnected, Rollback, Superseded, NotEnabled, StopFailed, Revoked, Paused,
}

// Bounds.
const (
	// CallTimeout bounds one rustdesk.exe call; the lab measured 80–190 ms.
	CallTimeout = 15 * time.Second
	// StopPause is how long stop-service stays Y: the lab saw the listener
	// close within about 1.3 s.
	StopPause = 3 * time.Second
)

// Result is one rustdesk.exe call's raw outcome.
type Result struct {
	Stdout   []byte
	ExitCode int
	TimedOut bool
	Err      error
}

func (r Result) ok() bool { return !r.TimedOut && r.Err == nil && r.ExitCode == 0 }

// Runner runs the installed rustdesk.exe with exactly args — one of the
// lists SetArgs, RestoreArgs, PasswordArgs, StopServiceArgs or ReadArgs
// built. The Windows runner refuses anything else.
type Runner interface {
	Run(ctx context.Context, args []string) Result
}

// Saved is what the agent read before it first changed anything: the value
// of every key, as RustDesk printed it. Kept in a SYSTEM-only file until a
// rollback puts it back.
type Saved struct {
	Schema  string            `json:"schema"`
	SavedAt string            `json:"savedAt"`
	Values  map[string]string `json:"values"`
}

// SavedSchema names the saved file.
const SavedSchema = "rem0te-msa-saved/1"

// Enforcer applies and undoes. Sleep and Password are test hooks.
type Enforcer struct {
	R        Runner
	Sleep    func(time.Duration)
	Password func() string
}

func (e *Enforcer) sleep(d time.Duration) {
	if e.Sleep != nil {
		e.Sleep(d)
		return
	}
	time.Sleep(d)
}

func (e *Enforcer) call(ctx context.Context, args []string) Result {
	if args == nil {
		return Result{Err: errors.New("refused: not an enforcement command")}
	}
	c, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	r := e.R.Run(c, args)
	if c.Err() != nil {
		r.TimedOut = true
	}
	return r
}

// Read reads one key; ok is false when RustDesk did not answer in the
// preflight's answer charset.
func (e *Enforcer) Read(ctx context.Context, key string) (string, bool) {
	r := e.call(ctx, ReadArgs(key))
	if msa.ParseRead(r.Stdout, r.ExitCode, r.TimedOut, len(r.Stdout) > msa.MaxReadBytes, r.Err) != msa.KeyOK {
		return "", false
	}
	return string(bytes.TrimSpace(r.Stdout)), true
}

// ReadAll reads every key; an unanswered read fails the whole read.
func (e *Enforcer) ReadAll(ctx context.Context) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range Keys {
		v, ok := e.Read(ctx, k)
		if !ok {
			return nil, errors.New("rustdesk did not answer a read")
		}
		out[k] = v
	}
	return out, nil
}

// Desired is what a verified grant asks of RustDesk (§3.3), for every key.
//
// Control is access-mode custom, never full (0.78.1, F1): RustDesk's Flutter
// builds read full as every permission on before they look at a single
// enable-* key, so under 0.73–0.78's full the clipboard, file-transfer,
// tunnel and restart values were written, read back and ignored, and every
// option the agent did not write (terminal, camera, remote printer,
// block-input, privacy mode, recording) was on. Custom makes RustDesk read
// each key, and every Locked key is N on every grant.
func Desired(g *grant.Grant) map[string]string {
	yn := func(b bool) string {
		if b {
			return "Y"
		}
		return "N"
	}
	access := "view"
	if g.Mode == "control" {
		access = "custom"
	}
	approve := "password"
	if g.Consent == "required" {
		approve = "click"
	}
	d := map[string]string{
		"verification-method":  "use-permanent-password",
		"access-mode":          access,
		"enable-keyboard":      yn(g.Mode == "control"),
		"enable-clipboard":     yn(g.Permissions.Clipboard),
		"enable-file-transfer": yn(g.Permissions.Files),
		"enable-audio":         yn(g.Permissions.Audio),
		// Never on, whatever a grant says: the Ceiling refuses either
		// permission before this is reached; this is the second lock.
		"enable-tunnel":           "N",
		"enable-remote-restart":   "N",
		"approve-mode":            approve,
		"allow-auto-disconnect":   "Y",
		"auto-disconnect-timeout": strconv.Itoa(g.IdleMinutes),
	}
	// No grant turns these on, whatever its mode or permissions.
	for _, k := range Locked {
		d[k] = "N"
	}
	return d
}

// Allowed is, permission by permission, what a grant may have on the
// controlled computer: keyboard only in control; clipboard, file transfer and
// audio only in control, only when the grant names them and the Ceiling
// allows them; every other permission never.
func Allowed(g *grant.Grant) map[string]bool {
	control := g.Mode == "control" && Ceiling.Mode == "control"
	out := map[string]bool{}
	for _, k := range Permissions {
		out[k] = false
	}
	out["enable-keyboard"] = control
	out["enable-clipboard"] = control && g.Permissions.Clipboard && Ceiling.Permissions.Clipboard
	out["enable-file-transfer"] = control && g.Permissions.Files && Ceiling.Permissions.Files
	out["enable-audio"] = control && g.Permissions.Audio && Ceiling.Permissions.Audio
	return out
}

// Beyond lists the permissions RustDesk would grant under values (Effective)
// that the grant may not have (Allowed), in Permissions order.
func Beyond(g *grant.Grant, values map[string]string) []string {
	eff, ok := Effective(values), Allowed(g)
	var over []string
	for _, k := range Permissions {
		if eff[k] && !ok[k] {
			over = append(over, k)
		}
	}
	return over
}

// Normalise brings a desired map persisted by an older agent (0.73–0.78,
// before F1) up to this one: access-mode full becomes custom, and every
// Locked key it never named is N. The hourly readback then checks — and
// corrects — the managed values this agent would have set. nil stays nil.
func Normalise(applied map[string]string) map[string]string {
	if applied == nil {
		return nil
	}
	out := make(map[string]string, len(applied)+len(Locked))
	for k, v := range applied {
		out[k] = v
	}
	if refused("access-mode", out["access-mode"]) {
		out["access-mode"] = "custom"
	}
	for _, k := range Locked {
		if _, ok := out[k]; !ok {
			out[k] = "N"
		}
	}
	return out
}

// order: the verification method first, so the moment anything changes
// only the permanent password works; then access-mode, then every
// permission, the Locked ones included; the password last of all.
var order = []string{
	"verification-method", "access-mode", "enable-keyboard", "enable-clipboard", "enable-file-transfer", "enable-audio",
	"enable-tunnel", "enable-remote-restart",
	"enable-terminal", "enable-camera", "enable-remote-printer", "enable-block-input", "enable-privacy-mode", "enable-record-session",
	"approve-mode", "allow-auto-disconnect", "auto-disconnect-timeout",
}

// Outcome of Apply: OK, or a code and the keys that disagreed.
type Outcome struct {
	OK   bool
	Code string
	Keys []string
}

// Set writes values (each through SetArgs) and reads every one back. It
// returns the keys that did not read back as set.
func (e *Enforcer) Set(ctx context.Context, values map[string]string) []string {
	var bad []string
	for _, k := range order {
		if r := e.call(ctx, SetArgs(k, values[k])); !r.ok() {
			bad = append(bad, k)
		}
	}
	for _, k := range order {
		if contains(bad, k) {
			continue
		}
		got, ok := e.Read(ctx, k)
		if !ok || !Matches(k, got, values[k]) {
			bad = append(bad, k)
		}
	}
	return bad
}

// Check reads every key and returns those that no longer read back as
// values (drift between sessions).
func (e *Enforcer) Check(ctx context.Context, values map[string]string) []string {
	var bad []string
	for _, k := range order {
		got, ok := e.Read(ctx, k)
		if !ok || !Matches(k, got, values[k]) {
			bad = append(bad, k)
		}
	}
	return bad
}

// SetPassword sets RustDesk's permanent password. RustDesk prints "Done!"
// only when its running service accepted it (0.68.3 lab; the installer
// relies on the same word); anything else is a failure.
func (e *Enforcer) SetPassword(ctx context.Context, pw string) bool {
	r := e.call(ctx, PasswordArgs(pw))
	return r.ok() && bytes.Contains(r.Stdout, []byte("Done"))
}

// Apply enforces a verified grant: every setting, every readback, then the
// one-time password. On any disagreement it refuses — the session is ended
// at once (a password nobody is told) and nothing weaker is substituted.
// The caller has saved the previous values first.
func (e *Enforcer) Apply(ctx context.Context, g *grant.Grant) Outcome {
	// Before anything is written: what RustDesk would make of the desired
	// values must be nothing the grant and the Ceiling do not both allow.
	if over := Beyond(g, Desired(g)); len(over) > 0 {
		_ = e.EndSession(ctx)
		return Outcome{Code: ReadbackMismatch, Keys: over}
	}
	if bad := e.Set(ctx, Desired(g)); len(bad) > 0 {
		_ = e.EndSession(ctx)
		return Outcome{Code: ReadbackMismatch, Keys: bad}
	}
	if !e.SetPassword(ctx, g.Password) {
		_ = e.EndSession(ctx)
		return Outcome{Code: PasswordNotApplied, Keys: []string{"password"}}
	}
	return Outcome{OK: true}
}

// RandomPassword: 24 characters from A–Z a–z 0–9 (rejection sampling), made
// here and told to nobody.
func RandomPassword() string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, 0, 24)
	buf := make([]byte, 32)
	for len(out) < 24 {
		if _, err := rand.Read(buf); err != nil {
			panic("crypto/rand failed")
		}
		for _, b := range buf {
			if b < 248 && len(out) < 24 {
				out = append(out, alphabet[int(b)%62])
			}
		}
	}
	return string(out)
}

func (e *Enforcer) newPassword() string {
	if e.Password != nil {
		return e.Password()
	}
	return RandomPassword()
}

// Secure replaces the permanent password with one nobody is told.
func (e *Enforcer) Secure(ctx context.Context) bool {
	return e.SetPassword(ctx, e.newPassword())
}

// EndSession ends every session and leaves no password anyone knows: a
// random password nobody is told, then stop-service Y, a pause, and N.
// Every step runs even when an earlier one failed; the error says which.
func (e *Enforcer) EndSession(ctx context.Context) error {
	var errs []error
	if !e.Secure(ctx) {
		errs = append(errs, errors.New("password"))
	}
	if r := e.call(ctx, StopServiceArgs(true)); !r.ok() {
		errs = append(errs, errors.New("stop-service Y"))
	}
	e.sleep(StopPause)
	if r := e.call(ctx, StopServiceArgs(false)); !r.ok() {
		errs = append(errs, errors.New("stop-service N"))
	}
	if got, ok := e.Read(ctx, "stop-service"); !ok || !Matches("stop-service", got, "N") {
		errs = append(errs, errors.New("stop-service did not read back N"))
	}
	return errors.Join(errs...)
}

// Restore puts every saved value back and reads it back; the keys that
// disagree are returned. A saved access-mode full goes back as RustDesk's
// default (RestoreValue). A Locked key missing from a file an older agent
// saved was never changed by it, so there is nothing to put back.
func (e *Enforcer) Restore(ctx context.Context, s *Saved) []string {
	var bad []string
	for _, k := range Keys {
		v, ok := s.Values[k]
		if !ok && isLocked(k) {
			continue
		}
		if !ok {
			bad = append(bad, k)
			continue
		}
		v = RestoreValue(k, v)
		if r := e.call(ctx, RestoreArgs(k, v)); !r.ok() {
			bad = append(bad, k)
			continue
		}
		if got, ok := e.Read(ctx, k); !ok || !Matches(k, got, v) {
			bad = append(bad, k)
		}
	}
	return bad
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}
