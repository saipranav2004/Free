//go:build !windows

package recorder

import (
	"os"
	"os/exec"
)

// interruptProcess asks ffmpeg to stop the way a person pressing Ctrl-C
// would, which it handles by finalising the output file.
func interruptProcess(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return cmd.Process.Signal(os.Interrupt)
}
