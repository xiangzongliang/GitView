package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// gitEnv is appended to every git invocation so output is stable and git never
// blocks on interactive prompts (credentials, editors, pagers).
func gitEnv() []string {
	return append(os.Environ(),
		"LC_ALL=C",                // stable, English output
		"GIT_PAGER=cat",           // never paginate
		"PAGER=cat",               // never paginate
		"GIT_EDITOR=true",         // never open an interactive editor
		"EDITOR=true",             // never open an interactive editor
		"GIT_TERMINAL_PROMPT=0",   // fail instead of prompting for credentials
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

func runGitCtx(ctx context.Context, repoPath string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if repoPath != "" {
		cmd.Dir = repoPath
	}
	cmd.Env = gitEnv()
	cmd.WaitDelay = 5 * time.Second

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	out := stdout.String()
	if ctx.Err() == context.DeadlineExceeded {
		return out, errors.New("git 命令超时: git " + strings.Join(args, " "))
	}
	if err != nil {
		msg := firstNonEmpty(strings.TrimSpace(stderr.String()), strings.TrimSpace(out), err.Error())
		// git prints progress/info noise on stderr; keep only the first meaningful lines.
		return out, errors.New(msg)
	}
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
func gitDir(repoPath string) (string, error) {
	out, err := runGit(repoPath, "rev-parse", "--absolute-git-dir")
	return strings.TrimSpace(out), err
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
