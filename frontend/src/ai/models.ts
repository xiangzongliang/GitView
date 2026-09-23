import type { AiConfig } from "../stores/ai";

// AI 模型选择的共享逻辑：把配置（provider）展开成可选的「模型」列表。
// 供模型下拉框、提交信息生成等场景复用。

/** 一个可选的模型（provider + 模型名称）。 */
export interface AiModelChoice {
	providerId: string;
	/** 配置名称，用于下拉分组标题 */
	providerTitle: string;
	model: string;
}

/**
 * 展开可用的模型列表，按配置分组（保持配置文件中的顺序）。
 * 只有 Base URL、API Key、模型名称三者齐备的配置才会入选：
 * 缺任一项都无法真正发起请求，放出来只会让用户选到不可用的模型。
 */
export function availableAiModels(providers: AiConfig[]): AiModelChoice[] {
	const out: AiModelChoice[] = [];
	for (const p of providers) {
		if (!p.baseUrl.trim() || !p.apiKey.trim()) continue;
		const title = p.title.trim() || "未命名配置";
		for (const raw of p.models) {
			const model = raw.trim();
			if (!model) continue;
			out.push({ providerId: p.id, providerTitle: title, model });
		}
	}
	return out;
}

/** 模型下拉框的取值编码：`providerId::模型名称`（模型名允许包含 ::）。 */
export function encodeModelValue(providerId: string, model: string): string {
	return `${providerId}::${model}`;
}

/** 解析模型下拉框的取值；格式非法时返回空值。 */
export function decodeModelValue(value: string): {
	providerId: string;
	model: string;
} {
	const i = value.indexOf("::");
	if (i < 0) return { providerId: "", model: "" };
	return { providerId: value.slice(0, i), model: value.slice(i + 2) };
}
