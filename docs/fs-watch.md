# 仓库变化监听（fsnotify）设计说明

前端刷新仓库状态是**事件驱动**的：后端用 fsnotify 监听活动仓库的 `.git`，变化时
通过 `repo:changed` 事件（`application.Event.Emit`）推给前端，前端按 `kind`
刷新对应数据。响应是即时的（去抖后约 300ms）。

除此之外**不做后台轮询**：git 命令只在下面几种情况下执行——

- 用户操作（暂存/提交/切换分支等）完成后由 `refreshAll()/refreshStatus()` 主动刷新；
- 收到 `repo:changed` 事件；
- 窗口重新可见（`visibilitychange`）时补一次 `all` 刷新，用来覆盖
  **工作区文件改动**（这类改动不触碰 `.git`，fsnotify 看不到）；
- 用户点工具栏的“刷新”按钮（`refreshAll()`）。

> 取舍：工作区里编辑文件不会自动刷新，需要切回窗口或手动刷新；换来的是
> 空闲时完全不跑 git 命令，调试窗口也不再持续刷屏。

## 监听范围（刻意保持很小）

`watcher.go: syncWatches()` 只监听下面这些路径（全部存在时才加，上限 48）：

- `.git`（目录级：`index`/`HEAD` 都是 lock + rename 写入，目录内容变化能覆盖）
- `.git/refs`、`.git/refs/heads`、`.git/refs/remotes`、`.git/refs/tags`
- `.git/HEAD`、`.git/packed-refs`、`.git/index`
- 中断标记：`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`rebase-merge`、`rebase-apply`
- 当前分支的 ref 文件（`HEAD` 里 `ref: refs/heads/x` → `.git/refs/heads/x`）
- 嵌套 ref 目录（`refs/heads/**` 深度 ≤2 取 16 个，`refs/remotes/**` 取 8 个）

**为什么不递归监听 `.git`**：fsnotify 在 macOS 用 kqueue（每个被监听对象占一个
文件描述符，GUI 应用默认 `ulimit -n` 常只有 256 左右），在 Linux 用 inotify
（受 `max_user_watches` / `max_user_instances` 限制）。递归监听 `refs/**`
在分支/标签多的仓库会直接耗尽配额并报 EMFILE/ENOSPC。因此改为"固定小集合 +
按需补挂有限个嵌套目录"。

## 事件抖动处理

- **忽略噪声**：`*.lock`、`.git/logs/*`（reflog）不参与分类。
- **忽略纯属性事件**：`fsnotify.Chmod`（不带 Write/Create/Remove/Rename）一律丢弃。
  macOS(kqueue) 下“读取文件更新 atime”“chmod/chown”都会上报 `NOTE_ATTRIB→Chmod`，
  而 `git status` 读 index 就会触发；它不代表内容变化，上报就会与自身命令自激。
- **忽略自身命令引发的事件**：本应用自己跑的 git 命令（`status`/`diff`/`commit`…）
  也会写 `.git`。`runGitCtxEnv` 会记录命令的起止时间，监听侧在“命令执行期间 +
  结束后的 800ms”内一律忽略事件（`ownGitActivity`）。每个操作结束后前端都会
  `refreshAll()`，所以屏蔽不会漏掉需要展示的变化，却能彻底断开
  “自身命令 → 事件 → 刷新 → 自身命令”的闭环。
  内置终端（`RunCommand`）不算自身命令：终端里执行 `git commit` 等仍会正常触发刷新。
- **尾部去抖**：每个事件重置 300ms 定时器，一次 `commit`/`checkout` 引发的一串
  写入（index、refs、HEAD）合并成一次推送。
- **最长等待 1.2s**：持续抖动时不能被尾部去抖“饿死”（否则突发期间一次都不推），
  超过 1.2s 先推一次。
- **最小间隔节流**：两次推送之间至少间隔 700ms，超过则顺延合并。
- **风暴保护**：6s 窗口内推送超过 4 次时，间隔自动放大到 3s，避免外部工具狂写
  仓库时 UI/git 进程持续高频运转。（实测：6s 持续狂写 → 4 次推送）

### 调试溯源

每次推送都会在调试窗口写入一条 `repo:changed kind=…` 记录，并在展开输出里列出
**触发路径 + fsnotify 操作**（如 `index [WRITE]`、`refs/heads/main [WRITE]`）以及本次被
忽略的噪声事件数；监听启动/停止/失败也会各记一条（`监听已启动 | 监听路径：7（fsnotify）`）。
这既是排查“为什么在刷新”的依据，也能用来确认当前跑的确实是新构建（没看到启动那条
说明应用需要重启）。

### 关键：绝不能让自己轮询的 git 命令写 index（曾经的自激循环）

`git status` / `git diff` 默认会“顺手”刷新 index 里的 stat 缓存，即**重写 `.git/index`**；
而我们把 `.git` 列为监听目标，于是形成闭环：

```
外部改动 → 前端 status → git 写 .git/index → 监听事件 → 推送 repo:changed
        → 前端 refreshStatus → 又写 index → ……（节奏被 700ms 最小间隔锁死）
```

实测印证：同一环境下普通 `git status` 会改写 `index`（mtime 变化），
带 `GIT_OPTIONAL_LOCKS=0` 则不写。因此：

- 所有“只看”的命令（`Status`、`WorktreeDiff`、未跟踪文件 diff 探测）都走
  `runGitRO()`（即 `GIT_OPTIONAL_LOCKS=0`），不再产生 index 写入；
- 前端 `refreshStatus()` 做并发合并（在途时只记一个尾随标记），防止刷新堆叠。

即便不写 index，`git status` **读取** index 仍会在 macOS 上产生 `index [CHMOD]`
属性事件，所以监听侧另外把纯 `Chmod` 事件丢弃（见上“忽略纯属性事件”），
再加上“忽略自身命令引发的事件”（安静窗口）作为兜底：三层防护共同保证
**自身命令永远不会触发刷新**。

需要提醒的是：如果**外部**进程（例如 `wails dev`/`vite` 重建被跟踪的产物、日志文件持续写入）
真的在持续修改仓库，事件推送本身就是正确的（仓库确实在变），此时由风暴保护把频率
封在 3s 一次。

## 分类与前端行为

`kind` 取值与前端动作（`App.vue: applyRepoChange`）：

| kind     | 含义                                  | 前端刷新                                                 |
| -------- | ------------------------------------- | -------------------------------------------------------- |
| `status` | index / 中断标记（`.git` 目录级变化） | `refreshStatus()`                                        |
| `refs`   | `refs/**`、`HEAD`、`packed-refs`      | `refreshStatus()` + `refreshRefs()` + `refreshStashes()` |
| `all`    | 同一去抖窗口内两者都有                | 同上（超集）                                             |

窗口不可见、有操作执行中（`ui.busy`）、弹窗打开时不处理事件，回到前台时由
`visibilitychange` 统一补一次 `all` 刷新。

## 生命周期

- 打开/切换仓库：`repo.attach()` → `GitService.WatchRepo(path)`（已监听同一路径则复用）。
- 关闭仓库或应用退出：`GitService.UnwatchRepo()`。
- 调试窗口显示监听状态（`监听中 · N`），失败时显示红色"监听失败"并在悬停提示里给出原因。

## 已验证（临时测试，跑完即删）

- 分类函数：`.lock`/reflog → 忽略，`refs/**`、`HEAD`、`packed-refs` → `refs`，
  `index`/`MERGE_HEAD`/`rebase-merge`/`.git` → `status`。
- 端到端：`WatchRepo` 后修改文件并 `git add/commit`，收到 `kind=all` 事件；
  一次突变只推送 1 次（去抖 + 节流生效）；`UnwatchRepo` 后 `watching=false`。
- 写入行为：`Status()` 不再改写 `.git/index`（普通 `git status` 会），
  持续 6s 高频写入只推送 4 次（最长等待 + 风暴保护生效）。
- 溯源：启动日志与推送触发路径（如 `index [WRITE|CHMOD]`）均写入调试日志。
- macOS 上路径数为 7（存在才监听），远低于配额上限。

## 已知取舍

- 工作区文件改动不触碰 `.git`，fsnotify 看不到；已取消后台轮询，改为在窗口重新
  可见（`visibilitychange`）或手动点“刷新”时补刷。
- macOS(kqueue) 下目录级监听只报告"条目增删改"，**已存在 ref 文件的内容改写**
  不一定上报；因此额外单独监听"当前分支的 ref 文件"，切分支时会随 `HEAD` 事件重新对齐。
- Windows(ReadDirectoryChangesW) 缓冲区溢出会丢事件（fsnotify 通过 `Errors`
  通道上报，代码中忽略该错误），由窗口可见/手动刷新补上。
- 监听启动失败只在调试窗口显示"监听失败"并给出原因。
