// Package winget runs winget.exe for the signed agent's software actions
// (v0.34). It is the only place in the software path that starts a process:
// one executable, by the absolute path the caller located, with an argument
// array that internal/action built from checked values. Never a shell, never
// a command line.
package winget

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"time"
)

// MaxOutput is the most output kept from one run.
const MaxOutput = 64 << 10

// TimeoutError is returned when winget ran past its timeout and was killed.
// internal/action recognises it through its Timeout method.
type TimeoutError struct{}

func (TimeoutError) Error() string { return "winget did not finish in time" }
func (TimeoutError) Timeout() bool { return true }

// Runner runs the winget.exe at Path. Env, when set, is added to the
// inherited environment (the simulator uses it to point its stub at a state
// file); the agent leaves it nil.
type Runner struct {
	Path string
	Env  []string
}

type capped struct{ bytes.Buffer }

func (c *capped) Write(p []byte) (int, error) {
	if room := MaxOutput - c.Len(); room > 0 {
		if len(p) > room {
			c.Buffer.Write(p[:room])
		} else {
			c.Buffer.Write(p)
		}
	}
	return len(p), nil
}

// Locate: the configured path, if it is a regular file.
func (r Runner) Locate() (string, error) {
	st, err := os.Stat(r.Path)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", errors.New("winget path is not a regular file")
	}
	return r.Path, nil
}

// Run executes winget with args and waits at most timeout. The exit code is
// returned with a nil error whenever the process ran to an exit.
func (r Runner) Run(args []string, timeout time.Duration) (int, []byte, error) {
	if r.Path == "" {
		return -1, nil, errors.New("winget not located")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Path, args...)
	if r.Env != nil {
		cmd.Env = append(os.Environ(), r.Env...)
	}
	var out capped
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return -1, out.Bytes(), TimeoutError{}
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), out.Bytes(), nil
	}
	if err != nil {
		return -1, out.Bytes(), err
	}
	return 0, out.Bytes(), nil
}
