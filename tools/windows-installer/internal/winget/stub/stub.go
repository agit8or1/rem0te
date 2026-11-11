// Package stub is a stand-in winget for the agent's Go tests and for
// rem0te-action-sim (v0.34). It is a real executable — the test binary or
// the simulator re-executed with REM0TE_WINGET_STUB naming a state file — so
// the agent's own exec path (internal/winget.Runner) is what runs it, with
// the argument array the agent built. It records every argv it receives.
//
// Linux exit statuses are 8 bits, so winget's HRESULT exit codes travel as
// small codes (ExitCodes) and Winget.Run maps them back.
package stub

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/winget"
)

// EnvVar names the state file; set, the process acts as winget.
const EnvVar = "REM0TE_WINGET_STUB"

// State is the simulated computer, as JSON.
type State struct {
	// Version is what `winget --version` prints ("v1.9.25200"); empty means
	// winget is not installed (Locate fails).
	Version string `json:"version"`
	// Packages the source offers, by "<id>@<version>".
	Packages map[string]*Package `json:"packages,omitempty"`
	// Installed: the uninstall entries on the computer.
	Installed []Entry `json:"installed,omitempty"`
	// Files: "<base>|<file>" → file version.
	Files map[string]string `json:"files,omitempty"`
	// Managers: what else manages applications (configmgr, intune).
	Managers []string `json:"managers,omitempty"`
	// Calls: every argv the stub received, in order.
	Calls [][]string `json:"calls,omitempty"`
}

// Package is one package version the simulated source offers.
type Package struct {
	// Installer: the installer file's content as downloaded.
	Installer string `json:"installer"`
	// ManifestSha256: the InstallerSha256 the downloaded manifest declares
	// ("" means the installer's real hash).
	ManifestSha256 string `json:"manifestSha256,omitempty"`
	// What an install adds.
	DisplayName    string `json:"displayName,omitempty"`
	DisplayVersion string `json:"displayVersion,omitempty"`
	UninstallKey   string `json:"uninstallKey,omitempty"`
	File           string `json:"file,omitempty"` // "<base>|<file>", set to DisplayVersion on install
	// Exit codes (winget HRESULTs, 0 = success).
	DownloadExitCode  uint32 `json:"downloadExitCode,omitempty"`
	ExitCode          uint32 `json:"exitCode,omitempty"`
	UninstallExitCode uint32 `json:"uninstallExitCode,omitempty"`
	// NoEffect: install/uninstall report success and change nothing.
	NoEffect bool `json:"noEffect,omitempty"`
	// Hang: install and uninstall never finish (the caller's timeout fires).
	Hang bool `json:"hang,omitempty"`
}

// Entry is one uninstall entry.
type Entry struct {
	Key            string `json:"key"`
	DisplayName    string `json:"displayName"`
	DisplayVersion string `json:"displayVersion"`
	PackageID      string `json:"packageId,omitempty"`
}

// Winget HRESULTs the stub uses.
const (
	NoPackageFound  = 0x8A150014
	RebootToFinish  = 0x8A150109
	RebootToInstall = 0x8A15010A
	InstallFailed   = 0x8A150011
)

// ExitCodes: small exit status → winget HRESULT.
var ExitCodes = map[int]uint32{101: NoPackageFound, 102: RebootToFinish, 103: RebootToInstall, 104: InstallFailed}

func small(h uint32) int {
	if h == 0 {
		return 0
	}
	for k, v := range ExitCodes {
		if v == h {
			return k
		}
	}
	return 1
}

func Load(path string) (*State, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	s := &State{}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *State) Save(path string) error {
	b, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

var valueOpts = map[string]bool{"--id": true, "--version": true, "--source": true, "--scope": true, "--download-directory": true}
var flagOpts = map[string]bool{"--exact": true, "--silent": true, "--skip-dependencies": true, "--accept-package-agreements": true,
	"--accept-source-agreements": true, "--disable-interactivity": true}
var commands = map[string]bool{"download": true, "install": true, "uninstall": true}

// Main is the stub's entry point: args as winget would receive them.
func Main(args []string) int {
	path := os.Getenv(EnvVar)
	s, err := Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "stub state:", err)
		return 1
	}
	s.Calls = append(s.Calls, append([]string{}, args...))
	if err := s.Save(path); err != nil {
		return 1
	}
	if len(args) == 1 && args[0] == "--version" {
		if s.Version == "" {
			return 1
		}
		fmt.Println(s.Version)
		return 0
	}
	if len(args) == 0 || !commands[args[0]] {
		fmt.Fprintln(os.Stderr, "unknown command")
		return 1
	}
	opts := map[string]string{}
	for i := 1; i < len(args); i++ {
		a := args[i]
		switch {
		case valueOpts[a]:
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
				fmt.Fprintln(os.Stderr, "missing value for", a)
				return 1
			}
			opts[a] = args[i+1]
			i++
		case flagOpts[a]:
			opts[a] = "true"
		default:
			fmt.Fprintln(os.Stderr, "unknown argument:", a)
			return 1
		}
	}
	id := opts["--id"]
	if id == "" || opts["--exact"] != "true" {
		fmt.Fprintln(os.Stderr, "--id and --exact are required here")
		return 1
	}
	switch args[0] {
	case "download":
		pkg := s.Packages[id+"@"+opts["--version"]]
		if pkg == nil {
			return small(NoPackageFound)
		}
		if pkg.DownloadExitCode != 0 {
			return small(pkg.DownloadExitCode)
		}
		dir := opts["--download-directory"]
		if dir == "" {
			return 1
		}
		sum := sha256.Sum256([]byte(pkg.Installer))
		decl := pkg.ManifestSha256
		if decl == "" {
			decl = hex.EncodeToString(sum[:])
		}
		name := strings.ReplaceAll(id, ".", "_") + "_" + opts["--version"]
		if err := os.WriteFile(filepath.Join(dir, name+"_Machine_X64_exe.exe"), []byte(pkg.Installer), 0o600); err != nil {
			return 1
		}
		manifest := fmt.Sprintf("PackageIdentifier: %s\nPackageVersion: %s\nInstallers:\n- Architecture: x64\n  Scope: machine\n  InstallerSha256: %s\nManifestType: merged\n", id, opts["--version"], strings.ToUpper(decl))
		if err := os.WriteFile(filepath.Join(dir, name+".yaml"), []byte(manifest), 0o600); err != nil {
			return 1
		}
		return 0
	case "install":
		pkg := s.Packages[id+"@"+opts["--version"]]
		if pkg == nil {
			return small(NoPackageFound)
		}
		if pkg.Hang {
			time.Sleep(10 * time.Minute)
		}
		if pkg.ExitCode != 0 && pkg.ExitCode != RebootToFinish && pkg.ExitCode != RebootToInstall {
			return small(pkg.ExitCode)
		}
		if !pkg.NoEffect {
			if s.Files == nil {
				s.Files = map[string]string{}
			}
			if pkg.File != "" {
				s.Files[pkg.File] = pkg.DisplayVersion
			}
			if pkg.DisplayName != "" || pkg.UninstallKey != "" {
				s.Installed = append(s.Installed, Entry{Key: pkg.UninstallKey, DisplayName: pkg.DisplayName, DisplayVersion: pkg.DisplayVersion, PackageID: id})
			}
			if err := s.Save(path); err != nil {
				return 1
			}
		}
		return small(pkg.ExitCode)
	case "uninstall":
		var pkg *Package
		for k, p := range s.Packages {
			if strings.HasPrefix(k, id+"@") {
				pkg = p
			}
		}
		var keep []Entry
		found := false
		for _, e := range s.Installed {
			if e.PackageID == id {
				found = true
				continue
			}
			keep = append(keep, e)
		}
		if !found {
			return small(NoPackageFound)
		}
		if pkg != nil && pkg.Hang {
			time.Sleep(10 * time.Minute)
		}
		if pkg != nil && pkg.UninstallExitCode != 0 && pkg.UninstallExitCode != RebootToFinish {
			return small(pkg.UninstallExitCode)
		}
		if pkg == nil || !pkg.NoEffect {
			s.Installed = keep
			for k, p := range s.Packages {
				if strings.HasPrefix(k, id+"@") && p.File != "" {
					delete(s.Files, p.File)
				}
			}
			if err := s.Save(path); err != nil {
				return 1
			}
		}
		if pkg != nil {
			return small(pkg.UninstallExitCode)
		}
		return 0
	}
	return 1
}

// Winget is the agent's view of the stub: Locate fails when the state says
// winget is absent, and Run maps the stub's small exit codes back.
type Winget struct {
	State  string
	Runner winget.Runner
}

// New runs the executable at self (the test binary or the simulator) as winget.
func New(self, state string) Winget {
	return Winget{State: state, Runner: winget.Runner{Path: self, Env: []string{EnvVar + "=" + state}}}
}

func (w Winget) Locate() (string, error) {
	s, err := Load(w.State)
	if err != nil {
		return "", err
	}
	if s.Version == "" {
		return "", errors.New("winget.exe was not found under WindowsApps (App Installer is not installed for all users)")
	}
	return w.Runner.Locate()
}

func (w Winget) Run(args []string, timeout time.Duration) (int, []byte, error) {
	code, out, err := w.Runner.Run(args, timeout)
	if h, ok := ExitCodes[code]; ok && err == nil {
		return int(h), out, nil
	}
	return code, out, err
}

// Calls: the argv the stub has received.
func Calls(state string) [][]string {
	s, err := Load(state)
	if err != nil {
		return nil
	}
	return s.Calls
}

// Probe reads detection data from the same state. Entries returns the
// stub's own Entry type; callers adapt it to action.UninstallEntry.
type Probe struct{ State string }

func (p Probe) Entries() ([]Entry, error) {
	s, err := Load(p.State)
	if err != nil {
		return nil, err
	}
	return s.Installed, nil
}

func (p Probe) FileVersion(base, file string) (string, error) {
	s, err := Load(p.State)
	if err != nil {
		return "", err
	}
	v, ok := s.Files[base+"|"+file]
	if !ok {
		return "", fs.ErrNotExist
	}
	return v, nil
}

func (p Probe) AppManagers() []string {
	s, err := Load(p.State)
	if err != nil {
		return nil
	}
	return s.Managers
}
