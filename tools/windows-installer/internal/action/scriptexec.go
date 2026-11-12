package action

// The one process the action package starts (v0.34): PowerShell, for
// windows.script.run, with a constant argument list. Nothing from a plan
// reaches the command line — the wrapper path is the agent's own temporary
// directory, and the script's arguments travel in params.json.
//
// The process tree is bounded by procTree (scriptexec_windows.go: a job
// object with a memory limit that kills everything when closed; elsewhere,
// for the tests and the simulator, a process group).

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"
)

// ExecHost runs PowerShell at a fixed path.
type ExecHost struct {
	// PowerShell: the absolute path of powershell.exe (System32 on Windows) or, for tests, pwsh.
	PowerShell string
	// MemoryLimit: bytes for the whole job on Windows; 0 for ScriptMemoryLimit.
	MemoryLimit uint64
}

// scriptArgs is the whole command line after the executable. Constant but for
// the wrapper, which is a path the agent made.
func scriptArgs(wrapper string) []string {
	return []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper}
}

// capWriter keeps the first max bytes and counts the rest.
type capWriter struct {
	mu    sync.Mutex
	max   int
	buf   []byte
	total int64
}

func (w *capWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.total += int64(len(p))
	if room := w.max - len(w.buf); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		w.buf = append(w.buf, p[:room]...)
	}
	return len(p), nil
}

func (h ExecHost) RunPowerShell(dir, wrapper string, timeout time.Duration, maxOutput int) ScriptRun {
	cmd := exec.Command(h.PowerShell, scriptArgs(wrapper)...)
	cmd.Dir = dir
	// The script's temporary files go in its own directory, removed afterwards.
	cmd.Env = append(os.Environ(), "TEMP="+dir, "TMP="+dir, "TMPDIR="+dir)
	out, errw := &capWriter{max: maxOutput}, &capWriter{max: maxOutput}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, out, errw
	// Something the script left running may hold the pipes open after it
	// exits; it is stopped below, so Wait need not wait for it long.
	cmd.WaitDelay = 2 * time.Second
	mem := h.MemoryLimit
	if mem == 0 {
		mem = ScriptMemoryLimit
	}
	t := prepareTree(cmd)
	start := time.Now()
	if err := cmd.Start(); err != nil {
		return ScriptRun{Err: err}
	}
	if err := t.attach(cmd, mem); err != nil {
		// Never run a script outside its limits.
		t.kill(cmd)
		_ = cmd.Wait()
		t.close()
		return ScriptRun{Err: err}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	r := ScriptRun{}
	var err error
	select {
	case err = <-done:
	case <-timer.C:
		r.TimedOut = true
		t.kill(cmd)
		err = <-done
	}
	r.Duration = time.Since(start)
	// Whatever the script started and left running goes with it.
	if left := t.kill(cmd); !r.TimedOut {
		r.Leftovers = left || errors.Is(err, exec.ErrWaitDelay)
	}
	t.close()
	if cmd.ProcessState != nil {
		r.ExitCode = cmd.ProcessState.ExitCode()
	}
	r.Stdout, r.Stderr, r.StdoutTotal, r.StderrTotal = out.buf, errw.buf, out.total, errw.total
	return r
}
