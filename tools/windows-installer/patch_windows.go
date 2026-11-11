//go:build windows

package main

// Windows Update for the signed agent (v0.27): the registry reader that
// competing-manager and pending-restart detection use, the runner for the
// compiled-in wua.ps1, and `rem0te-agent.exe patch-scan`.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/devsig"
	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

type winRegistry struct{}

func (winRegistry) open(key string) (registry.Key, bool) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, key, registry.QUERY_VALUE)
	return k, err == nil
}
func (r winRegistry) String(key, name string) (string, bool) {
	k, ok := r.open(key)
	if !ok {
		return "", false
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	return v, err == nil
}
func (r winRegistry) DWord(key, name string) (uint32, bool) {
	k, ok := r.open(key)
	if !ok {
		return 0, false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue(name)
	return uint32(v), err == nil
}
func (r winRegistry) KeyExists(key string) bool {
	k, ok := r.open(key)
	if ok {
		k.Close()
	}
	return ok
}
func (r winRegistry) ValueExists(key, name string) bool {
	k, ok := r.open(key)
	if !ok {
		return false
	}
	defer k.Close()
	_, _, err := k.GetValue(name, nil)
	return err == nil || errors.Is(err, registry.ErrShortBuffer)
}
func (winRegistry) ServiceExists(name string) bool {
	m, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return false
	}
	s.Close()
	return true
}

// winWUA runs the compiled-in script. It writes the script, its input and
// its output inside the agent's own state directory (SYSTEM and
// Administrators only), runs powershell.exe by absolute path, and reads back
// at most 2 MB.
type winWUA struct{ paths agent.Paths }

const maxWUAOutput = 2 << 20

func (w winWUA) Run(mode string, ids []patch.Identity) ([]byte, error) {
	dir := filepath.Join(w.paths.StateDir, "patch", "run")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	var nb [8]byte
	_, _ = rand.Read(nb[:])
	tag := hex.EncodeToString(nb[:])
	script := filepath.Join(dir, "wua-"+tag+".ps1")
	in := filepath.Join(dir, "in-"+tag+".json")
	out := filepath.Join(dir, "out-"+tag+".json")
	defer os.Remove(script)
	defer os.Remove(in)
	defer os.Remove(out)
	if err := os.WriteFile(script, []byte("\ufeff"+patch.Script), 0o600); err != nil {
		return nil, err
	}
	env := append(os.Environ(), "REM0TE_WUA_MODE="+mode, "REM0TE_WUA_OUTPUT="+out)
	if ids != nil {
		b, _ := json.Marshal(ids)
		if err := os.WriteFile(in, b, 0o600); err != nil {
			return nil, err
		}
		env = append(env, "REM0TE_WUA_INPUT="+in)
	}
	timeout := 15 * time.Minute
	if mode == "install" {
		timeout = 4 * time.Hour
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.CommandContext(ctx, ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
	cmd.Env = env
	cmd.Dir = dir
	if msg, err := cmd.CombinedOutput(); err != nil {
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, fmt.Errorf("wua.ps1 %s: %v: %s", mode, err, msg)
	}
	f, err := os.Open(out)
	if err != nil {
		return nil, fmt.Errorf("wua.ps1 %s wrote no result", mode)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxWUAOutput+1))
	if err != nil || len(b) > maxWUAOutput {
		return nil, errors.New("wua.ps1 result unreadable or too large")
	}
	return b, nil
}

// PostureFile is where patch-scan leaves the posture for the heartbeat.
func postureFile(p agent.Paths) string { return filepath.Join(p.StateDir, "patch", "posture.json") }

// cmdPatchScan: read-only. Asks Windows Update what it offers and has
// installed, reads the registry for managers and pending restarts, and
// writes the posture. A scan already running (or an install) means this one
// is skipped, not queued.
func cmdPatchScan(args []string) int {
	paths := defaultPaths()
	logf := openLog(paths)
	defer logf.Close()
	l, err := flock.TryLock(action.WUALock(paths.StateDir))
	if errors.Is(err, flock.ErrBusy) {
		fmt.Fprintln(logf, "  patch-scan: Windows Update busy; skipped")
		return 0
	}
	if err != nil {
		fmt.Fprintf(logf, "  patch-scan: %v\n", err)
		return 4
	}
	defer l.Release()
	p := patch.Scan(winWUA{paths: paths}, winRegistry{}, time.Now())
	// v0.34: signed by this computer's own key, for a patch policy's ring
	// gate on the approval signer. A scan that cannot be signed is still
	// written: it shows posture, and only counts for nothing as evidence.
	if k, err := devsig.Load(paths.StateDir); err != nil {
		fmt.Fprintf(logf, "  patch-scan: result key unavailable, scan unsigned: %v\n", err)
	} else if rid, sec, err := (&winActions{paths: paths}).DeviceIdentity(); err != nil {
		fmt.Fprintf(logf, "  patch-scan: identity unreadable, scan unsigned: %v\n", err)
	} else if err := patch.SignScan(&p, k, rid, sec); err != nil {
		fmt.Fprintf(logf, "  patch-scan: signing: %v\n", err)
	}
	b, _ := json.Marshal(p)
	tmp := postureFile(paths) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		fmt.Fprintf(logf, "  patch-scan: %v\n", err)
		return 4
	}
	if err := os.Rename(tmp, postureFile(paths)); err != nil {
		fmt.Fprintf(logf, "  patch-scan: %v\n", err)
		return 4
	}
	fmt.Fprintf(logf, "  patch-scan: %d offered, reboot pending %v, managers %v, error %q\n", len(p.Updates), p.Reboot.Pending, p.Managers, p.Error)
	return 0
}
