import { defineStore } from "pinia";
import { GitService, errMsg } from "../api";
import type {
	BranchOptions,
	Commit,
	CommitFile,
	MergeOptions,
	PullOptions,
	PushOptions,
	RefsData,
	RepoStatus,
	StashEntry,
	StashOptions,
	TagOptions,
} from "../api";
import { useUI } from "./ui";

export type ViewKind = "history" | "status";

export interface SelectedFile {
	path: string;
	staged: boolean;
	group: "staged" | "unstaged" | "untracked" | "conflicted";
}

const LOG_PAGE = 200;

export const useRepo = defineStore("repo", {
	state: () => ({
		path: "",
		view: "history" as ViewKind,

		status: null as RepoStatus | null,
		refs: null as RefsData | null,
		stashes: [] as StashEntry[],
		statusError: "",

		// history view
		commits: [] as Commit[],
		logRef: "all",
		/** 用户是否手动选择过 ref；未选择时自动跟随当前检出分支 */
		logRefPinned: false,
		logSearch: "",
		logLoading: false,
		logHasMore: true,
		/** increments on every log query; stale in-flight responses are discarded */
		logGen: 0,
		selectedHash: "",
		selectedCommit: null as Commit | null,
		commitFiles: [] as CommitFile[],
		commitFile: "",
		commitDiff: "",
		detailLoading: false,

		// file status view
		selectedFile: null as SelectedFile | null,
		fileDiff: "",
		fileDiffLoading: false,
		commitMessage: "",
		amend: false,
		/** 正在执行文件级操作（暂存/取消/丢弃）的路径：对应行显示局部 loading */
		pendingPaths: [] as string[],
		/** refreshStatus 并发合并标记 */
		statusLoading: false,
		statusQueued: false,
	}),
	getters: {
		dirtyCount(s): number {
			if (!s.status) return 0;
			return (
				(s.status.staged?.length || 0) +
				(s.status.unstaged?.length || 0) +
				(s.status.untracked?.length || 0) +
				(s.status.conflicted?.length || 0)
			);
		},
		changeCount(s): number {
			if (!s.status) return 0;
			return (
				(s.status.staged?.length || 0) +
				(s.status.unstaged?.length || 0) +
				(s.status.untracked?.length || 0)
			);
		},
		opInProgress(s): "" | "merge" | "rebase" | "cherry-pick" | "revert" {
			const st = s.status;
			if (!st) return "";
			if (st.rebasing) return "rebase";
			if (st.merging) return "merge";
			if (st.cherryPicking) return "cherry-pick";
			if (st.reverting) return "revert";
			return "";
		},
	},
	actions: {
		attach(path: string) {
			this.$reset();
			this.path = path;
			// 让后端监听该仓库（fsnotify → repo:changed 事件），失败时退回兜底轮询
			GitService.WatchRepo(path).catch(() => {});
			this.refreshAll();
		},

		/** 取消后端对当前仓库的监听（关闭仓库时调用）。 */
		unwatch() {
			GitService.UnwatchRepo().catch(() => {});
		},

		async refreshAll() {
			if (!this.path) return;
			await Promise.all([
				this.refreshStatus(),
				this.refreshRefs(),
				this.refreshStashes(),
			]);
			// 用户尚未手动选择 ref 时，默认按当前检出分支过滤历史（而不是「所有分支」）
			if (!this.logRefPinned && this.refs) {
				const cur = (this.refs.branches || []).find(
					(b) => b.isCurrent && !b.isRemote,
				);
				if (cur) this.logRef = cur.name;
			}
			await this.loadLog(true);
			// Keep the selection valid after a refresh.
			if (this.selectedHash) {
				const still = this.commits.find(
					(c) => c.hash === this.selectedHash,
				);
				this.selectedCommit = still || null;
				if (!still) {
					this.selectedHash = "";
					this.commitFiles = [];
					this.commitDiff = "";
				}
			}
		},

		async refreshStatus() {
			if (!this.path) return;
			// 合并并发请求：一次未完成时只记一个尾随标记，避免刷新堆叠
			if (this.statusLoading) {
				this.statusQueued = true;
				return;
			}
			this.statusLoading = true;
			try {
				this.status = await GitService.Status(this.path);
				this.statusError = "";
			} catch (e) {
				this.statusError = errMsg(e);
			} finally {
				this.statusLoading = false;
			}
			// Selected file may be gone after external changes.
			if (this.selectedFile && this.status) {
				const f = this.selectedFile;
				const all = [
					...(this.status.staged || []).map((x) => x.path),
					...(this.status.unstaged || []).map((x) => x.path),
					...(this.status.untracked || []).map((x) => x.path),
					...(this.status.conflicted || []).map((x) => x.path),
				];
				if (!all.includes(f.path)) {
					this.selectedFile = null;
					this.fileDiff = "";
				}
			}
			if (this.statusQueued) {
				this.statusQueued = false;
				void this.refreshStatus();
			}
		},

		async refreshRefs() {
			if (!this.path) return;
			try {
				this.refs = await GitService.Refs(this.path);
			} catch {
				this.refs = null;
			}
		},

		async refreshStashes() {
			if (!this.path) return;
			try {
				this.stashes = (await GitService.StashList(this.path)) || [];
			} catch {
				this.stashes = [];
			}
		},

		async loadLog(reset = false) {
			if (!this.path) return;
			// Pagination is skipped while loading; a reset always supersedes
			// in-flight loads via the generation token so pages from different
			// branches/queries can never be mixed into one list.
			if (!reset && this.logLoading) return;
			const gen = ++this.logGen;
			this.logLoading = true;
			try {
				const skip = reset ? 0 : this.commits.length;
				const page =
					(await GitService.Log(this.path, {
						ref: this.logRef,
						skip,
						limit: LOG_PAGE,
						search: this.logSearch,
						file: "",
					})) || [];
				if (gen !== this.logGen) return; // superseded by a newer query
				if (reset) {
					this.commits = page;
				} else {
					this.commits = this.commits.concat(page);
				}
				this.logHasMore = page.length >= LOG_PAGE;
			} catch (e) {
				if (gen !== this.logGen) return;
				useUI().error("加载提交历史失败", errMsg(e));
				this.logHasMore = false;
			} finally {
				if (gen === this.logGen) this.logLoading = false;
			}
		},

		async loadMoreLog() {
			if (this.logHasMore && !this.logLoading) await this.loadLog(false);
		},

		setLogRef(ref: string) {
			this.logRefPinned = true;
			this.logRef = ref;
			this.loadLog(true);
		},
		setLogSearch(s: string) {
			this.logSearch = s;
			this.loadLog(true);
		},
		setView(v: ViewKind) {
			this.view = v;
		},

		async selectCommit(hash: string) {
			this.selectedHash = hash;
			this.selectedCommit = null;
			this.commitFiles = [];
			this.commitFile = "";
			this.commitDiff = "";
			this.detailLoading = true;
			try {
				const [full, files] = await Promise.all([
					GitService.ShowCommit(this.path, hash),
					GitService.CommitFiles(this.path, hash),
				]);
				if (this.selectedHash !== hash) return; // a newer selection won the race
				this.selectedCommit = full;
				this.commitFiles = files || [];
				if (this.commitFiles.length > 0) {
					this.selectCommitFile(this.commitFiles[0].path);
				}
			} catch (e) {
				useUI().error("加载提交详情失败", errMsg(e));
			} finally {
				if (this.selectedHash === hash) this.detailLoading = false;
			}
		},

		async selectCommitFile(path: string) {
			this.commitFile = path;
			this.commitDiff = "";
			try {
				this.commitDiff = await GitService.CommitDiff(
					this.path,
					this.selectedHash,
					path,
				);
			} catch (e) {
				useUI().error("加载 diff 失败", errMsg(e));
			}
		},

		async selectStatusFile(f: SelectedFile | null) {
			this.selectedFile = f;
			this.fileDiff = "";
			if (!f) return;
			this.fileDiffLoading = true;
			try {
				this.fileDiff = await GitService.WorktreeDiff(
					this.path,
					f.path,
					f.staged,
				);
			} catch (e) {
				useUI().error("加载 diff 失败", errMsg(e));
			} finally {
				this.fileDiffLoading = false;
			}
		},

		// ------------------------------------------------------------------ ops

		/** Run a git operation with local loading + toast + auto refresh.
		 *  key 用于把 loading 显示在发起该操作的控件上；同一时刻只允许一个操作，
		 *  重复触发会被直接忽略（防止重复执行）。 */
		async runOp<T>(
			label: string,
			fn: () => Promise<T>,
			opts?: {
				silent?: boolean;
				refresh?: () => Promise<void>;
				key?: string;
			},
		): Promise<T | null> {
			const ui = useUI();
			if (!ui.beginOp(opts?.key || "op", label + "…")) return null;
			try {
				const r = await fn();
				if (opts?.refresh) await opts.refresh();
				else await this.refreshAll();
				if (!opts?.silent) ui.success(label + "完成");
				return r;
			} catch (e) {
				ui.error(label + "失败", errMsg(e));
				await this.refreshStatus();
				return null;
			} finally {
				ui.endOp();
			}
		},

		/** 标记若干路径正在执行文件级操作（供列表行显示局部 loading）。 */
		async withPending<T>(
			paths: string[],
			fn: () => Promise<T>,
		): Promise<T> {
			this.pendingPaths = [...paths];
			try {
				return await fn();
			} finally {
				this.pendingPaths = [];
			}
		},

		isPending(path: string): boolean {
			return this.pendingPaths.includes(path);
		},

		stagePaths(paths: string[]) {
			return this.withPending(paths, () =>
				this.runOp("暂存", () => GitService.Stage(this.path, paths), {
					silent: true,
					refresh: () => this.refreshStatus(),
					key: "files",
				}),
			);
		},
		stageAll() {
			return this.runOp(
				"全部暂存",
				() => GitService.StageAll(this.path),
				{
					silent: true,
					refresh: () => this.refreshStatus(),
					key: "files",
				},
			);
		},
		unstagePaths(paths: string[]) {
			return this.withPending(paths, () =>
				this.runOp(
					"取消暂存",
					() => GitService.Unstage(this.path, paths),
					{
						silent: true,
						refresh: () => this.refreshStatus(),
						key: "files",
					},
				),
			);
		},
		unstageAll() {
			return this.runOp(
				"全部取消暂存",
				() => GitService.UnstageAll(this.path),
				{
					silent: true,
					refresh: () => this.refreshStatus(),
					key: "files",
				},
			);
		},
		discardPaths(paths: string[]) {
			return this.withPending(paths, () =>
				this.runOp(
					"丢弃更改",
					() => GitService.Discard(this.path, paths),
					{
						refresh: () => this.refreshStatus(),
						key: "files",
					},
				),
			);
		},

		async doCommit(): Promise<boolean> {
			const msg = this.commitMessage;
			const amend = this.amend;
			if (!msg.trim() && !amend) {
				useUI().error("请输入提交信息");
				return false;
			}
			const ui = useUI();
			if (!ui.beginOp("commit", amend ? "Amend 提交…" : "提交…"))
				return false;
			try {
				const hash = await GitService.Commit(this.path, {
					message: msg,
					amend,
				});
				this.commitMessage = "";
				this.amend = false;
				this.selectedFile = null;
				this.fileDiff = "";
				await this.refreshAll();
				ui.success(
					amend ? "已 amend 提交" : "提交成功",
					hash ? hash.slice(0, 8) : "",
				);
				if (hash) this.selectCommit(hash);
				return true;
			} catch (e) {
				ui.error("提交失败", errMsg(e));
				await this.refreshStatus();
				return false;
			} finally {
				ui.endOp();
			}
		},

		checkout(ref: string) {
			return this.runOp(
				"检出 " + ref,
				() => GitService.Checkout(this.path, ref),
				{ key: "branch" },
			);
		},
		createBranch(opts: BranchOptions) {
			return this.runOp(
				"创建分支 " + opts.name,
				() => GitService.CreateBranch(this.path, opts),
				{ key: "branch" },
			);
		},
		deleteBranch(name: string, force: boolean) {
			return this.runOp(
				"删除分支 " + name,
				() => GitService.DeleteBranch(this.path, name, force),
				{ key: "branch" },
			);
		},
		deleteRemoteBranch(remote: string, name: string) {
			return this.runOp(
				"删除远程分支 " + name,
				() => GitService.DeleteRemoteBranch(this.path, remote, name),
				{ key: "branch" },
			);
		},
		async renameBranch(oldName: string, newName: string): Promise<boolean> {
			const r = await this.runOp(
				"重命名分支",
				() => GitService.RenameBranch(this.path, oldName, newName),
				{ key: "branch" },
			);
			return r !== null;
		},
		async merge(opts: MergeOptions) {
			const ui = useUI();
			if (!ui.beginOp("merge", "合并 " + opts.ref + "…")) return false;
			try {
				await GitService.Merge(this.path, opts);
				await this.refreshAll();
				if (
					this.status?.merging ||
					(this.status?.conflicted?.length || 0) > 0
				) {
					ui.info("合并产生冲突", "请在文件状态视图中解决冲突后提交");
					this.view = "status";
				} else {
					ui.success("合并完成");
				}
				return true;
			} catch (e) {
				await this.refreshAll();
				if (
					this.status?.merging ||
					(this.status?.conflicted?.length || 0) > 0
				) {
					ui.info("合并产生冲突", errMsg(e));
					this.view = "status";
					return true;
				}
				ui.error("合并失败", errMsg(e));
				return false;
			} finally {
				ui.endOp();
			}
		},
		mergeAbort() {
			return this.runOp(
				"中止合并",
				() => GitService.MergeAbort(this.path),
				{ key: "merge" },
			);
		},
		rebase(onto: string) {
			return this.runOp(
				"Rebase 到 " + onto,
				() => GitService.Rebase(this.path, onto),
				{ key: "rebase" },
			);
		},
		rebaseAbort() {
			return this.runOp(
				"中止 rebase",
				() => GitService.RebaseAbort(this.path),
				{ key: "rebase" },
			);
		},
		rebaseContinue() {
			return this.runOp(
				"继续 rebase",
				() => GitService.RebaseContinue(this.path),
				{ key: "rebase" },
			);
		},
		rebaseSkip() {
			return this.runOp(
				"跳过 rebase 补丁",
				() => GitService.RebaseSkip(this.path),
				{ key: "rebase" },
			);
		},
		cherryPick(hash: string) {
			return this.runOp(
				"Cherry-pick " + hash.slice(0, 8),
				() => GitService.CherryPick(this.path, hash),
				{ key: "cherry-pick" },
			);
		},
		cherryPickAbort() {
			return this.runOp(
				"中止 cherry-pick",
				() => GitService.CherryPickAbort(this.path),
				{ key: "cherry-pick" },
			);
		},
		cherryPickContinue() {
			return this.runOp(
				"继续 cherry-pick",
				() => GitService.CherryPickContinue(this.path),
				{ key: "cherry-pick" },
			);
		},
		revertCommit(hash: string) {
			return this.runOp(
				"Revert " + hash.slice(0, 8),
				() => GitService.Revert(this.path, hash),
				{ key: "revert" },
			);
		},
		revertAbort() {
			return this.runOp(
				"中止 revert",
				() => GitService.RevertAbort(this.path),
				{ key: "revert" },
			);
		},
		reset(target: string, mode: string) {
			return this.runOp(
				"Reset (" + mode + ")",
				() => GitService.Reset(this.path, target, mode),
				{ key: "reset" },
			);
		},

		async fetch(remote: string, prune: boolean) {
			const out = await this.runOp(
				"Fetch",
				() => GitService.Fetch(this.path, remote, prune),
				{
					silent: true,
					key: "fetch",
				},
			);
			if (out !== null) {
				useUI().success("Fetch 完成", (out || "").trim() || undefined);
			}
		},
		async pull(opts: PullOptions) {
			const out = await this.runOp(
				"Pull",
				() => GitService.Pull(this.path, opts),
				{ silent: true, key: "pull" },
			);
			if (out !== null)
				useUI().success("Pull 完成", (out || "").trim() || undefined);
			await this.refreshAll();
		},
		async push(opts: PushOptions) {
			const out = await this.runOp(
				"Push",
				() => GitService.Push(this.path, opts),
				{ silent: true, key: "push" },
			);
			if (out !== null)
				useUI().success("Push 完成", (out || "").trim() || undefined);
			await this.refreshAll();
		},

		stashSave(opts: StashOptions) {
			return this.runOp(
				"Stash",
				() => GitService.StashSave(this.path, opts),
				{ key: "stash" },
			);
		},
		stashPop(index: number) {
			return this.runOp(
				"Stash pop",
				() => GitService.StashPop(this.path, index),
				{ key: "stash" },
			);
		},
		stashApply(index: number) {
			return this.runOp(
				"Stash apply",
				() => GitService.StashApply(this.path, index),
				{ key: "stash" },
			);
		},
		stashDrop(index: number) {
			return this.runOp(
				"删除 stash",
				async () => {
					await GitService.StashDrop(this.path, index);
					await this.refreshStashes();
				},
				{ key: "stash" },
			);
		},

		createTag(opts: TagOptions) {
			return this.runOp(
				"创建标签 " + opts.name,
				() => GitService.CreateTag(this.path, opts),
				{ key: "tag" },
			);
		},
		deleteTag(name: string, remote: string) {
			return this.runOp(
				"删除标签 " + name,
				() => GitService.DeleteTag(this.path, name, remote),
				{ key: "tag" },
			);
		},
	},
});
