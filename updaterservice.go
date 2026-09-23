package main

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/endpoint"
)

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
		return UpdateCheckResult{}, err
	}
	// 更新源返回的产物不属于本应用（同一更新服务承载多个应用）时，
	// 视为「已是最新」，避免误装其它应用。
	if rel != nil && !releaseBelongsToApp(rel) {
		log.Printf("[updater] 忽略不属于本应用的发布：version=%s name=%q filename=%q",
			rel.Version, rel.Name, rel.Artifact.Filename)
		rel = nil
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
	return result, nil
}

// DownloadAndInstall 下载上一轮 Check 发现的新版本并安装（staging）。
// 需先调用 CheckForUpdates 且结果为 UpdateAvailable=true。
func (s *UpdateService) DownloadAndInstall() error {
	u, err := s.readyUpdater()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	return u.DownloadAndInstall(ctx)
}

// Restart 完成重启并切换到新版本（安装完成后调用）。
func (s *UpdateService) Restart() error {
	u, err := s.readyUpdater()
	if err != nil {
		return err
	}
	return u.Restart(context.Background())
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
