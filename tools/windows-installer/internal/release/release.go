// Package release is the offline side of rem0te's signed update chain.
//
// It writes a TUF repository (https://theupdateframework.io) using go-tuf v2's
// metadata API: root, targets, snapshot and timestamp, consistent snapshots,
// hash-prefixed target files. The portal serves the resulting directory as a
// dumb mirror and holds none of these keys. That is the property the whole
// design rests on: a compromised portal or database can withhold or delay
// updates, but it cannot produce metadata an endpoint will accept, so it cannot
// install a replacement.
//
// Key separation:
//
//   - root      — offline, threshold (default 2 of 3). Only it can change who
//     may sign anything else, including itself.
//   - targets   — offline release-signing key. Decides which files exist and
//     their digests. This is "release signing" and nothing else.
//   - snapshot  — binds a consistent set of targets versions (anti mix-and-match).
//   - timestamp — freshness only. Can be run on a separate signer host on a
//     schedule; a stolen timestamp key can freeze clients on the newest
//     metadata they already accepted, never install anything.
//
// Job-approval signing (a later milestone) is a different key hierarchy
// entirely and never appears in this repository.
package release

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

const (
	RoleRoot      = "root"
	RoleTargets   = "targets"
	RoleSnapshot  = "snapshot"
	RoleTimestamp = "timestamp"
)

// Default lifetimes. The timestamp is short on purpose: it bounds how long a
// mirror can serve stale metadata before every client refuses it.
var (
	DefaultRootExpiry      = 365 * 24 * time.Hour
	DefaultTargetsExpiry   = 90 * 24 * time.Hour
	DefaultSnapshotExpiry  = 30 * 24 * time.Hour
	DefaultTimestampExpiry = 7 * 24 * time.Hour
)

// Target names are slash-separated, lower-case, no traversal. They become URL
// paths on the mirror and file names on the release machine.
var targetNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}(/[a-z0-9][a-z0-9._-]{0,63}){0,3}$`)

func ValidTargetName(name string) bool {
	return targetNameRE.MatchString(name) && !strings.Contains(name, "..")
}

// ---------------------------------------------------------------- keys

// Key is an ed25519 private key loaded from a PKCS#8 PEM file.
type Key struct {
	Path    string
	Private ed25519.PrivateKey
}

func (k *Key) Public() *metadata.Key {
	tk, err := metadata.KeyFromPublicKey(k.Private.Public())
	if err != nil {
		panic(err) // ed25519 public keys always convert
	}
	return tk
}

func (k *Key) ID() string {
	id, err := k.Public().ID()
	if err != nil {
		panic(err) // canonical JSON of an ed25519 key cannot fail
	}
	return id
}

func (k *Key) signer() (signature.Signer, error) {
	return signature.LoadSigner(k.Private, crypto.Hash(0))
}

// SignerFor exposes a key as a go-tuf signer (tests forge metadata with it).
func SignerFor(k *Key) (signature.Signer, error) { return k.signer() }

// GenerateKey writes a new ed25519 key to path (mode 0600, refusing to
// overwrite) and returns it.
func GenerateKey(p string) (*Key, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := pem.Encode(f, &pem.Block{Type: "PRIVATE KEY", Bytes: der}); err != nil {
		return nil, err
	}
	return &Key{Path: p, Private: priv}, nil
}

func LoadKey(p string) (*Key, error) {
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(raw)
	if blk == nil || blk.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s: not a PKCS#8 PEM private key", p)
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s: only ed25519 keys are supported", p)
	}
	return &Key{Path: p, Private: priv}, nil
}

func LoadKeys(paths []string) ([]*Key, error) {
	out := make([]*Key, 0, len(paths))
	for _, p := range paths {
		k, err := LoadKey(p)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, nil
}

// ---------------------------------------------------------------- repo

// Repo is a TUF repository on disk:
//
//	<dir>/metadata/N.root.json, root.json, N.targets.json, N.snapshot.json, timestamp.json
//	<dir>/targets/<dir>/<sha256>.<base>
//
// That is exactly the layout go-tuf's updater fetches with consistent
// snapshots on, and exactly what the portal mirrors.
type Repo struct {
	Dir string
	Now func() time.Time
}

func Open(dir string) *Repo { return &Repo{Dir: dir, Now: time.Now} }

func (r *Repo) metaDir() string    { return filepath.Join(r.Dir, "metadata") }
func (r *Repo) targetsDir() string { return filepath.Join(r.Dir, "targets") }
func (r *Repo) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

// InitOptions creates version 1 of every role.
type InitOptions struct {
	RootKeys      []*Key
	RootThreshold int
	TargetsKeys   []*Key
	SnapshotKey   *Key
	TimestampKey  *Key
	RootExpiry    time.Duration
}

func (r *Repo) Init(o InitOptions) error {
	if _, err := os.Stat(filepath.Join(r.metaDir(), "root.json")); err == nil {
		return errors.New("repository already initialised (metadata/root.json exists)")
	}
	if len(o.RootKeys) == 0 || o.RootThreshold < 1 || o.RootThreshold > len(o.RootKeys) {
		return fmt.Errorf("root threshold %d is not satisfiable by %d root keys", o.RootThreshold, len(o.RootKeys))
	}
	if len(o.TargetsKeys) == 0 || o.SnapshotKey == nil || o.TimestampKey == nil {
		return errors.New("targets, snapshot and timestamp keys are all required")
	}
	if err := distinctKeys(o); err != nil {
		return err
	}
	if o.RootExpiry == 0 {
		o.RootExpiry = DefaultRootExpiry
	}
	for _, d := range []string{r.metaDir(), r.targetsDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	now := r.now()

	root := metadata.Root(now.Add(o.RootExpiry))
	for _, k := range o.RootKeys {
		if err := root.Signed.AddKey(k.Public(), RoleRoot); err != nil {
			return err
		}
	}
	root.Signed.Roles[RoleRoot].Threshold = o.RootThreshold
	for _, k := range o.TargetsKeys {
		if err := root.Signed.AddKey(k.Public(), RoleTargets); err != nil {
			return err
		}
	}
	if err := root.Signed.AddKey(o.SnapshotKey.Public(), RoleSnapshot); err != nil {
		return err
	}
	if err := root.Signed.AddKey(o.TimestampKey.Public(), RoleTimestamp); err != nil {
		return err
	}
	if err := signAll(root, o.RootKeys); err != nil {
		return err
	}
	if err := r.writeRoot(root); err != nil {
		return err
	}

	targets := metadata.Targets(now.Add(DefaultTargetsExpiry))
	if err := signAll(targets, o.TargetsKeys); err != nil {
		return err
	}
	if err := writeVersioned(r.metaDir(), RoleTargets, targets.Signed.Version, targets); err != nil {
		return err
	}
	return r.publishSnapshotAndTimestamp(targets.Signed.Version, o.SnapshotKey, o.TimestampKey, 0, 0)
}

// Every role gets its own key. Reusing one key for two roles collapses the
// separation this package exists to provide, so it is refused outright.
func distinctKeys(o InitOptions) error {
	seen := map[string]string{}
	add := func(role string, k *Key) error {
		id := k.ID()
		if prev, ok := seen[id]; ok && prev != role {
			return fmt.Errorf("key %s is used for both %s and %s; every role needs its own key", id[:12], prev, role)
		}
		seen[id] = role
		return nil
	}
	for _, k := range o.RootKeys {
		if err := add(RoleRoot, k); err != nil {
			return err
		}
	}
	for _, k := range o.TargetsKeys {
		if err := add(RoleTargets, k); err != nil {
			return err
		}
	}
	if err := add(RoleSnapshot, o.SnapshotKey); err != nil {
		return err
	}
	return add(RoleTimestamp, o.TimestampKey)
}

// TargetSpec is one file to publish.
type TargetSpec struct {
	Name   string
	File   string
	Custom map[string]any
}

// ReleaseOptions publishes a new targets version.
type ReleaseOptions struct {
	Add           []TargetSpec
	Remove        []string
	TargetsKeys   []*Key
	SnapshotKey   *Key
	TimestampKey  *Key
	TargetsExpiry time.Duration
}

func (r *Repo) Release(o ReleaseOptions) error {
	root, err := r.Root()
	if err != nil {
		return err
	}
	if err := requireThreshold(root, RoleTargets, o.TargetsKeys); err != nil {
		return err
	}
	cur, err := r.Targets()
	if err != nil {
		return err
	}
	if o.TargetsExpiry == 0 {
		o.TargetsExpiry = DefaultTargetsExpiry
	}
	next := metadata.Targets(r.now().Add(o.TargetsExpiry))
	next.Signed.Version = cur.Signed.Version + 1
	for name, tf := range cur.Signed.Targets {
		next.Signed.Targets[name] = tf
	}
	for _, name := range o.Remove {
		if _, ok := next.Signed.Targets[name]; !ok {
			return fmt.Errorf("cannot remove %q: not a current target", name)
		}
		delete(next.Signed.Targets, name)
	}
	for _, t := range o.Add {
		if !ValidTargetName(t.Name) {
			return fmt.Errorf("invalid target name %q", t.Name)
		}
		tf, err := metadata.TargetFile().FromFile(t.File, "sha256")
		if err != nil {
			return fmt.Errorf("%s: %w", t.File, err)
		}
		if len(t.Custom) > 0 {
			raw, err := json.Marshal(t.Custom)
			if err != nil {
				return err
			}
			rm := json.RawMessage(raw)
			tf.Custom = &rm
		}
		tf.Path = t.Name
		if err := r.storeTarget(t.Name, t.File, tf); err != nil {
			return err
		}
		next.Signed.Targets[t.Name] = tf
	}
	if err := signAll(next, o.TargetsKeys); err != nil {
		return err
	}
	if err := writeVersioned(r.metaDir(), RoleTargets, next.Signed.Version, next); err != nil {
		return err
	}
	return r.publishSnapshotAndTimestamp(next.Signed.Version, o.SnapshotKey, o.TimestampKey, 0, 0)
}

// Refresh re-signs the timestamp (and, if a snapshot key is given, the
// snapshot) with no content change. This is the scheduled job: run it more
// often than DefaultTimestampExpiry or every client stops accepting updates —
// failing closed, which is the point.
func (r *Repo) Refresh(snapshotKey, timestampKey *Key, snapshotExpiry, timestampExpiry time.Duration) error {
	if timestampKey == nil {
		return errors.New("timestamp key required")
	}
	if snapshotKey == nil {
		snap, err := r.Snapshot()
		if err != nil {
			return err
		}
		return r.writeTimestamp(snap, timestampKey, timestampExpiry)
	}
	tg, err := r.Targets()
	if err != nil {
		return err
	}
	return r.publishSnapshotAndTimestamp(tg.Signed.Version, snapshotKey, timestampKey, snapshotExpiry, timestampExpiry)
}

func (r *Repo) publishSnapshotAndTimestamp(targetsVersion int64, snapKey, tsKey *Key, snapExp, tsExp time.Duration) error {
	if snapKey == nil || tsKey == nil {
		return errors.New("snapshot and timestamp keys are required to publish")
	}
	root, err := r.Root()
	if err != nil {
		return err
	}
	if err := requireThreshold(root, RoleSnapshot, []*Key{snapKey}); err != nil {
		return err
	}
	if err := requireThreshold(root, RoleTimestamp, []*Key{tsKey}); err != nil {
		return err
	}
	if snapExp == 0 {
		snapExp = DefaultSnapshotExpiry
	}
	var version int64 = 1
	if cur, err := r.Snapshot(); err == nil {
		version = cur.Signed.Version + 1
	}
	snap := metadata.Snapshot(r.now().Add(snapExp))
	snap.Signed.Version = version
	snap.Signed.Meta["targets.json"] = metadata.MetaFile(targetsVersion)
	if err := signAll(snap, []*Key{snapKey}); err != nil {
		return err
	}
	if err := writeVersioned(r.metaDir(), RoleSnapshot, snap.Signed.Version, snap); err != nil {
		return err
	}
	return r.writeTimestamp(snap, tsKey, tsExp)
}

func (r *Repo) writeTimestamp(snap *metadata.Metadata[metadata.SnapshotType], tsKey *Key, exp time.Duration) error {
	root, err := r.Root()
	if err != nil {
		return err
	}
	if err := requireThreshold(root, RoleTimestamp, []*Key{tsKey}); err != nil {
		return err
	}
	if exp == 0 {
		exp = DefaultTimestampExpiry
	}
	var version int64 = 1
	if cur, err := r.Timestamp(); err == nil {
		version = cur.Signed.Version + 1
	}
	ts := metadata.Timestamp(r.now().Add(exp))
	ts.Signed.Version = version
	ts.Signed.Meta["snapshot.json"] = metadata.MetaFile(snap.Signed.Version)
	if err := signAll(ts, []*Key{tsKey}); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(r.metaDir(), "timestamp.json"), ts)
}

// RotateOptions writes root version N+1. The new root must be signed by a
// threshold of the *old* root keys (so a client trusting N accepts it) and a
// threshold of the *new* root keys (so it is self-consistent). go-tuf's
// updater enforces both; this refuses to write a root that would fail.
type RotateOptions struct {
	OldRootKeys    []*Key
	NewRootKeys    []*Key // full new root key set; empty = unchanged
	NewThreshold   int    // 0 = unchanged
	ReplaceRoleKey map[string][]*metadata.Key
	RootExpiry     time.Duration
}

func (r *Repo) RotateRoot(o RotateOptions) error {
	old, err := r.Root()
	if err != nil {
		return err
	}
	if err := requireThreshold(old, RoleRoot, o.OldRootKeys); err != nil {
		return fmt.Errorf("old root: %w", err)
	}
	if o.RootExpiry == 0 {
		o.RootExpiry = DefaultRootExpiry
	}
	raw, err := old.ToBytes(false)
	if err != nil {
		return err
	}
	next, err := metadata.Root().FromBytes(raw)
	if err != nil {
		return err
	}
	next.ClearSignatures()
	next.Signed.Version = old.Signed.Version + 1
	next.Signed.Expires = r.now().Add(o.RootExpiry)

	newRootSigners := o.OldRootKeys
	if len(o.NewRootKeys) > 0 {
		for _, id := range append([]string(nil), next.Signed.Roles[RoleRoot].KeyIDs...) {
			if err := next.Signed.RevokeKey(id, RoleRoot); err != nil {
				return err
			}
		}
		for _, k := range o.NewRootKeys {
			if err := next.Signed.AddKey(k.Public(), RoleRoot); err != nil {
				return err
			}
		}
		newRootSigners = o.NewRootKeys
	}
	if o.NewThreshold > 0 {
		next.Signed.Roles[RoleRoot].Threshold = o.NewThreshold
	}
	for role, keys := range o.ReplaceRoleKey {
		if role == RoleRoot {
			return errors.New("replace root keys with NewRootKeys, not ReplaceRoleKey")
		}
		if _, ok := next.Signed.Roles[role]; !ok {
			return fmt.Errorf("unknown role %q", role)
		}
		for _, id := range append([]string(nil), next.Signed.Roles[role].KeyIDs...) {
			if err := next.Signed.RevokeKey(id, role); err != nil {
				return err
			}
		}
		for _, k := range keys {
			if err := next.Signed.AddKey(k, role); err != nil {
				return err
			}
		}
	}
	if t := next.Signed.Roles[RoleRoot]; t.Threshold > len(t.KeyIDs) {
		return fmt.Errorf("new root threshold %d exceeds its %d keys", t.Threshold, len(t.KeyIDs))
	}
	signers := uniqueKeys(append(append([]*Key{}, o.OldRootKeys...), newRootSigners...))
	if err := signAll(next, signers); err != nil {
		return err
	}
	if err := requireThreshold(next, RoleRoot, newRootSigners); err != nil {
		return fmt.Errorf("new root: %w", err)
	}
	// Self-check exactly as a client will: old root verifies new, new verifies new.
	if err := old.VerifyDelegate(RoleRoot, next); err != nil {
		return fmt.Errorf("new root would be rejected by clients trusting version %d: %w", old.Signed.Version, err)
	}
	if err := next.VerifyDelegate(RoleRoot, next); err != nil {
		return fmt.Errorf("new root is not self-consistent: %w", err)
	}
	return r.writeRoot(next)
}

// ---------------------------------------------------------------- read

func (r *Repo) Root() (*metadata.Metadata[metadata.RootType], error) {
	return metadata.Root().FromFile(filepath.Join(r.metaDir(), "root.json"))
}

func (r *Repo) Targets() (*metadata.Metadata[metadata.TargetsType], error) {
	snap, err := r.Snapshot()
	if err != nil {
		return nil, err
	}
	v := snap.Signed.Meta["targets.json"].Version
	return metadata.Targets().FromFile(filepath.Join(r.metaDir(), fmt.Sprintf("%d.targets.json", v)))
}

func (r *Repo) Snapshot() (*metadata.Metadata[metadata.SnapshotType], error) {
	ts, err := r.Timestamp()
	if err != nil {
		return nil, err
	}
	v := ts.Signed.Meta["snapshot.json"].Version
	return metadata.Snapshot().FromFile(filepath.Join(r.metaDir(), fmt.Sprintf("%d.snapshot.json", v)))
}

func (r *Repo) Timestamp() (*metadata.Metadata[metadata.TimestampType], error) {
	return metadata.Timestamp().FromFile(filepath.Join(r.metaDir(), "timestamp.json"))
}

// Status is what `rem0te-release status` prints and what the portal's mirror
// check reports: versions and expiry per role.
type RoleStatus struct {
	Role      string    `json:"role"`
	Version   int64     `json:"version"`
	Expires   time.Time `json:"expires"`
	Threshold int       `json:"threshold"`
	KeyIDs    []string  `json:"keyIds"`
}

func (r *Repo) Status() ([]RoleStatus, []string, error) {
	root, err := r.Root()
	if err != nil {
		return nil, nil, err
	}
	tg, err := r.Targets()
	if err != nil {
		return nil, nil, err
	}
	snap, err := r.Snapshot()
	if err != nil {
		return nil, nil, err
	}
	ts, err := r.Timestamp()
	if err != nil {
		return nil, nil, err
	}
	role := func(name string, v int64, exp time.Time) RoleStatus {
		rr := root.Signed.Roles[name]
		return RoleStatus{Role: name, Version: v, Expires: exp, Threshold: rr.Threshold, KeyIDs: rr.KeyIDs}
	}
	names := make([]string, 0, len(tg.Signed.Targets))
	for n := range tg.Signed.Targets {
		names = append(names, n)
	}
	sort.Strings(names)
	return []RoleStatus{
		role(RoleRoot, root.Signed.Version, root.Signed.Expires),
		role(RoleTargets, tg.Signed.Version, tg.Signed.Expires),
		role(RoleSnapshot, snap.Signed.Version, snap.Signed.Expires),
		role(RoleTimestamp, ts.Signed.Version, ts.Signed.Expires),
	}, names, nil
}

// ---------------------------------------------------------------- helpers

func (r *Repo) writeRoot(root *metadata.Metadata[metadata.RootType]) error {
	if err := writeVersioned(r.metaDir(), RoleRoot, root.Signed.Version, root); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(r.metaDir(), "root.json"), root)
}

// storeTarget copies the file to targets/<dir>/<sha256>.<base>, the
// consistent-snapshot name go-tuf's updater requests.
func (r *Repo) storeTarget(name, src string, tf *metadata.TargetFiles) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := tf.VerifyLengthHashes(data); err != nil {
		return fmt.Errorf("%s changed while it was being hashed: %w", src, err)
	}
	digest := fmt.Sprintf("%x", []byte(tf.Hashes["sha256"]))
	dir, base := path.Split(name)
	dst := filepath.Join(r.targetsDir(), filepath.FromSlash(dir), digest+"."+base)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

type signable interface {
	Sign(signature.Signer) (*metadata.Signature, error)
}

func signAll(m signable, keys []*Key) error {
	for _, k := range keys {
		s, err := k.signer()
		if err != nil {
			return err
		}
		if _, err := m.Sign(s); err != nil {
			return err
		}
	}
	return nil
}

func requireThreshold(root *metadata.Metadata[metadata.RootType], role string, keys []*Key) error {
	rr, ok := root.Signed.Roles[role]
	if !ok {
		return fmt.Errorf("root has no %s role", role)
	}
	allowed := map[string]bool{}
	for _, id := range rr.KeyIDs {
		allowed[id] = true
	}
	n := 0
	for _, k := range uniqueKeys(keys) {
		if allowed[k.ID()] {
			n++
		} else {
			return fmt.Errorf("key %s (%s) is not a %s key in root v%d", k.ID()[:12], k.Path, role, root.Signed.Version)
		}
	}
	if n < rr.Threshold {
		return fmt.Errorf("%s needs %d signatures, %d key(s) given", role, rr.Threshold, n)
	}
	return nil
}

func uniqueKeys(keys []*Key) []*Key {
	seen := map[string]bool{}
	out := []*Key{}
	for _, k := range keys {
		if k == nil || seen[k.ID()] {
			continue
		}
		seen[k.ID()] = true
		out = append(out, k)
	}
	return out
}

type toFiler interface {
	ToBytes(bool) ([]byte, error)
}

func writeVersioned(dir, role string, version int64, m toFiler) error {
	p := filepath.Join(dir, fmt.Sprintf("%d.%s.json", version, role))
	if _, err := os.Stat(p); err == nil {
		return fmt.Errorf("%s already exists; versions are never overwritten", p)
	}
	return atomicWrite(p, m)
}

func atomicWrite(p string, m toFiler) error {
	data, err := m.ToBytes(true)
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}
