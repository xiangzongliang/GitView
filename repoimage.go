package main

import (
	"bytes"
	"context"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// repoFileRoute 是本处理器拦截的 URL 前缀。前端用它直接以 <img src> 预览
// 仓库中的图片文件（工作区/暂存区/HEAD 任意版本），原始字节经 webview 的
// 资源服务器返回，避免在 JS 里做二进制/base64 转换。
//
//	GET /gitview-file?repo=<仓库路径>&path=<仓库内相对路径>&ref=<worktree|index|head|任意 git 修订>
const repoFileRoute = "/gitview-file"

// repoFileHandler 是挂在 Wails AssetOptions.Handler 上的复合处理器：
// 命中 repoFileRoute 的请求由它读取仓库文件字节，其余请求全部委托给
// 默认的静态资源服务（生产 = 内嵌 dist，开发 = 反向代理到 vite）。
type repoFileHandler struct {
	fallback    http.Handler
	repoService *RepoService
}

func newRepoFileHandler(fallback http.Handler, repoService *RepoService) *repoFileHandler {
	return &repoFileHandler{fallback: fallback, repoService: repoService}
}

func (h *repoFileHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == repoFileRoute {
		h.serve(w, r)
		return
	}
	h.fallback.ServeHTTP(w, r)
}

// imageMimeByExt 手工兜底表：mime.TypeByExtension 依赖系统 MIME 数据库，
// 不同平台/发行版对 webp、avif、svg 等的收录并不一致。
var imageMimeByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".svg":  "image/svg+xml",
	".avif": "image/avif",
	".tif":  "image/tiff",
	".tiff": "image/tiff",
}

// isPreviewableImage 只允许图片扩展名走该通道，避免它变成任意的文件读取接口
// （桌面模式下风险有限，但 server 模式会暴露 HTTP 端口）。
func isPreviewableImage(p string) bool {
	_, ok := imageMimeByExt[strings.ToLower(filepath.Ext(p))]
	return ok
}

func imageContentType(p string) string {
	ext := strings.ToLower(filepath.Ext(p))
	if ct, ok := imageMimeByExt[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

func (h *repoFileHandler) serve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	repo := q.Get("repo")
	rel := q.Get("path")
	// 已知的关键字不区分大小写；任意 git 修订（分支名等）保留原始大小写
	ref := strings.TrimSpace(q.Get("ref"))
	switch strings.ToLower(ref) {
	case "", "worktree":
		ref = "worktree"
	case "index":
		ref = "index"
	case "head":
		ref = "head"
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", imageContentType(rel))

	if repo == "" || rel == "" {
		http.Error(w, "repo 与 path 参数必填", http.StatusBadRequest)
		return
	}
	if !isPreviewableImage(rel) {
		http.Error(w, "仅支持预览图片文件", http.StatusForbidden)
		return
	}
	if strings.HasPrefix(ref, "-") || strings.ContainsRune(ref, 0) {
		http.Error(w, "非法的 ref 参数", http.StatusBadRequest)
		return
	}
	if !h.isKnownRepo(repo) {
		http.Error(w, "仓库未在应用中注册", http.StatusForbidden)
		return
	}
	if !isSafeRepoFile(repo, rel) {
		http.Error(w, "非法的文件路径", http.StatusBadRequest)
		return
	}

	var data []byte
	var err error
	if ref == "worktree" {
		data, err = os.ReadFile(filepath.Join(repo, filepath.FromSlash(rel)))
	} else {
		data, err = gitShowBlob(repo, ref, rel)
	}
	if err != nil {
		// 常见原因：新增文件没有 HEAD 版本、删除文件在工作区不存在等，
		// 前端会显示「该版本不存在」占位，因此统一按 404 处理即可。
		http.Error(w, "文件不存在: "+err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// isKnownRepo 校验请求的仓库确实是应用已注册（用户显式打开过）的仓库。
func (h *repoFileHandler) isKnownRepo(repo string) bool {
	if h.repoService == nil {
		return false
	}
	entries, err := h.repoService.ListRepos()
	if err != nil {
		return false
	}
	clean := filepath.Clean(repo)
	for _, e := range entries {
		if filepath.Clean(e.Path) == clean {
			return true
		}
	}
	return false
}

// isSafeRepoFile 防止路径穿越：rel 必须是仓库根内的相对路径，
// 且不允许读取 .git 目录本身。
func isSafeRepoFile(repo, rel string) bool {
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`) {
		return false
	}
	if rel == ".git" || strings.HasPrefix(rel, ".git/") {
		return false
	}
	info, err := os.Stat(repo)
	if err != nil || !info.IsDir() {
		return false
	}
	absRepo, err := filepath.Abs(repo)
	if err != nil {
		return false
	}
	full := filepath.Join(absRepo, filepath.FromSlash(rel))
	if full != absRepo && !strings.HasPrefix(full, absRepo+string(filepath.Separator)) {
		return false
	}
	return true
}

// gitShowBlob 读取仓库某个版本（index / head / 任意 git 修订）的文件字节，
// 等价于 `git show <rev>:<path>`（ref=index 时为 `git show :<path>`）。
func gitShowBlob(repo, ref, rel string) ([]byte, error) {
	revspec := ref
	switch ref {
	case "index":
		revspec = ""
	case "head":
		revspec = "HEAD"
	}

	args := []string{"show", revspec + ":" + rel}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	markGitCmdStart()
	defer markGitCmdDone()
	start := time.Now()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repo
	// GIT_OPTIONAL_LOCKS=0：只读命令不要顺手刷新 index（见 gitexec.go 的说明）
	cmd.Env = append(gitEnv(), "GIT_OPTIONAL_LOCKS=0")
	cmd.WaitDelay = 5 * time.Second

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	entry := GitLogEntry{
		Time:     start.UnixMilli(),
		Kind:     "git",
		Dir:      repo,
		Command:  "git " + joinCommand(args...),
		Duration: time.Since(start).Milliseconds(),
	}
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		entry.Error = "超时"
		recordCommand(entry)
		return nil, fmt.Errorf("git 命令超时: git %s", joinCommand(args...))
	case runErr != nil:
		msg := firstNonEmpty(strings.TrimSpace(stderr.String()), runErr.Error())
		entry.Error = msg
		recordCommand(entry)
		return nil, fmt.Errorf("%s", msg)
	}
	entry.OK = true
	// 调试日志只记大小：图片内容写进日志没有意义还会刷屏
	entry.Output = fmt.Sprintf("(图片内容，%d 字节)", stdout.Len())
	recordCommand(entry)
	return stdout.Bytes(), nil
}
