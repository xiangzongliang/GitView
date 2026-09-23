// 提交信息前缀：预设、拼接与去重规则集中在这里，便于复用与调整。
// 前缀按项目保存（见后端 RepoService 的 Get/SetAiCommitPrefix）。

/** 预设前缀；value 含分隔符，保证拼接后的提交信息可读。 */
export const COMMIT_PREFIX_PRESETS: { label: string; value: string }[] = [
	{ label: "无前缀", value: "" },
	{ label: "feat:", value: "feat: " },
	{ label: "AI：", value: "AI：" },
];

/** 下拉框里「自定义」的哨兵值，用来和真实前缀区分。 */
export const CUSTOM_PREFIX_VALUE = "__custom__";

/**
 * 已知的 Conventional Commits 类型前缀。
 * 配置了自定义前缀时，模型若仍自带类型前缀会先被去掉，
 * 避免出现「AI：feat: xxx」这种双重前缀。
 */
const CC_TYPE_RE =
	/^(feat|fix|refactor|docs|style|test|chore|build|perf|ci|revert)(\([^)]*\))?!?:\s*/i;

/** 判断某个前缀是否为预设值。 */
export function isPresetPrefix(value: string): boolean {
	return COMMIT_PREFIX_PRESETS.some((p) => p.value === value);
}

/** 把前缀拼到提交信息前面；prefix 为空时原样返回（仅去掉首尾空白）。 */
export function applyCommitPrefix(text: string, prefix: string): string {
	const body = text.trim();
	if (!prefix) return body;
	return prefix + body.replace(CC_TYPE_RE, "");
}
