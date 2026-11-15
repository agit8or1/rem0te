package tray

import (
	"bytes"
	"encoding/json"
)

// Brand (0.53.1) is who the tray is for, as the portal's records name them:
// the business the computer belongs to, the IT provider that supports it,
// the provider's support contact and its accent colour. It is all of State
// the tray keeps between runs, so that it can say "MSP Reboot · supported by
// Agit8or.net" before the first status answer instead of a bare "Support".
//
// The four fields are the whole file. It never holds a credential, a tray
// key, a chat code, a conversation id or any message text; it is written by
// the tray in the user's own %LOCALAPPDATA%, so it is re-cleaned on every
// read with the same rules CleanState applies to the portal's answer, and a
// file that is too big, not JSON, or carries any other field is ignored.
type Brand struct {
	Business    string `json:"business"`
	Provider    string `json:"provider"`
	SupportText string `json:"supportText"`
	Accent      string `json:"accent"`
}

// MaxBrandFileBytes caps the brand file. Four cleaned lines of at most 64,
// 64, 200 and 7 characters fit in well under this, even as escaped UTF-8.
const MaxBrandFileBytes = 4 << 10

// Clean applies CleanState's limits; an accent that is not #RRGGBB is "".
func (b Brand) Clean() Brand {
	b.Business, b.Provider = CleanLine(b.Business, 64), CleanLine(b.Provider, 64)
	b.SupportText = CleanLine(b.SupportText, 200)
	if !accentRE.MatchString(b.Accent) {
		b.Accent = ""
	}
	return b
}

// Empty: nothing to show.
func (b Brand) Empty() bool { return b.Business == "" && b.Provider == "" && b.SupportText == "" }

// BrandOf is the brand part of a state.
func BrandOf(s State) Brand {
	return Brand{Business: s.Business, Provider: s.Provider, SupportText: s.SupportText, Accent: s.Accent}.Clean()
}

// ParseBrand reads a brand file. ok is false for anything that is not
// exactly a brand: too large, not JSON, an unknown field, trailing data.
func ParseBrand(raw []byte) (Brand, bool) {
	if len(raw) > MaxBrandFileBytes {
		return Brand{}, false
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	var b Brand
	if err := d.Decode(&b); err != nil || d.More() {
		return Brand{}, false
	}
	return b.Clean(), true
}

// MarshalBrand is the file ParseBrand reads back.
func MarshalBrand(b Brand) []byte {
	out, _ := json.Marshal(b.Clean())
	return out
}

// WithBrand fills an empty state's brand from b: the tray before its first
// answer, or a host that has never reached the portal. A state that already
// names anyone keeps what it names.
func WithBrand(s State, b Brand) State {
	if !BrandOf(s).Empty() {
		return s
	}
	b = b.Clean()
	s.Business, s.Provider, s.SupportText = b.Business, b.Provider, b.SupportText
	if b.Accent != "" {
		s.Accent = b.Accent
	}
	return s
}

// ProviderOr is the provider's name for a sentence, or "your IT provider"
// when the portal named none.
func ProviderOr(provider string) string {
	if p := CleanLine(provider, 64); p != "" {
		return p
	}
	return "your IT provider"
}

// ProviderTitle is ProviderOr for the start of a sentence.
func ProviderTitle(provider string) string {
	if p := CleanLine(provider, 64); p != "" {
		return p
	}
	return "Your IT provider"
}
