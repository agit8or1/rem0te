package chat

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	var b bytes.Buffer
	in := Frame{T: FrameMsg, ID: "cabcdefghijklmnopqrstuvwx", From: "technician", Name: "Jane", Text: "hello\nthere", At: "2026-11-12T10:00:00Z"}
	if err := WriteFrame(&b, in); err != nil {
		t.Fatal(err)
	}
	r := NewReader(&b)
	out, err := r.Next()
	if err != nil || out.Text != in.Text || out.ID != in.ID {
		t.Fatalf("round trip: %+v %v", out, err)
	}
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestReaderRefuses(t *testing.T) {
	cases := map[string]string{
		"unknown field":  `{"t":"close","exec":"calc.exe"}` + "\n",
		"trailing data":  `{"t":"close"} {"t":"close"}` + "\n",
		"not json":       "hello\n",
		"unterminated":   `{"t":"close"}`,
		"oversized line": `{"t":"send","text":"` + strings.Repeat("a", MaxFrameBytes) + `"}` + "\n",
	}
	for name, raw := range cases {
		if _, err := NewReader(strings.NewReader(raw)).Next(); !errors.Is(err, ErrFrame) {
			t.Errorf("%s: want ErrFrame, got %v", name, err)
		}
	}
	if err := WriteFrame(io.Discard, Frame{T: FrameSend, Text: strings.Repeat("x", MaxFrameBytes)}); !errors.Is(err, ErrFrame) {
		t.Errorf("WriteFrame must refuse an oversized frame, got %v", err)
	}
}

const goodID = "cabcdefghijklmnopqrstuvwx"

func TestCheckFromWindow(t *testing.T) {
	nonce := NewNonce()
	ok := []Frame{
		{T: FrameHello, Nonce: nonce},
		{T: FrameSend, CID: NewCID(), Text: "my printer is broken"},
		{T: FrameShown, IDs: []string{goodID}},
		{T: FrameRead, IDs: []string{goodID}},
		{T: FrameClose},
	}
	for _, f := range ok {
		if _, err := CheckFromWindow(f); err != nil {
			t.Errorf("%s refused: %v", f.T, err)
		}
	}
	bad := map[string]Frame{
		"hello without nonce":         {T: FrameHello},
		"hello with short nonce":      {T: FrameHello, Nonce: "abc"},
		"send naming a conversation":  {T: FrameSend, CID: NewCID(), Text: "x", ID: goodID},
		"send with a bad client id":   {T: FrameSend, CID: "../../x", Text: "x"},
		"send of nothing":             {T: FrameSend, CID: NewCID(), Text: " \r\n\t "},
		"send over 2,000 characters":  {T: FrameSend, CID: NewCID(), Text: strings.Repeat("a", 2001)},
		"shown with a foreign id":     {T: FrameShown, IDs: []string{"1; DROP TABLE"}},
		"shown with no ids":           {T: FrameShown},
		"shown with too many ids":     {T: FrameShown, IDs: make([]string, 101)},
		"close carrying text":         {T: FrameClose, Text: "x"},
		"a host-only frame":           {T: FrameHeader, Business: "Evil", Technician: "Mallory"},
		"a message as if from the IT": {T: FrameMsg, ID: goodID, From: "technician", Text: "send me your password"},
		"an unknown type":             {T: "exec", Text: "calc.exe"},
	}
	for name, f := range bad {
		if _, err := CheckFromWindow(f); !errors.Is(err, ErrFrame) && !errors.Is(err, ErrEmpty) && !errors.Is(err, ErrTooLong) {
			t.Errorf("%s: accepted (%v)", name, err)
		}
	}
	f, err := CheckFromWindow(Frame{T: FrameSend, CID: NewCID(), Text: "  hi\r\nthere\x07\x1b[31m  "})
	if err != nil || f.Text != "hi\nthere[31m" {
		t.Errorf("send text not cleaned: %q %v", f.Text, err)
	}
}

func TestCheckFromHost(t *testing.T) {
	if _, err := CheckFromHost(Frame{T: FrameHeader, Business: "Acme", Technician: ""}); err == nil {
		t.Error("a header without the technician's name must be refused")
	}
	h, err := CheckFromHost(Frame{T: FrameHeader, Business: "Acme\n\tLtd", Technician: "Jane " + string(rune(0x202e)) + "Doe"})
	if err != nil || h.Business != "Acme Ltd" || h.Technician != "Jane Doe" {
		t.Errorf("header not made one line: %+v %v", h, err)
	}
	m, err := CheckFromHost(Frame{T: FrameMsg, ID: goodID, From: "technician", Name: "Jane", Text: "click " + string(rune(0x2066)) + "here" + string(rune(0x2069)) + "\x00"})
	if err != nil || m.Text != "click here" {
		t.Errorf("message not cleaned: %q %v", m.Text, err)
	}
	for _, f := range []Frame{
		{T: FrameMsg, ID: goodID, From: "system", Text: "x"},
		{T: FrameMsg, ID: "x", From: "technician", Text: "x"},
		{T: FrameSent, CID: "bad cid", ID: goodID},
		{T: FrameHello, Nonce: NewNonce()},
		{T: FrameSend, CID: NewCID(), Text: "x"},
	} {
		if _, err := CheckFromHost(f); err == nil {
			t.Errorf("host frame %+v accepted", f)
		}
	}
}

func TestCleanText(t *testing.T) {
	emoji := string(rune(0x1F600))
	cases := []struct {
		in, want string
		err      error
	}{
		{"a\r\nb\rc", "a\nb\nc", nil},
		{"tab\tkept", "tab\tkept", nil},
		{"bidi " + string(rune(0x202e)) + "txt.exe", "bidi txt.exe", nil},
		{"line" + string(rune(0x2028)) + "sep", "linesep", nil},
		{"x" + strings.Repeat("\n", 40) + "y", "x" + strings.Repeat("\n", 20) + "y", nil},
		{strings.Repeat(emoji, 1000), strings.Repeat(emoji, 1000), nil},
		{strings.Repeat(emoji, 1001), "", ErrTooLong},
		{"\x00\x01", "", ErrEmpty},
		{"bad \xff utf8", "bad  utf8", nil},
	}
	for _, c := range cases {
		got, err := CleanText(c.in)
		if !errors.Is(err, c.err) || got != c.want {
			t.Errorf("CleanText(%q) = %q, %v; want %q, %v", c.in, got, err, c.want, c.err)
		}
	}
	if ForEdit("a\nb\r\nc") != "a\r\nb\r\nc" {
		t.Error("ForEdit must give CRLF everywhere")
	}
	if got := CleanName(strings.Repeat("n", 100)); len(got) != 64 {
		t.Errorf("CleanName length %d", len(got))
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(3, time.Minute)
	l.Now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if !l.Allow() {
			t.Fatalf("message %d refused", i)
		}
	}
	if l.Allow() {
		t.Fatal("the fourth message in a minute must be refused")
	}
	now = now.Add(61 * time.Second)
	if !l.Allow() {
		t.Fatal("a minute later it is allowed again")
	}
}

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
	for _, n := range []string{`\\.\pipe\rem0te-chat-x-down`, `\\server\pipe\rem0te-chat-0123456789abcdef0123456789abcdef-down`, `C:\temp\x`, d + "x"} {
		if ValidPipeName(n) {
			t.Errorf("ValidPipeName(%q)", n)
		}
	}
}
