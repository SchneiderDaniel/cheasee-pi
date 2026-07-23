// pi-guardian — in-container orphan reaper for pi processes.
//
// Scans /proc for orphaned pi processes (PPid=1, cmdline containing "pi")
// and kills them with SIGTERM → SIGKILL escalation.
//
// Flags:
//
//	--once        Run a single scan+kill pass and exit (default: false)
//	--interval 30s  Time between sweeps in continuous mode (default: 30s)
//	--pid-name pi   Process name substring to match in /proc/*/cmdline
//	--dry-run       Log intended actions without sending signals
//	--log /dev/stdout  Log output path
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultInterval = 30 * time.Second
	defaultPidName  = "pi"
	gracePeriod     = 5 * time.Second
)

type config struct {
	once     bool
	interval time.Duration
	pidName  string
	dryRun   bool
	logPath  string
}

func main() {
	cfg := parseFlags()

	logWriter, err := openLog(cfg.logPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pi-guardian: open log: %v\n", err)
		os.Exit(1)
	}
	logger := log.New(logWriter, "pi-guardian: ", log.LstdFlags|log.Lmsgprefix)

	logger.Printf("starting (pid=%d, interval=%v, pid-name=%q, once=%v, dry-run=%v)",
		os.Getpid(), cfg.interval, cfg.pidName, cfg.once, cfg.dryRun)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	run := func() bool {
		pids, err := scanOnce(cfg.pidName)
		if err != nil {
			logger.Printf("scan error: %v", err)
			return true // continue
		}
		if len(pids) == 0 {
			return true // continue
		}
		for _, pid := range pids {
			escalate(pid, cfg.dryRun, logger)
		}
		return true // continue
	}

	if cfg.once {
		run()
		// Reap any zombies before exiting
		reapZombies()
		return
	}

	// Continuous mode
	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	for {
		if !run() {
			break
		}
		reapZombies()
		select {
		case sig := <-sigCh:
			logger.Printf("received signal %v, shutting down", sig)
			return
		case <-ticker.C:
		}
	}
}

func parseFlags() config {
	var (
		once     bool
		interval time.Duration
		pidName  string
		dryRun   bool
		logPath  string
	)

	flag.BoolVar(&once, "once", false, "Run single scan+kill pass and exit")
	flag.DurationVar(&interval, "interval", defaultInterval, "Time between sweeps")
	flag.StringVar(&pidName, "pid-name", defaultPidName, "Process name substring to match")
	flag.BoolVar(&dryRun, "dry-run", false, "Log intended actions without sending signals")
	flag.StringVar(&logPath, "log", "/dev/stdout", "Log output path")
	flag.Parse()

	if pidName == "" {
		fmt.Fprintf(os.Stderr, "pi-guardian: --pid-name must not be empty\n")
		os.Exit(1)
	}
	if interval <= 0 {
		interval = defaultInterval
	}

	return config{
		once:     once,
		interval: interval,
		pidName:  pidName,
		dryRun:   dryRun,
		logPath:  logPath,
	}
}

func openLog(path string) (io.Writer, error) {
	if path == "" || path == "/dev/stdout" {
		return os.Stdout, nil
	}
	if path == "/dev/stderr" {
		return os.Stderr, nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open log %s: %w", path, err)
	}
	return f, nil
}

// scanOnce scans /proc for orphaned processes matching pidName.
// Returns list of PIDs where PPid=1 and cmdline contains pidName.
func scanOnce(pidName string) ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, fmt.Errorf("read /proc: %w", err)
	}

	var orphans []int
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue // not a PID directory
		}
		if pid == 1 || pid == os.Getpid() {
			continue // skip init and ourselves
		}

		ppid, err := readPPid(pid)
		if err != nil {
			continue // race-exited or permission denied
		}
		if ppid != 1 {
			continue // not an orphan (PPid=1 = init/tini)
		}

		cmdline, err := readCmdline(pid)
		if err != nil {
			continue
		}
		if !matchPidName(cmdline, pidName) {
			continue
		}

		orphans = append(orphans, pid)
	}
	return orphans, nil
}

// readPPid reads the parent PID from /proc/<pid>/stat.
// Returns the PPID (4th field in stat, 2nd after the closing paren).
func readPPid(pid int) (int, error) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	// stat format: pid (comm) state ppid ...
	// Find the last ')' to handle comm with spaces/parens.
	s := string(data)
	closeParen := strings.LastIndex(s, ")")
	if closeParen < 0 {
		return 0, fmt.Errorf("no closing paren in stat for pid %d", pid)
	}
	fields := strings.Fields(s[closeParen+1:])
	if len(fields) < 3 {
		return 0, fmt.Errorf("too few fields in stat for pid %d", pid)
	}
	// fields[0] is state, fields[1] is ppid
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, fmt.Errorf("parse ppid for pid %d: %w", pid, err)
	}
	return ppid, nil
}

// readCmdline reads /proc/<pid>/cmdline (NUL-separated, converted to spaces).
func readCmdline(pid int) (string, error) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return "", err
	}
	// cmdline uses NUL byte as separator; replace with space
	cleaned := strings.ReplaceAll(string(data), "\x00", " ")
	return strings.TrimSpace(cleaned), nil
}

// matchPidName checks if cmdline contains pidName as a substring of any
// space-delimited element (base name of the command).
func matchPidName(cmdline, pidName string) bool {
	for _, part := range strings.Fields(cmdline) {
		base := filepath.Base(part)
		if strings.Contains(base, pidName) {
			return true
		}
	}
	return false
}

// escalate sends SIGTERM, waits gracePeriod, then sends SIGKILL if
// the process is still alive. Returns true if the process was killed.
func escalate(pid int, dryRun bool, logger *log.Logger) bool {
	// Check if process exists
	p, err := os.FindProcess(pid)
	if err != nil {
		logger.Printf("orphan %d: find process: %v (already dead?)", pid, err)
		return false
	}

	// Verify we can signal it (permission check)
	if err := p.Signal(syscall.Signal(0)); err != nil {
		logger.Printf("orphan %d: signal check: %v (already dead?)", pid, err)
		return false
	}

	if dryRun {
		logger.Printf("dry-run: would kill orphan %d (cmdline match)", pid)
		return false
	}

	logger.Printf("orphan %d: sending SIGTERM", pid)
	if err := p.Signal(syscall.SIGTERM); err != nil {
		logger.Printf("orphan %d: SIGTERM failed: %v", pid, err)
	}

	// Wait for grace period, then SIGKILL if still alive
	deadline := time.After(gracePeriod)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-deadline:
			// Check if still alive
			if err := p.Signal(syscall.Signal(0)); err != nil {
				logger.Printf("orphan %d: exited during grace period", pid)
				return true
			}
			logger.Printf("orphan %d: grace expired, sending SIGKILL", pid)
			if err := p.Signal(syscall.SIGKILL); err != nil {
				logger.Printf("orphan %d: SIGKILL failed: %v", pid, err)
				return false
			}
			logger.Printf("orphan %d: killed (SIGKILL)", pid)
			return true
		case <-ticker.C:
			// Process exited during grace — check every 100ms
			if err := p.Signal(syscall.Signal(0)); err != nil {
				logger.Printf("orphan %d: exited during grace period", pid)
				return true
			}
		}
	}
}

// reapZombies waits for any terminated children to prevent defunct processes.
func reapZombies() {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		if err != nil || pid == 0 {
			break
		}
	}
}

// scanOnceFromDir is like scanOnce but reads from a fixture directory
// instead of /proc. Used by tests.
func scanOnceFromDir(procDir, pidName string) ([]int, error) {
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", procDir, err)
	}

	var orphans []int
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if pid == 1 || pid == os.Getpid() {
			continue
		}

		ppid, err := readPPidFromDir(procDir, pid)
		if err != nil {
			continue
		}
		if ppid != 1 {
			continue
		}

		cmdline, err := readCmdlineFromDir(procDir, pid)
		if err != nil {
			continue
		}
		if !matchPidName(cmdline, pidName) {
			continue
		}

		orphans = append(orphans, pid)
	}
	return orphans, nil
}

func readPPidFromDir(procDir string, pid int) (int, error) {
	data, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	s := string(data)
	closeParen := strings.LastIndex(s, ")")
	if closeParen < 0 {
		return 0, fmt.Errorf("no closing paren in stat for pid %d", pid)
	}
	fields := strings.Fields(s[closeParen+1:])
	if len(fields) < 2 {
		return 0, fmt.Errorf("too few fields in stat for pid %d", pid)
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, fmt.Errorf("parse ppid for pid %d: %w", pid, err)
	}
	return ppid, nil
}

func readCmdlineFromDir(procDir string, pid int) (string, error) {
	data, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return "", err
	}
	cleaned := strings.ReplaceAll(string(data), "\x00", " ")
	return strings.TrimSpace(cleaned), nil
}

// readCmdlineFromReader reads from an io.Reader (for test fixtures).
func readCmdlineFromReader(r io.Reader) (string, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	cleaned := strings.ReplaceAll(string(data), "\x00", " ")
	return strings.TrimSpace(cleaned), nil
}

// readPPidFromReader reads PPID from a stat file reader (for test fixtures).
func readPPidFromReader(r io.Reader) (int, error) {
	scanner := bufio.NewScanner(r)
	if !scanner.Scan() {
		return 0, fmt.Errorf("empty stat")
	}
	s := scanner.Text()
	closeParen := strings.LastIndex(s, ")")
	if closeParen < 0 {
		return 0, fmt.Errorf("no closing paren in stat")
	}
	fields := strings.Fields(s[closeParen+1:])
	if len(fields) < 2 {
		return 0, fmt.Errorf("too few fields in stat")
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, fmt.Errorf("parse ppid: %w", err)
	}
	return ppid, nil
}
