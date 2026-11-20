//go:build windows

package main

// `rem0te-agent.exe msa-poller` (0.72.0): the Managed Secure Access grant
// poller, started detached by the signed heartbeat ONLY when the portal
// answered msaPoll: true — the server runs with MSA_GRANTS=on AND a Platform
// Admin moved this one computer into Managed Secure Access. On a Legacy
// computer the heartbeat never starts it, and if started anyway it asks the
// portal once, is told the computer is not managed (or 404), and exits
// without touching RustDesk.
//
// One instance (msa\poller.lock). The decisions are internal/msa/enforce's;
// this file is the wiring and the ENFORCEMENT exec site, enforceRunner.Run:
// the installed rustdesk.exe by its absolute path, an argument array that
// enforce.Valid accepts (a closed read, set, restore, password or
// stop-service toggle), no shell, no window, output capped. Its arguments
// are never logged: one of them can be a password.
//
// Files under StateDir\msa\enforce, whose DACL names SYSTEM only: the
// settings RustDesk had before the first apply (saved.json), the replay set
// (grants-seen.json) and the poller's state (enforce.json).

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/msa/enforce"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

// enforceSDDL: SYSTEM only, inherited, nothing from the parent. Not even
// Administrators read the settings RustDesk had before (they include no
// secret, but they are what a rollback trusts).
const enforceSDDL = "D:P(A;OICI;FA;;;SY)"

func enforceDir(p agent.Paths) string { return filepath.Join(msaDir(p), "enforce") }

// enforceRunner is the enforcement's one exec site.
type enforceRunner struct{ exe string }

func (r enforceRunner) Run(ctx context.Context, args []string) enforce.Result {
	if !enforce.Valid(args) {
		return enforce.Result{Err: errors.New("refused: not an enforcement command")}
	}
	if _, ok := regularFile(r.exe); !ok {
		return enforce.Result{Err: errors.New("rustdesk.exe is not installed")}
	}
	if _, expected := rustdeskService(r.exe); !expected {
		return enforce.Result{Err: errors.New("the RustDesk service does not run the installed rustdesk.exe")}
	}
	cmd := exec.CommandContext(ctx, r.exe, args...)
	cmd.Dir = filepath.Dir(r.exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out := &capBuf{}
	cmd.Stdout = out
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	res := enforce.Result{Stdout: out.Bytes()}
	if ctx.Err() != nil {
		res.TimedOut = true
	}
	if out.over {
		res.Err = errors.New("output over the cap")
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		res.ExitCode = ee.ExitCode()
	} else if err != nil {
		res.Err = err
	}
	return res
}

// ── the portal ──────────────────────────────────────────────────────────────

type msaPortal struct {
	base, rid, secret string
	hc                *http.Client
}

func (m *msaPortal) post(ctx context.Context, path string, body map[string]any, hold time.Duration) ([]byte, int, error) {
	body["rustdeskId"], body["agentSecret"] = m.rid, m.secret
	b, _ := json.Marshal(body)
	c, cancel := context.WithTimeout(ctx, hold+30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(c, http.MethodPost, m.base+path, bytes.NewReader(b))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.hc.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	return raw, resp.StatusCode, err
}

func (m *msaPortal) Poll(ctx context.Context, ack []string, wait bool) (enforce.PollAnswer, error) {
	body := map[string]any{"wait": wait}
	if len(ack) > 0 {
		body["ack"] = ack
	}
	raw, code, err := m.post(ctx, "/msa/agent/poll", body, 25*time.Second)
	if err != nil {
		return enforce.PollAnswer{}, err
	}
	switch {
	case code == http.StatusNotFound || code == http.StatusForbidden || code == http.StatusUnauthorized:
		return enforce.PollAnswer{}, enforce.ErrStop
	case code != http.StatusOK:
		return enforce.PollAnswer{}, fmt.Errorf("poll: HTTP %d", code)
	}
	var env struct {
		Data enforce.PollAnswer `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return enforce.PollAnswer{}, err
	}
	return env.Data, nil
}

func (m *msaPortal) Report(ctx context.Context, r enforce.Report) error {
	body := map[string]any{"event": r.Event}
	if r.GrantID != "" {
		body["grantId"] = r.GrantID
	}
	if r.Outcome != "" {
		body["outcome"] = r.Outcome
	}
	if len(r.Keys) > 0 {
		body["keys"] = r.Keys
	}
	_, code, err := m.post(ctx, "/msa/agent/report", body, 0)
	if err == nil && code != http.StatusOK {
		err = fmt.Errorf("report: HTTP %d", code)
	}
	return err
}

// ── the computer ────────────────────────────────────────────────────────────

type msaHost struct {
	paths agent.Paths
	wp    *winPlatform
	wa    *winActions
	rid   string
}

func (h *msaHost) RustdeskID(context.Context) (string, error) {
	// Read again: a RustDesk that changed its ID since the poller started
	// must not receive a grant made for the old one.
	rid, _, err := chatIdentity(h.paths)
	if err != nil {
		return "", err
	}
	return rid, nil
}

func (h *msaHost) Sessions() (int, error) { return h.wa.RemoteSessions() }

func (h *msaHost) Trust(context.Context) (map[string]ed25519.PublicKey, func(string, string) bool, error) {
	keys, pz, err := agent.MsaTrust(agent.Options{PortalHost: pinnedPortal(), Root: embeddedRoot, Paths: h.paths}, h.wp)
	if err != nil {
		return nil, nil, err
	}
	// The signed pause has no `remote` scope; its actions scope (and an
	// unreadable listed pause, which covers everything) stops grants too.
	return keys, func(business, rid string) bool { return pz.ActionsPaused(business, rid) }, nil
}

// ── the files ───────────────────────────────────────────────────────────────

type msaStore struct{ dir string }

func (s msaStore) read(name string, v any) (bool, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if len(raw) > 64<<10 {
		return false, errors.New(name + ": too large")
	}
	return true, json.Unmarshal(raw, v)
}

func (s msaStore) write(name string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.dir, name), b)
}

func (s msaStore) LoadState() (*enforce.State, error) {
	var st enforce.State
	ok, err := s.read("enforce.json", &st)
	if !ok || err != nil {
		return nil, err
	}
	return &st, nil
}
func (s msaStore) SaveState(st *enforce.State) error { return s.write("enforce.json", st) }
func (s msaStore) LoadSaved() (*enforce.Saved, error) {
	var sv enforce.Saved
	ok, err := s.read("saved.json", &sv)
	if !ok {
		return nil, err
	}
	if err != nil || sv.Schema != enforce.SavedSchema {
		return nil, errors.New("saved.json is not readable")
	}
	return &sv, nil
}
func (s msaStore) SaveSaved(sv *enforce.Saved) error { return s.write("saved.json", sv) }
func (s msaStore) DeleteSaved() error {
	err := os.Remove(filepath.Join(s.dir, "saved.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
func (s msaStore) LoadSeen() (map[string]time.Time, error) {
	m := map[string]time.Time{}
	_, err := s.read("grants-seen.json", &m)
	return m, err
}
func (s msaStore) SaveSeen(m map[string]time.Time) error { return s.write("grants-seen.json", m) }

// secureEnforceDir: msa\enforce with the SYSTEM-only DACL, refusing a reparse point.
func secureEnforceDir(p agent.Paths, wp *winPlatform) (string, error) {
	if err := wp.SecureDir(msaDir(p)); err != nil {
		return "", err
	}
	dir := enforceDir(p)
	if err := wp.SecureDir(dir); err != nil { // creates it, refuses a reparse point
		return "", err
	}
	sd, err := windows.SecurityDescriptorFromString(enforceSDDL)
	if err != nil {
		return "", err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return "", err
	}
	return dir, windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// cmdMsaPoller: the subcommand. It takes no arguments.
func cmdMsaPoller(args []string) int {
	paths := defaultPaths()
	logf := openLog(paths)
	defer logf.Close()
	if len(args) > 0 {
		fmt.Fprintln(logf, "  msa-poller: takes no arguments")
		return 2
	}
	if !trust.HasRoot(embeddedRoot) {
		fmt.Fprintln(logf, "  msa-poller: this build carries no update-signing root; it cannot verify grant keys")
		return 3
	}
	wp := &winPlatform{paths: paths, log: logf}
	dir, err := secureEnforceDir(paths, wp)
	if err != nil {
		fmt.Fprintf(logf, "  msa-poller: %v\n", err)
		return 4
	}
	l, err := flock.TryLock(filepath.Join(msaDir(paths), "poller.lock"))
	if errors.Is(err, flock.ErrBusy) {
		return 0
	}
	if err != nil {
		fmt.Fprintf(logf, "  msa-poller: %v\n", err)
		return 4
	}
	defer l.Release()

	portal := pinnedPortal()
	if !agent.ValidPortal(portal) {
		fmt.Fprintln(logf, "  msa-poller: no pinned portal")
		return 4
	}
	rid, secret, err := chatIdentity(paths)
	if err != nil {
		fmt.Fprintf(logf, "  msa-poller: %v\n", err)
		return 4
	}
	o := agent.Options{PortalHost: portal, Root: embeddedRoot, Paths: paths}
	p := &enforce.Poller{
		E: &enforce.Enforcer{R: enforceRunner{exe: installedRustdeskExe()}},
		P: &msaPortal{base: o.APIBase(), rid: rid, secret: secret, hc: &http.Client{}},
		H: &msaHost{paths: paths, wp: wp, wa: &winActions{paths: paths}, rid: rid},
		S: msaStore{dir: dir},
		Logf: func(f string, a ...any) {
			fmt.Fprintf(logf, "  "+f+"\n", a...)
		},
	}
	if err := p.Run(context.Background()); err != nil {
		fmt.Fprintf(logf, "  msa-poller: %v\n", err)
		return 1
	}
	return 0
}
