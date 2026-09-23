import { defineStore } from "pinia";
import { RepoService, pickDirectory, errMsg } from "../api";
import type { RepoEntry, GroupInfo, CloneOptions } from "../api";
import { useUI } from "./ui";

export interface RepoGroup {
	/** "" = 未分组 */
	name: string;
	entries: RepoEntry[];
}

/** 布局写盘去抖定时器（就地编辑分组外观时避免每次点击都写盘） */
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;

export const useRepos = defineStore("repos", {
	state: () => ({
		entries: [] as RepoEntry[],
		activePath: "",
		loaded: false,
		/** 分组元数据（顺序 = 显示顺序；含折叠状态，空分组也保留） */
		groups: [] as GroupInfo[],
	}),
	getters: {
		active(s): RepoEntry | null {
			return s.entries.find((e) => e.path === s.activePath) || null;
		},
		/** 已登记的分组名（不含未分组 ""），顺序即显示顺序 */
		groupNames(s): string[] {
			const out: string[] = [];
			const seen = new Set<string>();
			for (const g of s.groups) {
				const n = g.name || "";
				if (!n || seen.has(n)) continue;
				seen.add(n);
				out.push(n);
			}
			return out;
		},
		/** 折叠状态映射（供模板直接按名查询） */
		collapsedGroups(s): Record<string, boolean> {
			const out: Record<string, boolean> = {};
			for (const g of s.groups) {
				if (g.name && g.collapsed) out[g.name] = true;
			}
			return out;
		},
		/**
		 * 分组视图：顺序取自 s.groups（唯一真源），组内仓库顺序取自 s.entries；
		 * 未登记到 s.groups 的分组（兼容旧配置）兜底追加，未分组固定在最后。
		 */
		groupsView(s): RepoGroup[] {
			const out: RepoGroup[] = [];
			const seen = new Set<string>();
			const pick = (name: string): RepoEntry[] =>
				s.entries.filter((e) => (e.group || "") === name);
			for (const g of s.groups) {
				const n = g.name || "";
				if (!n || seen.has(n)) continue;
				seen.add(n);
				out.push({ name: n, entries: pick(n) });
			}
			for (const e of s.entries) {
				const n = e.group || "";
				if (!n || seen.has(n)) continue;
				seen.add(n);
				out.push({ name: n, entries: pick(n) });
			}
			const ungrouped = pick("");
			if (ungrouped.length) out.push({ name: "", entries: ungrouped });
			return out;
		},
	},
	actions: {
		async load() {
			const ui = useUI();
			try {
				const [entries, groups] = await Promise.all([
					RepoService.ListRepos(),
					RepoService.ListGroups(),
				]);
				this.entries = entries || [];
				this.groups = (groups || [])
					.filter((g) => g && g.name)
					.map((g) => ({
						name: g.name,
						collapsed: !!g.collapsed,
						icon: g.icon || "",
						iconColor: g.iconColor || "",
						textColor: g.textColor || "",
					}));
				// 兼容旧配置：entries 中出现但未登记的分组补登记
				this.ensureGroupsRegistered();
			} catch (e) {
				ui.error("加载仓库列表失败", errMsg(e));
			}
			this.loaded = true;
		},
		setActive(path: string) {
			if (path) this.activePath = path;
		},
		/** 把 entries 中出现、但 s.groups 尚未登记的分组补登记到末尾 */
		ensureGroupsRegistered() {
			const known = new Set(this.groups.map((g) => g.name));
			for (const e of this.entries) {
				const n = e.group || "";
				if (n && !known.has(n)) {
					known.add(n);
					this.groups.push({ name: n, collapsed: false });
				}
			}
		},
		toggleGroup(name: string) {
			const g = this.groups.find((x) => x.name === name);
			if (!g) return;
			g.collapsed = !g.collapsed;
			void this.saveLayout();
		},
		/** 把仓库顺序/分组归属与分组列表（顺序 + 折叠）发送给后端持久化；失败仅提示，不回滚本地状态 */
		async saveLayout() {
			const ui = useUI();
			try {
				await RepoService.SaveLayout(
					this.entries.map((e) => ({ ...e, group: e.group || "" })),
					this.groups.map((g) => ({
						name: g.name,
						collapsed: !!g.collapsed,
						icon: g.icon || "",
						iconColor: g.iconColor || "",
						textColor: g.textColor || "",
					})),
				);
			} catch (e) {
				ui.error("保存布局失败", errMsg(e));
			}
		},
		/** 应用拖拽/分组变更后的完整列表并持久化 */
		async applyLayout(entries: RepoEntry[]) {
			this.entries = entries;
			this.ensureGroupsRegistered();
			await this.saveLayout();
		},
		/** 按给定名称顺序重排分组（保留已有分组的折叠状态，新名称默认展开） */
		async applyGroupOrder(order: string[]) {
			const byName = new Map(this.groups.map((g) => [g.name, g]));
			const next: GroupInfo[] = [];
			const seen = new Set<string>();
			for (const n of order) {
				if (!n || seen.has(n)) continue;
				seen.add(n);
				const g = byName.get(n);
				next.push(g ? { ...g } : { name: n, collapsed: false });
			}
			// 安全网：order 未覆盖但已登记的分组追加到末尾
			for (const g of this.groups) {
				if (g.name && !seen.has(g.name)) next.push(g);
			}
			this.groups = next;
			await this.saveLayout();
		},
		createGroup(name: string): boolean {
			const n = name.trim();
			if (!n) return false;
			if (this.groups.some((g) => g.name === n)) {
				useUI().error("新建分组失败", `分组 “${n}” 已存在`);
				return false;
			}
			this.groups.push({ name: n, collapsed: false });
			void this.saveLayout();
			return true;
		},
		/** 更新分组外观（图标 / 图标颜色 / 文字颜色）：本地立即生效，写盘去抖 */
		setGroupStyle(
			name: string,
			style: { icon?: string; iconColor?: string; textColor?: string },
		) {
			const g = this.groups.find((x) => x.name === name);
			if (!g) return;
			g.icon = style.icon || "";
			g.iconColor = style.iconColor || "";
			g.textColor = style.textColor || "";
			this.scheduleLayoutSave();
		},
		/** 去抖保存布局（高频就地编辑用）；可用 flushLayoutSave 立即落盘 */
		scheduleLayoutSave(delay = 500) {
			if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
			layoutSaveTimer = setTimeout(() => {
				layoutSaveTimer = null;
				void this.saveLayout();
			}, delay);
		},
		/** 若有待保存的布局变更，立即落盘（关闭就地编辑弹层时调用） */
		flushLayoutSave() {
			if (!layoutSaveTimer) return;
			clearTimeout(layoutSaveTimer);
			layoutSaveTimer = null;
			void this.saveLayout();
		},
		async renameGroup(from: string, to: string): Promise<boolean> {
			const n = to.trim();
			if (!n || n === from) return false;
			if (this.groups.some((g) => g.name === n)) {
				useUI().error("重命名分组失败", `分组 “${n}” 已存在`);
				return false;
			}
			const g = this.groups.find((x) => x.name === from);
			if (g) g.name = n;
			else this.groups.push({ name: n, collapsed: false });
			this.entries.forEach((e) => {
				if ((e.group || "") === from) e.group = n;
			});
			await this.saveLayout();
			return true;
		},
		/** 解散分组：组内仓库变回未分组，分组本身消失 */
		async dissolveGroup(name: string) {
			this.entries.forEach((e) => {
				if ((e.group || "") === name) e.group = "";
			});
			this.groups = this.groups.filter((g) => g.name !== name);
			await this.saveLayout();
		},
		async openPath(path: string): Promise<RepoEntry | null> {
			const ui = useUI();
			try {
				const entry = await RepoService.OpenRepo(path);
				if (!entry) {
					ui.error("打开仓库失败", "后端未返回仓库信息");
					return null;
				}
				await this.load();
				this.activePath = entry.path;
				ui.success("已打开仓库", entry.name);
				return entry;
			} catch (e) {
				ui.error("打开仓库失败", errMsg(e));
				return null;
			}
		},
		async pickAndOpen() {
			const dir = await pickDirectory("选择 Git 仓库（或其子目录）");
			if (dir) return this.openPath(dir);
			return null;
		},
		async clone(opts: CloneOptions): Promise<RepoEntry | null> {
			const ui = useUI();
			if (!ui.beginOp("clone", "正在克隆仓库…")) return null;
			try {
				const entry = await RepoService.Clone(opts);
				if (!entry) {
					ui.error("克隆失败", "后端未返回仓库信息");
					return null;
				}
				await this.load();
				this.activePath = entry.path;
				ui.success("克隆完成", entry.path);
				return entry;
			} catch (e) {
				ui.error("克隆失败", errMsg(e));
				return null;
			} finally {
				ui.endOp();
			}
		},
		async initRepo(dir: string): Promise<RepoEntry | null> {
			const ui = useUI();
			try {
				const entry = await RepoService.Init(dir);
				if (!entry) {
					ui.error("初始化失败", "后端未返回仓库信息");
					return null;
				}
				await this.load();
				this.activePath = entry.path;
				ui.success("已初始化仓库", entry.path);
				return entry;
			} catch (e) {
				ui.error("初始化失败", errMsg(e));
				return null;
			}
		},
		async remove(path: string) {
			try {
				await RepoService.RemoveRepo(path);
			} catch (e) {
				useUI().error("移除失败", errMsg(e));
			}
			if (this.activePath === path) this.activePath = "";
			await this.load();
			if (!this.activePath && this.entries.length > 0) {
				this.activePath = this.entries[0].path;
			}
		},
		async reveal(path: string) {
			try {
				await RepoService.RevealInFinder(path);
			} catch {
				/* ignore */
			}
		},
	},
});
