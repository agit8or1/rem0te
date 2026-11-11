package action

import "time"

// The agent's copy of the catalog (v0.26). It is compiled in, so a plan can
// only ever name something this file implements: there is no command, script,
// path or URL parameter anywhere, and no way to add one without shipping a new
// signed agent build through the offline-rooted update chain.
//
// Keep in step with apps/api/src/actions/catalog.ts; the portal and signer
// copy decides what can be proposed, this copy decides what can run.

// ServiceName is the only service windows.service.start touches.
// windows.service.restart has its own allowlist (RestartableServices).
const ServiceName = "Spooler"

// MinApprovals by risk; the same numbers as APPROVALS_REQUIRED in the portal.
var MinApprovals = map[string]int{"low": 1, "high": 2}

type Action struct {
	ID       string
	Version  int
	ParamsOK func(map[string]any) bool
	// Risk from this machine's own product type and the plan's target count:
	// anything but one workstation is high impact, whatever the plan claims.
	Risk func(productType, targets int) string
	// MaxTargets: how many computers one signed plan may name.
	MaxTargets int
	// MaxWindow: the longest signed window this action accepts (0: no
	// limit beyond the portal's 24 hours). A restart must not land hours
	// after the time its approvers had in mind.
	MaxWindow time.Duration
	// Precheck, if set, runs after every verification and the signed pause,
	// before the job is journaled as executing. It only reads; a non-nil
	// Result ends the job there (final, like a refusal).
	Precheck func(p *Plan, o Options) *Result
	// Execute runs the verified plan. Observations only.
	Execute func(p *Plan, o Options) Result
	// Interrupted describes the computer now, for a job whose journal says it
	// was executing when the agent stopped. It must not change anything.
	// params are the plan's, as journaled; check them before use.
	Interrupted func(params map[string]any, o Options) map[string]string
}

var catalog = []Action{
	{
		ID: "windows.service.start", Version: 1, MaxTargets: 1,
		ParamsOK: func(p map[string]any) bool {
			if len(p) != 1 {
				return false
			}
			s, ok := p["service"].(string)
			return ok && s == ServiceName
		},
		Risk: func(pt, n int) string {
			if pt == 1 && n == 1 {
				return "low"
			}
			return "high"
		},
		Execute: startSpooler,
		Interrupted: func(_ map[string]any, o Options) map[string]string {
			if st, err := o.Platform.ServiceState(ServiceName); err == nil {
				return map[string]string{"now": st}
			}
			return nil
		},
	},
	{
		// Install named Windows updates (v0.27). Software installation is high
		// impact on any computer: two approvers, always. The parameters name
		// update identities and nothing else — no URL, package, path or
		// script — and "reboot" admits one value, so a plan can never restart
		// a computer in this release.
		ID: "windows.update.install", Version: 1, MaxTargets: MaxRingTargets,
		ParamsOK:    updateParamsOK,
		Risk:        func(int, int) string { return "high" },
		Execute:     installUpdates,
		Interrupted: updatesNow,
	},
	{
		// Restart one service from RestartableServices (v0.32). High impact
		// on any computer: two approvers, always. Restarting RustDesk drops
		// whoever is connected, so that one waits for no open session.
		ID: "windows.service.restart", Version: 1, MaxTargets: 1,
		ParamsOK:    func(p map[string]any) bool { return RestartService(p) != "" },
		Risk:        func(int, int) string { return "high" },
		Precheck:    restartPrecheck,
		Execute:     restartService,
		Interrupted: restartInterrupted,
	},
	{
		// Schedule a restart after a warning of 5 minutes to 24 hours
		// (v0.32). Never immediate; the message is fixed text; skipped while a
		// RustDesk session is open or when that cannot be told.
		ID: "windows.reboot.schedule", Version: 1, MaxTargets: 1, MaxWindow: 2 * time.Hour,
		ParamsOK:    func(p map[string]any) bool { return RestartDelay(p) != 0 },
		Risk:        func(int, int) string { return "high" },
		Precheck:    sessionCheck("the restart"),
		Execute:     scheduleRestart,
		Interrupted: scheduleInterrupted,
	},
	{
		// Cancel a pending restart (v0.32). No parameters at all.
		ID: "windows.reboot.cancel", Version: 1, MaxTargets: 1,
		ParamsOK:    func(p map[string]any) bool { return len(p) == 0 },
		Risk:        func(int, int) string { return "high" },
		Precheck:    needMaint,
		Execute:     cancelRestart,
		Interrupted: func(map[string]any, Options) map[string]string { return nil },
	},
	{
		// Collect the fixed LogSources, bounded and redacted (v0.32). No
		// parameters: nothing can name a file, a log or a time range.
		ID: "windows.logs.collect", Version: 1, MaxTargets: 1,
		ParamsOK:    func(p map[string]any) bool { return len(p) == 0 },
		Risk:        func(int, int) string { return "high" },
		Precheck:    needMaint,
		Execute:     collectLogs,
		Interrupted: func(map[string]any, Options) map[string]string { return nil },
	},
	{
		// Install one allowlisted winget package at an exact version, pinned
		// by installer hash (v0.34). High impact on any computer: two
		// approvers, always. The agent hashes the downloaded installer
		// itself before winget installs anything (software.go).
		ID: "windows.software.install", Version: 1, MaxTargets: MaxRingTargets,
		ParamsOK:    softwareParamsOK,
		Risk:        func(int, int) string { return "high" },
		Precheck:    softwarePrecheck(false),
		Execute:     installSoftware,
		Interrupted: softwareInterrupted,
	},
	{
		// Uninstall that package (v0.34). Same closed parameters.
		ID: "windows.software.uninstall", Version: 1, MaxTargets: MaxRingTargets,
		ParamsOK:    softwareParamsOK,
		Risk:        func(int, int) string { return "high" },
		Precheck:    softwarePrecheck(true),
		Execute:     uninstallSoftware,
		Interrupted: softwareInterrupted,
	},
}

func needMaint(_ *Plan, o Options) *Result {
	if o.Maint == nil {
		return &Result{Outcome: "failed", Reason: "no_maintenance", Detail: "this agent cannot perform maintenance actions"}
	}
	return nil
}

// MaxRingTargets is the most computers one signed patch plan (one ring) may name.
const MaxRingTargets = 25

func Lookup(id string, version int) *Action {
	for i := range catalog {
		if catalog[i].ID == id && catalog[i].Version == version {
			return &catalog[i]
		}
	}
	return nil
}

// Supported is what the heartbeat reports, as "id@version".
func Supported() []string {
	out := make([]string, 0, len(catalog))
	for _, a := range catalog {
		out = append(out, a.ID+"@"+itoa(a.Version))
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
