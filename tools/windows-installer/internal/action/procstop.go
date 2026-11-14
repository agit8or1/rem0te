package action

// Ending a process (0.45): windows.process.stop@1, the task manager's End
// process. The parameters are closed: the process id, its image name and its
// creation time exactly as the portal's process list showed them, and
// optionally "tree" to end the processes it started as well.
//
// A process id is reused as soon as its process exits, so a PID alone could
// end something nobody chose. The agent refuses unless all three still
// match: the PID, the image name (without ".exe", case-insensitively) and
// the creation time (to the millisecond, the precision the portal keeps).
// ProcessTable.Terminate checks the creation time again on the handle it
// ends the process through, so nothing between the check and the end can
// swap the process underneath it.
//
// Protected processes are never ended (ProtectedProcesses): the kernel's
// own, the session and logon chain, the security subsystem, every service
// host (svchost — stop the service instead), Defender, and Rem0te's agent and
// tray and RustDesk, which are how this computer is reached. The portal
// refuses the same list (apps/api/src/actions/catalog.ts). With tree, a
// protected process anywhere in the tree refuses the whole plan.
//
// This package starts no process; the Windows side uses OpenProcess,
// GetProcessTimes and TerminateProcess (golang.org/x/sys/windows), never
// taskkill or PowerShell.

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ProcessTable is the Windows process table as windows.process.stop uses
// it; tests and the simulator fake it.
type ProcessTable interface {
	// Processes lists every process: id, parent id, image name and creation
	// time (zero when Windows does not let the agent read it).
	Processes() ([]ProcessInfo, error)
	// Terminate opens pid, checks on that handle that the process was
	// created at created (ErrProcessChanged otherwise), ends it, and waits
	// at most timeout for it to exit.
	Terminate(pid uint32, created time.Time, timeout time.Duration) error
}

// ProcessInfo is one process.
type ProcessInfo struct {
	PID, ParentPID uint32
	// Name: the image file name, e.g. notepad.exe.
	Name    string
	Created time.Time
}

// ErrProcessChanged: the process id now belongs to a different process.
// ErrProcessGone: no process has that id any more.
var (
	ErrProcessChanged = errors.New("that process id now belongs to a different process")
	ErrProcessGone    = errors.New("no process has that id any more")
)

var (
	// ProcessNameRE: a process name as the process list shows it (the image
	// name, without .exe). A name, never a path.
	ProcessNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.()+-]{0,63}$`)
	// ProcessStartedRE: the creation time, as the portal stores it (UTC, milliseconds).
	ProcessStartedRE = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`)
)

// ProtectedProcesses are never ended from here, compared case-insensitively
// with the image name without ".exe". Keep in step with PROTECTED_PROCESSES
// in apps/api/src/actions/catalog.ts.
//
//   - The kernel's own: System, Idle, Registry, Memory Compression, Secure System.
//   - Session and logon: smss, csrss, wininit, winlogon, services, fontdrvhost,
//     dwm. Ending most of them stops Windows (a bug check) or the desktop.
//   - The security subsystem: lsass, lsaiso.
//   - svchost: every one hosts Windows services; end the service instead
//     (windows.service.control, the Services tab).
//   - Security products: MsMpEng, NisSrv, MpDefenderCoreService, MsSense,
//     SecurityHealthService, SgrmBroker.
//   - How this computer is reached: Rem0te's agent and tray, and RustDesk.
var ProtectedProcesses = []string{
	"System", "Idle", "Registry", "Memory Compression", "Secure System",
	"smss", "csrss", "wininit", "winlogon", "services", "fontdrvhost", "dwm",
	"lsass", "lsaiso",
	"svchost",
	"MsMpEng", "NisSrv", "MpDefenderCoreService", "MsSense", "SecurityHealthService", "SgrmBroker",
	"rem0te-agent", "rem0te-tray", "rustdesk",
}

// MaxTreeProcesses: the most processes one tree plan ends.
const MaxTreeProcesses = 64

// processTerminateTimeout: how long to wait for each process to exit.
const processTerminateTimeout = 10 * time.Second

// ImageBase is a process name as the list shows it: the image file name
// without a trailing ".exe".
func ImageBase(name string) string {
	if len(name) > 4 && strings.EqualFold(name[len(name)-4:], ".exe") {
		return name[:len(name)-4]
	}
	return name
}

// ProcessRefusal says why this process is never ended, or "".
func ProcessRefusal(name string, pid uint32) string {
	base := ImageBase(strings.TrimSpace(name))
	switch {
	case pid == 0 || pid == 4:
		return "the System and Idle processes are the kernel's own; they cannot be ended"
	case strings.EqualFold(base, "svchost"):
		return "svchost hosts Windows services: stop the service instead, from the Services tab"
	case strings.EqualFold(base, "rem0te-agent") || strings.EqualFold(base, "rem0te-tray") || strings.EqualFold(base, "rustdesk"):
		return "Rem0te and RustDesk are how this computer is reached; they are never ended from here"
	case inFold(ProtectedProcesses, base):
		return "a protected Windows or security process: ending it can stop Windows, sign everyone out or leave the computer unprotected"
	}
	return ""
}

// ProcessSpec is a verified plan's parameters.
type ProcessSpec struct {
	PID       uint32
	Name      string
	StartedAt time.Time
	Tree      bool
}

// ProcessStopParams parses exactly {pid, name, startedAt} or {pid, name, startedAt, tree}.
func ProcessStopParams(p map[string]any) (*ProcessSpec, error) {
	if !exactKeys(p, "pid", "name", "startedAt") && !exactKeys(p, "pid", "name", "startedAt", "tree") {
		return nil, paramErr("params must be exactly pid, name, startedAt and optionally tree")
	}
	s := &ProcessSpec{}
	n, ok := p["pid"].(float64)
	if !ok || n != math.Trunc(n) || n < 1 || n > math.MaxUint32 {
		return nil, paramErr("pid must be a whole number from 1 to 4294967295")
	}
	s.PID = uint32(n)
	if s.Name, ok = strField(p, "name"); !ok || !ProcessNameRE.MatchString(s.Name) || strings.TrimSpace(s.Name) != s.Name {
		return nil, paramErr("bad process name")
	}
	at, ok := strField(p, "startedAt")
	if !ok || !ProcessStartedRE.MatchString(at) {
		return nil, paramErr("startedAt must be a UTC time to the millisecond")
	}
	t, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return nil, paramErr("startedAt does not parse")
	}
	s.StartedAt = t
	if v, present := p["tree"]; present {
		if s.Tree, ok = v.(bool); !ok {
			return nil, paramErr("tree must be true or false")
		}
	}
	return s, nil
}

func processStopParamsOK(p map[string]any) bool {
	_, err := ProcessStopParams(p)
	return err == nil
}

// SameCreation: a creation time read on the computer is the one the plan
// names, to the millisecond the portal kept (the portal's copy is truncated,
// never rounded, so the two differ by less than a millisecond).
func SameCreation(read, want time.Time) bool {
	if read.IsZero() {
		return false
	}
	return read.UTC().Truncate(time.Millisecond).Equal(want.UTC())
}

// matchProcess: the plan's process as the table has it now, its tree when
// asked for, or the refusal. Nothing here changes anything.
func matchProcess(o Options, s *ProcessSpec, obs map[string]string) (ProcessInfo, []ProcessInfo, *Result) {
	if why := ProcessRefusal(s.Name, s.PID); why != "" {
		return ProcessInfo{}, nil, &Result{Outcome: "refused", Reason: "protected_process", Detail: why, Observed: obs}
	}
	all, err := o.Processes.Processes()
	if err != nil {
		return ProcessInfo{}, nil, &Result{Outcome: "failed", Reason: "process_query_failed", Detail: trim(err.Error()), Observed: obs}
	}
	var root *ProcessInfo
	for i := range all {
		if all[i].PID == s.PID {
			root = &all[i]
			break
		}
	}
	if root == nil {
		return ProcessInfo{}, nil, &Result{Outcome: "no_change", Reason: "not_running", Detail: "that process is no longer running; nothing was changed", Observed: obs}
	}
	if !strings.EqualFold(ImageBase(root.Name), s.Name) || !SameCreation(root.Created, s.StartedAt) {
		obs["nowName"] = trimTo(ImageBase(root.Name), 64)
		return *root, nil, &Result{Outcome: "refused", Reason: "process_changed",
			Detail: "that process id now belongs to a different process (its name or start time is not the one this plan was made for), so nothing was ended. Refresh the Processes tab and ask again", Observed: obs}
	}
	if why := ProcessRefusal(root.Name, root.PID); why != "" {
		return *root, nil, &Result{Outcome: "refused", Reason: "protected_process", Detail: why, Observed: obs}
	}
	if !s.Tree {
		return *root, nil, nil
	}
	// Its descendants: started by it (or by one of them) no earlier than it,
	// so a process whose parent id was reused is never counted as a child.
	var tree []ProcessInfo
	seen := map[uint32]bool{root.PID: true}
	frontier := []ProcessInfo{*root}
	for len(frontier) > 0 {
		parent := frontier[0]
		frontier = frontier[1:]
		for _, c := range all {
			if seen[c.PID] || c.ParentPID != parent.PID || c.Created.IsZero() || c.Created.Before(parent.Created) {
				continue
			}
			seen[c.PID] = true
			if why := ProcessRefusal(c.Name, c.PID); why != "" {
				obs["protectedChild"] = trimTo(ImageBase(c.Name), 64)
				return *root, nil, &Result{Outcome: "refused", Reason: "protected_process", Detail: "the tree includes " + trimTo(ImageBase(c.Name), 64) + ": " + why, Observed: obs}
			}
			tree = append(tree, c)
			if len(tree) > MaxTreeProcesses {
				return *root, nil, &Result{Outcome: "refused", Reason: "tree_too_large", Detail: "the tree has more than " + strconv.Itoa(MaxTreeProcesses) + " processes; end it from the computer", Observed: obs}
			}
			frontier = append(frontier, c)
		}
	}
	return *root, tree, nil
}

func trimTo(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// processPrecheck runs after the signed pause and before the job is
// journaled as executing.
func processPrecheck(p *Plan, o Options) *Result {
	if o.Processes == nil {
		return &Result{Outcome: "failed", Reason: "no_process_control", Detail: "this agent cannot end processes"}
	}
	s, err := ProcessStopParams(p.Params)
	if err != nil {
		return refuse("params_not_allowed", err.Error())
	}
	obs := map[string]string{"pid": strconv.FormatUint(uint64(s.PID), 10), "name": s.Name}
	if _, _, r := matchProcess(o, s, obs); r != nil {
		return r
	}
	return nil
}

func stopProcess(p *Plan, o Options) Result {
	r := started(o)
	s, err := ProcessStopParams(p.Params) // verified already; checked again before use
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "refused", "params_not_allowed", err.Error()
		return r
	}
	r.Observed["pid"], r.Observed["name"] = strconv.FormatUint(uint64(s.PID), 10), s.Name
	root, tree, refusal := matchProcess(o, s, r.Observed)
	if refusal != nil {
		refusal.ExecutedAt, refusal.AgentSHA256 = r.ExecutedAt, r.AgentSHA256
		return *refusal
	}
	journalStep(o, p, "ending")
	// The children first, the last-found first, so nothing is re-parented
	// out of reach; a child that cannot be ended is counted, not fatal.
	ended, childFailed := 0, 0
	for i := len(tree) - 1; i >= 0; i-- {
		switch err := o.Processes.Terminate(tree[i].PID, tree[i].Created, processTerminateTimeout); {
		case err == nil:
			ended++
		case errors.Is(err, ErrProcessChanged), errors.Is(err, ErrProcessGone):
			// It exited on its own (perhaps because its child did); not ours to count.
		default:
			childFailed++
		}
	}
	if s.Tree {
		r.Observed["children"] = strconv.Itoa(len(tree))
		r.Observed["childrenEnded"] = strconv.Itoa(ended)
		r.Observed["childrenFailed"] = strconv.Itoa(childFailed)
	}
	err = o.Processes.Terminate(root.PID, root.Created, processTerminateTimeout)
	switch {
	case errors.Is(err, ErrProcessChanged):
		r.Outcome, r.Reason, r.Detail = "refused", "process_changed", "that process id changed hands just before it was ended; it was not ended"
		return r
	case errors.Is(err, ErrProcessGone):
		r.Outcome, r.Reason, r.Detail = "no_change", "not_running", "the process exited before it was ended"
		r.Observed["stillRunning"] = "false"
		return r
	case err != nil:
		r.Outcome, r.Reason, r.Detail = "failed", "terminate_failed", trim(err.Error())
	}
	// Afterwards: is that process (that PID, created then) still there?
	all, lerr := o.Processes.Processes()
	still := lerr != nil
	for _, q := range all {
		if q.PID == root.PID && SameCreation(q.Created, s.StartedAt) {
			still = true
		}
	}
	r.Observed["stillRunning"] = strconv.FormatBool(still)
	switch {
	case r.Outcome == "failed":
	case still:
		r.Outcome, r.Reason, r.Detail = "failed", "still_running", "Windows accepted the request, but the process is still running"
	default:
		r.Outcome, r.Detail = "succeeded", "the process was ended and is no longer running"
		if s.Tree {
			r.Detail = "the process was ended, with " + strconv.Itoa(ended) + " of the " + strconv.Itoa(len(tree)) + " processes it started"
		}
	}
	return r
}

func processInterrupted(params map[string]any, o Options) map[string]string {
	s, err := ProcessStopParams(params)
	if err != nil || o.Processes == nil {
		return nil
	}
	all, err := o.Processes.Processes()
	if err != nil {
		return nil
	}
	for _, q := range all {
		if q.PID == s.PID && SameCreation(q.Created, s.StartedAt) {
			return map[string]string{"pid": strconv.FormatUint(uint64(s.PID), 10), "stillRunning": "true"}
		}
	}
	return map[string]string{"pid": strconv.FormatUint(uint64(s.PID), 10), "stillRunning": "false"}
}
