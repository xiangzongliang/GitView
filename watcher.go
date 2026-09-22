package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// 仓库变化监听（fsnotify）：只是为了把“外部改动”尽快推给前端，
// 不追求 100% 覆盖 —— 前端仍保留一个低频兜底轮询。
//
// 设计约束（见 docs/fs-watch.md）：
//   - 只监听固定的小集合（.git 目录、refs 常用目录、少数关键文件），
//     避免在 macOS(kqueue) 上耗尽文件描述符、在 Linux 上耗尽 inotify watch。
//   - 事件抖动：*.lock、reflog 一律忽略；事件先做尾部去抖（debounce），
//     再受最小间隔节流（minGap），避免 commit/checkout 一类操作引发连环刷新。
//   - 自身命令触发的事件不做屏蔽：`git status` 只在工作区确实变化时才重写
//     index，配合最小间隔即可自终止，屏蔽反而会漏掉外部改动。
const (
	repoChangedEvent = "repo:changed"

	watchMaxPaths = 48
	watchDebounce = 300 * time.Millisecond
	watchMinGap   = 700 * time.Millisecond

	// 风暴保护：短时间内推送过于频繁（例如外部工具在狂写仓库）时，
	// 自动放大最小间隔，避免 UI 与 git 进程持续高频运转。
	watchStormWindow = 6 * time.Second
	watchStormLimit  = 4
	watchStormGap    = 3 * time.Second

	// 最长等待：持续抖动时不能被尾部去抖“饿死”（否则突发期间一次都不推）
	watchMaxWait = 1200 * time.Millisecond
)

// WatchStatus describes the current watcher state (shown in the debug window).
type WatchStatus struct {
	Watching bool   `json:"watching"`
	RepoPath string `json:"repoPath"`
	Paths    int    `json:"paths"`
	Error    string `json:"error"`
	LastPush int64  `json:"lastPush"` // unix 毫秒
}

// RepoChange is the payload of the "repo:changed" event.
type RepoChange struct {
	RepoPath string `json:"repoPath"`
	/** "status"（工作区/index）| "refs"（分支/标签/stash）| "all" */
	Kind string `json:"kind"`
}

type repoWatcher struct {
	mu      sync.Mutex
	path    string
	gitDir  string
	watcher *fsnotify.Watcher
	watched map[string]bool

	// 去抖 + 节流状态
	timer        *time.Timer
	pending      map[string]bool // 待上报的变更类型
	pendingPaths map[string]bool // 触发本次推送的路径（用于调试溯源，限额 8）
	pendingSince time.Time
	ignored      int // 本次窗口内被忽略的噪声事件数
	lastPush     time.Time
	lastPushMs   int64
	pushTimes    []time.Time // 用于风暴保护
	err          string
	stopped      bool
}

var activeWatcher *repoWatcher
var watcherMu sync.Mutex

// WatchRepo starts watching repoPath and pushes "repo:changed" events on
// changes. Watching an already-watched path is a no-op.
func (s *GitService) WatchRepo(repoPath string) *WatchStatus {
	watcherMu.Lock()
	defer watcherMu.Unlock()
	if repoPath == "" {
		return currentWatchStatus()
	}
	if activeWatcher != nil && activeWatcher.path == repoPath && !activeWatcher.dead() {
		return currentWatchStatus()
	}
	stopWatcherLocked()
	w := &repoWatcher{
		path:         repoPath,
		watched:      map[string]bool{},
		pending:      map[string]bool{},
		pendingPaths: map[string]bool{},
	}
	activeWatcher = w
	if err := w.start(); err != nil {
		// 监听不可用（例如 macOS 文件描述符耗尽）：记录错误，前端继续用兜底轮询
		w.err = err.Error()
		logWatchEvent("监听启动失败（已退回定时轮询）", err.Error(), false)
	}
	return currentWatchStatus()
}

// UnwatchRepo stops watching the current repository.
func (s *GitService) UnwatchRepo() {
	watcherMu.Lock()
	defer watcherMu.Unlock()
	stopWatcherLocked()
}

// WatchStatus returns the current watcher state.
func (s *GitService) WatchStatus() *WatchStatus {
	watcherMu.Lock()
	defer watcherMu.Unlock()
	return currentWatchStatus()
}

func stopWatcherLocked() {
	if activeWatcher == nil {
		return
	}
	activeWatcher.stop()
	activeWatcher = nil
}

func currentWatchStatus() *WatchStatus {
	w := activeWatcher
	if w == nil {
		return &WatchStatus{}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return &WatchStatus{
		Watching: w.watcher != nil && !w.stopped,
		RepoPath: w.path,
		Paths:    len(w.watched),
		Error:    w.err,
		LastPush: w.lastPushMs,
	}
}

func (w *repoWatcher) dead() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stopped
}

func (w *repoWatcher) start() error {
	gd, err := gitDir(w.path)
	if err != nil || gd == "" {
		return err
	}
	ew, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.gitDir = gd
	w.watcher = ew
	w.mu.Unlock()

	w.syncWatches()
	logWatchEvent("监听已启动", fmt.Sprintf("仓库：%s\n监听路径：%d（fsnotify）", w.path, len(w.watched)), true)
	go w.loop()
	return nil
}

func (w *repoWatcher) stop() {
	w.mu.Lock()
	w.stopped = true
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	ew := w.watcher
	w.watcher = nil
	w.mu.Unlock()
	if ew != nil {
		_ = ew.Close()
		logWatchEvent("监听已停止", w.path, true)
	}
}

// loop consumes fsnotify events until the watcher is closed.
func (w *repoWatcher) loop() {
	for {
		w.mu.Lock()
		ew := w.watcher
		stopped := w.stopped
		w.mu.Unlock()
		if stopped || ew == nil {
			return
		}
		select {
		case ev, ok := <-ew.Events:
			if !ok {
				return
			}
			w.handle(ev)
		case _, ok := <-ew.Errors:
			if !ok {
				return
			}
			// 单个事件错误（例如缓冲区溢出）不致命：交给兜底轮询
		}
	}
}

func (w *repoWatcher) handle(ev fsnotify.Event) {
	kind := w.classify(ev.Name)
	if kind == "" {
		// .lock / reflog 等噪声：只计数，不触发刷新
		w.mu.Lock()
		if !w.stopped {
			w.ignored++
		}
		w.mu.Unlock()
		return
	}
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	w.pending[kind] = true
	if rel, err := filepath.Rel(w.gitDir, ev.Name); err == nil {
		if len(w.pendingPaths) < 8 {
			w.pendingPaths[filepath.ToSlash(rel)+(" ["+ev.Op.String()+"]")] = true
		}
	}
	now := time.Now()
	if w.pendingSince.IsZero() {
		w.pendingSince = now
	}
	if w.timer != nil {
		w.timer.Stop()
	}
	// 尾部去抖，但持续抖动时最多等 watchMaxWait 就先推一次
	delay := watchDebounce
	if elapsed := now.Sub(w.pendingSince); elapsed+delay > watchMaxWait {
		delay = watchMaxWait - elapsed
		if delay < 0 {
			delay = 0
		}
	}
	w.timer = time.AfterFunc(delay, w.flush)
	w.mu.Unlock()

	// 目录增删可能带来新的 ref 目录 / 出现或消失的 MERGE_HEAD 等，
	// 重新对齐监听集合（有上限，见 syncWatches）。
	if ev.Op&(fsnotify.Create|fsnotify.Remove|fsnotify.Rename) != 0 {
		w.syncWatches()
	}
}

// classify maps a changed path to a refresh kind ("" = ignore).
func (w *repoWatcher) classify(p string) string {
	if strings.HasSuffix(p, ".lock") {
		return ""
	}
	gd := w.gitDir
	rel, err := filepath.Rel(gd, p)
	if err != nil {
		return "status"
	}
	rel = filepath.ToSlash(rel)
	switch {
	case rel == ".":
		// .git 目录自身变化：多为 index/HEAD 的 lock+rename
		return "status"
	case strings.HasPrefix(rel, "refs/"):
		return "refs"
	case rel == "HEAD" || rel == "packed-refs":
		return "refs"
	case strings.HasPrefix(rel, "logs/"):
		return "" // reflog 噪声
	default:
		return "status"
	}
}

// flush pushes the accumulated change kinds, honouring the minimum gap
// (and a wider gap when pushes come in a storm).
func (w *repoWatcher) flush() {
	w.mu.Lock()
	if w.stopped || len(w.pending) == 0 {
		w.mu.Unlock()
		return
	}

	// 风暴保护：统计窗口内的推送次数，过多则放大间隔
	now := time.Now()
	kept := w.pushTimes[:0]
	for _, ts := range w.pushTimes {
		if now.Sub(ts) < watchStormWindow {
			kept = append(kept, ts)
		}
	}
	w.pushTimes = kept
	gap := watchMinGap
	if len(w.pushTimes) >= watchStormLimit {
		gap = watchStormGap
	}

	waited := now.Sub(w.lastPush)
	if waited < gap {
		// 距上次推送太近：稍后合并上报，避免连环刷新
		if w.timer != nil {
			w.timer.Stop()
		}
		w.timer = time.AfterFunc(gap-waited, w.flush)
		w.mu.Unlock()
		return
	}
	kinds := w.pending
	w.pending = map[string]bool{}
	paths := make([]string, 0, len(w.pendingPaths))
	for p := range w.pendingPaths {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	w.pendingPaths = map[string]bool{}
	ignored := w.ignored
	w.ignored = 0
	w.pendingSince = time.Time{}
	w.lastPush = now
	w.lastPushMs = now.UnixMilli()
	w.pushTimes = append(w.pushTimes, now)
	repoPath := w.path
	w.mu.Unlock()

	kind := "status"
	if kinds["refs"] && kinds["status"] {
		kind = "all"
	} else if kinds["refs"] {
		kind = "refs"
	}
	logWatchPush(kind, paths, ignored)
	emitRepoChange(RepoChange{RepoPath: repoPath, Kind: kind})
}

// logWatchPush records why a refresh was pushed (visible in the debug window).
// 触发路径直接内联在命令行里，不用展开就能看出是谁触发的。
func logWatchPush(kind string, paths []string, ignored int) {
	trigger := ""
	if len(paths) > 0 {
		trigger = "  ← " + paths[0]
		if len(paths) > 1 {
			trigger += fmt.Sprintf(" 等 %d 处", len(paths))
		}
	}
	out := "触发路径：" + strings.Join(paths, "\n")
	if ignored > 0 {
		out += fmt.Sprintf("\n（已忽略噪声事件 %d 个：.lock / reflog 等）", ignored)
	}
	logWatchEvent("repo:changed  kind="+kind+trigger, out, true)
}

// logWatchEvent writes a watcher lifecycle/trigger entry into the debug log.
func logWatchEvent(title, detail string, ok bool) {
	recordCommand(GitLogEntry{
		Time:    nowMillis(),
		Kind:    "watch",
		Command: title,
		Output:  detail,
		OK:      ok,
	})
}

// emitRepoChange pushes a repo change to the frontend. Replaced in tests.
var emitRepoChange = func(change RepoChange) {
	if app := application.Get(); app != nil && app.Event != nil {
		app.Event.Emit(repoChangedEvent, change)
	}
}

// syncWatches aligns the watched path set with the repository layout.
// 只保留存在的小集合；嵌套 ref 目录有限额，防止在分支极多的仓库里失控。
func (w *repoWatcher) syncWatches() {
	w.mu.Lock()
	ew := w.watcher
	gd := w.gitDir
	stopped := w.stopped
	watched := w.watched
	w.mu.Unlock()
	if ew == nil || stopped || gd == "" {
		return
	}

	desired := map[string]bool{}
	add := func(p string) {
		if len(desired) >= watchMaxPaths || p == "" {
			return
		}
		if _, err := os.Stat(p); err != nil {
			return
		}
		desired[p] = true
	}

	add(gd) // .git 目录：index/HEAD 等通过 lock+rename 写入
	add(filepath.Join(gd, "refs"))
	add(filepath.Join(gd, "refs", "heads"))
	add(filepath.Join(gd, "refs", "remotes"))
	add(filepath.Join(gd, "refs", "tags"))
	add(filepath.Join(gd, "HEAD"))
	add(filepath.Join(gd, "packed-refs"))
	add(filepath.Join(gd, "index"))
	add(filepath.Join(gd, "MERGE_HEAD"))
	add(filepath.Join(gd, "CHERRY_PICK_HEAD"))
	add(filepath.Join(gd, "REVERT_HEAD"))
	add(filepath.Join(gd, "rebase-merge")) // 目录存在即 rebase 进行中
	add(filepath.Join(gd, "rebase-apply"))
	// 当前分支的 ref 文件：kqueue 下“目录内容变化”之外的改写不一定上报
	add(currentRefFile(gd))
	// 嵌套 ref 目录（如 refs/heads/feature/xxx）：inotify 不递归，需要显式监听
	for _, p := range nestedRefDirs(filepath.Join(gd, "refs", "heads"), 16) {
		add(p)
	}
	for _, p := range nestedRefDirs(filepath.Join(gd, "refs", "remotes"), 8) {
		add(p)
	}

	// 新增
	for p := range desired {
		if !watched[p] {
			if err := ew.Add(p); err == nil {
				watched[p] = true
			}
		}
	}
	// 移除已不需要的（路径消失或超出限额）
	for p := range watched {
		if !desired[p] {
			_ = ew.Remove(p)
			delete(watched, p)
		}
	}
}

// currentRefFile returns .git/<ref> for the branch referenced by HEAD
// ("" for detached HEAD). Pure file reads: no git process.
func currentRefFile(gitDirPath string) string {
	if gitDirPath == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(gitDirPath, "HEAD"))
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(b))
	ref, ok := strings.CutPrefix(line, "ref:")
	if !ok {
		return ""
	}
	ref = strings.TrimSpace(ref)
	if ref == "" || strings.Contains(ref, "..") {
		return ""
	}
	return filepath.Join(gitDirPath, filepath.FromSlash(ref))
}

// nestedRefDirs lists sub-directories (depth <= 2) under refDir, capped at max.
func nestedRefDirs(refDir string, max int) []string {
	entries, err := os.ReadDir(refDir)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, e := range entries {
		if !e.IsDir() || len(out) >= max {
			continue
		}
		child := filepath.Join(refDir, e.Name())
		out = append(out, child)
		subs, err := os.ReadDir(child)
		if err != nil {
			continue
		}
		for _, s := range subs {
			if !s.IsDir() || len(out) >= max {
				continue
			}
			out = append(out, filepath.Join(child, s.Name()))
		}
	}
	return out
}
