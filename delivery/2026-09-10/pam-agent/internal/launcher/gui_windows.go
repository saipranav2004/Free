//go:build windows

// pam-agent/internal/launcher/gui_windows.go
package launcher

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// spawnGUIAndWait opens a desktop application and blocks until it is closed,
// so the caller can report the session's real end.
//
// See gui_darwin.go for why waiting at all is the fix. Windows needs one
// extra thing the other two do not: some of these tools are LAUNCHER STUBS.
// Oracle SQL Developer's sqldeveloper.exe starts a JVM and exits; waiting on
// the process this function started would then report the session as over
// several seconds after it began, while the operator's window is still open
// in front of them — worse than the original bug, because it closes a live
// session rather than leaving a dead one open.
//
// A JOB OBJECT is the Windows answer to that. Every process the child starts
// is placed in the same job automatically, and the job posts
// JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO to an IO completion port when the LAST
// of them exits. That is the event this waits on, so a stub that hands off to
// a JVM is measured by the JVM's lifetime, which is the operator's session.
//
// DELIBERATELY NOT SET: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Closing this
// process's job handle must never kill the operator's application. The job is
// used purely as an observer here.
//
// EVERY STEP FALLS BACK. Job objects can be refused — a machine policy, a
// nested job on some older Windows containers, an application that assigns
// itself elsewhere. Any failure drops through to plain Wait on the child,
// which is exactly what the other two platforms do and is correct for the
// Electron-based tools (Compass, pgAdmin 4, RedisInsight) that make up most
// of this list. So the job object can only ever improve on the fallback,
// never break it.
func spawnGUIAndWait(pc *PreparedCommand) (waited bool, enforcement Summary, err error) {
	c := exec.Command(pc.Exec, pc.Args...)
	c.Env = mergeEnv(os.Environ(), pc.Env)
	if startErr := c.Start(); startErr != nil {
		return false, enforcement, startErr
	}

	if job, port, ok := trackProcessTree(c.Process.Pid); ok {
		defer syscall.CloseHandle(job)
		defer syscall.CloseHandle(port)
		// Reap the direct child so it does not linger as a zombie handle
		// while the tree is still being waited on. Its exit status is not a
		// launch failure (see gui_darwin.go), and for a stub launcher it
		// arrives long before the session is actually over.
		go func() { _ = c.Wait() }()
		waitForEmptyJob(port)
		return true, enforcement, nil
	}

	_ = c.Wait()
	return true, enforcement, nil
}

// Win32 constants. Named here rather than inline so the values can be checked
// against the SDK headers without decoding call sites.
const (
	jobObjectAssociateCompletionPortInformation = 7
	jobObjectMsgActiveProcessZero               = 4

	processTerminate        = 0x0001
	processSetQuota         = 0x0100
	waitInfinite     uint32 = 0xFFFFFFFF
)

// jobAssociateCompletionPort mirrors JOBOBJECT_ASSOCIATE_COMPLETION_PORT.
type jobAssociateCompletionPort struct {
	CompletionKey  uintptr
	CompletionPort syscall.Handle
}

var (
	kernel32Job                = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW       = kernel32Job.NewProc("CreateJobObjectW")
	procAssignProcessToJobObj  = kernel32Job.NewProc("AssignProcessToJobObject")
	procSetInformationJobObjec = kernel32Job.NewProc("SetInformationJobObject")
)

// trackProcessTree builds a job object holding pid and returns it with a
// completion port that will be posted to when the job empties.
//
// ok=false means the caller should fall back to waiting on the child alone;
// every partial state is cleaned up before returning, so a false never leaks
// a handle.
func trackProcessTree(pid int) (job syscall.Handle, port syscall.Handle, ok bool) {
	h, _, _ := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return 0, 0, false
	}
	job = syscall.Handle(h)

	port, err := syscall.CreateIoCompletionPort(syscall.InvalidHandle, 0, 0, 1)
	if err != nil {
		syscall.CloseHandle(job)
		return 0, 0, false
	}

	assoc := jobAssociateCompletionPort{CompletionKey: 1, CompletionPort: port}
	if r, _, _ := procSetInformationJobObjec.Call(
		uintptr(job),
		uintptr(jobObjectAssociateCompletionPortInformation),
		uintptr(unsafe.Pointer(&assoc)),
		unsafe.Sizeof(assoc),
	); r == 0 {
		syscall.CloseHandle(port)
		syscall.CloseHandle(job)
		return 0, 0, false
	}

	// PROCESS_SET_QUOTA and PROCESS_TERMINATE are exactly the rights
	// AssignProcessToJobObject requires, and no more.
	proc, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		syscall.CloseHandle(port)
		syscall.CloseHandle(job)
		return 0, 0, false
	}
	defer syscall.CloseHandle(proc)

	if r, _, _ := procAssignProcessToJobObj.Call(uintptr(job), uintptr(proc)); r == 0 {
		syscall.CloseHandle(port)
		syscall.CloseHandle(job)
		return 0, 0, false
	}
	return job, port, true
}

// waitForEmptyJob blocks until the job reports that its last process has
// exited.
//
// Messages other than ACTIVE_PROCESS_ZERO (a process joined, a process left)
// arrive on the same port and are ignored: the loop is waiting for the one
// that means the operator is finished. A failed dequeue also returns, because
// a port that cannot be read will never deliver the message either, and
// hanging here would keep the session open forever — the exact failure this
// function exists to remove.
func waitForEmptyJob(port syscall.Handle) {
	for {
		var code uint32
		var key uint32
		var overlapped *syscall.Overlapped
		if err := syscall.GetQueuedCompletionStatus(port, &code, &key, &overlapped, waitInfinite); err != nil {
			return
		}
		if code == jobObjectMsgActiveProcessZero {
			return
		}
	}
}
