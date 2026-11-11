package patch

import (
	"time"
)

// WUA runs one mode of wua.ps1 and returns its JSON output. The Windows
// implementation is in the agent; tests and the simulator fake it.
type WUA interface {
	Run(mode string, ids []Identity) ([]byte, error)
}

// Scan builds this computer's posture. A failed scan still reports what the
// registry says, with the error, rather than nothing.
func Scan(w WUA, reg Registry, now time.Time) Posture {
	p := Posture{Schema: PostureSchema, ScannedAt: now.UTC().Format("2006-01-02T15:04:05.000Z07:00"), Updates: []Update{}, History: []HistoryEntry{},
		Managers: Managers(reg), AutoUpdate: AutoUpdate(reg)}
	raw, err := w.Run("scan", nil)
	var s ScanOut
	if err == nil {
		s, err = ParseScan(raw)
	}
	if err != nil {
		p.Error = clip(err.Error(), 200)
		p.Reboot = Reboot{Sources: RebootSources(reg, false)}
	} else {
		p.Updates, p.History = s.Updates, s.History
		p.Reboot = Reboot{Sources: RebootSources(reg, s.RebootRequired)}
	}
	p.Reboot.Pending = len(p.Reboot.Sources) > 0
	return p
}

// Report is what an approved install observed.
type Report struct {
	// Refusal is set when nothing was attempted: managed_elsewhere, lookup_failed.
	Refusal  string
	Detail   string
	Outcomes []Outcome
	Reboot   Reboot
}

// Install installs exactly the approved identities that this computer is
// offered and that Eligible allows, and nothing else. It never restarts.
func Install(w WUA, reg Registry, ids []Identity) Report { return InstallFiltered(w, reg, ids, nil) }

// InstallFiltered is Install with a signed plan's own narrowing (0.32): a
// plan signed under a patch policy names the classifications, severities and
// excluded KBs that policy allows, and the computer applies them to Windows
// Update's own answer — not to the titles and classes the portal displayed.
// A nil filter narrows nothing beyond Eligible.
func InstallFiltered(w WUA, reg Registry, ids []Identity, f *Filter) Report {
	r := Report{Outcomes: []Outcome{}}
	if m := Managers(reg); len(m) > 0 {
		r.Refusal, r.Detail = "managed_elsewhere", "updates on this computer are managed by: "+join(m)
		r.Reboot = reboot(reg, false)
		return r
	}
	raw, err := w.Run("lookup", ids)
	var found map[string]LookupState
	if err == nil {
		found, err = ParseLookup(raw, ids)
	}
	if err != nil {
		r.Refusal, r.Detail = "lookup_failed", clip(err.Error(), 200)
		r.Reboot = reboot(reg, false)
		return r
	}

	byKey := map[string]int{}
	var install []Identity
	for _, id := range ids {
		o := Outcome{UpdateID: id.UpdateID, Revision: id.Revision}
		st, ok := found[id.Key()]
		switch {
		case !ok || st.State == "not_found":
			o.State, o.Reason = "not_offered", "Windows Update does not offer this update to this computer"
		case st.State == "installed":
			o.State = "already_installed"
		case st.State == "superseded":
			o.State, o.Reason = "superseded", "a newer update replaces it"
		default: // offered
			o.KB = st.Update.KB
			if ok, why := Eligible(*st.Update); !ok {
				o.State, o.Reason = "excluded", why
			} else if ok, why := f.Allows(*st.Update); !ok {
				o.State, o.Reason = "excluded", why
			} else {
				o.State = "not_attempted"
				install = append(install, id)
			}
		}
		byKey[id.Key()] = len(r.Outcomes)
		r.Outcomes = append(r.Outcomes, o)
	}
	if len(install) == 0 {
		r.Reboot = reboot(reg, false)
		return r
	}

	raw, err = w.Run("install", install)
	var out InstallOut
	if err == nil {
		out, err = ParseInstall(raw, install)
	}
	if err != nil {
		// The script may have died half-way through: what was installed is
		// not known, and saying "failed" would invite a blind retry.
		for _, id := range install {
			o := &r.Outcomes[byKey[id.Key()]]
			o.State, o.Reason = "unknown", "the installer did not report: "+clip(err.Error(), 120)
		}
		r.Reboot = reboot(reg, false)
		return r
	}
	seen := map[string]bool{}
	for _, res := range out.Results {
		o := &r.Outcomes[byKey[res.ID().Key()]]
		seen[res.ID().Key()] = true
		o.HResult = res.HResult
		switch {
		case !res.Found:
			o.State, o.Reason = "not_offered", "no longer offered when the install began"
		case res.ResultCode == 2 && res.RebootRequired:
			o.State = "restart_required"
		case res.ResultCode == 2:
			o.State = "installed"
		case res.ResultCode == 3:
			// "Succeeded with errors" is not a success to build a rollout on.
			o.State, o.Reason = "failed", "completed_with_errors"
		case res.ResultCode == 4:
			o.State, o.Reason = "failed", "install_failed"
		case res.ResultCode == 5:
			o.State, o.Reason = "failed", "install_aborted"
		default:
			o.State, o.Reason = "unknown", "Windows did not report a result"
		}
		if (o.State == "failed" || o.State == "unknown") && out.Error != "" {
			o.Reason += ": " + out.Error
		}
	}
	for _, id := range install {
		if !seen[id.Key()] {
			o := &r.Outcomes[byKey[id.Key()]]
			o.State, o.Reason = "unknown", "the installer did not report this update"
		}
	}
	r.Reboot = reboot(reg, out.RebootRequired)
	return r
}

// Filter is a signed plan's narrowing of what may be installed (0.32). It can
// only remove updates from what Eligible allows; it can never add one.
type Filter struct {
	// Classifications: a non-empty subset of Installable.
	Classifications []string
	// Severities: if set, the MSRC severity must be one of these. An update
	// Windows reports no severity for counts as "Unrated".
	Severities []string
	// ExcludeKBs: updates Windows reports under one of these KBs are refused.
	ExcludeKBs []string
}

// Severities a filter may name.
var Severities = map[string]bool{"Critical": true, "Important": true, "Moderate": true, "Low": true, "Unrated": true}

// Allows reports whether f lets u through, and the stable reason if not.
func (f *Filter) Allows(u Update) (bool, string) {
	if f == nil {
		return true, ""
	}
	if !has(f.Classifications, u.Classification) {
		return false, "classification_not_in_policy"
	}
	if len(f.Severities) > 0 {
		s := u.Severity
		if s == "" {
			s = "Unrated"
		}
		if !has(f.Severities, s) {
			return false, "severity_not_in_policy"
		}
	}
	if u.KB != "" && has(f.ExcludeKBs, u.KB) {
		return false, "kb_excluded_by_policy"
	}
	return true, ""
}

// ValidKB reports whether s is a KB number as Windows Update reports one.
func ValidKB(s string) bool { return kbRE.MatchString(s) }

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func reboot(reg Registry, wuaSays bool) Reboot {
	s := RebootSources(reg, wuaSays)
	return Reboot{Pending: len(s) > 0, Sources: s}
}

// Overall reduces per-update outcomes to the job's outcome:
//
//	uncertain        something's result is not known — reconcile before retrying
//	failed / partial nothing / not everything that was attempted succeeded
//	restart_required everything attempted succeeded; a restart is needed for it to take effect
//	succeeded        everything attempted is installed
//	no_change        nothing needed or was allowed to be installed
func Overall(r Report) string {
	var inst, fail, unk, restart int
	for _, o := range r.Outcomes {
		switch o.State {
		case "installed":
			inst++
		case "restart_required":
			inst++
			restart++
		case "failed":
			fail++
		case "unknown":
			unk++
		}
	}
	switch {
	case unk > 0:
		return "uncertain"
	case fail > 0 && inst > 0:
		return "partial"
	case fail > 0:
		return "failed"
	case restart > 0 || (inst > 0 && r.Reboot.Pending):
		return "restart_required"
	case inst > 0:
		return "succeeded"
	default:
		return "no_change"
	}
}

func join(s []string) string {
	out := ""
	for i, v := range s {
		if i > 0 {
			out += ", "
		}
		out += v
	}
	return out
}
