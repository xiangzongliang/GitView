package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// RepoService manages the set of repositories known to the app and persists
// them in a JSON config file under the user's config directory.
type RepoService struct {
	mu sync.Mutex
}

type appConfig struct {
	Repos       []RepoEntry  `json:"repos"`
	Groups      []GroupInfo  `json:"groups,omitempty"`
	AiProviders []AiProvider `json:"aiProviders,omitempty"`
	// CommitPrefixes 按仓库路径保存「AI 生成提交信息」使用的前缀
	// （如 "feat: " / "AI："）。只存非空值，key 为仓库根目录路径。
	CommitPrefixes map[string]string `json:"commitPrefixes,omitempty"`
}

func configFilePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "GitView")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func (s *RepoService) load() (*appConfig, error) {
	p, err := configFilePath()
	if err != nil {
		return &appConfig{}, nil // config unavailable: run without persistence
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return &appConfig{}, nil
		}
		return nil, err
	}
	cfg := &appConfig{}
	if err := json.Unmarshal(data, cfg); err != nil {
		return &appConfig{}, nil // corrupted config: start fresh
	}
	return cfg, nil
}

func (s *RepoService) save(cfg *appConfig) error {
	p, err := configFilePath()
	if err != nil {
		return nil
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

// ListRepos returns all registered repositories in stored order.
// The order is user-managed (drag & drop) and persisted via SaveLayout.
func (s *RepoService) ListRepos() ([]RepoEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return nil, err
	}
	for i := range cfg.Repos {
		_, statErr := os.Stat(cfg.Repos[i].Path)
		cfg.Repos[i].Missing = statErr != nil
	}
	return cfg.Repos, nil
}

// ListGroups returns persisted groups in display order (empty groups included).
func (s *RepoService) ListGroups() ([]GroupInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return nil, err
	}
	if cfg.Groups == nil {
		return []GroupInfo{}, nil
	}
	return cfg.Groups, nil
}

// SaveLayout persists the repository order/group assignments and the group
// list (order + collapsed state) exactly as provided by the frontend.
func (s *RepoService) SaveLayout(entries []RepoEntry, groups []GroupInfo) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return err
	}
	// Keep LastOpened/Missing from the stored config; take order+group from input.
	stored := make(map[string]RepoEntry, len(cfg.Repos))
	for _, r := range cfg.Repos {
		stored[r.Path] = r
	}
	out := make([]RepoEntry, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, e := range entries {
		prev, ok := stored[e.Path]
		if !ok {
			continue // unknown path: ignore
		}
		prev.Group = e.Group
		_, statErr := os.Stat(prev.Path)
		prev.Missing = statErr != nil
		out = append(out, prev)
		seen[e.Path] = true
	}
	// Append any stored repo missing from the input (safety net).
	for _, r := range cfg.Repos {
		if !seen[r.Path] {
			out = append(out, r)
		}
	}
	cfg.Repos = out
	// Group list: dedupe, drop the ungrouped placeholder ("").
	cleaned := make([]GroupInfo, 0, len(groups))
	seenGroup := make(map[string]bool, len(groups))
	for _, g := range groups {
		if g.Name == "" || seenGroup[g.Name] {
			continue
		}
		seenGroup[g.Name] = true
		cleaned = append(cleaned, g)
	}
	cfg.Groups = cleaned
	return s.save(cfg)
}

// OpenRepo validates a path, resolves it to the repository root and registers it.
func (s *RepoService) OpenRepo(path string) (*RepoEntry, error) {
	path = expandHome(strings.TrimSpace(path))
	if path == "" {
		return nil, errors.New("路径不能为空")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return nil, errors.New("目录不存在: " + abs)
	}
	top, err := repoToplevel(abs)
	if err != nil {
		return nil, errors.New("不是有效的 Git 仓库: " + abs)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return nil, err
	}
	entry := RepoEntry{Path: top, Name: filepath.Base(top), LastOpened: time.Now().Unix()}
	found := false
	for i := range cfg.Repos {
		if cfg.Repos[i].Path == top {
			cfg.Repos[i].LastOpened = entry.LastOpened
			cfg.Repos[i].Missing = false
			cfg.Repos[i].Name = entry.Name
			found = true
			break
		}
	}
	if !found {
		cfg.Repos = append(cfg.Repos, entry)
	}
	if err := s.save(cfg); err != nil {
		return nil, err
	}
	res := entry
	if found {
		for i := range cfg.Repos {
			if cfg.Repos[i].Path == top {
				res = cfg.Repos[i]
				break
			}
		}
	}
	return &res, nil
}

// RemoveRepo unregisters a repository (files on disk are untouched).
func (s *RepoService) RemoveRepo(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return err
	}
	repos := make([]RepoEntry, 0, len(cfg.Repos))
	for _, r := range cfg.Repos {
		if r.Path != path {
			repos = append(repos, r)
		}
	}
	cfg.Repos = repos
	return s.save(cfg)
}

// injectCredentials embeds username/password into an https URL so git can
// authenticate without an interactive prompt.
func injectCredentials(rawURL, username, password string) string {
	if username == "" && password == "" {
		return rawURL
	}
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return rawURL
	}
	schemeEnd := strings.Index(rawURL, "://")
	rest := rawURL[schemeEnd+3:]
	// Strip any existing userinfo.
	if at := strings.Index(rest, "@"); at >= 0 {
		if slash := strings.Index(rest, "/"); slash < 0 || at < slash {
			rest = rest[at+1:]
		}
	}
	user := urlQueryEscape(username)
	if password != "" {
		user += ":" + urlQueryEscape(password)
	}
	return rawURL[:schemeEnd+3] + user + "@" + rest
}

func urlQueryEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// RemoteBranches lists the heads of a remote repository without cloning it.
// It is used by the clone dialog to offer a branch picker.
func (s *RepoService) RemoteBranches(url, username, password string) ([]string, error) {
	url = strings.TrimSpace(url)
	if url == "" {
		return nil, errors.New("仓库地址不能为空")
	}
	target := injectCredentials(url, strings.TrimSpace(username), password)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := runGitCtx(ctx, "", "ls-remote", "--symref", "--heads", target)
	if err != nil {
		return nil, err
	}
	var branches []string
	headRef := ""
	for _, line := range splitLines(out) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[0] == "ref:" && len(fields) >= 3 {
			headRef = strings.TrimPrefix(fields[2], "refs/heads/")
			continue
		}
		if strings.HasPrefix(fields[1], "refs/heads/") {
			branches = append(branches, strings.TrimPrefix(fields[1], "refs/heads/"))
		}
	}
	// Put the remote HEAD branch first.
	if headRef != "" {
		sort.SliceStable(branches, func(i, j int) bool {
			return branches[i] == headRef
		})
	}
	return branches, nil
}

// Clone clones a remote repository and registers it.
func (s *RepoService) Clone(opts CloneOptions) (*RepoEntry, error) {
	url := strings.TrimSpace(opts.URL)
	if url == "" {
		return nil, errors.New("仓库地址不能为空")
	}
	url = injectCredentials(url, strings.TrimSpace(opts.Username), opts.Password)
	name := strings.TrimSpace(opts.Name)
	if name == "" {
		name = nameFromURL(url)
	}
	parent := expandHome(strings.TrimSpace(opts.Parent))
	if parent == "" {
		home, _ := os.UserHomeDir()
		parent = home
	}
	target := filepath.Join(parent, name)
	if entries, err := os.ReadDir(target); err == nil && len(entries) > 0 {
		return nil, errors.New("目标目录非空: " + target)
	}

	args := []string{"clone", "--progress"}
	if strings.TrimSpace(opts.Branch) != "" {
		args = append(args, "-b", strings.TrimSpace(opts.Branch))
	}
	args = append(args, "--", url, target)
	if _, err := runGitNetworkStream("", emitCloneProgress, args...); err != nil {
		return nil, err
	}
	return s.OpenRepo(target)
}

// cloneProgressEvent：克隆过程中把 git 的进度/日志实时推送给前端。
const cloneProgressEvent = "clone:progress"

// CloneProgressEvent 是 clone:progress 的负载：Output 为 git stderr 的原始
// 片段（git 的进度输出带 \r 回车覆盖语义），由前端按行渲染。
type CloneProgressEvent struct {
	Output string `json:"output"`
}

func emitCloneProgress(chunk string) {
	if app := application.Get(); app != nil && app.Event != nil {
		app.Event.Emit(cloneProgressEvent, CloneProgressEvent{Output: redactSecrets(chunk)})
	}
}

// Init creates a new git repository in dir and registers it.
func (s *RepoService) Init(dir string) (*RepoEntry, error) {
	dir = expandHome(strings.TrimSpace(dir))
	if dir == "" {
		return nil, errors.New("路径不能为空")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if _, err := runGit("", "init", dir); err != nil {
		return nil, err
	}
	return s.OpenRepo(dir)
}

// RevealInFinder opens the repository directory in the OS file manager.
func (s *RepoService) RevealInFinder(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("explorer", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	return cmd.Start()
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

func nameFromURL(url string) string {
	u := strings.TrimSuffix(url, "/")
	if i := strings.LastIndexAny(u, "/:"); i >= 0 {
		u = u[i+1:]
	}
	return strings.TrimSuffix(u, ".git")
}

// ListAiProviders returns the AI model service configurations stored in the
// app config file, in stored order.
func (s *RepoService) ListAiProviders() ([]AiProvider, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return nil, err
	}
	if cfg.AiProviders == nil {
		return []AiProvider{}, nil
	}
	return cfg.AiProviders, nil
}

// SaveAiProviders replaces the stored AI model service configurations with
// the provided list (saved exactly as given by the frontend).
func (s *RepoService) SaveAiProviders(providers []AiProvider) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return err
	}
	if providers == nil {
		providers = []AiProvider{}
	}
	cfg.AiProviders = providers
	return s.save(cfg)
}

// GetAiCommitPrefix returns the AI commit-message prefix saved for a repo.
// nil 表示该项目从未配置过（前端据此使用默认前缀）；
// 非 nil 的空字符串表示用户显式选择了「不加前缀」。
func (s *RepoService) GetAiCommitPrefix(repoPath string) (*string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return nil, err
	}
	if v, ok := cfg.CommitPrefixes[repoPath]; ok {
		return &v, nil
	}
	return nil, nil
}

// SetAiCommitPrefix saves the AI commit-message prefix for a repo.
// An empty prefix removes the entry (so the config stays free of empty keys).
func (s *RepoService) SetAiCommitPrefix(repoPath string, prefix string) error {
	if strings.TrimSpace(repoPath) == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.load()
	if err != nil {
		return err
	}
	if prefix == "" {
		// delete on a nil map is a no-op, so no nil check is needed here.
		delete(cfg.CommitPrefixes, repoPath)
	} else {
		if cfg.CommitPrefixes == nil {
			cfg.CommitPrefixes = map[string]string{}
		}
		cfg.CommitPrefixes[repoPath] = prefix
	}
	return s.save(cfg)
}
