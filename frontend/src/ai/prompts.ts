// AI 提示词集中管理：与对话组件解耦，便于单独调整措辞或复用到其它场景。

/** 提交信息生成：系统提示词的基础部分。 */
const COMMIT_MESSAGE_BASE = [
	"你是一名严谨的工程师，负责为 Git 提交撰写简洁的提交信息。",
	"",
	"要求：",
	"1. 只输出提交信息本身，不要任何解释、客套话或 Markdown 代码块围栏。",
	"2. 默认只写一行标题，整条信息尽量少于 50 个字；",
	"   用祈使句或简洁的名词短语点明这次改动的目的，不要罗列细节。",
	"3. 必要时可加 Conventional Commits 前缀（feat/fix/refactor/docs/style/test/chore/build/perf/ci）。",
	"4. 只有当改动横跨多个不相关的模块、确实需要交代背景时，才空一行补充极简正文，",
	"   最多 2-3 条「- 」要点、每条一句话；不要逐行复述代码差异。",
	"5. 宁短勿长：删掉可推断的修饰语，不要把文件清单写进提交信息。",
	"6. 使用与代码库一致的描述语言；无法判断时默认使用中文。",
	"7. 不要编造改动中没有出现的内容。可按需调用 read_file 工具确认，",
	"   但不要为了写得详细而过度翻查文件——目标是一句话把「做了什么」说清楚。",
];

/** 提交信息生成：系统提示词（约束任务与输出格式）。 */
export const COMMIT_MESSAGE_SYSTEM_PROMPT = COMMIT_MESSAGE_BASE.join("\n");

/**
 * 按项目配置的前缀生成系统提示词。
 * 配了前缀时明确告诉模型不要再自带类型前缀，避免出现「AI：feat: xxx」。
 */
export function buildCommitSystemPrompt(prefix: string): string {
	if (!prefix) return COMMIT_MESSAGE_SYSTEM_PROMPT;
	return [
		...COMMIT_MESSAGE_BASE,
		"",
		`注意：提交信息将由系统统一添加前缀「${prefix}」，`,
		"因此你**不要**再输出任何类型前缀（如 feat: / fix: / AI：），直接写正文即可；",
		"上述第 3 条前缀要求同样不适用。",
	].join("\n");
}

/** 提交信息生成所需的上下文。 */
export interface CommitContext {
	/** 当前分支名 */
	branch: string;
	/** 变更文件（路径 + 变更类型字符） */
	files: { path: string; status: string }[];
	/** 所有变更文件合并后的差异文本（可能被截断） */
	diff: string;
	/** 差异是否被截断（截断后会提示模型用工具补充读取） */
	truncated: boolean;
}

/** 提交信息生成：用户提示词（拼装变更摘要 + 差异）。 */
export function buildCommitUserPrompt(ctx: CommitContext): string {
	const fileLines = ctx.files.length
		? ctx.files.map((f) => `- ${f.status} ${f.path}`).join("\n")
		: "（无变更文件）";

	const parts = [
		"请根据以下改动生成提交信息。",
		"",
		`分支：${ctx.branch || "（未知）"}`,
		"",
		"变更文件：",
		fileLines,
		"",
		"差异内容：",
		ctx.diff.trim() || "（无差异内容）",
	];
	if (ctx.truncated) {
		parts.push(
			"",
			"（差异内容已截断，如需更多细节可调用 read_file 工具读取相应文件。）",
		);
	}
	return parts.join("\n");
}

// ------------------------------------------------------------- 合并信息生成

/** 合并信息生成：系统提示词的基础部分。 */
const MERGE_SUMMARY_BASE = [
	"你是一名严谨的工程师，负责为 Git 分支合并撰写合并提交信息（merge commit message）。",
	"",
	"要求：",
	"1. 只输出合并信息本身：不要任何解释、客套话、Markdown 代码块围栏或引号。",
	"2. 输出单行文本，不要换行；长度控制在 10～100 字。",
	"3. 归纳这批提交的共同主题（整体做了什么、为了什么），",
	"   不要罗列单个提交标题、文件名或提交号，不要写成流水账。",
	"4. 主题分散时向上概括，可用「模块：要点」式的紧凑表达；",
	"   确实有 2～3 个并列主题时用顿号连接，仍保持一句话。",
	"5. 使用与提交记录一致的语言；无法判断时默认使用中文。",
	"6. 不要编造提交记录中不存在的内容。",
];

/** 合并信息生成：系统提示词（不带前缀的基础版本）。 */
export const MERGE_SUMMARY_SYSTEM_PROMPT = MERGE_SUMMARY_BASE.join("\n");

/**
 * 按项目配置的前缀生成合并信息系统提示词。
 * 配了前缀时明确告诉模型不要再自带类型前缀。
 */
export function buildMergeSystemPrompt(prefix: string): string {
	if (!prefix) return MERGE_SUMMARY_SYSTEM_PROMPT;
	return [
		...MERGE_SUMMARY_BASE,
		"",
		`注意：合并信息将由系统统一添加前缀「${prefix}」，`,
		"因此你**不要**再输出任何类型前缀（如 feat: / fix: / AI：），直接写正文即可。",
	].join("\n");
}

/** 合并信息生成所需的上下文。 */
export interface MergeSummaryContext {
	/** 被合并的分支（源） */
	sourceBranch: string;
	/** 合并进去的分支（目标） */
	targetBranch: string;
	/** 将被合并的提交（新 → 旧） */
	commits: { hash: string; subject: string; author?: string }[];
}

/** 合并信息生成：用户提示词（分支名 + 待合并提交清单）。 */
export function buildMergeSummaryUserPrompt(ctx: MergeSummaryContext): string {
	const lines = ctx.commits.map(
		(c) => `- ${c.hash.slice(0, 7)} ${c.subject}`,
	);
	return [
		`即将把分支 ${ctx.sourceBranch} 合并进 ${ctx.targetBranch}，请为这次合并提交写一句简短说明。`,
		"",
		`待合并的提交（共 ${ctx.commits.length} 个，新 → 旧）：`,
		...lines,
	].join("\n");
}
