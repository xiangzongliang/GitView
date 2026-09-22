package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// RepoService manages the set of repositories known to the app and persists
// them in a JSON config file under the user's config directory.
type RepoService struct {
	mu sync.Mutex
}

type appConfig struct {
	Repos []RepoEntry `json:"repos"`
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

// ListRepos returns all registered repositories, most recently opened first.
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
	sort.Slice(cfg.Repos, func(i, j int) bool {
		return cfg.Repos[i].LastOpened > cfg.Repos[j].LastOpened
	})
	return cfg.Repos, nil
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
	return &entry, nil
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

// Clone clones a remote repository and registers it.
func (s *RepoService) Clone(opts CloneOptions) (*RepoEntry, error) {
	url := strings.TrimSpace(opts.URL)
	if url == "" {
		return nil, errors.New("仓库地址不能为空")
	}
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
	if _, err := runGitNetwork("", args...); err != nil {
		return nil, err
	}
	return s.OpenRepo(target)
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
