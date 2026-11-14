package stub

// The simulated uninstall registry for windows.software.remove@1 (0.41).
// Programs are the HKLM uninstall keys the computer has, in the same state
// file as the winget stub; Remove is what running the removal does to them.
// Nothing here starts a process: the removal is recorded and applied to the
// state, and the agent's decision code (internal/action/remove.go) is what
// the tests and the simulator exercise. The Windows exec path
// (software_remove_windows.go) is not run by any of this.

import (
	"errors"
	"strings"
	"time"
)

// Program is one uninstall key.
type Program struct {
	View                 string `json:"view"` // "64" or "32"
	Key                  string `json:"key"`
	DisplayName          string `json:"displayName"`
	DisplayVersion       string `json:"displayVersion,omitempty"`
	UninstallString      string `json:"uninstallString,omitempty"`
	QuietUninstallString string `json:"quietUninstallString,omitempty"`
	WindowsInstaller     bool   `json:"windowsInstaller,omitempty"`
	// NSIS (0.42): the uninstaller file the UninstallString names carries
	// the NSIS header (what FileHead returns for it).
	NSIS bool `json:"nsis,omitempty"`
	// What running its removal does: the exit code (0 = success), whether
	// the key stays (noEffect), and whether it never finishes (hang).
	RemoveExitCode int  `json:"removeExitCode,omitempty"`
	NoEffect       bool `json:"noEffect,omitempty"`
	Hang           bool `json:"hang,omitempty"`
}

// Removal is one removal the stub was asked to run.
type Removal struct {
	Kind        string `json:"kind"`
	ProductCode string `json:"productCode,omitempty"`
	Exe         string `json:"exe,omitempty"`
	Args        string `json:"args,omitempty"`
}

// Registry reads and removes Programs in the state file.
type Registry struct{ State string }

// Program finds view\key, as the agent's interface asks.
func (r Registry) Program(view, key string) (Program, bool, error) {
	s, err := Load(r.State)
	if err != nil {
		return Program{}, false, err
	}
	if s.RegistryUnreadable {
		return Program{}, false, errors.New("Access is denied.")
	}
	for _, p := range s.Programs {
		if p.View == view && strings.EqualFold(p.Key, key) {
			return p, true, nil
		}
	}
	return Program{}, false, nil
}

// Remove records c and applies it: an msi removal removes the key named by
// its product code; a quiet removal the key whose QuietUninstallString names
// that program.
func (r Registry) Remove(c Removal, timeout time.Duration) (int, []byte, error) {
	s, err := Load(r.State)
	if err != nil {
		return -1, nil, err
	}
	s.Removals = append(s.Removals, c)
	idx := -1
	for i, p := range s.Programs {
		if (c.Kind == "msi" && strings.EqualFold(p.Key, c.ProductCode)) ||
			(c.Kind != "msi" && c.Exe != "" && (strings.Contains(p.QuietUninstallString, c.Exe) || strings.Contains(p.UninstallString, c.Exe))) {
			idx = i
			break
		}
	}
	if idx < 0 {
		if err := s.Save(r.State); err != nil {
			return -1, nil, err
		}
		if c.Kind == "msi" {
			return 1605, []byte("This action is only valid for products that are currently installed."), nil
		}
		return 2, []byte("uninstaller: nothing to remove"), nil
	}
	p := s.Programs[idx]
	if p.Hang {
		if err := s.Save(r.State); err != nil {
			return -1, nil, err
		}
		time.Sleep(timeout)
		return -1, nil, timeoutErr{}
	}
	if !p.NoEffect && (p.RemoveExitCode == 0 || p.RemoveExitCode == 3010) {
		s.Programs = append(s.Programs[:idx], s.Programs[idx+1:]...)
	}
	if err := s.Save(r.State); err != nil {
		return -1, nil, err
	}
	return p.RemoveExitCode, nil, nil
}

// NSISMarker is what an NSIS uninstaller's first header starts with (the
// agent's own constant, repeated so the stub does not import the agent).
const NSISMarker = "\xef\xbe\xad\xdeNullsoftInst"

// FileHead returns a simulated file start for an uninstaller a program's
// UninstallString names: an NSIS header when that program is marked NSIS,
// an ordinary executable's start otherwise, and an error for a file no
// program names.
func (r Registry) FileHead(path string, max int) ([]byte, error) {
	s, err := Load(r.State)
	if err != nil {
		return nil, err
	}
	for _, p := range s.Programs {
		if path != "" && strings.Contains(p.UninstallString, path) {
			b := []byte("MZ\x90\x00 simulated executable ")
			if p.NSIS {
				b = append(b, []byte(NSISMarker+" simulated NSIS first header")...)
			}
			if len(b) > max {
				b = b[:max]
			}
			return b, nil
		}
	}
	return nil, errors.New("The system cannot find the file specified.")
}

type timeoutErr struct{}

func (timeoutErr) Error() string { return "the uninstaller did not finish in time" }
func (timeoutErr) Timeout() bool { return true }
