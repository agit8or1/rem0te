package action

import (
	"math"
	"path/filepath"
	"strconv"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/flock"
	"github.com/agit8or1/rem0te/windows-installer/internal/patch"
)

// updateParamsOK: exactly {"updates": [{updateId, revision}, ...], "reboot": "never"},
// and optionally "allow" (0.32): a signed patch policy's narrowing, see updateFilter.
func updateParamsOK(p map[string]any) bool {
	_, _, err := updateParams(p)
	return err == nil
}

type paramErr string

func (e paramErr) Error() string { return string(e) }

func updateParams(p map[string]any) ([]patch.Identity, *patch.Filter, error) {
	_, hasAllow := p["allow"]
	want := 2
	if hasAllow {
		want = 3
	}
	if len(p) != want || p["reboot"] != "never" {
		return nil, nil, paramErr("params must be exactly updates, reboot=never and optionally allow")
	}
	list, ok := p["updates"].([]any)
	if !ok || len(list) < 1 || len(list) > patch.MaxPerPlan {
		return nil, nil, paramErr("updates must list 1 to " + strconv.Itoa(patch.MaxPerPlan) + " identities")
	}
	seen := map[string]bool{}
	out := make([]patch.Identity, 0, len(list))
	for _, e := range list {
		m, ok := e.(map[string]any)
		if !ok || len(m) != 2 {
			return nil, nil, paramErr("an update is exactly {updateId, revision}")
		}
		id, ok1 := m["updateId"].(string)
		rev, ok2 := m["revision"].(float64)
		if !ok1 || !ok2 || !patch.ValidID(id) || rev != math.Trunc(rev) || rev < 1 || rev > 1_000_000 {
			return nil, nil, paramErr("bad update identity")
		}
		i := patch.Identity{UpdateID: id, Revision: int(rev)}
		if seen[i.Key()] {
			return nil, nil, paramErr("duplicate update")
		}
		seen[i.Key()] = true
		out = append(out, i)
	}
	if !hasAllow {
		return out, nil, nil
	}
	f, err := updateFilter(p["allow"])
	if err != nil {
		return nil, nil, err
	}
	return out, f, nil
}

// updateFilter parses "allow": {"classifications": [...], "severities"?: [...],
// "excludeKbs"?: [...]}. Closed like everything else here: no other key, each
// list bounded, every value from a fixed set or a KB number. It can only
// narrow: a classification outside patch.Installable is refused, never added.
func updateFilter(v any) (*patch.Filter, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, paramErr("allow must be an object")
	}
	for k := range m {
		if k != "classifications" && k != "severities" && k != "excludeKbs" {
			return nil, paramErr("allow has an unknown field")
		}
	}
	strs := func(key string, max int, valid func(string) bool) ([]string, error) {
		raw, present := m[key]
		if !present {
			return nil, nil
		}
		l, ok := raw.([]any)
		if !ok || len(l) < 1 || len(l) > max {
			return nil, paramErr("allow." + key + " must list 1 to " + strconv.Itoa(max) + " values")
		}
		seen := map[string]bool{}
		out := make([]string, 0, len(l))
		for _, e := range l {
			s, ok := e.(string)
			if !ok || !valid(s) || seen[s] {
				return nil, paramErr("allow." + key + " has a bad or duplicate value")
			}
			seen[s] = true
			out = append(out, s)
		}
		return out, nil
	}
	f := &patch.Filter{}
	var err error
	if f.Classifications, err = strs("classifications", len(patch.Installable), func(s string) bool { _, ok := patch.Installable[s]; return ok }); err != nil {
		return nil, err
	}
	if len(f.Classifications) == 0 {
		return nil, paramErr("allow.classifications is required")
	}
	if f.Severities, err = strs("severities", len(patch.Severities), func(s string) bool { return patch.Severities[s] }); err != nil {
		return nil, err
	}
	if f.ExcludeKBs, err = strs("excludeKbs", 50, patch.ValidKB); err != nil {
		return nil, err
	}
	return f, nil
}

// WUALock serializes everything that drives the Windows Update Agent: a scan
// and an install, or two installs, must not run at once.
func WUALock(stateDir string) string { return filepath.Join(stateDir, "patch", "wua.lock") }

func installUpdates(p *Plan, o Options) Result {
	r := Result{ExecutedAt: o.now().UTC().Format(time.RFC3339), Observed: map[string]string{}}
	if s, err := o.Platform.SelfSHA256(); err == nil {
		r.AgentSHA256 = s
	}
	ids, filter, _ := updateParams(p.Params) // verified already
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
	rep := patch.InstallFiltered(o.WUA, o.Registry, ids, filter)
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
