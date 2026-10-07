package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestIsPreviewableImage(t *testing.T) {
	yes := []string{"a.png", "b.JPG", "c/d.jpeg", "x.gif", "y.webp", "z.bmp", "i.ico", "s.svg", "v.avif"}
	for _, p := range yes {
		if !isPreviewableImage(p) {
			t.Errorf("isPreviewableImage(%q) = false, want true", p)
		}
	}
	no := []string{"a.txt", "b.go", "c", "d.pdf", "e.js", "f.PNG.exe"}
	for _, p := range no {
		if isPreviewableImage(p) {
			t.Errorf("isPreviewableImage(%q) = true, want false", p)
		}
	}
}

func TestImageContentType(t *testing.T) {
	cases := map[string]string{
		"a.svg":   "image/svg+xml",
		"b.PNG":   "image/png",
		"c.jpg":   "image/jpeg",
		"d.webp":  "image/webp",
		"e.avif":  "image/avif",
		"noext":   "application/octet-stream",
		"x.unknown": "application/octet-stream",
	}
	for in, want := range cases {
		if got := imageContentType(in); got != want {
			t.Errorf("imageContentType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsSafeRepoFile(t *testing.T) {
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	safe := []string{"logo.png", "sub/logo.png", "a/b/c.png"}
	for _, rel := range safe {
		if !isSafeRepoFile(repo, rel) {
			t.Errorf("isSafeRepoFile(%q) = false, want true", rel)
		}
	}

	unsafe := []string{
		"/abs/logo.png",         // absolute
		"../outside.png",        // parent escape
		"sub/../../outside.png", // nested escape
		".git/config",           // git internals
		".git",                  // git dir itself
	}
	if runtime.GOOS == "windows" {
		// 反斜杠只在 Windows 上是分隔符；unix 下 `..\x.png` 只是一个普通文件名
		unsafe = append(unsafe, `..\windows.png`)
	}
	for _, rel := range unsafe {
		if isSafeRepoFile(repo, rel) {
			t.Errorf("isSafeRepoFile(%q) = true, want false", rel)
		}
	}

	// 仓库目录不存在时一律拒绝
	if isSafeRepoFile(filepath.Join(repo, "missing"), "logo.png") {
		t.Error("isSafeRepoFile on missing repo = true, want false")
	}
}

// newImageRepo 建一个含 logo.png 三个版本（HEAD / index / worktree 各不相同）的仓库。
func newImageRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		if _, err := runGit(dir, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.email", "t@t")
	git("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "logo.png"), []byte("HEAD"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "logo.png")
	git("commit", "-m", "base")
	// index 版本
	if err := os.WriteFile(filepath.Join(dir, "logo.png"), []byte("INDEX"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "logo.png")
	// worktree 版本（在 add 之后再改）
	if err := os.WriteFile(filepath.Join(dir, "logo.png"), []byte("WORKTREE"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestGitShowBlob(t *testing.T) {
	dir := newImageRepo(t)

	head, err := gitShowBlob(dir, "head", "logo.png")
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if string(head) != "HEAD" {
		t.Errorf("head = %q, want HEAD", head)
	}

	index, err := gitShowBlob(dir, "index", "logo.png")
	if err != nil {
		t.Fatalf("index: %v", err)
	}
	if string(index) != "INDEX" {
		t.Errorf("index = %q, want INDEX", index)
	}

	// 不存在的文件应报错
	if _, err := gitShowBlob(dir, "head", "missing.png"); err == nil {
		t.Error("gitShowBlob missing file: want error, got nil")
	}
}

func TestRepoFileHandlerServe(t *testing.T) {
	// 用临时 HOME 隔离 config.json，注册仓库后走完整 serve 路径
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)

	dir := newImageRepo(t)
	svc := &RepoService{}
	entry, err := svc.OpenRepo(dir)
	if err != nil {
		t.Fatalf("OpenRepo: %v", err)
	}
	// 用注册后的路径查询（与生产一致：前端拿到的 repo.path 就是 RepoEntry.Path，
	// macOS 上是 git 解析过符号链接的物理路径）
	repo := entry.Path

	h := newRepoFileHandler(http.NotFoundHandler(), svc)

	get := func(query string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, repoFileRoute+"?"+query, nil))
		return rec
	}

	// worktree 版本
	rec := get("repo=" + repo + "&path=logo.png&ref=worktree")
	if rec.Code != http.StatusOK || rec.Body.String() != "WORKTREE" {
		t.Errorf("worktree: code=%d body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("worktree Content-Type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q", cc)
	}

	// head 版本
	rec = get("repo=" + repo + "&path=logo.png&ref=head")
	if rec.Code != http.StatusOK || rec.Body.String() != "HEAD" {
		t.Errorf("head: code=%d body=%q", rec.Code, rec.Body.String())
	}

	// 未注册的仓库 → 403
	rec = get("repo=" + t.TempDir() + "&path=logo.png&ref=worktree")
	if rec.Code != http.StatusForbidden {
		t.Errorf("unknown repo: code=%d, want 403", rec.Code)
	}

	// 非图片扩展名 → 403
	rec = get("repo=" + repo + "&path=secret.txt&ref=worktree")
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-image: code=%d, want 403", rec.Code)
	}

	// 路径穿越 → 400
	rec = get("repo=" + repo + "&path=../x.png&ref=worktree")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("traversal: code=%d, want 400", rec.Code)
	}

	// 缺少参数 → 400
	rec = get("repo=" + repo)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing path: code=%d, want 400", rec.Code)
	}

	// 不存在的文件 → 404
	rec = get("repo=" + repo + "&path=nope.png&ref=worktree")
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing file: code=%d, want 404", rec.Code)
	}

	// 非 /gitview-file 路径应委托给 fallback
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/index.html", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("fallback: code=%d, want 404", rec.Code)
	}
}

func TestRefFlagInjectionRejected(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)

	dir := newImageRepo(t)
	svc := &RepoService{}
	entry, err := svc.OpenRepo(dir)
	if err != nil {
		t.Fatalf("OpenRepo: %v", err)
	}
	h := newRepoFileHandler(http.NotFoundHandler(), svc)

	rec := httptest.NewRecorder()
	u := repoFileRoute + "?repo=" + entry.Path + "&path=logo.png&ref=" + "--output=/tmp/pwn"
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, u, nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("flag ref: code=%d, want 400", rec.Code)
	}
	if !strings.HasPrefix(rec.Body.String(), "非法的 ref") {
		t.Logf("body = %q", rec.Body.String())
	}
}
