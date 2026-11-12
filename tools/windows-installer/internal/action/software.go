package action

// Software deployment (v0.34): install or uninstall one winget package from
// a catalog the portal keeps, pinned by exact version and installer SHA-256.
// The parameters are closed like everything else in the catalog — a package
// id, a version, a hash, the scope "machine" and one of three closed
// detection rules — and each value passes a charset before anything uses it.
//
// What is verified, and by whom, on this computer:
//   - winget downloads the installer (`winget download`) and checks it
//     against the manifest of the winget-pkgs source, as it always does;
//   - this agent then hashes the downloaded installer ITSELF and refuses
//     unless it equals the signed plan's installerSha256 (hash_mismatch),
//     and refuses unless the downloaded manifest declares that same hash
//     (manifest_hash_mismatch). Nothing has been installed at that point;
//   - `winget install --id --version --exact` then downloads again and
//     verifies those bytes against the source's manifest. The agent cannot
//     hash the bytes winget installs: if the source's manifest for that
//     exact version changed between the two steps, winget would verify
//     against the new hash. That window is seconds to minutes, and is
//     documented rather than claimed closed;
//   - the detection rule, run before (already installed: nothing is run)
//     and after (not detected: not_effective), decides the outcome.
//
// This package starts no process: Winget is an interface whose Windows
// implementation (internal/winget) runs the located winget.exe with an
// argument array, never through a shell.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Winget runs this computer's winget.exe. Run takes an argument list and
// never a command line; it returns the exit code and (bounded) output, and
// an error only when the process could not run or was killed at timeout.
type Winget interface {
	Locate() (string, error)
	Run(args []string, timeout time.Duration) (int, []byte, error)
}

// ErrWingetTimeout is returned (or matched through a Timeout() bool method)
// when winget was killed because it ran past its timeout.
var ErrWingetTimeout = errors.New("winget did not finish in time")

// UninstallEntry is one Programs and Features entry (HKLM uninstall keys).
type UninstallEntry struct{ Key, DisplayName, DisplayVersion string }

// SoftwareProbe is the read-only side detection rules use.
type SoftwareProbe interface {
	UninstallEntries() ([]UninstallEntry, error)
	// FileVersion: errors.Is(err, fs.ErrNotExist) when the file is absent.
	FileVersion(base, file string) (string, error)
	// AppManagers names what else manages applications here (configmgr, intune).
	AppManagers() []string
}

var (
	PackageIDRE    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+_-]{0,63}(\.[A-Za-z0-9+_-]{1,64}){1,7}$`)
	PkgVersionRE   = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`)
	sha256RE       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	displayNameRE  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._()+&,'-]{0,119}$`)
	uninstallKeyRE = regexp.MustCompile(`^[A-Za-z0-9{}][A-Za-z0-9{}._+ -]{0,127}$`)
	fileSegmentRE  = regexp.MustCompile(`^[A-Za-z0-9 ._()+-]{1,64}$`)
	manifestHashRE = regexp.MustCompile(`(?im)^\s*-?\s*InstallerSha256:\s*['"]?([0-9a-f]{64})['"]?\s*$`)
	wingetVerRE    = regexp.MustCompile(`^v?([0-9]{1,4})\.([0-9]{1,4})`)
)

// Minimum winget: `winget download` and SYSTEM-context machine installs.
const minWingetMajor, minWingetMinor = 1, 7

// Default timeouts.
const (
	wingetVersionTimeout = 30 * time.Second
	downloadTimeout      = 20 * time.Minute
	installTimeout       = 30 * time.Minute
	uninstallTimeout     = 20 * time.Minute
	maxManifestBytes     = 256 << 10
)

// Exit codes winget uses for "installed; restart to finish".
const (
	exitRebootToFinish  = 0x8A150109
	exitRebootToInstall = 0x8A15010A
)

// Detection is one closed detection rule.
type Detection struct {
	Kind    string // display_name | uninstall_key | file_version
	Name    string // display_name
	Match   string // exact | prefix
	Key     string // uninstall_key
	Base    string // ProgramFiles | ProgramFilesX86
	File    string // file_version
	Compare string // gte | eq
	Version string
}

// SoftwareSpec is a verified plan's parameters.
type SoftwareSpec struct {
	PackageID, Version, InstallerSHA256, Scope string
	Detection                                  Detection
}

func softwareParamsOK(p map[string]any) bool {
	_, err := SoftwareParams(p)
	return err == nil
}

func strField(m map[string]any, k string) (string, bool) {
	s, ok := m[k].(string)
	return s, ok
}

func exactKeys(m map[string]any, keys ...string) bool {
	if len(m) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return false
		}
	}
	return true
}

// ValidPackageID: the package id charset (it can never start with "-", so
// winget can never read it as an option) and length.
func ValidPackageID(s string) bool { return len(s) <= 128 && PackageIDRE.MatchString(s) }

// ValidDetectionFile: a relative file under Program Files, segment by
// segment. No drive, no leading or forward slash, no "." or "..", no segment
// ending in a dot or a space (Windows would trim them), .exe or .dll only.
func ValidDetectionFile(f string) bool {
	if f == "" || len(f) > 200 || strings.ContainsAny(f, "/:") || strings.HasPrefix(f, `\`) {
		return false
	}
	segs := strings.Split(f, `\`)
	if len(segs) > 8 {
		return false
	}
	for _, s := range segs {
		if !fileSegmentRE.MatchString(s) || s == "." || s == ".." || strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ") || strings.HasSuffix(s, ".") {
			return false
		}
	}
	last := strings.ToLower(segs[len(segs)-1])
	return strings.HasSuffix(last, ".exe") || strings.HasSuffix(last, ".dll")
}

// SoftwareParams parses exactly {packageId, version, installerSha256, scope,
// detection}; anything else, or any value outside its charset, is an error.
func SoftwareParams(p map[string]any) (*SoftwareSpec, error) {
	if !exactKeys(p, "packageId", "version", "installerSha256", "scope", "detection") {
		return nil, paramErr("params must be exactly packageId, version, installerSha256, scope and detection")
	}
	s := &SoftwareSpec{}
	var ok bool
	if s.PackageID, ok = strField(p, "packageId"); !ok || !ValidPackageID(s.PackageID) {
		return nil, paramErr("bad packageId")
	}
	if s.Version, ok = strField(p, "version"); !ok || !PkgVersionRE.MatchString(s.Version) {
		return nil, paramErr("bad version")
	}
	if s.InstallerSHA256, ok = strField(p, "installerSha256"); !ok || !sha256RE.MatchString(s.InstallerSHA256) {
		return nil, paramErr("bad installerSha256")
	}
	if s.Scope, ok = strField(p, "scope"); !ok || s.Scope != "machine" {
		return nil, paramErr("scope must be machine")
	}
	d, ok := p["detection"].(map[string]any)
	if !ok {
		return nil, paramErr("detection must be an object")
	}
	det, err := parseDetection(d)
	if err != nil {
		return nil, err
	}
	s.Detection = *det
	return s, nil
}

func parseDetection(d map[string]any) (*Detection, error) {
	out := &Detection{}
	kind, _ := strField(d, "kind")
	out.Kind = kind
	var want []string
	switch kind {
	case "display_name":
		want = []string{"kind", "name", "match", "compare", "version"}
	case "uninstall_key":
		want = []string{"kind", "key", "compare", "version"}
	case "file_version":
		want = []string{"kind", "base", "file", "compare", "version"}
	default:
		return nil, paramErr("unknown detection kind")
	}
	if !exactKeys(d, want...) {
		return nil, paramErr("detection has missing or unknown fields")
	}
	var ok bool
	if out.Compare, ok = strField(d, "compare"); !ok || (out.Compare != "gte" && out.Compare != "eq") {
		return nil, paramErr("detection.compare must be gte or eq")
	}
	if out.Version, ok = strField(d, "version"); !ok || !PkgVersionRE.MatchString(out.Version) {
		return nil, paramErr("bad detection.version")
	}
	switch kind {
	case "display_name":
		if out.Name, ok = strField(d, "name"); !ok || !displayNameRE.MatchString(out.Name) {
			return nil, paramErr("bad detection.name")
		}
		if out.Match, ok = strField(d, "match"); !ok || (out.Match != "exact" && out.Match != "prefix") {
			return nil, paramErr("detection.match must be exact or prefix")
		}
	case "uninstall_key":
		if out.Key, ok = strField(d, "key"); !ok || !uninstallKeyRE.MatchString(out.Key) {
			return nil, paramErr("bad detection.key")
		}
	case "file_version":
		if out.Base, ok = strField(d, "base"); !ok || (out.Base != "ProgramFiles" && out.Base != "ProgramFilesX86") {
			return nil, paramErr("detection.base must be ProgramFiles or ProgramFilesX86")
		}
		if out.File, ok = strField(d, "file"); !ok || !ValidDetectionFile(out.File) {
			return nil, paramErr("bad detection.file")
		}
	}
	return out, nil
}

// ── Versions ────────────────────────────────────────────────────────────────

// versionSegments splits on . - + _ keeping empty segments, which count as
// "0" (so "1..2" is 1.0.2). The empty string is one segment, "0".
func versionSegments(s string) []string {
	out := []string{""}
	for _, r := range s {
		if r == '.' || r == '-' || r == '+' || r == '_' {
			out = append(out, "")
			continue
		}
		out[len(out)-1] += string(r)
	}
	for i := range out {
		if out[i] == "" {
			out[i] = "0"
		}
	}
	return out
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func cmpSegment(a, b string) int {
	if isDigits(a) && isDigits(b) {
		a, b = strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
		if len(a) != len(b) {
			if len(a) < len(b) {
				return -1
			}
			return 1
		}
		return strings.Compare(a, b)
	}
	return strings.Compare(strings.ToLower(a), strings.ToLower(b))
}

// CompareVersions: -1, 0 or 1. Segments split on . - + _; a missing segment
// is "0"; numeric segments compare as numbers (any length), others
// case-insensitively. The portal's copy (apps/api/src/software) is the same.
func CompareVersions(a, b string) int {
	as, bs := versionSegments(a), versionSegments(b)
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		x, y := "0", "0"
		if i < len(as) {
			x = as[i]
		}
		if i < len(bs) {
			y = bs[i]
		}
		if c := cmpSegment(x, y); c != 0 {
			return c
		}
	}
	return 0
}

func versionHolds(compare, found, want string) bool {
	c := CompareVersions(found, want)
	if compare == "eq" {
		return c == 0
	}
	return c >= 0
}

// ── Detection ───────────────────────────────────────────────────────────────

// Detect evaluates a rule: "installed", "outdated" or "absent", with the
// version found.
func Detect(sp SoftwareProbe, d Detection) (string, string, error) {
	found, version := false, ""
	switch d.Kind {
	case "display_name", "uninstall_key":
		entries, err := sp.UninstallEntries()
		if err != nil {
			return "", "", err
		}
		for _, e := range entries {
			var match bool
			if d.Kind == "display_name" {
				if e.DisplayName == "" {
					continue
				}
				if d.Match == "exact" {
					match = strings.EqualFold(e.DisplayName, d.Name)
				} else {
					match = len(e.DisplayName) >= len(d.Name) && strings.EqualFold(e.DisplayName[:len(d.Name)], d.Name)
				}
			} else {
				match = strings.EqualFold(e.Key, d.Key)
			}
			if !match {
				continue
			}
			if !found || CompareVersions(e.DisplayVersion, version) > 0 {
				version = e.DisplayVersion
			}
			found = true
		}
	case "file_version":
		if !ValidDetectionFile(d.File) {
			return "", "", errors.New("detection file outside the allowed form")
		}
		v, err := sp.FileVersion(d.Base, d.File)
		if errors.Is(err, fs.ErrNotExist) {
			return "absent", "", nil
		}
		if err != nil {
			return "", "", err
		}
		found, version = true, v
	default:
		return "", "", errors.New("unknown detection kind")
	}
	if !found {
		return "absent", "", nil
	}
	if versionHolds(d.Compare, version, d.Version) {
		return "installed", version, nil
	}
	return "outdated", version, nil
}

func clip80(s string) string {
	if len(s) > 80 {
		return s[:80]
	}
	return s
}

// ── Running winget ──────────────────────────────────────────────────────────

func swTimeout(o Options, d time.Duration) time.Duration {
	if o.SoftwareTimeout > 0 {
		return o.SoftwareTimeout
	}
	return d
}

func isTimeout(err error) bool {
	var t interface{ Timeout() bool }
	return errors.Is(err, ErrWingetTimeout) || (errors.As(err, &t) && t.Timeout())
}

func exitHex(code int) string { return fmt.Sprintf("0x%08X", uint32(code)) }

// The argument lists. Built from values SoftwareParams checked; each value
// is one element, never joined into a string.
func downloadArgs(s *SoftwareSpec, dir string) []string {
	return []string{"download", "--id", s.PackageID, "--version", s.Version, "--exact", "--source", "winget", "--scope", "machine",
		"--skip-dependencies", "--download-directory", dir, "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"}
}

func installArgs(s *SoftwareSpec) []string {
	return []string{"install", "--id", s.PackageID, "--version", s.Version, "--exact", "--source", "winget", "--silent", "--scope", "machine",
		"--skip-dependencies", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"}
}

func uninstallArgs(s *SoftwareSpec) []string {
	return []string{"uninstall", "--id", s.PackageID, "--exact", "--source", "winget", "--silent", "--scope", "machine",
		"--accept-source-agreements", "--disable-interactivity"}
}

// wingetVersion: the version winget reports, and whether it is new enough.
func wingetVersion(o Options) (string, *Result) {
	if _, err := o.Winget.Locate(); err != nil {
		return "", &Result{Outcome: "not_executed", Reason: "winget_unavailable", Detail: "winget (App Installer) was not found for the SYSTEM account: " + trim(err.Error())}
	}
	code, out, err := o.Winget.Run([]string{"--version"}, swTimeout(o, wingetVersionTimeout))
	v := strings.TrimSpace(string(out))
	m := wingetVerRE.FindStringSubmatch(v)
	if err != nil || code != 0 || m == nil {
		return "", &Result{Outcome: "not_executed", Reason: "winget_unavailable", Detail: "winget is present but did not report its version"}
	}
	var major, minor int
	fmt.Sscanf(m[1], "%d", &major)
	fmt.Sscanf(m[2], "%d", &minor)
	if major < minWingetMajor || (major == minWingetMajor && minor < minWingetMinor) {
		return clip80(v), &Result{Outcome: "not_executed", Reason: "winget_too_old", Observed: map[string]string{"wingetVersion": clip80(v)},
			Detail: fmt.Sprintf("winget %s is older than %d.%d, which this action needs; update App Installer", v, minWingetMajor, minWingetMinor)}
	}
	return clip80(v), nil
}

// softwarePrecheck runs after the signed pause and before the executing
// journal entry. It only reads: app management, winget's presence and
// version, and the detection rule.
func softwarePrecheck(uninstall bool) func(p *Plan, o Options) *Result {
	return func(p *Plan, o Options) *Result {
		if o.Winget == nil || o.Software == nil {
			return &Result{Outcome: "failed", Reason: "no_software", Detail: "this agent cannot deploy software"}
		}
		s, err := SoftwareParams(p.Params)
		if err != nil {
			return &Result{Outcome: "refused", Reason: "params_not_allowed", Detail: err.Error()}
		}
		obs := map[string]string{"packageId": s.PackageID}
		if m := o.Software.AppManagers(); len(m) > 0 {
			obs["managers"] = clip80(strings.Join(m, ","))
			return &Result{Outcome: "refused", Reason: "managed_elsewhere", Observed: obs,
				Detail: "applications on this computer are managed by " + strings.Join(m, ", ") + "; deploy it there"}
		}
		v, bad := wingetVersion(o)
		if bad != nil {
			if bad.Observed == nil {
				bad.Observed = map[string]string{}
			}
			bad.Observed["packageId"] = s.PackageID
			return bad
		}
		obs["wingetVersion"] = v
		st, ver, err := Detect(o.Software, s.Detection)
		if err != nil {
			return &Result{Outcome: "not_executed", Reason: "detection_failed", Observed: obs, Detail: "the detection rule could not be read: " + trim(err.Error())}
		}
		obs["detectedBefore"], obs["versionBefore"] = st, clip80(ver)
		if !uninstall && st == "installed" {
			return &Result{Outcome: "no_change", Observed: obs, ExecutedAt: o.now().UTC().Format(time.RFC3339), Detail: "already installed (the detection rule holds); nothing was run"}
		}
		if uninstall && st == "absent" {
			return &Result{Outcome: "no_change", Observed: obs, ExecutedAt: o.now().UTC().Format(time.RFC3339), Detail: "not installed (the detection rule finds nothing); nothing was run"}
		}
		return nil
	}
}

func softwareStart(p *Plan, o Options) (Result, *SoftwareSpec, bool) {
	r := started(o)
	s, err := SoftwareParams(p.Params) // verified already; checked again before use
	if err != nil || o.Winget == nil || o.Software == nil {
		r.Outcome, r.Reason, r.Detail = "refused", "params_not_allowed", "the parameters are outside this agent's catalog"
		return r, nil, false
	}
	r.Observed["packageId"] = s.PackageID
	if v, bad := wingetVersion(o); bad == nil {
		r.Observed["wingetVersion"] = v
	}
	if st, ver, err := Detect(o.Software, s.Detection); err == nil {
		r.Observed["detectedBefore"], r.Observed["versionBefore"] = st, clip80(ver)
	}
	return r, s, true
}

func detectAfter(o Options, s *SoftwareSpec, r *Result, key string) string {
	st, ver, err := Detect(o.Software, s.Detection)
	if err != nil {
		st = "unknown"
	}
	r.Observed["detected"+key], r.Observed["version"+key] = st, clip80(ver)
	return st
}

// downloadedInstaller: the one regular non-.yaml file at the top of dir, and
// the .yaml manifests beside it. Links and directories are never followed.
func downloadedInstaller(dir string) (string, []string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return "", nil, err
	}
	var inst, yamls []string
	for _, e := range ents {
		if !e.Type().IsRegular() {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if strings.HasSuffix(strings.ToLower(e.Name()), ".yaml") {
			yamls = append(yamls, p)
		} else {
			inst = append(inst, p)
		}
	}
	if len(inst) != 1 {
		return "", nil, fmt.Errorf("winget downloaded %d installer files, expected exactly one", len(inst))
	}
	if len(yamls) == 0 {
		return "", nil, errors.New("winget downloaded no manifest")
	}
	return inst[0], yamls, nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// manifestDeclares: does any downloaded manifest declare this installer hash?
func manifestDeclares(yamls []string, pin string) bool {
	for _, y := range yamls {
		f, err := os.Open(y)
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(f, maxManifestBytes+1))
		f.Close()
		if err != nil || len(b) > maxManifestBytes {
			continue
		}
		for _, m := range manifestHashRE.FindAllStringSubmatch(string(b), -1) {
			if strings.EqualFold(m[1], pin) {
				return true
			}
		}
	}
	return false
}

func installSoftware(p *Plan, o Options) Result {
	r, s, ok := softwareStart(p, o)
	if !ok {
		return r
	}
	journalStep(o, p, "downloading")
	dir := filepath.Join(o.dir("software"), p.JobID)
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "download_failed", trim(err.Error())
		return r
	}
	defer os.RemoveAll(dir)
	code, out, err := o.Winget.Run(downloadArgs(s, dir), swTimeout(o, downloadTimeout))
	if err != nil || code != 0 {
		r.Outcome, r.Reason = "failed", "download_failed"
		if err != nil {
			r.Detail = "winget download did not complete: " + trim(err.Error())
		} else {
			r.Observed["exitCode"] = exitHex(code)
			r.Detail = "winget download failed (" + exitHex(code) + "): " + trim(strings.TrimSpace(string(out)))
		}
		return r
	}
	journalStep(o, p, "verifying")
	inst, yamls, err := downloadedInstaller(dir)
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "installer_not_found", trim(err.Error())
		return r
	}
	got, err := fileSHA256(inst)
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "installer_not_found", trim(err.Error())
		return r
	}
	r.Observed["installerSha256"] = got
	if got != s.InstallerSHA256 {
		r.Outcome, r.Reason, r.Detail = "refused", "hash_mismatch", "the downloaded installer's SHA-256 is not the one the plan pins; nothing was installed"
		return r
	}
	if !manifestDeclares(yamls, s.InstallerSHA256) {
		r.Outcome, r.Reason, r.Detail = "refused", "manifest_hash_mismatch", "the downloaded manifest does not declare the pinned installer hash; nothing was installed"
		return r
	}
	journalStep(o, p, "installing")
	code, out, err = o.Winget.Run(installArgs(s), swTimeout(o, installTimeout))
	if isTimeout(err) {
		r.Outcome, r.Reason, r.Detail = "uncertain", "timeout", "winget install did not finish in time and was stopped; the installer may still have changed the computer"
		detectAfter(o, s, &r, "Now")
		return r
	}
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "install_failed", "winget could not be run: "+trim(err.Error())
		return r
	}
	r.Observed["exitCode"] = exitHex(code)
	reboot := uint32(code) == exitRebootToFinish || uint32(code) == exitRebootToInstall
	if code != 0 && !reboot {
		r.Outcome, r.Reason, r.Detail = "failed", "install_failed", "winget install failed ("+exitHex(code)+"): "+trim(strings.TrimSpace(string(out)))
		return r
	}
	journalStep(o, p, "detecting")
	st := detectAfter(o, s, &r, "After")
	r.Observed["rebootRequired"] = fmt.Sprint(reboot)
	r.Observed["effective"] = fmt.Sprint(st == "installed")
	switch {
	case st == "installed":
		r.Outcome, r.Detail = "succeeded", "installed; the detection rule holds"
		if reboot {
			r.Detail += " (Windows needs a restart to finish; it was not restarted)"
		}
	case reboot:
		r.Outcome, r.Detail = "restart_required", "winget installed it but the computer must restart before it takes effect; it was not restarted"
	default:
		r.Outcome, r.Reason, r.Detail = "failed", "not_effective", "winget reported success but the detection rule does not hold ("+st+")"
	}
	return r
}

func uninstallSoftware(p *Plan, o Options) Result {
	r, s, ok := softwareStart(p, o)
	if !ok {
		return r
	}
	journalStep(o, p, "uninstalling")
	code, out, err := o.Winget.Run(uninstallArgs(s), swTimeout(o, uninstallTimeout))
	if isTimeout(err) {
		r.Outcome, r.Reason, r.Detail = "uncertain", "timeout", "winget uninstall did not finish in time and was stopped; it may have changed the computer"
		detectAfter(o, s, &r, "Now")
		return r
	}
	if err != nil {
		r.Outcome, r.Reason, r.Detail = "failed", "uninstall_failed", "winget could not be run: "+trim(err.Error())
		return r
	}
	r.Observed["exitCode"] = exitHex(code)
	reboot := uint32(code) == exitRebootToFinish || uint32(code) == exitRebootToInstall
	if code != 0 && !reboot {
		r.Outcome, r.Reason, r.Detail = "failed", "uninstall_failed", "winget uninstall failed ("+exitHex(code)+"): "+trim(strings.TrimSpace(string(out)))
		return r
	}
	journalStep(o, p, "detecting")
	st := detectAfter(o, s, &r, "After")
	r.Observed["rebootRequired"] = fmt.Sprint(reboot)
	r.Observed["effective"] = fmt.Sprint(st == "absent")
	switch {
	case st == "absent":
		r.Outcome, r.Detail = "succeeded", "uninstalled; the detection rule finds nothing"
	case reboot:
		r.Outcome, r.Detail = "restart_required", "winget uninstalled it but the computer must restart to finish; it was not restarted"
	default:
		r.Outcome, r.Reason, r.Detail = "failed", "not_effective", "winget reported success but the detection rule still finds it ("+st+")"
	}
	return r
}

// softwareInterrupted reports what the detection rule sees now. It reads only.
func softwareInterrupted(params map[string]any, o Options) map[string]string {
	s, err := SoftwareParams(params)
	if err != nil || o.Software == nil {
		return nil
	}
	out := map[string]string{"packageId": s.PackageID}
	if st, ver, err := Detect(o.Software, s.Detection); err == nil {
		out["detectedNow"], out["versionNow"] = st, clip80(ver)
	}
	return out
}
