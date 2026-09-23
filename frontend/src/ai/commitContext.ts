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

/**
 * 收集提交上下文。优先使用已暂存的变更（提交只会包含它们）；
 * 没有暂存内容时退回未暂存 + 未跟踪，便于在暂存前先让 AI 起草信息。
 */
export async function collectCommitContext(
	repoPath: string,
	status: RepoStatus | null,
): Promise<CommitContext> {
	const staged = status?.staged || [];
	const useStaged = staged.length > 0;
	const list = useStaged
		? staged
		: [...(status?.unstaged || []), ...(status?.untracked || [])];

	const files: { path: string; status: string }[] = [];
	const seen = new Set<string>();
	for (const f of list) {
		if (!f.path || seen.has(f.path)) continue;
		seen.add(f.path);
		files.push({ path: f.path, status: f.statusChar || "M" });
	}

	const parts: string[] = [];
	let total = 0;
	let truncated = false;
	for (const f of files) {
		let diff = "";
		try {
			diff = await GitService.WorktreeDiff(repoPath, f.path, useStaged);
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
			parts.push("…（其余文件差异因篇幅省略，可按需用 read_file 工具读取）");
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
