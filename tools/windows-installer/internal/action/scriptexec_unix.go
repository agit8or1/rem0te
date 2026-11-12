//go:build !windows

package action

import (
	"os/exec"
	"syscall"
)

// procTree off Windows (the tests and the simulator): a process group.
type procTree struct{}

func prepareTree(cmd *exec.Cmd) *procTree {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return &procTree{}
}

func (t *procTree) attach(*exec.Cmd, uint64) error { return nil }

// kill stops every process in the group; true if any was still there.
func (t *procTree) kill(cmd *exec.Cmd) bool {
	if cmd.Process == nil {
		return false
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) == nil
}

func (t *procTree) close() {}
