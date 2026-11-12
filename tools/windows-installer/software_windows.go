//go:build windows

package main

// Software deployment for the signed agent (v0.34): finding winget.exe for
// the SYSTEM account, and the read-only probe detection rules use. The
// decisions — what may be installed, the hash check, the detection rule —
// are in internal/action; the process start is in internal/winget.
//
// winget under SYSTEM: App Installer is an MSIX package, so there is no
// winget.exe on SYSTEM's PATH and no per-user alias. The agent looks for the
// provisioned package under %ProgramFiles%\WindowsApps, by the Microsoft
// publisher id, and runs the newest version's winget.exe by its absolute
// path. If it is not there, the action answers winget_unavailable: nothing
// is installed to get it.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/winget"
)

// Microsoft.DesktopAppInstaller_<version>_<arch>__8wekyb3d8bbwe
var appInstallerDirRE = regexp.MustCompile(`^Microsoft\.DesktopAppInstaller_([0-9]{1,5})\.([0-9]{1,5})\.([0-9]{1,6})\.([0-9]{1,6})_(x64|arm64)__8wekyb3d8bbwe$`)

type winLocatedWinget struct{}

func locateWinget() (string, error) {
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return "", err
	}
	apps := filepath.Join(pf, "WindowsApps")
	ents, err := os.ReadDir(apps)
	if err != nil {
		return "", fmt.Errorf("cannot list %s: %w", apps, err)
	}
	best, bestV := "", [4]int{}
	for _, e := range ents {
		m := appInstallerDirRE.FindStringSubmatch(e.Name())
		if m == nil || !e.IsDir() || e.Type()&fs.ModeSymlink != 0 {
			continue
		}
		var v [4]int
		for i := 0; i < 4; i++ {
			v[i], _ = strconv.Atoi(m[i+1])
		}
		if best == "" || later(v, bestV) {
			best, bestV = e.Name(), v
		}
	}
	if best == "" {
		return "", errors.New("App Installer (winget) is not provisioned for all users on this computer")
	}
	exe := filepath.Join(apps, best, "winget.exe")
	if reparse(filepath.Join(apps, best)) || reparse(exe) {
		return "", errors.New("winget.exe is behind a reparse point; refusing it")
	}
	st, err := os.Lstat(exe)
	if err != nil || !st.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", exe)
	}
	return exe, nil
}

func later(a, b [4]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func reparse(p string) bool {
	u, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return true
	}
	attr, err := windows.GetFileAttributes(u)
	return err != nil || attr&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

func (winLocatedWinget) Locate() (string, error) { return locateWinget() }

func (winLocatedWinget) Run(args []string, timeout time.Duration) (int, []byte, error) {
	exe, err := locateWinget()
	if err != nil {
		return -1, nil, err
	}
	return winget.Runner{Path: exe}.Run(args, timeout)
}

type winSoftware struct{}

const uninstallRoot = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`

// UninstallEntries reads Programs and Features from both registry views.
func (winSoftware) UninstallEntries() ([]action.UninstallEntry, error) {
	var out []action.UninstallEntry
	opened := false
	for _, view := range []uint32{registry.WOW64_64KEY, registry.WOW64_32KEY} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallRoot, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE|view)
		if err != nil {
			continue
		}
		opened = true
		names, _ := k.ReadSubKeyNames(-1)
		for _, n := range names {
			sk, err := registry.OpenKey(k, n, registry.QUERY_VALUE|view)
			if err != nil {
				continue
			}
			dn, _, _ := sk.GetStringValue("DisplayName")
			dv, _, _ := sk.GetStringValue("DisplayVersion")
			sk.Close()
			out = append(out, action.UninstallEntry{Key: n, DisplayName: dn, DisplayVersion: dv})
		}
		k.Close()
	}
	if !opened {
		return nil, errors.New("cannot open the uninstall registry keys")
	}
	return out, nil
}

// FileVersion reads the version resource of a file under Program Files.
// It never runs the file.
func (winSoftware) FileVersion(base, file string) (string, error) {
	if !action.ValidDetectionFile(file) {
		return "", errors.New("detection file outside the allowed form")
	}
	id := windows.FOLDERID_ProgramFiles
	switch base {
	case "ProgramFiles":
	case "ProgramFilesX86":
		id = windows.FOLDERID_ProgramFilesX86
	default:
		return "", errors.New("unknown base")
	}
	root, err := windows.KnownFolderPath(id, 0)
	if err != nil {
		return "", err
	}
	p := filepath.Join(root, file)
	if !strings.HasPrefix(strings.ToLower(p), strings.ToLower(root)+`\`) {
		return "", errors.New("detection file escapes its base")
	}
	if st, err := os.Lstat(p); err != nil {
		if os.IsNotExist(err) {
			return "", fs.ErrNotExist
		}
		return "", err
	} else if !st.Mode().IsRegular() {
		return "", errors.New("detection file is not a regular file")
	}
	size, err := windows.GetFileVersionInfoSize(p, nil)
	if err != nil || size == 0 {
		return "", fmt.Errorf("no version resource: %v", err)
	}
	buf := make([]byte, size)
	if err := windows.GetFileVersionInfo(p, 0, size, unsafe.Pointer(&buf[0])); err != nil {
		return "", err
	}
	var fixed *windows.VS_FIXEDFILEINFO
	var n uint32
	if err := windows.VerQueryValue(unsafe.Pointer(&buf[0]), `\`, unsafe.Pointer(&fixed), &n); err != nil || fixed == nil || n == 0 {
		return "", errors.New("no fixed version information")
	}
	return fmt.Sprintf("%d.%d.%d.%d", fixed.FileVersionMS>>16, fixed.FileVersionMS&0xffff, fixed.FileVersionLS>>16, fixed.FileVersionLS&0xffff), nil
}

// AppManagers: Configuration Manager's client and the Intune Management
// Extension both deploy applications; installing beside them would fight.
func (winSoftware) AppManagers() []string {
	var out []string
	r := winRegistry{}
	if r.ServiceExists("CcmExec") {
		out = append(out, "configmgr")
	}
	if r.ServiceExists("IntuneManagementExtension") {
		out = append(out, "intune")
	}
	return out
}
