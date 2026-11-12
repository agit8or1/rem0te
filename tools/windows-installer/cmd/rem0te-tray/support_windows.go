//go:build windows

package main

import (
	"context"
	"errors"
	"image"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

const (
	supportClass = "Rem0teSupportRequest"
	idText       = 1
	idUsage      = 2
	idShot       = 3
	idRemove     = 4
	idSend       = 5
	idCancel     = 6
	previewW     = 320
	previewH     = 180
)

// supportForm is "Open a support request": the text, two boxes that are
// off until ticked, and — when the screenshot box is ticked — the captured
// screen, shown before anything is sent, with a button that removes it.
type supportForm struct {
	hwnd                                  windows.HWND
	text, usage, shotBox, preview, remove windows.HWND
	status, send, cancel                  windows.HWND
	shot                                  []byte
	previewBmp                            uintptr
	sending                               bool
}

func registerSupportClass() error { return registerClass(supportClass, supportProc) }

func (a *app) openSupport() {
	if a.support != nil && a.support.hwnd != 0 {
		pShowWindow.Call(uintptr(a.support.hwnd), swShowNormal)
		pSetForegroundWindow.Call(uintptr(a.support.hwnd))
		return
	}
	s, _ := a.snapshot()
	title := "Support request"
	if s.Business != "" {
		title = "Support request — " + s.Business
	}
	f := &supportForm{}
	a.support = f
	f.hwnd = createWindow(wsExTopmost, supportClass, title, wsOverlapped|wsCaption|wsSysMenu|wsMinimizeBox, 200, 120, 470, 520, 0, 0)
	child := func(class, text string, style uint32, x, y, w, h int32, id uintptr) windows.HWND {
		c := createWindow(0, class, text, wsChild|wsVisible|style, x, y, w, h, f.hwnd, id)
		setFont(c)
		return c
	}
	child("STATIC", "Describe what you need help with:", 0, 12, 12, 430, 18, 0)
	f.text = child("EDIT", "", wsTabStop|wsBorder|wsVScroll|esMultiline|esAutoVScroll|esWantReturn, 12, 32, 430, 130, idText)
	pSendMessageW.Call(uintptr(f.text), emLimitText, tray.MaxRequestChars, 0)
	f.usage = child("BUTTON", "Include current resource usage (CPU, memory, disk, busiest programs)", wsTabStop|bsAutoCheck, 12, 172, 430, 20, idUsage)
	f.shotBox = child("BUTTON", "Include a screenshot of my screen", wsTabStop|bsAutoCheck, 12, 196, 430, 20, idShot)
	f.preview = child("STATIC", "", ssBitmap|ssCenterImage|wsBorder, 12, 222, previewW, previewH, 0)
	f.remove = child("BUTTON", "Remove screenshot", wsTabStop|bsPushButton, 340, 222, 102, 28, idRemove)
	enable(f.remove, false)
	f.status = child("STATIC", "Nothing is sent until you choose Send.", 0, 12, 412, 430, 34, 0)
	f.send = child("BUTTON", "Send", wsTabStop|bsDefPush, 252, 450, 90, 28, idSend)
	f.cancel = child("BUTTON", "Cancel", wsTabStop|bsPushButton, 352, 450, 90, 28, idCancel)
	pShowWindow.Call(uintptr(f.hwnd), swShow)
	pSetForegroundWindow.Call(uintptr(f.hwnd))
	pSetFocus.Call(uintptr(f.text))
}

func supportProc(hwnd windows.HWND, m uint32, w, l uintptr) uintptr {
	a := theApp
	f := a.support
	switch m {
	case wmCommand:
		if f == nil {
			break
		}
		switch w & 0xffff {
		case idShot:
			if checked(f.shotBox) {
				f.capture()
			} else {
				f.clearShot()
			}
			return 0
		case idRemove:
			f.clearShot()
			setCheck(f.shotBox, false)
			return 0
		case idSend:
			f.submit()
			return 0
		case idCancel:
			pDestroyWindow.Call(uintptr(hwnd))
			return 0
		}
	case wmClose:
		pDestroyWindow.Call(uintptr(hwnd))
		return 0
	case wmDestroy:
		if f != nil {
			f.clearShot()
			f.hwnd = 0
		}
		a.support = nil
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(uintptr(hwnd), uintptr(m), w, l)
	return r
}

func (f *supportForm) setStatus(s string) { setText(f.status, s) }

func (f *supportForm) clearShot() {
	f.shot = nil
	pSendMessageW.Call(uintptr(f.preview), stmSetImage, 0, 0)
	if f.previewBmp != 0 {
		pDeleteObject.Call(f.previewBmp)
		f.previewBmp = 0
	}
	enable(f.remove, false)
	if f.hwnd != 0 {
		f.setStatus("Nothing is sent until you choose Send.")
	}
}

// capture hides this window, takes the screen in this (the user's own)
// session, and shows it here. Nothing leaves the computer until Send.
func (f *supportForm) capture() {
	pShowWindow.Call(uintptr(f.hwnd), swHide)
	go func() {
		time.Sleep(400 * time.Millisecond)
		img, err := captureScreen()
		var jpg []byte
		if err == nil {
			jpg, err = tray.EncodeShot(img)
		}
		theApp.onUI(func() {
			if f.hwnd == 0 {
				return
			}
			pShowWindow.Call(uintptr(f.hwnd), swShow)
			pSetForegroundWindow.Call(uintptr(f.hwnd))
			if err != nil {
				setCheck(f.shotBox, false)
				f.setStatus("The screenshot could not be taken: " + err.Error())
				return
			}
			f.shot = jpg
			f.previewBmp = previewBitmap(img)
			pSendMessageW.Call(uintptr(f.preview), stmSetImage, 0 /* IMAGE_BITMAP */, f.previewBmp)
			enable(f.remove, true)
			f.setStatus("This screenshot will be sent with your request (" + kb(len(jpg)) + "). Remove it if it shows anything you do not want to share.")
		})
	}()
}

func kb(n int) string {
	k := (n + 1023) / 1024
	b := []byte{}
	for k > 0 || len(b) == 0 {
		b = append([]byte{byte('0' + k%10)}, b...)
		k /= 10
	}
	return string(b) + " KB"
}

func (f *supportForm) submit() {
	if f.sending {
		return
	}
	text := windowText(f.text)
	if _, err := tray.CleanRequestText(text); err != nil {
		f.setStatus("Please describe what you need help with (up to 2,000 characters).")
		return
	}
	usage := checked(f.usage)
	shot := f.shot
	if !checked(f.shotBox) {
		shot = nil
	}
	f.sending = true
	enable(f.send, false)
	f.setStatus("Sending…")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		err := theApp.backend.Support(ctx, text, usage, shot)
		theApp.onUI(func() {
			if f.hwnd == 0 {
				return
			}
			f.sending = false
			enable(f.send, true)
			if err != nil {
				f.setStatus(err.Error())
				return
			}
			msgBox(f.hwnd, "Your request was sent. Your IT provider will be in touch.", "Support request", mbOK|mbIconInfo)
			pDestroyWindow.Call(uintptr(f.hwnd))
		})
	}()
}

// captureScreen copies the whole virtual screen (every monitor) into an image.
func captureScreen() (image.Image, error) {
	x, _, _ := pGetSystemMetrics.Call(smXVirtual)
	y, _, _ := pGetSystemMetrics.Call(smYVirtual)
	w, _, _ := pGetSystemMetrics.Call(smCxVirtual)
	h, _, _ := pGetSystemMetrics.Call(smCyVirtual)
	W, H := int32(w), int32(h)
	if W <= 0 || H <= 0 || W > 32768 || H > 32768 {
		return nil, errors.New("no screen to capture")
	}
	screen, _, _ := pGetDC.Call(0)
	if screen == 0 {
		return nil, errors.New("the screen is not available")
	}
	defer pReleaseDC.Call(0, screen)
	mem, _, _ := pCreateCompatibleDC.Call(screen)
	defer pDeleteDC.Call(mem)
	bmp, _, _ := pCreateCompatibleBitmap.Call(screen, uintptr(W), uintptr(H))
	if bmp == 0 {
		return nil, errors.New("out of memory for the capture")
	}
	defer pDeleteObject.Call(bmp)
	old, _, _ := pSelectObject.Call(mem, bmp)
	r, _, _ := pBitBlt.Call(mem, 0, 0, uintptr(W), uintptr(H), screen, uintptr(int32(x)), uintptr(int32(y)), srcCopy|captureBlt)
	pSelectObject.Call(mem, old)
	if r == 0 {
		return nil, errors.New("the screen could not be copied (it may be locked)")
	}
	bi := bitmapInfo{Header: bitmapInfoHeader{Width: W, Height: -H, Planes: 1, BitCount: 32}}
	bi.Header.Size = uint32(unsafe.Sizeof(bi.Header))
	buf := make([]byte, int(W)*int(H)*4)
	if r, _, _ := pGetDIBits.Call(mem, bmp, 0, uintptr(H), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), 0); r == 0 {
		return nil, errors.New("the capture could not be read")
	}
	img := image.NewRGBA(image.Rect(0, 0, int(W), int(H)))
	for i := 0; i < len(buf); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = buf[i+2], buf[i+1], buf[i], 255
	}
	return img, nil
}

// previewBitmap is a small copy of the capture for the form.
func previewBitmap(img image.Image) uintptr {
	b := img.Bounds()
	w, h := previewW, previewW*b.Dy()/b.Dx()
	if h > previewH {
		h, w = previewH, previewH*b.Dx()/b.Dy()
	}
	bi := bitmapInfo{Header: bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}}
	bi.Header.Size = uint32(unsafe.Sizeof(bi.Header))
	var bits unsafe.Pointer
	hdc, _, _ := pGetDC.Call(0)
	bmp, _, _ := pCreateDIBSection.Call(hdc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	pReleaseDC.Call(0, hdc)
	if bmp == 0 {
		return 0
	}
	px := unsafe.Slice((*byte)(bits), w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, bl, _ := img.At(b.Min.X+x*b.Dx()/w, b.Min.Y+y*b.Dy()/h).RGBA()
			i := (y*w + x) * 4
			px[i], px[i+1], px[i+2], px[i+3] = byte(bl>>8), byte(g>>8), byte(r>>8), 255
		}
	}
	return bmp
}
