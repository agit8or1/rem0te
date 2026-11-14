//go:build windows

package main

// The Windows calls behind windows.service.control@1 and
// windows.process.stop@1 (0.45). Everything that decides whether anything
// happens is in internal/action (svcctl.go, procstop.go); this file is only
// the service control manager and the process table. It starts no process:
// no sc.exe, no taskkill, no PowerShell.
//
// The one service configuration write is ChangeServiceConfig with
// SERVICE_NO_CHANGE for the service type and error control and nil for the
// binary path, load-order group, tag, dependencies, account, password and
// display name — so only the startup type changes — then the delayed-start
// flag through ChangeServiceConfig2. mgr.Service.UpdateConfig is never used:
// it writes back every field, binary path and account included.

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
)

type winServices struct{}

func svcState(st svc.State) string {
	switch st {
	case svc.Running:
		return "running"
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start_pending"
	case svc.StopPending:
		return "stop_pending"
	case svc.Paused:
		return "paused"
	case svc.ContinuePending:
		return "continue_pending"
	case svc.PausePending:
		return "pause_pending"
	}
	return fmt.Sprintf("state_%d", st)
}

func startTypeName(c mgr.Config) string {
	switch c.StartType {
	case mgr.StartAutomatic:
		if c.DelayedAutoStart {
			return "automatic_delayed"
		}
		return "automatic"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	case windows.SERVICE_BOOT_START:
		return "boot"
	case windows.SERVICE_SYSTEM_START:
		return "system"
	}
	return fmt.Sprintf("start_%d", c.StartType)
}

func openService(name string) (*mgr.Mgr, *mgr.Service, error) {
	if !action.ServiceNameRE.MatchString(name) {
		return nil, nil, errors.New("refusing a service name outside the charset")
	}
	m, err := mgr.Connect()
	if err != nil {
		return nil, nil, err
	}
	s, err := m.OpenService(name)
	if err != nil {
		m.Disconnect()
		return nil, nil, err
	}
	return m, s, nil
}

// Service reads the configuration (display name, start type, type) and the
// status. The binary path and account it also returns are not passed on.
func (winServices) Service(name string) (action.ServiceInfo, bool, error) {
	m, s, err := openService(name)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return action.ServiceInfo{}, false, nil
	}
	if err != nil {
		return action.ServiceInfo{}, false, err
	}
	defer m.Disconnect()
	defer s.Close()
	c, err := s.Config()
	if err != nil {
		return action.ServiceInfo{}, false, err
	}
	st, err := s.Query()
	if err != nil {
		return action.ServiceInfo{}, false, err
	}
	driver := c.ServiceType&(windows.SERVICE_KERNEL_DRIVER|windows.SERVICE_FILE_SYSTEM_DRIVER|windows.SERVICE_ADAPTER|windows.SERVICE_RECOGNIZER_DRIVER) != 0
	return action.ServiceInfo{Name: s.Name, DisplayName: c.DisplayName, State: svcState(st.State), StartType: startTypeName(c), Driver: driver}, true, nil
}

func waitState(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the service did not reach %s within %s (it is %s)", svcState(want), timeout, svcState(st.State))
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// Start starts the service and nothing else: the startup type is not
// touched, so a Disabled service stays disabled and the start fails.
func (winServices) Start(name string, timeout time.Duration) error {
	m, s, err := openService(name)
	if err != nil {
		return err
	}
	defer m.Disconnect()
	defer s.Close()
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return err
	}
	return waitState(s, svc.Running, timeout)
}

// Stop sends the stop control. A service with running dependents is refused
// by Windows (ERROR_DEPENDENT_SERVICES_RUNNING) and that error is returned
// as is: nothing else is ever stopped to make room.
func (winServices) Stop(name string, timeout time.Duration) error {
	m, s, err := openService(name)
	if err != nil {
		return err
	}
	defer m.Disconnect()
	defer s.Close()
	if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return err
	}
	return waitState(s, svc.Stopped, timeout)
}

// SetStartType changes the startup type only.
func (winServices) SetStartType(name, startType string) error {
	var t uint32
	delayed := uint32(0)
	switch startType {
	case "automatic":
		t = windows.SERVICE_AUTO_START
	case "automatic_delayed":
		t, delayed = windows.SERVICE_AUTO_START, 1
	case "manual":
		t = windows.SERVICE_DEMAND_START
	case "disabled":
		t = windows.SERVICE_DISABLED
	default:
		return errors.New("refusing a start type outside the catalog")
	}
	m, s, err := openService(name)
	if err != nil {
		return err
	}
	defer m.Disconnect()
	defer s.Close()
	if err := windows.ChangeServiceConfig(s.Handle, windows.SERVICE_NO_CHANGE, t, windows.SERVICE_NO_CHANGE, nil, nil, nil, nil, nil, nil, nil); err != nil {
		return err
	}
	if t != windows.SERVICE_AUTO_START {
		return nil
	}
	info := windows.SERVICE_DELAYED_AUTO_START_INFO{IsDelayedAutoStartUp: delayed}
	return windows.ChangeServiceConfig2(s.Handle, windows.SERVICE_CONFIG_DELAYED_AUTO_START_INFO, (*byte)(unsafe.Pointer(&info)))
}

type winProcesses struct{}

func creationTime(h windows.Handle) (time.Time, error) {
	var c, e, k, u windows.Filetime
	if err := windows.GetProcessTimes(h, &c, &e, &k, &u); err != nil {
		return time.Time{}, err
	}
	return time.Unix(0, c.Nanoseconds()).UTC(), nil
}

// Processes: a Toolhelp snapshot, and each process's creation time where
// Windows lets the agent open it for query.
func (winProcesses) Processes() ([]action.ProcessInfo, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	var out []action.ProcessInfo
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		p := action.ProcessInfo{PID: e.ProcessID, ParentPID: e.ParentProcessID, Name: windows.UTF16ToString(e.ExeFile[:])}
		if h, oerr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID); oerr == nil {
			if t, terr := creationTime(h); terr == nil {
				p.Created = t
			}
			windows.CloseHandle(h)
		}
		out = append(out, p)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	return out, nil
}

// Terminate: OpenProcess for terminate, query and synchronize; the creation
// time is checked on that handle, which pins the process, so a PID reused
// since the list was read is never ended; then TerminateProcess and a wait.
func (winProcesses) Terminate(pid uint32, created time.Time, timeout time.Duration) error {
	if pid == 0 || pid == 4 {
		return errors.New("refusing the System or Idle process")
	}
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return action.ErrProcessGone // that PID names no process now
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	t, err := creationTime(h)
	if err != nil {
		return err
	}
	if !action.SameCreation(t, created.UTC().Truncate(time.Millisecond)) {
		return action.ErrProcessChanged
	}
	if err := windows.TerminateProcess(h, 1); err != nil {
		return err
	}
	ev, err := windows.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
	if err != nil {
		return err
	}
	if ev != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("the process did not exit within %s", timeout)
	}
	return nil
}
