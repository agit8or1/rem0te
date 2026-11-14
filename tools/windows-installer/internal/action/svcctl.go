package action

// Service control (0.45): windows.service.control@1. Start, stop or restart
// one Windows service, or change its startup type — and nothing else about
// it. The parameters are closed like everything else in the catalog: the
// service's name (ServiceNameRE), the display name the portal's service list
// showed, the operation, and for set_start_type one of four start types.
//
// "Editing a service" means its startup type only. The binary path, the
// account and password it runs as, its recovery actions and its
// dependencies are never changed by this agent: each of those is arbitrary
// code execution as SYSTEM, which a catalog action must never be. The one
// configuration write (ServiceControl.SetStartType, svcproc_windows.go) is
// ChangeServiceConfig with SERVICE_NO_CHANGE for the type and error control
// and nil for every string, then the delayed-start flag.
//
// The agent reads the service ITSELF before anything changes:
//   - no such service: refused, service_not_found;
//   - a kernel or file-system driver: refused, not_a_service (disabling a
//     disk or file-system driver leaves the computer unbootable);
//   - its display name is not the one the plan names: refused,
//     service_changed (it was replaced, or the list was out of date);
//   - a protected service (ProtectedServices, the agent's own, RustDesk's
//     stop or disable, the update services' disable): refused,
//     protected_service. The portal refuses the same, from the same lists
//     (apps/api/src/actions/catalog.ts).
// Restarting RustDesk drops whoever is connected, so it waits for no open
// RustDesk session; "cannot tell" counts as open (sessionCheck).
//
// This package starts no process; the Windows side uses only the service
// control manager (golang.org/x/sys/windows/svc/mgr), never sc.exe or
// PowerShell.

import (
	"regexp"
	"strings"
	"time"
)

// ServiceControl is the Windows service control manager as
// windows.service.control uses it; tests and the simulator fake it.
type ServiceControl interface {
	// Service reads one service's configuration and state. found is false
	// (and err nil) when no service has that name.
	Service(name string) (info ServiceInfo, found bool, err error)
	// Start asks the service manager to start it and waits until it reports
	// running, or the timeout passes. The startup type is not touched.
	Start(name string, timeout time.Duration) error
	// Stop asks the service manager to stop it and waits until it reports
	// stopped, or the timeout passes. A service with running dependents is
	// refused by Windows, and that refusal is the answer: nothing else is
	// ever stopped to make room.
	Stop(name string, timeout time.Duration) error
	// SetStartType changes the startup type, and only the startup type (and
	// the delayed-start flag that is part of "automatic (delayed)").
	SetStartType(name, startType string) error
}

// ServiceInfo is what the service manager says about one service.
type ServiceInfo struct {
	// Name: the service manager's own name for it (its key).
	Name        string
	DisplayName string
	// State: running, stopped, start_pending, stop_pending, paused, ...
	State string
	// StartType: automatic, automatic_delayed, manual, disabled, boot, system.
	StartType string
	// Driver: a kernel or file-system driver. Never touched.
	Driver bool
}

// The operations and start types windows.service.control accepts.
var (
	ServiceOps        = []string{"start", "stop", "restart", "set_start_type"}
	ServiceStartTypes = []string{"automatic", "automatic_delayed", "manual", "disabled"}
)

// ServiceDisplayNameRE: the display name the plan expects. Compared on the
// computer, never run or passed to anything.
var ServiceDisplayNameRE = regexp.MustCompile(`^[^\x00-\x1f\x7f"<>\\]{1,256}$`)

// ProtectedServices are never started, stopped, restarted or reconfigured
// from here, whatever the operation. Compared case-insensitively (Windows
// service names are). Keep in step with PROTECTED_SERVICES in
// apps/api/src/actions/catalog.ts. Why each group:
//
//   - Security: Defender (WinDefend, WdNisSvc, MDCoreSvc), Defender for
//     Endpoint (Sense), Windows Security (SecurityHealthService, wscsvc),
//     the firewall and its filtering engine (mpssvc, BFE), System Guard
//     (SgrmBroker), web threat defence (webthreatdefsvc), the event log
//     (stopping it is how intruders hide), the security accounts manager,
//     key isolation and the credential vault (SamSs, KeyIso, VaultSvc),
//     domain logon (Netlogon), cryptographic services (CryptSvc, which also
//     checks every signature) and Group Policy (gpsvc). Stopping or
//     disabling any of these leaves the computer unprotected or locked out.
//   - Core: RPC (RpcSs, RpcEptMapper), the DCOM launcher, the local session
//     manager, Plug and Play, Power, the user profile service, WMI, the
//     Windows Modules Installer (TrustedInstaller), the broker and event
//     services the shell depends on, and Application Information
//     (elevation). Windows refuses to stop most of them; disabling them
//     leaves it unbootable or unusable.
//   - Task Scheduler (Schedule): this agent's heartbeat is a scheduled task,
//     so stopping or disabling it cuts the computer off from rem0te.
//   - Networking the computer needs to be reached: DHCP Client, DNS Client,
//     Network Store Interface, Workstation (stopping it drops open files and
//     mapped drives; Netlogon depends on it).
var ProtectedServices = []string{
	// Security
	"WinDefend", "WdNisSvc", "MDCoreSvc", "Sense", "SecurityHealthService", "wscsvc", "mpssvc", "BFE", "SgrmBroker", "webthreatdefsvc",
	"EventLog", "SamSs", "KeyIso", "VaultSvc", "Netlogon", "CryptSvc", "gpsvc",
	// Core
	"RpcSs", "RpcEptMapper", "DcomLaunch", "LSM", "PlugPlay", "Power", "ProfSvc", "Winmgmt", "TrustedInstaller",
	"BrokerInfrastructure", "SystemEventsBroker", "CoreMessagingRegistrar", "StateRepository", "UserManager", "EventSystem", "Appinfo",
	// The heartbeat
	"Schedule",
	// Reachability
	"Dhcp", "Dnscache", "nsi", "LanmanWorkstation",
}

// OwnServicePrefix: any service whose name starts with it is Rem0te's own,
// and is never touched from here.
const OwnServicePrefix = "Rem0te"

// KeepRunningServices may be started, restarted and set to start
// automatically, but never stopped or set to Manual or Disabled: RustDesk is
// how this computer is reached at all. (A restart waits for no open session.)
var KeepRunningServices = []string{"RustDesk"}

// NoDisableServices may be started, stopped and restarted, but never set to
// Disabled: Windows Update and what it needs to deliver updates.
var NoDisableServices = []string{"wuauserv", "UsoSvc", "WaaSMedicSvc", "BITS"}

func inFold(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}

// ServiceRefusal says why this operation on this service is refused, or "".
// The same rules as the portal's serviceRefusal.
func ServiceRefusal(name, op, startType string) string {
	switch {
	case len(name) >= len(OwnServicePrefix) && strings.EqualFold(name[:len(OwnServicePrefix)], OwnServicePrefix):
		return "this is Rem0te's own service; it is never changed from here"
	case inFold(ProtectedServices, name):
		return "a protected security or core Windows service: stopping, restarting or reconfiguring it can leave the computer unprotected, unbootable or unreachable"
	case inFold(KeepRunningServices, name) && (op == "stop" || (op == "set_start_type" && startType != "automatic" && startType != "automatic_delayed")):
		return "RustDesk is how this computer is reached: it can be started, restarted or set to start automatically, never stopped or set to Manual or Disabled"
	case inFold(NoDisableServices, name) && op == "set_start_type" && startType == "disabled":
		return "a Windows Update service: disabling it stops the computer receiving updates"
	}
	return ""
}

// ServiceSpec is a verified plan's parameters.
type ServiceSpec struct{ Service, DisplayName, Op, StartType string }

// ValidServiceDisplayName: the display-name charset, with no leading or
// trailing space.
func ValidServiceDisplayName(s string) bool {
	return ServiceDisplayNameRE.MatchString(s) && strings.TrimSpace(s) == s
}

// ServiceControlParams parses exactly {service, displayName, op}, or for
// set_start_type exactly {service, displayName, op, startType}.
func ServiceControlParams(p map[string]any) (*ServiceSpec, error) {
	s := &ServiceSpec{}
	var ok bool
	if s.Op, ok = strField(p, "op"); !ok || !inList(ServiceOps, s.Op) {
		return nil, paramErr("op must be start, stop, restart or set_start_type")
	}
	if s.Op == "set_start_type" {
		if !exactKeys(p, "service", "displayName", "op", "startType") {
			return nil, paramErr("params must be exactly service, displayName, op and startType")
		}
		if s.StartType, ok = strField(p, "startType"); !ok || !inList(ServiceStartTypes, s.StartType) {
			return nil, paramErr("startType must be automatic, automatic_delayed, manual or disabled")
		}
	} else if !exactKeys(p, "service", "displayName", "op") {
		return nil, paramErr("params must be exactly service, displayName and op")
	}
	if s.Service, ok = strField(p, "service"); !ok || !ServiceNameRE.MatchString(s.Service) {
		return nil, paramErr("bad service name")
	}
	if s.DisplayName, ok = strField(p, "displayName"); !ok || !ValidServiceDisplayName(s.DisplayName) {
		return nil, paramErr("bad displayName")
	}
	return s, nil
}

func inList(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func serviceControlParamsOK(p map[string]any) bool {
	_, err := ServiceControlParams(p)
	return err == nil
}

// readService: the spec's service as the service manager has it now, or
// the refusal. Every check that does not change anything, in order.
func readService(o Options, s *ServiceSpec, obs map[string]string) (ServiceInfo, *Result) {
	if why := ServiceRefusal(s.Service, s.Op, s.StartType); why != "" {
		return ServiceInfo{}, &Result{Outcome: "refused", Reason: "protected_service", Detail: why, Observed: obs}
	}
	info, found, err := o.Services.Service(s.Service)
	if err != nil {
		return ServiceInfo{}, &Result{Outcome: "failed", Reason: "service_query_failed", Detail: trim(err.Error()), Observed: obs}
	}
	if !found {
		return ServiceInfo{}, &Result{Outcome: "refused", Reason: "service_not_found", Detail: "this computer has no service by that name; nothing was changed", Observed: obs}
	}
	obs["before"], obs["beforeStartType"] = info.State, info.StartType
	if info.Driver {
		return info, &Result{Outcome: "refused", Reason: "not_a_service", Detail: "that name is a driver, not a service; drivers are never changed from here", Observed: obs}
	}
	// The name the service manager answers to may differ in case; it must
	// still be the same service, and still not a protected one.
	if !strings.EqualFold(info.Name, s.Service) {
		return info, &Result{Outcome: "refused", Reason: "service_changed", Detail: "the service manager answered with a different service", Observed: obs}
	}
	if why := ServiceRefusal(info.Name, s.Op, s.StartType); why != "" {
		return info, &Result{Outcome: "refused", Reason: "protected_service", Detail: why, Observed: obs}
	}
	if strings.TrimSpace(info.DisplayName) != s.DisplayName {
		return info, &Result{Outcome: "refused", Reason: "service_changed",
			Detail: "the service's display name is not the one this plan was made for, so nothing was changed. Refresh the Services tab and ask again", Observed: obs}
	}
	if info.StartType == "boot" || info.StartType == "system" {
		return info, &Result{Outcome: "refused", Reason: "not_a_service", Detail: "a boot or system start type belongs to a driver; it is never changed from here", Observed: obs}
	}
	return info, nil
}

// servicePrecheck runs after the signed pause and before the job is
// journaled as executing: the reads above, and for a RustDesk restart no
// open RustDesk session.
func servicePrecheck(p *Plan, o Options) *Result {
	if o.Services == nil {
		return &Result{Outcome: "failed", Reason: "no_service_control", Detail: "this agent cannot control services"}
	}
	s, err := ServiceControlParams(p.Params)
	if err != nil {
		return refuse("params_not_allowed", err.Error())
	}
	obs := map[string]string{"service": s.Service, "op": s.Op}
	if _, r := readService(o, s, obs); r != nil {
		return r
	}
	if s.Op == "restart" && inFold(KeepRunningServices, s.Service) {
		return sessionCheck("the RustDesk restart")(p, o)
	}
	return nil
}

func controlService(p *Plan, o Options) Result {
	r := started(o)
	s, err := ServiceControlParams(p.Params) // verified already; checked again before use
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "refused", "params_not_allowed", err.Error()
		return r
	}
	r.Observed["service"], r.Observed["op"] = s.Service, s.Op
	if s.StartType != "" {
		r.Observed["want"] = s.StartType
	}
	info, refusal := readService(o, s, r.Observed)
	if refusal != nil {
		refusal.ExecutedAt, refusal.AgentSHA256 = r.ExecutedAt, r.AgentSHA256
		return *refusal
	}
	timeout := o.StopTimeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	switch s.Op {
	case "start":
		if info.State == "running" {
			r.Outcome, r.Detail = "no_change", "the service was already running; nothing was changed"
			break
		}
		journalStep(o, p, "starting")
		if err := o.Services.Start(info.Name, timeout); err != nil {
			r.Outcome, r.Reason, r.Detail = "failed", "start_failed", trim(err.Error())
			break
		}
		if serviceStaysRunning(o, info.Name, &r) {
			r.Outcome, r.Detail = "succeeded", "started; running at every check"
		} else {
			r.Outcome, r.Reason, r.Detail = "failed", "did_not_remain_running", "started, but was not running at every check"
		}
	case "stop":
		if info.State == "stopped" {
			r.Outcome, r.Detail = "no_change", "the service was already stopped; nothing was changed"
			break
		}
		journalStep(o, p, "stopping")
		if err := o.Services.Stop(info.Name, timeout); err != nil {
			r.Outcome, r.Reason, r.Detail = "failed", "stop_failed", trim(err.Error())
			break
		}
		r.Outcome, r.Detail = "succeeded", "stopped"
	case "restart":
		if info.State != "stopped" {
			journalStep(o, p, "stopping")
			if err := o.Services.Stop(info.Name, timeout); err != nil {
				r.Outcome, r.Reason, r.Detail = "failed", "stop_failed", trim(err.Error())
				break
			}
		}
		journalStep(o, p, "starting")
		if err := o.Services.Start(info.Name, timeout); err != nil {
			r.Outcome, r.Reason, r.Detail = "failed", "start_failed", trim(err.Error())
			break
		}
		if serviceStaysRunning(o, info.Name, &r) {
			r.Outcome, r.Detail = "succeeded", "restarted; running at every check"
			if info.State == "stopped" {
				r.Detail = "it was stopped, so it was started; running at every check"
			}
		} else {
			r.Outcome, r.Reason, r.Detail = "failed", "did_not_remain_running", "restarted, but was not running at every check"
		}
	case "set_start_type":
		if info.StartType == s.StartType {
			r.Outcome, r.Detail = "no_change", "the startup type was already "+s.StartType+"; nothing was changed"
			break
		}
		journalStep(o, p, "configuring")
		if err := o.Services.SetStartType(info.Name, s.StartType); err != nil {
			r.Outcome, r.Reason, r.Detail = "failed", "config_failed", trim(err.Error())
			break
		}
		r.Outcome, r.Detail = "succeeded", "the startup type is now "+s.StartType+"; the service's state was not changed"
	}
	// What the service manager says now, whatever happened: both its state
	// and its startup type. A change that did not take is a failure.
	now, found, err := o.Services.Service(info.Name)
	switch {
	case err != nil || !found:
		r.Observed["state"], r.Observed["startType"] = "unknown", "unknown"
		if r.Outcome == "succeeded" {
			r.Outcome, r.Reason, r.Detail = "failed", "verify_failed", "the change was made, but the service could not be read back afterwards"
		}
	default:
		r.Observed["state"], r.Observed["startType"] = now.State, now.StartType
		if r.Outcome != "succeeded" {
			break
		}
		switch {
		case s.Op == "stop" && now.State != "stopped":
			r.Outcome, r.Reason, r.Detail = "failed", "did_not_stop", "the stop was accepted, but the service is "+now.State
		case (s.Op == "start" || s.Op == "restart") && now.State != "running":
			r.Outcome, r.Reason, r.Detail = "failed", "did_not_remain_running", "started, but the service is "+now.State
		case s.Op == "set_start_type" && now.StartType != s.StartType:
			r.Outcome, r.Reason, r.Detail = "failed", "start_type_not_applied", "the service manager accepted the change, but reports the startup type as "+now.StartType
		}
	}
	return r
}

// serviceStaysRunning sleeps through o.Checks and records the state after each.
func serviceStaysRunning(o Options, name string, r *Result) bool {
	checks := o.Checks
	if checks == nil {
		checks = []time.Duration{10 * time.Second, 20 * time.Second}
	}
	elapsed, ok := time.Duration(0), true
	for _, d := range checks {
		o.Platform.Sleep(d)
		elapsed += d
		st := "unknown"
		if info, found, err := o.Services.Service(name); err == nil && found {
			st = info.State
		}
		r.Observed["after"+itoa(int(elapsed.Seconds()))+"s"] = st
		if st != "running" {
			ok = false
		}
	}
	return ok
}

func serviceInterrupted(params map[string]any, o Options) map[string]string {
	s, err := ServiceControlParams(params)
	if err != nil || o.Services == nil {
		return nil
	}
	if info, found, err := o.Services.Service(s.Service); err == nil && found {
		return map[string]string{"service": s.Service, "state": info.State, "startType": info.StartType}
	}
	return nil
}
