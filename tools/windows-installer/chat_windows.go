//go:build windows

package main

// `rem0te-agent.exe chat` (0.34): the chat host. The SYSTEM heartbeat starts
// it, detached, when its response says a chat is open on this computer. It
// polls the portal with the device secret while the chat lasts, and shows
// the conversation in a window it starts in the signed-in user's session:
//
//	WTSGetActiveConsoleSessionId → WTSQueryUserToken (the user's own,
//	unelevated token) → two named pipes ACL'd to that user's SID and SYSTEM,
//	first instance only, local only → CreateProcessAsUser of this same
//	installed binary as `chat-window` on winsta0\default → the window's
//	process id must be the one that connects to both pipes, and its first
//	frame must carry the nonce from its command line.
//
// The window holds no device secret and never talks to the network. Every
// decision about what either side may say is in internal/chat; this file is
// only the Windows calls.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/chat"
	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

func cmdChat(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, "usage: rem0te-agent.exe chat")
		return 2
	}
	if !trust.HasRoot(embeddedRoot) {
		fmt.Fprintln(os.Stderr, "This build carries no update-signing root; chat runs only from an official release build.")
		return 3
	}
	paths := defaultPaths()
	logf := openLog(paths)
	defer logf.Close()
	say := func(f string, a ...any) { fmt.Fprintf(logf, "  "+f+"\n", a...) }

	wp := &winPlatform{paths: paths, log: logf}
	dir := filepath.Join(paths.StateDir, "chat")
	if err := wp.SecureDir(dir); err != nil {
		say("chat: state directory: %v", err)
		return 4
	}
	// One host per computer: the heartbeat starts one on every beat while a
	// chat is open, and every one after the first leaves at once.
	lock, err := flock.TryLock(filepath.Join(dir, "host.lock"))
	if errors.Is(err, flock.ErrBusy) {
		return 0
	}
	if err != nil {
		say("chat: lock: %v", err)
		return 4
	}
	defer lock.Release()

	rid, secret, err := chatIdentity(paths)
	if err != nil {
		say("chat: %v", err)
		return 4
	}
	portal := pinnedPortal()
	if !agent.ValidPortal(portal) {
		say("chat: no pinned portal")
		return 4
	}
	h := &chat.Host{
		API:  &chat.Client{Base: "https://" + portal + "/api/v1", RustdeskID: rid, Secret: secret},
		Desk: &winDesktop{exe: paths.AgentExe(), dir: paths.InstallDir, logf: say},
		Logf: say,
	}
	out, err := h.Run(context.Background())
	if err != nil {
		say("chat: %s: %v", out, err)
		return 5
	}
	say("chat: %s", out)
	return 0
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

// ── The desktop ──────────────────────────────────────────────────────────────

type winDesktop struct {
	exe, dir string
	logf     func(string, ...any)
}

const noSession = 0xFFFFFFFF

// ActiveUser: the console session's user; failing that, the one active
// remote desktop session if there is exactly one. Several active sessions
// and no console user is "nobody" rather than a guess at whom to show it to.
func (d *winDesktop) ActiveUser() (chat.Session, error) {
	if id := windows.WTSGetActiveConsoleSessionId(); id != noSession {
		if s, err := sessionUser(id); err == nil {
			return s, nil
		} else if !errors.Is(err, chat.ErrNoUser) {
			return chat.Session{}, err
		}
	}
	var info *windows.WTS_SESSION_INFO
	var n uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &info, &n); err != nil {
		return chat.Session{}, chat.ErrNoUser
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(info)))
	var found []chat.Session
	for _, si := range unsafe.Slice(info, n) {
		if si.State != windows.WTSActive || si.SessionID == 0 {
			continue
		}
		if s, err := sessionUser(si.SessionID); err == nil {
			found = append(found, s)
		}
	}
	if len(found) == 1 {
		return found[0], nil
	}
	return chat.Session{}, chat.ErrNoUser
}

func sessionUser(id uint32) (chat.Session, error) {
	var tok windows.Token
	if err := windows.WTSQueryUserToken(id, &tok); err != nil {
		if errors.Is(err, windows.ERROR_NO_TOKEN) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return chat.Session{}, chat.ErrNoUser
		}
		return chat.Session{}, fmt.Errorf("WTSQueryUserToken: %w", err)
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return chat.Session{}, err
	}
	acct, dom, _, err := u.User.Sid.LookupAccount("")
	if err != nil {
		return chat.Session{ID: id, User: u.User.Sid.String()}, nil
	}
	return chat.Session{ID: id, User: dom + `\` + acct}, nil
}

func (d *winDesktop) Open(ctx context.Context, s chat.Session) (chat.Window, error) {
	var tok windows.Token
	if err := windows.WTSQueryUserToken(s.ID, &tok); err != nil {
		return nil, fmt.Errorf("WTSQueryUserToken: %w", err)
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return nil, err
	}
	sddl, err := chat.PipeSDDL(u.User.Sid.String())
	if err != nil {
		return nil, err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, err
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	downName, upName := chat.PipeNames()
	mode := uint32(windows.PIPE_TYPE_BYTE | windows.PIPE_READMODE_BYTE | windows.PIPE_WAIT | windows.PIPE_REJECT_REMOTE_CLIENTS)
	mk := func(name string, access uint32) (windows.Handle, error) {
		return windows.CreateNamedPipe(windows.StringToUTF16Ptr(name), access|windows.FILE_FLAG_FIRST_PIPE_INSTANCE, mode, 1, 64<<10, 64<<10, 0, sa)
	}
	hDown, err := mk(downName, windows.PIPE_ACCESS_OUTBOUND)
	if err != nil {
		return nil, fmt.Errorf("pipe: %w", err)
	}
	hUp, err := mk(upName, windows.PIPE_ACCESS_INBOUND)
	if err != nil {
		windows.CloseHandle(hDown)
		return nil, fmt.Errorf("pipe: %w", err)
	}
	closePipes := func() { windows.CloseHandle(hDown); windows.CloseHandle(hUp) }

	if _, err := os.Stat(d.exe); err != nil {
		closePipes()
		return nil, fmt.Errorf("the installed agent is missing: %w", err)
	}
	nonce := chat.NewNonce()
	cmd := windows.ComposeCommandLine([]string{d.exe, "chat-window", "--down", downName, "--up", upName, "--nonce", nonce})
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, tok, false); err != nil {
		closePipes()
		return nil, fmt.Errorf("environment: %w", err)
	}
	defer windows.DestroyEnvironmentBlock(env)
	si := &windows.StartupInfo{Desktop: windows.StringToUTF16Ptr(`winsta0\default`)}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi windows.ProcessInformation
	err = windows.CreateProcessAsUser(tok, windows.StringToUTF16Ptr(d.exe), windows.StringToUTF16Ptr(cmd), nil, nil, false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW, env, windows.StringToUTF16Ptr(d.dir), si, &pi)
	if err != nil {
		closePipes()
		return nil, fmt.Errorf("CreateProcessAsUser: %w", err)
	}
	windows.CloseHandle(pi.Thread)
	kill := func() { _ = windows.TerminateProcess(pi.Process, 1); windows.CloseHandle(pi.Process) }

	// Both pipes must be connected by the process just started, within 30 s.
	connected := make(chan error, 2)
	for _, h := range []windows.Handle{hDown, hUp} {
		go func(h windows.Handle) {
			err := windows.ConnectNamedPipe(h, nil)
			if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
				err = nil
			}
			if err == nil {
				var pid uint32
				if err = windows.GetNamedPipeClientProcessId(h, &pid); err == nil && pid != pi.ProcessId {
					err = fmt.Errorf("pipe client is process %d, not the window (%d)", pid, pi.ProcessId)
				}
			}
			connected <- err
		}(h)
	}
	timeout := time.NewTimer(30 * time.Second)
	defer timeout.Stop()
	for i := 0; i < 2; i++ {
		select {
		case err := <-connected:
			if err != nil {
				closePipes()
				kill()
				return nil, err
			}
		case <-timeout.C:
			closePipes() // unblocks ConnectNamedPipe
			kill()
			return nil, errors.New("the chat window did not connect within 30 seconds")
		case <-ctx.Done():
			closePipes()
			kill()
			return nil, ctx.Err()
		}
	}
	down := os.NewFile(uintptr(hDown), downName)
	up := os.NewFile(uintptr(hUp), upName)
	// Closing the pipes is how the host lets go: the window then says it was
	// disconnected and stays until the person closes it. It is killed only
	// when the handshake fails.
	w, err := chat.Attach(up, down, func() error { down.Close(); up.Close(); return nil }, nonce, 30*time.Second, d.logf)
	if err != nil {
		kill()
		return nil, err
	}
	windows.CloseHandle(pi.Process)
	return w, nil
}
