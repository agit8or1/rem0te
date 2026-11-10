//go:build windows

package main

// `rem0te-agent.exe action --job <id> --envelope <file>` (v0.26), run by the
// SYSTEM heartbeat for each envelope the portal delivers. Everything that
// decides whether the action runs is in internal/action; this file is only
// the Windows calls it makes and the place the approval keys come from.

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

const maxEnvelopeBytes = 64 << 10

func cmdAction(args []string) int {
	fs := flag.NewFlagSet("action", flag.ContinueOnError)
	job := fs.String("job", "", "job id (32 hex)")
	envPath := fs.String("envelope", "", "envelope file")
	if err := fs.Parse(args); err != nil || *job == "" || *envPath == "" {
		fmt.Fprintln(os.Stderr, "usage: rem0te-agent.exe action --job <id> --envelope <file>")
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
	wp := &winPlatform{paths: paths, log: logf}
	// Keys first, and from the signed chain only. If they cannot be had the
	// job is not consumed: nothing is journaled or reported, the portal marks
	// it uncertain after its timeout and re-delivers, and this tries again.
	keys, err := agent.ApprovalKeys(agent.Options{PortalHost: pinnedPortal(), Root: embeddedRoot, Paths: paths}, wp)
	if err != nil {
		fmt.Fprintf(out, "  action %s: approval keys unavailable: %v\n", *job, err)
		return 4
	}
	r, err := action.Run(*job, raw, action.Options{StateDir: paths.StateDir, Keys: keys, Platform: &winActions{paths: paths}, Now: time.Now,
		WUA: winWUA{paths: paths}, Registry: winRegistry{}})
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
