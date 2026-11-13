//go:build windows

package main

// Removing an installed program for the signed agent (0.41,
// windows.software.remove@1): reading one HKLM uninstall key, and running the
// one removal internal/action decided on. The decisions — whether the key is
// the program the plan names, msiexec or the QuietUninstallString, what is
// never run — are in internal/action/remove.go; this file only reads the
// registry and starts the process, from exactly one exec site, with no shell.
//
// This has not run on a real Windows computer. The tests and the simulator
// exercise the decisions against a simulated registry (internal/winget/stub);
// the registry read and the process start below are compiled for Windows and
// checked statically only.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
)

type winPrograms struct{}

func viewFlag(view string) (uint32, error) {
	switch view {
	case "64":
		return registry.WOW64_64KEY, nil
	case "32":
		return registry.WOW64_32KEY, nil
	}
	return 0, errors.New("unknown registry view")
}

// Program reads HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\<key>
// in one view. Read-only.
func (winPrograms) Program(view, key string) (action.Program, bool, error) {
	if !action.ProgramKeyRE.MatchString(key) {
		return action.Program{}, false, errors.New("uninstall key outside the allowed form")
	}
	flag, err := viewFlag(view)
	if err != nil {
		return action.Program{}, false, err
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallRoot+`\`+key, registry.QUERY_VALUE|flag)
	if errors.Is(err, registry.ErrNotExist) {
		return action.Program{}, false, nil
	}
	if err != nil {
		return action.Program{}, false, err
	}
	defer k.Close()
	str := func(n string) string { v, _, _ := k.GetStringValue(n); return v }
	wi, _, _ := k.GetIntegerValue("WindowsInstaller")
	return action.Program{
		DisplayName: str("DisplayName"), DisplayVersion: str("DisplayVersion"),
		UninstallString: str("UninstallString"), QuietUninstallString: str("QuietUninstallString"),
		WindowsInstaller: wi == 1,
	}, true, nil
}

type cappedOut struct{ bytes.Buffer }

func (c *cappedOut) Write(p []byte) (int, error) {
	if room := 64<<10 - c.Len(); room > 0 {
		if len(p) > room {
			p = p[:room]
		}
		c.Buffer.Write(p)
	}
	return len(p), nil
}

type removeTimeout struct{}

func (removeTimeout) Error() string { return "the uninstaller did not finish in time" }
func (removeTimeout) Timeout() bool { return true }

// Remove runs System32\msiexec.exe /x CODE /qn /norestart, or the program a
// QuietUninstallString names with the arguments it registered, as one
// process with no shell (the command line goes to CreateProcess as it is).
func (winPrograms) Remove(c action.RemovalCommand, timeout time.Duration) (int, []byte, error) {
	var path string
	var args []string
	var cmdLine string
	switch c.Kind {
	case "msi":
		d, err := windows.GetSystemDirectory()
		if err != nil {
			return -1, nil, err
		}
		path, args = filepath.Join(d, "msiexec.exe"), action.MsiArgs(c.ProductCode)
	case "quiet":
		// Checked again here: internal/action parsed it; the file must be a
		// regular file reached through no reparse point.
		if _, err := action.ParseQuietUninstall(`"` + c.Exe + `"`); err != nil {
			return -1, nil, fmt.Errorf("refusing %s: %v", c.Exe, err)
		}
		st, err := os.Lstat(c.Exe)
		if err != nil || !st.Mode().IsRegular() || reparse(c.Exe) || reparse(filepath.Dir(c.Exe)) {
			return -1, nil, fmt.Errorf("%s is not a regular file", c.Exe)
		}
		path, cmdLine = c.Exe, strings.TrimSpace(`"`+c.Exe+`" `+c.Args)
	default:
		return -1, nil, errors.New("unknown removal")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	if cmdLine != "" {
		cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: cmdLine}
	}
	var out cappedOut
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return -1, out.Bytes(), removeTimeout{}
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), out.Bytes(), nil
	}
	if err != nil {
		return -1, out.Bytes(), err
	}
	return 0, out.Bytes(), nil
}
