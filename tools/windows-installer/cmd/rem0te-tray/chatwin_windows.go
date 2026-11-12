//go:build windows

package main

// The chat window (0.36): the portal's /assist page in a WebView2 control,
// in a process of its own (`rem0te-tray.exe --chat-window`), so that the
// WebView2 wrapper — which exits its process on an internal error — can
// never take the tray down with it.
//
// The window loads one https URL, on the pinned portal, under /assist/, and
// refuses every other request (WebResourceRequested answers 403 for
// anything AllowedNavigation does not pass, sub-resources included). Dev
// tools, the context menu, host objects, web messages and script dialogs
// are off. Its profile lives in the user's local app data.

import (
	"os"
	"path/filepath"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

// webView2Available: is the Evergreen WebView2 runtime installed?
func webView2Available() bool {
	v, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString("")
	return err == nil && v != ""
}

var chatView *edge.Chromium

func chatProc(hwnd windows.HWND, m uint32, w, l uintptr) uintptr {
	switch m {
	case wmSize:
		if chatView != nil {
			chatView.Resize()
		}
		return 0
	case wmClose:
		pDestroyWindow.Call(uintptr(hwnd))
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(uintptr(hwnd), uintptr(m), w, l)
	return r
}

func runChatWindow(portal string) int {
	u, err := chatURL(portal, os.Stdin)
	if err != nil {
		return 2
	}
	if !webView2Available() {
		return 3
	}
	if err := registerClass(chatClass, chatProc); err != nil {
		return 5
	}
	hwnd := createWindow(0, chatClass, "Chat with support", wsOverlapped|wsCaption|wsSysMenu|wsMinimizeBox|wsThickFrame|wsVisible, 120, 80, 440, 640, 0, 0)
	if hwnd == 0 {
		return 5
	}
	v := edge.NewChromium()
	chatView = v
	v.DataPath = filepath.Join(os.Getenv("LOCALAPPDATA"), "Rem0te", "chat-webview")
	v.SetErrorCallback(func(error) { os.Exit(6) })
	v.WebResourceRequestedCallback = func(req *edge.ICoreWebView2WebResourceRequest, args *edge.ICoreWebView2WebResourceRequestedEventArgs) {
		uri, err := req.GetUri()
		if err == nil && tray.AllowedNavigation(portal, uri) {
			return
		}
		if env := v.Environment(); env != nil {
			if resp, err := env.CreateWebResourceResponse(nil, 403, "Forbidden", ""); err == nil {
				_ = args.PutResponse(resp)
				resp.Release()
			}
		}
	}
	if !v.Embed(uintptr(hwnd)) {
		return 6
	}
	if s, err := v.GetSettings(); err == nil {
		_ = s.PutAreDevToolsEnabled(false)
		_ = s.PutAreDefaultContextMenusEnabled(false)
		_ = s.PutAreHostObjectsAllowed(false)
		_ = s.PutIsWebMessageEnabled(false)
		_ = s.PutAreDefaultScriptDialogsEnabled(false)
		_ = s.PutIsStatusBarEnabled(false)
		_ = s.PutAreBrowserAcceleratorKeysEnabled(false)
	}
	v.AddWebResourceRequestedFilter("*", edge.COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
	v.Resize()
	v.Navigate(u)
	pShowWindow.Call(uintptr(hwnd), swShowNormal)
	pSetForegroundWindow.Call(uintptr(hwnd))
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	return 0
}
