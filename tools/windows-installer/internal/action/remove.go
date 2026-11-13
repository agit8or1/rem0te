package action

// Removing an installed program (0.41): windows.software.remove@1. The
// software catalog's uninstall (software.go) removes only what winget
// installed from a catalog entry; this removes anything Programs and
// Features lists, named by its HKLM uninstall key.
//
// The parameters are closed like everything else in the catalog — the key's
// name, which registry view it is in ("64" or "32"), and the DisplayName the
// portal's inventory showed — and the plan never carries a command. The
// agent reads the key ITSELF and decides from what it finds:
//   - the key is gone: nothing to do (no_change);
//   - its DisplayName is not the one the plan names: refused, program_changed
//     (the key now belongs to something else, or was replaced);
//   - an MSI product ({GUID} key, WindowsInstaller = 1): msiexec.exe from
//     System32 with exactly /x {GUID} /qn /norestart;
//   - otherwise only the key's QuietUninstallString, run without a shell:
//     an absolute path to an .exe (never an interpreter or a system tool)
//     and the arguments the installer registered. A key with only an
//     interactive UninstallString is refused, no_silent_uninstall — nothing
//     is ever run that would wait for someone to click.
// Afterwards the key must be gone for the result to be "succeeded".
//
// This package starts no process: ProgramRegistry.Remove does, on Windows
// (software_remove_windows.go), from a RemovalCommand built here.

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ProgramRegistry reads one uninstall key and runs a removal.
type ProgramRegistry interface {
	// Program reads HKLM\…\Uninstall\<key> in one view ("64" or "32").
	// found is false (and err nil) when the key does not exist.
	Program(view, key string) (p Program, found bool, err error)
	// Remove runs c and waits at most timeout: the exit code, bounded output,
	// and an error only when it could not run or was killed at the timeout.
	Remove(c RemovalCommand, timeout time.Duration) (int, []byte, error)
}

// Program is what one uninstall key says.
type Program struct {
	DisplayName, DisplayVersion, UninstallString, QuietUninstallString string
	WindowsInstaller                                                   bool
}

// RemovalCommand is one of two closed forms.
type RemovalCommand struct {
	// Kind: "msi" (System32\msiexec.exe /x ProductCode /qn /norestart) or
	// "quiet" (Exe, with Args as the installer registered them).
	Kind        string
	ProductCode string
	Exe         string
	Args        string
}

// MsiArgs is the one argument list msiexec is ever given.
func MsiArgs(productCode string) []string {
	return []string{"/x", productCode, "/qn", "/norestart"}
}

var (
	// ProgramKeyRE: an uninstall subkey name. No backslash: one key, never a path.
	ProgramKeyRE = regexp.MustCompile(`^[A-Za-z0-9{}][A-Za-z0-9{}()._+ ,&'!-]{0,127}$`)
	// ProgramNameRE: the DisplayName the plan expects. Compared, never run.
	ProgramNameRE = regexp.MustCompile(`^[^\x00-\x1f\x7f"<>\\]{1,200}$`)
	productCodeRE = regexp.MustCompile(`^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$`)
	msiInQuietRE  = regexp.MustCompile(`(?i)^"?(?:[A-Za-z]:\\Windows\\(?:System32|SysWOW64)\\)?msiexec(?:\.exe)?"?\s+/[XI]\s*(\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\})(?:\s+/(?:qn|quiet|passive|norestart|qb!?|qb-!?))*\s*$`)
	absExeRE      = regexp.MustCompile(`^[A-Za-z]:\\[^"*?<>|/:]+\.[Ee][Xx][Ee]$`)
)

// NeverRun: programs a QuietUninstallString may name but the agent never
// starts — interpreters, script hosts and system tools that would turn a
// registry value into arbitrary execution.
var NeverRun = []string{"cmd.exe", "powershell.exe", "pwsh.exe", "powershell_ise.exe", "wscript.exe", "cscript.exe", "mshta.exe", "rundll32.exe",
	"regsvr32.exe", "msiexec.exe", "bash.exe", "wsl.exe", "conhost.exe", "explorer.exe", "schtasks.exe", "sc.exe", "reg.exe", "regedit.exe",
	"certutil.exe", "bitsadmin.exe", "msbuild.exe", "installutil.exe", "regasm.exe", "regsvcs.exe", "wmic.exe", "forfiles.exe", "taskkill.exe", "net.exe", "net1.exe"}

// Default timeout and how long the key may take to go after the uninstaller
// exits (NSIS uninstallers copy themselves to %TEMP% and return at once).
const (
	removeTimeout     = 30 * time.Minute
	removeSettleTries = 24
	removeSettleEvery = 5 * time.Second
)

// Exit codes msiexec uses.
const (
	msiRebootRequired  = 3010
	msiRebootInitiated = 1641
	msiUnknownProduct  = 1605
)

// RemoveSpec is a verified plan's parameters.
type RemoveSpec struct{ Key, View, DisplayName string }

// ValidProgramName: the DisplayName charset, with no leading or trailing space.
func ValidProgramName(s string) bool {
	return ProgramNameRE.MatchString(s) && strings.TrimSpace(s) == s
}

// RemoveParams parses exactly {key, view, displayName}.
func RemoveParams(p map[string]any) (*RemoveSpec, error) {
	if !exactKeys(p, "key", "view", "displayName") {
		return nil, paramErr("params must be exactly key, view and displayName")
	}
	s := &RemoveSpec{}
	var ok bool
	if s.Key, ok = strField(p, "key"); !ok || !ProgramKeyRE.MatchString(s.Key) {
		return nil, paramErr("bad key")
	}
	if s.View, ok = strField(p, "view"); !ok || (s.View != "64" && s.View != "32") {
		return nil, paramErr("view must be 64 or 32")
	}
	if s.DisplayName, ok = strField(p, "displayName"); !ok || !ValidProgramName(s.DisplayName) {
		return nil, paramErr("bad displayName")
	}
	return s, nil
}

func removeParamsOK(p map[string]any) bool {
	_, err := RemoveParams(p)
	return err == nil
}

// isMSI: a Windows Installer product, removed through msiexec by its code.
func isMSI(key string, pr Program) bool { return pr.WindowsInstaller && productCodeRE.MatchString(key) }

// ParseQuietUninstall splits a QuietUninstallString into the program it
// names and the rest of the command line, or says why it is refused. A
// QuietUninstallString that is an msiexec removal of one product code
// becomes the msi form (the agent's own msiexec, its own arguments).
func ParseQuietUninstall(s string) (RemovalCommand, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return RemovalCommand{}, errors.New("empty")
	}
	if len(s) > 1024 {
		return RemovalCommand{}, errors.New("longer than 1024 characters")
	}
	for _, c := range s {
		if c < 0x20 || c == 0x7f {
			return RemovalCommand{}, errors.New("control character")
		}
	}
	if m := msiInQuietRE.FindStringSubmatch(s); m != nil {
		return RemovalCommand{Kind: "msi", ProductCode: strings.ToUpper(m[1])}, nil
	}
	if strings.Contains(strings.ToLower(s), "msiexec") {
		return RemovalCommand{}, errors.New("an msiexec command other than /x of one product code")
	}
	// No environment variables, no shell operators: nothing here is run by a
	// shell, and nothing may look as if it were.
	if strings.ContainsAny(s, "%&|<>^`\n") {
		return RemovalCommand{}, errors.New("environment variables or shell operators")
	}
	var exe, rest string
	if strings.HasPrefix(s, `"`) {
		end := strings.Index(s[1:], `"`)
		if end < 0 {
			return RemovalCommand{}, errors.New("unterminated quote")
		}
		exe, rest = s[1:1+end], s[2+end:]
		if rest != "" && !strings.HasPrefix(rest, " ") {
			return RemovalCommand{}, errors.New("text straight after the quoted program")
		}
	} else if i := strings.IndexByte(s, ' '); i >= 0 {
		exe, rest = s[:i], s[i:]
	} else {
		exe = s
	}
	rest = strings.TrimSpace(rest)
	if !absExeRE.MatchString(exe) {
		return RemovalCommand{}, errors.New("the program is not an absolute path to an .exe")
	}
	for _, seg := range strings.Split(exe, `\`) {
		if seg == "" || seg == "." || seg == ".." || strings.HasSuffix(seg, " ") || strings.HasSuffix(seg, ".") {
			return RemovalCommand{}, errors.New("a relative or trimmed path segment")
		}
	}
	base := strings.ToLower(exe[strings.LastIndexByte(exe, '\\')+1:])
	for _, n := range NeverRun {
		if base == n {
			return RemovalCommand{}, fmt.Errorf("it names %s, which this agent never runs", base)
		}
	}
	return RemovalCommand{Kind: "quiet", Exe: exe, Args: rest}, nil
}

// removalFor: what would remove this program, or the refusal.
func removalFor(key string, pr Program) (RemovalCommand, *Result) {
	if isMSI(key, pr) {
		return RemovalCommand{Kind: "msi", ProductCode: strings.ToUpper(key)}, nil
	}
	if strings.TrimSpace(pr.QuietUninstallString) == "" {
		d := "the program registers no uninstall command"
		if strings.TrimSpace(pr.UninstallString) != "" {
			d = "the program registers only an interactive uninstall (UninstallString, no QuietUninstallString); it would wait for someone at the computer, so it is not run"
		}
		return RemovalCommand{}, &Result{Outcome: "refused", Reason: "no_silent_uninstall", Detail: d}
	}
	c, err := ParseQuietUninstall(pr.QuietUninstallString)
	if err != nil {
		return RemovalCommand{}, &Result{Outcome: "refused", Reason: "uninstall_command_refused", Detail: "the QuietUninstallString is not run: " + trim(err.Error())}
	}
	// An msiexec removal must be of this key's own product.
	if c.Kind == "msi" && !strings.EqualFold(c.ProductCode, key) {
		return RemovalCommand{}, &Result{Outcome: "refused", Reason: "uninstall_command_refused", Detail: "the QuietUninstallString removes a different Windows Installer product from this key's; it is not run"}
	}
	return c, nil
}

// readProgram: the key, and a refusal when it changed or cannot be read.
func readProgram(o Options, s *RemoveSpec, obs map[string]string) (Program, bool, *Result) {
	pr, found, err := o.Programs.Program(s.View, s.Key)
	if err != nil {
		return pr, false, &Result{Outcome: "not_executed", Reason: "registry_unreadable", Observed: obs, Detail: "the uninstall key could not be read: " + trim(err.Error())}
	}
	if found && strings.TrimSpace(pr.DisplayName) != s.DisplayName {
		obs["displayNameNow"] = clip80(pr.DisplayName)
		return pr, true, &Result{Outcome: "refused", Reason: "program_changed", Observed: obs,
			Detail: "the uninstall key names a different program from the one this plan was made for; nothing was run"}
	}
	return pr, found, nil
}

// removePrecheck runs after the signed pause and before the executing journal
// entry. It only reads.
func removePrecheck(p *Plan, o Options) *Result {
	if o.Programs == nil {
		return &Result{Outcome: "failed", Reason: "no_software", Detail: "this agent cannot remove programs"}
	}
	s, err := RemoveParams(p.Params)
	if err != nil {
		return &Result{Outcome: "refused", Reason: "params_not_allowed", Detail: err.Error()}
	}
	obs := map[string]string{"key": clip80(s.Key), "view": s.View}
	if o.Software != nil {
		if m := o.Software.AppManagers(); len(m) > 0 {
			obs["managers"] = clip80(strings.Join(m, ","))
			return &Result{Outcome: "refused", Reason: "managed_elsewhere", Observed: obs,
				Detail: "applications on this computer are managed by " + strings.Join(m, ", ") + "; remove it there"}
		}
	}
	pr, found, bad := readProgram(o, s, obs)
	if bad != nil {
		return bad
	}
	if !found {
		obs["presentBefore"] = "false"
		return &Result{Outcome: "no_change", Observed: obs, ExecutedAt: o.now().UTC().Format(time.RFC3339), Detail: "the uninstall key is not there; nothing was run"}
	}
	if _, refused := removalFor(s.Key, pr); refused != nil {
		refused.Observed = obs
		return refused
	}
	return nil
}

func removeProgram(p *Plan, o Options) Result {
	r := started(o)
	s, err := RemoveParams(p.Params) // verified already; checked again before use
	if err != nil || o.Programs == nil {
		r.Outcome, r.Reason, r.Detail = "refused", "params_not_allowed", "the parameters are outside this agent's catalog"
		return r
	}
	r.Observed["key"], r.Observed["view"] = clip80(s.Key), s.View
	pr, found, bad := readProgram(o, s, r.Observed)
	if bad != nil {
		bad.ExecutedAt, bad.AgentSHA256 = r.ExecutedAt, r.AgentSHA256
		return *bad
	}
	if !found {
		r.Outcome, r.Detail = "no_change", "the uninstall key is not there; nothing was run"
		r.Observed["presentBefore"] = "false"
		return r
	}
	r.Observed["presentBefore"], r.Observed["versionBefore"] = "true", clip80(pr.DisplayVersion)
	c, refused := removalFor(s.Key, pr)
	if refused != nil {
		refused.Observed, refused.ExecutedAt, refused.AgentSHA256 = r.Observed, r.ExecutedAt, r.AgentSHA256
		return *refused
	}
	r.Observed["method"] = c.Kind
	if c.Kind == "quiet" {
		r.Observed["program"] = clip80(c.Exe[strings.LastIndexByte(c.Exe, '\\')+1:])
	}
	journalStep(o, p, "removing")
	code, out, err := o.Programs.Remove(c, swTimeout(o, removeTimeout))
	if isTimeout(err) {
		r.Outcome, r.Reason, r.Detail = "uncertain", "timeout", "the uninstaller did not finish in time and was stopped; it may have changed the computer"
		r.Observed["presentNow"] = presence(o, s)
		return r
	}
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "uninstall_failed", "the uninstaller could not be run: "+trim(err.Error())
		return r
	}
	r.Observed["exitCode"] = fmt.Sprint(code)
	journalStep(o, p, "detecting")
	present := presence(o, s)
	for i := 0; present == "true" && i < removeSettleTries && (code == 0 || c.Kind == "quiet"); i++ {
		o.Platform.Sleep(removeSettleEvery)
		present = presence(o, s)
	}
	r.Observed["presentAfter"] = present
	r.Observed["effective"] = fmt.Sprint(present == "false")
	reboot := c.Kind == "msi" && (code == msiRebootRequired || code == msiRebootInitiated)
	r.Observed["rebootRequired"] = fmt.Sprint(reboot)
	switch {
	case present == "false":
		r.Outcome, r.Detail = "succeeded", "removed; the uninstall key is gone"
		if code != 0 && !(c.Kind == "msi" && code == msiUnknownProduct) && !reboot {
			r.Detail += fmt.Sprintf(" (the uninstaller exited %d)", code)
		}
	case reboot:
		r.Outcome, r.Detail = "restart_required", "the uninstall needs a restart to finish; the computer was not restarted"
	case code != 0:
		r.Outcome, r.Reason, r.Detail = "failed", "uninstall_failed", fmt.Sprintf("the uninstaller exited %d and the program is still there: %s", code, trim(strings.TrimSpace(string(out))))
	default:
		r.Outcome, r.Reason, r.Detail = "failed", "not_effective", "the uninstaller reported success but the uninstall key is still there"
	}
	return r
}

// presence: "true", "false" or "unknown" for the key now.
func presence(o Options, s *RemoveSpec) string {
	_, found, err := o.Programs.Program(s.View, s.Key)
	switch {
	case err != nil:
		return "unknown"
	case found:
		return "true"
	}
	return "false"
}

// removeInterrupted reports whether the key is there now. It reads only.
func removeInterrupted(params map[string]any, o Options) map[string]string {
	s, err := RemoveParams(params)
	if err != nil || o.Programs == nil {
		return nil
	}
	return map[string]string{"key": clip80(s.Key), "view": s.View, "presentNow": presence(o, s)}
}
