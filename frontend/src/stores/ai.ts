import { defineStore } from "pinia";
import { RepoService, errMsg } from "../api";
import type { AiProvider } from "../api";

/**
 * AI 模型配置持久化到后端 config.json（UserConfigDir/GitView/config.json），
 * 与仓库列表 / 分组共用同一份应用配置文件。
 * 旧版本数据存于 localStorage，首次加载时自动迁移到 config.json。
 */

// 旧版存储键：仅用于一次性迁移，不再写入。
const LEGACY_KEY = "gv.ai-models";

/** 写盘去抖定时器：标题 / Key 输入时避免每次按键都写文件。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DELAY = 400;

function uid(): string {
	return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function strList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

/** 模型名称列表：去首尾空白并丢弃空名称（空名称不保存、不参与计算）。 */
function modelList(v: unknown): string[] {
	return strList(v)
		.map((m) => m.trim())
		.filter((m) => m !== "");
}

function normalize(raw: unknown): AiProvider | null {
	if (!raw || typeof raw !== "object") return null;
	const p = raw as Record<string, unknown>;
	const provider: AiProvider = {
		id: str(p.id) || uid(),
		// 兼容旧结构（单模型）：旧的 name 字段作为标题
		title: str(p.title) || str(p.name),
		baseUrl: str(p.baseUrl),
		apiKey: str(p.apiKey),
		models: modelList(p.models),
	};
	// 丢弃完全空白的条目（例如手工编辑坏的存储）
	if (
		!provider.title &&
		!provider.baseUrl &&
		!provider.apiKey &&
		provider.models.length === 0
	) {
		return null;
	}
	return provider;
}

/** 读取旧版 localStorage 数据（迁移用）。 */
function loadLegacy(): AiProvider[] {
	try {
		const raw = localStorage.getItem(LEGACY_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map(normalize).filter((p): p is AiProvider => p !== null);
	} catch {
		return [];
	}
}

/** 写盘前的整理：只保留有意义的字段，模型名称为空的不写入。 */
function toSave(providers: AiProvider[]): AiProvider[] {
	return providers.map((p) => ({
		id: p.id,
		title: p.title,
		baseUrl: p.baseUrl,
		apiKey: p.apiKey,
		models: modelList(p.models),
	}));
}

export const useAi = defineStore("ai", {
	state: () => ({
		providers: [] as AiProvider[],
		loaded: false,
	}),
	actions: {
		/** 从后端 config.json 加载；后端不可用时保持内存态（不阻塞使用）。 */
		async load() {
			if (this.loaded) return;
			this.loaded = true;
			let providers: AiProvider[] = [];
			try {
				const res = await RepoService.ListAiProviders();
				providers = (res ?? [])
					.map(normalize)
					.filter((p): p is AiProvider => p !== null);
			} catch (e) {
				console.error("读取 AI 模型配置失败", errMsg(e));
			}
			// 后端无数据时尝试迁移旧版 localStorage 数据
			if (providers.length === 0) {
				const legacy = loadLegacy();
				if (legacy.length > 0) {
					this.providers = legacy;
					void this.persist();
					return;
				}
			}
			this.providers = providers;
		},
		/** 写入 config.json（去抖）。字段通过 v-model 直接修改后调用。 */
		persist() {
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				saveTimer = null;
				void this.flush();
			}, SAVE_DELAY);
		},
		async flush() {
			try {
				await RepoService.SaveAiProviders(toSave(this.providers));
				// 写盘成功后清理旧版数据：否则用户删除配置后，下次启动会从旧数据重新迁移回来。
				try {
					localStorage.removeItem(LEGACY_KEY);
				} catch {
					/* ignore */
				}
			} catch (e) {
				console.error("保存 AI 模型配置失败", errMsg(e));
			}
		},
		addProvider(partial?: Partial<Omit<AiProvider, "id">>): AiProvider {
			const provider: AiProvider = {
				id: uid(),
				title: partial?.title ?? "",
				baseUrl: partial?.baseUrl ?? "",
				apiKey: partial?.apiKey ?? "",
				models: partial?.models ?? [],
			};
			this.providers.push(provider);
			this.persist();
			return provider;
		},
		removeProvider(id: string) {
			this.providers = this.providers.filter((p) => p.id !== id);
			this.persist();
		},
		/** 在该服务下新增一个空模型名称。 */
		addModel(id: string) {
			const p = this.providers.find((x) => x.id === id);
			if (!p) return;
			p.models.push("");
			this.persist();
		},
		removeModel(id: string, index: number) {
			const p = this.providers.find((x) => x.id === id);
			if (!p) return;
			p.models.splice(index, 1);
			this.persist();
		},
	},
});
