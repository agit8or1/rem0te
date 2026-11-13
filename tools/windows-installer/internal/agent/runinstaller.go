package agent

import (
	"errors"
	"os/exec"
	"time"
)

// InstallerWaitDelay bounds how long RunInstallerCmd waits, after install.ps1
// itself has exited, for its output pipe to close (0.37.3).
//
// When cmd.Stdout is not an *os.File (the platform tees it to the agent log),
// os/exec copies through a pipe and Wait returns only once every holder of
// the pipe's write end has exited. install.ps1 runs rustdesk.exe directly
// (--config, --password, --get-id), and a RustDesk process that stays up
// inherits that handle, so Wait never returned. The agent hung after a
// successful install, the legacy heartbeat that launched it never finished,
// and with the scheduled task's IgnoreNew no heartbeat ran again: computers
// sat silent after fetching the migration. The script runner has the same
// guard (action/scriptexec.go).
const InstallerWaitDelay = 15 * time.Second

// RunInstallerCmd runs cmd and returns install.ps1's own exit code, which is
// still known when the wait delay expires: the process has exited and only a
// descendant still holds the output pipe.
func RunInstallerCmd(cmd *exec.Cmd) (int, error) {
	cmd.WaitDelay = InstallerWaitDelay
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	if errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode(), nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return 1, err
}
