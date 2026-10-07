package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newConflictRepo 建一个带冲突的测试仓库：main 与 feature 都改了 a.txt 的同一行。
func newConflictRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		if _, err := runGit(dir, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	git("init", "-b", "main")
	git("config", "user.email", "t@t")
	git("config", "user.name", "t")
	write("a.txt", "line1\nbase\nline3\n")
	git("add", ".")
	git("commit", "-m", "base")
	git("checkout", "-b", "feature")
	write("a.txt", "line1\ntheirs\nline3\n")
	git("commit", "-am", "theirs change")
	git("checkout", "main")
	write("a.txt", "line1\nours\nline3\n")
	git("commit", "-am", "ours change")
	// 产生冲突（merge 失败但留下 MERGE_HEAD 与冲突文件）
	if _, err := runGit(dir, "merge", "feature"); err == nil {
		t.Fatal("expected merge conflict")
	}
	return dir
}

func TestConflictDetail(t *testing.T) {
	dir := newConflictRepo(t)
	s := &GitService{}

	d, err := s.ConflictDetail(dir, "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !d.Ours.Exists || !d.Theirs.Exists || !d.Base.Exists {
		t.Fatalf("sides should all exist: %+v", d)
	}
	if d.Ours.Content != "line1\nours\nline3\n" {
		t.Errorf("ours = %q", d.Ours.Content)
	}
	if d.Theirs.Content != "line1\ntheirs\nline3\n" {
		t.Errorf("theirs = %q", d.Theirs.Content)
	}
	if d.Base.Content != "line1\nbase\nline3\n" {
		t.Errorf("base = %q", d.Base.Content)
	}
	if !strings.Contains(d.Worktree, "<<<<<<<") {
		t.Errorf("worktree should contain markers: %q", d.Worktree)
	}
	if d.Binary {
		t.Error("should not be binary")
	}
	if d.Ours.Label != "main" {
		t.Errorf("ours label = %q, want main", d.Ours.Label)
	}
	if d.Theirs.Label != "feature" {
		t.Errorf("theirs label = %q, want feature", d.Theirs.Label)
	}
}

func TestWriteWorktreeFile(t *testing.T) {
	dir := newConflictRepo(t)
	s := &GitService{}

	if err := s.WriteWorktreeFile(dir, "a.txt", "resolved\n"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "resolved\n" {
		t.Fatalf("file = %q", b)
	}
	// 路径逃逸必须被拒绝
	if err := s.WriteWorktreeFile(dir, "../escape.txt", "x"); err == nil {
		t.Error("path escape should be rejected")
	}
}

func TestResolveConflictTakeSide(t *testing.T) {
	dir := newConflictRepo(t)
	s := &GitService{}

	if err := s.ResolveConflictTakeSide(dir, "a.txt", "theirs"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "line1\ntheirs\nline3\n" {
		t.Fatalf("after take theirs = %q", b)
	}
	// 冲突应已解决（不再出现在 conflicted 列表）
	st, err := s.Status(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Conflicted) != 0 {
		t.Fatalf("conflict not resolved: %+v", st.Conflicted)
	}
}

// delete/modify 冲突：一侧删除文件、一侧修改文件。
func TestResolveConflictDeleteModify(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		if _, err := runGit(dir, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	write := func(name, content string) {
		t.Helper()
		os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
	}
	git("init", "-b", "main")
	git("config", "user.email", "t@t")
	git("config", "user.name", "t")
	write("a.txt", "x\n")
	git("add", ".")
	git("commit", "-m", "base")
	git("checkout", "-b", "feature")
	write("a.txt", "modified\n")
	git("commit", "-am", "modify")
	git("checkout", "main")
	git("rm", "a.txt")
	git("commit", "-m", "delete")
	if _, err := runGit(dir, "merge", "feature"); err == nil {
		t.Fatal("expected conflict")
	}

	s := &GitService{}
	d, err := s.ConflictDetail(dir, "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if d.Ours.Exists {
		t.Errorf("ours (main deleted it) should not exist")
	}
	if !d.Theirs.Exists {
		t.Error("theirs should exist")
	}

	// 保留 ours = 删除该文件
	if err := s.ResolveConflictTakeSide(dir, "a.txt", "ours"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); !os.IsNotExist(err) {
		t.Fatal("file should be deleted")
	}
	st, _ := s.Status(dir)
	if len(st.Conflicted) != 0 {
		t.Fatalf("conflict not resolved: %+v", st.Conflicted)
	}
}
