package main

import (
	"regexp"
	"strings"
	"sync"
	"time"
)

// GitLogEntry records one executed command (git or built-in terminal shell) so
// the in-app debug window can show exactly what ran, how long it took and what
// it printed.
type GitLogEntry struct {
	Seq      int64  `json:"seq"`
	Time     int64  `json:"time"`     // unix 毫秒
	Kind     string `json:"kind"`     // "git" | "shell"
	Dir      string `json:"dir"`      // 命令的工作目录
	Command  string `json:"command"`  // 完整命令行
	Duration int64  `json:"duration"` // 耗时（毫秒）
	OK       bool   `json:"ok"`
	Error    string `json:"error"`
	Output   string `json:"output"` // 输出（已截断）
}

const (
	debugLogLimit    = 500
	debugOutputLimit = 4000
)

var (
	debugLogMu  sync.Mutex
	debugLogSeq int64
	debugLogBuf []GitLogEntry
)

// recordCommand appends an entry to the bounded debug log (ring buffer).
// It never fails and never blocks: logging is best-effort.
func recordCommand(e GitLogEntry) {
	e.Command = redactSecrets(e.Command)
	e.Output = strings.TrimSpace(e.Output)
	if len(e.Output) > debugOutputLimit {
		e.Output = e.Output[:debugOutputLimit] + "\n…（输出已截断）"
	}
	debugLogMu.Lock()
	defer debugLogMu.Unlock()
	debugLogSeq++
	e.Seq = debugLogSeq
	debugLogBuf = append(debugLogBuf, e)
	if drop := len(debugLogBuf) - debugLogLimit; drop > 0 {
		debugLogBuf = append([]GitLogEntry(nil), debugLogBuf[drop:]...)
	}
}

// debugLogSince returns every entry with Seq greater than since.
func debugLogSince(since int64) []GitLogEntry {
	debugLogMu.Lock()
	defer debugLogMu.Unlock()
	out := make([]GitLogEntry, 0, len(debugLogBuf))
	for _, e := range debugLogBuf {
		if e.Seq > since {
			out = append(out, e)
		}
	}
	return out
}

func debugLogClear() {
	debugLogMu.Lock()
	debugLogBuf = nil
	debugLogMu.Unlock()
}

var credentialRe = regexp.MustCompile(`://[^/@\s]+@`)

// redactSecrets hides "user:password@" in remote URLs before logging.
func redactSecrets(s string) string {
	return credentialRe.ReplaceAllString(s, "://***@")
}

// joinCommand renders arguments as a copy-pasteable command line.
func joinCommand(args ...string) string {
	parts := make([]string, len(args))
	for i, a := range args {
		if a == "" || strings.ContainsAny(a, " \t\"'$`\\") {
			parts[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		} else {
			parts[i] = a
		}
	}
	return strings.Join(parts, " ")
}

// ------------------------------------------------------------------ AppService

// GitLog returns the recorded command log entries newer than since.
func (s *AppService) GitLog(since int64) []GitLogEntry {
	return debugLogSince(since)
}

// ClearGitLog drops every recorded command log entry.
func (s *AppService) ClearGitLog() {
	debugLogClear()
}

// nowMillis is the timestamp helper used for log entries.
func nowMillis() int64 { return time.Now().UnixMilli() }
