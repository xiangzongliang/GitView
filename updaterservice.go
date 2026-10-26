package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/endpoint"
)

// 与 Wails 内置 updater 同名的事件：「关于」页已在监听这些事件，
// 自解包下载时直接复用，进度条/下载中状态无需额外改动。
const (
	evDownloadStarted  = "wails:updater:download-started"
	evDownloadProgress = "wails:updater:download-progress"
)

// updateProgressEvent 是 download-progress 事件的负载（字段名与内置 updater 一致）。
type updateProgressEvent struct {
	Written int64 `json:"written"`
	Total   int64 `json:"total"`
}

func emitUpdaterEvent(name string, payload any) {
	if app := application.Get(); app != nil && app.Event != nil {
		app.Event.Emit(name, payload)
	}
}

// ===========================================================================
// 更新源配置
//
// 「自动升级访问的域名 / 接口」全部集中提取在下面这一段常量里，
// 切换更新服务器只需改这里（或用环境变量覆盖），业务逻辑无需改动。
// ===========================================================================
const (
	// 更新服务器域名（默认自建更新服务）。可用 GITVIEW_UPDATE_BASE_URL 覆盖。
	updateBaseURL = "https://xais.iepose.cn"

	// 更新清单接口路径（与 ServeApi/app/routers/gitview_update.py 的
	// GET /api/v1/gitview/updates/manifest 一致）。
	// GitView 与 pcApp 完全独立：该接口只返回 gitview_releases 表中的发布，
	// 不会与 pcApp 的 app_releases 混用。
	// platform / arch / version 等查询参数由 updater 每次检查时自动附带。
	updateManifestPath = "/api/v1/gitview/updates/manifest"

	// 发布产物识别关键字：只有「版本名」或「安装包文件名」规范化后包含该关键字，
	// 才认为是 Git View 自身的更新。
	//
	// 已置空关闭：更新源已改为 GitView 专属接口，只会返回本应用的发布，
	// 不再需要与其它应用共用一个更新源时的误装防护；置空可避免因版本名 /
	// 文件名未包含 "gitview" 而把自家新版本误判为「已是最新」。
	// 如需重新启用，填回 "gitview" 即可。
	updateReleaseKeyword = ""

	// 环境变量：完整更新清单地址（优先级最高）。
	envUpdateManifestURL = "GITVIEW_UPDATE_MANIFEST_URL"
	// 环境变量：仅更新服务器域名，与 updateManifestPath 拼接。
	envUpdateBaseURL = "GITVIEW_UPDATE_BASE_URL"
	// 环境变量：当前运行版本号（覆盖 appVersion）。
	envAppVersion = "GITVIEW_APP_VERSION"
)

// updateManifestURL 可在构建期注入完整更新清单地址（优先级仅次于环境变量）：
//
//	-ldflags "-X main.updateManifestURL=https://example.com/api/v1/updates/manifest"
var updateManifestURL = ""

// UpdateCheckResult 是「检查更新」返回给前端的结果。
// 字段名 / JSON tag 与前端 SettingsPanel 的「关于」页保持一致。
type UpdateCheckResult struct {
	UpdateAvailable bool   `json:"updateAvailable"`
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	Name            string `json:"name"`
	Notes           string `json:"notes"`
	PublishedAt     string `json:"publishedAt"`
}

// logUpdate 把更新流程的关键事件追写到 %APPDATA%\GitView\update.log。
// 生产版以 -H windowsgui 运行，log.Printf 没有可见输出，升级出问题时
// （如安装器未拉起新版本）只能靠这份日志定位。失败时静默忽略。
func logUpdate(format string, args ...any) {
	line := time.Now().Format("2006-01-02 15:04:05") + " " + fmt.Sprintf(format, args...) + "\n"
	dir, err := os.UserConfigDir()
	if err != nil {
		return
	}
	dir = filepath.Join(dir, "GitView")
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	path := filepath.Join(dir, "update.log")
	_, statErr := os.Stat(path)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	// 新建文件时写 UTF-8 BOM，避免 PowerShell / 记事本按 ANSI（GBK）打开时中文乱码。
	if os.IsNotExist(statErr) {
		_, _ = f.WriteString("\ufeff")
	}
	_, _ = f.WriteString(line)
}

// startRestartWatchdog 在调用 updater.Restart 之前启动一个隐藏的后台助手：
// 等待约 30 秒后，如果 gitView 进程不存在（说明安装器没有把新版本拉起来，
// 或者 updater 根本没执行安装器），就启动当前 exe，保证升级后应用一定回来。
// 已有实例在运行时什么都不做，避免与安装器的自动拉起重复开两个窗口。
// 助手通过 cmd.exe 实现：ping 充当延时，tasklist 判断实例是否存在。
func startRestartWatchdog() {
	if runtime.GOOS != "windows" {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		logUpdate("重启守护：无法获取当前 exe 路径：%v", err)
		return
	}
	script := fmt.Sprintf(
		`ping -n 31 127.0.0.1 >nul & tasklist /fi "imagename eq gitView.exe" | find /i "gitView.exe" >nul || start "" "%s"`,
		exe,
	)
	cmd := exec.Command("cmd.exe", "/c", script)
	hideConsoleWindow(cmd)
	if err := cmd.Start(); err != nil {
		logUpdate("重启守护：启动失败：%v", err)
		return
	}
	logUpdate("重启守护：已安排 30 秒后兜底启动 %s", exe)
	// 不 Wait：助手需在当前进程退出后继续存活。
}

// UpdateService 提供应用自更新能力（基于 Wails v3 内置 updater）。
//
// 暴露给前端的方法：
//   - CheckForUpdates    仅检查是否有新版本（不下载、不安装）
//   - DownloadAndInstall 下载并安装上一轮检查发现的新版本
//   - Restart            重启并切换到新版本
//
// 设计原则：任何网络 / 配置失败都只返回 error 并展示给用户，
// 绝不影响应用的正常使用与启动（configure 失败仅记录日志）。
type UpdateService struct {
	mu sync.RWMutex
	u  *updater.Updater

	manifestURL    string // 更新清单端点（完整 URL）
	currentVersion string
	configured     bool // app.Updater 已注入
	initialized    bool // updater.Init 已执行（只能执行一次）
	initErr        error

	// lastRelease 是上一轮检查发现的新版本，下载前用它校验产物格式
	lastRelease *updater.Release

	// Windows 自定义安装：解包后暂存的产物（stagedInstaller 优先）及其临时目录。
	// 更新源只接受 zip / tar.gz / tgz，内置 updater 在 Windows 上无法解包，
	// 因此由应用自己下载、解包，再由 Restart 执行安装。
	stagedDir       string
	stagedInstaller string
	stagedAppExe    string
}

// NewUpdateService 构造更新服务；Updater 由 main 中的 configure 注入。
func NewUpdateService() *UpdateService {
	version := appVersion
	if v := strings.TrimSpace(os.Getenv(envAppVersion)); v != "" {
		version = v
	}
	return &UpdateService{
		manifestURL:    resolveManifestURL(),
		currentVersion: version,
	}
}

// resolveManifestURL 按优先级解析出更新清单地址：
// 环境变量(完整) > 构建期注入(完整) > 环境变量(域名) > 内置域名，后三者与
// updateManifestPath 拼接。
func resolveManifestURL() string {
	if v := strings.TrimSpace(os.Getenv(envUpdateManifestURL)); v != "" {
		return strings.TrimRight(v, "/")
	}
	if v := strings.TrimSpace(updateManifestURL); v != "" {
		return strings.TrimRight(v, "/")
	}
	base := updateBaseURL
	if v := strings.TrimSpace(os.Getenv(envUpdateBaseURL)); v != "" {
		base = v
	}
	return strings.TrimRight(base, "/") + updateManifestPath
}

// configure 由 main 在 app 创建后调用：注入 Updater 并完成初始化。
// 它是小写方法，不会被 Wails 绑定暴露给前端。
func (s *UpdateService) configure(u *updater.Updater) error {
	if u == nil {
		return errors.New("updater: 未提供 Updater 实例")
	}
	s.mu.Lock()
	s.u = u
	s.configured = true
	s.mu.Unlock()
	return s.initUpdater()
}

// initUpdater 用当前 manifestURL 初始化 Wails updater（仅一次）。
func (s *UpdateService) initUpdater() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.initialized {
		return s.initErr
	}
	s.initialized = true

	if s.u == nil {
		s.initErr = errors.New("更新服务未初始化")
		return s.initErr
	}
	if s.manifestURL == "" {
		s.initErr = errors.New("未配置更新源")
		return s.initErr
	}

	provider, err := endpoint.New(endpoint.Config{URL: s.manifestURL})
	if err != nil {
		s.initErr = err
		return err
	}
	if err := s.u.Init(updater.Config{
		CurrentVersion: s.currentVersion,
		Providers:      []updater.Provider{provider},
		// 使用应用自身的更新 UI（设置 - 关于），不弹框架自带的更新窗口。
		Window: updater.WindowNone,
	}); err != nil {
		s.initErr = err
		return err
	}
	return nil
}

// GetVersion 返回当前运行版本号。
func (s *UpdateService) GetVersion() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.currentVersion != "" {
		return s.currentVersion
	}
	if s.u != nil {
		return s.u.CurrentVersion()
	}
	return appVersion
}

// CheckForUpdates 手动 / 自动检查是否有新版本，不会下载。
func (s *UpdateService) CheckForUpdates() (UpdateCheckResult, error) {
	u, err := s.readyUpdater()
	if err != nil {
		return UpdateCheckResult{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rel, err := u.Check(ctx)
	if err != nil {
		logUpdate("检查更新失败：%v", err)
		return UpdateCheckResult{}, err
	}
	// 更新源返回的产物不属于本应用（同一更新服务承载多个应用）时，
	// 视为「已是最新」，避免误装其它应用。
	if rel != nil && !releaseBelongsToApp(rel) {
		log.Printf("[updater] 忽略不属于本应用的发布：version=%s name=%q filename=%q",
			rel.Version, rel.Name, rel.Artifact.Filename)
		logUpdate("忽略不属于本应用的发布：version=%s file=%q", rel.Version, rel.Artifact.Filename)
		rel = nil
	}
	if rel != nil {
		logUpdate("发现新版本 %s（当前 %s，产物 %q）", rel.Version, s.GetVersion(), rel.Artifact.Filename)
	}

	result := UpdateCheckResult{
		UpdateAvailable: rel != nil,
		CurrentVersion:  s.GetVersion(),
	}
	if rel != nil {
		result.LatestVersion = rel.Version
		result.Name = rel.Name
		result.Notes = rel.Notes
		if !rel.PublishedAt.IsZero() {
			result.PublishedAt = rel.PublishedAt.Format(time.RFC3339)
		}
	}

	s.mu.Lock()
	s.lastRelease = rel
	s.mu.Unlock()

	return result, nil
}

// DownloadAndInstall 下载上一轮 Check 发现的新版本并安装（staging）。
// 需先调用 CheckForUpdates 且结果为 UpdateAvailable=true。
func (s *UpdateService) DownloadAndInstall() error {
	u, err := s.readyUpdater()
	if err != nil {
		logUpdate("下载安装失败（updater 未就绪）：%v", err)
		return err
	}

	// Windows：更新源只接受 zip / tar.gz / tgz，而内置 updater 在 Windows 上
	// 只会直接执行产物（无法解包），因此压缩包产物由我们自己下载、解包、暂存，
	// 待用户点「重启并更新」时由 Restart 执行安装。
	if runtime.GOOS == "windows" {
		s.mu.RLock()
		rel := s.lastRelease
		s.mu.RUnlock()
		if rel != nil && isArchiveArtifact(rel.Artifact.Filename) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
			defer cancel()
			return s.stageWindowsArchive(ctx, rel)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	logUpdate("开始下载并安装更新（当前 %s）", s.GetVersion())
	if err := u.DownloadAndInstall(ctx); err != nil {
		logUpdate("下载安装失败：%v", err)
		return err
	}
	logUpdate("下载安装完成，等待用户点「重启并更新」")
	return nil
}

// isArchiveArtifact 判断产物是否为需要自解包的压缩包（Windows 更新源只接受这些格式）。
func isArchiveArtifact(name string) bool {
	n := strings.ToLower(name)
	return strings.HasSuffix(n, ".zip") ||
		strings.HasSuffix(n, ".tar.gz") ||
		strings.HasSuffix(n, ".tgz")
}

// stageWindowsArchive 下载并解包更新产物，暂存其中的安装包（优先）或应用 exe。
// wails 的 Release 不暴露产物下载地址，因此这里自己带 platform/arch/version
// 参数重新请求更新清单，并从 JSON 中解析出下载 URL。
func (s *UpdateService) stageWindowsArchive(ctx context.Context, rel *updater.Release) error {
	manifest := s.manifestURL
	if manifest == "" {
		return errors.New("未配置更新源")
	}

	q := url.Values{}
	q.Set("platform", "windows")
	q.Set("arch", runtime.GOARCH)
	q.Set("version", s.GetVersion())
	sep := "?"
	if strings.Contains(manifest, "?") {
		sep = "&"
	}
	manifestURL := manifest + sep + q.Encode()

	logUpdate("请求更新清单：%s", manifestURL)
	body, err := fetchBytes(ctx, manifestURL)
	if err != nil {
		logUpdate("请求更新清单失败：%v", err)
		return err
	}
	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		logUpdate("解析更新清单失败：%v", err)
		return err
	}
	artifactURL := findDownloadURL(doc)
	if artifactURL == "" {
		err := errors.New("更新清单中没有找到下载地址")
		logUpdate("%v（响应：%s）", err, truncate(string(body), 2000))
		return err
	}
	// 解析为绝对地址（兼容响应里的相对路径，如 "/api/v1/.../file.zip"）。
	if pu, perr := url.Parse(manifestURL); perr == nil {
		if ru, rerr := url.Parse(artifactURL); rerr == nil {
			artifactURL = pu.ResolveReference(ru).String()
		}
	}

	name := artifactFilename(rel, artifactURL)

	dir, err := os.MkdirTemp("", "gitview-update-")
	if err != nil {
		return err
	}
	localPath := filepath.Join(dir, name)

	logUpdate("开始下载更新包 %s（当前 %s）", name, s.GetVersion())
	if err := downloadFile(ctx, artifactURL, localPath); err != nil {
		logUpdate("下载更新包失败：%v", err)
		return err
	}

	exePath := localPath
	if isArchiveArtifact(name) {
		exePath, err = extractExeFromArchive(localPath, dir)
		if err != nil {
			logUpdate("解包更新包失败：%v", err)
			return err
		}
	}

	s.mu.Lock()
	s.stagedDir = dir
	if strings.Contains(strings.ToLower(filepath.Base(exePath)), "installer") || !isArchiveArtifact(name) {
		s.stagedInstaller = exePath
		s.stagedAppExe = ""
		logUpdate("已准备安装包：%s", exePath)
	} else {
		s.stagedAppExe = exePath
		s.stagedInstaller = ""
		logUpdate("已准备应用可执行文件：%s", exePath)
	}
	s.mu.Unlock()

	logUpdate("下载解包完成，等待用户点「重启并更新」")
	return nil
}

// artifactFilename 确定下载产物落盘时的文件名。优先用清单里的 filename；
// 缺失时从下载地址的 path 查询参数 / URL 路径推断（注意服务端下载地址形如
// /api/v1/gitview/updates/download?path=...zip，URL 路径本身没有扩展名）。
func artifactFilename(rel *updater.Release, rawURL string) string {
	if rel != nil {
		n := filepath.Base(strings.TrimSpace(rel.Artifact.Filename))
		if n != "" && n != "." && n != "/" && n != "\\" {
			return n
		}
	}
	if pu, err := url.Parse(rawURL); err == nil {
		if p := pu.Query().Get("path"); p != "" {
			if n := filepath.Base(p); n != "" && n != "." && n != "/" {
				return n
			}
		}
		if n := filepath.Base(pu.Path); n != "" && n != "." && n != "/" {
			if !isArchiveArtifact(n) && !strings.HasSuffix(strings.ToLower(n), ".exe") {
				n += ".zip"
			}
			return n
		}
	}
	return "artifact.zip"
}

// fetchBytes GET 一个 URL 并返回响应体。
func fetchBytes(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// urlKeys / containerKeys 用于从结构未知的清单 JSON 中定位下载地址。
var urlKeys = []string{
	"url", "download_url", "downloadUrl", "artifact_url", "artifactUrl",
	"file_url", "fileUrl", "href", "link", "download", "location", "target",
}

var containerKeys = []string{
	"artifact", "artifacts", "file", "files", "download", "downloads", "assets",
	"release", "data", "windows", "platforms", "amd64",
}

// findDownloadURL 递归查找清单中的下载地址：优先已知字段名，其次已知容器，
// 最后兜底扫描字符串（仅接受以归档/exe 扩展名结尾的值，允许相对路径）。
func findDownloadURL(v any) string {
	switch t := v.(type) {
	case map[string]any:
		for _, k := range urlKeys {
			if s, ok := t[k].(string); ok && looksLikeArtifactURL(s) {
				return s
			}
		}
		for _, k := range containerKeys {
			if child, ok := t[k]; ok {
				if s := findDownloadURL(child); s != "" {
					return s
				}
			}
		}
		for _, child := range t {
			if s := findDownloadURL(child); s != "" {
				return s
			}
		}
	case []any:
		for _, child := range t {
			if s := findDownloadURL(child); s != "" {
				return s
			}
		}
	case string:
		if looksLikeArtifactURL(t) {
			return t
		}
	}
	return ""
}

// looksLikeArtifactURL 判断字符串是否像一个更新产物地址（允许相对路径）。
func looksLikeArtifactURL(s string) bool {
	lower := strings.ToLower(strings.TrimSpace(s))
	if lower == "" {
		return false
	}
	return strings.HasSuffix(lower, ".zip") ||
		strings.HasSuffix(lower, ".tar.gz") ||
		strings.HasSuffix(lower, ".tgz") ||
		strings.HasSuffix(lower, ".exe")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// downloadFile 将 url 下载到本地文件。
func downloadFile(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载失败：HTTP %d", resp.StatusCode)
	}
	logUpdate("下载响应：HTTP %d，Content-Length=%d", resp.StatusCode, resp.ContentLength)
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	// 推送下载进度事件（前端「关于」页据此刷新进度条）。
	emitUpdaterEvent(evDownloadStarted, updateProgressEvent{Total: resp.ContentLength})
	pw := &progressWriter{
		w:     f,
		total: resp.ContentLength,
		last:  time.Now(),
	}
	n, err := io.Copy(pw, resp.Body)
	if err != nil {
		logUpdate("下载中断：已写入 %d 字节：%v", n, err)
		return err
	}
	emitUpdaterEvent(evDownloadProgress, updateProgressEvent{Written: n, Total: resp.ContentLength})
	logUpdate("下载完成：%d 字节", n)
	return nil
}

// progressWriter 在写文件的同时限流（200ms）推送下载进度，避免事件风暴。
type progressWriter struct {
	w       io.Writer
	written int64
	total   int64
	last    time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	p.written += int64(n)
	if time.Since(p.last) >= 200*time.Millisecond {
		emitUpdaterEvent(evDownloadProgress, updateProgressEvent{
			Written: p.written,
			Total:   p.total,
		})
		p.last = time.Now()
	}
	return n, err
}

// extractExeFromArchive 按扩展名解包 zip / tar.gz / tgz，并把其中的 .exe 写到 destDir。
func extractExeFromArchive(archivePath, destDir string) (string, error) {
	lower := strings.ToLower(archivePath)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return extractExeFromZip(archivePath, destDir)
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return extractExeFromTarGz(archivePath, destDir)
	}
	return "", fmt.Errorf("不支持的更新包格式：%s", filepath.Base(archivePath))
}

// extractExeFromZip 解出 zip 中的 .exe；含 "installer" 的优先。
// 只用 filepath.Base 落盘，避免压缩包内的路径穿越。
func extractExeFromZip(zipPath, destDir string) (string, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", err
	}
	defer zr.Close()

	best := ""
	for _, f := range zr.File {
		name := strings.ToLower(f.Name)
		if f.FileInfo().IsDir() || !strings.HasSuffix(name, ".exe") {
			continue
		}
		dst := filepath.Join(destDir, filepath.Base(f.Name))
		if err := writeZipEntry(f, dst); err != nil {
			return "", err
		}
		if best == "" || strings.Contains(name, "installer") {
			best = dst
		}
		if strings.Contains(name, "installer") {
			break
		}
	}
	if best == "" {
		return "", errors.New("更新包中没有找到 .exe 文件")
	}
	return best, nil
}

func writeZipEntry(f *zip.File, dst string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

// extractExeFromTarGz 解出 tar.gz / tgz 中的 .exe；含 "installer" 的优先。
func extractExeFromTarGz(archivePath, destDir string) (string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	best := ""
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		name := strings.ToLower(h.Name)
		if h.Typeflag != tar.TypeReg || !strings.HasSuffix(name, ".exe") {
			continue
		}
		dst := filepath.Join(destDir, filepath.Base(h.Name))
		out, err := os.Create(dst)
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(out, tr)
		out.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if best == "" {
			best = dst
		}
		if strings.Contains(name, "installer") {
			best = dst
			break
		}
	}
	if best == "" {
		return "", errors.New("更新包中没有找到 .exe 文件")
	}
	return best, nil
}

// Restart 完成重启并切换到新版本（安装完成后调用）。
func (s *UpdateService) Restart() error {
	u, err := s.readyUpdater()
	if err != nil {
		logUpdate("重启失败（updater 未就绪）：%v", err)
		return err
	}
	// 先安排兜底拉起，再执行安装/切换并退出。
	startRestartWatchdog()

	s.mu.RLock()
	installer, appExe := s.stagedInstaller, s.stagedAppExe
	s.mu.RUnlock()
	if runtime.GOOS == "windows" && (installer != "" || appExe != "") {
		return runWindowsStagedInstall(installer, appExe)
	}

	logUpdate("调用 Restart：执行安装器/切换到新版本，随后退出当前进程")
	if err := u.Restart(context.Background()); err != nil {
		logUpdate("Restart 返回错误：%v", err)
		return err
	}
	// 走到这里说明当前进程没有退出（版本行为差异），记录以便排查
	logUpdate("Restart 返回但进程仍在运行")
	return nil
}

// runWindowsStagedInstall 执行已解包的更新：优先静默运行 NSIS 安装包
//（保留卸载信息、快捷方式维护），没有安装包时退化为自我替换 exe。
// 启动后主动退出当前进程，由安装包 / 替换脚本负责把新版拉起来。
func runWindowsStagedInstall(installer, appExe string) error {
	if installer != "" {
		cmd := exec.Command(installer, "/S")
		hideConsoleWindow(cmd)
		cmd.Dir = filepath.Dir(installer)
		logUpdate("静默运行安装包：%s /S", installer)
		if err := cmd.Start(); err != nil {
			logUpdate("启动安装包失败：%v", err)
			return err
		}
		scheduleExit()
		return nil
	}
	if appExe != "" {
		if err := startSelfReplace(appExe); err != nil {
			logUpdate("启动自替换失败：%v", err)
			return err
		}
		scheduleExit()
		return nil
	}
	return errors.New("没有可安装的更新产物")
}

// scheduleExit 稍等片刻后退出当前进程（让安装包/脚本接管文件替换）。
func scheduleExit() {
	go func() {
		time.Sleep(800 * time.Millisecond)
		logUpdate("退出当前进程，等待新版启动")
		os.Exit(0)
	}()
}

// startSelfReplace 生成并启动一个隐藏批处理：等当前进程退出后，用新版 exe
// 覆盖安装目录中的 exe 并启动；★注意：机器级安装（Program Files）无写权限时
// 复制会失败，脚本会恢复旧文件并拉起它，不会把应用弄丢。
func startSelfReplace(newExe string) error {
	cur, err := os.Executable()
	if err != nil {
		return err
	}
	cur, err = filepath.Abs(cur)
	if err != nil {
		return err
	}
	bat := filepath.Join(filepath.Dir(newExe), "gitview-selfupdate.bat")
	script := "@echo off\r\n" +
		"setlocal enabledelayedexpansion\r\n" +
		"ping -n 4 127.0.0.1 >nul\r\n" +
		"set /a tries=0\r\n" +
		":retry\r\n" +
		"ping -n 2 127.0.0.1 >nul\r\n" +
		"ren \"" + cur + "\" \"" + cur + ".old\" >nul 2>&1\r\n" +
		"if exist \"" + cur + "\" (\r\n" +
		"  set /a tries+=1\r\n" +
		"  if !tries! lss 10 goto retry\r\n" +
		")\r\n" +
		"copy /y \"" + newExe + "\" \"" + cur + "\" >nul 2>&1\r\n" +
		"if not exist \"" + cur + "\" ren \"" + cur + ".old\" \"" + cur + "\" >nul 2>&1\r\n" +
		"start \"\" \"" + cur + "\"\r\n" +
		"del \"" + cur + ".old\" >nul 2>&1\r\n" +
		"del \"%~f0\" >nul 2>&1\r\n"
	if err := os.WriteFile(bat, []byte(script), 0o644); err != nil {
		return err
	}
	cmd := exec.Command("cmd.exe", "/c", bat)
	hideConsoleWindow(cmd)
	logUpdate("启动自替换脚本：%s", bat)
	return cmd.Start()
}

// readyUpdater 校验服务已配置并初始化，返回可用的 Updater。
func (s *UpdateService) readyUpdater() (*updater.Updater, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.configured || s.u == nil {
		return nil, errors.New("更新服务未初始化")
	}
	if s.manifestURL == "" {
		return nil, errors.New("未配置更新源")
	}
	if !s.initialized {
		return nil, errors.New("更新源尚未初始化")
	}
	if s.initErr != nil {
		return nil, s.initErr
	}
	return s.u, nil
}

// releaseBelongsToApp 判断发布产物是否属于本应用：规范化后（小写、去掉
// 空格 / 连字符 / 下划线 / 点）在版本名或安装包文件名中查找
// updateReleaseKeyword。关键字为空时不做过滤。
func releaseBelongsToApp(rel *updater.Release) bool {
	kw := normalizeToken(updateReleaseKeyword)
	if kw == "" {
		return true
	}
	hay := normalizeToken(rel.Name + " " + rel.Artifact.Filename)
	return strings.Contains(hay, kw)
}

// normalizeToken 将字符串规范化为便于关键字匹配的形式。
func normalizeToken(s string) string {
	s = strings.ToLower(s)
	return strings.NewReplacer(" ", "", "-", "", "_", "", ".", "").Replace(s)
}
