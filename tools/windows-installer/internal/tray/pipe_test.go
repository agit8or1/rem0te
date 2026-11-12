package tray

import (
	"strings"
	"testing"
)

func TestPipeSDDL(t *testing.T) {
	for _, sid := range []string{"S-1-5-21-3623811015-3361044348-30300820-1013", "S-1-12-1-1234567890-1234567890-1234567890-1234567890"} {
		s, err := PipeSDDL(sid)
		if err != nil || s != "D:P(A;;GA;;;SY)(A;;GRGW;;;"+sid+")" {
			t.Errorf("%s: %q %v", sid, s, err)
		}
		if strings.Contains(s, ";BA)") || strings.Contains(s, ";WD)") || strings.Contains(s, ";BU)") {
			t.Errorf("the pipe must not be granted to Administrators, Everyone or Users: %s", s)
		}
	}
	for _, sid := range []string{"S-1-1-0", "S-1-5-32-545", "S-1-5-32-544", "S-1-5-18", "S-1-5-4", "S-1-5-11", "WD", "",
		"S-1-5-21-1)(A;;GA;;;WD", "S-1-5-21-1-2-3-4\x00"} {
		if _, err := PipeSDDL(sid); err == nil {
			t.Errorf("PipeSDDL accepted %q", sid)
		}
	}
}

func TestPipeNames(t *testing.T) {
	d, u := PipeNames()
	d2, _ := PipeNames()
	if !ValidPipeName(d) || !ValidPipeName(u) || d == d2 || !strings.HasSuffix(d, "-down") || !strings.HasSuffix(u, "-up") {
		t.Fatalf("pipe names %q %q %q", d, u, d2)
	}
	for _, n := range []string{`\\.\pipe\rem0te-tray-x-down`, `\\server\pipe\rem0te-tray-0123456789abcdef0123456789abcdef-down`, `C:\temp\x`, d + "x"} {
		if ValidPipeName(n) {
			t.Errorf("ValidPipeName(%q)", n)
		}
	}
}
