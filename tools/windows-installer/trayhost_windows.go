//go:build windows

package main

// `rem0te-agent.exe tray-host` (0.36): the signed agent's SYSTEM tray host.
// It replaces the 0.34 chat host and chat window. The heartbeat starts it on
// every beat; a lock makes every start after the first leave at once.
//
// For each active session with a signed-in user it starts the tray there:
//
//	WTSQueryUserToken (the user's own, unelevated token) → two named pipes
//	ACL'd to that user's SID and SYSTEM, first instance only, local only →
//	the installed tray, checked against the sha256 the signed install
//	recorded → CreateProcessAsUser on winsta0\default → the tray's process id
//	must be the one that connects to both pipes, and its first frame must
//	carry the nonce from its command line.
//
// It then speaks for that tray (internal/tray Serve): the device secret
// stays in this process, the user is the one the token names, and the
// self-help tools run here, as SYSTEM, from the closed catalog.

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
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

// hostLifetime: the host leaves after this long (or as soon as its own
// binary is replaced) and the next heartbeat starts the current one.
const hostLifetime = 12 * time.Hour

func cmdTrayHost(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, "usage: rem0te-agent.exe tray-host")
		return 2
	}
	if !trust.HasRoot(embeddedRoot) {
		fmt.Fprintln(os.Stderr, "This build carries no update-signing root; the tray host runs only from an official release build.")
		return 3
	}
	paths := defaultPaths()
	logf := openLog(paths)
	defer logf.Close()
	var lmu sync.Mutex
	say := func(f string, a ...any) {
		lmu.Lock()
		defer lmu.Unlock()
		fmt.Fprintf(logf, "  "+f+"\n", a...)
	}

	wp := &winPlatform{paths: paths, log: logf}
	dir := filepath.Join(paths.StateDir, "trayhost")
	if err := wp.SecureDir(dir); err != nil {
		say("tray-host: state directory: %v", err)
		return 4
	}
	lock, err := flock.TryLock(filepath.Join(dir, "host.lock"))
	if errors.Is(err, flock.ErrBusy) {
		return 0
	}
	if err != nil {
		say("tray-host: lock: %v", err)
		return 4
	}
	defer lock.Release()

	traySum := installedTraySHA(paths)
	if traySum == "" {
		say("tray-host: no signed tray is installed (agent-status.json names none); nothing to do")
		return 0
	}
	rid, secret, err := chatIdentity(paths)
	if err != nil {
		say("tray-host: %v", err)
		return 4
	}
	portal := pinnedPortal()
	if !agent.ValidPortal(portal) {
		say("tray-host: no pinned portal")
		return 4
	}
	wa := &winActions{paths: paths}
	core := &tray.Core{
		API:     &tray.Client{Base: "https://" + portal + "/api/v1", Cred: tray.Credential{RustdeskID: rid, Secret: secret}},
		Portal:  portal,
		Agent:   "signed",
		Version: agentVersion(paths),
		Run:     &tray.Runner{OS: &hostOS{wa: wa}, Portal: portal, Elevated: true},
		Sample:  tray.SampleUsage,
		Logf:    say,
		SignedPause: func(ctx context.Context, businessID string) (string, error) {
			_, pz, err := agent.ActionTrust(agent.Options{PortalHost: portal, Root: embeddedRoot, Paths: paths}, wp)
			if err != nil {
				return "", err
			}
			if pz.ActionsPaused(businessID, rid) {
				return tray.CleanLine(pz.Reason, 200), nil
			}
			return "", nil
		},
	}
	h := &trayHost{paths: paths, core: core, traySum: traySum, logf: say, sessions: map[uint32]*hostSession{}}
	return h.run()
}

// installedTraySHA is the hash the signed install recorded for the tray it
// placed. The host starts only a file with that hash.
func installedTraySHA(p agent.Paths) string {
	raw, err := os.ReadFile(p.StatusFile())
	if err != nil {
		return ""
	}
	var st agent.Status
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &st) != nil || len(st.TraySHA256) != 64 {
		return ""
	}
	return st.TraySHA256
}

// buildVersion may be set at link time (-X main.buildVersion=0.36.0). When
// it is not, About names the signed targets version this install verified.
var buildVersion string

// agentVersion is what About shows as this agent's version.
func agentVersion(p agent.Paths) string {
	if v := strings.TrimSpace(buildVersion); v != "" {
		return v
	}
	var st agent.Status
	if raw, err := os.ReadFile(p.StatusFile()); err == nil && json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &st) == nil && st.TargetsVersion > 0 {
		return fmt.Sprintf("signed release, targets v%d", st.TargetsVersion)
	}
	return "signed release"
}

// chatIdentity: the RustDesk ID as the heartbeat reads it, and the device
// secret from heartbeat.dat (SYSTEM and Administrators only). The secret
// stays in this process.
func chatIdentity(p agent.Paths) (string, string, error) {
	raw, err := os.ReadFile(filepath.Join(p.StateDir, "heartbeat.dat"))
	if err != nil {
		return "", "", err
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	var st struct {
		AgentSecret string `json:"agentSecret"`
	}
	if err := json.Unmarshal(raw, &st); err != nil || len(st.AgentSecret) < 16 {
		return "", "", errors.New("heartbeat.dat carries no device secret")
	}
	rd := filepath.Join(os.Getenv("ProgramFiles"), "RustDesk", "rustdesk.exe")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	outb, err := exec.CommandContext(ctx, rd, "--get-id").Output()
	if err != nil {
		return "", "", fmt.Errorf("rustdesk --get-id: %w", err)
	}
	m := ridRE.FindStringSubmatch(string(outb))
	if m == nil {
		return "", "", errors.New("rustdesk reported no ID")
	}
	return m[1], st.AgentSecret, nil
}

// ── The elevated self-help operations ───────────────────────────────────────

// hostOS is the read-only tray.WinOS plus the three operations only SYSTEM
// may do. Each is one fixed operation with fixed arguments.
type hostOS struct {
	tray.WinOS
	wa *winActions
}

func (o *hostOS) FlushDNS() (string, error) {
	out, code, err := tray.RunSystem32(context.Background(), 60*time.Second, "ipconfig.exe", "/flushdns")
	if err != nil || code != 0 {
		return string(out), fmt.Errorf("ipconfig /flushdns exit %d", code)
	}
	return string(out), nil
}

func (o *hostOS) RenewIP() (string, error) {
	out, code, err := tray.RunSystem32(context.Background(), 90*time.Second, "ipconfig.exe", "/renew")
	if err != nil || code != 0 {
		return string(out), fmt.Errorf("ipconfig /renew exit %d", code)
	}
	return string(out), nil
}

// RemoteSessions is the 0.32 count of RustDesk connection managers.
func (o *hostOS) RemoteSessions() (int, error) { return o.wa.RemoteSessions() }

// RestartRustDesk stops and starts the RustDesk service, nothing else.
func (o *hostOS) RestartRustDesk() error {
	if err := o.wa.StopService("RustDesk", 60*time.Second); err != nil {
		return fmt.Errorf("stop: %w", err)
	}
	if err := o.wa.StartService("RustDesk"); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	return nil
}

// ── Sessions ────────────────────────────────────────────────────────────────

type hostSession struct {
	sess     tray.Session
	kick     chan struct{}
	failures []time.Time
	running  bool
	next     time.Time
}

type trayHost struct {
	paths    agent.Paths
	core     *tray.Core
	traySum  string
	logf     func(string, ...any)
	mu       sync.Mutex
	sessions map[uint32]*hostSession
}

const noSession = 0xFFFFFFFF

func (h *trayHost) run() int {
	started := time.Now()
	self := h.paths.AgentExe()
	selfStat, _ := os.Stat(self)
	signal := filepath.Join(h.paths.StateDir, "tray", "signal.json")
	var sigMod time.Time
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	h.logf("tray-host: started")
	for {
		if time.Since(started) > hostLifetime {
			h.logf("tray-host: lifetime reached; the next heartbeat starts a fresh host")
			return 0
		}
		if st, err := os.Stat(self); err != nil || selfStat == nil || !st.ModTime().Equal(selfStat.ModTime()) || st.Size() != selfStat.Size() {
			h.logf("tray-host: the agent was replaced; leaving so the new one takes over")
			return 0
		}
		if st, err := os.Stat(signal); err == nil && !st.ModTime().Equal(sigMod) {
			sigMod = st.ModTime()
			h.kickAll()
		}
		h.reconcile()
		<-tick.C
	}
}

func (h *trayHost) kickAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.sessions {
		select {
		case s.kick <- struct{}{}:
		default:
		}
	}
}

// reconcile starts a tray in each active user session that has none, with
// a back-off for a tray that keeps failing.
func (h *trayHost) reconcile() {
	active := activeSessions()
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range active {
		hs := h.sessions[s.ID]
		if hs == nil || hs.sess.User != s.User {
			if hs != nil && hs.running {
				continue // a different user's tray is still winding down
			}
			hs = &hostSession{sess: s, kick: make(chan struct{}, 1)}
			h.sessions[s.ID] = hs
		}
		hs.sess.Console = s.Console
		if hs.running || time.Now().Before(hs.next) {
			continue
		}
		hs.running = true
		go h.serve(hs)
	}
}

func (h *trayHost) serve(hs *hostSession) {
	err := h.launchAndServe(hs)
	h.mu.Lock()
	defer h.mu.Unlock()
	hs.running = false
	now := time.Now()
	if err != nil {
		h.logf("tray-host: session %d (%s): %v", hs.sess.ID, hs.sess.User, err)
		keep := hs.failures[:0]
		for _, t := range hs.failures {
			if now.Sub(t) < 10*time.Minute {
				keep = append(keep, t)
			}
		}
		hs.failures = append(keep, now)
		if len(hs.failures) >= 5 {
			hs.next = now.Add(30 * time.Minute)
			h.logf("tray-host: session %d: five failures in ten minutes; waiting 30 minutes", hs.sess.ID)
			return
		}
	}
	hs.next = now.Add(30 * time.Second)
}

// activeSessions: every active session (console or remote desktop) with a
// signed-in user, and whether it is the console.
func activeSessions() []tray.Session {
	console := windows.WTSGetActiveConsoleSessionId()
	var info *windows.WTS_SESSION_INFO
	var n uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &info, &n); err != nil {
		return nil
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(info)))
	var out []tray.Session
	for _, si := range unsafe.Slice(info, n) {
		if si.State != windows.WTSActive || si.SessionID == 0 {
			continue
		}
		user, err := sessionUser(si.SessionID)
		if err != nil {
			continue
		}
		out = append(out, tray.Session{ID: si.SessionID, User: user, Console: console != noSession && si.SessionID == console})
	}
	return out
}

func sessionUser(id uint32) (string, error) {
	var tok windows.Token
	if err := windows.WTSQueryUserToken(id, &tok); err != nil {
		if errors.Is(err, windows.ERROR_NO_TOKEN) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return "", tray.ErrNoUser
		}
		return "", fmt.Errorf("WTSQueryUserToken: %w", err)
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", err
	}
	acct, dom, _, err := u.User.Sid.LookupAccount("")
	if err != nil {
		return u.User.Sid.String(), nil
	}
	return dom + `\` + acct, nil
}

// launchAndServe starts the tray in hs's session and serves it until it
// disconnects.
func (h *trayHost) launchAndServe(hs *hostSession) error {
	exe := h.paths.TrayExe()
	sum, err := agent.FileSHA256(exe)
	if err != nil {
		return fmt.Errorf("the tray is missing: %w", err)
	}
	if sum != h.traySum {
		return fmt.Errorf("refusing to start %s: sha256 %s is not the signed tray (%s)", exe, sum[:12], h.traySum[:12])
	}

	var tok windows.Token
	if err := windows.WTSQueryUserToken(hs.sess.ID, &tok); err != nil {
		return fmt.Errorf("WTSQueryUserToken: %w", err)
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return err
	}
	sddl, err := tray.PipeSDDL(u.User.Sid.String())
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	downName, upName := tray.PipeNames()
	mode := uint32(windows.PIPE_TYPE_BYTE | windows.PIPE_READMODE_BYTE | windows.PIPE_WAIT | windows.PIPE_REJECT_REMOTE_CLIENTS)
	mk := func(name string, access uint32) (windows.Handle, error) {
		return windows.CreateNamedPipe(windows.StringToUTF16Ptr(name), access|windows.FILE_FLAG_FIRST_PIPE_INSTANCE, mode, 1, 1<<20, 1<<20, 0, sa)
	}
	hDown, err := mk(downName, windows.PIPE_ACCESS_OUTBOUND)
	if err != nil {
		return fmt.Errorf("pipe: %w", err)
	}
	hUp, err := mk(upName, windows.PIPE_ACCESS_INBOUND)
	if err != nil {
		windows.CloseHandle(hDown)
		return fmt.Errorf("pipe: %w", err)
	}
	var closeOnce sync.Once
	closePipes := func() { closeOnce.Do(func() { windows.CloseHandle(hDown); windows.CloseHandle(hUp) }) }

	nonce := tray.NewNonce()
	cmd := windows.ComposeCommandLine([]string{exe, "--down", downName, "--up", upName, "--nonce", nonce})
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, tok, false); err != nil {
		closePipes()
		return fmt.Errorf("environment: %w", err)
	}
	defer windows.DestroyEnvironmentBlock(env)
	si := &windows.StartupInfo{Desktop: windows.StringToUTF16Ptr(`winsta0\default`)}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi windows.ProcessInformation
	err = windows.CreateProcessAsUser(tok, windows.StringToUTF16Ptr(exe), windows.StringToUTF16Ptr(cmd), nil, nil, false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW, env, windows.StringToUTF16Ptr(filepath.Dir(exe)), si, &pi)
	if err != nil {
		closePipes()
		return fmt.Errorf("CreateProcessAsUser: %w", err)
	}
	windows.CloseHandle(pi.Thread)
	defer windows.CloseHandle(pi.Process)
	kill := func() { _ = windows.TerminateProcess(pi.Process, 1) }

	// Both pipes must be connected by the process just started, within 30 s.
	connected := make(chan error, 2)
	for _, hp := range []windows.Handle{hDown, hUp} {
		go func(hp windows.Handle) {
			err := windows.ConnectNamedPipe(hp, nil)
			if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
				err = nil
			}
			if err == nil {
				var pid uint32
				if err = windows.GetNamedPipeClientProcessId(hp, &pid); err == nil && pid != pi.ProcessId {
					err = fmt.Errorf("pipe client is process %d, not the tray (%d)", pid, pi.ProcessId)
				}
			}
			connected <- err
		}(hp)
	}
	timeout := time.NewTimer(30 * time.Second)
	defer timeout.Stop()
	for i := 0; i < 2; i++ {
		select {
		case err := <-connected:
			if err != nil {
				closePipes()
				kill()
				return err
			}
		case <-timeout.C:
			closePipes() // unblocks ConnectNamedPipe
			kill()
			return errors.New("the tray did not connect within 30 seconds")
		}
	}
	down := os.NewFile(uintptr(hDown), downName)
	up := os.NewFile(uintptr(hUp), upName)
	defer func() { down.Close(); up.Close() }()
	r := tray.NewReader(up)
	hello := make(chan error, 1)
	go func() { hello <- tray.Attach(r, nonce) }()
	select {
	case err := <-hello:
		if err != nil {
			kill()
			return err
		}
	case <-time.After(30 * time.Second):
		kill()
		return errors.New("the tray sent no hello within 30 seconds")
	}
	h.logf("tray-host: tray started in session %d for %s", hs.sess.ID, hs.sess.User)
	err = tray.Serve(context.Background(), h.core, hs.sess, r, down, hs.kick)
	if err != nil {
		// A tray that sent something it may not is stopped, not left running.
		kill()
		return err
	}
	return nil
}
