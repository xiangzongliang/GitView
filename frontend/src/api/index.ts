// Typed access to the Go backend via the auto-generated Wails bindings.
import {
	GitService,
	RepoService,
	AppService,
	UpdateService,
} from "../../bindings/gitview";
import { Dialogs, Clipboard, Events } from "@wailsio/runtime";

export { GitService, RepoService, AppService, UpdateService, Events };

export type {
	BranchInfo,
	BranchOptions,
	CloneOptions,
	CommandResult,
	Commit,
	CommitFile,
	CommitOptions,
	FileStatus,
	GitLogEntry,
	GroupInfo,
	LogOptions,
	MergeOptions,
	PullOptions,
	PushOptions,
	RefDecoration,
	RefsData,
	RemoteInfo,
	RepoEntry,
	RepoStatus,
	StashEntry,
	StashOptions,
	TagInfo,
	TagOptions,
	UpdateCheckResult,
	WatchStatus,
} from "../../bindings/gitview/models";

/** 后端监听仓库变化时推送的事件名（见 gitView/watcher.go） */
export const REPO_CHANGED_EVENT = "repo:changed";

/** repo:changed 事件负载 */
export interface RepoChange {
	repoPath?: string;
	/** "status"（工作区/index）| "refs"（分支/标签/stash）| "all" */
	kind?: string;
}

/** Open a native directory picker. Resolves '' when cancelled. */
export async function pickDirectory(
	title = "选择目录",
	startDir = "",
): Promise<string> {
	const res = await Dialogs.OpenFile({
		CanChooseDirectories: true,
		CanChooseFiles: false,
		CanCreateDirectories: true,
		Title: title,
		Directory: startDir || undefined,
	});
	const path = Array.isArray(res) ? res[0] : res;
	return path || "";
}

/** Extract a human-readable message from a rejected Wails call. */
export function errMsg(e: unknown): string {
	if (!e) return "未知错误";
	const err = e as any;
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	return err.message || JSON.stringify(err);
}

export async function copyText(text: string): Promise<void> {
	try {
		await Clipboard.SetText(text);
	} catch {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			/* ignore */
		}
	}
}
