package tray

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
)

// ShotMaxWidth: a screenshot wider than this is scaled down before encoding.
const ShotMaxWidth = 1600

// EncodeShot turns a captured screen into a JPEG of at most
// MaxScreenshotBytes: scaled to ShotMaxWidth, then encoded at falling
// quality, then scaled again, until it fits. It never sends more than the
// portal accepts and never cuts a file short.
func EncodeShot(img image.Image) ([]byte, error) {
	b := img.Bounds()
	if b.Dx() <= 0 || b.Dy() <= 0 {
		return nil, errors.New("empty screen capture")
	}
	w := b.Dx()
	if w > ShotMaxWidth {
		w = ShotMaxWidth
	}
	for w >= 320 {
		src := scale(img, w)
		for _, q := range []int{80, 70, 60, 50, 40} {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: q}); err != nil {
				return nil, err
			}
			if buf.Len() <= MaxScreenshotBytes {
				return buf.Bytes(), nil
			}
		}
		w = w * 3 / 4
	}
	return nil, errors.New("the screen capture does not fit in 700 KB")
}

// scale is a box-filter downscale to width w (height kept in proportion).
func scale(img image.Image, w int) image.Image {
	b := img.Bounds()
	if w >= b.Dx() {
		return img
	}
	h := b.Dy() * w / b.Dx()
	if h < 1 {
		h = 1
	}
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		y0, y1 := b.Min.Y+y*b.Dy()/h, b.Min.Y+(y+1)*b.Dy()/h
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < w; x++ {
			x0, x1 := b.Min.X+x*b.Dx()/w, b.Min.X+(x+1)*b.Dx()/w
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, bl, n uint32
			for yy := y0; yy < y1; yy += 2 {
				for xx := x0; xx < x1; xx += 2 {
					cr, cg, cb, _ := img.At(xx, yy).RGBA()
					r, g, bl, n = r+cr, g+cg, bl+cb, n+1
				}
			}
			i := out.PixOffset(x, y)
			out.Pix[i], out.Pix[i+1], out.Pix[i+2], out.Pix[i+3] = uint8(r/n>>8), uint8(g/n>>8), uint8(bl/n>>8), 255
		}
	}
	return out
}
