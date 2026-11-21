package remote

import (
	"path/filepath"
	"regexp"
	"strings"
)

// ShellCommand: the absolute path and fixed arguments for a shell name, under
// the given System32 directory. Only "cmd" and "powershell"; anything else is
// refused. The arguments are constants:
//
//	cmd.exe /D                      (/D: the registry's AutoRun commands do not run)
//	powershell.exe -NoLogo -NoProfile -NonInteractive -Command -
//	                                (no profile; commands are read from stdin)
func ShellCommand(system32, shell string) (path string, args []string, ok bool) {
	// An absolute local directory only: never a UNC or device path, never "..".
	if strings.HasPrefix(system32, `\\`) || strings.HasPrefix(system32, "//") || strings.Contains(system32, "..") {
		return "", nil, false
	}
	if !isWinAbs(system32) && !filepath.IsAbs(system32) {
		return "", nil, false
	}
	switch shell {
	case "cmd":
		return joinWin(system32, "cmd.exe"), []string{"/D"}, true
	case "powershell":
		return joinWin(system32, `WindowsPowerShell\v1.0\powershell.exe`), []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"}, true
	}
	return "", nil, false
}

var winAbsRE = regexp.MustCompile(`^[A-Za-z]:\\`)

func isWinAbs(p string) bool { return winAbsRE.MatchString(p) }

// joinWin joins with a backslash on a Windows path, and with filepath.Join
// elsewhere (the tests run on Linux too).
func joinWin(dir, rel string) string {
	if isWinAbs(dir) {
		return strings.TrimRight(dir, `\`) + `\` + rel
	}
	return filepath.Join(dir, filepath.FromSlash(strings.ReplaceAll(rel, `\`, "/")))
}

// ValidShell reports whether a name is one of the two shells.
func ValidShell(s string) bool {
	for _, x := range Shells {
		if s == x {
			return true
		}
	}
	return false
}

var sessionIDRE = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ValidSessionID: 32 lowercase hex characters, as the portal makes them.
func ValidSessionID(s string) bool { return sessionIDRE.MatchString(s) }
