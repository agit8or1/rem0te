//go:build windows

package tray

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// WinOS is the read-only half of the self-help OS: what any user's session
// may do. The signed tray host wraps it and adds the elevated operations;
// here they return ErrNotHere.
type WinOS struct{}

func (WinOS) Resolve(ctx context.Context, host string) ([]string, error) {
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil {
		var de *net.DNSError
		if errors.As(err, &de) {
			return nil, errors.New(de.Err)
		}
		return nil, err
	}
	return addrs, nil
}

func (WinOS) Adapters() ([]Adapter, error) { return adapters() }

func adapters() ([]Adapter, error) {
	size := uint32(15000)
	var buf []byte
	for i := 0; i < 3; i++ {
		buf = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_INCLUDE_GATEWAYS|windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST,
			0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) || i == 2 {
			return nil, err
		}
	}
	var out []Adapter
	for a := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); a != nil; a = a.Next {
		if a.IfType == windows.IF_TYPE_SOFTWARE_LOOPBACK || a.IfType == 131 /* tunnel */ {
			continue
		}
		ad := Adapter{Name: CleanLine(windows.UTF16PtrToString(a.FriendlyName), 64), Up: a.OperStatus == windows.IfOperStatusUp, DHCP: a.Flags&0x4 != 0 /* IP_ADAPTER_DHCP_ENABLED */}
		if a.PhysicalAddressLength > 0 && a.PhysicalAddressLength <= 8 {
			ad.MAC = net.HardwareAddr(a.PhysicalAddress[:a.PhysicalAddressLength]).String()
		}
		for u := a.FirstUnicastAddress; u != nil; u = u.Next {
			if ip := u.Address.IP(); ip != nil {
				if ip.To4() != nil {
					ad.IPv4 = append(ad.IPv4, ip.String())
				} else if !ip.IsLinkLocalUnicast() {
					ad.IPv6 = append(ad.IPv6, ip.String())
				}
			}
		}
		for g := a.FirstGatewayAddress; g != nil; g = g.Next {
			if ip := g.Address.IP(); ip != nil {
				ad.Gateways = append(ad.Gateways, ip.String())
			}
		}
		for d := a.FirstDnsServerAddress; d != nil; d = d.Next {
			if ip := d.Address.IP(); ip != nil && !ip.IsLinkLocalUnicast() {
				ad.DNS = append(ad.DNS, ip.String())
			}
		}
		out = append(out, ad)
	}
	return out, nil
}

// DialTLS opens a verified TLS connection (system roots, the name checked)
// and closes it: the connection test, and nothing is sent.
func (WinOS) DialTLS(ctx context.Context, hostport string) (time.Duration, error) {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		return 0, err
	}
	start := time.Now()
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 10 * time.Second}, Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
	c, err := d.DialContext(ctx, "tcp", hostport)
	if err != nil {
		return 0, err
	}
	c.Close()
	return time.Since(start), nil
}

var pingTimeRE = regexp.MustCompile(`(?i)(?:time|zeit|temps|tiempo)[=<]\s*([0-9]+)\s*ms`)

// Ping runs System32\ping.exe -n 2 -w 1000 <ip>, where ip is a gateway
// address from the adapter table, parsed as an IPv4 address here again.
func (WinOS) Ping(ctx context.Context, ip string) (time.Duration, error) {
	p := net.ParseIP(ip).To4()
	if p == nil {
		return 0, errors.New("not an IPv4 address")
	}
	out, code, err := RunSystem32(ctx, 15*time.Second, "ping.exe", "-n", "2", "-w", "1000", p.String())
	if err != nil || code != 0 {
		return 0, fmt.Errorf("no answer")
	}
	if m := pingTimeRE.FindStringSubmatch(string(out)); m != nil {
		var ms int
		fmt.Sscanf(m[1], "%d", &ms)
		return time.Duration(ms) * time.Millisecond, nil
	}
	return 0, nil
}

func (WinOS) FlushDNS() (string, error)    { return "", ErrNotHere }
func (WinOS) RenewIP() (string, error)     { return "", ErrNotHere }
func (WinOS) RemoteSessions() (int, error) { return 0, ErrNotHere }
func (WinOS) RestartRustDesk() error       { return ErrNotHere }

// System32Allowed is every program a self-help tool may run. §51 checks
// that nothing else is passed to RunSystem32 in the tray.
var System32Allowed = map[string]bool{"ipconfig.exe": true, "ping.exe": true}

// RunSystem32 runs one allowed program from System32 by absolute path,
// without a shell, with no window.
func RunSystem32(ctx context.Context, timeout time.Duration, exe string, args ...string) ([]byte, int, error) {
	if !System32Allowed[exe] {
		return nil, -1, fmt.Errorf("refusing to run %q", exe)
	}
	for _, a := range args {
		if strings.ContainsAny(a, "&|<>^\"%\r\n") {
			return nil, -1, errors.New("refusing an argument with shell characters")
		}
	}
	d, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, -1, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(d, exe), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out, ee.ExitCode(), err
	}
	if err != nil {
		return out, -1, err
	}
	return out, 0, nil
}
