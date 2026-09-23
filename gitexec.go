package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// gitDirCache memoizes `git rev-parse --absolute-git-dir` per repository path.
var gitDirCache sync.Map

// 自身命令的“安静窗口”。本应用执行的 git 命令会改动 .git（index、refs、HEAD…），
// 由此产生的 fsnotify 事件并不是外部改动；若把它当作仓库变化上报，就会与自身
// 命令形成自激刷新（读一次 → 写一次 → 再读一次……）。这里记录命令的起止时间，
// 供监听侧屏蔽这类“自我触发”的事件。
//
// 屏蔽不会漏掉需要展示的变化：每个操作结束后前端都会主动 refreshAll()，
// 而工作区文件的改动本来就不触碰 .git（监听看不到），因此无需依赖这些事件。
var (
	gitCmdInFlight atomic.Int64
	gitCmdLastDone atomic.Int64 // unix 毫秒
)

// ownGitQuietWindow 是命令结束后继续忽略自我事件的时长，用来覆盖 lock+rename
// 落盘与事件送达之间的延迟。
const ownGitQuietWindow = 800 * time.Millisecond

func markGitCmdStart() { gitCmdInFlight.Add(1) }

func markGitCmdDone() {
	gitCmdLastDone.Store(time.Now().UnixMilli())
	gitCmdInFlight.Add(-1)
}

// ownGitActivity reports whether one of our own git commands is running or has
// just finished — i.e. whether a .git change is (probably) self-inflicted and
// must not trigger a refresh.
func ownGitActivity() bool {
	if gitCmdInFlight.Load() > 0 {
		return true
	}
	last := gitCmdLastDone.Load()
	return last != 0 && time.Since(time.UnixMilli(last)) < ownGitQuietWindow
}

// gitEnv is appended to every git invocation so output is stable and git never
// blocks on interactive prompts (credentials, editors, pagers).
func gitEnv() []string {
	return append(os.Environ(),
		"LC_ALL=C",              // stable, English output
		"GIT_PAGER=cat",         // never paginate
		"PAGER=cat",             // never paginate
		"GIT_EDITOR=true",       // never open an interactive editor
		"EDITOR=true",           // never open an interactive editor
		"GIT_TERMINAL_PROMPT=0", // fail instead of prompting for credentials
	)
}

// runGit executes a git command in repoPath and returns its stdout.
// On failure the error message is taken from stderr (what the user should see).
func runGit(repoPath string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return runGitCtx(ctx, repoPath, args...)
}

// runGitNetwork executes a git command that talks to a remote. It gets a much
// longer timeout than local commands.
func runGitNetwork(repoPath string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	return runGitCtx(ctx, repoPath, args...)
}

// runGitRO runs a read-only git command with GIT_OPTIONAL_LOCKS=0.
//
// 这很关键：`git status` / `git diff` 默认会“顺手”刷新 index 里的 stat 缓存，
// 也就是会重写 .git/index。对一个会监听 .git 的客户端来说，这会造成自激循环：
// 轮询 → 写 index → 监听事件 → 刷新 → 再写 index ……
// 因此所有只是“看”的命令都必须关掉这类可选写入。
func runGitRO(repoPath string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return runGitCtxEnv(ctx, repoPath, []string{"GIT_OPTIONAL_LOCKS=0"}, args...)
}

func runGitCtx(ctx context.Context, repoPath string, args ...string) (string, error) {
	return runGitCtxEnv(ctx, repoPath, nil, args...)
}

// runGitCtxEnv executes git with extra environment entries appended.
func runGitCtxEnv(ctx context.Context, repoPath string, extraEnv []string, args ...string) (string, error) {
	markGitCmdStart()
	defer markGitCmdDone()
	start := time.Now()
	cmd := exec.CommandContext(ctx, "git", args...)
	if repoPath != "" {
		cmd.Dir = repoPath
	}
	cmd.Env = append(gitEnv(), extraEnv...)
	cmd.WaitDelay = 5 * time.Second

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	out := stdout.String()
	entry := GitLogEntry{
		Time:     start.UnixMilli(),
		Kind:     "git",
		Dir:      repoPath,
		Command:  "git " + joinCommand(args...),
		Duration: time.Since(start).Milliseconds(),
		Output:   stdout.String() + stderr.String(),
	}
	if ctx.Err() == context.DeadlineExceeded {
		entry.Error = "超时"
		recordCommand(entry)
		return out, errors.New("git 命令超时: git " + strings.Join(args, " "))
	}
	if err != nil {
		msg := firstNonEmpty(strings.TrimSpace(stderr.String()), strings.TrimSpace(out), err.Error())
		// git prints progress/info noise on stderr; keep only the first meaningful lines.
		entry.Error = msg
		recordCommand(entry)
		return out, errors.New(msg)
	}
	entry.OK = true
	recordCommand(entry)
	return out, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// splitLines trims trailing newlines and splits into non-empty lines.
func splitLines(s string) []string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// gitDir returns the absolute path of the .git directory for repoPath.
// The result is cached: a repository's git dir cannot change during one
// session, and this avoids an extra `git rev-parse` on every status poll.
func gitDir(repoPath string) (string, error) {
	if v, ok := gitDirCache.Load(repoPath); ok {
		return v.(string), nil
	}
	out, err := runGit(repoPath, "rev-parse", "--absolute-git-dir")
	dir := strings.TrimSpace(out)
	if err != nil || dir == "" {
		return dir, err
	}
	gitDirCache.Store(repoPath, dir)
	return dir, nil
}

// repoToplevel resolves the repository root for any path inside a work tree.
func repoToplevel(path string) (string, error) {
	out, err := runGit(path, "rev-parse", "--show-toplevel")
	return strings.TrimSpace(out), err
}

// headHash returns the current HEAD commit hash, or "" for an unborn HEAD.
func headHash(repoPath string) string {
	out, err := runGit(repoPath, "rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}
