// Package labevidence records what the Windows lab's Go tests found (0.68.3).
//
// The lab tests (files tagged `windows && labwindows`, run only by the
// lab-windows workflow) exercise the agent's real Windows code on a
// disposable GitHub runner. Each test calls Track, which appends one JSON line
// to the file named by REM0TE_LAB_EVIDENCE when the test ends: its id, pass,
// fail or skip, and a detail saying what was observed. The workflow merges
// those lines into the lab-evidence-windows artifact.
//
// Nothing here runs unless REM0TE_LAB=1: Require skips the test otherwise, so
// building with the tag on a developer's computer changes nothing on it.
package labevidence

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// Record is one line of the evidence file.
type Record struct {
	ID     string `json:"id"`
	Status string `json:"status"` // pass, fail, skip
	Detail string `json:"detail"`
	// Real: the test ran against the real operating system (the service
	// control manager, the process table, the registry, Windows PowerShell
	// 5.1). False only for a skip. Nothing in the lab is simulated.
	Real       bool   `json:"real"`
	DurationMs int64  `json:"durationMs"`
	At         string `json:"at"`
}

var mu sync.Mutex

// Require skips t unless the lab gate is set. The lab tests change services,
// end processes and remove programs: they belong on a throwaway runner only.
func Require(t *testing.T) {
	t.Helper()
	if os.Getenv("REM0TE_LAB") != "1" {
		t.Skip("lab test: set REM0TE_LAB=1, on a disposable Windows computer only")
	}
}

// Note collects what one test observed.
type Note struct {
	t      *testing.T
	mu     sync.Mutex
	parts  []string
	reason string
}

// Track records t under id when it ends. Call Require first.
func Track(t *testing.T, id string) *Note {
	t.Helper()
	n := &Note{t: t}
	start := time.Now()
	t.Cleanup(func() {
		status := "pass"
		switch {
		case t.Failed():
			status = "fail"
		case t.Skipped():
			status = "skip"
		}
		n.mu.Lock()
		detail := strings.Join(n.parts, "; ")
		if n.reason != "" {
			if detail != "" {
				detail += "; "
			}
			detail += "skipped: " + n.reason
		}
		n.mu.Unlock()
		write(Record{ID: id, Status: status, Detail: detail, Real: status != "skip",
			DurationMs: time.Since(start).Milliseconds(), At: time.Now().UTC().Format(time.RFC3339)})
	})
	return n
}

// Logf adds an observation to the record and to the test log.
func (n *Note) Logf(format string, args ...any) {
	n.t.Helper()
	s := fmt.Sprintf(format, args...)
	n.mu.Lock()
	n.parts = append(n.parts, s)
	n.mu.Unlock()
	n.t.Log(s)
}

// Skip records why and skips the test.
func (n *Note) Skip(reason string) {
	n.t.Helper()
	n.mu.Lock()
	n.reason = reason
	n.mu.Unlock()
	n.t.Skip(reason)
}

func write(r Record) {
	path := os.Getenv("REM0TE_LAB_EVIDENCE")
	if path == "" {
		return
	}
	b, err := json.Marshal(r)
	if err != nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}
