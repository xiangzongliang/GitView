import { defineStore } from "pinia";

export interface Toast {
	id: number;
	type: "success" | "error" | "info";
	title: string;
	detail?: string;
}

export interface MenuItem {
	label?: string;
	icon?: string;
	danger?: boolean;
	disabled?: boolean;
	separator?: boolean;
	checked?: boolean;
	action?: () => void;
}

export interface DialogRequest {
	kind: string;
	payload?: any;
}

let toastSeq = 1;

export const useUI = defineStore("ui", {
	state: () => ({
		toasts: [] as Toast[],
		menu: null as null | { x: number; y: number; items: MenuItem[] },
		dialog: null as DialogRequest | null,
		/**
		 * 当前正在执行的操作。同一时刻只允许一个（互斥），key 标明所属功能
		 * （fetch/pull/push/commit/files/…），以便在对应控件上显示局部 loading。
		 */
		op: null as null | { key: string; label: string },
		/** built-in terminal panel visibility */
		terminalOpen: false,
		/** 右下角调试窗口（git 命令日志）是否展开 */
		debugOpen: false,
		/** settings slide-over panel visibility (not a modal dialog) */
		settingsOpen: false,
		/**
		 * 打开设置时要选中的功能页 key（见 SettingsPanel 的 TABS）。
		 * null 表示沿用上次停留的页面。
		 */
		settingsTab: null as string | null,
		/** sidebar width in px (drag the divider to change; min/max clamped in App) */
		sidebarWidth: Number(localStorage.getItem("gv.sidebarW")) || 236,
	}),
	getters: {
		/** 操作文案（状态栏内联提示用） */
		opRunning(s): string {
			return s.op?.label || "";
		},
		/** 是否有操作在执行（用于禁用可能重复触发的控件） */
		busy(s): boolean {
			return !!s.op;
		},
	},
	actions: {
		pushToast(type: Toast["type"], title: string, detail?: string) {
			const t: Toast = { id: toastSeq++, type, title, detail };
			this.toasts.push(t);
			if (this.toasts.length > 5) {
				const drop = this.toasts.shift();
				if (drop) this.dismissToast(drop.id);
			}
			setTimeout(
				() => this.dismissToast(t.id),
				type === "error" ? 12000 : 4000,
			);
		},
		success(title: string, detail?: string) {
			this.pushToast("success", title, detail);
		},
		error(title: string, detail?: string) {
			this.pushToast("error", title, detail);
		},
		info(title: string, detail?: string) {
			this.pushToast("info", title, detail);
		},
		dismissToast(id: number) {
			this.toasts = this.toasts.filter((t) => t.id !== id);
		},
		openMenu(x: number, y: number, items: MenuItem[]) {
			this.menu = { x, y, items };
		},
		closeMenu() {
			this.menu = null;
		},
		openDialog(kind: string, payload?: any) {
			this.dialog = { kind, payload };
		},
		closeDialog() {
			this.dialog = null;
		},
		toggleTerminal() {
			this.terminalOpen = !this.terminalOpen;
		},
		toggleDebug() {
			this.debugOpen = !this.debugOpen;
		},
		/**
		 * 标记一个操作开始；已有操作在执行时返回 false（调用方应直接放弃，
		 * 以避免重复触发同一次 git 操作）。
		 */
		beginOp(key: string, label: string): boolean {
			if (this.op) return false;
			this.op = { key, label };
			return true;
		},
		endOp() {
			this.op = null;
		},
		/** 某个功能当前是否在执行（用于在该控件上显示 loading） */
		isOp(key: string): boolean {
			return this.op?.key === key;
		},
		openSettings(tab?: string) {
			this.settingsTab = tab || null;
			this.settingsOpen = true;
		},
		closeSettings() {
			this.settingsOpen = false;
			this.settingsTab = null;
		},
		setSidebarWidth(w: number) {
			const max = Math.max(200, Math.round(window.innerWidth * 0.4));
			this.sidebarWidth = Math.round(Math.min(Math.max(200, w), max));
			try {
				localStorage.setItem("gv.sidebarW", String(this.sidebarWidth));
			} catch {
				/* ignore */
			}
		},
		/** Promise-based confirmation dialog. */
		confirm(opts: {
			title: string;
			message: string;
			confirmLabel?: string;
			danger?: boolean;
		}): Promise<boolean> {
			return new Promise<boolean>((resolve) => {
				this.openDialog("confirm", { ...opts, resolve });
			});
		},
	},
});
