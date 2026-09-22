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
