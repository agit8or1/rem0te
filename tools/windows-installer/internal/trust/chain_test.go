package trust_test

// End-to-end tests of the signed update chain: the offline release tooling
// writes a real TUF repository, an httptest server plays the portal's mirror,
// and the real endpoint client verifies against it. Each attack test changes
// only what a compromised portal/database could change — the mirror's files —
// never the release keys.

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/release"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

type keys struct {
	root      []*release.Key
	targets   *release.Key
	snapshot  *release.Key
	timestamp *release.Key
}

func genKey(t *testing.T, dir, name string) *release.Key {
	t.Helper()
	k, err := release.GenerateKey(filepath.Join(dir, name+".pem"))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

type fixture struct {
	t     *testing.T
	repo  *release.Repo
	dir   string
	keys  keys
	srv   *httptest.Server
	state string
	root1 []byte
}

// newFixture: root 2-of-3, one key per other role, one release with two targets.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	base := t.TempDir()
	kd := filepath.Join(base, "keys")
	os.MkdirAll(kd, 0o700)
	k := keys{
		root:      []*release.Key{genKey(t, kd, "r1"), genKey(t, kd, "r2"), genKey(t, kd, "r3")},
		targets:   genKey(t, kd, "targets"),
		snapshot:  genKey(t, kd, "snapshot"),
		timestamp: genKey(t, kd, "timestamp"),
	}
	dir := filepath.Join(base, "repo")
	repo := release.Open(dir)
	if err := repo.Init(release.InitOptions{RootKeys: k.root, RootThreshold: 2, TargetsKeys: []*release.Key{k.targets}, SnapshotKey: k.snapshot, TimestampKey: k.timestamp}); err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, repo: repo, dir: dir, keys: k, state: filepath.Join(base, "agent-state")}
	f.root1, _ = os.ReadFile(filepath.Join(dir, "metadata", "1.root.json"))
	f.release(map[string]string{"windows/install.ps1": "Write-Host 'v1'", "windows/rem0te-agent.exe": "MZ agent v1"}, nil)
	f.srv = httptest.NewServer(http.FileServer(http.Dir(dir)))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) release(files map[string]string, custom map[string]map[string]any) {
	f.t.Helper()
	src := f.t.TempDir()
	specs := []release.TargetSpec{}
	for name, body := range files {
		p := filepath.Join(src, strings.ReplaceAll(name, "/", "_"))
		os.WriteFile(p, []byte(body), 0o644)
		specs = append(specs, release.TargetSpec{Name: name, File: p, Custom: custom[name]})
	}
	if err := f.repo.Release(release.ReleaseOptions{Add: specs, TargetsKeys: []*release.Key{f.keys.targets}, SnapshotKey: f.keys.snapshot, TimestampKey: f.keys.timestamp}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) client(now ...time.Time) (*trust.Client, error) {
	cfg := trust.Config{MirrorURL: f.srv.URL, EmbeddedRoot: f.root1, StateDir: f.state, AllowInsecureHTTP: true}
	if len(now) > 0 {
		cfg.Now = now[0]
	}
	return trust.New(cfg)
}

func (f *fixture) mustClient() *trust.Client {
	f.t.Helper()
	c, err := f.client()
	if err != nil {
		f.t.Fatal(err)
	}
	return c
}

func (f *fixture) meta(name string) string { return filepath.Join(f.dir, "metadata", name) }

func read(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// ------------------------------------------------------------------ basics

func TestHappyPath(t *testing.T) {
	f := newFixture(t)
	c := f.mustClient()
	dest := filepath.Join(t.TempDir(), "install.ps1")
	tg, err := c.Fetch("windows/install.ps1", dest)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(read(t, dest)); got != "Write-Host 'v1'" {
		t.Fatalf("content %q", got)
	}
	if len(tg.SHA256) != 64 || c.RootVersion() != 1 || c.TargetsVersion() != 2 {
		t.Fatalf("unexpected %+v root=%d targets=%d", tg, c.RootVersion(), c.TargetsVersion())
	}
}

func TestNoRootRefused(t *testing.T) {
	_, err := trust.New(trust.Config{MirrorURL: "https://x.example", EmbeddedRoot: []byte("{}"), StateDir: t.TempDir()})
	if !errors.Is(err, trust.ErrNoTrustRoot) {
		t.Fatalf("want ErrNoTrustRoot, got %v", err)
	}
}

func TestPlainHTTPRefused(t *testing.T) {
	f := newFixture(t)
	_, err := trust.New(trust.Config{MirrorURL: f.srv.URL, EmbeddedRoot: f.root1, StateDir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("plain http accepted: %v", err)
	}
}

func TestUnknownTargetRefused(t *testing.T) {
	f := newFixture(t)
	c := f.mustClient()
	if _, err := c.Fetch("windows/payload.exe", filepath.Join(t.TempDir(), "x")); err == nil {
		t.Fatal("unsigned target name was fetched")
	}
}

// ------------------------------------------------------------------ attacks by the mirror

// The portal swaps the bytes of a signed file.
func TestTamperedTargetRefused(t *testing.T) {
	f := newFixture(t)
	matches, _ := filepath.Glob(filepath.Join(f.dir, "targets", "windows", "*.install.ps1"))
	if len(matches) != 1 {
		t.Fatalf("expected one stored install.ps1, got %v", matches)
	}
	os.WriteFile(matches[0], []byte("Write-Host 'XX'"), 0o644) // same length: only the digest catches it
	c := f.mustClient()
	dest := filepath.Join(t.TempDir(), "install.ps1")
	_, err := c.Fetch("windows/install.ps1", dest)
	refused(t, err, "hash")
	if _, err := os.Stat(dest); err == nil {
		t.Fatal("unverified bytes were left at the destination")
	}
}

// The portal (holding no release key) publishes its own targets metadata
// listing a replacement installer, signed with a key it generated.
func TestForgedTargetsRefused(t *testing.T) {
	f := newFixture(t)
	evil := genKey(t, t.TempDir(), "evil")
	tg, err := f.repo.Targets()
	if err != nil {
		t.Fatal(err)
	}
	tg.ClearSignatures()
	tg.Signed.Version++
	tf, _ := metadata.TargetFile().FromBytes("windows/install.ps1", []byte("evil"), "sha256")
	tg.Signed.Targets["windows/install.ps1"] = tf
	signWith(t, tg, evil)
	tg.ToFile(f.meta("3.targets.json"), true)
	// It has the snapshot and timestamp keys? No — but give it them anyway to
	// show the targets signature alone is decisive.
	forgeSnapshotTimestamp(t, f, 3)
	_, err = f.client()
	refused(t, err, "targets")
}

// Rollback: the mirror replays an older, validly signed timestamp after the
// agent has seen a newer one. The agent's persisted state is what catches it.
func TestRollbackRefusedAcrossRestarts(t *testing.T) {
	f := newFixture(t)
	oldTS := read(t, f.meta("timestamp.json"))
	f.release(map[string]string{"windows/install.ps1": "Write-Host 'v2'"}, nil)
	f.mustClient() // agent accepts the newer release and persists it

	os.WriteFile(f.meta("timestamp.json"), oldTS, 0o644)
	_, err := f.client()
	refused(t, err, "version")
}

// Freeze: the mirror stops publishing; metadata it serves expires. The agent
// must stop trusting it rather than keep installing a stale release.
func TestFreezeRefusedAfterExpiry(t *testing.T) {
	f := newFixture(t)
	later := time.Now().Add(release.DefaultTimestampExpiry + time.Hour)
	if _, err := f.client(later); err == nil || !strings.Contains(strings.ToLower(err.Error()), "expired") {
		t.Fatalf("expired timestamp accepted: %v", err)
	}
	// A timestamp refresh (scheduled signer job) restores service.
	f.repo.Now = func() time.Time { return later }
	if err := f.repo.Refresh(nil, f.keys.timestamp, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.client(later); err != nil {
		t.Fatalf("refreshed timestamp refused: %v", err)
	}
}

// Mix-and-match: current timestamp, snapshot from a different release.
func TestMixAndMatchRefused(t *testing.T) {
	f := newFixture(t)
	f.release(map[string]string{"windows/install.ps1": "Write-Host 'v2'"}, nil)
	ts, _ := f.repo.Timestamp()
	cur := ts.Signed.Meta["snapshot.json"].Version
	// Overwrite the snapshot the timestamp names with the previous one.
	os.WriteFile(f.meta(itoa(cur)+".snapshot.json"), read(t, f.meta(itoa(cur-1)+".snapshot.json")), 0o644)
	_, err := f.client()
	refused(t, err, "expected 3, got 2")
}

// A stolen timestamp key (e.g. on a compromised signer host) can re-date
// metadata but cannot introduce a target or point back at an older snapshot
// once an agent has seen a newer one.
func TestStolenTimestampKeyCannotInstall(t *testing.T) {
	f := newFixture(t)
	f.release(map[string]string{"windows/install.ps1": "Write-Host 'v2'"}, nil)
	f.mustClient()

	ts, _ := f.repo.Timestamp()
	ts.ClearSignatures()
	ts.Signed.Version++
	ts.Signed.Meta["snapshot.json"] = metadata.MetaFile(1) // the first release's snapshot
	signWith(t, ts, f.keys.timestamp)
	ts.ToFile(f.meta("timestamp.json"), true)
	_, err := f.client()
	refused(t, err, "snapshot")
}

// ------------------------------------------------------------------ rotation

func TestRootRotationFollowedAndOldTargetsKeyRevoked(t *testing.T) {
	f := newFixture(t)
	f.mustClient()

	kd := t.TempDir()
	newRoot := []*release.Key{genKey(t, kd, "n1"), genKey(t, kd, "n2"), genKey(t, kd, "n3")}
	newTargets := genKey(t, kd, "targets2")
	// v2: new root keys (signed by 2 old + new threshold)
	if err := f.repo.RotateRoot(release.RotateOptions{OldRootKeys: f.keys.root[:2], NewRootKeys: newRoot, NewThreshold: 2}); err != nil {
		t.Fatal(err)
	}
	// v3: replace the targets key, signed by the new root keys only
	if err := f.repo.RotateRoot(release.RotateOptions{OldRootKeys: newRoot[1:], ReplaceRoleKey: map[string][]*metadata.Key{release.RoleTargets: {newTargets.Public()}}}); err != nil {
		t.Fatal(err)
	}
	// The old targets key is now refused by the tooling itself...
	err := f.repo.Release(release.ReleaseOptions{Add: nil, TargetsKeys: []*release.Key{f.keys.targets}, SnapshotKey: f.keys.snapshot, TimestampKey: f.keys.timestamp})
	if err == nil {
		t.Fatal("tooling signed targets with a revoked key")
	}
	f.keys.targets = newTargets
	f.release(map[string]string{"windows/install.ps1": "Write-Host 'v3'"}, nil)

	// ...and an agent that shipped with root v1 walks v1 -> v2 -> v3.
	c := f.mustClient()
	if c.RootVersion() != 3 {
		t.Fatalf("root version %d, want 3", c.RootVersion())
	}
	dest := filepath.Join(t.TempDir(), "i.ps1")
	if _, err := c.Fetch("windows/install.ps1", dest); err != nil || string(read(t, dest)) != "Write-Host 'v3'" {
		t.Fatalf("fetch after rotation: %v %q", err, read(t, dest))
	}
}

// The tooling will not write a root that clients would reject, and a client
// rejects one written by hand with too few old-root signatures.
func TestUnderSignedRootRotationRefused(t *testing.T) {
	f := newFixture(t)
	if err := f.repo.RotateRoot(release.RotateOptions{OldRootKeys: f.keys.root[:1]}); err == nil {
		t.Fatal("rotation with 1 of 2 required root signatures was written")
	}
	// A compromised portal holding one leaked root key writes v2 itself.
	root, _ := f.repo.Root()
	root.ClearSignatures()
	root.Signed.Version = 2
	evilTargets := genKey(t, t.TempDir(), "evil")
	for _, id := range append([]string(nil), root.Signed.Roles[release.RoleTargets].KeyIDs...) {
		root.Signed.RevokeKey(id, release.RoleTargets)
	}
	root.Signed.AddKey(evilTargets.Public(), release.RoleTargets)
	signWith(t, root, f.keys.root[0])
	root.ToFile(f.meta("2.root.json"), true)
	c, err := f.client()
	t.Logf("under-signed root: err=%v", err)
	if err == nil && c.RootVersion() != 1 {
		t.Fatalf("root v%d with one signature was accepted", c.RootVersion())
	}
}

// A replaced binary that embeds an *older* root must not make the machine
// forget a rotation it already followed.
func TestOlderEmbeddedRootDoesNotForgetRotation(t *testing.T) {
	f := newFixture(t)
	if err := f.repo.RotateRoot(release.RotateOptions{OldRootKeys: f.keys.root[:2]}); err != nil {
		t.Fatal(err)
	}
	if c := f.mustClient(); c.RootVersion() != 2 {
		t.Fatalf("root %d", c.RootVersion())
	}
	// Mirror now hides 2.root.json; an agent starting from v1 alone would
	// stay on v1, but this one starts from its persisted v2.
	os.Remove(f.meta("2.root.json"))
	c := f.mustClient()
	if c.RootVersion() != 2 {
		t.Fatalf("agent fell back to root v%d", c.RootVersion())
	}
}

// ------------------------------------------------------------------ tooling guards

func TestInitRefusesKeyReuse(t *testing.T) {
	kd := t.TempDir()
	r := []*release.Key{genKey(t, kd, "a"), genKey(t, kd, "b")}
	err := release.Open(filepath.Join(kd, "repo")).Init(release.InitOptions{RootKeys: r, RootThreshold: 2, TargetsKeys: []*release.Key{r[0]}, SnapshotKey: genKey(t, kd, "s"), TimestampKey: genKey(t, kd, "t")})
	if err == nil || !strings.Contains(err.Error(), "own key") {
		t.Fatalf("root key reused as targets key: %v", err)
	}
}

func TestInvalidTargetNameRefused(t *testing.T) {
	f := newFixture(t)
	p := filepath.Join(t.TempDir(), "x")
	os.WriteFile(p, []byte("x"), 0o644)
	for _, name := range []string{"../etc/passwd", "Windows/X.exe", "a//b", "/abs"} {
		err := f.repo.Release(release.ReleaseOptions{Add: []release.TargetSpec{{Name: name, File: p}}, TargetsKeys: []*release.Key{f.keys.targets}, SnapshotKey: f.keys.snapshot, TimestampKey: f.keys.timestamp})
		if err == nil {
			t.Fatalf("name %q accepted", name)
		}
	}
}

func TestVersionsAreNeverOverwritten(t *testing.T) {
	f := newFixture(t)
	before := read(t, f.meta("2.targets.json"))
	f.release(map[string]string{"windows/install.ps1": "x"}, nil)
	if !bytes.Equal(before, read(t, f.meta("2.targets.json"))) {
		t.Fatal("targets v2 was rewritten")
	}
}

func TestDowngradeMarkerComesFromSignedMetadata(t *testing.T) {
	f := newFixture(t)
	f.release(map[string]string{
		trust.RustdeskTargetName("1.4.5"): "old",
		trust.RustdeskTargetName("1.4.6"): "new",
	}, map[string]map[string]any{
		trust.RustdeskTargetName("1.4.5"): {"version": "1.4.5", "allowDowngrade": true},
		trust.RustdeskTargetName("1.4.6"): {"version": "1.4.6"},
	})
	c := f.mustClient()
	old, _ := c.Info(trust.RustdeskTargetName("1.4.5"))
	nw, _ := c.Info(trust.RustdeskTargetName("1.4.6"))
	if !old.DowngradeAllowed() || nw.DowngradeAllowed() {
		t.Fatalf("custom metadata not honoured: %+v %+v", old.Custom, nw.Custom)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		w    int
	}{{"1.4.6", "1.4.5", 1}, {"1.4", "1.4.0", 0}, {"1.10.0", "1.9.9", 1}, {"0.9", "1.0", -1}}
	for _, c := range cases {
		if g := trust.CompareVersions(c.a, c.b); g != c.w {
			t.Errorf("%s vs %s = %d want %d", c.a, c.b, g, c.w)
		}
	}
}

// ------------------------------------------------------------------ helpers

// refused asserts a refusal and that it names the reason, so a test cannot
// pass because something unrelated (a 404, a bad fixture) failed instead.
func refused(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatal("accepted; expected a refusal")
	}
	t.Logf("refused as expected: %v", err)
	if !strings.Contains(strings.ToLower(err.Error()), want) {
		t.Fatalf("refusal %q does not mention %q", err, want)
	}
}

func signWith[T metadata.Roles](t *testing.T, m *metadata.Metadata[T], k *release.Key) {
	t.Helper()
	s, err := release.SignerFor(k)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Sign(s); err != nil {
		t.Fatal(err)
	}
}

// forgeSnapshotTimestamp gives the attacker the online keys too, to show that
// a portal that also held snapshot+timestamp still cannot change targets.
func forgeSnapshotTimestamp(t *testing.T, f *fixture, targetsVersion int64) {
	t.Helper()
	snap, _ := f.repo.Snapshot()
	snap.ClearSignatures()
	snap.Signed.Version++
	snap.Signed.Meta["targets.json"] = metadata.MetaFile(targetsVersion)
	signWith(t, snap, f.keys.snapshot)
	snap.ToFile(f.meta(itoa(snap.Signed.Version)+".snapshot.json"), true)
	ts, _ := f.repo.Timestamp()
	ts.ClearSignatures()
	ts.Signed.Version++
	ts.Signed.Meta["snapshot.json"] = metadata.MetaFile(snap.Signed.Version)
	signWith(t, ts, f.keys.timestamp)
	ts.ToFile(f.meta("timestamp.json"), true)
}

func itoa(v int64) string { b, _ := json.Marshal(v); return string(b) }
