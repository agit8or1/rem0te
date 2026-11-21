//go:build windows

package main

// `rem0te-agent.exe remote-worker` (0.77.0 Conduit): the background terminal.
// Started detached by the signed heartbeat ONLY when the portal answered
// remotePoll: true (a terminal is waiting on this computer). It polls the
// pinned portal outbound with this computer's device secret — it opens no
// port and listens on nothing — and exits when it has had nothing to do for a
// minute. One instance (remote\worker.lock).
//
// The decisions are internal/remote's; the exec site is
// internal/remote.SystemSpawner (cmd.exe or powershell.exe by absolute
// System32 path, in a Job Object). What is typed and printed passes through
// this process and is never written to the log.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/remote"
)

func remoteDir(p agent.Paths) string { return filepath.Join(p.StateDir, "remote") }

// cmdRemoteWorker: the subcommand. It takes no arguments.
func cmdRemoteWorker(args []string) int {
	paths := defaultPaths()
	logf := openLog(paths)
	defer logf.Close()
	if len(args) > 0 {
		fmt.Fprintln(logf, "  remote-worker: takes no arguments")
		return 2
	}
	wp := &winPlatform{paths: paths, log: logf}
	if err := wp.SecureDir(remoteDir(paths)); err != nil { // creates it, refuses a reparse point
		fmt.Fprintf(logf, "  remote-worker: %v\n", err)
		return 4
	}
	l, err := flock.TryLock(filepath.Join(remoteDir(paths), "worker.lock"))
	if errors.Is(err, flock.ErrBusy) {
		return 0
	}
	if err != nil {
		fmt.Fprintf(logf, "  remote-worker: %v\n", err)
		return 4
	}
	defer l.Release()

	portal := pinnedPortal()
	if !agent.ValidPortal(portal) {
		fmt.Fprintln(logf, "  remote-worker: no pinned portal")
		return 4
	}
	rid, secret, err := chatIdentity(paths)
	if err != nil {
		fmt.Fprintf(logf, "  remote-worker: %v\n", err)
		return 4
	}
	o := agent.Options{PortalHost: portal, Root: embeddedRoot, Paths: paths}
	w := &remote.Worker{
		P: &remote.HTTPPortal{Base: o.APIBase(), RID: rid, Secret: secret, HC: &http.Client{}},
		S: remote.SystemSpawner{},
		Logf: func(f string, a ...any) {
			fmt.Fprintf(logf, "  "+f+"\n", a...)
		},
	}
	if err := w.Run(context.Background()); err != nil {
		fmt.Fprintf(logf, "  remote-worker: %v\n", err)
		return 1
	}
	_ = os.Remove(filepath.Join(remoteDir(paths), "worker.started"))
	return 0
}
