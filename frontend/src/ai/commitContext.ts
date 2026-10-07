import { GitService, errMsg } from "../api";
import type { RepoStatus } from "../api";
import type { CommitContext } from "./prompts";

// 提交上下文收集：把当前变更（文件列表 + 差异）整理成可交给模型的文本。
// 差异可能很大，因此按文件与总量双重截断；被截断的部分由模型按需用
// read_file 工具补充读取（工具的启用见 AiChatDialog 的 repoPath）。

/** 单个文件差异的字符上限；超出后截断。 */
const MAX_FILE_DIFF_CHARS = 8000;
/** 全部文件差异合计的字符上限。 */
const MAX_TOTAL_DIFF_CHARS = 24000;

/** 显式指定要分析的文件（勾选/选中的文件），用于覆盖默认选择。 */
export interface ContextPick {
	path: string;
	/** 读取差异的方向：true=index vs HEAD（已暂存），false=worktree vs index */
	staged: boolean;
	/** 变更类型字符，仅用于提示词里的文件清单展示 */
	status?: string;
}

/**
 * 收集提交上下文。`only` 用于显式圈定要分析的文件（调用方按「勾选/选中」的
 * 文件传入）；未提供时，优先使用已暂存的变更（提交只会包含它们），
 * 没有暂存内容时退回未暂存 + 未跟踪，便于在暂存前先让 AI 起草信息。
 */
export async function collectCommitContext(
	repoPath: string,
	status: RepoStatus | null,
	only?: ContextPick[] | null,
): Promise<CommitContext> {
	const picks: ContextPick[] = [];
	const seen = new Set<string>();
	const add = (p: ContextPick) => {
		if (!p.path || seen.has(p.path)) return;
		seen.add(p.path);
		picks.push(p);
	};

	if (only && only.length > 0) {
		// 调用方已圈定要分析的文件：严格按此清单，不再回退。
		for (const p of only) add(p);
	} else {
		const staged = status?.staged || [];
		const useStaged = staged.length > 0;
		const list = useStaged
			? staged
			: [...(status?.unstaged || []), ...(status?.untracked || [])];
		for (const f of list) {
			add({ path: f.path, staged: useStaged, status: f.statusChar });
		}
	}

	const files: { path: string; status: string }[] = picks.map((p) => ({
		path: p.path,
		status: p.status || "M",
	}));

	const parts: string[] = [];
	let total = 0;
	let truncated = false;
	for (const f of picks) {
		let diff = "";
		try {
			diff = await GitService.WorktreeDiff(
				repoPath,
				f.path,
				f.staged,
				false,
			);
		} catch (e) {
			// 单个文件读差异失败不应中断整体流程，跳过并在结果中体现截断。
			console.warn("读取文件差异失败", f.path, errMsg(e));
			truncated = true;
			continue;
		}
		if (!diff.trim()) continue;
		if (diff.length > MAX_FILE_DIFF_CHARS) {
			diff = `${diff.slice(0, MAX_FILE_DIFF_CHARS)}\n…（该文件差异过长，已截断）`;
			truncated = true;
		}
		if (total + diff.length > MAX_TOTAL_DIFF_CHARS) {
			parts.push(
				"…（其余文件差异因篇幅省略，可按需用 read_file 工具读取）",
			);
			truncated = true;
			break;
		}
		total += diff.length;
		parts.push(diff);
	}

	return {
		branch: status?.branch || "",
		files,
		diff: parts.join("\n"),
		truncated,
	};
}
