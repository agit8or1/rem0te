package chat

import (
	"errors"
	"strings"
	"testing"
	"time"
)

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
