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
			this.refreshAll();
		},

		async refreshAll() {
			if (!this.path) return;
			await Promise.all([
				this.refreshStatus(),
				this.refreshRefs(),
				this.refreshStashes(),
			]);
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
			try {
				this.status = await GitService.Status(this.path);
				this.statusError = "";
			} catch (e) {
				this.statusError = errMsg(e);
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

		/** Run a git operation with spinner + toast + auto refresh. */
		async runOp<T>(
			label: string,
			fn: () => Promise<T>,
			opts?: { silent?: boolean; refresh?: () => Promise<void> },
		): Promise<T | null> {
			const ui = useUI();
			ui.opRunning = label + "…";
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
				ui.opRunning = "";
			}
		},

		stagePaths(paths: string[]) {
			return this.runOp(
				"暂存",
				() => GitService.Stage(this.path, paths),
				{
					silent: true,
					refresh: () => this.refreshStatus(),
				},
			);
		},
		stageAll() {
			return this.runOp(
				"全部暂存",
				() => GitService.StageAll(this.path),
				{
					silent: true,
					refresh: () => this.refreshStatus(),
				},
			);
		},
		unstagePaths(paths: string[]) {
			return this.runOp(
				"取消暂存",
				() => GitService.Unstage(this.path, paths),
				{
					silent: true,
					refresh: () => this.refreshStatus(),
				},
			);
		},
		unstageAll() {
			return this.runOp(
				"全部取消暂存",
				() => GitService.UnstageAll(this.path),
				{
					silent: true,
					refresh: () => this.refreshStatus(),
				},
			);
		},
		discardPaths(paths: string[]) {
			return this.runOp(
				"丢弃更改",
				() => GitService.Discard(this.path, paths),
				{
					refresh: () => this.refreshStatus(),
				},
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
			ui.opRunning = amend ? "Amend 提交…" : "提交…";
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
				ui.opRunning = "";
			}
		},

		checkout(ref: string) {
			return this.runOp("检出 " + ref, () =>
				GitService.Checkout(this.path, ref),
			);
		},
		createBranch(opts: BranchOptions) {
			return this.runOp("创建分支 " + opts.name, () =>
				GitService.CreateBranch(this.path, opts),
			);
		},
		deleteBranch(name: string, force: boolean) {
			return this.runOp("删除分支 " + name, () =>
				GitService.DeleteBranch(this.path, name, force),
			);
		},
		deleteRemoteBranch(remote: string, name: string) {
			return this.runOp("删除远程分支 " + name, () =>
				GitService.DeleteRemoteBranch(this.path, remote, name),
			);
		},
		async renameBranch(oldName: string, newName: string): Promise<boolean> {
			const r = await this.runOp("重命名分支", () =>
				GitService.RenameBranch(this.path, oldName, newName),
			);
			return r !== null;
		},
		async merge(opts: MergeOptions) {
			const ui = useUI();
			ui.opRunning = "合并 " + opts.ref + "…";
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
				ui.opRunning = "";
			}
		},
		mergeAbort() {
			return this.runOp("中止合并", () =>
				GitService.MergeAbort(this.path),
			);
		},
		rebase(onto: string) {
			return this.runOp("Rebase 到 " + onto, () =>
				GitService.Rebase(this.path, onto),
			);
		},
		rebaseAbort() {
			return this.runOp("中止 rebase", () =>
				GitService.RebaseAbort(this.path),
			);
		},
		rebaseContinue() {
			return this.runOp("继续 rebase", () =>
				GitService.RebaseContinue(this.path),
			);
		},
		rebaseSkip() {
			return this.runOp("跳过 rebase 补丁", () =>
				GitService.RebaseSkip(this.path),
			);
		},
		cherryPick(hash: string) {
			return this.runOp("Cherry-pick " + hash.slice(0, 8), () =>
				GitService.CherryPick(this.path, hash),
			);
		},
		cherryPickAbort() {
			return this.runOp("中止 cherry-pick", () =>
				GitService.CherryPickAbort(this.path),
			);
		},
		cherryPickContinue() {
			return this.runOp("继续 cherry-pick", () =>
				GitService.CherryPickContinue(this.path),
			);
		},
		revertCommit(hash: string) {
			return this.runOp("Revert " + hash.slice(0, 8), () =>
				GitService.Revert(this.path, hash),
			);
		},
		revertAbort() {
			return this.runOp("中止 revert", () =>
				GitService.RevertAbort(this.path),
			);
		},
		reset(target: string, mode: string) {
			return this.runOp("Reset (" + mode + ")", () =>
				GitService.Reset(this.path, target, mode),
			);
		},

		async fetch(remote: string, prune: boolean) {
			const out = await this.runOp(
				"Fetch",
				() => GitService.Fetch(this.path, remote, prune),
				{
					silent: true,
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
				{ silent: true },
			);
			if (out !== null)
				useUI().success("Pull 完成", (out || "").trim() || undefined);
			await this.refreshAll();
		},
		async push(opts: PushOptions) {
			const out = await this.runOp(
				"Push",
				() => GitService.Push(this.path, opts),
				{ silent: true },
			);
			if (out !== null)
				useUI().success("Push 完成", (out || "").trim() || undefined);
			await this.refreshAll();
		},

		stashSave(opts: StashOptions) {
			return this.runOp("Stash", () =>
				GitService.StashSave(this.path, opts),
			);
		},
		stashPop(index: number) {
			return this.runOp("Stash pop", () =>
				GitService.StashPop(this.path, index),
			);
		},
		stashApply(index: number) {
			return this.runOp("Stash apply", () =>
				GitService.StashApply(this.path, index),
			);
		},
		stashDrop(index: number) {
			return this.runOp("删除 stash", async () => {
				await GitService.StashDrop(this.path, index);
				await this.refreshStashes();
			});
		},

		createTag(opts: TagOptions) {
			return this.runOp("创建标签 " + opts.name, () =>
				GitService.CreateTag(this.path, opts),
			);
		},
		deleteTag(name: string, remote: string) {
			return this.runOp("删除标签 " + name, () =>
				GitService.DeleteTag(this.path, name, remote),
			);
		},
	},
});
