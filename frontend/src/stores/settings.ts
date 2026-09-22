import { defineStore } from "pinia";

export interface AccentPreset {
	key: string;
	label: string;
	color: string;
}

// 主题色（应用主色调）：与亮/暗外观相互独立。首项为原默认蓝，保持不变。
export const ACCENT_PRESETS: AccentPreset[] = [
	{ key: "blue", label: "经典蓝", color: "#4c8dff" },
	{ key: "purple", label: "灵动紫", color: "#a48cff" },
	{ key: "green", label: "清新绿", color: "#3fb968" },
	{ key: "orange", label: "活力橙", color: "#f0883e" },
	{ key: "red", label: "热忱红", color: "#f0554d" },
	{ key: "teal", label: "湖水青", color: "#39c5cf" },
];

export type Appearance = "light" | "dark" | "system";

const STORAGE_KEY = "gv.settings";

interface PersistedSettings {
	accent: string;
	appearance: Appearance;
}

function load(): PersistedSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const p = JSON.parse(raw) as Partial<PersistedSettings>;
			const accent =
				ACCENT_PRESETS.find((a) => a.key === p.accent)?.key || "blue";
			const appearance: Appearance =
				p.appearance === "light" || p.appearance === "dark"
					? p.appearance
					: "dark";
			return { accent, appearance };
		}
	} catch {
		/* corrupted settings: fall through to defaults */
	}
	return { accent: "blue", appearance: "dark" };
}

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	];
}

function mix(hex: string, target: number): string {
	// target > 1 lightens (towards white), < 1 darkens (towards black)
	const [r, g, b] = hexToRgb(hex);
	const f = (v: number) =>
		Math.round(
			Math.min(
				255,
				Math.max(
					0,
					target < 1 ? v * target : v + (255 - v) * (target - 1),
				),
			),
		);
	return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

export const useSettings = defineStore("settings", {
	state: () => {
		const init = load();
		return {
			accent: init.accent,
			appearance: init.appearance,
			media: null as MediaQueryList | null,
		};
	},
	actions: {
		/** Apply accent color + resolved light/dark to the document root. */
		applyTheme() {
			const root = document.documentElement;
			const preset =
				ACCENT_PRESETS.find((a) => a.key === this.accent) ||
				ACCENT_PRESETS[0];
			const dark = this.resolvedDark;
			root.dataset.theme = dark ? "dark" : "light";
			root.style.setProperty("--accent", preset.color);
			// hover 变体：暗色下提亮、亮色下压暗
			root.style.setProperty(
				"--accent-hover",
				dark ? mix(preset.color, 1.15) : mix(preset.color, 0.88),
			);
			const [r, g, b] = hexToRgb(preset.color);
			root.style.setProperty(
				"--accent-soft",
				`rgba(${r}, ${g}, ${b}, 0.2)`,
			);
			root.style.setProperty(
				"--accent-wash",
				`rgba(${r}, ${g}, ${b}, 0.08)`,
			);
			root.style.setProperty(
				"--bg-selected",
				`rgba(${r}, ${g}, ${b}, 0.27)`,
			);
		},
		init() {
			this.applyTheme();
			const m = window.matchMedia("(prefers-color-scheme: dark)");
			this.media = m;
			m.addEventListener("change", () => {
				if (this.appearance === "system") this.applyTheme();
			});
		},
		setAccent(key: string) {
			if (!ACCENT_PRESETS.some((a) => a.key === key)) return;
			this.accent = key;
			this.persist();
			this.applyTheme();
		},
		setAppearance(a: Appearance) {
			this.appearance = a;
			this.persist();
			this.applyTheme();
		},
		/** Quick toggle used by the titlebar button: switch light <-> dark. */
		toggleLightDark() {
			this.setAppearance(this.resolvedDark ? "light" : "dark");
		},
		persist() {
			try {
				localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({
						accent: this.accent,
						appearance: this.appearance,
					}),
				);
			} catch {
				/* persistence unavailable: keep in-session */
			}
		},
	},
	getters: {
		resolvedDark(s): boolean {
			if (s.appearance === "light") return false;
			if (s.appearance === "dark") return true;
			return s.media
				? s.media.matches
				: window.matchMedia("(prefers-color-scheme: dark)").matches;
		},
		accentColor(s): string {
			return (
				ACCENT_PRESETS.find((a) => a.key === s.accent)?.color ||
				ACCENT_PRESETS[0].color
			);
		},
	},
});
