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
	{ key: "indigo", label: "深邃靛", color: "#6366f1" },
	{ key: "sky", label: "天空蓝", color: "#38bdf8" },
	{ key: "lime", label: "青柠绿", color: "#84cc16" },
	{ key: "amber", label: "琥珀黄", color: "#e3b341" },
	{ key: "pink", label: "樱花粉", color: "#f778ba" },
	{ key: "slate", label: "石墨灰", color: "#8b949e" },
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
				p.appearance === "light" ||
				p.appearance === "dark" ||
				p.appearance === "system"
					? p.appearance
					: "dark";
			return { accent, appearance };
		}
	} catch {
		/* corrupted settings: fall through to defaults */
	}
	return { accent: "blue", appearance: "dark" };
}

type RGB = [number, number, number];

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

function hexToRgb(hex: string): RGB {
	const h = hex.replace("#", "").trim();
	const full =
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h.padEnd(6, "0").slice(0, 6);
	return [
		parseInt(full.slice(0, 2), 16),
		parseInt(full.slice(2, 4), 16),
		parseInt(full.slice(4, 6), 16),
	];
}

function rgbToHex([r, g, b]: RGB): string {
	const p = (v: number) =>
		Math.round(clamp(v, 0, 255))
			.toString(16)
			.padStart(2, "0");
	return `#${p(r)}${p(g)}${p(b)}`;
}

function rgba([r, g, b]: RGB, a: number): string {
	return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

/** RGB → HSL，h∈[0,360)，s/l∈[0,1] */
function rgbToHsl([r, g, b]: RGB): [number, number, number] {
	const rr = r / 255;
	const gg = g / 255;
	const bb = b / 255;
	const max = Math.max(rr, gg, bb);
	const min = Math.min(rr, gg, bb);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l];
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
	else if (max === gg) h = (bb - rr) / d + 2;
	else h = (rr - gg) / d + 4;
	return [h * 60, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
	let tt = t;
	if (tt < 0) tt += 1;
	if (tt > 1) tt -= 1;
	if (tt < 1 / 6) return p + (q - p) * 6 * tt;
	if (tt < 1 / 2) return q;
	if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
	return p;
}

function hslToRgb(h: number, s: number, l: number): RGB {
	const hh = (((h % 360) + 360) % 360) / 360;
	if (s === 0) {
		const v = l * 255;
		return [v, v, v];
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [
		hueToRgb(p, q, hh + 1 / 3) * 255,
		hueToRgb(p, q, hh) * 255,
		hueToRgb(p, q, hh - 1 / 3) * 255,
	];
}

/** WCAG 相对亮度（0=黑，1=白） */
function relLuminance([r, g, b]: RGB): number {
	const f = (c: number) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a: RGB, b: RGB): number {
	const la = relLuminance(a);
	const lb = relLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: RGB = [255, 255, 255];
const INK: RGB = [13, 17, 23]; // #0d1117：与深色底一致的近黑前景

/**
 * 在保持色相/饱和度的前提下逐步调整明度，直到与 bg 的对比度达标。
 * 用于把过亮的主色压暗成可读的文字/图标色（亮色外观），不破坏主题色辨识度。
 */
function tuneForContrast(rgb: RGB, bg: RGB, target: number): RGB {
	if (contrastRatio(rgb, bg) >= target) return rgb;
	const [h, s, l0] = rgbToHsl(rgb);
	// 比背景暗则继续压暗、比背景亮则继续提亮——两者都能提高对比度
	const darker = relLuminance(rgb) < relLuminance(bg);
	let l = l0;
	for (let i = 0; i < 100; i++) {
		l = clamp(l + (darker ? -0.02 : 0.02), 0, 1);
		const cand = hslToRgb(h, s, l);
		if (contrastRatio(cand, bg) >= target || l <= 0 || l >= 1) return cand;
	}
	return hslToRgb(h, s, l);
}

/** 按 HSL 明度平移派生 hover 色：保持色相/饱和度，比直接混白/混黑更纯净。 */
function shiftLightness(rgb: RGB, delta: number): RGB {
	const [h, s, l] = rgbToHsl(rgb);
	return hslToRgb(h, s, clamp(l + delta, 0, 1));
}

/** 填充色上的白色前景下限：白色对比度低于该值时改用深墨色。 */
const FG_WHITE_MIN = 2.4;

/** 在给定背景色上清晰可读的前景色（浅色底用深墨、深色底用白）。 */
export function foregroundOn(colorHex: string): string {
	return contrastRatio(hexToRgb(colorHex), WHITE) >= FG_WHITE_MIN
		? "#ffffff"
		: rgbToHex(INK);
}

/** 一整套随主题色细化的搭配色 */
interface AccentTokens {
	/** 主色本体（亮色外观下会压暗到可读） */
	accent: string;
	/** 悬停态（暗色提亮 / 亮色压暗） */
	hover: string;
	/** 主色填充上的前景（文字/图标/勾选） */
	fg: string;
	/** hover / 强调底色 */
	soft: string;
	/** 极淡强调底色（单选/开关等） */
	wash: string;
	/** 选中行底色 */
	selected: string;
}

/**
 * 依据外观（亮/暗）把单个主题色细化为一整套相互协调的派生色：
 * - 亮色外观把过亮的主色压暗到能作为文字清晰阅读（保留色相/饱和度）；
 * - 暗色外观保留原始明度（浅主色在深底上本就醒目）；
 * - 前景色按实际填充明度自动在白色 / 深墨之间选择，避免浅色主色上白字看不清。
 */
function buildAccentTokens(hex: string, dark: boolean): AccentTokens {
	const base = hexToRgb(hex);
	const tone = dark ? base : tuneForContrast(base, WHITE, 4.5);
	const fg =
		contrastRatio(tone, WHITE) >= FG_WHITE_MIN ? "#ffffff" : rgbToHex(INK);
	return {
		accent: rgbToHex(tone),
		hover: rgbToHex(shiftLightness(tone, dark ? 0.08 : -0.08)),
		fg,
		soft: rgba(tone, dark ? 0.2 : 0.18),
		wash: rgba(tone, dark ? 0.09 : 0.1),
		selected: rgba(tone, dark ? 0.27 : 0.15),
	};
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
			// 由主色细化出的一整套搭配色（随亮/暗外观自适应）
			const t = buildAccentTokens(preset.color, dark);
			root.style.setProperty("--accent", t.accent);
			root.style.setProperty("--accent-hover", t.hover);
			root.style.setProperty("--accent-fg", t.fg);
			root.style.setProperty("--accent-soft", t.soft);
			root.style.setProperty("--accent-wash", t.wash);
			root.style.setProperty("--bg-selected", t.selected);
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
