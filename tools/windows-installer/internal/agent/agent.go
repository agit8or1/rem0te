// Package agent is the platform-independent part of the Windows agent:
// install, update and migrate, as a sequence of verified steps.
//
// Two stages, so that whatever runs privileged steps is the signed binary:
//
//	stage 1  (whatever binary was launched — a downloaded bootstrap, an old
//	          agent, a GPO-copied file): refresh signed metadata, fetch the
//	          signed agent binary into the install directory, run it.
//	stage 2  (the installed binary, which first checks that its own digest is
//	          the signed one): fetch the signed installer script and the signed
//	          RustDesk build, write a parameters file, run the script.
//
// The portal supplies only data (parameters), and on update the RustDesk
// relay host and key are taken from what this machine pinned at install, not
// from the portal — otherwise a compromised portal could repoint the fleet at
// its own relay without touching a byte of signed code.
package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

const (
	TargetInstaller = "windows/install.ps1"
	TargetAgent     = "windows/rem0te-agent.exe"
	ParamsSchema    = "rem0te-install-params/1"
)

type Mode string

const (
	ModeInstall Mode = "install" // new machine, with a claim token
	ModeUpdate  Mode = "update"  // heartbeat-triggered or scheduled
	ModeMigrate Mode = "migrate" // legacy agent → signed chain, keeps enrolment
)

// Platform is everything that touches Windows. main.go implements it; tests fake it.
type Platform interface {
	// RustdeskVersion of the installed client, "" if none.
	RustdeskVersion() string
	// SecureDir creates dir (if needed) restricted to SYSTEM and Administrators.
	SecureDir(dir string) error
	// InstallAgent atomically places a verified binary at dst, coping with dst
	// being the running executable.
	InstallAgent(src, dst string) error
	// RunAgent runs the installed agent binary and returns its exit code.
	RunAgent(exe string, args []string) (int, error)
	// RunInstaller runs the verified script with the parameters file.
	RunInstaller(script, params string) (int, error)
	// SelfPath is the running executable.
	SelfPath() (string, error)
	// PriorRelay reads the relay host/key a legacy install left behind
	// (heartbeat.dat / RustDesk2.toml) for migration; "" if unknown.
	PriorRelay() (host, key string)
}

type Paths struct {
	InstallDir string // C:\Program Files\Rem0te
	StateDir   string // C:\ProgramData\Rem0te
}

func (p Paths) AgentExe() string   { return filepath.Join(p.InstallDir, "rem0te-agent.exe") }
func (p Paths) TUFDir() string     { return filepath.Join(p.StateDir, "tuf") }
func (p Paths) Staging() string    { return filepath.Join(p.StateDir, "setup", "signed") }
func (p Paths) PinFile() string    { return filepath.Join(p.StateDir, "agent-pin.json") }
func (p Paths) StatusFile() string { return filepath.Join(p.StateDir, "agent-status.json") }

type Options struct {
	Mode       Mode
	PortalHost string // hostname only; https is implied
	ClaimToken string
	Nonce      string
	Stage2     bool
	Root       []byte
	Paths      Paths
	// Test hooks.
	Scheme     string // "https" unless a test sets "http"
	HTTPClient *http.Client
	Now        func() time.Time
}

var (
	hostRE    = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,253}$`)
	keyRE     = regexp.MustCompile(`^[A-Za-z0-9+/]{16,512}={0,2}$`)
	tokenRE   = regexp.MustCompile(`^[A-Fa-f0-9]{16,128}$`)
	nonceRE   = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	portRE    = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
	ErrRefuse = errors.New("refused")
)

func ValidHost(h string) bool {
	return hostRE.MatchString(h) && !strings.HasPrefix(h, ".") && !strings.Contains(h, "..")
}

// ValidPortal is a hostname with an optional port (a portal on :8443). The
// relay host stays hostname-only: RustDesk takes the port from its own config.
func ValidPortal(h string) bool {
	host, port, found := strings.Cut(h, ":")
	if found && !portRE.MatchString(port) {
		return false
	}
	return ValidHost(host)
}

func (o *Options) scheme() string {
	if o.Scheme != "" {
		return o.Scheme
	}
	return "https"
}

func (o *Options) base() string { return o.scheme() + "://" + o.PortalHost + "/api/v1" }

func (o *Options) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o *Options) validate() error {
	if !ValidPortal(o.PortalHost) {
		return fmt.Errorf("%w: portal host %q is not a hostname", ErrRefuse, o.PortalHost)
	}
	if o.ClaimToken != "" && !tokenRE.MatchString(o.ClaimToken) {
		return fmt.Errorf("%w: claim token is not hex", ErrRefuse)
	}
	if o.Nonce != "" && !nonceRE.MatchString(o.Nonce) {
		return fmt.Errorf("%w: update nonce has an invalid format", ErrRefuse)
	}
	switch o.Mode {
	case ModeInstall, ModeUpdate, ModeMigrate:
	default:
		return fmt.Errorf("%w: unknown mode %q", ErrRefuse, o.Mode)
	}
	return nil
}

func (o *Options) trustClient(p Platform) (*trust.Client, error) {
	if err := p.SecureDir(o.Paths.StateDir); err != nil {
		return nil, err
	}
	return trust.New(trust.Config{
		MirrorURL:         o.base() + "/public/updates",
		EmbeddedRoot:      o.Root,
		StateDir:          o.Paths.TUFDir(),
		AllowInsecureHTTP: o.scheme() == "http",
		HTTPClient:        o.HTTPClient,
	})
}

// Run executes one stage and returns the installer's exit code (0 = success).
func Run(o Options, p Platform) (int, error) {
	if err := o.validate(); err != nil {
		return 0, err
	}
	c, err := o.trustClient(p)
	if err != nil {
		writeStatus(o, Status{Channel: "signed", LastResult: "metadata-refused: " + err.Error()})
		return 0, err
	}
	// v0.28: the signed pause stops the update command (stage 1 only: a
	// stage 2 already running finishes the install it verified).
	if !o.Stage2 {
		// A listed pause the agent cannot read — including because its state
		// directory cannot be secured — is a pause (fail closed).
		dir := filepath.Join(o.Paths.StateDir, "actions")
		dirErr := p.SecureDir(dir)
		if pz := signedPause(c, dir, dirErr); pz.UpdatesPaused() {
			writeStatus(o, Status{Channel: "signed", LastResult: "paused: " + pz.Reason})
			return 0, fmt.Errorf("%w: updates are paused by the signed pause (%s): %s", ErrRefuse, pz.IssuedAt, pz.Reason)
		}
	}
	if !o.Stage2 {
		return stage1(o, p, c)
	}
	return stage2(o, p, c)
}

func stage1(o Options, p Platform, c *trust.Client) (int, error) {
	if err := p.SecureDir(o.Paths.Staging()); err != nil {
		return 0, err
	}
	tmp := filepath.Join(o.Paths.Staging(), "rem0te-agent.exe")
	if _, err := c.Fetch(TargetAgent, tmp); err != nil {
		return 0, err
	}
	if err := p.InstallAgent(tmp, o.Paths.AgentExe()); err != nil {
		return 0, fmt.Errorf("installing the verified agent binary: %w", err)
	}
	args := []string{string(o.Mode), "--stage2", "--portal", o.PortalHost}
	if o.ClaimToken != "" {
		args = append(args, "--token", o.ClaimToken)
	}
	if o.Nonce != "" {
		args = append(args, "--nonce", o.Nonce)
	}
	return p.RunAgent(o.Paths.AgentExe(), args)
}

// Params is what the portal sends. All of it is untrusted data; every field
// is validated here and again by the signed script.
type Params struct {
	Schema          string `json:"schema"`
	Host            string `json:"host"`
	Key             string `json:"key"`
	RustdeskVersion string `json:"rustdeskVersion"`
	UpdateNonce     string `json:"updateNonce,omitempty"`
}

// Pin is what this machine trusts for its relay, recorded at install/migrate.
type Pin struct {
	Host       string    `json:"host"`
	Key        string    `json:"key"`
	PortalHost string    `json:"portalHost"`
	PinnedAt   time.Time `json:"pinnedAt"`
}

// ScriptParams is written for the signed installer script.
type ScriptParams struct {
	Schema          string `json:"schema"`
	Mode            Mode   `json:"mode"`
	Host            string `json:"host"`
	Key             string `json:"key"`
	ClaimToken      string `json:"claimToken"`
	RustdeskVersion string `json:"rustdeskVersion"`
	RustdeskExe     string `json:"rustdeskExe"`
	RustdeskSHA256  string `json:"rustdeskSha256"`
	UpdateNonce     string `json:"updateNonce"`
	TrustRoot       int64  `json:"trustRootVersion"`
	TargetsVersion  int64  `json:"targetsVersion"`
	AgentSHA256     string `json:"agentSha256"`
}

// Status is read by the heartbeat and reported to the portal.
type Status struct {
	Channel          string    `json:"channel"`
	TrustRoot        int64     `json:"trustRootVersion,omitempty"`
	TargetsVersion   int64     `json:"targetsVersion,omitempty"`
	AgentSHA256      string    `json:"agentSha256,omitempty"`
	LastCheck        time.Time `json:"lastCheck"`
	LastResult       string    `json:"lastResult"`
	RelayChangeAsked bool      `json:"relayChangeRequested,omitempty"`
	// Actions this build can execute (v0.26), as "id@version". The heartbeat
	// reports them; the portal offers nothing an agent does not list.
	Actions []string `json:"actions,omitempty"`
}

func stage2(o Options, p Platform, c *trust.Client) (int, error) {
	// 1. The code about to do privileged work must be the signed agent.
	agentT, err := c.Info(TargetAgent)
	if err != nil {
		return 0, err
	}
	self, err := p.SelfPath()
	if err != nil {
		return 0, err
	}
	selfSum, err := FileSHA256(self)
	if err != nil {
		return 0, err
	}
	if selfSum != agentT.SHA256 {
		return 0, fmt.Errorf("%w: stage 2 is running %s (sha256 %s), not the signed agent (%s)", ErrRefuse, self, selfSum[:12], agentT.SHA256[:12])
	}

	// 2. Parameters (data) from the portal.
	prm, err := fetchParams(o)
	if err != nil {
		return 0, err
	}

	// 3. Relay pin.
	pin, relayChange, err := resolvePin(o, p, prm)
	if err != nil {
		return 0, err
	}

	// 4. RustDesk build: must be signed, and not older than what is installed
	//    unless the release signer marked that build as a permitted rollback.
	rdName := trust.RustdeskTargetName(prm.RustdeskVersion)
	rdT, err := c.Info(rdName)
	if err != nil {
		return 0, fmt.Errorf("%w: RustDesk %s is not a signed release", ErrRefuse, prm.RustdeskVersion)
	}
	if cur := p.RustdeskVersion(); cur != "" && trust.CompareVersions(prm.RustdeskVersion, cur) < 0 && !rdT.DowngradeAllowed() {
		return 0, fmt.Errorf("%w: RustDesk %s is older than installed %s and is not signed as a permitted rollback", ErrRefuse, prm.RustdeskVersion, cur)
	}

	// 5. Fetch verified files into the locked staging directory.
	st := o.Paths.Staging()
	if err := p.SecureDir(st); err != nil {
		return 0, err
	}
	script := filepath.Join(st, "install.ps1")
	if _, err := c.Fetch(TargetInstaller, script); err != nil {
		return 0, err
	}
	rdExe := filepath.Join(st, "rustdesk-"+prm.RustdeskVersion+"-x86_64.exe")
	if _, err := c.Fetch(rdName, rdExe); err != nil {
		return 0, err
	}

	// 6. Parameters for the script, then run it.
	sp := ScriptParams{
		Schema: ParamsSchema, Mode: o.Mode, Host: pin.Host, Key: pin.Key, ClaimToken: o.ClaimToken,
		RustdeskVersion: prm.RustdeskVersion, RustdeskExe: rdExe, RustdeskSHA256: rdT.SHA256,
		UpdateNonce: prm.UpdateNonce, TrustRoot: c.RootVersion(), TargetsVersion: c.TargetsVersion(), AgentSHA256: selfSum,
	}
	pf := filepath.Join(st, "params.json")
	raw, _ := json.Marshal(sp)
	if err := os.WriteFile(pf, raw, 0o600); err != nil {
		return 0, err
	}
	code, err := p.RunInstaller(script, pf)
	res := fmt.Sprintf("installer exit %d", code)
	if err != nil {
		res = "installer failed: " + err.Error()
	}
	writeStatus(o, Status{Channel: "signed", TrustRoot: c.RootVersion(), TargetsVersion: c.TargetsVersion(), AgentSHA256: selfSum, LastResult: res, RelayChangeAsked: relayChange})
	return code, err
}

func fetchParams(o Options) (*Params, error) {
	q := url.Values{}
	if o.ClaimToken != "" {
		q.Set("token", o.ClaimToken)
	}
	if o.Nonce != "" {
		q.Set("updateNonce", o.Nonce)
	}
	u := o.base() + "/public/install/windows-params.json"
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	hc := o.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := hc.Get(u)
	if err != nil {
		return nil, fmt.Errorf("fetching install parameters: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("install parameters: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if err != nil {
		return nil, err
	}
	var env struct {
		Data *Params `json:"data"`
	}
	var prm Params
	if json.Unmarshal(body, &env) == nil && env.Data != nil {
		prm = *env.Data
	} else if err := json.Unmarshal(body, &prm); err != nil {
		return nil, fmt.Errorf("install parameters are not JSON: %w", err)
	}
	if prm.Schema != ParamsSchema {
		return nil, fmt.Errorf("%w: install parameters schema %q", ErrRefuse, prm.Schema)
	}
	if !ValidHost(prm.Host) || !keyRE.MatchString(prm.Key) {
		return nil, fmt.Errorf("%w: install parameters carry an invalid relay host or key", ErrRefuse)
	}
	if !trust.ValidVersion(prm.RustdeskVersion) {
		return nil, fmt.Errorf("%w: install parameters carry an invalid RustDesk version %q", ErrRefuse, prm.RustdeskVersion)
	}
	if prm.UpdateNonce != "" && !nonceRE.MatchString(prm.UpdateNonce) {
		return nil, fmt.Errorf("%w: invalid update nonce in parameters", ErrRefuse)
	}
	if o.Nonce != "" && prm.UpdateNonce != o.Nonce {
		return nil, fmt.Errorf("%w: parameters are for nonce %q, not %q", ErrRefuse, prm.UpdateNonce, o.Nonce)
	}
	return &prm, nil
}

// resolvePin decides which relay this machine talks to.
//   - install: the portal's values are pinned (trust on first install, the
//     same moment the operator trusts the portal with a claim token).
//   - migrate: the values the legacy install already uses are pinned when
//     known, so migration cannot be used to repoint a machine.
//   - update: the pin wins. A differing portal value is reported, not applied.
func resolvePin(o Options, p Platform, prm *Params) (Pin, bool, error) {
	existing, haveExisting := readPin(o.Paths.PinFile())
	switch {
	case haveExisting:
		changed := existing.Host != prm.Host || existing.Key != prm.Key
		return existing, changed, nil
	case o.Mode == ModeUpdate:
		return Pin{}, false, fmt.Errorf("%w: no relay pin on this machine; run `rem0te-agent.exe migrate` locally or via GPO/Intune", ErrRefuse)
	}
	pin := Pin{Host: prm.Host, Key: prm.Key, PortalHost: o.PortalHost, PinnedAt: o.now().UTC()}
	if o.Mode == ModeMigrate {
		if h, k := p.PriorRelay(); h != "" {
			pin.Host = h
			if keyRE.MatchString(k) {
				pin.Key = k
			}
		}
	}
	raw, _ := json.Marshal(pin)
	if err := os.WriteFile(o.Paths.PinFile(), raw, 0o600); err != nil {
		return Pin{}, false, err
	}
	return pin, pin.Host != prm.Host || pin.Key != prm.Key, nil
}

func readPin(path string) (Pin, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Pin{}, false
	}
	var p Pin
	if json.Unmarshal(raw, &p) != nil || !ValidHost(p.Host) || !keyRE.MatchString(p.Key) {
		return Pin{}, false
	}
	return p, true
}

func writeStatus(o Options, s Status) {
	s.LastCheck = o.now().UTC()
	if s.AgentSHA256 != "" {
		s.Actions = action.Supported()
	}
	raw, _ := json.Marshal(s)
	_ = os.WriteFile(o.Paths.StatusFile(), raw, 0o600)
}

func FileSHA256(p string) (string, error) {
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

// ApprovalKeys fetches approval/keys.json through the signed update chain
// (v0.26): the only place the agent learns which keys may sign action plans.
// The portal cannot substitute one; it is a target like the agent binary.
func ApprovalKeys(o Options, p Platform) ([]action.Key, error) {
	k, _, err := ActionTrust(o, p)
	return k, err
}

// signedPause reads control/pause.json when the signed targets list it
// (v0.28). Listed but unreadable means paused: fail closed.
func signedPause(c *trust.Client, dir string, dirErr error) *action.Pause {
	listed := false
	for _, t := range c.Targets() {
		if t == action.PauseTarget {
			listed = true
		}
	}
	if !listed {
		return nil
	}
	closed := &action.Pause{Schema: action.PauseSchema, IssuedAt: time.Now().UTC().Format(time.RFC3339), Reason: "the signed pause could not be read",
		Actions: action.PauseScope{All: true}, Updates: action.PauseScope{All: true}}
	if dirErr != nil {
		return closed
	}
	dst := filepath.Join(dir, "pause.json")
	if _, err := c.Fetch(action.PauseTarget, dst); err != nil {
		return closed
	}
	raw, err := os.ReadFile(dst)
	if err != nil {
		return closed
	}
	pz, err := action.ParsePause(raw)
	if err != nil {
		return closed
	}
	return pz
}

// ActionTrust is ApprovalKeys plus the signed pause, from one refresh of the
// signed metadata.
func ActionTrust(o Options, p Platform) ([]action.Key, *action.Pause, error) {
	keys, pz, err := actionTrust(o, p)
	return keys, pz, err
}

func actionTrust(o Options, p Platform) ([]action.Key, *action.Pause, error) {
	if !ValidPortal(o.PortalHost) {
		return nil, nil, fmt.Errorf("%w: portal host %q is not a hostname", ErrRefuse, o.PortalHost)
	}
	c, err := o.trustClient(p)
	if err != nil {
		return nil, nil, err
	}
	dir := filepath.Join(o.Paths.StateDir, "actions")
	if err := p.SecureDir(dir); err != nil {
		return nil, nil, err
	}
	dst := filepath.Join(dir, "keys.json")
	if _, err := c.Fetch(action.KeysTarget, dst); err != nil {
		return nil, nil, err
	}
	raw, err := os.ReadFile(dst)
	if err != nil {
		return nil, nil, err
	}
	keys, err := action.ParseKeys(raw)
	if err != nil {
		return nil, nil, err
	}
	return keys, signedPause(c, dir, nil), nil
}
