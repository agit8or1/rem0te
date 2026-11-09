// rem0te-release maintains the signed update repository offline.
//
// It runs on a release machine, never on the portal. The portal receives
// only the output directory (metadata/ and targets/) and serves it as-is.
//
//	rem0te-release keygen   -out root1.pem
//	rem0te-release init     -repo DIR -root-key r1.pem -root-key r2.pem -root-key r3.pem -root-threshold 2 \
//	                        -targets-key targets.pem -snapshot-key snapshot.pem -timestamp-key timestamp.pem
//	rem0te-release release  -repo DIR -targets-key targets.pem -snapshot-key snapshot.pem -timestamp-key timestamp.pem \
//	                        -add windows/install.ps1=./install.ps1 -add windows/rem0te-agent.exe=./rem0te-agent.exe
//	                        [-add approval/keys.json=./keys.json]   (from `approval-signer keys`; checked before signing)
//	rem0te-release refresh  -repo DIR -timestamp-key timestamp.pem [-snapshot-key snapshot.pem]
//	rem0te-release rotate-root -repo DIR -old-root-key r1.pem -old-root-key r2.pem [-new-root-key n1.pem ...] \
//	                        [-replace targets=newtargets.pub.pem]
//	rem0te-release status   -repo DIR
//	rem0te-release verify   -repo DIR -trusted-root root-v1.json
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/agit8or1/rem0te/windows-installer/internal/action"
	"github.com/agit8or1/rem0te/windows-installer/internal/release"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "keygen":
		err = keygen(args)
	case "init":
		err = initRepo(args)
	case "release":
		err = doRelease(args)
	case "refresh":
		err = refresh(args)
	case "rotate-root":
		err = rotateRoot(args)
	case "status":
		err = status(args)
	case "verify":
		err = verify(args)
	case "pubkey":
		err = pubkey(args)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: rem0te-release keygen|pubkey|init|release|refresh|rotate-root|status|verify [flags]")
	os.Exit(2)
}

func keygen(args []string) error {
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	out := fs.String("out", "", "private key file to create (0600, never overwritten)")
	fs.Parse(args)
	if *out == "" {
		return fmt.Errorf("-out is required")
	}
	k, err := release.GenerateKey(*out)
	if err != nil {
		return err
	}
	fmt.Printf("created %s\nkeyid %s\n", *out, k.ID())
	return nil
}

// pubkey exports a public key, so a root rotation can name a new targets key
// without the root holders ever touching the targets private key.
func pubkey(args []string) error {
	fs := flag.NewFlagSet("pubkey", flag.ExitOnError)
	key := fs.String("key", "", "private key")
	out := fs.String("out", "", "public key PEM to write")
	fs.Parse(args)
	k, err := release.LoadKey(*key)
	if err != nil {
		return err
	}
	der, err := x509.MarshalPKIXPublicKey(k.Private.Public())
	if err != nil {
		return err
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	if *out == "" {
		os.Stdout.Write(data)
		return nil
	}
	return os.WriteFile(*out, data, 0o644)
}

func loadPub(p string) (*metadata.Key, error) {
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(raw)
	if blk == nil || blk.Type != "PUBLIC KEY" {
		return nil, fmt.Errorf("%s: not a PEM public key", p)
	}
	pk, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	if _, ok := pk.(ed25519.PublicKey); !ok {
		return nil, fmt.Errorf("%s: only ed25519", p)
	}
	return metadata.KeyFromPublicKey(pk)
}

func one(p string) (*release.Key, error) {
	if p == "" {
		return nil, nil
	}
	return release.LoadKey(p)
}

func initRepo(args []string) error {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	repo := fs.String("repo", "", "repository directory")
	var rootKeys, targetsKeys multi
	fs.Var(&rootKeys, "root-key", "root private key (repeat)")
	thr := fs.Int("root-threshold", 2, "root signatures required")
	fs.Var(&targetsKeys, "targets-key", "targets (release signing) key")
	snap := fs.String("snapshot-key", "", "snapshot key")
	ts := fs.String("timestamp-key", "", "timestamp key")
	fs.Parse(args)
	rk, err := release.LoadKeys(rootKeys)
	if err != nil {
		return err
	}
	tk, err := release.LoadKeys(targetsKeys)
	if err != nil {
		return err
	}
	sk, err := one(*snap)
	if err != nil {
		return err
	}
	tsk, err := one(*ts)
	if err != nil {
		return err
	}
	if err := release.Open(*repo).Init(release.InitOptions{RootKeys: rk, RootThreshold: *thr, TargetsKeys: tk, SnapshotKey: sk, TimestampKey: tsk}); err != nil {
		return err
	}
	fmt.Printf("initialised %s\nembed %s in the agent build (tools/windows-installer/trustroot/root.json)\n", *repo, filepath.Join(*repo, "metadata", "1.root.json"))
	return nil
}

func doRelease(args []string) error {
	fs := flag.NewFlagSet("release", flag.ExitOnError)
	repo := fs.String("repo", "", "repository directory")
	var targetsKeys, adds, removes, customs multi
	fs.Var(&targetsKeys, "targets-key", "targets key (repeat to meet threshold)")
	snap := fs.String("snapshot-key", "", "snapshot key")
	ts := fs.String("timestamp-key", "", "timestamp key")
	fs.Var(&adds, "add", "name=path (repeat)")
	fs.Var(&removes, "remove", "target name to drop (repeat)")
	fs.Var(&customs, "custom", "name=JSON custom metadata for an -add (e.g. '{\"version\":\"1.4.6\"}')")
	exp := fs.Duration("targets-expires", release.DefaultTargetsExpiry, "targets lifetime")
	fs.Parse(args)
	tk, err := release.LoadKeys(targetsKeys)
	if err != nil {
		return err
	}
	sk, err := one(*snap)
	if err != nil {
		return err
	}
	tsk, err := one(*ts)
	if err != nil {
		return err
	}
	cm := map[string]map[string]any{}
	for _, c := range customs {
		name, js, ok := strings.Cut(c, "=")
		if !ok {
			return fmt.Errorf("-custom wants name=JSON")
		}
		var v map[string]any
		if err := json.Unmarshal([]byte(js), &v); err != nil {
			return fmt.Errorf("-custom %s: %w", name, err)
		}
		cm[name] = v
	}
	specs := []release.TargetSpec{}
	for _, a := range adds {
		name, p, ok := strings.Cut(a, "=")
		if !ok {
			return fmt.Errorf("-add wants name=path")
		}
		// The approval key list is read by every agent before it will run an
		// action; refuse to sign one the agent would reject anyway.
		if name == action.KeysTarget {
			raw, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			keys, err := action.ParseKeys(raw)
			if err != nil {
				return fmt.Errorf("%s: %w (generate it with `approval-signer keys`)", p, err)
			}
			for _, k := range keys {
				fmt.Printf("approval key %s\n", k.Kid)
			}
		}
		specs = append(specs, release.TargetSpec{Name: name, File: p, Custom: cm[name]})
	}
	if err := release.Open(*repo).Release(release.ReleaseOptions{Add: specs, Remove: removes, TargetsKeys: tk, SnapshotKey: sk, TimestampKey: tsk, TargetsExpiry: *exp}); err != nil {
		return err
	}
	return status([]string{"-repo", *repo})
}

func refresh(args []string) error {
	fs := flag.NewFlagSet("refresh", flag.ExitOnError)
	repo := fs.String("repo", "", "repository directory")
	snap := fs.String("snapshot-key", "", "snapshot key (optional; re-signs snapshot too)")
	ts := fs.String("timestamp-key", "", "timestamp key")
	tsExp := fs.Duration("timestamp-expires", release.DefaultTimestampExpiry, "timestamp lifetime")
	fs.Parse(args)
	sk, err := one(*snap)
	if err != nil {
		return err
	}
	tsk, err := one(*ts)
	if err != nil {
		return err
	}
	if err := release.Open(*repo).Refresh(sk, tsk, 0, *tsExp); err != nil {
		return err
	}
	return status([]string{"-repo", *repo})
}

func rotateRoot(args []string) error {
	fs := flag.NewFlagSet("rotate-root", flag.ExitOnError)
	repo := fs.String("repo", "", "repository directory")
	var oldKeys, newKeys, replaces multi
	fs.Var(&oldKeys, "old-root-key", "current root key (repeat to meet threshold)")
	fs.Var(&newKeys, "new-root-key", "full new root key set (repeat; omit to keep)")
	thr := fs.Int("threshold", 0, "new root threshold (0 = keep)")
	fs.Var(&replaces, "replace", "role=pubkey.pem — replace that role's keys (repeat per key)")
	fs.Parse(args)
	ok, err := release.LoadKeys(oldKeys)
	if err != nil {
		return err
	}
	nk, err := release.LoadKeys(newKeys)
	if err != nil {
		return err
	}
	rep := map[string][]*metadata.Key{}
	for _, r := range replaces {
		role, p, found := strings.Cut(r, "=")
		if !found {
			return fmt.Errorf("-replace wants role=pubkey.pem")
		}
		k, err := loadPub(p)
		if err != nil {
			return err
		}
		rep[role] = append(rep[role], k)
	}
	if err := release.Open(*repo).RotateRoot(release.RotateOptions{OldRootKeys: ok, NewRootKeys: nk, NewThreshold: *thr, ReplaceRoleKey: rep}); err != nil {
		return err
	}
	fmt.Println("new root written. If a non-root role's key changed, run `release` (targets) or `refresh -snapshot-key` (snapshot/timestamp) with the new key next.")
	return status([]string{"-repo", *repo})
}

func status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	repo := fs.String("repo", "", "repository directory")
	fs.Parse(args)
	roles, names, err := release.Open(*repo).Status()
	if err != nil {
		return err
	}
	now := time.Now()
	for _, r := range roles {
		left := r.Expires.Sub(now).Round(time.Hour)
		warn := ""
		if left < 48*time.Hour {
			warn = "  <-- expires soon"
		}
		fmt.Printf("%-9s v%-4d threshold %d  keys %d  expires %s (%s)%s\n", r.Role, r.Version, r.Threshold, len(r.KeyIDs), r.Expires.Format(time.RFC3339), left, warn)
	}
	fmt.Println("targets:")
	for _, n := range names {
		fmt.Println("  " + n)
	}
	return nil
}

// verify runs the real endpoint client against the repository over loopback
// HTTP, from a given trusted root, exactly as an agent would. Run it before
// syncing a release to the portal.
func verify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	repo := fs.String("repo", "", "repository directory")
	rootFile := fs.String("trusted-root", "", "root.json an agent ships with (e.g. metadata/1.root.json)")
	mirror := fs.String("mirror", "", "verify a deployed mirror instead, e.g. https://portal.example.com/api/v1/public/updates")
	fs.Parse(args)
	root, err := os.ReadFile(*rootFile)
	if err != nil {
		return err
	}
	mirrorURL := *mirror
	if mirrorURL == "" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		srv := &http.Server{Handler: http.FileServer(http.Dir(*repo)), ReadHeaderTimeout: 5 * time.Second}
		go srv.Serve(ln)
		defer srv.Close()
		mirrorURL = "http://" + ln.Addr().String()
	}
	// Plain http only for loopback (a local check or a scratch API).
	insecure := strings.HasPrefix(mirrorURL, "http://127.0.0.1:") || strings.HasPrefix(mirrorURL, "http://localhost:")
	state, err := os.MkdirTemp("", "rem0te-verify")
	if err != nil {
		return err
	}
	defer os.RemoveAll(state)
	c, err := trust.New(trust.Config{MirrorURL: mirrorURL, EmbeddedRoot: root, StateDir: state, AllowInsecureHTTP: insecure})
	if err != nil {
		return err
	}
	for _, n := range c.Targets() {
		if _, err := c.Fetch(n, filepath.Join(state, "check")); err != nil {
			return err
		}
		fmt.Println("ok", n)
	}
	fmt.Printf("verified: root v%d, targets v%d, %d target(s)\n", c.RootVersion(), c.TargetsVersion(), len(c.Targets()))
	return nil
}
