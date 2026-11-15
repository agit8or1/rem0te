package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

func decodeIcon(t *testing.T, state string, light bool, size int) *image.NRGBA {
	t.Helper()
	ico, err := iconFile(state, light)
	if err != nil {
		t.Fatalf("%s light=%v: %v", state, light, err)
	}
	b, got, err := pickIconImage(ico, size)
	if err != nil || got != size {
		t.Fatalf("%s light=%v size %d: got %d, %v", state, light, size, got, err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("%s light=%v size %d: not a PNG: %v", state, light, size, err)
	}
	if img.Bounds().Dx() != size || img.Bounds().Dy() != size {
		t.Fatalf("%s light=%v size %d: image is %v", state, light, size, img.Bounds())
	}
	n := image.NewNRGBA(img.Bounds())
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			n.Set(x, y, img.At(x, y))
		}
	}
	return n
}

func TestEveryIconFileHasEverySize(t *testing.T) {
	for _, st := range iconStates {
		for _, light := range []bool{false, true} {
			ico, err := iconFile(st, light)
			if err != nil {
				t.Fatal(err)
			}
			es, err := icoEntries(ico)
			if err != nil {
				t.Fatalf("%s light=%v: %v", st, light, err)
			}
			have := map[int]bool{}
			for _, e := range es {
				have[e.Size] = true
			}
			for _, s := range iconSizes {
				if !have[s] {
					t.Errorf("%s light=%v: no %d px image", st, light, s)
				}
				decodeIcon(t, st, light, s)
			}
		}
	}
}

// lum is relative luminance (WCAG), 0..1.
func lum(c color.NRGBA) float64 {
	f := func(v uint8) float64 {
		x := float64(v) / 255
		if x <= 0.03928 {
			return x / 12.92
		}
		p := (x + 0.055) / 1.055
		return p * p * (1 + 0.6*(p-1)) // close enough to ^2.4 for a contrast floor
	}
	return 0.2126*f(c.R) + 0.7152*f(c.G) + 0.0722*f(c.B)
}

func contrast(a, b color.NRGBA) float64 {
	la, lb := lum(a), lum(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// At 16 px the bubble must stand off the disc and the ring off the disc,
// in whole opaque pixels: the geometry is hand-snapped for this size.
func TestSixteenPixelIsLegible(t *testing.T) {
	for _, st := range iconStates {
		for _, light := range []bool{false, true} {
			img := decodeIcon(t, st, light, 16)
			bubble := img.NRGBAAt(5, 5) // inside the 9x5 bubble (x 3..11, y 4..8)
			disc := img.NRGBAAt(8, 11)  // below the bubble, inside the disc
			ring := img.NRGBAAt(8, 14)  // bottom of the ring (rows 14.25..16)
			if st == iconAttention {
				bubble = img.NRGBAAt(4, 6)
			}
			for name, c := range map[string]color.NRGBA{"bubble": bubble, "disc": disc, "ring": ring} {
				if c.A < 240 {
					t.Errorf("%s light=%v: %s pixel is not opaque (%v)", st, light, name, c)
				}
			}
			min := 4.5
			if st == iconOffline {
				min = 3 // deliberately subdued
			}
			if r := contrast(bubble, disc); r < min {
				t.Errorf("%s light=%v: bubble/disc contrast %.2f < %.1f", st, light, r, min)
			}
			if r := contrast(ring, disc); r < 2 {
				t.Errorf("%s light=%v: ring/disc contrast %.2f < 2", st, light, r)
			}
			if c := img.NRGBAAt(0, 0); c.A != 0 {
				t.Errorf("%s light=%v: the corner is not transparent", st, light)
			}
		}
	}
	// Connected: three separate one-pixel dots in the bubble's middle row.
	img := decodeIcon(t, iconConnected, false, 16)
	white := img.NRGBAAt(4, 6)
	for x := 5; x <= 9; x++ {
		dot := x == 5 || x == 7 || x == 9
		if isDot := contrast(img.NRGBAAt(x, 6), white) > 3; isDot != dot {
			t.Errorf("connected 16 px: pixel (%d,6) dot=%v, want %v", x, isDot, dot)
		}
	}
	// Attention: the red dot is red.
	img = decodeIcon(t, iconAttention, true, 16)
	if c := img.NRGBAAt(13, 3); !(c.R > 200 && c.G < 90 && c.B < 90) {
		t.Errorf("attention 16 px: badge pixel is %v, want red", c)
	}
}

func TestPickIconImageFallsBack(t *testing.T) {
	ico, _ := iconFile(iconNormal, false)
	for want, got := range map[int]int{16: 16, 18: 20, 28: 32, 36: 40, 64: 48, 8: 16} {
		if _, g, err := pickIconImage(ico, want); err != nil || g != got {
			t.Errorf("want %d: picked %d (%v), expected %d", want, g, err, got)
		}
	}
	if _, _, err := pickIconImage([]byte("nope"), 16); err == nil {
		t.Error("a non-.ico was accepted")
	}
}

func TestIconStateFor(t *testing.T) {
	cases := []struct {
		s    tray.State
		have bool
		want string
	}{
		{tray.State{}, false, iconNormal},
		{tray.State{}, true, iconNormal},
		{tray.State{Offline: true}, true, iconOffline},
		{tray.State{Chat: tray.ChatState{Open: true}}, true, iconConnected},
		{tray.State{Offline: true, Chat: tray.ChatState{Open: true, Unread: []string{"x"}}}, true, iconAttention},
	}
	for i, c := range cases {
		if g := iconStateFor(c.s, c.have); g != c.want {
			t.Errorf("case %d: %s, want %s", i, g, c.want)
		}
	}
}
