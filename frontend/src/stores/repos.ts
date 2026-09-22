import { defineStore } from "pinia";
import { RepoService, pickDirectory, errMsg } from "../api";
import type { RepoEntry, CloneOptions } from "../api";
import { useUI } from "./ui";

export interface RepoGroup {
	/** "" = 未分组 */
	name: string;
	entries: RepoEntry[];
}

export const useRepos = defineStore("repos", {
	state: () => ({
		entries: [] as RepoEntry[],
		activePath: "",
		loaded: false,
		/** 已折叠的分组名 */
		collapsedGroups: {} as Record<string, boolean>,
		/** 暂无仓库的分组（新建后等待拖入仓库，不参与持久化） */
		emptyGroups: [] as string[],
	}),
	getters: {
		active(s): RepoEntry | null {
			return s.entries.find((e) => e.path === s.activePath) || null;
		},
		/** 分组视图：按首次出现顺序排序，未分组固定在最后 */
		groups(s): RepoGroup[] {
			const order: string[] = [...s.emptyGroups];
			const map = new Map<string, RepoEntry[]>();
			for (const e of s.entries) {
				const g = e.group || "";
				if (!map.has(g)) {
					map.set(g, []);
					if (g && !order.includes(g)) order.push(g);
				}
				map.get(g)!.push(e);
			}
			const out: RepoGroup[] = [];
			for (const g of order) {
				const list = map.get(g);
				if (g && list && list.length)
					out.push({ name: g, entries: list });
			}
			for (const [g, list] of map) {
				if (g && !order.includes(g) && list.length)
					out.push({ name: g, entries: list });
			}
			const ungrouped = map.get("");
			if (ungrouped && ungrouped.length)
				out.push({ name: "", entries: ungrouped });
			return out;
		},
	},
	actions: {
		async load() {
			const ui = useUI();
			try {
				this.entries = (await RepoService.ListRepos()) || [];
			} catch (e) {
				ui.error("加载仓库列表失败", errMsg(e));
			}
			this.loaded = true;
		},
		setActive(path: string) {
			if (path) this.activePath = path;
		},
		toggleGroup(name: string) {
			this.collapsedGroups[name] = !this.collapsedGroups[name];
		},
		/** 把当前完整顺序（含 group 字段）发送给后端持久化；失败仅提示，不回滚本地状态 */
		async saveLayout() {
			const ui = useUI();
			try {
				await RepoService.SaveLayout(
					this.entries.map((e) => ({ ...e, group: e.group || "" })),
				);
			} catch (e) {
				ui.error("保存布局失败", errMsg(e));
			}
		},
		/** 应用拖拽/分组变更后的完整列表并持久化 */
		async applyLayout(entries: RepoEntry[]) {
			this.entries = entries;
			// 分组一旦有了仓库，就不再是空分组
			this.emptyGroups = this.emptyGroups.filter(
				(n) => !entries.some((e) => (e.group || "") === n),
			);
			await this.saveLayout();
		},
		createGroup(name: string): boolean {
			const n = name.trim();
			if (!n) return false;
			if (
				this.emptyGroups.includes(n) ||
				this.entries.some((e) => (e.group || "") === n)
			) {
				useUI().error("新建分组失败", `分组 “${n}” 已存在`);
				return false;
			}
			this.emptyGroups.push(n);
			return true;
		},
		async renameGroup(from: string, to: string): Promise<boolean> {
			const n = to.trim();
			if (!n || n === from) return false;
			if (
				this.emptyGroups.includes(n) ||
				this.entries.some((e) => (e.group || "") === n)
			) {
				useUI().error("重命名分组失败", `分组 “${n}” 已存在`);
				return false;
			}
			this.entries.forEach((e) => {
				if ((e.group || "") === from) e.group = n;
			});
			const i = this.emptyGroups.indexOf(from);
			if (i !== -1) this.emptyGroups.splice(i, 1, n);
			if (this.collapsedGroups[from]) {
				this.collapsedGroups[n] = true;
				delete this.collapsedGroups[from];
			}
			await this.saveLayout();
			return true;
		},
		/** 解散分组：组内仓库变回未分组，分组本身消失 */
		async dissolveGroup(name: string) {
			this.entries.forEach((e) => {
				if ((e.group || "") === name) e.group = "";
			});
			const i = this.emptyGroups.indexOf(name);
			if (i !== -1) this.emptyGroups.splice(i, 1);
			delete this.collapsedGroups[name];
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
