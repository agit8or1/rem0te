package flock

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The lock must exclude another process, not just another handle in this one.
func TestHeldAcrossProcesses(t *testing.T) {
	if os.Getenv("FLOCK_CHILD") != "" {
		_, err := TryLock(os.Getenv("FLOCK_CHILD"))
		if errors.Is(err, ErrBusy) {
			os.Exit(3)
		}
		os.Exit(0)
	}
	p := filepath.Join(t.TempDir(), "x.lock")
	l, err := TryLock(p)
	if err != nil {
		t.Fatal(err)
	}
	child := func() int {
		cmd := exec.Command(os.Args[0], "-test.run", "TestHeldAcrossProcesses")
		cmd.Env = append(os.Environ(), "FLOCK_CHILD="+p)
		err := cmd.Run()
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		return 0
	}
	if c := child(); c != 3 {
		t.Fatalf("another process took a held lock (exit %d)", c)
	}
	l.Release()
	if c := child(); c != 0 {
		t.Fatalf("a released lock stayed held (exit %d)", c)
	}
}
