//go:build windows

package main

// `rem0te-agent.exe rustdesk-preflight` (0.69.0): the read-only RustDesk
// preflight for Managed Secure Access, started detached by the signed
// heartbeat at most every 30 minutes and running for real at most every
// 6 hours, or when the installed rustdesk.exe changed (internal/msa
// ShouldRun). It writes msa\preflight.json, which the heartbeat sends as
// rustdeskPreflight until the portal acknowledges it.
//
// It only reads: the RustDesk service's configuration and status through the
// service manager with query rights only, the exe's version resource, two
// file names beside the exe, and — through preflightRunner.Read, the preflight's one
// exec site — `rustdesk.exe --option <key>` with no value, for the closed key
// list in internal/msa. The exe is always the INSTALLED one, by its absolute
// path, and only when the RustDesk service names that same file: the 0.68.3
// lab showed 1.4.7+ refuses a copy elsewhere, and a copy is never run here.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa"
)

// installedRustdeskExe is where the Rem0te installers put RustDesk:
// %ProgramFiles%\RustDesk\rustdesk.exe. The preflight runs nothing else.
func installedRustdeskExe() string {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "RustDesk", "rustdesk.exe")
}

func msaDir(p agent.Paths) string        { return filepath.Join(p.StateDir, "msa") }
func preflightFile(p agent.Paths) string { return filepath.Join(msaDir(p), "preflight.json") }
func preflightStateFile(p agent.Paths) string {
	return filepath.Join(msaDir(p), "preflight.state.json")
}
func preflightLockFile(p agent.Paths) string { return filepath.Join(msaDir(p), "preflight.lock") }

// regularFile: exists, is not a directory, and is not a reparse point.
func regularFile(p string) (os.FileInfo, bool) {
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	attrs, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(p))
	if err != nil || attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return nil, false
	}
	return fi, true
}

// fileVersion reads FileVersion from the exe's version resource (the first
// translation), without running anything.
func fileVersion(exe string) string {
	var zero windows.Handle
	n, err := windows.GetFileVersionInfoSize(exe, &zero)
	if err != nil || n == 0 || n > 1<<20 {
		return ""
	}
	buf := make([]byte, n)
	if err := windows.GetFileVersionInfo(exe, 0, n, unsafe.Pointer(&buf[0])); err != nil {
		return ""
	}
	var tp unsafe.Pointer
	var tl uint32
	if err := windows.VerQueryValue(unsafe.Pointer(&buf[0]), `\VarFileInfo\Translation`, unsafe.Pointer(&tp), &tl); err != nil || tl < 4 {
		return ""
	}
	tr := (*[2]uint16)(tp)
	sub := fmt.Sprintf(`\StringFileInfo\%04x%04x\FileVersion`, tr[0], tr[1])
	var vp unsafe.Pointer
	var vl uint32
	if err := windows.VerQueryValue(unsafe.Pointer(&buf[0]), sub, unsafe.Pointer(&vp), &vl); err != nil || vl == 0 || vl > 256 {
		return ""
	}
	return strings.TrimSpace(windows.UTF16ToString(unsafe.Slice((*uint16)(vp), vl)))
}

// imageExe takes the program out of a service image path: the quoted part,
// or everything before the first " --".
func imageExe(bin string) string {
	bin = strings.TrimSpace(bin)
	if strings.HasPrefix(bin, `"`) {
		if i := strings.Index(bin[1:], `"`); i >= 0 {
			return bin[1 : 1+i]
		}
		return strings.Trim(bin, `"`)
	}
	if i := strings.Index(bin, " --"); i >= 0 {
		return strings.TrimSpace(bin[:i])
	}
	return bin
}

// rustdeskService reads the RustDesk service with query rights only (the
// mgr package's OpenService asks for all access; this never does).
func rustdeskService(exe string) (state string, expected bool) {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return "other", false
	}
	defer windows.CloseServiceHandle(scm)
	h, err := windows.OpenService(scm, windows.StringToUTF16Ptr("RustDesk"), windows.SERVICE_QUERY_CONFIG|windows.SERVICE_QUERY_STATUS)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return "missing", false
	}
	if err != nil {
		return "other", false
	}
	s := &mgr.Service{Name: "RustDesk", Handle: h}
	defer s.Close()
	if c, err := s.Config(); err == nil {
		expected = strings.EqualFold(filepath.Clean(imageExe(c.BinaryPathName)), filepath.Clean(exe))
	}
	st, err := s.Query()
	switch {
	case err != nil:
		state = "other"
	case st.State == svc.Running:
		state = "running"
	case st.State == svc.Stopped:
		state = "stopped"
	default:
		state = "other"
	}
	return state, expected
}

type capBuf struct {
	bytes.Buffer
	over bool
}

func (c *capBuf) Write(p []byte) (int, error) {
	if room := msa.MaxReadBytes + 1 - c.Len(); room > 0 {
		if len(p) > room {
			c.Buffer.Write(p[:room])
			c.over = true
		} else {
			c.Buffer.Write(p)
		}
	} else if len(p) > 0 {
		c.over = true
	}
	return len(p), nil
}

// preflightRunner is the preflight's one exec site.
type preflightRunner struct{ exe string }

// Read runs the installed rustdesk.exe with exactly msa.ReadArgs(key): an
// argument array, no shell, no window, output capped.
func (r preflightRunner) Read(ctx context.Context, args []string) msa.ReadResult {
	if len(args) != 2 || args[0] != "--option" || msa.ReadArgs(args[1]) == nil {
		return msa.ReadResult{Err: errors.New("refused: not a preflight read")}
	}
	cmd := exec.CommandContext(ctx, r.exe, msa.ReadArgs(args[1])...)
	cmd.Dir = filepath.Dir(r.exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out := &capBuf{}
	cmd.Stdout = out
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	res := msa.ReadResult{Stdout: out.Bytes(), Truncated: out.over}
	if ctx.Err() != nil {
		res.TimedOut = true
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		res.ExitCode = ee.ExitCode()
	} else if err != nil {
		res.Err = err
	}
	return res
}

// preflightFacts reads everything but the option reads.
func preflightFacts(exe string) (msa.Facts, msa.Fingerprint) {
	var f msa.Facts
	var fp msa.Fingerprint
	fi, ok := regularFile(exe)
	f.Installed = ok
	if ok {
		f.Version = fileVersion(exe)
		fp = msa.Fingerprint{Version: f.Version, Size: fi.Size(), ModTime: fi.ModTime().UnixNano()}
		dir := filepath.Dir(exe)
		_, f.HasFlutter = regularFile(filepath.Join(dir, "flutter_windows.dll"))
		_, f.HasSciter = regularFile(filepath.Join(dir, "sciter.dll"))
	}
	f.Service, f.ExpectedPath = rustdeskService(exe)
	return f, fp
}

// runPreflight runs the preflight now against the installed RustDesk.
func runPreflight(ctx context.Context) (msa.Report, msa.Fingerprint) {
	exe := installedRustdeskExe()
	f, fp := preflightFacts(exe)
	return msa.Run(ctx, preflightRunner{exe: exe}, f, time.Now), fp
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// cmdRustdeskPreflight: the subcommand. Takes no arguments that name a path:
// it reads only the installed RustDesk and writes only under StateDir\msa.
func cmdRustdeskPreflight(args []string) int {
	paths := defaultPaths()
	logf := openLog(paths)
	defer logf.Close()
	force := len(args) == 1 && args[0] == "--force"
	if len(args) > 0 && !force {
		fmt.Fprintln(logf, "  rustdesk-preflight: usage: rustdesk-preflight [--force]")
		return 2
	}
	if err := (&winPlatform{paths: paths}).SecureDir(msaDir(paths)); err != nil {
		fmt.Fprintf(logf, "  rustdesk-preflight: %v\n", err)
		return 4
	}
	l, err := flock.TryLock(preflightLockFile(paths))
	if errors.Is(err, flock.ErrBusy) {
		fmt.Fprintln(logf, "  rustdesk-preflight: already running; skipped")
		return 0
	}
	if err != nil {
		fmt.Fprintf(logf, "  rustdesk-preflight: %v\n", err)
		return 4
	}
	defer l.Release()

	exe := installedRustdeskExe()
	_, fp := preflightFacts(exe)
	var prev *msa.State
	if raw, err := os.ReadFile(preflightStateFile(paths)); err == nil {
		var st msa.State
		if json.Unmarshal(raw, &st) == nil {
			prev = &st
		}
	}
	now := time.Now()
	if !force && !msa.ShouldRun(prev, now, fp) {
		return 0
	}
	rep, fp := runPreflight(context.Background())
	b, _ := json.Marshal(rep)
	if len(b) > 4096 {
		fmt.Fprintf(logf, "  rustdesk-preflight: report too large (%d bytes); not written\n", len(b))
		return 4
	}
	if err := writeAtomic(preflightFile(paths), b); err != nil {
		fmt.Fprintf(logf, "  rustdesk-preflight: %v\n", err)
		return 4
	}
	sb, _ := json.Marshal(msa.State{LastRunAt: now.UTC(), Fingerprint: fp})
	if err := writeAtomic(preflightStateFile(paths), sb); err != nil {
		fmt.Fprintf(logf, "  rustdesk-preflight: state: %v\n", err)
	}
	fmt.Fprintf(logf, "  rustdesk-preflight: installed %v, expected path %v, build %s, service %s, cli %s\n",
		rep.Installed, rep.ExpectedPath, rep.Build, rep.Service, rep.CLI)
	return 0
}
