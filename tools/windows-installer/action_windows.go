//go:build windows

package main

// `rem0te-agent.exe action --job <id> --envelope <file>` (v0.26), run by the
// SYSTEM heartbeat for each envelope the portal delivers. Everything that
// decides whether the action runs is in internal/action; this file is only
// the Windows calls it makes and the place the approval keys come from.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

const maxEnvelopeBytes = 64 << 10

// maxScriptFileBytes: a 64 KiB script, base64 (v0.34).
const maxScriptFileBytes = 100000

func cmdAction(args []string) int {
	fs := flag.NewFlagSet("action", flag.ContinueOnError)
	job := fs.String("job", "", "job id (32 hex)")
	envPath := fs.String("envelope", "", "envelope file")
	scriptPath := fs.String("script", "", "script content, base64 (windows.script.run only)")
	if err := fs.Parse(args); err != nil || *job == "" || *envPath == "" {
		fmt.Fprintln(os.Stderr, "usage: rem0te-agent.exe action --job <id> --envelope <file> [--script <file>]")
		return 2
	}
	if !trust.HasRoot(embeddedRoot) {
		fmt.Fprintln(os.Stderr, "This build carries no update-signing root; it cannot verify approval keys.")
		return 3
	}
	paths := defaultPaths()
	logf := openLog(paths)
	defer logf.Close()
	out := io.MultiWriter(os.Stderr, logf)

	raw, err := readSmall(*envPath, maxEnvelopeBytes)
	// The heartbeat starts this detached and cannot clean up after it: the
	// envelope is in memory now, so its file goes — but only from the inbox.
	if filepath.Dir(filepath.Clean(*envPath)) == filepath.Join(paths.StateDir, "actions", "inbox") {
		_ = os.Remove(*envPath)
	}
	if err != nil {
		fmt.Fprintf(out, "  action %s: envelope unreadable: %v\n", *job, err)
		return 4
	}
	// v0.34: a script run's content, delivered beside the envelope. Data
	// only: internal/action refuses it unless it hashes to the signed SHA-256.
	var script []byte
	if *scriptPath != "" {
		raw, err := readSmall(*scriptPath, maxScriptFileBytes)
		if filepath.Dir(filepath.Clean(*scriptPath)) == filepath.Join(paths.StateDir, "actions", "inbox") {
			_ = os.Remove(*scriptPath)
		}
		if err == nil {
			script, err = base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		}
		if err != nil {
			script = nil
			fmt.Fprintf(out, "  action %s: script unreadable: %v\n", *job, err)
		}
	}
	wp := &winPlatform{paths: paths, log: logf}
	// Keys first, and from the signed chain only. If they cannot be had the
	// job is not consumed: nothing is journaled or reported, the portal marks
	// it uncertain after its timeout and re-delivers, and this tries again.
	keys, pause, err := agent.ActionTrust(agent.Options{PortalHost: pinnedPortal(), Root: embeddedRoot, Paths: paths}, wp)
	if err != nil {
		fmt.Fprintf(out, "  action %s: approval keys unavailable: %v\n", *job, err)
		return 4
	}
	wa := &winActions{paths: paths}
	o := action.Options{StateDir: paths.StateDir, Keys: keys, Platform: wa, Now: time.Now,
		WUA: winWUA{paths: paths}, Registry: winRegistry{}, Pause: pause, Maint: wa, ScriptContent: script}
	// Windows PowerShell 5.1 from System32, by absolute path (v0.34).
	if d, err := windows.GetSystemDirectory(); err == nil {
		o.Scripts = action.ExecHost{PowerShell: filepath.Join(d, "WindowsPowerShell", "v1.0", "powershell.exe")}
	}
	r, err := action.Run(*job, raw, o)
	if err != nil {
		fmt.Fprintf(out, "  action %s: %v\n", *job, err)
		return 5
	}
	fmt.Fprintf(out, "  action %s: %s %s %v\n", *job, r.Outcome, r.Reason, r.Observed)
	return 0
}

func readSmall(p string, max int64) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errors.New("too large")
	}
	// Windows PowerShell 5 writes a BOM with -Encoding UTF8.
	return bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), nil
}

type winActions struct{ paths agent.Paths }

func (w *winActions) ServiceState(name string) (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return "", err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return "", err
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return "", err
	}
	switch st.State {
	case svc.Running:
		return "running", nil
	case svc.Stopped:
		return "stopped", nil
	case svc.StartPending:
		return "start_pending", nil
	case svc.StopPending:
		return "stop_pending", nil
	case svc.Paused:
		return "paused", nil
	default:
		return fmt.Sprintf("state_%d", st.State), nil
	}
}

// StartService starts the service and nothing else: the startup type is not
// touched, so a Disabled spooler stays disabled and the start fails.
func (w *winActions) StartService(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return err
	}
	return nil
}

// ProductType from the registry: WinNT = workstation (1), LanmanNT = domain
// controller (2), ServerNT = server (3). Unknown counts as a server, so an
// unreadable value can only raise the approvals a plan needs.
func (w *winActions) ProductType() (int, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\ProductOptions`, registry.QUERY_VALUE)
	if err != nil {
		return 3, nil
	}
	defer k.Close()
	v, _, err := k.GetStringValue("ProductType")
	if err != nil {
		return 3, nil
	}
	switch strings.ToLower(v) {
	case "winnt":
		return 1, nil
	case "lanmannt":
		return 2, nil
	default:
		return 3, nil
	}
}

var ridRE = regexp.MustCompile(`([0-9]{6,15})`)

// DeviceIdentity: the RustDesk ID as the heartbeat reads it, and the sha256
// of the device secret in heartbeat.dat — the same two things the portal
// pinned this computer's enrolment to.
func (w *winActions) DeviceIdentity() (string, string, error) {
	raw, err := os.ReadFile(filepath.Join(w.paths.StateDir, "heartbeat.dat"))
	if err != nil {
		return "", "", err
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	var st struct {
		AgentSecret string `json:"agentSecret"`
	}
	if err := json.Unmarshal(raw, &st); err != nil || st.AgentSecret == "" {
		return "", "", errors.New("heartbeat.dat carries no device secret")
	}
	exe := filepath.Join(os.Getenv("ProgramFiles"), "RustDesk", "rustdesk.exe")
	outb, err := exec.Command(exe, "--get-id").Output()
	if err != nil {
		return "", "", fmt.Errorf("rustdesk --get-id: %w", err)
	}
	m := ridRE.FindStringSubmatch(string(outb))
	if m == nil {
		return "", "", errors.New("rustdesk reported no ID")
	}
	return m[1], action.SecretSHA256(st.AgentSecret), nil
}

func (w *winActions) SelfSHA256() (string, error) {
	p, err := (&winPlatform{paths: w.paths}).SelfPath()
	if err != nil {
		return "", err
	}
	return agent.FileSHA256(p)
}

func (w *winActions) Sleep(d time.Duration) { time.Sleep(d) }

// ── Maintenance actions (v0.32) ────────────────────────────────────────────
// One fixed operation per method. Nothing here takes a command line from a
// plan: shutdown.exe and wevtutil.exe are run by absolute path, without a
// shell, with argument lists built from values internal/action has checked.

// StopService asks the service manager to stop the service, then waits for
// it to report stopped. A service with running dependents is refused by
// Windows (ERROR_DEPENDENT_SERVICES_RUNNING) and that error is returned as
// is: nothing else is ever stopped to make room.
func (w *winActions) StopService(name string, timeout time.Duration) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return err
	}
	defer s.Close()
	st, err := s.Control(svc.Stop)
	if err != nil {
		if !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return err
		}
		return nil
	}
	deadline := time.Now().Add(timeout)
	for st.State != svc.Stopped {
		if time.Now().After(deadline) {
			return fmt.Errorf("the service did not stop within %s", timeout)
		}
		time.Sleep(500 * time.Millisecond)
		if st, err = s.Query(); err != nil {
			return err
		}
	}
	return nil
}

func runSystem32(timeout time.Duration, exe string, args ...string) ([]byte, int, error) {
	d, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, -1, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, filepath.Join(d, exe), args...).CombinedOutput()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out, ee.ExitCode(), err
	}
	if err != nil {
		return out, -1, err
	}
	return out, 0, nil
}

// ScheduleRestart: shutdown.exe /r /t N /d p:4:1 /c MESSAGE. With /t above 0
// Windows implies /f, so programs still open at the deadline are closed —
// which is what the fixed message tells the person at the computer.
func (w *winActions) ScheduleRestart(seconds int, message string) error {
	if seconds < action.MinRestartDelayMinutes*60 || seconds > action.MaxRestartDelayMinutes*60 || len(message) > 500 || strings.ContainsAny(message, "\"\r\n") {
		return errors.New("refusing an out-of-range restart")
	}
	out, code, err := runSystem32(30*time.Second, "shutdown.exe", "/r", "/t", strconv.Itoa(seconds), "/d", "p:4:1", "/c", message)
	switch {
	case code == int(windows.ERROR_SHUTDOWN_IS_SCHEDULED):
		return action.ErrRestartScheduled
	case err != nil:
		return fmt.Errorf("shutdown.exe exit %d: %s", code, strings.TrimSpace(string(out)))
	}
	return nil
}

// CancelRestart: shutdown.exe /a.
func (w *winActions) CancelRestart() error {
	out, code, err := runSystem32(30*time.Second, "shutdown.exe", "/a")
	switch {
	case code == int(windows.ERROR_NO_SHUTDOWN_IN_PROGRESS):
		return action.ErrNoRestartScheduled
	case err != nil:
		return fmt.Errorf("shutdown.exe exit %d: %s", code, strings.TrimSpace(string(out)))
	}
	return nil
}

// RemoteSessions counts 'rustdesk.exe --cm' processes: RustDesk starts one
// connection manager per incoming session and none otherwise. It is the
// signal heartbeat.ps1 reports as rustdeskSessions. A rustdesk.exe whose
// command line cannot be read is an error, never "no session".
func (w *winActions) RemoteSessions() (int, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	n := 0
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if !strings.EqualFold(windows.UTF16ToString(e.ExeFile[:]), "rustdesk.exe") {
			continue
		}
		cmd, cerr := commandLine(e.ProcessID)
		if cerr != nil {
			return 0, fmt.Errorf("rustdesk.exe pid %d: %w", e.ProcessID, cerr)
		}
		if strings.Contains(cmd, "--cm") {
			n++
		}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return 0, err
	}
	return n, nil
}

func commandLine(pid uint32) (string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]byte, 64<<10)
	var ret uint32
	if err := windows.NtQueryInformationProcess(h, windows.ProcessCommandLineInformation, unsafe.Pointer(&buf[0]), uint32(len(buf)), &ret); err != nil {
		return "", err
	}
	return (*windows.NTUnicodeString)(unsafe.Pointer(&buf[0])).String(), nil
}

// Events: wevtutil.exe qe <System|Application> for Critical (1) and Error
// (2) events newer than since, newest first, at most max, as text.
func (w *winActions) Events(log string, since time.Duration, max int) ([]byte, error) {
	if log != "System" && log != "Application" {
		return nil, errors.New("not a collected log")
	}
	q := fmt.Sprintf("/q:*[System[(Level=1 or Level=2) and TimeCreated[timediff(@SystemTime) <= %d]]]", since.Milliseconds())
	out, code, err := runSystem32(60*time.Second, "wevtutil.exe", "qe", log, q, "/c:"+strconv.Itoa(max), "/rd:true", "/f:text")
	if err != nil {
		return nil, fmt.Errorf("wevtutil exit %d", code)
	}
	return out, nil
}

// RustdeskLogDirs: where the RustDesk service writes its logs (the same
// three the installer's diagnostics read). Service profiles only — a
// person's own profile is never read.
func (w *winActions) RustdeskLogDirs() []string {
	win := os.Getenv("SystemRoot")
	if win == "" {
		win = `C:\Windows`
	}
	return []string{
		filepath.Join(win, `System32\config\systemprofile\AppData\Roaming\RustDesk\log`),
		filepath.Join(win, `ServiceProfiles\LocalService\AppData\Roaming\RustDesk\log`),
		filepath.Join(win, `ServiceProfiles\NetworkService\AppData\Roaming\RustDesk\log`),
	}
}
