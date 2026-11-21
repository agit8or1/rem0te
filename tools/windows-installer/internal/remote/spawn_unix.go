//go:build !windows

package remote

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
)

// SystemSpawner off Windows: the Go tests and rem0te-remote-sim. Each shell
// name maps to an argv given by the caller (e.g. /bin/sh), run in its own
// process group, which KillTree kills whole. The decisions around it are the
// worker's own; only the shell and the tree mechanism differ from Windows.
type SystemSpawner struct {
	Shells map[string][]string
}

func (s SystemSpawner) Start(shell string) (Proc, error) {
	if !ValidShell(shell) {
		return nil, errors.New("not a shell")
	}
	argv := s.Shells[shell]
	if len(argv) == 0 {
		return nil, ErrShellMissing
	}
	if fi, err := os.Stat(argv[0]); err != nil || !fi.Mode().IsRegular() {
		return nil, ErrShellMissing
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &unixProc{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

type unixProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.Reader
	stderr io.Reader
	wonce  sync.Once
	code   int
	werr   error
}

func (p *unixProc) Stdin() io.WriteCloser { return p.stdin }
func (p *unixProc) Stdout() io.Reader     { return p.stdout }
func (p *unixProc) Stderr() io.Reader     { return p.stderr }
func (p *unixProc) Pid() int              { return p.cmd.Process.Pid }

func (p *unixProc) KillTree() {
	_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
	_ = p.stdin.Close()
}

func (p *unixProc) Wait() (int, error) {
	p.wonce.Do(func() {
		err := p.cmd.Wait()
		var ee *exec.ExitError
		switch {
		case errors.As(err, &ee):
			p.code = ee.ExitCode()
		case err != nil:
			p.werr = err
		}
	})
	return p.code, p.werr
}
