//go:build windows

package remote

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SystemSpawner is the terminal's ONE exec site on Windows. It starts only
// what ShellCommand names under the real System32 directory, by absolute
// path, with an argument array and no window, created suspended, put in a
// Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and only then resumed,
// so nothing the shell starts can leave the job. KillTree terminates the job
// and closes it; so does this worker exiting for any reason, because the
// handle closes with it.
//
// The shell runs as this process does: SYSTEM. Never another user.
type SystemSpawner struct{}

func (SystemSpawner) Start(shell string) (Proc, error) {
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, err
	}
	path, args, ok := ShellCommand(sys, shell)
	if !ok {
		return nil, errors.New("not a shell")
	}
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return nil, ErrShellMissing
	}
	cmd := exec.Command(path, args...)
	cmd.Dir = sys
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP}
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
	p := &winProc{cmd: cmd, stdin: &crlf{w: stdin}, stdout: stdout, stderr: stderr}
	if err := p.attach(); err != nil {
		_ = cmd.Process.Kill()
		p.closeJob()
		return nil, fmt.Errorf("job object: %w", err)
	}
	return p, nil
}

type winProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.Reader
	stderr io.Reader
	mu     sync.Mutex
	job    windows.Handle
	waited bool
	code   int
	werr   error
	wonce  sync.Once
}

func (p *winProc) Stdin() io.WriteCloser { return p.stdin }
func (p *winProc) Stdout() io.Reader     { return p.stdout }
func (p *winProc) Stderr() io.Reader     { return p.stderr }
func (p *winProc) Pid() int              { return p.cmd.Process.Pid }

func (p *winProc) attach() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.job = job
	p.mu.Unlock()
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return err
	}
	ph, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(p.cmd.Process.Pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(ph)
	if err := windows.AssignProcessToJobObject(job, ph); err != nil {
		return err
	}
	return resumeThreads(uint32(p.cmd.Process.Pid))
}

// resumeThreads resumes the suspended shell (os/exec does not expose the
// primary thread's handle).
func resumeThreads(pid uint32) error {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snap)
	var e windows.ThreadEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	n := 0
	for err = windows.Thread32First(snap, &e); err == nil; err = windows.Thread32Next(snap, &e) {
		if e.OwnerProcessID != pid {
			continue
		}
		h, oerr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, e.ThreadID)
		if oerr != nil {
			return oerr
		}
		_, rerr := windows.ResumeThread(h)
		windows.CloseHandle(h)
		if rerr != nil {
			return rerr
		}
		n++
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return err
	}
	if n == 0 {
		return errors.New("no thread to resume")
	}
	return nil
}

func (p *winProc) closeJob() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.job != 0 {
		_ = windows.TerminateJobObject(p.job, 1)
		windows.CloseHandle(p.job)
		p.job = 0
	}
}

// KillTree: every process in the job, then the job.
func (p *winProc) KillTree() {
	p.closeJob()
	_ = p.stdin.Close()
}

func (p *winProc) Wait() (int, error) {
	p.wonce.Do(func() {
		err := p.cmd.Wait()
		var ee *exec.ExitError
		switch {
		case errors.As(err, &ee):
			p.code = ee.ExitCode()
		case err != nil:
			p.werr = err
		default:
			p.code = 0
		}
	})
	return p.code, p.werr
}

// crlf turns a lone "\n" into "\r\n" for cmd.exe and powershell.exe.
type crlf struct {
	w    io.WriteCloser
	last byte
}

func (c *crlf) Write(b []byte) (int, error) {
	out := make([]byte, 0, len(b)+8)
	for _, x := range b {
		if x == '\n' && c.last != '\r' {
			out = append(out, '\r')
		}
		out = append(out, x)
		c.last = x
	}
	if _, err := c.w.Write(out); err != nil {
		return 0, err
	}
	return len(b), nil
}

func (c *crlf) Close() error { return c.w.Close() }
