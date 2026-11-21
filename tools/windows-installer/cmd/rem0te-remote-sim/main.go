//go:build !windows

// The simulator is for the Linux test stacks: its shell is /bin/sh in a
// process group (remote.SystemSpawner's Unix side). On Windows the worker is
// rem0te-agent.exe remote-worker, so there is nothing to build here.

// rem0te-remote-sim runs the agent's real remote worker (internal/remote:
// the poll loop, the deadlines, the frame caps, the HTTP client that carries
// the device secret) against a portal, for the end-to-end suites
// (apps/api/scripts/e2e-terminal.mjs). Only the shell differs from Windows:
// here both "cmd" and "powershell" are /bin/sh (or -sh), run in a process
// group that is killed whole, where Windows uses cmd.exe or powershell.exe
// from System32 in a Job Object. SIMULATION, not Windows evidence.
//
//	rem0te-remote-sim -api http://127.0.0.1:PORT/api/v1 -rustdesk-id ID -secret S
//	    [-sh /bin/sh] [-idle-exit 60s] [-max-session 60m] [-idle-timeout 15m]
//	    [-disconnect-kill 90s] [-log FILE] [-files-root DIR]
//
// File transfer (0.78) runs the worker's real code against -files-root: a
// Windows path C:\a\b is DIR/C/a/b, and a reparse point is a symlink. On
// Windows the path is used as it is (WinFS) and a reparse point is
// FILE_ATTRIBUTE_REPARSE_POINT.
//
// It exits as the worker does: when it has had nothing to do for -idle-exit,
// or the portal refuses it. Loopback http only: it refuses any other portal.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/remote"
)

func main() {
	api := flag.String("api", "", "portal API base (loopback http)")
	rid := flag.String("rustdesk-id", "", "RustDesk ID")
	secret := flag.String("secret", "", "device secret")
	sh := flag.String("sh", "/bin/sh", "the shell both names run")
	idleExit := flag.Duration("idle-exit", remote.IdleExit, "exit after this long with nothing to do")
	maxSession := flag.Duration("max-session", remote.MaxSession, "the worker's own hard limit (test knob)")
	idleTimeout := flag.Duration("idle-timeout", remote.IdleTimeout, "the worker's own idle limit (test knob)")
	disconnect := flag.Duration("disconnect-kill", remote.DisconnectKill, "end every session after the portal is unreachable this long")
	logPath := flag.String("log", "", "append the worker's log here")
	filesRoot := flag.String("files-root", "", "file transfer: a Windows path C:\\a\\b is <files-root>/C/a/b (empty: transfers are refused)")
	flag.Parse()

	u, err := url.Parse(*api)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		fmt.Fprintln(os.Stderr, "rem0te-remote-sim: -api must be loopback http")
		os.Exit(2)
	}
	if *rid == "" || *secret == "" {
		fmt.Fprintln(os.Stderr, "rem0te-remote-sim: -rustdesk-id and -secret are required")
		os.Exit(2)
	}
	logw := os.Stderr
	if *logPath != "" {
		f, err := os.OpenFile(*logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		defer f.Close()
		logw = f
	}
	portal := &remote.HTTPPortal{Base: *api, RID: *rid, Secret: *secret, HC: &http.Client{}}
	var fs remote.FileSystem
	if *filesRoot != "" {
		fs = remote.RootFS{Root: *filesRoot}
	}
	w := &remote.Worker{
		P:              portal,
		F:              portal,
		FS:             fs,
		S:              remote.SystemSpawner{Shells: map[string][]string{"cmd": {*sh}, "powershell": {*sh}}},
		IdleExit:       *idleExit,
		MaxSession:     *maxSession,
		IdleTimeout:    *idleTimeout,
		DisconnectKill: *disconnect,
		Logf: func(f string, a ...any) {
			fmt.Fprintf(logw, "%s "+f+"\n", append([]any{time.Now().UTC().Format(time.RFC3339Nano)}, a...)...)
		},
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := w.Run(ctx); err != nil {
		fmt.Fprintln(logw, "rem0te-remote-sim:", err)
		os.Exit(1)
	}
}
