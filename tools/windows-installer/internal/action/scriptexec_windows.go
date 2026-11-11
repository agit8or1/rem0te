//go:build windows

package action

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// procTree on Windows: a job object. The process is created suspended,
// assigned to the job, and only then resumed, so nothing it starts can escape
// the job. The job caps memory for the whole tree, and closing it
// (KILL_ON_JOB_CLOSE) stops everything still in it. Not yet exercised on a
// real Windows computer.
type procTree struct{ job windows.Handle }

func prepareTree(cmd *exec.Cmd) *procTree {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW}
	return &procTree{}
}

func (t *procTree) attach(cmd *exec.Cmd, mem uint64) error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("job object: %w", err)
	}
	t.job = job
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_JOB_MEMORY
	info.JobMemoryLimit = uintptr(mem)
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return fmt.Errorf("job limits: %w", err)
	}
	ph, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return fmt.Errorf("open process: %w", err)
	}
	defer windows.CloseHandle(ph)
	if err := windows.AssignProcessToJobObject(job, ph); err != nil {
		return fmt.Errorf("assign to job: %w", err)
	}
	return resumeThreads(uint32(cmd.Process.Pid))
}

// resumeThreads resumes the suspended process's threads (os/exec does not
// expose the primary thread's handle).
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

// kill stops every process in the job; true if the job still had any.
func (t *procTree) kill(cmd *exec.Cmd) bool {
	if t.job == 0 {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return false
	}
	var acct struct {
		TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
		TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
	}
	live := false
	if err := windows.QueryInformationJobObject(t.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&acct)), uint32(unsafe.Sizeof(acct)), nil); err == nil {
		live = acct.ActiveProcesses > 0
	}
	_ = windows.TerminateJobObject(t.job, 1)
	return live
}

func (t *procTree) close() {
	if t.job != 0 {
		windows.CloseHandle(t.job)
		t.job = 0
	}
}
