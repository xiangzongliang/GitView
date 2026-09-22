import { defineStore } from "pinia";
import { RepoService, pickDirectory, errMsg } from "../api";
import type { RepoEntry, CloneOptions } from "../api";
import { useUI } from "./ui";

export const useRepos = defineStore("repos", {
	state: () => ({
		entries: [] as RepoEntry[],
		activePath: "",
		loaded: false,
	}),
	getters: {
		active(s): RepoEntry | null {
			return s.entries.find((e) => e.path === s.activePath) || null;
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
			ui.opRunning = "正在克隆仓库…";
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
				ui.opRunning = "";
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
