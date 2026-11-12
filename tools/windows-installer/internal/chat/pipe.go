package chat

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
)

var (
	sidRE      = regexp.MustCompile(`^S-1-(5-21|12-1)(-[0-9]{1,10}){1,14}$`)
	pipeNameRE = regexp.MustCompile(`^\\\\\.\\pipe\\rem0te-chat-[0-9a-f]{32}-(down|up)$`)
)

// PipeSDDL is the security descriptor for the two chat pipes: SYSTEM (the
// host) and the signed-in user whose session the window runs in, nobody
// else — not Administrators, not other users on the machine, not the
// network (also refused by PIPE_REJECT_REMOTE_CLIENTS). The DACL is
// protected so nothing is inherited.
//
// Only a person's account SID is accepted: a local or domain account
// (S-1-5-21-…) or a Microsoft Entra ID account (S-1-12-1-…). A well-known
// group such as Everyone (S-1-1-0), Users (S-1-5-32-545) or Interactive
// (S-1-5-4) here would hand the pipe to every account on the computer.
func PipeSDDL(userSID string) (string, error) {
	if !sidRE.MatchString(userSID) {
		return "", fmt.Errorf("refusing pipe ACL for %q: not a user account SID", userSID)
	}
	return "D:P(A;;GA;;;SY)(A;;GRGW;;;" + userSID + ")", nil
}

// PipeNames are a fresh, unguessable pair of pipe names for one window.
func PipeNames() (down, up string) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	base := `\\.\pipe\rem0te-chat-` + hex.EncodeToString(b)
	return base + "-down", base + "-up"
}

// ValidPipeName is what the window accepts on its command line: only a name
// PipeNames could have made.
func ValidPipeName(s string) bool { return pipeNameRE.MatchString(s) }
