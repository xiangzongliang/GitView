package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// GitService exposes all git operations to the frontend.
// Every method takes the repository path as its first argument.
type GitService struct{}

const logFormat = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%b%x1e"

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// Status returns the working tree / index state of the repository.
func (s *GitService) Status(repoPath string) (*RepoStatus, error) {
	// runGitRO：不写 index（否则会与仓库监听形成自激刷新循环）
	out, err := runGitRO(repoPath, "-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--branch")
	if err != nil {
		return nil, err
	}

	st := &RepoStatus{
		Staged:     []FileStatus{},
		Unstaged:   []FileStatus{},
		Untracked:  []FileStatus{},
		Conflicted: []FileStatus{},
	}

	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if entry == "" {
			continue
		}
		if strings.HasPrefix(entry, "## ") {
			parseBranchHeader(entry[3:], st)
			continue
		}
		if len(entry) < 4 || entry[2] != ' ' {
			continue
		}
		x, y := entry[0], entry[1]
		path := entry[3:]

		// Rename/copy entries are followed by the source path as the next NUL field.
		oldPath := ""
		if x == 'R' || x == 'C' {
			i++
			if i < len(fields) {
				oldPath = fields[i]
			}
		}

		switch {
		case x == '?' && y == '?':
			st.Untracked = append(st.Untracked, FileStatus{Path: path, StatusChar: "?"})
		case x == '!' && y == '!':
			// ignored (only with --ignored, kept for safety)
		case isConflictCode(x, y):
			st.Conflicted = append(st.Conflicted, FileStatus{Path: path, OldPath: oldPath, StatusChar: "U", Conflicted: true, Renamed: oldPath != ""})
		default:
			if isStatusChar(x) {
				st.Staged = append(st.Staged, FileStatus{
					Path: path, OldPath: oldPath, StatusChar: string(x),
					Renamed: x == 'R' || x == 'C',
				})
			}
			if isStatusChar(y) {
				st.Unstaged = append(st.Unstaged, FileStatus{
					Path: path, OldPath: oldPath, StatusChar: string(y),
					Renamed: x == 'R' || x == 'C',
				})
			}
		}
	}

	st.Head = headHash(repoPath)
	if st.Head != "" {
		st.Head = st.Head[:min(12, len(st.Head))]
	}

	// Operation-in-progress markers.
	if gd, err := gitDir(repoPath); err == nil {
		st.Merging = pathExists(filepath.Join(gd, "MERGE_HEAD"))
		st.Rebasing = pathExists(filepath.Join(gd, "rebase-merge")) || pathExists(filepath.Join(gd, "rebase-apply"))
		st.CherryPicking = pathExists(filepath.Join(gd, "CHERRY_PICK_HEAD"))
		st.Reverting = pathExists(filepath.Join(gd, "REVERT_HEAD"))
	}

	// Stash 条数不在这里统计：stash 列表由前端单独的 refreshStashes 维护（见
	// StatusBar 使用的 repo.stashes），避免每次轮询都多起一个 git 进程。

	if st.Detached && st.Branch == "" {
		st.Branch = describeDetached(repoPath, st.Head)
	}
	return st, nil
}

func describeDetached(repoPath, head string) string {
	if head == "" {
		return "(detached)"
	}
	if out, err := runGit(repoPath, "describe", "--tags", "--always"); err == nil {
		return "(detached @ " + strings.TrimSpace(out) + ")"
	}
	return "(detached @ " + head + ")"
}

var trackAheadRe = regexp.MustCompile(`ahead (\d+)`)
var trackBehindRe = regexp.MustCompile(`behind (\d+)`)

func parseBranchHeader(h string, st *RepoStatus) {
	// Forms:
	//   "main...origin/main [ahead 1, behind 2]"
	//   "main"                       (no upstream)
	//   "HEAD (no branch)"           (detached)
	//   "No commits yet on main"     (unborn)
	switch {
	case strings.HasPrefix(h, "HEAD (no branch)"):
		st.Detached = true
	case strings.HasPrefix(h, "No commits yet on "):
		st.Branch = strings.TrimPrefix(h, "No commits yet on ")
	default:
		left := h
		if idx := strings.Index(h, " ["); idx >= 0 {
			left = h[:idx]
			track := h[idx:]
			if m := trackAheadRe.FindStringSubmatch(track); m != nil {
				st.Ahead, _ = strconv.Atoi(m[1])
			}
			if m := trackBehindRe.FindStringSubmatch(track); m != nil {
				st.Behind, _ = strconv.Atoi(m[1])
			}
		}
		if parts := strings.SplitN(left, "...", 2); len(parts) == 2 {
			st.Branch = parts[0]
			st.Upstream = parts[1]
		} else {
			st.Branch = left
		}
	}
}

func isConflictCode(x, y byte) bool {
	pair := string([]byte{x, y})
	switch pair {
	case "DD", "AU", "UD", "UA", "DU", "AA", "UU":
		return true
	}
	return false
}

// isStatusChar reports whether c is a porcelain status letter.
// An unmodified side is reported as a space (or '.' in some formats),
// never as one of these letters.
func isStatusChar(c byte) bool {
	switch c {
	case 'M', 'A', 'D', 'R', 'C', 'T', 'U', 'X':
		return true
	}
	return false
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ---------------------------------------------------------------------------
// Log / commits
// ---------------------------------------------------------------------------

// Log returns a page of commits, newest first.
func (s *GitService) Log(repoPath string, opts LogOptions) ([]Commit, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 300
	}
	if limit > 2000 {
		limit = 2000
	}
	skip := max(opts.Skip, 0)

	args := []string{
		"-c", "core.quotepath=false",
		"log",
		"--pretty=tformat:" + logFormat,
		"--skip=" + strconv.Itoa(skip),
		"-n", strconv.Itoa(limit),
	}
	switch opts.Ref {
	case "", "HEAD":
		// default
	case "all":
		args = append(args, "--all")
	default:
		args = append(args, opts.Ref)
	}
	if opts.Search != "" {
		args = append(args, "-i", "--grep="+opts.Search)
	}
	if opts.File != "" {
		args = append(args, "--follow", "--", opts.File)
	}

	out, err := runGit(repoPath, args...)
	if err != nil {
		msg := err.Error()
		// Empty repository or filtered-out revision: not an error for the UI.
		if strings.Contains(msg, "unknown revision") || strings.Contains(msg, "bad revision") ||
			strings.Contains(msg, "does not have any commits") {
			return []Commit{}, nil
		}
		return nil, err
	}

	remoteNames := s.remoteNames(repoPath)
	commits := []Commit{}
	for _, record := range strings.Split(out, "\x1e") {
		record = strings.TrimPrefix(record, "\n")
		if strings.TrimSpace(record) == "" {
			continue
		}
		f := strings.Split(record, "\x1f")
		if len(f) < 8 {
			continue
		}
		ts, _ := strconv.ParseInt(f[4], 10, 64)
		parents := []string{}
		if f[1] != "" {
			parents = strings.Split(f[1], " ")
		}
		commits = append(commits, Commit{
			Hash:        f[0],
			Parents:     parents,
			Author:      f[2],
			AuthorEmail: f[3],
			Timestamp:   ts,
			Subject:     f[6],
			Body:        strings.TrimSpace(f[7]),
			Refs:        parseDecorations(f[5], remoteNames),
		})
	}
	return commits, nil
}

func (s *GitService) remoteNames(repoPath string) map[string]bool {
	names := map[string]bool{}
	if out, err := runGit(repoPath, "remote"); err == nil {
		for _, l := range splitLines(out) {
			names[strings.TrimSpace(l)] = true
		}
	}
	return names
}

func parseDecorations(s string, remotes map[string]bool) []RefDecoration {
	if strings.TrimSpace(s) == "" {
		return []RefDecoration{}
	}
	parts := strings.Split(s, ", ")
	out := make([]RefDecoration, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		switch {
		case p == "":
		case strings.HasPrefix(p, "tag: "):
			out = append(out, RefDecoration{Name: strings.TrimPrefix(p, "tag: "), Type: "tag"})
		case strings.HasPrefix(p, "HEAD -> "):
			out = append(out, RefDecoration{Name: strings.TrimPrefix(p, "HEAD -> "), Type: "branch", Current: true})
		case p == "HEAD":
			// detached HEAD marker: shown via status, skip chip
		case strings.Contains(p, "/") && remotes[strings.SplitN(p, "/", 2)[0]]:
			out = append(out, RefDecoration{Name: p, Type: "remote"})
		default:
			out = append(out, RefDecoration{Name: p, Type: "branch"})
		}
	}
	return out
}

// ShowCommit returns the full details of a single commit.
func (s *GitService) ShowCommit(repoPath string, hash string) (*Commit, error) {
	out, err := runGit(repoPath, "-c", "core.quotepath=false", "show", "-s", "--pretty=tformat:"+logFormat, hash)
	if err != nil {
		return nil, err
	}
	record := strings.TrimPrefix(strings.Split(out, "\x1e")[0], "\n")
	f := strings.Split(record, "\x1f")
	if len(f) < 8 {
		return nil, errors.New("无法解析提交 " + hash)
	}
	ts, _ := strconv.ParseInt(f[4], 10, 64)
	parents := []string{}
	if f[1] != "" {
		parents = strings.Split(f[1], " ")
	}
	c := &Commit{
		Hash: f[0], Parents: parents, Author: f[2], AuthorEmail: f[3],
		Timestamp: ts, Subject: f[6], Body: strings.TrimSpace(f[7]),
		Refs: parseDecorations(f[5], s.remoteNames(repoPath)),
	}
	return c, nil
}

// CommitFiles lists the files changed in a commit with add/delete counts.
func (s *GitService) CommitFiles(repoPath string, hash string) ([]CommitFile, error) {
	base, err := s.diffBaseArgs(repoPath, hash)
	if err != nil {
		return nil, err
	}
	return s.diffFileList(repoPath, base)
}

// diffFileList runs a name-status + numstat diff for the given base args and
// parses the result into CommitFile entries. Shared by CommitFiles and
// StashFiles.
func (s *GitService) diffFileList(repoPath string, base []string) ([]CommitFile, error) {
	// Name + status (handles renames as "R100\0old\0new").
	nsArgs := append(append([]string{"-c", "core.quotepath=false"}, base...), "-z", "-M", "--name-status")
	nsOut, err := runGit(repoPath, nsArgs...)
	if err != nil {
		return nil, err
	}
	files := []CommitFile{}
	idxByPath := map[string]int{}
	toks := strings.Split(nsOut, "\x00")
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t == "" {
			continue
		}
		status := t
		if len(status) > 1 && (status[0] == 'R' || status[0] == 'C') {
			status = status[:1]
			// old, new
			old := ""
			newp := ""
			if i+2 < len(toks) {
				old = toks[i+1]
				newp = toks[i+2]
				i += 2
			}
			files = append(files, CommitFile{Path: newp, OldPath: old, Status: status})
			idxByPath[newp] = len(files) - 1
			continue
		}
		if i+1 < len(toks) {
			i++ // path
			files = append(files, CommitFile{Path: toks[i], Status: status})
			idxByPath[toks[i]] = len(files) - 1
		}
	}

	// Numstat for +/- counts.
	numArgs := append(append([]string{"-c", "core.quotepath=false"}, base...), "-z", "-M", "--numstat")
	if numOut, err := runGit(repoPath, numArgs...); err == nil {
		nt := strings.Split(numOut, "\x00")
		for i := 0; i < len(nt); i++ {
			t := nt[i]
			if t == "" {
				continue
			}
			path := ""
			parts := strings.Split(t, "\t")
			var adds, dels int
			binary := false
			if len(parts) >= 3 {
				// normal: adds\tdels\tpath
				adds, dels, binary = parseNumstat(parts[0], parts[1])
				path = parts[2]
			} else if len(parts) == 2 && i+2 < len(nt) {
				// rename: adds\tdels \0 old \0 new
				adds, dels, binary = parseNumstat(parts[0], parts[1])
				i += 2
				path = nt[i]
			} else {
				continue
			}
			if idx, ok := idxByPath[path]; ok {
				files[idx].Additions = adds
				files[idx].Deletions = dels
				files[idx].Binary = binary
			}
		}
	}

	return files, nil
}

func parseNumstat(a, d string) (int, int, bool) {
	if a == "-" || d == "-" {
		return 0, 0, true
	}
	adds, _ := strconv.Atoi(a)
	dels, _ := strconv.Atoi(d)
	return adds, dels, false
}

// diffBaseArgs returns the git args producing a patch for a commit.
// Merge commits are diffed against their first parent, which shows the
// changes introduced by the merge itself rather than the whole branch.
func (s *GitService) diffBaseArgs(repoPath string, hash string) ([]string, error) {
	parents, err := runGit(repoPath, "show", "-s", "--format=%P", hash)
	if err != nil {
		return nil, err
	}
	ps := strings.Fields(strings.TrimSpace(parents))
	if len(ps) > 1 {
		return []string{"diff", "-M", ps[0], hash}, nil
	}
	return []string{"show", "--format=", "-M", hash}, nil
}

// CommitDiff returns the diff of one file within a commit.
func (s *GitService) CommitDiff(repoPath string, hash string, file string) (string, error) {
	base, err := s.diffBaseArgs(repoPath, hash)
	if err != nil {
		return "", err
	}
	args := append(append([]string{"-c", "core.quotepath=false"}, base...), "--no-color", "--no-ext-diff", "--", file)
	return runGit(repoPath, args...)
}

// ---------------------------------------------------------------------------
// Refs: branches / remotes / tags
// ---------------------------------------------------------------------------

// Refs returns branches, remotes (with their branches) and tags.
func (s *GitService) Refs(repoPath string) (*RefsData, error) {
	data := &RefsData{Branches: []BranchInfo{}, Remotes: []RemoteInfo{}, Tags: []TagInfo{}}

	// Remotes first: needed to group remote branches.
	remoteOut, err := runGit(repoPath, "remote", "-v")
	if err != nil && !strings.Contains(err.Error(), "not a git repository") {
		return nil, err
	}
	remoteIdx := map[string]int{}
	for _, l := range splitLines(remoteOut) {
		f := strings.Fields(l)
		if len(f) >= 3 && strings.HasSuffix(f[2], "(fetch)") {
			data.Remotes = append(data.Remotes, RemoteInfo{Name: f[0], URL: f[1], Branches: []BranchInfo{}})
			remoteIdx[f[0]] = len(data.Remotes) - 1
		}
	}

	// Branches (local + remote-tracking).
	brOut, err := runGit(repoPath, "for-each-ref",
		"--format=%(refname)%09%(HEAD)%09%(upstream)%09%(upstream:track)%09%(objectname:short)%09%(committerdate:unix)%09%(contents:subject)",
		"refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}
	for _, l := range splitLines(brOut) {
		f := strings.Split(l, "\t")
		if len(f) < 7 {
			continue
		}
		refname := f[0]
		bi := BranchInfo{
			IsCurrent: f[1] == "*",
			Tracking:  strings.TrimPrefix(f[2], "refs/remotes/"),
			LastHash:  f[4],
			Subject:   f[6],
		}
		bi.Timestamp, _ = strconv.ParseInt(f[5], 10, 64)
		parseTrack(f[3], &bi)

		switch {
		case strings.HasPrefix(refname, "refs/heads/"):
			bi.Name = strings.TrimPrefix(refname, "refs/heads/")
			data.Branches = append(data.Branches, bi)
		case strings.HasPrefix(refname, "refs/remotes/"):
			name := strings.TrimPrefix(refname, "refs/remotes/")
			if strings.HasSuffix(name, "/HEAD") {
				continue // symbolic remote HEAD, duplicates the default branch
			}
			bi.Name = name
			bi.IsRemote = true
			if idx := strings.Index(name, "/"); idx > 0 {
				bi.Remote = name[:idx]
				if ri, ok := remoteIdx[bi.Remote]; ok {
					data.Remotes[ri].Branches = append(data.Remotes[ri].Branches, bi)
					continue
				}
			}
			// Remote branch without a matching remote entry (rare): show standalone.
			data.Remotes = append(data.Remotes, RemoteInfo{Name: bi.Remote, Branches: []BranchInfo{bi}})
			remoteIdx[bi.Remote] = len(data.Remotes) - 1
		}
	}
	sort.Slice(data.Branches, func(i, j int) bool {
		if data.Branches[i].IsCurrent != data.Branches[j].IsCurrent {
			return data.Branches[i].IsCurrent
		}
		return data.Branches[i].Name < data.Branches[j].Name
	})
	for i := range data.Remotes {
		sort.Slice(data.Remotes[i].Branches, func(a, b int) bool {
			return data.Remotes[i].Branches[a].Name < data.Remotes[i].Branches[b].Name
		})
	}

	// Tags.
	tagOut, err := runGit(repoPath, "for-each-ref", "--sort=-creatordate",
		"--format=%(refname)%09%(objectname:short)%09%(creatordate:unix)%09%(contents:subject)",
		"refs/tags")
	if err != nil {
		return nil, err
	}
	for _, l := range splitLines(tagOut) {
		f := strings.Split(l, "\t")
		if len(f) < 4 || strings.HasSuffix(f[0], "^{}") {
			continue
		}
		ti := TagInfo{Name: strings.TrimPrefix(f[0], "refs/tags/"), Hash: f[1], Subject: f[3]}
		ti.Timestamp, _ = strconv.ParseInt(f[2], 10, 64)
		data.Tags = append(data.Tags, ti)
	}

	return data, nil
}

func parseTrack(track string, bi *BranchInfo) {
	track = strings.TrimSpace(track)
	if track == "[gone]" {
		bi.Gone = true
		return
	}
	if m := trackAheadRe.FindStringSubmatch(track); m != nil {
		bi.Ahead, _ = strconv.Atoi(m[1])
	}
	if m := trackBehindRe.FindStringSubmatch(track); m != nil {
		bi.Behind, _ = strconv.Atoi(m[1])
	}
}

// ---------------------------------------------------------------------------
// Staging / discarding
// ---------------------------------------------------------------------------

// Stage adds the given paths to the index.
func (s *GitService) Stage(repoPath string, files []string) error {
	return runPathsFallback(repoPath, files, func(paths []string) []string {
		return append([]string{"-c", "core.quotepath=false", "add", "-A", "--"}, paths...)
	})
}

// StageAll stages every change in the worktree.
func (s *GitService) StageAll(repoPath string) error {
	_, err := runGit(repoPath, "add", "-A")
	return err
}

// Unstage removes the given paths from the index (keeps worktree changes).
func (s *GitService) Unstage(repoPath string, files []string) error {
	// Unborn HEAD: `git reset` cannot work, remove from index instead.
	unborn := headHash(repoPath) == ""
	return runPathsFallback(repoPath, files, func(paths []string) []string {
		if unborn {
			return append([]string{"rm", "-r", "--cached", "-q", "--"}, paths...)
		}
		return append([]string{"reset", "-q", "HEAD", "--"}, paths...)
	})
}

// runPathsFallback runs the git command built by build for all paths at once.
// A single batch call is fast but fails as a whole when one pathspec no longer
// matches (e.g. the file was deleted/renamed externally in the meantime), so on
// failure each path is retried on its own and the failures are reported.
func runPathsFallback(repoPath string, files []string, build func(paths []string) []string) error {
	if len(files) == 0 {
		return nil
	}
	if _, err := runGit(repoPath, build(files)...); err == nil {
		return nil
	}
	var failed []string
	for _, f := range files {
		if _, err := runGit(repoPath, build([]string{f})...); err != nil {
			failed = append(failed, f)
		}
	}
	if len(failed) == 0 {
		return nil
	}
	return fmt.Errorf("以下路径未能处理：%s", strings.Join(failed, "、"))
}

// UnstageAll resets the whole index to HEAD (keeps worktree changes).
func (s *GitService) UnstageAll(repoPath string) error {
	if headHash(repoPath) == "" {
		_, err := runGit(repoPath, "rm", "-r", "--cached", "-q", ".")
		return err
	}
	_, err := runGit(repoPath, "reset", "-q")
	return err
}

// Discard throws away local changes for the given paths:
// tracked files are restored from HEAD, untracked files are deleted.
func (s *GitService) Discard(repoPath string, files []string) error {
	if len(files) == 0 {
		return nil
	}
	// Classify the requested paths via a targeted status call.
	args := append([]string{"-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--"}, files...)
	out, err := runGit(repoPath, args...)
	if err != nil {
		return err
	}

	var restore, clean, reset []string
	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if len(entry) < 4 || entry[2] != ' ' {
			continue
		}
		x, y := entry[0], entry[1]
		path := entry[3:]
		oldPath := ""
		if x == 'R' || x == 'C' {
			i++
			if i < len(fields) {
				oldPath = fields[i]
			}
		}
		switch {
		case x == '?' && y == '?':
			clean = append(clean, path)
		case x == 'R' || x == 'C':
			// Undo the rename: unstage both paths, restore the old one, delete the new one.
			reset = append(reset, oldPath, path)
			restore = append(restore, oldPath)
			clean = append(clean, path)
		case string(x) == "A":
			// Staged new file: unstage, then delete.
			reset = append(reset, path)
			clean = append(clean, path)
		default:
			restore = append(restore, path)
		}
	}

	if len(reset) > 0 {
		if headHash(repoPath) == "" {
			a := append([]string{"rm", "-r", "--cached", "-q", "--"}, reset...)
			if _, err := runGit(repoPath, a...); err != nil {
				return err
			}
		} else {
			a := append([]string{"reset", "-q", "HEAD", "--"}, reset...)
			if _, err := runGit(repoPath, a...); err != nil {
				return err
			}
		}
	}
	if len(restore) > 0 {
		if headHash(repoPath) != "" {
			a := append([]string{"checkout", "HEAD", "--"}, restore...)
			if _, err := runGit(repoPath, a...); err != nil {
				return err
			}
		}
	}
	if len(clean) > 0 {
		a := append([]string{"clean", "-fd", "--"}, clean...)
		if _, err := runGit(repoPath, a...); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

// Commit creates (or amends) a commit from the staged changes.
func (s *GitService) Commit(repoPath string, opts CommitOptions) (string, error) {
	msg := strings.TrimSpace(opts.Message)
	if msg == "" && !opts.Amend {
		return "", errors.New("提交信息不能为空")
	}
	args := []string{"commit"}
	if opts.Amend {
		args = append(args, "--amend")
		if msg == "" {
			args = append(args, "--no-edit")
		}
	}
	if msg != "" {
		args = append(args, "-m", opts.Message)
	}
	if _, err := runGit(repoPath, args...); err != nil {
		return "", err
	}
	return headHash(repoPath), nil
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

// WorktreeDiff returns the diff of a file: staged (index vs HEAD) or unstaged
// (worktree vs index). Untracked files get a synthesized "new file" diff.
func (s *GitService) WorktreeDiff(repoPath string, file string, staged bool) (string, error) {
	args := []string{"-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "-M"}
	if staged {
		args = append(args, "--staged")
	}
	args = append(args, "--", file)
	// runGitRO：git diff 也会顺带刷新 index，关掉可选写入
	out, err := runGitRO(repoPath, args...)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) == "" && !staged {
		if d, ok := s.synthesizeUntrackedDiff(repoPath, file); ok {
			return d, nil
		}
	}
	return out, nil
}

const untrackedDiffLimit = 2 << 20 // 2 MB

func (s *GitService) synthesizeUntrackedDiff(repoPath, file string) (string, bool) {
	// Only synthesize for genuinely untracked files; an empty diff for a
	// tracked file simply means "no changes".
	if st, err := runGitRO(repoPath, "status", "--porcelain=v1", "-z", "--", file); err != nil ||
		!strings.HasPrefix(st, "?? ") {
		return "", false
	}
	full := filepath.Join(repoPath, filepath.FromSlash(file))
	info, err := os.Stat(full)
	if err != nil || info.IsDir() || info.Size() > untrackedDiffLimit {
		return "", false
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", false
	}
	if isBinaryData(data) {
		return fmt.Sprintf("diff --git a/%s b/%s\nnew file mode %o\nBinary file (%d bytes) not shown.\n",
			file, file, info.Mode().Perm(), info.Size()), true
	}
	text := string(data)
	lines := strings.Split(text, "\n")
	noFinalNewline := len(lines) > 0 && lines[len(lines)-1] == ""
	if noFinalNewline {
		lines = lines[:len(lines)-1]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git a/%s b/%s\nnew file mode %o\n--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n",
		file, file, info.Mode().Perm(), file, len(lines))
	for _, l := range lines {
		b.WriteString("+")
		b.WriteString(l)
		b.WriteString("\n")
	}
	if !noFinalNewline && text != "" {
		b.WriteString("\\ No newline at end of file\n")
	}
	return b.String(), true
}

func isBinaryData(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	for i := 0; i < n; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

// Checkout switches to an existing branch, tag or commit.
func (s *GitService) Checkout(repoPath string, ref string) error {
	_, err := runGit(repoPath, "checkout", ref)
	return err
}

// CreateBranch creates a branch (and optionally checks it out).
func (s *GitService) CreateBranch(repoPath string, opts BranchOptions) error {
	name := strings.TrimSpace(opts.Name)
	if name == "" {
		return errors.New("分支名不能为空")
	}
	args := []string{"checkout", "-b", name}
	if opts.Start != "" {
		args = append(args, opts.Start)
	}
	if !opts.Checkout {
		args = []string{"branch", name}
		if opts.Start != "" {
			args = append(args, opts.Start)
		}
	}
	_, err := runGit(repoPath, args...)
	return err
}

// DeleteBranch deletes a local branch.
func (s *GitService) DeleteBranch(repoPath string, name string, force bool) error {
	flag := "-d"
	if force {
		flag = "-D"
	}
	_, err := runGit(repoPath, "branch", flag, name)
	return err
}

// DeleteRemoteBranch deletes a branch on a remote.
func (s *GitService) DeleteRemoteBranch(repoPath string, remote string, name string) error {
	_, err := runGitNetwork(repoPath, "push", remote, "--delete", name)
	return err
}

// RenameBranch renames a local branch.
func (s *GitService) RenameBranch(repoPath string, oldName string, newName string) error {
	if strings.TrimSpace(newName) == "" {
		return errors.New("分支名不能为空")
	}
	_, err := runGit(repoPath, "branch", "-m", oldName, newName)
	return err
}

// Merge merges a ref into the current branch.
func (s *GitService) Merge(repoPath string, opts MergeOptions) error {
	args := []string{"merge"}
	if opts.NoFF {
		args = append(args, "--no-ff")
	}
	if opts.Squash {
		args = append(args, "--squash")
	}
	args = append(args, opts.Ref)
	_, err := runGit(repoPath, args...)
	return err
}

// MergeAbort aborts an in-progress merge.
func (s *GitService) MergeAbort(repoPath string) error {
	_, err := runGit(repoPath, "merge", "--abort")
	return err
}

// Rebase rebases the current branch onto the given upstream.
func (s *GitService) Rebase(repoPath string, upstream string) error {
	_, err := runGit(repoPath, "rebase", upstream)
	return err
}

// RebaseAbort aborts an in-progress rebase.
func (s *GitService) RebaseAbort(repoPath string) error {
	_, err := runGit(repoPath, "rebase", "--abort")
	return err
}

// RebaseContinue continues an in-progress rebase.
func (s *GitService) RebaseContinue(repoPath string) error {
	_, err := runGit(repoPath, "rebase", "--continue")
	return err
}

// RebaseSkip skips the current patch of an in-progress rebase.
func (s *GitService) RebaseSkip(repoPath string) error {
	_, err := runGit(repoPath, "rebase", "--skip")
	return err
}

// CherryPick applies a commit onto the current branch.
func (s *GitService) CherryPick(repoPath string, hash string) error {
	_, err := runGit(repoPath, "cherry-pick", hash)
	return err
}

// CherryPickAbort aborts an in-progress cherry-pick.
func (s *GitService) CherryPickAbort(repoPath string) error {
	_, err := runGit(repoPath, "cherry-pick", "--abort")
	return err
}

// CherryPickContinue continues an in-progress cherry-pick.
func (s *GitService) CherryPickContinue(repoPath string) error {
	_, err := runGit(repoPath, "-c", "core.editor=true", "cherry-pick", "--continue")
	return err
}

// Revert creates a commit undoing the given commit.
func (s *GitService) Revert(repoPath string, hash string) error {
	_, err := runGit(repoPath, "revert", "--no-edit", hash)
	return err
}

// RevertAbort aborts an in-progress revert.
func (s *GitService) RevertAbort(repoPath string) error {
	_, err := runGit(repoPath, "revert", "--abort")
	return err
}

// Reset moves the current branch to target. mode: soft | mixed | hard.
func (s *GitService) Reset(repoPath string, target string, mode string) error {
	switch mode {
	case "soft", "mixed", "hard":
	default:
		return errors.New("无效的 reset 模式: " + mode)
	}
	if target == "" {
		target = "HEAD"
	}
	_, err := runGit(repoPath, "reset", "--"+mode, target)
	return err
}

// ---------------------------------------------------------------------------
// Remote operations
// ---------------------------------------------------------------------------

// AddRemote adds a remote pointing at url. The name must be unique.
func (s *GitService) AddRemote(repoPath string, name string, url string) error {
	name = strings.TrimSpace(name)
	url = strings.TrimSpace(url)
	if name == "" {
		return errors.New("远程名不能为空")
	}
	if url == "" {
		return errors.New("远程地址不能为空")
	}
	_, err := runGit(repoPath, "remote", "add", name, url)
	return err
}

// RemoveRemote removes a remote. The last remaining remote is protected so the
// repository never ends up without any remote.
func (s *GitService) RemoveRemote(repoPath string, name string) error {
	if len(s.remoteNames(repoPath)) <= 1 {
		return errors.New("至少保留一个远程，无法删除最后一个")
	}
	_, err := runGit(repoPath, "remote", "remove", name)
	return err
}

// RenameRemote renames a remote (git remote rename). Renaming also renames
// the remote-tracking branches (refs/remotes/old/* → refs/remotes/new/*) and
// updates branch upstream configs automatically.
func (s *GitService) RenameRemote(repoPath string, oldName string, newName string) error {
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || newName == "" {
		return errors.New("远程名不能为空")
	}
	if oldName == newName {
		return nil
	}
	_, err := runGit(repoPath, "remote", "rename", oldName, newName)
	return err
}

// SetRemoteUrl updates the fetch URL of a remote (git remote set-url).
func (s *GitService) SetRemoteUrl(repoPath string, name string, url string) error {
	name = strings.TrimSpace(name)
	url = strings.TrimSpace(url)
	if name == "" {
		return errors.New("远程名不能为空")
	}
	if url == "" {
		return errors.New("远程地址不能为空")
	}
	_, err := runGit(repoPath, "remote", "set-url", name, url)
	return err
}

// Fetch fetches one remote (or all when remote == "").
func (s *GitService) Fetch(repoPath string, remote string, prune bool) (string, error) {
	args := []string{"fetch"}
	if prune {
		args = append(args, "--prune")
	}
	if remote == "" || remote == "--all" {
		args = append(args, "--all")
	} else {
		args = append(args, remote)
	}
	out, err := runGitNetwork(repoPath, args...)
	return out, err
}

// Pull pulls from a remote.
func (s *GitService) Pull(repoPath string, opts PullOptions) (string, error) {
	args := []string{"pull"}
	if opts.Rebase {
		args = append(args, "--rebase")
	}
	if opts.Autostash {
		args = append(args, "--autostash")
	}
	if opts.Remote != "" {
		args = append(args, opts.Remote)
		if opts.Branch != "" {
			args = append(args, opts.Branch)
		}
	}
	out, err := runGitNetwork(repoPath, args...)
	if err != nil {
		return out, err
	}
	return out, nil
}

// Push pushes a branch to a remote.
func (s *GitService) Push(repoPath string, opts PushOptions) (string, error) {
	remote := opts.Remote
	if remote == "" {
		remote = "origin"
	}
	args := []string{"push"}
	if opts.SetUpstream {
		args = append(args, "-u")
	}
	if opts.Force {
		args = append(args, "--force-with-lease")
	}
	if opts.PushTags {
		args = append(args, "--tags")
	}
	args = append(args, remote)
	branch := opts.Branch
	if branch == "" {
		branch = "HEAD"
	}
	args = append(args, branch)
	out, err := runGitNetwork(repoPath, args...)
	return out, err
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

// StashList returns all stash entries, newest first.
func (s *GitService) StashList(repoPath string) ([]StashEntry, error) {
	out, err := runGit(repoPath, "stash", "list", "--format=%gd%x1f%gs%x1f%ct")
	if err != nil {
		return nil, err
	}
	entries := []StashEntry{}
	for _, l := range splitLines(out) {
		f := strings.SplitN(l, "\x1f", 3)
		if len(f) < 3 {
			continue
		}
		e := StashEntry{Ref: f[0], Message: f[1]}
		e.Timestamp, _ = strconv.ParseInt(strings.TrimSpace(f[2]), 10, 64)
		// "WIP on main: abc1234 msg" / "On main: custom message" / "index on main: ..."
		e.Branch, e.Message = parseStashSubject(f[1])
		if n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(f[0], "stash@{"), "}")); err == nil {
			e.Index = n
		}
		entries = append(entries, e)
	}
	return entries, nil
}

func parseStashSubject(subj string) (branch, message string) {
	if strings.HasPrefix(subj, "WIP on ") || strings.HasPrefix(subj, "index on ") {
		rest := subj
		if i := strings.Index(rest, ": "); i >= 0 {
			head := rest[:i]
			head = strings.TrimPrefix(head, "WIP on ")
			head = strings.TrimPrefix(head, "index on ")
			return head, rest[i+2:]
		}
		return "", subj
	}
	if strings.HasPrefix(subj, "On ") {
		if i := strings.Index(subj, ": "); i >= 0 {
			return subj[3:i], subj[i+2:]
		}
	}
	return "", subj
}

// StashSave creates a new stash entry.
func (s *GitService) StashSave(repoPath string, opts StashOptions) error {
	args := []string{"stash", "push"}
	if opts.IncludeUntracked {
		args = append(args, "-u")
	}
	if opts.KeepIndex {
		args = append(args, "--keep-index")
	}
	if strings.TrimSpace(opts.Message) != "" {
		args = append(args, "-m", opts.Message)
	}
	_, err := runGit(repoPath, args...)
	return err
}

// StashPop applies a stash entry and drops it.
func (s *GitService) StashPop(repoPath string, index int) error {
	_, err := runGit(repoPath, "stash", "pop", fmt.Sprintf("stash@{%d}", index))
	return err
}

// StashApply applies a stash entry, keeping it in the list.
func (s *GitService) StashApply(repoPath string, index int) error {
	_, err := runGit(repoPath, "stash", "apply", fmt.Sprintf("stash@{%d}", index))
	return err
}

// StashDrop removes a stash entry.
func (s *GitService) StashDrop(repoPath string, index int) error {
	_, err := runGit(repoPath, "stash", "drop", fmt.Sprintf("stash@{%d}", index))
	return err
}

// StashClear removes all stash entries.
func (s *GitService) StashClear(repoPath string) error {
	_, err := runGit(repoPath, "stash", "clear")
	return err
}

// StashApplyIndex applies a stash entry and also restores the staged state
// (git stash apply --index).
func (s *GitService) StashApplyIndex(repoPath string, index int) error {
	_, err := runGit(repoPath, "stash", "apply", "--index", fmt.Sprintf("stash@{%d}", index))
	return err
}

// StashBranch creates a new branch from the commit the stash was based on and
// applies the stash there (git stash branch <name> <stash>). Useful when the
// current branch has moved and applying would conflict. Note: it checks out
// the new branch.
func (s *GitService) StashBranch(repoPath string, index int, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("分支名不能为空")
	}
	_, err := runGit(repoPath, "stash", "branch", name, fmt.Sprintf("stash@{%d}", index))
	return err
}

// StashFiles lists the files contained in a stash entry with their status.
// Tracked changes are the diff between the stash commit and its first parent
// (HEAD at stash time); files stashed with -u live in the stash's third
// parent and are reported as untracked additions.
func (s *GitService) StashFiles(repoPath string, index int) ([]CommitFile, error) {
	ref := fmt.Sprintf("stash@{%d}", index)
	if _, err := runGit(repoPath, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err != nil {
		return nil, fmt.Errorf("stash@{%d} 不存在（可能已被弹出或删除）", index)
	}
	files, err := s.diffFileList(repoPath, []string{"diff", "-M", ref + "^1", ref})
	if err != nil {
		return nil, err
	}
	// stash -u 时未跟踪文件保存在第三个父提交中；ls-tree 失败即没有该父提交
	if lsOut, err := runGitRO(repoPath, "-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "-z", ref+"^3"); err == nil {
		seen := make(map[string]bool, len(files))
		for _, f := range files {
			seen[f.Path] = true
		}
		for _, p := range strings.Split(lsOut, "\x00") {
			if p == "" || seen[p] {
				continue
			}
			files = append(files, CommitFile{Path: p, Status: "A", Untracked: true})
		}
	}
	return files, nil
}

// StashDiff returns the diff of one file inside a stash entry. Untracked
// files (stashed with -u) have no tracked diff; their content is read from
// the stash's third parent and synthesized into a new-file patch.
func (s *GitService) StashDiff(repoPath string, index int, file string) (string, error) {
	ref := fmt.Sprintf("stash@{%d}", index)
	out, err := runGitRO(repoPath, "-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "-M", ref+"^1", ref, "--", file)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) != "" {
		return out, nil
	}
	if d, ok := s.synthesizeStashUntrackedDiff(repoPath, ref, file); ok {
		return d, nil
	}
	return out, nil
}

// synthesizeStashUntrackedDiff builds a new-file patch for an untracked file
// stored in the stash's third parent (stash -u).
func (s *GitService) synthesizeStashUntrackedDiff(repoPath, ref, file string) (string, bool) {
	out, err := runGitRO(repoPath, "-c", "core.quotepath=false", "cat-file", "blob", ref+"^3:"+file)
	if err != nil {
		return "", false
	}
	mode := "100644"
	if t, err := runGitRO(repoPath, "-c", "core.quotepath=false", "ls-tree", ref+"^3", "--", file); err == nil && t != "" {
		if f := strings.Fields(strings.SplitN(t, "\x00", 2)[0]); len(f) >= 3 {
			mode = f[0]
		}
	}
	if len(out) > untrackedDiffLimit {
		return "", false
	}
	if isBinaryData([]byte(out)) {
		return fmt.Sprintf("diff --git a/%s b/%s\nnew file mode %s\nBinary file (%d bytes) not shown.\n",
			file, file, mode, len(out)), true
	}
	lines := strings.Split(out, "\n")
	noFinalNewline := len(lines) > 0 && lines[len(lines)-1] == ""
	if noFinalNewline {
		lines = lines[:len(lines)-1]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git a/%s b/%s\nnew file mode %s\n--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n",
		file, file, mode, file, len(lines))
	for _, l := range lines {
		b.WriteString("+")
		b.WriteString(l)
		b.WriteString("\n")
	}
	if !noFinalNewline && out != "" {
		b.WriteString("\\ No newline at end of file\n")
	}
	return b.String(), true
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

// CreateTag creates a lightweight (or annotated when message is set) tag.
func (s *GitService) CreateTag(repoPath string, opts TagOptions) error {
	name := strings.TrimSpace(opts.Name)
	if name == "" {
		return errors.New("标签名不能为空")
	}
	args := []string{"tag"}
	if strings.TrimSpace(opts.Message) != "" {
		args = append(args, "-a", "-m", opts.Message)
	}
	args = append(args, name)
	if opts.Target != "" {
		args = append(args, opts.Target)
	}
	if _, err := runGit(repoPath, args...); err != nil {
		return err
	}
	if opts.Push {
		remote := opts.Remote
		if remote == "" {
			remote = "origin"
		}
		if _, err := runGitNetwork(repoPath, "push", remote, name); err != nil {
			return err
		}
	}
	return nil
}

// DeleteTag deletes a tag locally and optionally on a remote.
func (s *GitService) DeleteTag(repoPath string, name string, remote string) error {
	if _, err := runGit(repoPath, "tag", "-d", name); err != nil {
		return err
	}
	if remote != "" {
		if _, err := runGitNetwork(repoPath, "push", remote, ":refs/tags/"+name); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Step runner (for guided multi-step workflows)
// ---------------------------------------------------------------------------

// RunGitStep executes one raw git command and returns its command line plus
// combined output for step-by-step display in the UI. Unlike the other
// methods, a failing git command does not produce a Go error: the frontend
// inspects GitStepResult.OK and decides how to continue. The error return is
// reserved for invalid arguments.
//
// network selects the long timeout used by commands that talk to a remote
// (fetch/pull/push).
func (s *GitService) RunGitStep(repoPath string, args []string, network bool) (*GitStepResult, error) {
	if repoPath == "" {
		return nil, errors.New("没有仓库路径")
	}
	if len(args) == 0 {
		return nil, errors.New("缺少 git 参数")
	}
	return runGitStep(repoPath, network, args...), nil
}

// ---------------------------------------------------------------------------
// Built-in terminal
// ---------------------------------------------------------------------------

// cmdPwdMarker delimits the working-directory report appended to every
// terminal command so `cd` can persist across invocations.
const cmdPwdMarker = "__GV_PWD__"

// RunCommand executes an arbitrary shell command for the built-in terminal.
// cwd is the directory the command starts in ("" = repoPath). The final
// working directory is reported back so the UI can keep `cd` state.
// Output is capped; only real startup failures return an error.
func (s *GitService) RunCommand(repoPath string, cwd string, command string) (*CommandResult, error) {
	res := &CommandResult{}
	command = strings.TrimSpace(command)
	if command == "" {
		return res, nil
	}
	dir := cwd
	if dir == "" {
		dir = repoPath
	}
	if dir == "" {
		return nil, errors.New("没有可用的工作目录")
	}
	if !pathExists(dir) {
		return nil, fmt.Errorf("目录不存在: %s", dir)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Append a marker line reporting the shell's final PWD (captured &
	// stripped below) so subsequent commands can continue from there.
	script := command + "\n__gv_ec=$?; printf '\\n" + cmdPwdMarker + "%s\\n' \"$PWD\"; exit $__gv_ec"
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", script)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"LC_ALL=en_US.UTF-8",
		"GIT_PAGER=cat",
		"PAGER=cat",
		"GIT_EDITOR=true",
		"EDITOR=true",
		"GIT_TERMINAL_PROMPT=0",
		// 强制彩色输出：终端 UI 会解析 ANSI 颜色码做主题化渲染。
		// git 2.31+ 支持通过 GIT_CONFIG_* 环境变量注入配置。
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=color.ui", "GIT_CONFIG_VALUE_0=always",
		"GIT_CONFIG_KEY_1=color.diff", "GIT_CONFIG_VALUE_1=always",
		"CLICOLOR_FORCE=1",
		"FORCE_COLOR=1",
	)
	cmd.WaitDelay = 5 * time.Second

	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	runStart := time.Now()
	runErr := cmd.Run()

	out := buf.String()

	// Extract and strip the PWD marker line.
	lines := strings.Split(out, "\n")
	kept := make([]string, 0, len(lines))
	for _, ln := range lines {
		if strings.HasPrefix(ln, cmdPwdMarker) {
			res.NewCwd = strings.TrimPrefix(ln, cmdPwdMarker)
			continue
		}
		kept = append(kept, ln)
	}
	out = strings.Join(kept, "\n")

	if ctx.Err() == context.DeadlineExceeded {
		res.Timeout = true
		res.ExitCode = -1
	} else if runErr != nil {
		var ee *exec.ExitError
		if errors.As(runErr, &ee) {
			res.ExitCode = ee.ExitCode()
		} else {
			return nil, runErr
		}
	}

	// 记录到调试日志（终端命令也算“执行过的命令”）。
	logEntry := GitLogEntry{
		Time:     runStart.UnixMilli(),
		Kind:     "shell",
		Dir:      dir,
		Command:  command,
		Duration: time.Since(runStart).Milliseconds(),
		Output:   out,
	}
	switch {
	case res.Timeout:
		logEntry.Error = "超时（5 分钟），已终止"
	case res.ExitCode != 0:
		logEntry.Error = "退出码 " + strconv.Itoa(res.ExitCode)
	default:
		logEntry.OK = true
	}
	recordCommand(logEntry)

	// Cap output: keep the tail (most recent), which is what users care about.
	const maxOut = 256 * 1024
	if len(out) > maxOut {
		out = "… 输出过长，已截断开头 …\n" + out[len(out)-maxOut:]
	}
	res.Output = out
	return res, nil
}

// ---------------------------------------------------------------------------
// Global git configuration
// ---------------------------------------------------------------------------

// GlobalConfig returns the values of the git config keys the settings panel
// exposes. Missing keys are returned as empty strings.
func (s *GitService) GlobalConfig() (map[string]string, error) {
	keys := []string{"user.name", "user.email", "core.editor", "init.defaultBranch"}
	res := make(map[string]string, len(keys))
	for _, k := range keys {
		out, err := runGit("", "config", "--global", "--get", k)
		if err != nil {
			continue // unset or missing global file
		}
		res[k] = strings.TrimSpace(out)
	}
	return res, nil
}

// SetGlobalConfig writes one global git config key. An empty value unsets it.
func (s *GitService) SetGlobalConfig(key, value string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return errors.New("配置项不能为空")
	}
	// Only allow manipulating known-safe keys from the settings UI.
	switch key {
	case "user.name", "user.email", "core.editor", "init.defaultBranch":
	default:
		return errors.New("不支持修改的配置项: " + key)
	}
	if strings.TrimSpace(value) == "" {
		_, err := runGit("", "config", "--global", "--unset", key)
		if err != nil && strings.Contains(err.Error(), "exit status 5") {
			return nil // key was already unset
		}
		return err
	}
	_, err := runGit("", "config", "--global", key, strings.TrimSpace(value))
	return err
}
