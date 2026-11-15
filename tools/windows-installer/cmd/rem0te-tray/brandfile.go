package main

import (
	"io"
	"os"
	"path/filepath"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

// The last-known brand (0.53.1): %LOCALAPPDATA%\Rem0te\tray-brand.json, the
// user's own, so each person's tray keeps its own copy and nothing in the
// machine-wide tray folder the heartbeat writes is written by an
// unprivileged process.
// It holds exactly tray.Brand's four fields (business, provider,
// supportText, accent) — never a credential, a tray key, a code or message
// text — and is re-cleaned on every read. It is only a placeholder: the
// portal's first answer replaces whatever it says.
const brandFileName = "tray-brand.json"

// brandDir is the folder the brand file lives in, or "" when the user has no
// local app data folder (then nothing is read or written).
func brandDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" && filepath.IsAbs(d) {
		return filepath.Join(d, "Rem0te")
	}
	return ""
}

// loadBrand reads the brand file in dir. A missing, oversized or malformed
// file is no brand.
func loadBrand(dir string) tray.Brand {
	if dir == "" {
		return tray.Brand{}
	}
	f, err := os.Open(filepath.Join(dir, brandFileName))
	if err != nil {
		return tray.Brand{}
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, tray.MaxBrandFileBytes+1))
	if err != nil {
		return tray.Brand{}
	}
	b, ok := tray.ParseBrand(raw)
	if !ok {
		return tray.Brand{}
	}
	return b
}

// saveBrand writes b to dir, through a temporary file and a rename so a
// reader never sees half a file. Failure is not an error worth showing: the
// tray just starts generic next time.
func saveBrand(dir string, b tray.Brand) error {
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, brandFileName+".*.tmp")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(tray.MarshalBrand(b))
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), filepath.Join(dir, brandFileName))
	}
	if werr != nil {
		os.Remove(tmp.Name())
	}
	return werr
}
