//go:build windows

package recorder

import "os/exec"

// interruptProcess is a no-op on Windows.
//
// os.Interrupt is documented as not implemented for Process.Signal there, and
// delivering a real CTRL_C_EVENT requires attaching to the child's console
// group, which would also interrupt the agent itself. The "q" on stdin above
// is what stops ffmpeg cleanly on Windows, and Kill remains the backstop, so
// the middle rung of the escalation is simply skipped.
func interruptProcess(cmd *exec.Cmd) error { return nil }
