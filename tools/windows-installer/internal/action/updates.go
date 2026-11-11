package action

import (
	"math"
	"path/filepath"
	"strconv"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

// updateParamsOK: exactly {"updates": [{updateId, revision}, ...], "reboot": "never"}.
func updateParamsOK(p map[string]any) bool {
	_, err := updateIDs(p)
	return err == nil
}

type paramErr string

func (e paramErr) Error() string { return string(e) }

func updateIDs(p map[string]any) ([]patch.Identity, error) {
	if len(p) != 2 || p["reboot"] != "never" {
		return nil, paramErr("params must be exactly updates and reboot=never")
	}
	list, ok := p["updates"].([]any)
	if !ok || len(list) < 1 || len(list) > patch.MaxPerPlan {
		return nil, paramErr("updates must list 1 to " + strconv.Itoa(patch.MaxPerPlan) + " identities")
	}
	seen := map[string]bool{}
	out := make([]patch.Identity, 0, len(list))
	for _, e := range list {
		m, ok := e.(map[string]any)
		if !ok || len(m) != 2 {
			return nil, paramErr("an update is exactly {updateId, revision}")
		}
		id, ok1 := m["updateId"].(string)
		rev, ok2 := m["revision"].(float64)
		if !ok1 || !ok2 || !patch.ValidID(id) || rev != math.Trunc(rev) || rev < 1 || rev > 1_000_000 {
			return nil, paramErr("bad update identity")
		}
		i := patch.Identity{UpdateID: id, Revision: int(rev)}
		if seen[i.Key()] {
			return nil, paramErr("duplicate update")
		}
		seen[i.Key()] = true
		out = append(out, i)
	}
	return out, nil
}

// WUALock serializes everything that drives the Windows Update Agent: a scan
// and an install, or two installs, must not run at once.
func WUALock(stateDir string) string { return filepath.Join(stateDir, "patch", "wua.lock") }

func installUpdates(p *Plan, o Options) Result {
	r := Result{ExecutedAt: o.now().UTC().Format(time.RFC3339), Observed: map[string]string{}}
	if s, err := o.Platform.SelfSHA256(); err == nil {
		r.AgentSHA256 = s
	}
	ids, _ := updateIDs(p.Params) // verified already
	if o.WUA == nil || o.Registry == nil {
		r.Outcome, r.Reason, r.Detail = "failed", "no_update_agent", "this agent cannot reach Windows Update"
		return r
	}
	wait := o.WUAWait
	if wait == 0 {
		wait = 20 * time.Minute
	}
	every := 5 * time.Second
	if wait < 10*every {
		every = wait / 10
	}
	l, err := flock.Wait(WUALock(o.StateDir), wait, every)
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "update_agent_busy", "Windows Update was busy with another scan or install; nothing was attempted"
		return r
	}
	defer l.Release()
	rep := patch.Install(o.WUA, o.Registry, ids)
	r.Reboot = &rep.Reboot
	r.Observed["rebootPending"] = strconv.FormatBool(rep.Reboot.Pending)
	if rep.Refusal != "" {
		r.Outcome, r.Reason, r.Detail = "refused", rep.Refusal, rep.Detail
		return r
	}
	r.Updates = rep.Outcomes
	r.Outcome = patch.Overall(rep)
	switch r.Outcome {
	case "succeeded":
		r.Detail = "every eligible update installed; no restart needed"
	case "restart_required":
		r.Detail = "installed; the computer must restart for the updates to take effect. It was not restarted."
	case "no_change":
		r.Detail = "nothing was installed: every update was already installed, superseded, not offered or excluded"
	case "uncertain":
		r.Detail = "the installer did not report every result; check the computer before trying again"
	}
	return r
}

// updatesNow reports what a restart check can see without touching Windows
// Update, for a job interrupted mid-install.
func updatesNow(_ map[string]any, o Options) map[string]string {
	if o.Registry == nil {
		return nil
	}
	s := patch.RebootSources(o.Registry, false)
	out := map[string]string{"rebootPending": strconv.FormatBool(len(s) > 0)}
	if len(s) > 0 {
		out["rebootSources"] = joinComma(s)
	}
	return out
}

func joinComma(s []string) string {
	out := ""
	for i, v := range s {
		if i > 0 {
			out += ","
		}
		out += v
	}
	return out
}
