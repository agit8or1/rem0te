//go:build !windows

package main

import (
	"fmt"
	"os"
)

// The tray is Windows only. Linux and macOS agents have no tray program; the
// portal says so on those computers and offers no chat.
func main() {
	fmt.Fprintln(os.Stderr, "rem0te-tray runs on Windows only; Linux and macOS are not supported.")
	os.Exit(3)
}
