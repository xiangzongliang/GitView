import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

export const fmtDateTime = (ts: number): string =>
	ts ? dayjs.unix(ts).format("YYYY-MM-DD HH:mm") : "";
export const fmtDate = (ts: number): string =>
	ts ? dayjs.unix(ts).format("YYYY-MM-DD") : "";
export const relTime = (ts: number): string =>
	ts ? dayjs.unix(ts).fromNow() : "";

export const shortHash = (h: string): string => (h || "").slice(0, 8);

/** Distinct colors for graph lanes. */
export const LANE_COLORS = [
	"#4c8dff",
	"#f0883e",
	"#46c26a",
	"#bc8cff",
	"#39c5cf",
	"#e3b341",
	"#ff7b9c",
	"#9ccc65",
	"#6ba5f7",
	"#d98cb3",
];
export const laneColor = (lane: number): string =>
	LANE_COLORS[lane % LANE_COLORS.length];

export const STATUS_LABELS: Record<string, string> = {
	M: "修改",
	A: "新增",
	D: "删除",
	R: "重命名",
	C: "复制",
	U: "冲突",
	"?": "未跟踪",
	T: "类型变更",
	X: "未知",
};

export function statusColor(ch: string): string {
	switch (ch) {
		case "A":
			return "var(--green)";
		case "M":
		case "T":
			return "var(--yellow)";
		case "D":
			return "var(--red)";
		case "R":
		case "C":
			return "var(--teal)";
		case "U":
			return "var(--orange)";
		case "?":
			return "var(--text-dim)";
		default:
			return "var(--text-dim)";
	}
}

/** Two-letter avatar text for an author name. */
export function initials(name: string): string {
	if (!name) return "?";
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

export function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(0, i) : "";
}

/**
 * 可直接以 <img> 预览的图片扩展名（小写、不带点）。
 * 与后端 GitView/repoimage.go 的 imageMimeByExt 白名单保持一致。
 */
export const IMAGE_EXTENSIONS = [
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"svg",
	"avif",
] as const;

const IMAGE_EXT_SET: Set<string> = new Set(IMAGE_EXTENSIONS);

/** 文件扩展名（小写、不带点）；无扩展名（如 ".gitignore"）返回 ""。 */
export function extname(p: string): string {
	const base = basename(p || "");
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 是否为可直接预览的图片文件（按扩展名判断）。 */
export function isImageFile(p: string): boolean {
	return IMAGE_EXT_SET.has(extname(p));
}

/** 是否为 SVG：既有源码文本 diff，也可渲染成图，两种模式可切换。 */
export function isSvgFile(p: string): boolean {
	return extname(p) === "svg";
}
