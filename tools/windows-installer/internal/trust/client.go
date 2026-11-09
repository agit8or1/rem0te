// Package trust is the endpoint side of rem0te's signed update chain: a thin,
// opinionated wrapper around go-tuf v2's updater.
//
// Everything an agent executes after install comes through Fetch. The portal
// is only a mirror; what decides is the root of trust compiled into the
// binary (or a newer root that a threshold of the previous root's keys
// signed), and the local copy of the last metadata accepted, which is what
// makes rollback and freeze attacks fail across restarts.
package trust

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

// MaxTargetBytes bounds every download. The RustDesk client is ~25 MB; this
// leaves room while still refusing an attacker-chosen multi-gigabyte length.
const MaxTargetBytes = 200 << 20

// Config for one Client.
type Config struct {
	// MirrorURL is the base the repository is served under, e.g.
	// https://portal.example.com/api/v1/public/updates — metadata/ and
	// targets/ are appended.
	MirrorURL string
	// EmbeddedRoot is the root.json compiled into this binary.
	EmbeddedRoot []byte
	// StateDir holds trusted metadata between runs. On Windows it is under
	// C:\ProgramData\Rem0te\tuf with an ACL of SYSTEM and Administrators.
	StateDir string
	// AllowInsecureHTTP is for tests only: the loopback mirror in a unit test.
	AllowInsecureHTTP bool
	// HTTPClient overrides the fetcher's client (tests, proxies).
	HTTPClient *http.Client
	// Now is the reference time; zero means time.Now.
	Now time.Time
}

type Client struct {
	cfg Config
	up  *updater.Updater
}

var ErrNoTrustRoot = errors.New("this build carries no trust root; it cannot verify signed updates")

// HasRoot reports whether a binary was built with a real root (CI and dev
// builds carry an empty placeholder).
func HasRoot(root []byte) bool {
	var probe struct {
		Signed struct {
			Type string `json:"_type"`
		} `json:"signed"`
	}
	return json.Unmarshal(root, &probe) == nil && probe.Signed.Type == "root"
}

// New loads trusted state and refreshes metadata from the mirror. A refresh
// failure is returned as-is: expired metadata, a rollback, a bad signature
// and an unreachable mirror all fail closed.
func New(cfg Config) (*Client, error) {
	if !HasRoot(cfg.EmbeddedRoot) {
		return nil, ErrNoTrustRoot
	}
	u, err := url.Parse(cfg.MirrorURL)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid mirror URL %q", cfg.MirrorURL)
	}
	if u.Scheme != "https" && !(cfg.AllowInsecureHTTP && u.Scheme == "http") {
		return nil, fmt.Errorf("mirror must be https, got %q", u.Scheme)
	}
	metaDir := filepath.Join(cfg.StateDir, "metadata")
	targetsDir := filepath.Join(cfg.StateDir, "targets")
	for _, d := range []string{metaDir, targetsDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	root, err := chooseRoot(cfg.EmbeddedRoot, filepath.Join(metaDir, "root.json"))
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(cfg.MirrorURL, "/")
	uc, err := config.New(base+"/metadata", root)
	if err != nil {
		return nil, err
	}
	uc.LocalMetadataDir = metaDir
	uc.LocalTargetsDir = targetsDir
	uc.RemoteTargetsURL = base + "/targets"
	uc.PrefixTargetsWithHash = true
	if cfg.HTTPClient != nil {
		if err := uc.SetDefaultFetcherHTTPClient(cfg.HTTPClient); err != nil {
			return nil, err
		}
	}
	up, err := updater.New(uc)
	if err != nil {
		return nil, err
	}
	if !cfg.Now.IsZero() {
		up.UnsafeSetRefTime(cfg.Now)
	}
	if err := up.Refresh(); err != nil {
		return nil, fmt.Errorf("signed metadata refused: %w", err)
	}
	return &Client{cfg: cfg, up: up}, nil
}

// chooseRoot starts from whichever root is newer: the one the binary carries
// or the one this machine already accepted. Starting from the older would
// re-walk rotations (harmless); starting from a *replaced* binary's older
// embedded root while ignoring the local one would let an old binary forget a
// key revocation. go-tuf only walks forward from what it is given.
func chooseRoot(embedded []byte, localPath string) ([]byte, error) {
	local, err := os.ReadFile(localPath)
	if err != nil {
		return embedded, nil
	}
	ev, err1 := rootVersion(embedded)
	lv, err2 := rootVersion(local)
	if err1 != nil {
		return nil, fmt.Errorf("embedded root: %w", err1)
	}
	if err2 != nil || lv < ev {
		return embedded, nil
	}
	return local, nil
}

func rootVersion(raw []byte) (int64, error) {
	r, err := metadata.Root().FromBytes(raw)
	if err != nil {
		return 0, err
	}
	return r.Signed.Version, nil
}

// Target is a verified target's metadata.
type Target struct {
	Name   string
	Length int64
	SHA256 string
	Custom map[string]any
}

func (c *Client) Info(name string) (*Target, error) {
	tf, err := c.up.GetTargetInfo(name)
	if err != nil {
		return nil, fmt.Errorf("%s is not a signed target: %w", name, err)
	}
	t := &Target{Name: name, Length: tf.Length}
	if h, ok := tf.Hashes["sha256"]; ok {
		t.SHA256 = fmt.Sprintf("%x", []byte(h))
	} else {
		return nil, fmt.Errorf("%s has no sha256 in signed metadata", name)
	}
	if tf.Custom != nil {
		_ = json.Unmarshal(*tf.Custom, &t.Custom)
	}
	if t.Length <= 0 || t.Length > MaxTargetBytes {
		return nil, fmt.Errorf("%s: signed length %d outside 1..%d", name, t.Length, MaxTargetBytes)
	}
	return t, nil
}

// Fetch downloads a signed target to dest after go-tuf has verified its
// length and digest against signed metadata. The file is written to a
// sibling temp name and renamed, so a half-written or unverified file never
// sits at dest.
func (c *Client) Fetch(name, dest string) (*Target, error) {
	t, err := c.Info(name)
	if err != nil {
		return nil, err
	}
	tf, _ := c.up.GetTargetInfo(name)
	_, data, err := c.up.DownloadTarget(tf, filepath.Join(c.cfg.StateDir, "targets", "download.tmp"), "")
	if err != nil {
		return nil, fmt.Errorf("%s failed verification: %w", name, err)
	}
	tmp := dest + ".verifying"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	_ = os.Remove(filepath.Join(c.cfg.StateDir, "targets", "download.tmp"))
	return t, nil
}

// Targets lists every signed target name.
func (c *Client) Targets() []string {
	out := []string{}
	for n := range c.up.GetTopLevelTargets() {
		out = append(out, n)
	}
	return out
}

// RootVersion is reported on every heartbeat so the portal can show which
// agents have followed a key rotation.
func (c *Client) RootVersion() int64 {
	return c.up.GetTrustedMetadataSet().Root.Signed.Version
}

func (c *Client) TargetsVersion() int64 {
	return c.up.GetTrustedMetadataSet().Targets[metadata.TARGETS].Signed.Version
}

// ---------------------------------------------------------------- versions

var versionRE = regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,3}$`)

func ValidVersion(v string) bool { return versionRE.MatchString(v) }

// CompareVersions compares dotted numeric versions: -1, 0, 1.
func CompareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// RustdeskTargetName is the signed name of a RustDesk client build.
func RustdeskTargetName(version string) string {
	return "windows/rustdesk/rustdesk-" + version + "-x86_64.exe"
}

// DowngradeAllowed is true only when the signed target itself says so. The
// portal chooses *which* signed version to roll out (that is what staged
// rollouts are), but it cannot walk a fleet back to an older build with a
// known flaw unless the release signer explicitly marked that build as a
// permitted rollback target.
func (t *Target) DowngradeAllowed() bool {
	v, ok := t.Custom["allowDowngrade"].(bool)
	return ok && v
}
