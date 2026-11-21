// Package enforce is the signed agent's Managed Secure Access enforcement
// (0.72, build step 4 in docs/managed-secure-access.md, §3.3, §3.7): it
// applies a verified grant to the installed RustDesk through RustDesk's own
// command line, reads every value back, sets the one-time password, ends a
// session with a password nobody is told, and on rollback restores the
// settings it saved before it first changed anything.
//
// It is portable (no Windows calls) so every decision is tested on every
// platform with a fake RustDesk. The Windows side (msa_poller_windows.go,
// enforceRunner) is its one exec site: the INSTALLED rustdesk.exe by its
// absolute path, an argument array, no shell — exactly the argument lists
// built here and nowhere else. check-security-invariants §82. No list it
// builds ever carries access-mode full (0.78.1, F1).
//
// The password — the grant's one-time password, or a random one nobody is
// told — goes only into PasswordArgs and the runner. It is never logged,
// journaled, reported or returned.
package enforce

import (
	"regexp"

	"github.com/agit8or1/rem0te/windows-installer/internal/msa"
)

// Locked (0.78.1, F1) are RustDesk's remaining permission options: the ones
// no grant ever turns on. Every grant, view and control alike, sets each to N
// and reads it back. RustDesk reads each on the controlled computer
// (Connection::permission in 1.4.1–1.4.6, is_permission_enabled_locally from
// 1.4.7) through option2bool, which counts anything but "N" as on, so an
// option the agent never wrote is on. The names are the same in every
// supported release (1.4.1–1.5.3); enable-privacy-mode is read only from
// 1.4.7, and on 1.4.1–1.4.6 the N is stored, read back and ignored
// (docs/managed-secure-access.md §3.12).
var Locked = []string{
	"enable-terminal", "enable-camera", "enable-remote-printer",
	"enable-block-input", "enable-privacy-mode", "enable-record-session",
}

// Keys are the settings enforcement changes, saves and restores: the
// preflight's eleven (msa.Keys), in the same order, then Locked. The
// preflight itself still reads only its eleven.
var Keys = append(append([]string(nil), msa.Keys...), Locked...)

// Permissions are every RustDesk permission option, an enable-* key the
// controlled side checks before it serves something: the six a grant
// governs, then Locked. Effective evaluates exactly these.
var Permissions = append([]string{
	"enable-keyboard", "enable-clipboard", "enable-file-transfer", "enable-audio",
	"enable-tunnel", "enable-remote-restart",
}, Locked...)

// allowed is the closed set of values enforcement itself ever sets.
// access-mode is never "full": RustDesk's Flutter builds read full as every
// permission on before they look at any enable-* key (F1, 0.78.1), so
// control is "custom", which makes RustDesk read each key.
var allowed = map[string]map[string]bool{
	"access-mode":           {"view": true, "custom": true},
	"enable-keyboard":       {"Y": true, "N": true},
	"enable-clipboard":      {"Y": true, "N": true},
	"enable-file-transfer":  {"Y": true, "N": true},
	"enable-audio":          {"Y": true, "N": true},
	"enable-tunnel":         {"Y": true, "N": true},
	"enable-remote-restart": {"Y": true, "N": true},
	"approve-mode":          {"click": true, "password": true},
	"verification-method":   {"use-permanent-password": true},
	"allow-auto-disconnect": {"Y": true},
	"enable-terminal":       {"N": true},
	"enable-camera":         {"N": true},
	"enable-remote-printer": {"N": true},
	"enable-block-input":    {"N": true},
	"enable-privacy-mode":   {"N": true},
	"enable-record-session": {"N": true},
}

// refused is a value no argument list ever carries, set or restore:
// access-mode full turns every permission on (F1).
func refused(key, value string) bool {
	return key == "access-mode" && value == "full"
}

var (
	timeoutRE  = regexp.MustCompile(`^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$`)
	passwordRE = regexp.MustCompile(`^[A-Za-z0-9]{24}$`)
	// restoreRE is the preflight's answer charset: a value RustDesk printed,
	// put back as it was (empty included: the option was unset).
	restoreRE = regexp.MustCompile(`^[A-Za-z0-9_.:-]{0,64}$`)
)

func isKey(k string) bool {
	for _, x := range Keys {
		if x == k {
			return true
		}
	}
	return false
}

// SetArgs is the only way a value enforcement chooses reaches RustDesk:
// {"--option", key, value} for a key on the closed list and a value in that
// key's closed set; nil for anything else.
func SetArgs(key, value string) []string {
	if !isKey(key) || refused(key, value) {
		return nil
	}
	if key == "auto-disconnect-timeout" {
		if !timeoutRE.MatchString(value) {
			return nil
		}
	} else if !allowed[key][value] {
		return nil
	}
	return []string{"--option", key, value}
}

// RestoreArgs puts back a value the agent read before its first apply:
// {"--option", key, saved} for a key on the closed list and a value in the
// preflight's answer charset; nil for anything else, and nil for access-mode
// full (Restore puts back RustDesk's default instead: RestoreValue).
func RestoreArgs(key, saved string) []string {
	if !isKey(key) || refused(key, saved) || !restoreRE.MatchString(saved) {
		return nil
	}
	return []string{"--option", key, saved}
}

// PasswordArgs is the only way a password reaches RustDesk: {"--password",
// pw} for 24 characters from A–Z a–z 0–9; nil for anything else.
func PasswordArgs(pw string) []string {
	if !passwordRE.MatchString(pw) {
		return nil
	}
	return []string{"--password", pw}
}

// StopServiceArgs: {"--option", "stop-service", "Y"} or "N". RustDesk ends
// every session and stops serving on Y, and serves again on N (0.68.3 lab).
func StopServiceArgs(stop bool) []string {
	if stop {
		return []string{"--option", "stop-service", "Y"}
	}
	return []string{"--option", "stop-service", "N"}
}

// ReadArgs is the preflight's read, {"--option", key} with no value, for the
// eleven keys, plus the reads enforcement adds: Locked (0.78.1), and
// stop-service, to confirm RustDesk serves again after a session was ended.
func ReadArgs(key string) []string {
	if key == "stop-service" || isLocked(key) {
		return []string{"--option", key}
	}
	return msa.ReadArgs(key)
}

func isLocked(k string) bool {
	for _, x := range Locked {
		if x == k {
			return true
		}
	}
	return false
}

// emptyMeans: RustDesk removes an option set to its default, so reading it
// back prints nothing. For these an empty readback is the default named
// here (the 0.68.3 lab's table, rustdesk-probe.ps1).
//
// An unset access-mode is RustDesk's own "Custom" (its Flutter settings page
// writes "" for it): neither full nor view, so each enable-* key is read.
var emptyMeans = map[string]string{
	"enable-keyboard": "Y", "enable-clipboard": "Y", "enable-file-transfer": "Y", "enable-audio": "Y",
	"enable-tunnel": "Y", "enable-remote-restart": "Y", "allow-auto-disconnect": "N",
	"verification-method": "use-both-passwords", "stop-service": "N",
	"enable-terminal": "Y", "enable-camera": "Y", "enable-remote-printer": "Y",
	"enable-block-input": "Y", "enable-privacy-mode": "Y", "enable-record-session": "Y",
	"access-mode": "custom",
}

// Effective is what RustDesk's Flutter build on the controlled computer
// grants a connection, permission by permission, given these option values:
// a port of Connection::permission (1.4.1–1.4.6) and
// is_permission_enabled_locally (1.4.7–1.5.3) with hbb_common's option2bool.
// access-mode full is every permission on, view every permission off, and
// anything else (custom, or unset) reads each enable-* key, on unless it is
// exactly "N". It leaves out the rendezvous server's ControlPermissions
// (1.4.9+), which only RustDesk Server Pro sends; Rem0te's hbbs never does.
func Effective(values map[string]string) map[string]bool {
	out := map[string]bool{}
	for _, k := range Permissions {
		switch values["access-mode"] {
		case "full":
			out[k] = true
		case "view":
			out[k] = false
		default:
			out[k] = values[k] != "N"
		}
	}
	return out
}

// RestoreValue is what Restore writes for a saved value: the value itself,
// except access-mode full, which is put back as "" — RustDesk's default,
// Custom, which reads each enable-* key (restored alongside it). Enforcement
// never writes full, not even to put a computer back as it was (F1).
func RestoreValue(key, saved string) string {
	if refused(key, saved) {
		return ""
	}
	return saved
}

// Matches: the value read back is the value wanted, or empty where empty
// means exactly that default.
func Matches(key, got, want string) bool {
	if got == want {
		return true
	}
	return got == "" && emptyMeans[key] != "" && emptyMeans[key] == want
}

// Valid reports whether args is exactly one of the lists this package
// builds: a read, a set, a restore, a password or a stop-service toggle. The
// Windows runner refuses anything else before it starts a process.
func Valid(args []string) bool {
	eq := func(b []string) bool {
		if b == nil || len(b) != len(args) {
			return false
		}
		for i := range b {
			if b[i] != args[i] {
				return false
			}
		}
		return true
	}
	switch len(args) {
	case 2:
		if args[0] == "--password" {
			return eq(PasswordArgs(args[1]))
		}
		return eq(ReadArgs(args[1]))
	case 3:
		if args[1] == "stop-service" {
			return eq(StopServiceArgs(true)) || eq(StopServiceArgs(false))
		}
		return eq(SetArgs(args[1], args[2])) || eq(RestoreArgs(args[1], args[2]))
	}
	return false
}
