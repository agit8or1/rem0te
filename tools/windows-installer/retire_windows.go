//go:build windows

package main

// The Windows side of agent.RetireStandard (0.51): the standard agent's
// scheduled task and the standard tray's Run value, by the exact names in
// internal/agent/retire.go. schtasks.exe from System32, an argument array,
// no shell, one task name per call; never a wildcard.

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
)

type winRetire struct{}

func (w *winPlatform) RetireOps() agent.RetireOps { return winRetire{} }

func allowedRetireTask(name string) bool {
	for _, t := range agent.StandardTasks {
		if name == t {
			return true
		}
	}
	return false
}

func schtasks(args ...string) (int, error) {
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return -1, err
	}
	cmd := exec.Command(filepath.Join(dir, "schtasks.exe"), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		return -1, errors.New("schtasks.exe did not finish within 60 seconds")
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

func (winRetire) TaskExists(name string) (bool, error) {
	if !allowedRetireTask(name) {
		return false, fmt.Errorf("refusing to look up task %q", name)
	}
	code, err := schtasks("/Query", "/TN", name)
	if err != nil {
		return false, err
	}
	return code == 0, nil
}

func (winRetire) DeleteTask(name string) error {
	if !allowedRetireTask(name) {
		return fmt.Errorf("refusing to delete task %q", name)
	}
	code, err := schtasks("/Delete", "/TN", name, "/F")
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("schtasks /Delete exit %d", code)
	}
	return nil
}

func (winRetire) DeleteRunValue(name string) (bool, error) {
	if name != agent.StandardRunValue {
		return false, fmt.Errorf("refusing to delete Run value %q", name)
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	defer k.Close()
	if _, _, err := k.GetValue(name, nil); err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if err := k.DeleteValue(name); err != nil {
		return false, err
	}
	return true, nil
}
