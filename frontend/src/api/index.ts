// Typed access to the Go backend via the auto-generated Wails bindings.
import {
	GitService,
	RepoService,
	AppService,
	UpdateService,
	AiService,
} from "../../bindings/gitview";
import { Dialogs, Clipboard, Events } from "@wailsio/runtime";

export {
	GitService,
	RepoService,
	AppService,
	UpdateService,
	AiService,
	Events,
};

export type {
	AiProvider,
	BranchInfo,
	BranchOptions,
	ChatMessage,
	ChatRequest,
	CloneOptions,
	CommandResult,
	Commit,
	CommitFile,
	CommitOptions,
	ConflictDetail,
	ConflictSide,
	FileStatus,
	GitLogEntry,
	GitStepResult,
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

/**
 * AI 流式对话事件（见 aiservice.go）。所有负载都带 streamId，
 * 以便同一时间多个对话互不干扰。
 */
export const AI_CHUNK_EVENT = "ai:chunk";
export const AI_REASONING_EVENT = "ai:reasoning";
export const AI_TOOL_EVENT = "ai:tool";
export const AI_ROUND_EVENT = "ai:round";
export const AI_DONE_EVENT = "ai:done";
export const AI_ERROR_EVENT = "ai:error";

/** ai:chunk 负载：助手增量文本 */
export interface AiChunkPayload {
	streamId: string;
	text: string;
}

/** ai:reasoning 负载：模型思考过程（reasoning）的增量文本 */
export interface AiReasoningPayload {
	streamId: string;
	text: string;
}

/** ai:round 负载：一轮结束（前端据此折叠本轮思考） */
export interface AiRoundPayload {
	streamId: string;
	index: number;
}

/** ai:tool 负载：工具调用开始（done=false）或结束（done=true，含 result） */
export interface AiToolPayload {
	streamId: string;
	name: string;
	args: string;
	result?: string;
	done: boolean;
}

/** ai:done 负载：最终文本 */
export interface AiDonePayload {
	streamId: string;
	content: string;
}

/** ai:error 负载：错误信息（用户取消时为「已取消」） */
export interface AiErrorPayload {
	streamId: string;
	message: string;
}

/** 克隆进度事件（见 gitView/reposervice.go 的 emitCloneProgress） */
export const CLONE_PROGRESS_EVENT = "clone:progress";

/** clone:progress 负载：git 输出的原始片段（可能含 \r 进度条覆盖语义） */
export interface CloneProgressPayload {
	output: string;
}

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
