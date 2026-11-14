// Package patch is the agent's view of Windows Update (v0.27): what this
// computer is offered, what it has installed, whether something else manages
// its updates, and whether it is waiting for a restart.
//
// The Windows Update Agent is reached through a fixed PowerShell script
// compiled into the signed agent (wua.ps1). Nothing in it comes from the
// portal: the only input it ever takes is a list of update identities that
// this package has already validated, and its output is parsed here strictly
// and bounded. Every decision — which classifications may be installed, what
// counts as a competing update manager, what a result means — is made in Go,
// where it is tested, not in the script.
package patch

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/agit8or1/rem0te/windows-installer/internal/devsig"
)

// Script is the Windows Update Agent bridge (modes: scan, lookup, install).
//
//go:embed wua.ps1
var Script string

const (
	PostureSchema = "rem0te-patch-posture/1"
	MaxUpdates    = 100
	MaxHistory    = 50
	// MaxPerPlan is the most updates one approved plan may name.
	MaxPerPlan = 20
)

var guidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var kbRE = regexp.MustCompile(`^KB[0-9]{4,10}$`)

// ValidID reports whether s is a lowercase Windows Update identity GUID.
func ValidID(s string) bool { return guidRE.MatchString(s) }

// Identity names exactly one revision of one update.
type Identity struct {
	UpdateID string `json:"updateId"`
	Revision int    `json:"revision"`
}

func (i Identity) Key() string { return fmt.Sprintf("%s@%d", i.UpdateID, i.Revision) }

// Classification GUIDs are Microsoft's, stable across languages; names are
// localized and are shown, never trusted.
const (
	ClassSecurity      = "0fa1201d-4330-4fa8-8ae9-b877473b6441"
	ClassCritical      = "e6cf1350-c01b-414d-a61f-263d14d133b4"
	ClassUpdateRollups = "28bc880e-0592-4cbf-8f95-c79b17911d5f"
	ClassUpdates       = "cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83"
	ClassDrivers       = "ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0"
	ClassUpgrades      = "3689bdc8-b205-4af4-8d4a-a63924c5e9d5"
	ClassFeaturePacks  = "b54e7d24-7add-428f-8b75-90a396fa584f"
	ClassServicePacks  = "68c5b0a3-d1a6-4553-ae49-01d3a7827828"
	ClassTools         = "b4832bd8-e735-4761-8daf-37f882276dab"
	ClassDefinitions   = "e0789628-ce08-4437-be74-2495b842f43b"
)

// Installable is the allowlist. Feature upgrades, feature packs, service
// packs, tools and anything unclassified are never installed by an approved
// plan: they change what the computer is, not just how patched it is, and
// they are where a "patch" becomes an OS migration.
//
// Drivers and Definition Updates joined the list in 0.42. Both are what
// Windows Update itself installs unattended on a home computer, and the
// owner of one asked to choose them: a person picks them update by update,
// and a patch policy names them only if someone ticks them.
var Installable = map[string]string{
	ClassSecurity:      "Security Updates",
	ClassCritical:      "Critical Updates",
	ClassUpdateRollups: "Update Rollups",
	ClassUpdates:       "Updates",
	ClassDrivers:       "Drivers",
	ClassDefinitions:   "Definition Updates",
}

// UserInputTolerated is the classifications whose CanRequestUserInput flag
// does not refuse an update (0.42). Windows Update marks nearly every driver
// as one that *can* ask, and drivers install headless as SYSTEM in practice —
// on a real Windows 10 computer all eight offered drivers carried the flag.
// Every other class still refuses it: there, the flag means an installer that
// may stop and wait for someone who is not there.
var UserInputTolerated = map[string]bool{ClassDrivers: true}

// Update is one update Windows Update offers this computer now.
type Update struct {
	UpdateID       string `json:"updateId"`
	Revision       int    `json:"revision"`
	KB             string `json:"kb,omitempty"`
	Title          string `json:"title"`
	Classification string `json:"classification"`
	ClassName      string `json:"className,omitempty"`
	Severity       string `json:"severity,omitempty"`
	Downloaded     bool   `json:"downloaded"`
	// RebootBehavior: 0 never, 1 always requires, 2 can request.
	RebootBehavior int   `json:"rebootBehavior"`
	UserInput      bool  `json:"userInput"`
	EulaAccepted   bool  `json:"eulaAccepted"`
	BrowseOnly     bool  `json:"browseOnly"`
	SizeBytes      int64 `json:"sizeBytes"`
}

func (u Update) ID() Identity { return Identity{u.UpdateID, u.Revision} }

// Eligible decides whether an approved plan may install u. The reasons are
// stable strings the portal shows.
func Eligible(u Update) (bool, string) {
	if _, ok := Installable[u.Classification]; !ok {
		return false, "excluded_classification"
	}
	if u.BrowseOnly {
		return false, "optional_update"
	}
	if u.UserInput && !UserInputTolerated[u.Classification] {
		return false, "needs_user_input"
	}
	if !u.EulaAccepted {
		// Accepting a licence on someone's behalf is not a patch decision.
		return false, "eula_required"
	}
	return true, ""
}

// HistoryEntry is one line of Windows Update's own installation history.
type HistoryEntry struct {
	UpdateID string `json:"updateId"`
	Revision int    `json:"revision"`
	KB       string `json:"kb,omitempty"`
	Title    string `json:"title"`
	// Result: in_progress succeeded succeeded_with_errors failed aborted unknown
	Result    string `json:"result"`
	HResult   string `json:"hresult,omitempty"`
	Operation string `json:"operation"` // install | uninstall | other
	Date      string `json:"date"`
}

// Reboot is whether this computer is waiting for a restart, and who says so.
type Reboot struct {
	Pending bool     `json:"pending"`
	Sources []string `json:"sources"`
}

// Posture is what patch-scan writes and the heartbeat reports.
type Posture struct {
	Schema    string         `json:"schema"`
	ScannedAt string         `json:"scannedAt"`
	Updates   []Update       `json:"updates"`
	History   []HistoryEntry `json:"history"`
	Reboot    Reboot         `json:"reboot"`
	// Managers: whatever else decides this computer's updates. Non-empty
	// means an approved plan will be refused here (managed_elsewhere).
	Managers []string `json:"managers"`
	// AutoUpdate: Windows' own automatic updates (enabled | disabled | notify | unknown).
	AutoUpdate string `json:"autoUpdate"`
	Error      string `json:"error,omitempty"`
	// Signed (v0.34): this computer's signature over the facts of this scan
	// that a patch policy's ring gate reads (SignScan).
	Signed *devsig.Signed `json:"signed,omitempty"`
}

// Registry is the slice of the Windows registry and service list that
// manager and reboot detection read. Tests fake it.
type Registry interface {
	String(key, name string) (string, bool)
	DWord(key, name string) (uint32, bool)
	KeyExists(key string) bool
	ValueExists(key, name string) bool
	ServiceExists(name string) bool
}

const (
	wuPolicy = `SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`
	auPolicy = `SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU`
	mdmPol   = `SOFTWARE\Microsoft\PolicyManager\current\device\Update`
)

// Managers names what else controls updates on this computer. Installing
// approved updates underneath any of them would fight it: WSUS decides what is
// approved, Configuration Manager and Intune own the schedule, and Windows
// Update for Business deferrals are a customer's stated policy.
func Managers(r Registry) []string {
	var out []string
	if s, ok := r.String(wuPolicy, "WUServer"); ok && strings.TrimSpace(s) != "" {
		if v, ok := r.DWord(auPolicy, "UseWUServer"); ok && v == 1 {
			out = append(out, "wsus")
		}
	}
	for _, n := range []string{"DeferQualityUpdates", "DeferQualityUpdatesPeriodInDays", "DeferFeatureUpdates", "TargetReleaseVersion", "PauseQualityUpdatesStartTime", "SetDisableUXWUAccess", "SetPolicyDrivenUpdateSourceForQualityUpdates"} {
		if r.ValueExists(wuPolicy, n) {
			out = append(out, "wufb_policy")
			break
		}
	}
	for _, n := range []string{"DeferQualityUpdatesPeriodInDays", "PauseQualityUpdates", "ActiveHoursStart", "AllowAutoUpdate", "BranchReadinessLevel"} {
		if r.ValueExists(mdmPol, n) {
			out = append(out, "mdm_policy")
			break
		}
	}
	if r.ServiceExists("CcmExec") {
		out = append(out, "configmgr")
	}
	return dedupe(out)
}

// AutoUpdate reads Windows' automatic-update policy.
func AutoUpdate(r Registry) string {
	if v, ok := r.DWord(auPolicy, "NoAutoUpdate"); ok && v == 1 {
		return "disabled"
	}
	if v, ok := r.DWord(auPolicy, "AUOptions"); ok {
		switch v {
		case 2, 3:
			return "notify"
		case 4, 5:
			return "enabled"
		}
	}
	return "enabled"
}

// RebootSources lists every place Windows records a pending restart. Each is
// checked separately because each is set by a different installer.
func RebootSources(r Registry, wuaSays bool) []string {
	var out []string
	if r.KeyExists(`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`) {
		out = append(out, "component_servicing")
	}
	if r.KeyExists(`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`) {
		out = append(out, "windows_update")
	}
	if r.ValueExists(`SYSTEM\CurrentControlSet\Control\Session Manager`, "PendingFileRenameOperations") {
		out = append(out, "pending_file_rename")
	}
	if wuaSays {
		out = append(out, "update_agent")
	}
	return dedupe(out)
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// ── Script output ───────────────────────────────────────────────────────────

// ScanOut is wua.ps1's scan mode.
type ScanOut struct {
	Updates        []Update       `json:"updates"`
	History        []HistoryEntry `json:"history"`
	RebootRequired bool           `json:"rebootRequired"`
}

// LookupState is what lookup mode found for one requested identity.
type LookupState struct {
	UpdateID string  `json:"updateId"`
	Revision int     `json:"revision"`
	State    string  `json:"state"` // offered | installed | superseded | not_found
	Update   *Update `json:"update,omitempty"`
}
type LookupOut struct {
	Results []LookupState `json:"results"`
}

// InstallState is install mode's result for one identity.
type InstallState struct {
	UpdateID       string `json:"updateId"`
	Revision       int    `json:"revision"`
	Downloaded     bool   `json:"downloaded"`
	ResultCode     int    `json:"resultCode"` // 0 not started, 1 in progress, 2 succeeded, 3 with errors, 4 failed, 5 aborted
	HResult        string `json:"hresult,omitempty"`
	RebootRequired bool   `json:"rebootRequired"`
	Found          bool   `json:"found"`
}
type InstallOut struct {
	Results        []InstallState `json:"results"`
	RebootRequired bool           `json:"rebootRequired"`
	Error          string         `json:"error,omitempty"`
}

var hresRE = regexp.MustCompile(`^0x[0-9A-Fa-f]{1,8}$`)

func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(strings.NewReader(strings.TrimPrefix(string(b), "\ufeff")))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.More() {
		return errors.New("trailing data")
	}
	return nil
}

func clip(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	if len(s) > n {
		s = s[:n]
	}
	return strings.TrimSpace(s)
}

func cleanUpdate(u Update) (Update, bool) {
	u.UpdateID = strings.ToLower(u.UpdateID)
	if !ValidID(u.UpdateID) || u.Revision < 1 || u.Revision > 1_000_000 {
		return u, false
	}
	u.Classification = strings.ToLower(u.Classification)
	if u.Classification != "" && !ValidID(u.Classification) {
		u.Classification = ""
	}
	if !kbRE.MatchString(u.KB) {
		u.KB = ""
	}
	u.Title = clip(u.Title, 300)
	u.ClassName = clip(u.ClassName, 64)
	u.Severity = clip(u.Severity, 32)
	if u.RebootBehavior < 0 || u.RebootBehavior > 2 {
		u.RebootBehavior = 1
	}
	if u.SizeBytes < 0 {
		u.SizeBytes = 0
	}
	return u, true
}

var historyResults = map[string]bool{"in_progress": true, "succeeded": true, "succeeded_with_errors": true, "failed": true, "aborted": true, "unknown": true}

// ParseScan validates scan output. Malformed entries are dropped, not fixed.
func ParseScan(b []byte) (ScanOut, error) {
	var s ScanOut
	if err := strictJSON(b, &s); err != nil {
		return ScanOut{}, fmt.Errorf("scan output: %w", err)
	}
	ups := []Update{}
	for _, u := range s.Updates {
		if c, ok := cleanUpdate(u); ok && len(ups) < MaxUpdates {
			ups = append(ups, c)
		}
	}
	hist := []HistoryEntry{}
	for _, h := range s.History {
		h.UpdateID = strings.ToLower(h.UpdateID)
		if !ValidID(h.UpdateID) || len(hist) >= MaxHistory {
			continue
		}
		if !historyResults[h.Result] {
			h.Result = "unknown"
		}
		if h.Operation != "install" && h.Operation != "uninstall" {
			h.Operation = "other"
		}
		if !kbRE.MatchString(h.KB) {
			h.KB = ""
		}
		if !hresRE.MatchString(h.HResult) {
			h.HResult = ""
		}
		h.Title, h.Date = clip(h.Title, 300), clip(h.Date, 40)
		hist = append(hist, h)
	}
	s.Updates, s.History = ups, hist
	return s, nil
}

// ParseLookup validates lookup output against what was asked: an answer for
// an identity nobody asked about is an error, not extra information.
func ParseLookup(b []byte, asked []Identity) (map[string]LookupState, error) {
	var l LookupOut
	if err := strictJSON(b, &l); err != nil {
		return nil, fmt.Errorf("lookup output: %w", err)
	}
	want := map[string]bool{}
	for _, a := range asked {
		want[a.Key()] = true
	}
	out := map[string]LookupState{}
	for _, r := range l.Results {
		k := Identity{strings.ToLower(r.UpdateID), r.Revision}.Key()
		if !want[k] {
			return nil, fmt.Errorf("lookup answered for %s, which was not asked", k)
		}
		switch r.State {
		case "offered":
			if r.Update == nil {
				return nil, fmt.Errorf("lookup: %s offered without details", k)
			}
			c, ok := cleanUpdate(*r.Update)
			if !ok || c.ID().Key() != k {
				return nil, fmt.Errorf("lookup: %s details do not match", k)
			}
			r.Update = &c
		case "installed", "superseded", "not_found":
			r.Update = nil
		default:
			return nil, fmt.Errorf("lookup: unknown state %q", r.State)
		}
		r.UpdateID = strings.ToLower(r.UpdateID)
		out[k] = r
	}
	return out, nil
}

// ParseInstall validates install output against what was asked to install.
func ParseInstall(b []byte, asked []Identity) (InstallOut, error) {
	var in InstallOut
	if err := strictJSON(b, &in); err != nil {
		return InstallOut{}, fmt.Errorf("install output: %w", err)
	}
	want := map[string]bool{}
	for _, a := range asked {
		want[a.Key()] = true
	}
	for i, r := range in.Results {
		r.UpdateID = strings.ToLower(r.UpdateID)
		if !want[r.ID().Key()] {
			return InstallOut{}, fmt.Errorf("install reported %s, which was not asked", r.ID().Key())
		}
		if !hresRE.MatchString(r.HResult) {
			r.HResult = ""
		}
		in.Results[i] = r
	}
	in.Error = clip(in.Error, 200)
	return in, nil
}

func (r InstallState) ID() Identity { return Identity{r.UpdateID, r.Revision} }

// Outcome is the per-update result an approved install reports. The states
// are the ones the portal distinguishes; "effective" is never among them —
// that needs a later scan, after any restart, and is the portal's to derive.
type Outcome struct {
	UpdateID string `json:"updateId"`
	Revision int    `json:"revision"`
	KB       string `json:"kb,omitempty"`
	// State: installed restart_required already_installed superseded
	// not_offered excluded failed not_attempted
	State   string `json:"state"`
	Reason  string `json:"reason,omitempty"`
	HResult string `json:"hresult,omitempty"`
}
