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
// built here and nowhere else. check-security-invariants §82.
//
// The password — the grant's one-time password, or a random one nobody is
// told — goes only into PasswordArgs and the runner. It is never logged,
// journaled, reported or returned.
package enforce

import (
	"regexp"

	"github.com/agit8or1/rem0te/windows-installer/internal/msa"
)

// Keys are the settings enforcement changes, saves and restores: exactly the
// preflight's eleven (msa.Keys), in the same order.
var Keys = msa.Keys

// allowed is the closed set of values enforcement itself ever sets.
var allowed = map[string]map[string]bool{
	"access-mode":           {"view": true, "full": true},
	"enable-keyboard":       {"Y": true, "N": true},
	"enable-clipboard":      {"Y": true, "N": true},
	"enable-file-transfer":  {"Y": true, "N": true},
	"enable-audio":          {"Y": true, "N": true},
	"enable-tunnel":         {"Y": true, "N": true},
	"enable-remote-restart": {"Y": true, "N": true},
	"approve-mode":          {"click": true, "password": true},
	"verification-method":   {"use-permanent-password": true},
	"allow-auto-disconnect": {"Y": true},
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
	if !isKey(key) {
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
// preflight's answer charset; nil for anything else.
func RestoreArgs(key, saved string) []string {
	if !isKey(key) || !restoreRE.MatchString(saved) {
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
// eleven keys, plus the one read enforcement adds: stop-service, to confirm
// RustDesk serves again after a session was ended.
func ReadArgs(key string) []string {
	if key == "stop-service" {
		return []string{"--option", "stop-service"}
	}
	return msa.ReadArgs(key)
}

// emptyMeans: RustDesk removes an option set to its default, so reading it
// back prints nothing. For these an empty readback is the default named
// here (the 0.68.3 lab's table, rustdesk-probe.ps1).
var emptyMeans = map[string]string{
	"enable-keyboard": "Y", "enable-clipboard": "Y", "enable-file-transfer": "Y", "enable-audio": "Y",
	"enable-tunnel": "Y", "enable-remote-restart": "Y", "allow-auto-disconnect": "N",
	"verification-method": "use-both-passwords", "stop-service": "N",
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
