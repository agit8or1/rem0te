package grant

// The grant public keys, as the signed release metadata carries them (0.72):
// msa/grant-keys.json, a TUF target the release owner adds with
// `rem0te-signed-grant-key add` and `rem0te-signed-publish`. The agent reads
// it only through the verified update chain (internal/agent MsaTrust), so a
// substituted key needs a signed release. Pure: bytes in, keys out.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
)

// KeysTarget is the signed target name; KeysSchema its schema. The portal's
// grant-key-commands.ts and deploy/release use the same strings.
const (
	KeysTarget = "msa/grant-keys.json"
	KeysSchema = "rem0te-msa-grant-keys/1"
	// MaxKeys bounds the list; a portal has one active key, and a rotation two.
	MaxKeys = 8
	// MaxKeysBytes bounds the file before it is parsed.
	MaxKeysBytes = 16 << 10
)

// KeyID is the first 16 hex characters of the SHA-256 of the raw public key.
func KeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:])[:16]
}

// ParseKeys is strict: an unknown field, a bad schema, a key id that is not
// the key's own, a duplicate, or more than MaxKeys refuses the whole file —
// the agent then trusts no grant key (every grant is unknown_key).
func ParseKeys(raw []byte) (map[string]ed25519.PublicKey, error) {
	if len(raw) > MaxKeysBytes {
		return nil, errors.New("grant keys: too large")
	}
	var doc struct {
		Schema string `json:"schema"`
		Keys   []struct {
			KeyID     string `json:"keyId"`
			PublicKey string `json:"publicKey"`
		} `json:"keys"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&doc); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("grant keys: trailing data")
	}
	if doc.Schema != KeysSchema {
		return nil, errors.New("grant keys: schema must be " + KeysSchema)
	}
	if doc.Keys == nil || len(doc.Keys) > MaxKeys {
		return nil, errors.New("grant keys: missing or too many keys")
	}
	out := map[string]ed25519.PublicKey{}
	for _, k := range doc.Keys {
		b, err := base64.StdEncoding.Strict().DecodeString(k.PublicKey)
		if err != nil || len(b) != ed25519.PublicKeySize || base64.StdEncoding.EncodeToString(b) != k.PublicKey {
			return nil, errors.New("grant keys: a public key is not 32 bytes of standard base64")
		}
		pub := ed25519.PublicKey(b)
		if !keyIDRE.MatchString(k.KeyID) || KeyID(pub) != k.KeyID {
			return nil, errors.New("grant keys: a key id is not its key's")
		}
		if _, dup := out[k.KeyID]; dup {
			return nil, errors.New("grant keys: duplicate key id")
		}
		out[k.KeyID] = pub
	}
	return out, nil
}
