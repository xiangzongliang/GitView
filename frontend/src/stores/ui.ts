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
		/** label of the git operation currently running (drives toolbar spinner) */
		opRunning: "",
		/** built-in terminal panel visibility */
		terminalOpen: false,
		/** settings slide-over panel visibility (not a modal dialog) */
		settingsOpen: false,
		/** sidebar width in px (drag the divider to change; min/max clamped in App) */
		sidebarWidth: Number(localStorage.getItem("gv.sidebarW")) || 236,
	}),
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
		openSettings() {
			this.settingsOpen = true;
		},
		closeSettings() {
			this.settingsOpen = false;
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
